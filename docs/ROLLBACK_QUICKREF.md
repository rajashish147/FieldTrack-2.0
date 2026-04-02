# Rollback System Quick Reference

## Commands

### Deploy Latest Version
```bash
cd /api
./scripts/deploy-bluegreen.sh <SHA>
```

### Rollback to Previous Version
```bash
cd /api
./scripts/rollback.sh
```

### Deploy Specific Version
```bash
./scripts/deploy-bluegreen.sh 7b3e9f1
```

## How It Works

1. Every successful deployment prepends image SHA to `.deploy_history`
2. History maintains last 5 deployments (newest first)
3. Rollback reads line 2 from `.deploy_history` and redeploys that image
4. Blue-green deployment ensures zero downtime
5. Health checks validate before switching traffic

## Deployment Flow

```
┌──────────────┐
│  CI builds   │
│  image SHA   │
└──────┬───────┘
       │
       ▼
┌──────────────────┐
│ deploy-blue      │
│ green.sh <SHA>   │
└──────┬───────────┘
       │
       ▼
┌──────────────────┐
│ Pull image       │
│ Start container  │
│ Health check     │
│ Switch nginx     │
└──────┬───────────┘
       │
       ▼
┌──────────────────┐
│ Prepend SHA to   │
│ .deploy_history  │
│ (keep last 5)    │
└──────────────────┘
```

## Rollback Flow

```
┌──────────────────┐
│ ./rollback.sh    │
└──────┬───────────┘
       │
       ▼
┌──────────────────┐
│ Read .deploy_    │
│ history (line 2) │
└──────┬───────────┘
       │
       ▼
┌──────────────────┐
│ Show history &   │
│ confirm with user│
└──────┬───────────┘
       │
       ▼
┌──────────────────┐
│ deploy-blue      │
│ green.sh <SHA>   │
└──────────────────┘
```

## Safety Features

- ✅ Interactive confirmation before rollback
- ✅ Health check validation (20 attempts × 3s)
- ✅ Nginx config validation before reload
- ✅ Automatic cleanup on failure
- ✅ Zero downtime blue-green deployment
- ✅ Immutable image SHAs

## File Locations

```
/api/
├── scripts/
│   ├── deploy-bluegreen.sh
│   └── rollback.sh
└── .deploy_history (last 5 SHAs)
```

## Example Session

```bash
# Deploy new version
$ ./scripts/deploy-bluegreen.sh b8c4d2e
[1/7] Pulling image...
[2/7] Detecting active container...
[3/7] Starting inactive container...
[4/7] Waiting for health check...
[5/7] Switching nginx upstream...
[6/7] Reloading nginx...
[7/7] Cleaning old container...
Deployment successful.
Deployment history updated: b8c4d2e

# Issue discovered - rollback
$ ./scripts/rollback.sh
Current deployment : b8c4d2e
Previous deployment: a4f91c2

Deployment history:
  1. b8c4d2e (current)
  2. a4f91c2 ← rollback target
  3. 7b3e9f1

⚠️  WARNING: This will redeploy the previous version.
Current production will be replaced with: a4f91c2

Continue with rollback? (yes/no): yes

Starting rollback to image: a4f91c2
[1/7] Pulling image...
...
Rollback completed successfully.
Production is now running: a4f91c2
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| Script not executable | `chmod +x scripts/rollback.sh` |
| No deployment history | Deploy at least once before rollback |
| Insufficient history | Need at least 2 deployments to rollback |
| Image not found | Verify SHA exists in GHCR |
| Health check fails | Check logs: `docker logs api-blue` |

## Performance

- **Rollback time:** <10 seconds
- **Health check:** Up to 60 seconds
- **Zero downtime:** Always maintained

## Related Docs

- [Full Documentation](./ROLLBACK_SYSTEM.md)
- [Deployment Guide](./DEPLOYMENT.md)
