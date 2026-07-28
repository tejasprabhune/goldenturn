FROM node:20-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates python3 python3-pip \
 && pip3 install --break-system-packages --no-cache-dir yt-dlp \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY lib.ts process.ts run.ts manifest.json relink.ts relink.json ./

ENV MANIFEST=/app/manifest.json
ENV RELINK=/app/relink.json
ENV RELINK_OUT=0
ENV CONCURRENCY=4
ENV LIMIT=10000

# Which pass to run is an env var rather than a command override: the CLI
# mangles command arguments, and every job already carries env vars.
ENV SCRIPT=run.ts
CMD ["sh", "-c", "npx tsx ${SCRIPT}"]
