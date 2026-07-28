/**
 * Takes every submitted round from "in search" to "like every other round".
 *
 * Submitting queues a round; this is what actually delivers it. The steps were
 * six separate commands, which meant a submission could sit half-finished with
 * nothing saying so: audio but no transcript, or a transcript but no speech
 * markers. Running them as one sequence, in the only order that works, is what
 * makes the promise on the submit page true.
 *
 *   1. pull the audio from the link it was submitted with, into R2 with peaks
 *   2. republish the media index so the site knows it is playable
 *   3. transcribe on the Azure GPUs, naming the slugs outright
 *   4. fit the six speeches to the transcript
 *   5. republish, and purge the edge copy of the index
 *
 * The site still needs a deploy afterwards to pick up the new pages, which it
 * says at the end rather than doing behind your back.
 */
import 'dotenv/config';
import { execFileSync, execFile } from 'child_process';
import { promisify } from 'util';

const run = promisify(execFile);
const API = process.env.GT_API ?? 'https://goldenturn-api.tejas-prabhune.workers.dev';
const RG = process.env.AZ_RESOURCE_GROUP ?? 'thava';
/** One job per GPU environment; two per environment is the ceiling. */
const JOBS = (process.env.TX_JOBS ?? 'gt-rx-2,gt-rx-4,gt-rx-6,gt-rx-8,gt-rx-10').split(',');

function sh(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, { encoding: 'utf8', maxBuffer: 1024 * 1024 * 64 });
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function transcribedSlugs(): Promise<Set<string>> {
  const res = await fetch(`https://media.goldenturn.org/index.json?cb=${Date.now()}`);
  const index = await res.json() as { transcribed: string[] };
  return new Set(index.transcribed);
}

async function main() {
  const res = await fetch(`${API}/recordings/pending`);
  const { pending } = await res.json() as { pending: Array<{ slug: string; title: string }> };
  if (!pending.length) {
    console.log('nothing waiting');
    return;
  }
  const slugs = pending.map(p => p.slug);
  console.log(`${pending.length} submitted round(s) to bring in:`);
  for (const p of pending) console.log(`  ${p.title}`);

  console.log('\n1. pulling audio');
  console.log(sh('npx', ['tsx', 'scripts/ingest/drain-submissions.ts']));

  console.log('2. republishing the media index');
  console.log(sh('npx', ['tsx', 'scripts/ingest/publish-index.ts']));

  // Only the rounds whose audio actually landed are worth a GPU.
  const playable = await fetch(`https://media.goldenturn.org/index.json?cb=${Date.now()}`)
    .then(r => r.json() as Promise<{ playable: string[] }>);
  const ready = slugs.filter(s => playable.playable.includes(s));
  if (!ready.length) {
    console.log('\nno audio landed, so nothing to transcribe. Check the log above.');
    return;
  }
  if (ready.length < slugs.length) {
    console.log(`\n${slugs.length - ready.length} round(s) got no audio and are left pending`);
  }

  // Naming the slugs is what lets a round submitted today be transcribed at
  // all: the manifest inside the image was fixed when it was built.
  console.log(`\n3. transcribing ${ready.length} round(s)`);
  const perJob = Math.ceil(ready.length / JOBS.length);
  const used: string[] = [];
  for (let i = 0; i < JOBS.length && i * perJob < ready.length; i++) {
    const batch = ready.slice(i * perJob, (i + 1) * perJob);
    const job = JOBS[i];
    sh('az', ['containerapp', 'job', 'update', '-n', job, '-g', RG,
      '--set-env-vars', `SLUGS=${batch.join(' ')}`, '-o', 'none']);
    sh('az', ['containerapp', 'job', 'start', '-n', job, '-g', RG, '-o', 'none']);
    console.log(`   ${job}: ${batch.join(', ')}`);
    used.push(job);
  }

  process.stdout.write('   waiting');
  const deadline = Date.now() + 90 * 60_000;
  let have = new Set<string>();
  while (Date.now() < deadline) {
    await sleep(60_000);
    have = await transcribedSlugs();
    const left = ready.filter(s => !have.has(s));
    process.stdout.write(`\r   waiting: ${ready.length - left.length}/${ready.length} transcribed   `);
    if (!left.length) break;
  }
  console.log();

  const done = ready.filter(s => have.has(s));
  if (done.length < ready.length) {
    console.log(`   ${ready.length - done.length} still missing a transcript; `
      + `check the job logs, then run this again to finish them`);
  }

  // The SLUGS override would otherwise stick and quietly narrow the next run.
  for (const job of used) {
    sh('az', ['containerapp', 'job', 'update', '-n', job, '-g', RG,
      '--set-env-vars', 'SLUGS=', '-o', 'none']);
  }

  if (done.length) {
    console.log('\n4. fitting speeches');
    console.log(sh('npx', ['tsx', 'scripts/segment/run.ts']).slice(-1200));

    console.log('5. republishing');
    console.log(sh('npx', ['tsx', 'scripts/ingest/publish-index.ts']));
    await purge(done);
  }

  console.log(`\n${done.length} of ${pending.length} round(s) are now complete.`);
  console.log('Deploy to give them pages: git commit --allow-empty -m "rebuild" && git push');
}

/** The R2 domain caches by URL, including the 404s from before a file existed. */
async function purge(slugs: string[]) {
  const key = process.env.CLOUDFLARE_API_TOKEN;
  const email = process.env.CLOUDFLARE_EMAIL ?? 'tejas.prabhune@gmail.com';
  const zone = process.env.CLOUDFLARE_ZONE_ID ?? '7627240c9688e6514a397b9509758a2a';
  if (!key) return;

  const files = ['https://media.goldenturn.org/index.json'];
  for (const s of slugs) {
    files.push(`https://media.goldenturn.org/transcripts/${s}.json`);
    files.push(`https://media.goldenturn.org/speeches/${s}.json`);
  }
  for (let i = 0; i < files.length; i += 30) {
    await fetch(`https://api.cloudflare.com/client/v4/zones/${zone}/purge_cache`, {
      method: 'POST',
      headers: {
        'X-Auth-Email': email, 'X-Auth-Key': key, 'Content-Type': 'application/json',
      },
      body: JSON.stringify({ files: files.slice(i, i + 30) }),
    }).catch(() => {});
  }
  console.log('   purged the edge copies');
}

main().catch(err => { console.error(err); process.exit(1); });
