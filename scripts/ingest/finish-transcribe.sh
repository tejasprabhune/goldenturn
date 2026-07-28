#!/bin/bash
# Waits for the transcription shards, then finishes the relinked rounds:
# fit their speeches, put them back in the index as transcribed, and deploy so
# the round pages stop saying the transcript is still queued.
set -euo pipefail
cd "$(dirname "$0")/../.."

RG=thava
JOBS="gt-rx-2 gt-rx-3 gt-rx-4 gt-rx-5 gt-rx-6 gt-rx-7 gt-rx-8 gt-rx-9 gt-rx-10 gt-rx-11"

running() {
  for j in $JOBS; do
    s=$(az containerapp job execution list -n "$j" -g $RG --query '[0].properties.status' -o tsv 2>/dev/null | tail -1)
    [ "$s" = "Running" ] && return 0
  done
  return 1
}

echo "waiting for transcription shards"
until ! running; do sleep 120; done
echo "shards finished"

SLUGS=$(node -e "console.log(require('./scripts/ingest/relink.json').map(t=>t.slug).join(' '))")

echo "fitting speeches"
SLUGS="$SLUGS" npx tsx scripts/segment/run.ts 2>&1 | tail -25

echo "updating the index"
node -e "require('fs').writeFileSync('scripts/ingest/relinked.json', JSON.stringify('$SLUGS'.split(' '), null, 2))"
npx tsx scripts/ingest/relink-index.ts

echo "purging the index at the edge"
KEY=$(grep -m1 '^CLOUDFLARE_API_TOKEN=' .env | cut -d= -f2- | tr -d '"')
curl -s -X POST "https://api.cloudflare.com/client/v4/zones/7627240c9688e6514a397b9509758a2a/purge_cache" \
  -H "X-Auth-Email: tejas.prabhune@gmail.com" -H "X-Auth-Key: $KEY" \
  -H "Content-Type: application/json" --data '{"files":["https://media.goldenturn.org/index.json"]}' -o /dev/null -w "purge %{http_code}\n"

npx tsx scripts/ingest/relink-progress.ts | tail -3
echo "done"
