#!/usr/bin/env bash
# Issues the first Let's Encrypt certificate for $DOMAIN and starts the proxy.
#
# Run once, on the server, from the repository root:
#
#     ./scripts/init-letsencrypt.sh
#
# Afterwards the certbot container renews on its own; this script is only
# needed again to add a domain or to recover a deleted certificate.
#
# Requirements: DOMAIN resolves to this server, and ports 80 and 443 reach it.

set -euo pipefail

cd "$(dirname "$0")/.."

[ -f .env ] || { echo "error: .env is missing"; exit 1; }

set -a
. ./.env
set +a

: "${DOMAIN:?error: DOMAIN is not set in .env}"
: "${LETSENCRYPT_EMAIL:?error: LETSENCRYPT_EMAIL is not set in .env}"

LIVE="/etc/letsencrypt/live/$DOMAIN"
STAGING="${CERTBOT_STAGING:-0}"

certbot_sh() { docker compose run --rm --entrypoint sh certbot -c "$1"; }

if certbot_sh "test -f $LIVE/fullchain.pem" 2>/dev/null; then
    echo "certificate for $DOMAIN already exists; starting the proxy"
    docker compose up -d
    exit 0
fi

# nginx refuses to start while ssl_certificate points at a missing file, and
# certbot cannot answer the HTTP challenge until nginx is up. A throwaway
# self-signed pair breaks that cycle.
echo "==> creating a temporary self-signed certificate"
certbot_sh "mkdir -p $LIVE && openssl req -x509 -nodes -newkey rsa:2048 -days 1 \
    -keyout $LIVE/privkey.pem -out $LIVE/fullchain.pem -subj '/CN=localhost'"

echo "==> starting nginx"
docker compose up -d nginx

echo "==> removing the temporary certificate"
certbot_sh "rm -rf /etc/letsencrypt/live/$DOMAIN \
    /etc/letsencrypt/archive/$DOMAIN /etc/letsencrypt/renewal/$DOMAIN.conf"

echo "==> requesting the certificate for $DOMAIN"
# Staging has far looser rate limits; use it while testing the setup, because
# five failed production attempts per hour locks the domain out.
staging_arg=""
[ "$STAGING" != "0" ] && staging_arg="--staging"

docker compose run --rm --entrypoint certbot certbot \
    certonly --webroot -w /var/www/certbot \
    -d "$DOMAIN" \
    --email "$LETSENCRYPT_EMAIL" \
    --agree-tos --no-eff-email --non-interactive \
    $staging_arg

echo "==> reloading nginx and starting the renewal loop"
docker compose exec nginx nginx -s reload
docker compose up -d

echo
echo "done: https://$DOMAIN/healthz"
