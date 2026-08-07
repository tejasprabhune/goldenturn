# The proof-of-origin token server, taken whole from its own published image
# rather than rebuilt here.
FROM brainicism/bgutil-ytdlp-pot-provider AS pot

FROM node:20-slim

# YouTube needs two things from a caller before it will hand over a video. A
# JavaScript runtime, to work out the real media URLs; yt-dlp says so plainly
# and returns fewer formats without one. And, from an address it does not
# recognise as a person's, a proof-of-origin token, without which every
# request from a datacentre is answered with "sign in to confirm you're not a
# bot". The token is generated locally by the plugin below, so this needs no
# account and no cookies.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates python3 python3-pip curl unzip \
 && pip3 install --break-system-packages --no-cache-dir yt-dlp bgutil-ytdlp-pot-provider \
 && curl -fsSL https://github.com/denoland/deno/releases/latest/download/deno-x86_64-unknown-linux-gnu.zip -o /tmp/deno.zip \
 && unzip -q /tmp/deno.zip -d /usr/local/bin \
 && chmod +x /usr/local/bin/deno \
 && rm -f /tmp/deno.zip \
 && rm -rf /var/lib/apt/lists/*

COPY --from=pot /app /pot

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY lib.ts process.ts run.ts manifest.json relink.ts relink.json ./
COPY policy-audio.ts policy-source.ts policy-rounds.json ./

ENV MANIFEST=/app/manifest.json
# The policy scripts read their source relative to the repo root when run by
# hand; in here everything is flat in /app.
ENV SOURCE_PATH=/app/policy-rounds.json
ENV RELINK=/app/relink.json
ENV RELINK_OUT=0
ENV CONCURRENCY=4
ENV LIMIT=10000

# Which pass to run is an env var rather than a command override: the CLI
# mangles command arguments, and every job already carries env vars.
ENV SCRIPT=run.ts

# The token server has to be answering before the first download asks it for
# one, and it is only ever spoken to over the loopback inside this container.
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh
CMD ["/app/entrypoint.sh"]
