#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

cd "${ROOT_DIR}"

mkdir -p photos seen-data

echo "Building frontend (Docker/web settings)..."
pushd frontend >/dev/null
npm ci
VITE_ENABLE_FILE_BROWSER=1 npm run build
popd >/dev/null

echo "Starting Docker smoke stack..."
docker compose -f docker-compose.smoke.yml up -d --build

cleanup() {
  docker compose -f docker-compose.smoke.yml down -v --remove-orphans >/dev/null 2>&1 || true
}
trap cleanup EXIT

echo "Waiting for backend..."
for i in {1..60}; do
  if curl -fsS "http://localhost:9161/api/health" >/dev/null 2>&1; then
    break
  fi
  sleep 1
done

echo "Checking /api/health..."
curl -fsS "http://localhost:9161/api/health" | head -c 200 || true
echo

echo "Checking frontend index at / ..."
HTML="$(curl -fsS "http://localhost:9161/" | head -c 500)"
echo "${HTML}" | head -n 5

echo "Smoke test passed."


