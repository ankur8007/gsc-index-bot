#!/usr/bin/env bash
# Daily headless run wrapper for macOS / Linux cron.
# Login must already be saved once via: npm run login
# Example cron line (every day at 09:00):
#   0 9 * * * /path/to/gsc-index-bot/run.sh
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p output
node gsc-index-bot.mjs --limit=10 >> output/daily.log 2>&1
