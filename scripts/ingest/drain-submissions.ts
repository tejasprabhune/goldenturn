/**
 * Turns submitted rounds into playable ones.
 *
 * A submission reaches search the moment it is made, but a round is not worth
 * opening until its audio is in R2 with a waveform, a transcript and speech
 * timings. This pulls the pending queue, ingests each from the link it was
 * submitted with, and tells the API what happened.
 *
 * Ingesting from the submitted link rather than searching an archive for a
 * likely filename is the whole point: matching by name is what gave eighteen
 * rounds somebody else's debate.
 *
 * Transcription is a separate GPU run, which then picks these up because they
 * have audio and no transcript.
 */
import 'dotenv/config';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtempSync, readFileSync, createWriteStream, rmSync } from 'fs';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';

const run = promisify(execFile);
const API = process.env.GT_API ?? 'https://goldenturn-api.tejas-prabhune.workers.dev';
const BUCKET = 'goldenturn-media';
const PEAK_BUCKETS = 3000;

interface Pending {
  object_id: string; slug: string; title: string; link: string;
  year: string | null; tournament: string | null; author: string | null;
}

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

function directUrl(url: string): string {
  if (url.includes('/scl/fi/')) {
    const u = new URL(url);
    u.hostname = 'dl.dropboxusercontent.com';
    u.searchParams.set('dl', '1');
    return u.toString();
  }
  return url
    .replace('www.dropbox.com', 'dl.dropboxusercontent.com')
    .replace('dl.dropbox.com', 'dl.dropboxusercontent.com')
    .split('?')[0];
}

const isVideoHost = (link: string) => /youtube\.com|youtu\.be|vimeo\.com/i.test(link);

async function fetchSource(link: string, dir: string): Promise<string> {
  if (isVideoHost(link)) {
    const out = join(dir, 'external.%(ext)s');
    await run('yt-dlp', ['-f', 'bestaudio/best', '-o', out, '--no-playlist',
      '--no-progress', '--quiet', link], { maxBuffer: 1024 * 1024 * 32 });
    const { stdout } = await run('sh', ['-c', `ls ${dir}/external.* | head -1`]);
    const path = stdout.trim();
    if (!path) throw new Error('yt-dlp produced no file');
    return path;
  }
  const dest = join(dir, 'src.bin');
  const res = await fetch(directUrl(link));
  if (!res.ok || !res.body) throw new Error(`download ${res.status}`);
  await pipeline(Readable.fromWeb(res.body as any), createWriteStream(dest));
  return dest;
}

async function computePeaks(src: string): Promise<number[]> {
  const pcm = `${src}.pcm`;
  await run('ffmpeg', ['-v', 'error', '-y', '-i', src, '-ac', '1', '-ar', '8000',
    '-f', 's16le', '-acodec', 'pcm_s16le', pcm], { maxBuffer: 1024 * 1024 * 64 });
  const raw = readFileSync(pcm);
  const samples = new Int16Array(raw.buffer, raw.byteOffset, Math.floor(raw.length / 2));
  const per = Math.max(1, Math.floor(samples.length / PEAK_BUCKETS));
  const peaks: number[] = [];
  for (let i = 0; i < PEAK_BUCKETS; i++) {
    let max = 0;
    for (let j = i * per, end = Math.min(i * per + per, samples.length); j < end; j++) {
      const v = Math.abs(samples[j]);
      if (v > max) max = v;
    }
    peaks.push(Math.round((max / 32768) * 255));
  }
  return peaks;
}

async function ingest(p: Pending, client: S3Client) {
  const dir = mkdtempSync(join(tmpdir(), 'gt-sub-'));
  try {
    const src = await fetchSource(p.link, dir);
    const out = join(dir, 'out.m4a');
    await run('ffmpeg', ['-v', 'error', '-y', '-i', src, '-vn', '-ac', '1',
      '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', out],
      { maxBuffer: 1024 * 1024 * 32 });

    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries',
      'format=duration', '-of', 'default=nw=1:nk=1', out]);
    const duration = Number(stdout.trim());
    if (!Number.isFinite(duration) || duration < 300) {
      throw new Error(`only ${Math.round(duration)}s of audio; too short for a round`);
    }

    const peaks = await computePeaks(out);
    const audio = readFileSync(out);
    await client.send(new PutObjectCommand({
      Bucket: BUCKET, Key: `audio/${p.slug}.m4a`, Body: audio, ContentType: 'audio/mp4',
      CacheControl: 'public, max-age=31536000, immutable',
    }));
    await client.send(new PutObjectCommand({
      Bucket: BUCKET, Key: `peaks/${p.slug}.json`, ContentType: 'application/json',
      CacheControl: 'public, max-age=31536000, immutable',
      Body: JSON.stringify({ slug: p.slug, duration, buckets: peaks.length, peaks }),
    }));
    return { duration, audioMB: +(audio.length / 1e6).toFixed(1) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function report(objectID: string, status: 'ingested' | 'failed', note?: string) {
  const token = process.env.GT_ADMIN_TOKEN;
  if (!token) return;
  await fetch(`${API}/recordings/${encodeURIComponent(objectID)}/status`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ status, note }),
  }).catch(() => {});
}

async function main() {
  const res = await fetch(`${API}/recordings/pending`);
  const { pending } = await res.json() as { pending: Pending[] };
  console.log(`${pending.length} submission(s) waiting on audio\n`);
  if (!pending.length) return;
  if (!process.env.GT_ADMIN_TOKEN) {
    console.log('note: GT_ADMIN_TOKEN unset, so results are not reported back\n');
  }

  const client = s3();
  const done: string[] = [];
  for (const p of pending) {
    console.log(`${p.title}\n  ${p.link.slice(0, 90)}`);
    try {
      const r = await ingest(p, client);
      console.log(`  ${Math.round(r.duration / 60)}min  ${r.audioMB}MB  -> ${p.slug}`);
      await report(p.object_id, 'ingested');
      done.push(p.slug);
    } catch (err) {
      const message = (err as Error).message.slice(0, 160);
      console.log(`  FAILED ${message}`);
      await report(p.object_id, 'failed', message);
    }
    console.log();
  }

  console.log(`ingested ${done.length} of ${pending.length}`);
  if (done.length) {
    console.log('\nnext: publish-index.ts, then a transcription run, then segment/run.ts');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
