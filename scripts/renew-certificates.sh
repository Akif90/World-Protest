#!/bin/sh
# Run as root (e.g. from cron); Docker and the project's .env must be available.
set -eu

PROJECT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$PROJECT_DIR"

# Serialize renewals so manual and scheduled invocations cannot overlap.
exec 9>/var/lock/world-protest-certificates.lock
flock -n 9 || exit 0

docker compose -f docker-compose.yml -f docker-compose.https.yml \
  run --rm -T certbot renew --webroot -w /var/www/certbot --non-interactive

# Renew returns success even when no certificate is due; reloading is harmless.
docker compose -f docker-compose.yml -f docker-compose.https.yml \
  exec -T frontend nginx -t
docker compose -f docker-compose.yml -f docker-compose.https.yml \
  exec -T frontend nginx -s reload
