/**
 * Ingests one recording: pull the source from Dropbox, transcode to a
 * streamable audio track, compute waveform peaks, and put both in R2.
 *
 * Peaks are precomputed here because decoding a 90 minute file in the browser
 * to draw the density plot is not viable.
 */
import 'dotenv/config';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtempSync, readFileSync, createWriteStream, rmSync } from 'fs';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { S3Client, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';
import { dropboxToken, loadEnv } from './lib.js';

const run = promisify(execFile);

const BUCKET = 'goldenturn-media';
const PEAK_BUCKETS = 3000;

export interface ManifestEntry {
  objectID: string;
  title: string;
  slug: string;
  link: string;
  match: string;
  dropbox?: { id: string; path: string; size: number };
}

/** YouTube and Vimeo rounds have no Dropbox source, so the audio comes from the host. */
async function downloadExternal(link: string, destDir: string): Promise<string> {
  const out = join(destDir, 'external.%(ext)s');
  await run('yt-dlp', [
    '-f', 'bestaudio/best', '-o', out, '--no-playlist',
    '--no-progress', '--quiet', link,
  ], { maxBuffer: 1024 * 1024 * 32 });
  const { stdout } = await run('sh', ['-c', `ls ${destDir}/external.* | head -1`]);
  const path = stdout.trim();
  if (!path) throw new Error('yt-dlp produced no file');
  return path;
}

function s3(): S3Client {
  const account = loadEnv('CLOUDFLARE_ACCOUNT_ID');
  return new S3Client({
    region: 'auto',
    endpoint: `https://${account}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: loadEnv('CLOUDFLARE_S3_KEY'),
      secretAccessKey: loadEnv('CLOUDFLARE_S3_SECRET'),
    },
  });
}

async function alreadyIngested(client: S3Client, key: string): Promise<boolean> {
  try {
    await client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Streamed to disk rather than buffered: source files run to 500MB+ and
 * several of these run concurrently in a memory-capped container.
 */
async function downloadFromDropbox(token: string, fileId: string, dest: string): Promise<void> {
  const res = await fetch('https://content.dropboxapi.com/2/files/download', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Dropbox-API-Arg': JSON.stringify({ path: fileId }),
    },
  });
  if (!res.ok || !res.body) throw new Error(`download ${res.status}: ${(await res.text()).slice(0, 160)}`);
  await pipeline(Readable.fromWeb(res.body as any), createWriteStream(dest));
}

async function probeDuration(path: string): Promise<number> {
  const { stdout } = await run('ffprobe', [
    '-v', 'error', '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1', path,
  ]);
  return Number(stdout.trim());
}

/**
 * Peaks come from an 8kHz mono decode: enough resolution to see speech
 * structure, small enough to compute in seconds.
 */
async function computePeaks(src: string, buckets: number): Promise<number[]> {
  const pcm = `${src}.pcm`;
  await run('ffmpeg', [
    '-v', 'error', '-y', '-i', src, '-ac', '1', '-ar', '8000',
    '-f', 's16le', '-acodec', 'pcm_s16le', pcm,
  ]);
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

export async function ingestOne(entry: ManifestEntry, opts: { force?: boolean } = {}) {
  const external = !entry.dropbox && entry.match === 'external';
  if (!entry.dropbox && !external) return { slug: entry.slug, skipped: 'no source' };

  const client = s3();
  const audioKey = `audio/${entry.slug}.m4a`;
  const peaksKey = `peaks/${entry.slug}.json`;

  if (!opts.force && await alreadyIngested(client, peaksKey)) {
    return { slug: entry.slug, skipped: 'already ingested' };
  }

  const dir = mkdtempSync(join(tmpdir(), 'gt-'));
  const started = Date.now();
  try {
    const out = join(dir, 'out.m4a');
    let src: string;

    if (external) {
      src = await downloadExternal(entry.link, dir);
    } else {
      const ext = entry.dropbox!.path.split('.').pop() ?? 'bin';
      src = join(dir, `src.${ext}`);
      const token = await dropboxToken();
      await downloadFromDropbox(token, entry.dropbox!.id, src);
    }

    // 64k mono AAC: speech-only content, and it keeps the archive streamable.
    await run('ffmpeg', ['-v', 'error', '-y', '-i', src, '-vn', '-ac', '1',
      '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', out]);

    const duration = await probeDuration(out);
    const peaks = await computePeaks(out, PEAK_BUCKETS);

    const audio = readFileSync(out);
    await client.send(new PutObjectCommand({
      Bucket: BUCKET, Key: audioKey, Body: audio, ContentType: 'audio/mp4',
    }));
    await client.send(new PutObjectCommand({
      Bucket: BUCKET, Key: peaksKey, ContentType: 'application/json',
      Body: JSON.stringify({
        slug: entry.slug, objectID: entry.objectID, duration,
        buckets: peaks.length, peaks,
      }),
    }));

    return {
      slug: entry.slug,
      duration: Math.round(duration),
      sourceMB: entry.dropbox ? +(entry.dropbox.size / 1e6).toFixed(1) : 0,
      audioMB: +(audio.length / 1e6).toFixed(1),
      seconds: +((Date.now() - started) / 1000).toFixed(1),
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
