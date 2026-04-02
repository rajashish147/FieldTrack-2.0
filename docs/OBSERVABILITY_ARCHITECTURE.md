# FieldTrack API — Observability Architecture

This document describes the monitoring, logging, and metrics systems in FieldTrack API and how they fit together in production.

---

## Stack Topology

```
                          ┌─────────────────────────────────────────────────┐
                          │               VPS (single host)                 │
                          │                                                 │
  Browser / Client        │  Nginx (public)                                 │
       │                  │    ├─ /         → api-blue:3000             │
       │ HTTPS            │    │             or api-green:3000          │
       └─────────────────►│    └─ /monitor/ → 127.0.0.1:3333 (Grafana)    │
                          │                                                 │
                          │  ┌──────────────────────────────────────────┐   │
                          │  │          api_network (Docker)     │   │
                          │  │                                          │   │
                          │  │  api-blue:3000  ──────────────────┐  │   │
                          │  │  api-green:3000 ── /metrics ──────┼──┼──►│ Prometheus
                          │  │                                        │  │   │ 127.0.0.1:9090
                          │  │  node-exporter:9100  ─── /metrics ───┘  │   │
                          │  │                                          │   │
                          │  │  Promtail ──── push ──► Loki:3100        │   │
                          │  │    │                       │             │   │
                          │  │    │ reads                 │             │   │
                          │  │  /var/log/*               ▼             │   │
                          │  │  /var/lib/docker/       Grafana          │   │
                          │  │    containers/          :3000 →          │   │
                          │  │                     127.0.0.1:3333       │   │
                          │  └──────────────────────────────────────────┘   │
                          └─────────────────────────────────────────────────┘
```

---

## Metrics Flow

### Scrape chain

```
Prometheus (every 15 s)
  ├─ GET api-blue:3000/metrics   [x-metrics-token: <token>]
  ├─ GET api-green:3000/metrics  [x-metrics-token: <token>]  ← inactive = DOWN (expected)
  ├─ GET node-exporter:9100/metrics  [no auth — host-internal only]
  └─ GET localhost:9090/metrics      [self-monitoring]
```

### Endpoint

The Fastify API exposes `/metrics` in [OpenMetrics](https://openmetrics.io/) format via the `@fastify/metrics` plugin. The endpoint is **not** reachable through Nginx (blocked by `location /metrics { return 403; }`).

### Authentication

Prometheus sends a custom header on every scrape:

```
x-metrics-token: <value of METRICS_SCRAPE_TOKEN>
```

The API validates this header in its metrics middleware. Requests without a matching token receive `403 Forbidden`.

`METRICS_SCRAPE_TOKEN` is injected into the Prometheus container via the `METRICS_SCRAPE_TOKEN` environment variable, which Prometheus expands when loading `prometheus.yml`  
(`headers: { x-metrics-token: ${METRICS_SCRAPE_TOKEN} }`).

### Prometheus config file

[infra/prometheus/prometheus.yml](../infra/prometheus/prometheus.yml)

### Retention

- Time-based: **30 days**
- Size-based: **5 GB**  
  Prometheus evicts oldest data first when the size limit is reached.

---

## Logs Flow

### Collection chain

```
Container stdout/stderr
        │
        ▼
Docker JSON log files
  /var/lib/docker/containers/<id>/*-json.log
        │
        ▼ (Promtail reads, parses, labels)
        │
        ▼
Loki:3100/loki/api/v1/push
        │
        ▼
Grafana (Loki datasource) → Explore / Dashboard panels
```

### Promtail config file

[infra/promtail/promtail.yml](../infra/promtail/promtail.yml)

### Log sources

| Source | Path | Labels added |
|--------|------|--------------|
| Docker containers | `/var/lib/docker/containers/*/*-json.log` | `job=docker`, `container_id`, `level`, `trace_id` |
| Host syslog | `/var/log/*.log` | `job=syslog` |

### Log parsing pipeline (Docker)

Promtail applies a multi-stage pipeline to container logs:

1. **`docker: {}`** — unwraps Docker's JSON envelope (`log`, `stream`, `time`)
2. **regex** — extracts `container_id` from the file path
3. **json** — extracts `level`, `msg`, `trace_id`, `span_id` from Pino structured logs
4. **labels** — promotes `level` and `trace_id` as Loki stream labels

### Positions persistence

Promtail records log offsets in:

```
/data/positions.yaml   (inside promtail_data Docker volume → fieldtrack_promtail_data)
```

This file survives container restarts so Promtail never re-ingests already-processed logs.

### Loki retention

Loki is configured via [infra/loki/loki-config.yaml](../infra/loki/loki-config.yaml).

| Setting | Value | Location |
|---------|-------|----------|
| `limits_config.retention_period` | `30d` | `loki-config.yaml` |
| `compactor.retention_enabled` | `true` | `loki-config.yaml` |
| Compaction interval | every 10 minutes | `loki-config.yaml` |
| Deletion delay | 2 hours | `loki-config.yaml` |

The compactor process runs inside the single-binary Loki container.  It scans the index every 10 minutes, marks chunks older than 30 days for deletion, and removes them 2 hours later.  The `loki_data` Docker volume (stored in `/loki/chunks`, `/loki/rules`, `/loki/compactor`) must have enough disk space for at most 30 days of logs.

---

## Grafana

| Property | Value |
|----------|-------|
| Bound to | `127.0.0.1:3333` |
| Public URL | `https://<API_HOSTNAME>/monitor/` |
| Served via | Nginx `location /monitor/` → `proxy_pass http://127.0.0.1:3333` |
| Auth | Admin credentials from `GRAFANA_ADMIN_PASSWORD` secret |
| Sign-up | Disabled (`GF_USERS_ALLOW_SIGN_UP=false`) |

### Datasources (provisioned)

Configured under [infra/grafana/provisioning/datasources/](../infra/grafana/provisioning/datasources/).

| Name | Type | URL |
|------|------|-----|
| Prometheus | prometheus | `http://prometheus:9090` |
| Loki | loki | `http://loki:3100` |

### Dashboards (provisioned)

Pre-built dashboards are stored in [infra/grafana/dashboards/](../infra/grafana/dashboards/) and automatically loaded at startup.

---

## Container Services

All services run inside the `api_network` Docker bridge network.

| Container | Image | Bound port | Role |
|-----------|-------|------------|------|
| `prometheus` | `prom/prometheus:v2.52.0` | `127.0.0.1:9090` | Metrics scraper & TSDB |
| `grafana` | `grafana/grafana:10.4.2` | `127.0.0.1:3333` | Dashboards |
| `loki` | `grafana/loki:2.9.6` | internal `:3100` | Log aggregation |
| `promtail` | `grafana/promtail:2.9.6` | — | Log shipper |
| `node-exporter` | `prom/node-exporter:v1.8.1` | internal `:9100` | Host metrics |

All images are **pinned** to exact versions to ensure deterministic restarts.

### Resource limits

Each monitoring container has a Docker-managed memory ceiling enforced via `deploy.resources.limits`:

| Container | Memory limit |
|-----------|--------------|
| `loki` | 1 GB |
| `prometheus` | 1 GB |
| `grafana` | 512 MB |
| `promtail` | 128 MB |
| `node-exporter` | *(no limit — minimal footprint)* |

---

## Persistent Volumes

| Docker Volume | Named Volume | Contents |
|---------------|-------------|----------|
| `prometheus_data` | `fieldtrack_prometheus_data` | Prometheus TSDB |
| `grafana_data` | `fieldtrack_grafana_data` | Grafana DB, plugins |
| `loki_data` | `fieldtrack_loki_data` | Loki chunks & index |
| `promtail_data` | `fieldtrack_promtail_data` | Log offset positions file |

---

## Monitoring Stack Restart Policy

The deploy script ([scripts/deploy-bluegreen.sh](../scripts/deploy-bluegreen.sh)) and the CI sync-infra job only restart the monitoring stack when monitoring configuration has actually changed.

Change detection uses a SHA-256 hash over all files matching:

```
infra/**/*.{yml,yaml,conf,toml,json}
```

with the `infra/nginx/` subtree excluded (nginx is rendered on every deploy and does not require a monitoring restart).

The last-known hash is stored at `~/.fieldtrack-monitoring-hash`. If the new hash matches, the monitoring stack is left running untouched.

---

## Security Notes

| Control | Detail |
|---------|--------|
| `/metrics` blocked at Nginx | `location /metrics { return 403; }` — scraping is only possible from inside `api_network` |
| Prometheus token auth | `x-metrics-token` header required; value stored in `METRICS_SCRAPE_TOKEN` env var |
| Grafana not publicly listed | Accessible only at `/monitor/`; no signup |
| Monitoring ports loopback-bound | Prometheus `:9090` and Grafana `:3333` bound to `127.0.0.1`; not accessible externally |
| Image versions pinned | No `latest` tags — prevents silent breaking changes on container restart |
| Container log limits | All monitoring containers use `json-file` driver with `max-size: 10m` / `max-file: 3` |

---

## Alerting (Deployed)

The [infra/prometheus/alerts.yml](../infra/prometheus/alerts.yml) file defines alerting rules. Prometheus loads it via:

```yaml
rule_files:
  - alerts.yml
```

Alertmanager is now deployed in [infra/docker-compose.monitoring.yml](../infra/docker-compose.monitoring.yml) and configured in [infra/prometheus/prometheus.yml](../infra/prometheus/prometheus.yml):

```yaml
alerting:
  alertmanagers:
    - static_configs:
        - targets:
            - alertmanager:9093
```

Alertmanager is configured at [infra/alertmanager/alertmanager.yml](../infra/alertmanager/alertmanager.yml), and Slack webhook is loaded from `infra/.env.monitoring` (ALERTMANAGER_SLACK_WEBHOOK).

Alerting now uses Slack only. Set this in `infra/.env.monitoring` with a valid Slack incoming webhook endpoint:

- `ALERTMANAGER_SLACK_WEBHOOK`

Then redeploy the monitoring stack.


---

## Certbot Bootstrap (Fresh VPS)

Nginx references LetsEncrypt certificates at `/etc/letsencrypt/live/<API_HOSTNAME>/`. On a fresh VPS these do not exist yet, so a full SSL config causes Nginx to refuse to start.

**Safe bootstrap sequence:**

1. Deploy a temporary HTTP-only Nginx config that only serves `/.well-known/acme-challenge/` and your `server_name`. Comment out the `listen 443` server block and all `ssl_*` directives.

2. Start Nginx with the HTTP-only config:
   ```bash
   sudo nginx -t && sudo systemctl start nginx
   ```

3. Obtain the certificate:
   ```bash
   sudo certbot certonly --webroot -w /var/www/certbot -d $API_HOSTNAME
   ```

4. Render and install the full SSL config from the template:
   ```bash
   sed \
     -e "s|__BACKEND_PORT__|3001|g" \
     -e "s|__API_HOSTNAME__|$API_HOSTNAME|g" \
     infra/nginx/fieldtrack.conf | sudo tee /etc/nginx/sites-enabled/fieldtrack.conf
   sudo nginx -t && sudo systemctl reload nginx
   ```

5. Enable auto-renewal (Certbot installs a systemd timer automatically on Ubuntu):
   ```bash
   sudo systemctl status certbot.timer
   ```
