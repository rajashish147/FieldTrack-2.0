# Deployment Guide

This document covers deploying FieldTrack API to a Linux VPS using the included blue-green deployment system.

---

## Prerequisites

- A Linux VPS (Ubuntu 22.04 recommended) accessible via SSH
- A GitHub Container Registry (GHCR) account with push access to the repository
- GitHub Actions secrets configured (see [CI/CD Setup](#cicd-setup))
- Docker and Docker Compose installed on the VPS (handled by `vps-setup.sh`)

---

## Initial VPS Provisioning

The `vps-setup.sh` script handles the full first-time setup of a fresh VPS:

```bash
# Copy the script to the VPS and run as root
scp scripts/vps-setup.sh root@your-server:/tmp/
ssh root@your-server 'bash /tmp/vps-setup.sh'
```

This script:

1. Installs Docker, Docker Compose, Nginx, and system dependencies
2. Creates a dedicated `deploy` OS user with limited permissions
3. Clones the repository and initialises the directory structure
4. Obtains a TLS certificate via Let's Encrypt (`certbot`)
5. Configures Nginx as a reverse proxy (TLS termination + blue-green upstream switching)
6. Sets up a `systemd` service for auto-restart on boot
7. Configures log rotation and minimal `ufw` firewall rules
8. Starts the monitoring stack (Prometheus, Grafana, Loki, Tempo)

Before running, update the variables at the top of the script:

```bash
DOMAIN="yourdomain.com"         # Your server's domain
DEPLOY_USER="fieldtrack"        # OS user to run the service
GH_USER="your-github-username"  # GitHub username (for GHCR)
REPO_URL="https://github.com/your-username/api.git"
```

---

## API Deployment
1. SSH into VPS
2. Run `scripts/vps-setup.sh` from workspace root
3. Set `.env` and `.env.monitoring` in workspace root
4. Start monitoring stack: `docker-compose -f infra/docker-compose.monitoring.yml up -d`
5. Deploy API: `scripts/deploy-bluegreen.sh`
6. Confirm readiness: `curl https://<domain>/ready`
7. Confirm Prometheus target status is UP

## Rollback
1. API: `scripts/rollback.sh`

## Monitoring
1. Set `.env.monitoring` in workspace root
2. Start stack: `docker-compose -f infra/docker-compose.monitoring.yml up -d`
3. Grafana: `http://<domain>:3000`
4. Prometheus: `http://<domain>:9090`
5. Loki: `http://<domain>:3100`
6. Tempo: `http://<domain>:3200`

## Nginx
1. Config: `infra/nginx/api.conf`
2. Canonical path: `/etc/nginx/conf.d/api.conf`
3. TLS bootstrap: two-stage via Certbot

## Troubleshooting
1. Logs: `infra/promtail/promtail.yml`
2. Alerts: `infra/prometheus/alerts.yml`
3. Config: `infra/prometheus/prometheus.yml`
4. Grafana dashboards: `infra/grafana/dashboards/`
5. Nginx config: `infra/nginx/api.conf`
The deployment uses a blue-green strategy for zero-downtime releases.

### How It Works

The VPS always runs **two containers** (`api-blue` on port 3001, `api-green` on port 3002). Nginx routes all traffic to whichever is currently active.

On each deploy:

1. The new image is pulled from GHCR
2. The **inactive** container is replaced with the new image
3. Readiness checks poll `GET /ready` until the new container is ready (up to 60 s)
4. Nginx upstream is switched to the new container (`nginx -s reload`)
5. The previously active container is stopped and removed
6. The deployed SHA is prepended to `.deploy_history` (keeps last 5)

### Manual Deploy

```bash
# SSH into the VPS
cd /home/ashish/api

# Deploy a specific image SHA (e.g. from CI output)
./scripts/deploy-bluegreen.sh a4f91c2

# Deploy the latest tag
./scripts/deploy-bluegreen.sh latest
```

---

## Rollback

To instantly revert to the previous deployment:

```bash
cd /home/ashish/api
./scripts/rollback.sh
```

The script:
1. Reads `.deploy_history` (requires at least 2 recorded deployments)
2. Displays the full history with current/target markers
3. Prompts for confirmation before proceeding
4. Calls `deploy-bluegreen.sh <previous-sha>` — no rebuild, image already in GHCR

**Typical rollback time: under 10 seconds.**

To deploy any specific historical SHA:

```bash
./scripts/deploy-bluegreen.sh 7b3e9f1
```

For full rollback system documentation, see [ROLLBACK_SYSTEM.md](ROLLBACK_SYSTEM.md).

---

## Monitoring Stack

The observability stack runs alongside the application on the same VPS:

```bash
cd infra
docker compose -f docker-compose.monitoring.yml up -d
```

| Service | Default Port | Access |
|---------|-------------|--------|
| Grafana | 3001 (internal) | Via Nginx proxy or direct |
| Prometheus | 9090 (internal) | Internal only |
| Loki | 3100 (internal) | Internal only |
| Tempo | 3200 / 4318 | Internal only |

The pre-built Grafana dashboard (`infra/grafana/dashboards/fieldtrack.json`) is auto-provisioned and covers HTTP metrics, queue depth, latency, and Redis health.

---

## Environment Variables

Copy `.env.example` to `.env` on the VPS and fill in all values before the first deploy.

See [README.md](../README.md) for the full variable reference.

---

## Health Check

The application exposes a public health endpoint:

```bash
curl https://yourdomain.com/health
# {"status":"ok","timestamp":"2026-03-10T12:00:00.000Z"}
```

The deployment script now uses `/ready` to validate dependency readiness before switching Nginx traffic.

---

## Troubleshooting

**Deployment hangs on health check**  
The new container failed to start. Check Docker logs:
```bash
docker logs api-green   # or api-blue
```

**Rollback fails: "insufficient deployment history"**  
Only one deployment has been recorded. Deploy manually with a known-good SHA:
```bash
./scripts/deploy-bluegreen.sh <known-good-sha>
```

**Container image not found in GHCR**  
The SHA must match a tag pushed to GHCR. Verify with:
```bash
docker pull ghcr.io/fieldtrack-tech/api:<sha>
```

**Nginx fails to reload**  
Check the Nginx config syntax:
```bash
nginx -t
```
