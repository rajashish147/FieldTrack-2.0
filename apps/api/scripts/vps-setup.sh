#!/bin/bash
# ============================================================================
# FieldTrack 2.0 — VPS Setup Script
# ============================================================================
#
# Deterministic first-time setup for a fresh Ubuntu 22.04/24.04 VPS.
#
# USAGE:
#   Step 1: Copy this script to the VPS
#   Step 2: Set the variables below
#   Step 3: Run: sudo bash vps-setup.sh
#
# PREREQUISITES:
#   - Fresh Ubuntu 22.04 or 24.04 LTS VPS
#   - Root or sudo access
#   - GitHub PAT with packages:read scope (for GHCR)
#
# ============================================================================

set -euo pipefail

# ── Configuration (EDIT THESE) ─────────────────────────────────────────────────
DOMAIN="api.getfieldtrack.app"               # Production API domain
FRONTEND_DOMAIN="app.getfieldtrack.app"      # Production frontend domain
GH_USER="fieldtrack-tech"                    # GitHub org name
GH_PAT=""                                   # GitHub Personal Access Token (packages:read)
DEPLOY_USER="ashish"                        # Non-root user for deployment
DEPLOY_USER_SSH_PUBLIC_KEY=""               # Required public key for deploy user (ssh-ed25519 ...)
REPO_URL="https://github.com/fieldtrack-tech/fieldtrack-2.0.git"
REPO_DIR="/home/${DEPLOY_USER}/FieldTrack-2.0"
NETWORK="fieldtrack_network"
NGINX_SITE_LINK="/etc/nginx/conf.d/fieldtrack.conf"

# ── Colour output ─────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }

render_nginx_ssl_config() {
    local target_file="$1"
    cp "$REPO_DIR/infra/nginx/fieldtrack.conf" "$target_file"
    sed -i "s|__API_DOMAIN__|$DOMAIN|g" "$target_file"
    sed -i "s|__FRONTEND_DOMAIN__|$FRONTEND_DOMAIN|g" "$target_file"
}

echo ""
echo "============================================="
echo "  FieldTrack 2.0 — VPS Setup"
echo "============================================="
echo ""

# ── Pre-flight checks ─────────────────────────────────────────────────────────
if [ "$EUID" -ne 0 ]; then
    err "This script must be run as root (sudo bash vps-setup.sh)"
fi

if [ "$GH_PAT" = "" ]; then
    err "Set GH_PAT (GitHub Personal Access Token) before running."
fi

# ============================================================================
# PHASE 1: System Packages
# ============================================================================
log "Phase 1: Updating system packages..."

apt-get update -y
apt-get upgrade -y
apt-get install -y \
    curl \
    wget \
    git \
    ufw \
    fail2ban \
    htop \
    unzip \
    nano \
    ca-certificates \
    gnupg \
    lsb-release \
    software-properties-common

log "System packages installed."

# ============================================================================
# PHASE 2: Create Deploy User (if not exists)
# ============================================================================
if ! id "$DEPLOY_USER" &>/dev/null; then
    log "Phase 2: Creating deploy user '$DEPLOY_USER'..."
    adduser --disabled-password --gecos "" "$DEPLOY_USER"
    usermod -aG sudo "$DEPLOY_USER"
    log "User '$DEPLOY_USER' created."
else
    log "Phase 2: User '$DEPLOY_USER' already exists."
fi

# Install deploy user SSH key before any SSH hardening.
log "Phase 2b: Installing deploy user SSH authorized_keys..."

DEPLOY_HOME="/home/${DEPLOY_USER}"
DEPLOY_SSH_DIR="$DEPLOY_HOME/.ssh"
DEPLOY_AUTH_KEYS="$DEPLOY_SSH_DIR/authorized_keys"

install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "$DEPLOY_SSH_DIR"
touch "$DEPLOY_AUTH_KEYS"
chown "$DEPLOY_USER:$DEPLOY_USER" "$DEPLOY_AUTH_KEYS"
chmod 600 "$DEPLOY_AUTH_KEYS"

if [ -n "$DEPLOY_USER_SSH_PUBLIC_KEY" ]; then
    if ! grep -qxF "$DEPLOY_USER_SSH_PUBLIC_KEY" "$DEPLOY_AUTH_KEYS"; then
        echo "$DEPLOY_USER_SSH_PUBLIC_KEY" >> "$DEPLOY_AUTH_KEYS"
        log "Deploy user public key installed."
    else
        log "Deploy user public key already present."
    fi
else
    warn "DEPLOY_USER_SSH_PUBLIC_KEY is empty."
fi

if [ ! -s "$DEPLOY_AUTH_KEYS" ]; then
    err "No deploy user SSH keys installed. Set DEPLOY_USER_SSH_PUBLIC_KEY before running this script."
fi

ssh-keygen -l -f "$DEPLOY_AUTH_KEYS" >/dev/null || err "authorized_keys content is invalid."
log "Deploy user SSH key material verified."

# ============================================================================
# PHASE 3: Docker Installation
# ============================================================================
log "Phase 3: Installing Docker..."

if command -v docker &>/dev/null; then
    warn "Docker already installed, skipping."
else
    install -m 0755 -d /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | \
        gpg --dearmor -o /etc/apt/keyrings/docker.gpg
    chmod a+r /etc/apt/keyrings/docker.gpg

    echo \
      "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
      https://download.docker.com/linux/ubuntu \
      $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | \
      tee /etc/apt/sources.list.d/docker.list > /dev/null

    apt-get update -y
    apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

    usermod -aG docker "$DEPLOY_USER"

    systemctl enable docker
    systemctl start docker

    log "Docker installed and started."
fi

# ============================================================================
# PHASE 4: Swap File (2GB)
# ============================================================================
log "Phase 4: Configuring swap..."

if swapon --show | grep -q "/swapfile"; then
    warn "Swap already configured, skipping."
else
    fallocate -l 2G /swapfile
    chmod 600 /swapfile
    mkswap /swapfile
    swapon /swapfile

    if ! grep -q "/swapfile" /etc/fstab; then
        echo "/swapfile none swap sw 0 0" >> /etc/fstab
    fi

    sysctl vm.swappiness=10
    echo "vm.swappiness=10" >> /etc/sysctl.conf

    log "2GB swap file created."
fi

# ============================================================================
# PHASE 5: UFW Firewall
# ============================================================================
log "Phase 5: Configuring UFW firewall..."

ufw default deny incoming
ufw default allow outgoing
ufw allow OpenSSH
ufw allow 80/tcp      # HTTP (nginx)
ufw allow 443/tcp     # HTTPS (nginx)
# All other ports are internal only — no UFW rule needed

echo "y" | ufw enable

log "UFW firewall configured (SSH, HTTP, HTTPS allowed)."

# ============================================================================
# PHASE 6: SSH Safety Precheck
# ============================================================================
log "Phase 6: Verifying SSH safety prerequisites..."

SSHD_CONFIG="/etc/ssh/sshd_config"

if [ ! -s "$DEPLOY_AUTH_KEYS" ]; then
    err "Deploy user authorized_keys is empty; refusing to harden SSH."
fi

sshd -t
log "SSH config syntax is valid. Hardening will run after deploy user access is in place."

# ============================================================================
# PHASE 7: Fail2Ban
# ============================================================================
log "Phase 7: Configuring Fail2Ban..."

cat > /etc/fail2ban/jail.local << 'EOF'
[DEFAULT]
bantime  = 3600
findtime = 600
maxretry = 5

[sshd]
enabled = true
port    = ssh
logpath = %(sshd_log)s
backend = %(sshd_backend)s
EOF

systemctl enable fail2ban
systemctl restart fail2ban

log "Fail2Ban configured."

# ============================================================================
# PHASE 8: Clone Repository
# ============================================================================
log "Phase 8: Cloning repository..."

if [ -d "$REPO_DIR" ]; then
    warn "Repository directory already exists, pulling latest..."
    cd "$REPO_DIR"
    sudo -u "$DEPLOY_USER" git fetch origin
    sudo -u "$DEPLOY_USER" git reset --hard origin/master
else
    sudo -u "$DEPLOY_USER" git clone "$REPO_URL" "$REPO_DIR"
fi

log "Repository ready at $REPO_DIR"

# ============================================================================
# PHASE 9: Create Docker Network
# ============================================================================
log "Phase 9: Creating Docker network..."

if docker network ls --format '{{.Name}}' | grep -Eq "^${NETWORK}$"; then
    warn "Network '$NETWORK' already exists."
else
    docker network create --driver bridge "$NETWORK"
    log "Docker network '$NETWORK' created."
fi

# ============================================================================
# PHASE 10: Nginx Installation & Configuration
# ============================================================================
log "Phase 10: Installing and configuring Nginx (HTTP bootstrap stage)..."

apt-get install -y nginx

# Remove default site
rm -f /etc/nginx/conf.d/default

mkdir -p /var/www/certbot

BOOTSTRAP_NGINX_CONF="/tmp/fieldtrack-bootstrap-http.conf"
cat > "$BOOTSTRAP_NGINX_CONF" << EOF
server {
    listen 80;
    listen [::]:80;
    server_name $DOMAIN;
    location /.well-known/acme-challenge/ {
        root /var/www/certbot;
    }
    location / {
        return 200 'FieldTrack bootstrap HTTP mode';
        add_header Content-Type text/plain;
    }
}
EOF

# Stage 1: temporary HTTP-only config to allow certificate bootstrap
cp "$BOOTSTRAP_NGINX_CONF" "$NGINX_SITE_LINK"
nginx -t && systemctl enable nginx && systemctl restart nginx
log "Nginx HTTP bootstrap config active at $NGINX_SITE_LINK"

# =========================================================================
# PHASE 11: SSL Certificate (Let's Encrypt / Certbot)
# =========================================================================
log "Phase 11: Provisioning SSL certificate..."
apt-get install -y certbot python3-certbot-nginx
certbot certonly --webroot -w /var/www/certbot -d "$DOMAIN" --non-interactive --agree-tos --email "admin@$DOMAIN" --keep-until-expiring
systemctl enable certbot.timer
log "SSL certificate provisioned for $DOMAIN"

# Stage 2: install SSL Nginx config after certs exist
log "Phase 11b: Activating SSL Nginx config..."
render_nginx_ssl_config "$NGINX_SITE_LINK"
nginx -t && systemctl reload nginx
log "SSL Nginx config activated at $NGINX_SITE_LINK"

# ============================================================================
# PHASE 12: GHCR Login
# ============================================================================
log "Phase 12: Logging into GitHub Container Registry..."

echo "$GH_PAT" | sudo -u "$DEPLOY_USER" docker login ghcr.io -u "$GH_USER" --password-stdin

log "GHCR login successful."

# ============================================================================
# PHASE 13: Environment File
# ============================================================================
log "Phase 13: Setting up environment file..."

ENV_FILE="$REPO_DIR/apps/api/.env"

if [ -f "$ENV_FILE" ]; then
    warn ".env file already exists. Verify its contents are correct."
else
    cp "$REPO_DIR/apps/api/.env.example" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    chown "$DEPLOY_USER:$DEPLOY_USER" "$ENV_FILE"
    warn ".env file created from template. EDIT IT NOW:"
    warn "  nano $ENV_FILE"
fi

MONITORING_ENV_FILE="$REPO_DIR/infra/.env.monitoring"

if [ -f "$MONITORING_ENV_FILE" ]; then
    chmod 600 "$MONITORING_ENV_FILE"
    chown "$DEPLOY_USER:$DEPLOY_USER" "$MONITORING_ENV_FILE"
    warn "Monitoring env file detected. Verify its values: $MONITORING_ENV_FILE"
else
    err "Missing $MONITORING_ENV_FILE. Ensure infra/.env.monitoring exists in the repository."
fi

# ============================================================================
# PHASE 14: Start Monitoring Stack
# ============================================================================
log "Phase 14: Starting monitoring stack..."

cd "$REPO_DIR/infra"
sudo -u "$DEPLOY_USER" docker compose --env-file .env.monitoring -f docker-compose.monitoring.yml up -d

log "Monitoring stack started (Prometheus, Grafana, Node Exporter)"

# ============================================================================
# PHASE 15: First Deployment
# ============================================================================
log "Phase 15: Pulling and starting initial backend container..."

# Pull the latest image
sudo -u "$DEPLOY_USER" docker pull ghcr.io/fieldtrack-tech/fieldtrack-backend:latest

# Start the blue container as initial deployment
if [ -f "$ENV_FILE" ] && grep -q "SUPABASE_URL=your-" "$ENV_FILE"; then
    warn "Skipping container start — .env still has placeholder values."
    warn "After editing .env, run:"
    warn "  cd $REPO_DIR/apps/api && ./scripts/deploy-bluegreen.sh latest"
else
    sudo -u "$DEPLOY_USER" docker run -d \
        --name backend-blue \
        --network "$NETWORK" \
        -p "127.0.0.1:3001:3000" \
        --restart unless-stopped \
        --env-file "$ENV_FILE" \
        ghcr.io/fieldtrack-tech/fieldtrack-backend:latest

    log "Backend container (backend-blue) started on 127.0.0.1:3001."
fi

# ============================================================================
# PHASE 16: SSH Hardening (post-key-install)
# ============================================================================
log "Phase 16: Applying SSH hardening..."

sed -i 's/^#*PermitRootLogin.*/PermitRootLogin no/' "$SSHD_CONFIG"
sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' "$SSHD_CONFIG"
sed -i 's/^#*PermitEmptyPasswords.*/PermitEmptyPasswords no/' "$SSHD_CONFIG"

sshd -t
systemctl restart sshd

log "SSH hardened (root login disabled, password auth disabled)."

# ============================================================================
# DONE
# ============================================================================
echo ""
echo "============================================="
echo "  FieldTrack 2.0 — VPS Setup Complete"
echo "============================================="
echo ""
echo "  Next steps:"
echo "    1. Edit $ENV_FILE with production values"
echo "    2. Verify: curl http://127.0.0.1:3001/health"
echo "    3. Verify: curl https://$DOMAIN/health"
echo "    4. Edit $MONITORING_ENV_FILE (set GRAFANA_ADMIN_PASSWORD and METRICS_SCRAPE_TOKEN)"
echo "    5. Grafana: https://$DOMAIN/monitor (admin / configured password)"
echo "    6. Prometheus: Internal only (via Grafana or SSH tunnel)"
echo "    7. Set up GitHub Secrets: DO_HOST, DO_USER, DO_SSH_KEY"
echo ""
echo "  Public endpoints:"
echo "    https://$DOMAIN/health    → Backend health check"
echo "    https://$DOMAIN/api/      → Backend API"
echo "    https://$DOMAIN/monitor   → Grafana dashboard"
echo ""
echo "  Done! 🎉"
echo ""
