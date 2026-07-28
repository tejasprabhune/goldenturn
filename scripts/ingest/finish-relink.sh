#!/bin/bash
# Waits for the Azure relink ingest, then does what has to happen only after
# the audio is actually replaced: retire the transcript and speech fit the
# wrong match left behind, put the rounds back in the index, and let the
# transcribers pick them up. Retiring earlier would have the transcriber
# re-transcribe the wrong audio; retiring never would have it skip them.
set -euo pipefail
cd "$(dirname "$0")/../.."

JOB=gt-ingest-0
RG=thava
BIG="finals-oregon-em-vs-washburn-bk-c23d88 round-4-texas-tech-hh-vs-cal-mm-125fa6"

echo "waiting for $JOB"
until [ "$(az containerapp job execution list -n $JOB -g $RG --query '[0].properties.status' -o tsv 2>/dev/null | tail -1)" != "Running" ]; do
  sleep 60
done
STATUS=$(az containerapp job execution list -n $JOB -g $RG --query '[0].properties.status' -o tsv 2>/dev/null | tail -1)
echo "ingest finished: $STATUS"
[ "$STATUS" = "Succeeded" ] || { echo "ingest did not succeed; stopping"; exit 1; }

node -e "require('fs').writeFileSync('scripts/ingest/relinked.json', JSON.stringify('$BIG'.split(' '), null, 2))"
npx tsx scripts/ingest/retire-stale.ts
npx tsx scripts/ingest/relink-index.ts

# Those two sit in 12-way shards 9 and 11, which is gt-rx-9 and gt-rx-11.
echo "restarting transcription for the two"
for j in gt-rx-9 gt-rx-11; do az containerapp job start -n $j -g $RG -o none; done
echo "done"
