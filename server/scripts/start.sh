#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
export ADGATE_JEV_URL="${ADGATE_JEV_URL:-http://127.0.0.1:8765}"
export PYTHONUNBUFFERED=1
exec "$ROOT/.venv/bin/uvicorn" app:app --host 0.0.0.0 --port 8770
