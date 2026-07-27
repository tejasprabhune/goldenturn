FROM node:20-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund

COPY lib.ts process.ts run.ts manifest.json ./

ENV MANIFEST=/app/manifest.json
ENV CONCURRENCY=4
ENV LIMIT=10000
CMD ["npx", "tsx", "run.ts"]
