#!/usr/bin/env bash
# Inspect adgate JSONL logs (server + extension-shipped client events).
set -euo pipefail
LOG="${ADGATE_LOG_PATH:-/home/ruin/projects/experiments/adblock-systemone/logs/adgate.jsonl}"
N="${1:-60}"
if [[ ! -f "$LOG" ]]; then
  echo "No log yet: $LOG"
  echo "Hit /health or run a scan first."
  exit 1
fi
echo "## $LOG (last $N lines)"
tail -n "$N" "$LOG" | while IFS= read -r line; do
  python3 -c 'import json,sys; d=json.loads(sys.argv[1]); print("{ts} {event} {rest}".format(ts=d.get("ts",""), event=d.get("event") or d.get("clientEvent",""), rest={k:v for k,v in d.items() if k not in ("ts","event","clientEvent")}))' "$line" 2>/dev/null || echo "$line"
done
