#!/bin/sh
# Starts the proof-of-origin token server, waits for it to answer, then runs
# the pass this job was configured for.
#
# The wait matters: yt-dlp does not retry a token it could not get, so a
# download that starts a second too early is simply refused, and the failure
# looks exactly like the bot check it is there to avoid.
set -e

if [ -f /pot/build/main.js ]; then
  node /pot/build/main.js >/tmp/pot.log 2>&1 &
  for i in $(seq 1 30); do
    if curl -sf http://127.0.0.1:4416/ping >/dev/null 2>&1; then
      echo "pot provider ready after ${i}s"
      break
    fi
    sleep 1
  done
  if ! curl -sf http://127.0.0.1:4416/ping >/dev/null 2>&1; then
    echo "pot provider did not come up; downloads will likely be refused"
    tail -20 /tmp/pot.log || true
  fi
else
  echo "no pot provider in this image"
fi

exec npx tsx "${SCRIPT}"
