#!/usr/bin/env bash
# Installs the deploy-server vhost into the host nginx and issues its
# Let's Encrypt certificate.
#
# Run on the server, as root, from the repository root:
#
#     sudo ./scripts/setup-nginx-tls.sh
#
# Rerun it after editing nginx/deploy-server.conf.template - the file is
# copied into /etc/nginx, not symlinked, because the deploy workflow runs
# `git checkout -- .` and would revert anything nginx or certbot wrote back.
#
# Requirements: nginx and certbot installed on the host, DOMAIN resolving to
# this server, ports 80 and 443 open.

set -euo pipefail

cd "$(dirname "$0")/.."

[ "$(id -u)" -eq 0 ] || { echo "error: run with sudo"; exit 1; }
[ -f .env ] || { echo "error: .env is missing"; exit 1; }

set -a
. ./.env
set +a

: "${DOMAIN:?error: DOMAIN is not set in .env}"
: "${LETSENCRYPT_EMAIL:?error: LETSENCRYPT_EMAIL is not set in .env}"

# The container publishes this port on 127.0.0.1; nginx proxies to it.
PORT="${PORT:-3000}"
STAGING="${CERTBOT_STAGING:-0}"
WEBROOT=/var/www/certbot

command -v nginx >/dev/null   || { echo "error: nginx is not installed"; exit 1; }
command -v certbot >/dev/null || { echo "error: certbot is not installed (apt install certbot)"; exit 1; }

# Debian and Ubuntu use sites-available/sites-enabled; RHEL-style layouts only
# have conf.d.
if [ -d /etc/nginx/sites-enabled ]; then
    TARGET="/etc/nginx/sites-available/$DOMAIN.conf"
    LINK="/etc/nginx/sites-enabled/$DOMAIN.conf"
else
    TARGET="/etc/nginx/conf.d/$DOMAIN.conf"
    LINK=""
fi

install_vhost() {
    sed -e "s|__DOMAIN__|$DOMAIN|g" -e "s|__PORT__|$PORT|g" "$1" > "$TARGET"
    [ -n "$LINK" ] && ln -sfn "$TARGET" "$LINK"
    nginx -t
    systemctl reload nginx
}

mkdir -p "$WEBROOT/.well-known/acme-challenge"

# A global hook, not `--deploy-hook` on the issuing command: this way a
# certificate that already exists also reloads nginx when it renews.
mkdir -p /etc/letsencrypt/renewal-hooks/deploy
cat > /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh <<'HOOK'
#!/bin/sh
systemctl reload nginx
HOOK
chmod +x /etc/letsencrypt/renewal-hooks/deploy/reload-nginx.sh

if [ -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
    echo "==> certificate for $DOMAIN already exists, installing the vhost"
else
    echo "==> installing the challenge-only vhost"
    install_vhost nginx/deploy-server.bootstrap.conf.template

    echo "==> requesting the certificate for $DOMAIN"
    # Staging has far looser rate limits; use it while testing the setup,
    # because five failed production attempts per hour lock the domain out.
    staging_arg=""
    [ "$STAGING" != "0" ] && staging_arg="--staging"

    certbot certonly --webroot -w "$WEBROOT" \
        -d "$DOMAIN" \
        --email "$LETSENCRYPT_EMAIL" \
        --agree-tos --no-eff-email --non-interactive \
        $staging_arg
fi

echo "==> installing the TLS vhost"
install_vhost nginx/deploy-server.conf.template

echo
echo "done: https://$DOMAIN/healthz"
