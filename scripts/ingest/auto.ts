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
import { API, errorText, fetchWithin, r2, reportEvents } from './lib.js';

const BUCKET = 'goldenturn-media';
const RG = process.env.AZ_RESOURCE_GROUP ?? 'thava';
const TX_JOBS = (process.env.TX_JOBS ?? 'gt-rx-2,gt-rx-4,gt-rx-6,gt-rx-8,gt-rx-10').split(',');
/**
 * How many rounds a single run may hand out, across all jobs. Bounds what one
 * run can spend; TX_PER_JOB bounds how long any one job is asked to work for.
 */
const TX_LIMIT = Number(process.env.TX_LIMIT ?? '20');

/**
 * Runs a step and waits for it, for at most `minutes`. Every step has a
 * limit, so that one that hangs fails like any other, and the steps after it
 * and the build still happen; the job's own limit in onboard.yml is the
 * backstop for the run as a whole.
 */
function sh(cmd: string, args: string[], env: Record<string, string> = {}, minutes = 3): string {
  return execFileSync(cmd, args, {
    encoding: 'utf8', maxBuffer: 1024 * 1024 * 64, env: { ...process.env, ...env },
    timeout: minutes * 60_000, killSignal: 'SIGKILL',
  });
}

/**
 * Whether there is an Azure session to start jobs with.
 *
 * Asked once, and apart from the question below, because without a session
 * every job looks busy: the check that protects against starting a second GPU
 * cannot tell "running" from "could not ask". A run with no Azure login then
 * reported every job busy on every pass, for as long as nobody looked.
 */
function azSignedIn(): boolean {
  try {
    sh('az', ['account', 'show', '-o', 'none']);
    return true;
  } catch {
    return false;
  }
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
  // What went wrong without stopping the run. A step that fails is not a
  // reason to skip the ones after it, which have their own work to find, but
  // it is a reason for the run to end in error: a red run is the only thing
  // here that reaches a person.
  const problems: string[] = [];
  const did: string[] = [];

  // Reports in first, before anything can stop it, so that "the run has not
  // been heard from" only ever means it is not running.
  const heard = await reportEvents([{ stage: 'run', state: 'started' }]);
  if (heard === 'refused') problems.push('GT_ADMIN_TOKEN is refused by the API');

  // Scheduled, so it runs whether or not anyone has finished wiring it up.
  // Saying what is missing and stopping beats failing every twenty minutes.
  const missing = ['CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_S3_KEY', 'CLOUDFLARE_S3_SECRET']
    .filter(k => !process.env[k]);
  if (missing.length) {
    console.log(`not configured yet: ${missing.join(', ')} unset. Nothing done.`);
    await reportEvents([{ stage: 'run', state: 'failed', note: `not configured: ${missing.join(', ')} unset` }]);
    return;
  }

  const client = r2();
  let changed = false;

  // Asked before any round is touched. With a storage key the bucket refuses,
  // every upload fails, and each round would be marked as failed for a fault
  // that is ours and not its link's. Stopping here leaves them pending, so the
  // run after the key is fixed takes them with nothing else to do.
  try {
    await client.send(new ListObjectsV2Command({ Bucket: BUCKET, MaxKeys: 1 }));
  } catch (err) {
    const why = errorText(err).slice(0, 200);
    console.error(`the storage bucket refused the ingest's key: ${why}\nNothing done.`);
    await reportEvents([{ stage: 'run', state: 'failed', note: `storage: the bucket refused the ingest's key (${why})` }]);
    process.exitCode = 1;
    return;
  }

  // 1. Audio for anything submitted and not yet pulled.
  const pending = await fetchWithin(`${API}/recordings/pending`)
    .then(r => r.json() as Promise<{ pending: Array<{ slug: string; title: string }> }>)
    .catch(() => {
      problems.push('the queue of submitted rounds could not be read');
      return { pending: [] };
    });

  if (pending.pending.length) {
    console.log(`pulling audio for ${pending.pending.length} submitted round(s)`);
    try {
      // Its own limits stop it starting rounds after thirty minutes and any
      // one step after fifteen; this is past both.
      console.log(sh('npx', ['tsx', 'scripts/ingest/drain-submissions.ts'], {}, 50));
      changed = true;
      did.push(`audio for ${pending.pending.length} submitted`);
    } catch (err) {
      const e = err as { status?: number; stdout?: string };
      // What it printed before it stopped is the account of what it did.
      console.log(String(e.stdout ?? ''));
      problems.push('pulling audio');
      // It leaves with 2 when it refused to start, and then nothing changed.
      if (e.status !== 2) changed = true;
    }
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
    const signedIn = azSignedIn();
    const idle = signedIn ? TX_JOBS.filter(job => !isRunning(job)) : [];
    console.log(`\nstarting transcription for ${untranscribed.length} round(s)`);
    if (!signedIn) {
      console.log('  not signed in to Azure, so no transcription job can be started');
    } else if (idle.length < TX_JOBS.length) {
      console.log(`  ${TX_JOBS.length - idle.length} job(s) still busy from a previous run`);
    }
    if (signedIn && !idle.length) {
      console.log('  every job is busy; the rest wait for the next run');
    }
    const handed = new Set<string>();
    const refused = new Set<string>();
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
        batch.forEach(s => handed.add(s));
        await reportEvents(batch.map(slug => ({ stage: 'transcript', state: 'started', slug, note: job })));
      } catch (err) {
        const why = errorText(err).slice(0, 200);
        console.log(`  ${job}: could not start (${why})`);
        batch.forEach(s => refused.add(s));
        await reportEvents(batch.map(slug => (
          { stage: 'transcript', state: 'failed', slug, note: `${job} could not be started: ${why}` })));
      }
    }
    // The ones nobody took, with why, so a round that waits here for a week
    // has something on its record besides the wait.
    const waiting = untranscribed.filter(s => !handed.has(s) && !refused.has(s));
    if (waiting.length) {
      await reportEvents(waiting.map(slug => ({
        stage: 'transcript', state: 'skipped', slug,
        note: signedIn ? 'every transcription job was busy' : 'not signed in to Azure',
      })));
    }
    if (handed.size) {
      console.log('  left running; their transcripts are picked up on a later run');
      did.push(`transcription started for ${handed.size}`);
    }
  }

  // 3. Fit anything transcribed that has no timings yet.
  const unfitted = [...transcripts].filter(s => !speeches.has(s));
  if (unfitted.length) {
    console.log(`\nfitting speeches for ${unfitted.length} round(s)`);
    await reportEvents(unfitted.map(slug => ({ stage: 'speeches', state: 'started', slug })));
    try {
      // Only the rounds that need it. Left to itself the fitter refits every
      // transcript there is, which rewrote six hundred files to add one and
      // made "when were this round's speeches marked" always "just now".
      console.log(sh('npx', ['tsx', 'scripts/segment/run.ts'], { SLUGS: unfitted.join(' ') }, 30).slice(-800));
    } catch (err) {
      console.log(`  the fitter stopped (${errorText(err).slice(0, 300)})`);
      problems.push('fitting speeches');
    }
    // Asked of the bucket rather than assumed, since the fitter can stop
    // part of the way down its list.
    const fitted = await slugsUnder(client, 'speeches/', '.json');
    const missed = unfitted.filter(s => !fitted.has(s));
    if (missed.length) {
      await reportEvents(missed.map(slug => (
        { stage: 'speeches', state: 'failed', slug, note: 'the fitter produced no timings' })));
    }
    // Only when something was fitted. A transcript the fitter cannot do is
    // in this list on every run, and rebuilding the whole site every fifteen
    // minutes for it changed nothing but the deploy history.
    if (missed.length < unfitted.length) changed = true;
    did.push(`speeches for ${unfitted.length - missed.length}`);
  }

  // 4. Give newly transcribed policy rounds their topic. A round's resolution
  //    is worked out from what was said in it, so it can only be settled once
  //    there is a transcript, and each one settled teaches the pass more about
  //    which season its tournament belongs to.
  if (unfitted.length && process.env.ALGOLIA_ADMIN_KEY) {
    console.log('\nassigning topics to policy rounds');
    try {
      console.log(sh('npx', ['tsx', 'scripts/ingest/policy-topics.ts'], {}, 20).slice(-700));
    } catch (err) {
      console.log(`  could not assign topics (${(err as Error).message.slice(0, 120)})`);
    }
  }

  // 5. The index decides what the site treats as playable.
  if (changed) {
    console.log('\nrepublishing the media index');
    console.log(sh('npx', ['tsx', 'scripts/ingest/publish-index.ts'], {}, 10));
    await purge([...pending.pending.map(p => p.slug), ...unfitted]);
    await reportEvents([
      { stage: 'index', state: 'done' },
      // The rebuild that follows is what gives these rounds a page with a
      // player, so this is when their pages were started on.
      ...pending.pending.filter(p => audio.has(p.slug))
        .map(p => ({ stage: 'page' as const, state: 'started' as const, slug: p.slug })),
    ]);
    askForRebuild();
  } else {
    console.log('nothing to do');
  }

  await reportEvents([{
    stage: 'run', state: problems.length ? 'failed' : 'done',
    note: [...did, ...problems.map(p => `problem: ${p}`)].join('; ') || 'nothing to do',
  }]);
  if (problems.length) {
    console.error(`\nfinished with problems: ${problems.join('; ')}`);
    process.exitCode = 1;
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
    await fetchWithin(`https://api.cloudflare.com/client/v4/zones/${zone}/purge_cache`, {
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
