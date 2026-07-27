/** Ingests a round from a local file, for sources no downloader can reach. */
import 'dotenv/config';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const run = promisify(execFile);
const BUCKET = 'goldenturn-media';
const PEAK_BUCKETS = 3000;

async function main() {
  const [file, slug] = process.argv.slice(2);
  if (!file || !slug) throw new Error('usage: ingest-local.ts <file> <slug>');

  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.CLOUDFLARE_S3_KEY!,
      secretAccessKey: process.env.CLOUDFLARE_S3_SECRET!,
    },
  });

  const dir = mkdtempSync(join(tmpdir(), 'gt-local-'));
  try {
    const out = join(dir, 'out.m4a');
    const pcm = join(dir, 'out.pcm');
    await run('ffmpeg', ['-v', 'error', '-y', '-i', file, '-vn', '-ac', '1',
      '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', out]);

    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries',
      'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', out]);
    const duration = Number(stdout.trim());

    await run('ffmpeg', ['-v', 'error', '-y', '-i', out, '-ac', '1', '-ar', '8000',
      '-f', 's16le', '-acodec', 'pcm_s16le', pcm]);
    const raw = readFileSync(pcm);
    const samples = new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 2));
    const per = Math.max(1, Math.floor(samples.length / PEAK_BUCKETS));
    const peaks: number[] = [];
    for (let i = 0; i < PEAK_BUCKETS; i++) {
      let max = 0;
      for (let j = i * per; j < Math.min((i + 1) * per, samples.length); j++) {
        const v = Math.abs(samples[j]);
        if (v > max) max = v;
      }
      peaks.push(Math.round((max / 32768) * 255));
    }

    const audio = readFileSync(out);
    await client.send(new PutObjectCommand({
      Bucket: BUCKET, Key: `audio/${slug}.m4a`, Body: audio, ContentType: 'audio/mp4',
      CacheControl: 'public, max-age=31536000, immutable',
    }));
    await client.send(new PutObjectCommand({
      Bucket: BUCKET, Key: `peaks/${slug}.json`, ContentType: 'application/json',
      CacheControl: 'public, max-age=31536000, immutable',
      Body: JSON.stringify({ slug, duration, buckets: peaks.length, peaks }),
    }));
    console.log(`ok ${slug} ${(duration / 60).toFixed(1)}min ${(audio.length / 1e6).toFixed(1)}MB`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch(e => { console.error(e.message); process.exit(1); });
