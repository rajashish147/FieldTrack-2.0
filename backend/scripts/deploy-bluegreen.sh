#!/bin/bash
set -euo pipefail

# ============================================================

# FieldTrack 2.0 Blue-Green Deployment Script

# Zero-downtime Docker deployment

# ============================================================

IMAGE="ghcr.io/rajashish147/fieldtrack-backend:latest"

BLUE_NAME="fieldtrack_backend_blue"
GREEN_NAME="fieldtrack_backend_green"

BLUE_PORT=3001
GREEN_PORT=3002
APP_PORT=3000

ENV_FILE="/home/ashish/FieldTrack-2.0/backend/.env"
NGINX_CONF="/etc/nginx/sites-enabled/fieldtrack.conf"

MAX_HEALTH_ATTEMPTS=20
HEALTH_INTERVAL=3

echo "========================================="
echo "FieldTrack Blue-Green Deployment Started"
echo "========================================="

# ------------------------------------------------------------

# Step 1 — Pull latest Docker image

# ------------------------------------------------------------

echo "[1/7] Pulling latest Docker image..."
docker pull "$IMAGE"

# ------------------------------------------------------------

# Step 2 — Detect active container from nginx config

# ------------------------------------------------------------

echo "[2/7] Detecting active container..."

if grep -q "127.0.0.1:$BLUE_PORT" "$NGINX_CONF"; then
ACTIVE="blue"
ACTIVE_NAME=$BLUE_NAME
ACTIVE_PORT=$BLUE_PORT

```
INACTIVE="green"
INACTIVE_NAME=$GREEN_NAME
INACTIVE_PORT=$GREEN_PORT
```

else
ACTIVE="green"
ACTIVE_NAME=$GREEN_NAME
ACTIVE_PORT=$GREEN_PORT

```
INACTIVE="blue"
INACTIVE_NAME=$BLUE_NAME
INACTIVE_PORT=$BLUE_PORT
```

fi

echo "Active container   : $ACTIVE ($ACTIVE_PORT)"
echo "Inactive container : $INACTIVE ($INACTIVE_PORT)"

# ------------------------------------------------------------

# Step 3 — Start inactive container

# ------------------------------------------------------------

echo "[3/7] Starting inactive container..."

if docker ps -a --format '{{.Names}}' | grep -Eq "^${INACTIVE_NAME}$"; then
echo "Removing old $INACTIVE_NAME..."
docker rm -f "$INACTIVE_NAME"
fi

docker run -d 
--name "$INACTIVE_NAME" 
-p "$INACTIVE_PORT:$APP_PORT" 
--restart unless-stopped 
--env-file "$ENV_FILE" 
"$IMAGE"

echo "Container $INACTIVE_NAME started."

# ------------------------------------------------------------

# Step 4 — Wait for health check

# ------------------------------------------------------------

echo "[4/7] Waiting for health check..."

ATTEMPT=0

until curl -s "[http://127.0.0.1:$INACTIVE_PORT/health](http://127.0.0.1:$INACTIVE_PORT/health)" | grep -q "ok"; do
ATTEMPT=$((ATTEMPT+1))

```
if [ "$ATTEMPT" -ge "$MAX_HEALTH_ATTEMPTS" ]; then
    echo "Health check failed after $MAX_HEALTH_ATTEMPTS attempts."
    echo "Deployment aborted."
    exit 1
fi

echo "Health check not ready... retrying ($ATTEMPT/$MAX_HEALTH_ATTEMPTS)"
sleep "$HEALTH_INTERVAL"
```

done

echo "Health check passed."

# ------------------------------------------------------------

# Step 5 — Update nginx configuration

# ------------------------------------------------------------

echo "[5/7] Switching nginx to $INACTIVE container..."

sudo sed -i "s/127.0.0.1:$ACTIVE_PORT/127.0.0.1:$INACTIVE_PORT/" "$NGINX_CONF"

# ------------------------------------------------------------

# Step 6 — Validate and reload nginx

# ------------------------------------------------------------

echo "[6/7] Validating nginx configuration..."

sudo nginx -t

echo "Reloading nginx..."

sudo systemctl reload nginx

echo "Traffic switched to $INACTIVE container."

# ------------------------------------------------------------

# Step 7 — Remove old container

# ------------------------------------------------------------

echo "[7/7] Removing old container..."

docker rm -f "$ACTIVE_NAME" || echo "Old container already removed."

echo "========================================="
echo "Deployment successful."
echo "$INACTIVE container is now LIVE."
echo "========================================="
