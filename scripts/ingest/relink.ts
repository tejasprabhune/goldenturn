/**
 * Ingests the rounds audit-match.ts unlinked, from the share link each round
 * was submitted with.
 *
 * Those recordings were never in the archive folder the original matcher
 * searched, which is why it found nothing and fuzzy-matched them to somebody
 * else's round. They sit behind the submitted URL, and the filename inside that
 * URL names the round exactly, down to "Berkeley BC" where the index says
 * "Cal BC". Sourcing from the link is therefore both correct and checkable.
 *
 * Same output as the normal pipeline: a 64k mono AAC and 3000 peak buckets.
 */
import 'dotenv/config';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtempSync, readFileSync, createWriteStream, rmSync, writeFileSync } from 'fs';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const run = promisify(execFile);
const BUCKET = 'goldenturn-media';
const PEAK_BUCKETS = 3000;

interface Target { slug: string; title: string; url: string; alive: boolean; filename: string; bytes: number }

function s3(): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.CLOUDFLARE_S3_KEY!,
      secretAccessKey: process.env.CLOUDFLARE_S3_SECRET!,
    },
  });
}

async function probeDuration(path: string): Promise<number> {
  const { stdout } = await run('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', path,
  ]);
  return Number(stdout.trim());
}

async function computePeaks(src: string, buckets: number): Promise<number[]> {
  const pcm = `${src}.pcm`;
  await run('ffmpeg', ['-v', 'error', '-y', '-i', src, '-ac', '1', '-ar', '8000',
    '-f', 's16le', '-acodec', 'pcm_s16le', pcm], { maxBuffer: 1024 * 1024 * 64 });
  const raw = readFileSync(pcm);
  const samples = new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 2));
  const per = Math.max(1, Math.floor(samples.length / buckets));
  const peaks: number[] = [];
  for (let i = 0; i < buckets; i++) {
    let max = 0;
    const start = i * per;
    const end = Math.min(start + per, samples.length);
    for (let j = start; j < end; j++) {
      const v = Math.abs(samples[j]);
      if (v > max) max = v;
    }
    peaks.push(Math.round((max / 32768) * 255));
  }
  return peaks;
}

/** Streamed to disk: two of these sources are multi-gigabyte video. */
async function download(url: string, dest: string): Promise<void> {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`download ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as any), createWriteStream(dest));
}

async function ingest(t: Target, client: S3Client) {
  const dir = mkdtempSync(join(tmpdir(), 'gt-relink-'));
  const started = Date.now();
  try {
    const src = join(dir, 'src.bin');
    await download(t.url, src);

    const out = join(dir, 'out.m4a');
    await run('ffmpeg', ['-v', 'error', '-y', '-i', src, '-vn', '-ac', '1',
      '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', out],
      { maxBuffer: 1024 * 1024 * 32 });

    const duration = await probeDuration(out);
    const peaks = await computePeaks(out, PEAK_BUCKETS);
    const audio = readFileSync(out);

    await client.send(new PutObjectCommand({
      Bucket: BUCKET, Key: `audio/${t.slug}.m4a`, Body: audio, ContentType: 'audio/mp4',
      CacheControl: 'public, max-age=31536000, immutable',
    }));
    await client.send(new PutObjectCommand({
      Bucket: BUCKET, Key: `peaks/${t.slug}.json`, ContentType: 'application/json',
      CacheControl: 'public, max-age=31536000, immutable',
      Body: JSON.stringify({ slug: t.slug, duration, buckets: peaks.length, peaks }),
    }));

    return { duration: Math.round(duration), audioMB: +(audio.length / 1e6).toFixed(1),
             seconds: +((Date.now() - started) / 1000).toFixed(0) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function main() {
  const targets: Target[] = JSON.parse(readFileSync('scripts/ingest/relink.json', 'utf8'))
    .filter((t: Target) => t.alive);
  const only = process.argv.slice(2);
  const work = only.length ? targets.filter(t => only.includes(t.slug)) : targets;

  console.log(`ingesting ${work.length} rounds from their own share links\n`);
  const client = s3();
  const done: string[] = [];

  for (const t of work) {
    process.stdout.write(`${t.title}\n  ${t.filename}\n  `);
    try {
      const r = await ingest(t, client);
      console.log(`${Math.round(r.duration / 60)}min  ${r.audioMB}MB  in ${r.seconds}s`);
      done.push(t.slug);
    } catch (err) {
      console.log(`FAILED ${(err as Error).message.slice(0, 120)}`);
    }
    console.log();
  }

  writeFileSync('scripts/ingest/relinked.json', JSON.stringify(done, null, 2));
  console.log(`${done.length} of ${work.length} ingested; wrote scripts/ingest/relinked.json`);
}

main().catch(err => { console.error(err); process.exit(1); });
