/**
 * Pulls policy round audio into R2.
 *
 * These rounds are on YouTube rather than in a Dropbox folder, and they are
 * long: a college policy round is eight speeches, four cross-examinations and
 * twenty minutes of prep, so two hours is ordinary and three is not unusual.
 * Downloading them all in one go is neither polite to the source nor useful,
 * since transcription is the slow step anyway, so this takes a batch at a time
 * and is safe to run again for the next one.
 *
 * Work is discovered from what is already in the bucket rather than from a
 * queue, matching the rest of the pipeline: a round half-done when a run died
 * is simply picked up by the next.
 *
 *   npx tsx scripts/ingest/policy-audio.ts [--limit 10] [--only <videoId,...>]
 */
import 'dotenv/config';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { S3Client, PutObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import type { PolicyRound } from './policy-source';

const run = promisify(execFile);
const BUCKET = 'goldenturn-media';
const SOURCE = join('scripts', 'ingest', 'policy-rounds.json');
const PEAK_BUCKETS = 3000;

/** Mirrors recordingSlug in src/lib/recordings.ts; the two must not drift. */
export function slugFor(title: string, objectID: string): string {
  const base = title
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70)
    .replace(/-+$/g, '');
  return `${base}-${objectID.replace(/[^a-z0-9]/gi, '').slice(0, 6).toLowerCase()}`;
}

/**
 * Which shard owns a round.
 *
 * Deliberately a hash of the id rather than a position in the queue: the queue
 * shrinks as rounds are finished, so slicing it would hand a round to a
 * different shard on every run and two jobs would race for the same download.
 */
function hashShard(id: string, count: number): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return Math.abs(h) % count;
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

async function have(client: S3Client, prefix: string, suffix: string): Promise<Set<string>> {
  const out = new Set<string>();
  let token: string | undefined;
  do {
    const r = await client.send(new ListObjectsV2Command({
      Bucket: BUCKET, Prefix: prefix, ContinuationToken: token,
    }));
    for (const o of r.Contents ?? []) {
      if (o.Key?.endsWith(suffix)) out.add(o.Key.slice(prefix.length, -suffix.length));
    }
    token = r.NextContinuationToken;
  } while (token);
  return out;
}

/** The same 3000-bucket envelope the waveform expects, from 8kHz mono PCM. */
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

async function ingest(round: PolicyRound, slug: string, client: S3Client) {
  const dir = mkdtempSync(join(tmpdir(), 'gt-policy-'));
  try {
    // YouTube refuses datacenter addresses outright unless the request looks
    // like a client it does not gate. Which client works changes, so it is a
    // setting rather than something baked in here, and cookies can be handed
    // in the same way when no client is enough.
    const extra = (process.env.YTDLP_ARGS ?? '').split(' ').filter(Boolean);
    // yt-dlp needs a JavaScript runtime and only looks for deno. Without one it
    // prints a warning as the first line of its complaint and then fails for
    // whatever the real reason was, which is what the caller sees. This script
    // is already running under a JavaScript runtime, so hand it that one.
    const js = ['--js-runtimes', `node:${process.execPath}`];
    // Everything here ends up as 64k mono AAC, and whisper hears it at 16kHz
    // mono, so YouTube's 160kbps stereo stream is three times the bytes for no
    // difference anyone or anything downstream can detect. Over four hundred
    // two-hour rounds that is the difference between a morning and a day.
    await run('yt-dlp', ['-f', 'bestaudio[abr<=80]/bestaudio/best',
      '-o', join(dir, 'src.%(ext)s'),
      '--no-playlist', '--no-progress', '--quiet', ...js, ...extra, round.link],
      { maxBuffer: 1024 * 1024 * 32 });
    const downloaded = readdirSync(dir).find(f => f.startsWith('src.'));
    if (!downloaded) throw new Error('yt-dlp produced no file');

    const out = join(dir, 'out.m4a');
    await run('ffmpeg', ['-v', 'error', '-y', '-i', join(dir, downloaded), '-vn', '-ac', '1',
      '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', out],
      { maxBuffer: 1024 * 1024 * 32 });

    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries',
      'format=duration', '-of', 'default=nw=1:nk=1', out]);
    const duration = Number(stdout.trim());
    // Eight speeches and four cross-examinations do not fit in half an hour;
    // anything this short is a clip or a broken download, not a round.
    if (!Number.isFinite(duration) || duration < 1800) {
      throw new Error(`only ${Math.round(duration)}s of audio; too short for a policy round`);
    }

    const peaks = await computePeaks(out);
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
    return { duration, audioMB: +(audio.length / 1e6).toFixed(1) };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}

async function main() {
  const limit = Number(arg('--limit') ?? process.env.LIMIT ?? '10');
  const only = (arg('--only') ?? process.env.ONLY ?? '')
    .split(',').map(s => s.trim()).filter(Boolean);
  // Sharding is by env rather than by argument because that is how the
  // container jobs are configured, and the CLI mangles command overrides.
  const shard = Number(process.env.SHARD ?? '0');
  const shardCount = Number(process.env.SHARD_COUNT ?? '1');

  const rounds = JSON.parse(readFileSync(process.env.SOURCE_PATH ?? SOURCE, 'utf-8')) as PolicyRound[];

  const client = s3();
  const audio = await have(client, 'audio/', '.m4a');

  const outstanding = rounds.filter(r => !audio.has(slugFor(r.title, r.objectID)));
  // A named round is pulled whether or not it is outstanding, so a bad
  // download can be replaced without emptying the bucket first.
  let queue = only.length ? rounds.filter(r => only.includes(r.objectID)) : outstanding;
  // Shard on the round's own id, so which shard owns a round never changes as
  // other rounds are finished and drop out of the queue.
  if (shardCount > 1) {
    queue = queue.filter(r => hashShard(r.objectID, shardCount) === shard);
  }
  const batch = queue.slice(0, limit);

  console.log(`${rounds.length} policy rounds, ${rounds.length - outstanding.length} already have audio`);
  if (shardCount > 1) console.log(`shard ${shard} of ${shardCount}: ${queue.length} outstanding here`);
  console.log(`pulling ${batch.length}\n`);

  // A round is a download, a transcode and an upload, and only the middle one
  // wants the CPU, so several at once finish far sooner than several in a row.
  // Kept modest: this is somebody's own connection and somebody else's server.
  const concurrency = Math.max(1, Number(arg('--concurrency') ?? process.env.CONCURRENCY ?? '5'));
  let done = 0;
  let next = 0;

  async function worker() {
    while (next < batch.length) {
      const r = batch[next++];
      const slug = slugFor(r.title, r.objectID);
      try {
        const res = await ingest(r, slug, client);
        console.log(`  ${Math.round(res.duration / 60)}min  ${res.audioMB}MB  -> ${slug}`);
        done += 1;
      } catch (err) {
        // The whole message: yt-dlp puts the reason a video would not download
        // well past the first two hundred characters of its complaint.
        const e = err as Error & { stderr?: string };
        console.log(`  FAILED ${r.title}: ${(e.stderr || e.message).trim().slice(0, 300)}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, batch.length) }, worker));

  console.log(`${done} of ${batch.length} pulled; ${Math.max(0, queue.length - done)} left in this queue`);
  if (done) console.log('next: a transcription run picks these up, then segment/run.ts fits them');
}

main().catch(err => { console.error(err); process.exit(1); });
