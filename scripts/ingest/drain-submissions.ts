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
 *
 * Every link is somebody else's server, so nothing here waits on one for
 * ever: each round has a time limit and a size limit, a download that stops
 * sending is given up on, and a round that hits any of them fails with a
 * plain reason like any other bad link, rather than holding up every round
 * queued behind it until GitHub kills the run.
 */
import 'dotenv/config';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { mkdtempSync, readFileSync, readdirSync, createWriteStream, rmSync } from 'fs';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { API, errorText, fetchWithin, r2, reportEvents, videoHost } from './lib.js';

const run = promisify(execFile);
const BUCKET = 'goldenturn-media';
const PEAK_BUCKETS = 3000;

// The limits. The environment can lower them, which is how the tests make a
// hung link fail in seconds rather than minutes.
const num = (name: string, fallback: number) => Number(process.env[name]) || fallback;
/** The longest any one step of one round may take: the download, yt-dlp, ffmpeg. */
const STEP_LIMIT_S = num('GT_STEP_LIMIT_S', 15 * 60);
/** How long a download may go without a byte before it is given up on. */
const STALL_LIMIT_S = num('GT_STALL_LIMIT_S', 120);
/** The largest file taken: four hours of video is well under it. */
const MAX_DOWNLOAD_MB = num('GT_MAX_DOWNLOAD_MB', 3072);
/** After this long, no new round is started; the rest wait for the next run. */
const RUN_BUDGET_S = num('GT_RUN_BUDGET_S', 30 * 60);

const minutes = (s: number) => (s >= 120 ? `${Math.round(s / 60)} minutes` : `${s} seconds`);

/**
 * The tools see the system's paths and nothing else. They are run on links
 * anyone could have submitted, and the run's environment holds the bucket
 * keys, the search write key and the ingest token.
 */
function toolEnv(): NodeJS.ProcessEnv {
  const keep = ['PATH', 'HOME', 'LANG', 'TMPDIR'];
  return Object.fromEntries(keep.filter(k => process.env[k]).map(k => [k, process.env[k]]));
}

/** A tool run with a deadline; past it the tool is killed and that is the error. */
async function tool(cmd: string, args: string[], maxBuffer = 1024 * 1024 * 32) {
  try {
    return await run(cmd, args, { maxBuffer, timeout: STEP_LIMIT_S * 1000, killSignal: 'SIGKILL', env: toolEnv() });
  } catch (err) {
    if ((err as { killed?: boolean }).killed) {
      throw new Error(`${cmd} took longer than ${minutes(STEP_LIMIT_S)} and was stopped`);
    }
    throw err;
  }
}

interface Pending {
  object_id: string; slug: string; title: string; link: string;
  year: string | null; tournament: string | null; author: string | null;
  /** Which time round the queue this is; handed back with the result. */
  attempt?: number | null;
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

async function fetchSource(link: string, dir: string): Promise<string> {
  if (videoHost(link)) {
    const out = join(dir, 'external.%(ext)s');
    await tool('yt-dlp', ['-f', 'bestaudio/best', '-o', out, '--no-playlist',
      '--no-progress', '--quiet', '--socket-timeout', String(STALL_LIMIT_S),
      '--max-filesize', `${MAX_DOWNLOAD_MB}M`, link]);
    const found = readdirSync(dir).find(f => f.startsWith('external.'));
    if (!found) throw new Error('yt-dlp produced no file');
    return join(dir, found);
  }
  const dest = join(dir, 'src.bin');
  await download(directUrl(link), dest);
  return dest;
}

/**
 * Downloads a file, within the limits above. Whichever is hit first, the
 * request is abandoned and the error says which, in words plainReason in the
 * Worker turns into something the submitter can act on.
 */
async function download(url: string, dest: string): Promise<void> {
  const cap = MAX_DOWNLOAD_MB * 1024 * 1024;
  const tooBig = () => new Error(`the file is larger than ${MAX_DOWNLOAD_MB}MB`);
  const ctrl = new AbortController();
  let why: string | null = null;
  const stop = (reason: string) => { if (!why) { why = reason; ctrl.abort(); } };
  const overall = setTimeout(() => stop(`download took longer than ${minutes(STEP_LIMIT_S)}`), STEP_LIMIT_S * 1000);
  let stall: NodeJS.Timeout | undefined;
  const waiting = () => {
    clearTimeout(stall);
    stall = setTimeout(() => stop(`download stalled: nothing arrived for ${minutes(STALL_LIMIT_S)}`), STALL_LIMIT_S * 1000);
  };
  waiting();
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok || !res.body) throw new Error(`download ${res.status}`);
    if (Number(res.headers.get('content-length') ?? 0) > cap) throw tooBig();
    let size = 0;
    const counted = new Transform({
      transform(chunk: Buffer, _enc, done) {
        size += chunk.length;
        waiting();
        if (size > cap) done(tooBig()); else done(null, chunk);
      },
    });
    await pipeline(Readable.fromWeb(res.body as any), counted, createWriteStream(dest));
  } catch (err) {
    if (why) throw new Error(why);
    throw err;
  } finally {
    clearTimeout(overall);
    clearTimeout(stall);
    if (!why) ctrl.abort();
  }
}

async function computePeaks(src: string): Promise<number[]> {
  const pcm = `${src}.pcm`;
  await tool('ffmpeg', ['-v', 'error', '-y', '-i', src, '-ac', '1', '-ar', '8000',
    '-f', 's16le', '-acodec', 'pcm_s16le', pcm], 1024 * 1024 * 64);
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
    await tool('ffmpeg', ['-v', 'error', '-y', '-i', src, '-vn', '-ac', '1',
      '-c:a', 'aac', '-b:a', '64k', '-movflags', '+faststart', out]);

    const { stdout } = await tool('ffprobe', ['-v', 'error', '-show_entries',
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

/**
 * Tells the API how a round's audio went, and says whether it was heard.
 *
 * A report that does not land leaves the round pending, and a pending round
 * is fetched, transcoded and uploaded again by every run. So a report that
 * fails is not swallowed: the caller counts it and the run ends in error.
 *
 * The report names the attempt it belongs to and the link that was fetched.
 * If the round was removed, or queued again with another link, while this
 * run was working on it, the API refuses it (409) and takes back what was
 * uploaded where it does not belong. That is not a failure to report: the
 * round's current attempt is still owed, and the next run makes it.
 */
async function report(p: Pending, status: 'ingested' | 'failed', note?: string): Promise<boolean> {
  const token = process.env.GT_ADMIN_TOKEN;
  if (!token) return true;
  try {
    const res = await fetchWithin(`${API}/recordings/${encodeURIComponent(p.object_id)}/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ status, note, attempt: p.attempt ?? undefined, link: p.link }),
    });
    if (res.status === 409) {
      const said = await res.json().catch(() => ({})) as { error?: string };
      console.log(`  not kept: ${said.error ?? 'the round changed while it was being fetched'}`);
      return true;
    }
    if (!res.ok) console.log(`  could not report "${status}": the API answered ${res.status}`);
    return res.ok;
  } catch (err) {
    console.log(`  could not report "${status}": ${(err as Error).message}`);
    return false;
  }
}

async function main() {
  const began = Date.now();
  const res = await fetchWithin(`${API}/recordings/pending`);
  const { pending } = await res.json() as { pending: Pending[] };
  console.log(`${pending.length} submission(s) waiting on audio\n`);
  if (!pending.length) return;

  // Asked before anything is downloaded. A result that cannot be recorded
  // leaves the round pending, so an unattended run with no token, or the
  // wrong one, would pull the same audio every fifteen minutes for ever. Run
  // by hand with no token it still works, and says the queue will not move.
  const heard = await reportEvents([]);
  if (heard === 'refused') {
    console.error('GT_ADMIN_TOKEN is refused by the API (it must match the Worker\'s INGEST_TOKEN).\n'
      + 'Nothing ingested: the results could not have been recorded.');
    process.exit(2);
  }
  if (heard === 'no-token') {
    if (process.env.GITHUB_ACTIONS) {
      console.error('GT_ADMIN_TOKEN is not set.\nNothing ingested: the results could not have been recorded.');
      process.exit(2);
    }
    console.log('note: GT_ADMIN_TOKEN unset, so results are not reported back\n');
  }

  const client = r2();
  const done: string[] = [];
  const unreported: string[] = [];
  const left: string[] = [];
  for (const p of pending) {
    // A long queue is worked through over several runs rather than in one
    // that never ends: what is not started now is still pending next time.
    if (Date.now() - began > RUN_BUDGET_S * 1000) {
      left.push(p.slug);
      continue;
    }
    console.log(`${p.title}\n  ${p.link.slice(0, 90)}`);
    await reportEvents([{ stage: 'audio', state: 'started', objectID: p.object_id, slug: p.slug }]);
    try {
      const r = await ingest(p, client);
      console.log(`  ${Math.round(r.duration / 60)}min  ${r.audioMB}MB  -> ${p.slug}`);
      if (!(await report(p, 'ingested'))) unreported.push(p.slug);
      done.push(p.slug);
    } catch (err) {
      const message = errorText(err);
      console.log(`  FAILED ${message}`);
      if (!(await report(p, 'failed', message))) unreported.push(p.slug);
    }
    console.log();
  }

  console.log(`ingested ${done.length} of ${pending.length}`);
  if (left.length) {
    console.log(`${left.length} not started, out of time for this run; the next run takes them: ${left.join(', ')}`);
  }
  if (done.length) {
    console.log('\nnext: publish-index.ts, then a transcription run, then segment/run.ts');
  }
  if (unreported.length) {
    console.error(`\n${unreported.length} result(s) could not be reported and will be fetched again next run: `
      + unreported.join(', '));
    process.exitCode = 1;
  }
}

main().catch(err => { console.error(err); process.exit(1); });
