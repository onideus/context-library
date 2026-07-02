#!/usr/bin/env bash
# Validate every supported Docker Compose stacking combination.
#
# Runs `docker compose config -q` for each overlay combination so syntax
# errors or bad merges are caught before they reach a deployment. CI does
# not validate compose startup — run this locally before opening a PR
# that touches any docker-compose*.yml file.
#
# Usage: ./scripts/test-compose.sh

set -u

cd "$(dirname "$0")/.."

failures=0

validate() {
  local label=$1
  shift
  if docker compose "$@" config -q 2>/dev/null; then
    echo "ok    $label"
  else
    echo "FAIL  $label"
    docker compose "$@" config -q || true
    failures=$((failures + 1))
  fi
}

validate "base" \
  -f docker-compose.yml
validate "base + postgres" \
  -f docker-compose.yml -f docker-compose.postgres.yml
validate "base + postgres + embeddings" \
  -f docker-compose.yml -f docker-compose.postgres.yml -f docker-compose.embeddings.yml
validate "base + postgres + auth" \
  -f docker-compose.yml -f docker-compose.postgres.yml -f docker-compose.auth.yml
validate "base + postgres + entities" \
  -f docker-compose.yml -f docker-compose.postgres.yml -f docker-compose.entities.yml
validate "full stack" \
  -f docker-compose.yml -f docker-compose.postgres.yml -f docker-compose.embeddings.yml \
  -f docker-compose.auth.yml -f docker-compose.entities.yml

if [ "$failures" -gt 0 ]; then
  echo ""
  echo "$failures combination(s) failed validation"
  exit 1
fi
echo ""
echo "All compose combinations validate"
