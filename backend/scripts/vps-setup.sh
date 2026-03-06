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
DOMAIN="fieldtrack.meowsician.tech"         # Production domain
GH_USER="rajashish147"                      # GitHub username
GH_PAT=""                                   # GitHub Personal Access Token (packages:read)
DEPLOY_USER="ashish"                        # Non-root user for deployment
REPO_URL="https://github.com/rajashish147/FieldTrack-2.0.git"
REPO_DIR="/home/${DEPLOY_USER}/FieldTrack-2.0"
NETWORK="fieldtrack_network"

# ── Colour output ─────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

log()  { echo -e "${GREEN}[✓]${NC} $1"; }
warn() { echo -e "${YELLOW}[!]${NC} $1"; }
err()  { echo -e "${RED}[✗]${NC} $1"; exit 1; }

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
# PHASE 6: SSH Hardening
# ============================================================================
log "Phase 6: Hardening SSH..."

SSHD_CONFIG="/etc/ssh/sshd_config"

sed -i 's/^#*PermitRootLogin.*/PermitRootLogin no/' "$SSHD_CONFIG"
sed -i 's/^#*PasswordAuthentication.*/PasswordAuthentication no/' "$SSHD_CONFIG"
sed -i 's/^#*PermitEmptyPasswords.*/PermitEmptyPasswords no/' "$SSHD_CONFIG"

systemctl restart sshd

log "SSH hardened (root login disabled, key-only auth)."

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
log "Phase 10: Installing and configuring Nginx..."

apt-get install -y nginx

# Remove default site
rm -f /etc/nginx/sites-enabled/default

# Symlink FieldTrack config
ln -sf "$REPO_DIR/infra/nginx/fieldtrack.conf" /etc/nginx/sites-enabled/fieldtrack

# Test and start nginx (SSL lines are commented out initially)
nginx -t
systemctl enable nginx
systemctl restart nginx

log "Nginx configured and running."

# ============================================================================
# PHASE 11: SSL Certificate (Let's Encrypt / Certbot)
# ============================================================================
log "Phase 11: Provisioning SSL certificate..."

apt-get install -y certbot python3-certbot-nginx

certbot --nginx \
    -d "$DOMAIN" \
    --non-interactive \
    --agree-tos \
    --email "admin@$DOMAIN" \
    --redirect

systemctl enable certbot.timer

log "SSL certificate provisioned for $DOMAIN"

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

ENV_FILE="$REPO_DIR/backend/.env"

if [ -f "$ENV_FILE" ]; then
    warn ".env file already exists. Verify its contents are correct."
else
    cp "$REPO_DIR/backend/.env.example" "$ENV_FILE"
    chmod 600 "$ENV_FILE"
    chown "$DEPLOY_USER:$DEPLOY_USER" "$ENV_FILE"
    warn ".env file created from template. EDIT IT NOW:"
    warn "  nano $ENV_FILE"
fi

# ============================================================================
# PHASE 14: Start Monitoring Stack
# ============================================================================
log "Phase 14: Starting monitoring stack..."

cd "$REPO_DIR/infra"
sudo -u "$DEPLOY_USER" docker compose -f docker-compose.monitoring.yml up -d

log "Monitoring stack started (Prometheus, Grafana, Node Exporter)"

# ============================================================================
# PHASE 15: First Deployment
# ============================================================================
log "Phase 15: Pulling and starting initial backend container..."

# Pull the latest image
sudo -u "$DEPLOY_USER" docker pull ghcr.io/rajashish147/fieldtrack-backend:latest

# Start the blue container as initial deployment
if [ -f "$ENV_FILE" ] && grep -q "SUPABASE_URL=your-" "$ENV_FILE"; then
    warn "Skipping container start — .env still has placeholder values."
    warn "After editing .env, run:"
    warn "  cd $REPO_DIR/backend && ./scripts/deploy-bluegreen.sh latest"
else
    sudo -u "$DEPLOY_USER" docker run -d \
        --name backend-blue \
        --network "$NETWORK" \
        -p "127.0.0.1:3001:3000" \
        --restart unless-stopped \
        --env-file "$ENV_FILE" \
        ghcr.io/rajashish147/fieldtrack-backend:latest

    log "Backend container (backend-blue) started on 127.0.0.1:3001."
fi

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
echo "    4. Grafana: https://$DOMAIN/monitor (admin / fieldtrack_admin)"
echo "    5. Prometheus: Internal only (via Grafana or SSH tunnel)"
echo "    6. Set up GitHub Secrets: DO_HOST, DO_USER, DO_SSH_KEY"
echo ""
echo "  Public endpoints:"
echo "    https://$DOMAIN/health    → Backend health check"
echo "    https://$DOMAIN/api/      → Backend API"
echo "    https://$DOMAIN/monitor   → Grafana dashboard"
echo ""
echo "  Done! 🎉"
echo ""
