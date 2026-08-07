/**
 * Brings submitted rounds all the way in, without being asked.
 *
 * Written to be run on a schedule and to be safe to run when there is nothing
 * to do, which is most of the time. Each step discovers its own work from what
 * is in the bucket rather than from a list handed to it, so a round that only
 * got half way on one run is picked up by the next: no queue to get out of
 * step, and no round stuck because a single run died between steps.
 *
 *   audio      submissions marked pending
 *   transcript audio in R2 with no transcript
 *   speeches   a transcript with no fit
 *   pages      a deploy, because which rounds have pages and which show a
 *              player are both decided at build time
 *
 * Transcription runs on GPUs elsewhere; this starts those jobs and leaves them
 * to finish, so a long round does not hold the run open.
 */
import 'dotenv/config';
import { execFileSync } from 'child_process';
import { appendFileSync } from 'fs';
import { S3Client, ListObjectsV2Command } from '@aws-sdk/client-s3';

const API = process.env.GT_API ?? 'https://goldenturn-api.tejas-prabhune.workers.dev';
const BUCKET = 'goldenturn-media';
const RG = process.env.AZ_RESOURCE_GROUP ?? 'thava';
const TX_JOBS = (process.env.TX_JOBS ?? 'gt-rx-2,gt-rx-4,gt-rx-6,gt-rx-8,gt-rx-10').split(',');
/**
 * How many rounds a single run may hand out, across all jobs. Bounds what one
 * run can spend; TX_PER_JOB bounds how long any one job is asked to work for.
 */
const TX_LIMIT = Number(process.env.TX_LIMIT ?? '20');

function sh(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 64 });
}

/**
 * Whether a transcription job still has work in flight.
 *
 * Treated as busy when the answer cannot be got: refusing to start a job that
 * might already be running costs a delay, and starting one that is costs a
 * second GPU for as long as it takes.
 */
function isRunning(job: string): boolean {
  try {
    const out = sh('az', ['containerapp', 'job', 'execution', 'list', '-n', job,
      '-g', RG, '--query', "[?properties.status=='Running'] | length(@)", '-o', 'tsv']);
    return Number(out.trim()) > 0;
  } catch {
    return true;
  }
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

async function slugsUnder(client: S3Client, prefix: string, suffix: string): Promise<Set<string>> {
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

async function main() {
  // Scheduled, so it runs whether or not anyone has finished wiring it up.
  // Saying what is missing and stopping beats failing every twenty minutes.
  const missing = ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_S3_KEY', 'CLOUDFLARE_S3_SECRET']
    .filter(k => !process.env[k]);
  if (missing.length) {
    console.log(`not configured yet: ${missing.join(', ')} unset. Nothing done.`);
    return;
  }

  const client = s3();
  let changed = false;

  // 1. Audio for anything submitted and not yet pulled.
  const pending = await fetch(`${API}/recordings/pending`)
    .then(r => r.json() as Promise<{ pending: Array<{ slug: string; title: string }> }>)
    .catch(() => ({ pending: [] }));

  if (pending.pending.length) {
    console.log(`pulling audio for ${pending.pending.length} submitted round(s)`);
    console.log(sh('npx', ['tsx', 'scripts/ingest/drain-submissions.ts']));
    changed = true;
  }

  const audio = await slugsUnder(client, 'audio/', '.m4a');
  const peaks = await slugsUnder(client, 'peaks/', '.json');
  const transcripts = await slugsUnder(client, 'transcripts/', '.json');
  const speeches = await slugsUnder(client, 'speeches/', '.json');

  // 2. Transcribe anything playable that has no transcript. Discovered rather
  //    than remembered, so a round half-done last run is finished this one.
  const playable = [...audio].filter(s => peaks.has(s));
  const untranscribed = playable.filter(s => !transcripts.has(s)).slice(0, TX_LIMIT);

  if (untranscribed.length) {
    // A job that is still working is not asked to take more on. Starting it
    // again does not queue behind the first, it runs a second replica on a
    // second GPU, and this runs on a schedule: with a backlog and no check,
    // every run would stack more paid GPUs on top of the ones already going.
    const idle = TX_JOBS.filter(job => !isRunning(job));
    console.log(`\nstarting transcription for ${untranscribed.length} round(s)`);
    if (idle.length < TX_JOBS.length) {
      console.log(`  ${TX_JOBS.length - idle.length} job(s) still busy from a previous run`);
    }
    if (!idle.length) {
      console.log('  every job is busy; the rest wait for the next run');
    }
    // Capped per job rather than shared out, because a job is killed at its
    // replica timeout: dividing the backlog between however many happen to be
    // free means that when few are free each gets a stint longer than it is
    // allowed to run, and the tail of every one of them is cut off and done
    // again from scratch on the next run.
    const perJob = Math.max(1, Number(process.env.TX_PER_JOB ?? '6'));
    for (let i = 0; i < idle.length && i * perJob < untranscribed.length; i++) {
      const batch = untranscribed.slice(i * perJob, (i + 1) * perJob);
      const job = idle[i];
      try {
        sh('az', ['containerapp', 'job', 'update', '-n', job, '-g', RG,
          '--set-env-vars', `SLUGS=${batch.join(' ')}`, '-o', 'none']);
        sh('az', ['containerapp', 'job', 'start', '-n', job, '-g', RG, '-o', 'none']);
        console.log(`  ${job}: ${batch.length} round(s)`);
      } catch (err) {
        console.log(`  ${job}: could not start (${(err as Error).message.slice(0, 80)})`);
      }
    }
    console.log('  left running; their transcripts are picked up on a later run');
  }

  // 3. Fit anything transcribed that has no timings yet.
  const unfitted = [...transcripts].filter(s => !speeches.has(s));
  if (unfitted.length) {
    console.log(`\nfitting speeches for ${unfitted.length} round(s)`);
    console.log(sh('npx', ['tsx', 'scripts/segment/run.ts'], ).slice(-800));
    changed = true;
  }

  // 4. The index decides what the site treats as playable.
  if (changed) {
    console.log('\nrepublishing the media index');
    console.log(sh('npx', ['tsx', 'scripts/ingest/publish-index.ts']));
    await purge([...pending.pending.map(p => p.slug), ...unfitted]);
    askForRebuild();
  } else {
    console.log('nothing to do');
  }
}

/**
 * The R2 domain caches by URL, including 404s from before a file existed.
 *
 * It also caches by Origin, because the responses carry `vary: Origin` for
 * CORS. That means there are two cached copies of every file: the one a plain
 * request gets, and the one the site itself gets. Purging the plain URL clears
 * only the first, so for a long time the index could be republished, verified
 * by hand with curl, and still be the old one as far as every actual visitor
 * was concerned. Both variants have to be named.
 */
async function purge(slugs: string[]) {
  const key = process.env.CLOUDFLARE_API_TOKEN;
  const zone = process.env.CLOUDFLARE_ZONE_ID ?? '7627240c9688e6514a397b9509758a2a';
  const email = process.env.CLOUDFLARE_EMAIL ?? 'tejas.prabhune@gmail.com';
  if (!key) return;

  const urls = ['https://media.goldenturn.org/index.json'];
  for (const s of new Set(slugs)) {
    for (const p of ['audio', 'peaks', 'transcripts', 'speeches']) {
      urls.push(`https://media.goldenturn.org/${p}/${s}.${p === 'audio' ? 'm4a' : 'json'}`);
    }
  }

  const files: Array<string | { url: string; headers: Record<string, string> }> = [];
  for (const url of urls) {
    files.push(url);
    files.push({ url, headers: { Origin: 'https://goldenturn.org' } });
  }

  for (let i = 0; i < files.length; i += 30) {
    await fetch(`https://api.cloudflare.com/client/v4/zones/${zone}/purge_cache`, {
      method: 'POST',
      headers: { 'X-Auth-Email': email, 'X-Auth-Key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ files: files.slice(i, i + 30) }),
    }).catch(() => {});
  }
  console.log(`purged ${urls.length} file(s), both cache variants`);
}

/**
 * A round has no page until the site is built, so the run that gave it audio
 * is the run that rebuilds. On a runner that is the next step in the workflow;
 * run by hand it is a reminder, because pushing on someone's behalf is not
 * this script's business.
 */
function askForRebuild() {
  const out = process.env.GITHUB_OUTPUT;
  if (out) {
    appendFileSync(out, 'changed=true\n');
    console.log('rounds changed; the workflow will rebuild and deploy');
  } else {
    console.log('rounds changed. Deploy to give them pages: '
      + 'git commit --allow-empty -m rebuild && git push');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
