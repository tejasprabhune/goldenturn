#!/usr/bin/env node
/**
 * Exercises the Worker against a local copy of itself.
 *
 *   cd worker && npm ci && node test/local.mjs
 *
 * Nothing here can reach production. The Worker runs under `wrangler dev
 * --local` with a throwaway D1 and R2 in worker/.wrangler/, every credential
 * is made up, and the four things the Worker talks to (the search index, the
 * built site, GitHub, and the host a submitted link points at) are one small
 * server in this file. Nothing it starts sees the caller's environment: wrangler
 * and the ingest scripts are each given an explicit one, holding only the
 * system's paths and what the test sets, and the scripts are told not to read
 * a .env (DOTENV_CONFIG_PATH=/dev/null), so a real .env in the repo cannot put
 * production credentials back.
 *
 * It starts from the schema as it was before migrations 0007 and 0008, puts
 * the awkward accounts in (an admin address with a password, one without, an
 * ordinary account from before passwords), and only then applies the two new
 * migrations, because what they do to existing rows is the part that cannot
 * be taken back.
 *
 * ALGOLIASEARCH=/path/to/algoliasearch/dist/node.js (optional) also checks the
 * prep key against the one Algolia's own client generates.
 *
 * The last section runs the real ingest scripts (scripts/ingest/auto.ts and
 * drain-submissions.ts) against this Worker, with the bucket, yt-dlp, az and
 * the speech fitter stood in for. It needs the repo's own dependencies
 * (`pnpm install` at the root) and ffmpeg, and is skipped, loudly, without.
 */
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';

const WORKER = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.GT_TEST_PORT ?? 8791);
const API = `http://127.0.0.1:${PORT}`;
const WRANGLER = join(WORKER, 'node_modules', '.bin', 'wrangler');

const INGEST_TOKEN = 'test-ingest-token';
const BOOTSTRAP_SECRET = 'test-bootstrap-secret-0123456789abcdef';
const PREP_PARENT_KEY = 'test-prep-search-only-key';
const PREP_INDEX = 'prep_test';
const OWNER = 'prabhune@berkeley.edu';
const MACHINE = 'admincli@goldenturn.org';
const SPARE = 'spare-admin@goldenturn.org';

// Production credentials in the shell must not be visible to anything started
// from here. Not a copy of the caller's environment with the dangerous names
// taken out, which misses whatever was not thought of, but an environment
// built from nothing: the system's paths, and what this file sets. No proxy,
// so the Worker's own requests can only land on this machine. And every
// script that does `import 'dotenv/config'` is pointed at /dev/null, because
// dotenv fills in from <repo>/.env exactly the variables that are missing.
const SYSTEM_VARS = ['PATH', 'HOME', 'LANG', 'TMPDIR', 'USER'];
const env = {
  ...Object.fromEntries(SYSTEM_VARS.filter(k => process.env[k]).map(k => [k, process.env[k]])),
  WRANGLER_SEND_METRICS: 'false', CI: '1', DOTENV_CONFIG_PATH: '/dev/null',
};

mkdirSync(join(WORKER, '.wrangler'), { recursive: true });
const STATE = mkdtempSync(join(WORKER, '.wrangler', 'test-'));

function wrangler(args, input) {
  return execFileSync(WRANGLER, args, { cwd: WORKER, env, input, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
}
function sql(text) {
  const file = join(STATE, `seed-${randomBytes(4).toString('hex')}.sql`);
  writeFileSync(file, text);
  return wrangler(['d1', 'execute', 'goldenturn', '--local', '--persist-to', STATE, '--file', file]);
}
function r2put(key, body) {
  const file = join(STATE, `obj-${randomBytes(4).toString('hex')}`);
  writeFileSync(file, body);
  wrangler(['r2', 'object', 'put', `goldenturn-media/${key}`, '--local', '--persist-to', STATE, '--file', file]);
}
function r2get(key) {
  try {
    return wrangler(['r2', 'object', 'get', `goldenturn-media/${key}`, '--local', '--persist-to', STATE, '--pipe']);
  } catch { return null; }
}

/** The format the Worker stores: iterations:salt:hash. */
function passwordHash(password) {
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(password, salt, 100_000, 32, 'sha256');
  return `100000:${salt.toString('base64')}:${hash.toString('base64')}`;
}

// ── the stand-in for search, the site and the submitted link ────────────────

const records = new Map();   // objectID -> record
const pages = new Map();     // slug -> Date the page was "deployed"
let siteDeployed = new Date(Date.now() - 3600_000);
let searchDown = false;
let githubStatus = 204;
let searchHangs = false;     // search accepts the connection and never answers
const dispatched = [];       // what "GitHub" was asked to start
const purged = [];           // what "Cloudflare" was asked to purge
const hanging = new Set();   // responses deliberately never finished
const bucket = new Map();    // what the ingest scripts put in "R2": key -> Buffer
let realRound = null;        // five minutes of actual audio, once made
const mockLog = [];

const mock = createServer((req, res) => {
  const url = new URL(req.url, 'http://mock');
  const chunks = [];
  req.on('data', c => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks);
    const body = raw.toString();
    const send = (status, payload, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(req.method === 'HEAD' ? undefined : (typeof payload === 'string' ? payload : JSON.stringify(payload)));
    };
    mockLog.push(`${req.method} ${url.pathname}`);

    // Cloudflare, being asked to empty the media domain's cache.
    if (req.method === 'POST' && /^\/zones\/[^/]+\/purge_cache$/.test(url.pathname)) {
      purged.push({ zone: url.pathname.split('/')[2], auth: req.headers.authorization, ...JSON.parse(body) });
      return send(200, { success: true });
    }

    // Links that misbehave: one whose server answers the range check and then
    // sends a few bytes and nothing more, and one that never stops sending.
    if (url.pathname.startsWith('/files/hang') || url.pathname.startsWith('/files/endless')) {
      if (url.pathname.includes('probe')) { hanging.add(res); return; }
      if (req.headers.range) {
        return send(206, 'x'.repeat(1024), { 'Content-Type': 'audio/mp4', 'Content-Range': 'bytes 0-1023/56100000' });
      }
      res.writeHead(200, { 'Content-Type': 'audio/mp4' });
      if (url.pathname.startsWith('/files/hang')) { res.write(Buffer.alloc(1024)); hanging.add(res); return; }
      const chunk = Buffer.alloc(64 * 1024);
      const more = () => { if (!res.destroyed && res.write(chunk)) setImmediate(more); else if (!res.destroyed) res.once('drain', more); };
      res.on('close', () => res.destroy());
      return more();
    }

    // The bucket, as the ingest scripts reach it: S3's put, get and list.
    if (url.pathname.startsWith('/goldenturn-media')) {
      const key = decodeURIComponent(url.pathname.slice('/goldenturn-media/'.length));
      if (req.method === 'PUT') { bucket.set(key, raw); return send(200, '', { ETag: '"stand-in"' }); }
      if (url.searchParams.get('list-type') === '2') {
        const prefix = url.searchParams.get('prefix') ?? '';
        const keys = [...bucket.keys()].filter(k => k.startsWith(prefix)).sort();
        return send(200, `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult><Name>goldenturn-media</Name>`
          + `<Prefix>${prefix}</Prefix><KeyCount>${keys.length}</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>`
          + keys.map(k => `<Contents><Key>${k}</Key><Size>${bucket.get(k).length}</Size>`
            + `<LastModified>${new Date().toISOString()}</LastModified><ETag>"stand-in"</ETag></Contents>`).join('')
          + `</ListBucketResult>`, { 'Content-Type': 'application/xml' });
      }
      if (bucket.has(key)) { res.writeHead(200); return res.end(bucket.get(key)); }
      return send(404, '<Error><Code>NoSuchKey</Code></Error>', { 'Content-Type': 'application/xml' });
    }

    // A recording that really is one, for the ingest to download and transcode.
    if (url.pathname === '/files/real-round.m4a' && realRound) {
      if (req.headers.range) {
        res.writeHead(206, { 'Content-Type': 'audio/mp4', 'Content-Range': `bytes 0-1023/${realRound.length}` });
        return res.end(realRound.subarray(0, 1024));
      }
      res.writeHead(200, { 'Content-Type': 'audio/mp4', 'Content-Length': realRound.length });
      return res.end(realRound);
    }

    // A recording somebody linked to: big, and the right type.
    if (url.pathname.startsWith('/files/')) {
      if (url.pathname.endsWith('.html')) return send(200, '<html></html>', { 'Content-Type': 'text/html' });
      if (url.pathname.includes('missing')) return send(404, 'gone');
      return send(206, 'x'.repeat(1024), {
        'Content-Type': 'audio/mp4', 'Content-Range': 'bytes 0-1023/56100000',
      });
    }

    // GitHub, being asked to run a workflow.
    if (req.method === 'POST' && /^\/repos\/[^/]+\/[^/]+\/dispatches$/.test(url.pathname)) {
      if (githubStatus === 204) dispatched.push({ ...JSON.parse(body), auth: req.headers.authorization, repo: url.pathname.split('/').slice(2, 4).join('/') });
      res.writeHead(githubStatus);
      return res.end();
    }

    // The built site.
    if (url.pathname === '/recordings/') return send(200, '', { 'Last-Modified': siteDeployed.toUTCString() });
    const page = url.pathname.match(/^\/recordings\/([^/]+)\/$/);
    if (page) {
      const built = pages.get(page[1]);
      return built ? send(200, '', { 'Last-Modified': built.toUTCString() }) : send(404, 'not found');
    }

    // The search index.
    const index = url.pathname.match(/^\/1\/indexes\/([^/]+)(?:\/([^/]+))?(?:\/(partial))?$/);
    if (index) {
      if (searchHangs) { hanging.add(res); return; }
      if (searchDown) return send(503, { message: 'down' });
      // A record far bigger than any round, to see the Worker will not read it all.
      if (index[2] === 'huge-record' && req.method === 'GET') return send(200, { objectID: 'huge-record', junk: 'x'.repeat(3_000_000) });
      const [, name, second, partial] = index;
      if (name === '*' && second === 'objects') {
        const { requests } = JSON.parse(body);
        return send(200, { results: requests.map(r => records.get(r.objectID) ?? null) });
      }
      if (second === 'browse') return send(200, { hits: [...records.values()] });
      const objectID = decodeURIComponent(second ?? '');
      if (partial) {
        const patch = JSON.parse(body);
        if (!records.has(objectID) && url.searchParams.get('createIfNotExists') === 'false') return send(200, {});
        records.set(objectID, { ...(records.get(objectID) ?? {}), ...patch });
        return send(200, { objectID });
      }
      if (req.method === 'PUT') { records.set(objectID, JSON.parse(body)); return send(200, { objectID }); }
      if (req.method === 'DELETE') { records.delete(objectID); return send(200, {}); }
      if (req.method === 'GET') {
        return records.has(objectID) ? send(200, records.get(objectID)) : send(404, { message: 'no' });
      }
    }
    send(404, { message: `mock has no ${req.method} ${url.pathname}` });
  });
});
await new Promise(r => mock.listen(0, '127.0.0.1', r));
const MOCK = `http://127.0.0.1:${mock.address().port}`;

// ── the Worker ──────────────────────────────────────────────────────────────

let dev = null;
async function startWorker(vars) {
  const args = ['dev', '--local', '--port', String(PORT), '--ip', '127.0.0.1', '--persist-to', STATE,
    '--show-interactive-dev-session=false', '--test-scheduled'];
  for (const [k, v] of Object.entries(vars)) args.push('--var', `${k}:${v}`);
  dev = spawn(WRANGLER, args, { cwd: WORKER, env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  dev.stdout.on('data', d => { log += d; });
  dev.stderr.on('data', d => { log += d; });
  for (let i = 0; i < 120; i++) {
    await new Promise(r => setTimeout(r, 500));
    if (dev.exitCode !== null) throw new Error(`wrangler dev exited:\n${log}`);
    const ok = await fetch(`${API}/health`).then(r => r.ok).catch(() => false);
    if (ok) return;
  }
  throw new Error(`the Worker did not come up:\n${log}`);
}
async function stopWorker() {
  if (!dev) return;
  const gone = new Promise(r => dev.once('exit', r));
  dev.kill('SIGTERM');
  await Promise.race([gone, new Promise(r => setTimeout(r, 5000))]);
  if (dev.exitCode === null) dev.kill('SIGKILL');
  dev = null;
  await new Promise(r => setTimeout(r, 500));
}

const BASE_VARS = {
  ALGOLIA_HOST: MOCK,
  ALGOLIA_APP_ID: 'TESTAPP',
  ALGOLIA_ADMIN_KEY: 'test-write-key',
  ALGOLIA_INDEX: 'all_rounds',
  SITE_URL: MOCK,
  MEDIA_URL: 'https://media.test',
  INGEST_TOKEN,
  ADMIN_EMAIL: `${OWNER},${MACHINE},${SPARE}`,
};

async function call(method, path, { token, body, headers } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      // One connection a request. The steps between requests (wrangler's CLI,
      // ffmpeg, the ingest scripts) block this process for seconds at a time,
      // and a kept-alive socket the Worker closed meanwhile is found out only
      // by the request that tries to use it.
      Connection: 'close',
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, headers: res.headers };
}
/** Fires the cron trigger, the way Cloudflare would every fifteen minutes. */
const tick = () => fetch(`${API}/__scheduled?cron=7,22,37,52+*+*+*+*`).then(r => r.status);
const dispatchLog = async token =>
  (await call('GET', '/admin/ingest/events?limit=500', { token })).data.events.filter(e => e.stage === 'dispatch');
const signIn = (email, password) => call('POST', '/auth/session', { body: { mode: 'signin', email, password } });
const signUp = (email, password, displayName) =>
  call('POST', '/auth/session', { body: { mode: 'signup', email, password, displayName } });

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (e) {
    failures.push(name);
    console.log(`  FAIL  ${name}\n        ${String(e?.message ?? e).split('\n').join('\n        ')}`);
  }
}
const section = name => console.log(`\n${name}`);

const submission = (over = {}) => ({
  title: 'Finals - Cal MS vs Pacific BP', link: `${MOCK}/files/round.m4a`, year: '2026-27',
  tournament: 'Paul Winters', format: 'parli', level: 'college', decision: '3-0 Aff',
  resolution: 'This house would test its own code', aff: 'Topical (War)', neg: '2-off (T, Cap K)',
  tags: ['#k-aff'], ...over,
});

try {
  // ── schema as production has it, then the rows the migration must get right
  section('migrations');
  const files = readdirSync(join(WORKER, 'migrations')).sort();
  const before = files.filter(f => f < '0007');
  const added = files.filter(f => f >= '0007');
  for (const f of before) {
    wrangler(['d1', 'execute', 'goldenturn', '--local', '--persist-to', STATE, '--file', join('migrations', f)]);
  }
  const t0 = Math.floor(Date.now() / 1000) - 86400 * 20;
  sql(`
    INSERT INTO users (id, email, display_name, created_at, rep, password_hash)
      VALUES ('u-owner', '${OWNER}', 'Owner', ${t0}, 50, '${passwordHash('owner-password')}');
    INSERT INTO users (id, email, display_name, created_at, rep, password_hash)
      VALUES ('u-machine', '${MACHINE}', 'Machine', ${t0}, 0, NULL);
    INSERT INTO users (id, email, display_name, created_at, rep, password_hash)
      VALUES ('u-legacy', 'legacy@example.com', 'Legacy', ${t0}, 5, NULL);
    INSERT INTO users (id, email, display_name, created_at, rep, password_hash)
      VALUES ('u-lookalike', 'prabhune@berkeley.edu.example.com', 'Lookalike', ${t0}, 0, '${passwordHash('lookalike-pw')}');
    INSERT INTO events (kind, user_id, slug, payload, created_at)
      VALUES ('search', NULL, NULL, '{"q":"a query that was cut off half way thro', ${t0 + 10});
    INSERT INTO events (kind, user_id, slug, payload, created_at)
      VALUES ('search', NULL, NULL, '{"q":"framework"}', ${t0 + 11});
    INSERT INTO events (kind, user_id, slug, payload, created_at)
      VALUES ('auth.failed', 'u-owner', NULL, '{}', ${t0 + 12});
    INSERT INTO submissions (object_id, slug, title, link, year, tournament, user_id, status, note, created_at, updated_at, review)
      VALUES ('sub-1790000000000-abc123', 'octafinals-nueva-lj-vs-menlo-atherton-sg-sub179', 'Octafinals - Nueva LJ vs Menlo-Atherton SG',
              'https://www.youtube.com/watch?v=aaaaaaaaaaa', '2026-27', NULL, 'u-legacy', 'failed',
              'Command failed: yt-dlp -f bestaudio/best -o /tmp/gt-sub-x/external.%(ext)s --no-playlist --no-progress --quiet https://www.youtube.com/watch?v=aaaaaaaaaaa',
              ${t0}, ${t0 + 900}, 'unreviewed');
  `);

  // The Worker deployed ahead of its migrations, which is the order the
  // review found took every signed-in request down.
  await test('deployed before its migrations, the Worker still signs people in and serves them, and a failure says nothing of why to a stranger', async () => {
    await startWorker(BASE_VARS);
    try {
      const s = await signIn(OWNER, 'owner-password');
      assert.equal(s.status, 200, JSON.stringify(s.data));
      assert.equal(s.data.admin, false, 'nobody is an admin until the migration has run');
      const me = await call('GET', '/me', { token: s.data.token });
      assert.equal(me.status, 200, JSON.stringify(me.data));
      assert.equal(me.data.user.email, OWNER);
      assert.equal((await call('GET', '/me/ratings', { token: s.data.token })).status, 200);
      assert.equal((await call('GET', '/admin/users', { token: s.data.token })).status, 403);
      // What genuinely needs the new tables still fails, and says only that it did.
      const p = await call('GET', '/rounds/anything/progress');
      assert.equal(p.status, 500);
      assert.deepEqual(Object.keys(p.data).sort(), ['error', 'requestId']);
      assert.doesNotMatch(JSON.stringify(p.data), /column|table|D1|SQL/i);
      assert.equal(await tick(), 200, 'the cron tick is caught, not thrown');
    } finally { await stopWorker(); }
  });
  await test('the deploy script applies the migrations before it deploys', async () => {
    const { scripts } = JSON.parse(readFileSync(join(WORKER, 'package.json'), 'utf8'));
    assert.equal(scripts.deploy, 'wrangler d1 migrations apply goldenturn --remote && wrangler deploy');
  });

  await test('0007, 0008 and 0009 apply to a database that already has rows', async () => {
    for (const f of added) {
      wrangler(['d1', 'execute', 'goldenturn', '--local', '--persist-to', STATE, '--file', join('migrations', f)]);
    }
    assert.deepEqual(added, ['0007_admin_and_prep.sql', '0008_ingest_state.sql', '0009_attempts_and_pipeline.sql']);
  });
  await test('every migration applies in order to an empty database (wrangler d1 migrations apply)', async () => {
    const fresh = mkdtempSync(join(WORKER, '.wrangler', 'test-fresh-'));
    try {
      const out = wrangler(['d1', 'migrations', 'apply', 'goldenturn', '--local', '--persist-to', fresh]);
      assert.match(out, /0009_attempts_and_pipeline\.sql/);
    } finally { rmSync(fresh, { recursive: true, force: true }); }
  });

  // ── before the owner has set any secret ───────────────────────────────────
  section('unconfigured Worker (no bootstrap secret, no prep key)');
  await startWorker(BASE_VARS);
  let owner;
  await test('an admin address that had a password is an admin after the migration', async () => {
    const r = await signIn(OWNER, 'owner-password');
    assert.equal(r.status, 200);
    assert.equal(r.data.admin, true);
    assert.equal(r.data.prep, true, 'an admin is let into prep');
    assert.deepEqual(Object.keys(r.data.user).sort(), ['display_name', 'email', 'id', 'rep']);
    owner = r.data.token;
  });
  await test('an address that merely contains an admin address is not an admin', async () => {
    const r = await signIn('prabhune@berkeley.edu.example.com', 'lookalike-pw');
    assert.equal(r.status, 200);
    assert.equal(r.data.admin, false);
  });
  await test('POST /admin/bootstrap is closed when no secret is set', async () => {
    const r = await call('POST', '/admin/bootstrap', { token: '', body: { email: MACHINE, password: 'whatever-123' } });
    assert.equal(r.status, 503);
    const guess = await call('POST', '/admin/bootstrap', { token: 'undefined', body: { email: MACHINE, password: 'whatever-123' } });
    assert.equal(guess.status, 503);
  });
  await test('GET /prep/key answers 503 when no parent key is set', async () => {
    const r = await call('GET', '/prep/key', { token: owner });
    assert.equal(r.status, 503);
    assert.equal(r.data.error, 'prep search is not configured');
  });
  await test('the cron trigger with no GitHub token: nothing sent, and the failure is written down once', async () => {
    assert.equal(await tick(), 200);
    assert.equal(await tick(), 200);
    assert.equal(dispatched.length, 0);
    const log = await dispatchLog(owner);
    assert.deepEqual(log.map(e => [e.state, e.note]), [['failed', 'GITHUB_DISPATCH_TOKEN is not set']]);
    const p = await call('GET', '/admin/ingest/events', { token: owner });
    assert.equal(p.data.pipeline.lastRunAt, null, 'a failure to start a run is not the run reporting in');
  });
  await stopWorker();

  // ── configured ────────────────────────────────────────────────────────────
  await startWorker({
    ...BASE_VARS,
    GITHUB_API: MOCK,
    GITHUB_DISPATCH_TOKEN: 'test-github-token',
    ADMIN_BOOTSTRAP_SECRET: BOOTSTRAP_SECRET,
    ALGOLIA_PREP_KEY: PREP_PARENT_KEY,
    ALGOLIA_PREP_INDEX: PREP_INDEX,
    CACHE_PURGE_TOKEN: 'test-purge-token',
    CLOUDFLARE_API: MOCK,
    // Short, so a host that never answers costs the suite seconds, not tens of them.
    FETCH_TIMEOUT_MS: '3000',
  });

  section('keeping the ingest run alive');
  await test('the cron trigger asks GitHub to start the onboarding run', async () => {
    assert.equal(await tick(), 200);
    assert.deepEqual(dispatched, [{ event_type: 'onboard-due', client_payload: {}, auth: 'Bearer test-github-token', repo: 'tejasprabhune/goldenturn' }]);
  });
  await test('a refused start is recorded once, however long it lasts, and so is the recovery', async () => {
    githubStatus = 401;
    await tick(); await tick(); await tick();
    githubStatus = 204;
    await tick(); await tick();
    assert.equal(dispatched.length, 3);
    const s = await signIn(OWNER, 'owner-password');
    const log = await dispatchLog(s.data.token);
    // Newest first: the missing token from before, its recovery, the refusal, its recovery.
    assert.deepEqual(log.map(e => [e.state, e.note]), [
      ['done', 'the run is being started again'],
      ['failed', 'GitHub answered 401'],
      ['done', 'the run is being started again'],
      ['failed', 'GITHUB_DISPATCH_TOKEN is not set'],
    ]);
    dispatched.length = 0;
  });

  section('admin takeover');
  await test('GET /me carries the stored admin flag and the prep flag', async () => {
    const r = await call('GET', '/me', { token: owner });
    assert.equal(r.status, 200);
    assert.deepEqual({ admin: r.data.admin, prep: r.data.prep }, { admin: true, prep: true });
    assert.equal(r.data.user.email, OWNER);
    assert.equal((await call('GET', '/me')).status, 401);
  });
  await test('sign-up is refused for every address on the admin list', async () => {
    for (const email of [SPARE, MACHINE, OWNER, ` ${SPARE.toUpperCase()} `]) {
      const r = await signUp(email, 'attacker-password', 'Mallory');
      assert.equal(r.status, 403, `${email} -> ${r.status}`);
      assert.equal(r.data.token, undefined);
    }
  });
  await test('a passwordless admin address cannot be claimed by signing in', async () => {
    const r = await signIn(MACHINE, 'attacker-password');
    assert.equal(r.status, 403);
    assert.equal(r.data.token, undefined);
    const again = await signIn(MACHINE, 'attacker-password');
    assert.equal(again.status, 403, 'the first attempt must not have set the password');
  });
  let legacy;
  await test('an ordinary account from before passwords can still set one, and is not an admin', async () => {
    const r = await signIn('legacy@example.com', 'legacy-password');
    assert.equal(r.status, 200);
    assert.equal(r.data.admin, false);
    assert.equal(r.data.prep, false);
    legacy = r.data.token;
    assert.equal((await signIn('legacy@example.com', 'someone-else')).status, 401);
  });
  let ada, adaId;
  await test('an ordinary sign-up is not an admin', async () => {
    const r = await signUp('ada@example.com', 'ada-password', 'Ada');
    assert.equal(r.status, 200);
    assert.deepEqual({ admin: r.data.admin, prep: r.data.prep }, { admin: false, prep: false });
    ada = r.data.token; adaId = r.data.user.id;
    assert.equal((await signIn('nobody@example.com', 'whatever-123')).status, 404);
    assert.equal((await signIn('ada@example.com', 'wrong-password')).status, 401);
  });
  const ADMIN_ROUTES = [
    ['GET', '/admin/stats'], ['GET', '/admin/events'], ['GET', '/admin/proposals'],
    ['GET', '/admin/users'], ['GET', '/admin/users/x'], ['GET', '/admin/sessions'], ['GET', '/admin/rounds'],
    ['GET', '/admin/proposals/history'], ['GET', '/admin/revisions'],
    ['GET', '/admin/auth-failures'], ['GET', '/admin/submissions'], ['GET', '/admin/submissions/x'],
    ['POST', '/admin/submissions/x/retry'], ['POST', '/admin/submissions/x/link'],
    ['DELETE', '/admin/submissions/x'], ['GET', '/admin/ingest/events'],
    ['POST', '/admin/prep/grant'], ['POST', '/admin/prep/revoke'],
    ['GET', '/recordings/submissions'], ['GET', '/recordings/x'], ['PATCH', '/recordings/x'],
    ['DELETE', '/recordings/x'], ['POST', '/recordings/x/confirm'],
  ];
  await test(`all ${ADMIN_ROUTES.length} admin endpoints refuse a signed-in non-admin and a signed-out caller`, async () => {
    for (const [method, path] of ADMIN_ROUTES) {
      for (const token of [ada, undefined]) {
        const r = await call(method, path, { token, body: method === 'GET' ? undefined : {} });
        assert.equal(r.status, 403, `${method} ${path} as ${token ? 'user' : 'guest'} -> ${r.status}`);
      }
    }
  });
  await test('POST /admin/bootstrap needs the secret', async () => {
    const body = { email: SPARE, password: 'spare-password' };
    assert.equal((await call('POST', '/admin/bootstrap', { body })).status, 403);
    assert.equal((await call('POST', '/admin/bootstrap', { token: 'not-the-secret', body })).status, 403);
    assert.equal((await call('POST', '/admin/bootstrap', { token: owner, body })).status, 403, 'an admin session is not the secret');
    assert.equal((await call('POST', '/admin/bootstrap', { token: BOOTSTRAP_SECRET, body: { email: SPARE, password: 'short' } })).status, 400);
    assert.equal((await call('POST', '/admin/bootstrap', { token: BOOTSTRAP_SECRET, body: { email: 'nope', password: 'long-enough' } })).status, 400);
  });
  await test('bootstrap creates an admin where there was no account', async () => {
    const r = await call('POST', '/admin/bootstrap', { token: BOOTSTRAP_SECRET, body: { email: SPARE, password: 'spare-password', displayName: 'Spare' } });
    assert.equal(r.status, 201);
    assert.deepEqual({ created: r.data.created, admin: r.data.admin }, { created: true, admin: true });
    const s = await signIn(SPARE, 'spare-password');
    assert.equal(s.data.admin, true);
  });
  let machine;
  await test('bootstrap gives a passwordless admin address its password and the flag', async () => {
    const r = await call('POST', '/admin/bootstrap', { token: BOOTSTRAP_SECRET, body: { email: MACHINE, password: 'machine-password' } });
    assert.equal(r.status, 200);
    assert.equal(r.data.created, false);
    const s = await signIn(MACHINE, 'machine-password');
    assert.equal(s.status, 200);
    assert.equal(s.data.admin, true);
    machine = s.data.token;
  });
  await test('bootstrap on an account somebody else holds changes the password and ends their sessions', async () => {
    const r = await call('POST', '/admin/bootstrap', { token: BOOTSTRAP_SECRET, body: { email: OWNER, password: 'owner-new-password' } });
    assert.equal(r.status, 200);
    assert.ok(r.data.sessions_revoked >= 1);
    assert.equal((await call('GET', '/me', { token: owner })).status, 401, 'the old session is dead');
    assert.equal((await signIn(OWNER, 'owner-password')).status, 401, 'the old password is dead');
    const s = await signIn(OWNER, 'owner-new-password');
    assert.equal(s.data.admin, true);
    owner = s.data.token;
  });
  await test('bootstrap can take admin away', async () => {
    const r = await call('POST', '/admin/bootstrap', { token: BOOTSTRAP_SECRET, body: { email: SPARE, revoke: true } });
    assert.equal(r.status, 200);
    assert.equal(r.data.admin, false);
    assert.equal((await signIn(SPARE, 'spare-password')).data.admin, false);
    assert.equal((await call('POST', '/admin/bootstrap', { token: BOOTSTRAP_SECRET, body: { email: 'ghost@example.com', revoke: true } })).status, 404);
  });
  await test('GET /admin/auth-failures lists refused sign-ins with the address and the reason', async () => {
    const r = await call('GET', '/admin/auth-failures?days=30', { token: owner });
    assert.equal(r.status, 200);
    const reasons = new Set(r.data.failures.map(f => f.reason));
    for (const want of ['wrong_password', 'no_account', 'reserved_address', 'no_password']) {
      assert.ok(reasons.has(want), `missing ${want}`);
    }
    const old = r.data.failures.find(f => f.user_id === 'u-owner' && f.email === OWNER && f.reason === 'wrong_password');
    assert.ok(old, 'a failure recorded before this deploy still reads sensibly');
    const ghost = r.data.by_email.find(e => e.email === 'nobody@example.com');
    assert.deepEqual({ n: ghost.n, known: ghost.known }, { n: 1, known: false });
    assert.equal(r.data.by_email.find(e => e.email === 'ada@example.com').known, true);
    assert.equal(r.data.total, r.data.failures.length);
  });

  // ── submitting ────────────────────────────────────────────────────────────
  section('submitting and resubmitting');
  let first;
  await test('POST /recordings needs a session and a link that serves a file', async () => {
    assert.equal((await call('POST', '/recordings', { body: submission() })).status, 401);
    const page = await call('POST', '/recordings', { token: ada, body: submission({ link: `${MOCK}/files/page.html` }) });
    assert.equal(page.status, 400);
    assert.match(page.data.errors.link, /web page/);
  });
  await test('a submission gets an id whose random part is its slug suffix', async () => {
    const r = await call('POST', '/recordings', { token: ada, body: submission() });
    assert.equal(r.status, 201);
    assert.match(r.data.objectID, /^[a-z0-9]{6}-sub-\d{13}$/);
    assert.equal(r.data.slug, `finals-cal-ms-vs-pacific-bp-${r.data.objectID.slice(0, 6)}`);
    assert.deepEqual({ status: r.data.status, resubmitted: r.data.resubmitted, rebuilding: r.data.rebuilding },
      { status: 'pending', resubmitted: false, rebuilding: true });
    assert.deepEqual(dispatched.at(-1).event_type, 'rounds-changed', 'a site build was asked for, so the page exists soon');
    assert.equal(dispatched.at(-1).client_payload.reason, `submitted ${r.data.slug}`);
    assert.equal(records.get(r.data.objectID).slug, r.data.slug, 'search holds the same slug');
    first = r.data;
  });
  await test('the same title in another season gets a different slug (it used to get the same one)', async () => {
    const slugs = new Set([first.slug]);
    for (const year of ['2025-26', '2024-25', '2023-24']) {
      const r = await call('POST', '/recordings', { token: ada, body: submission({ year }) });
      assert.equal(r.status, 201);
      slugs.add(r.data.slug);
    }
    assert.equal(slugs.size, 4);
  });
  await test('a round that is pending is still a duplicate, and the refusal says which one', async () => {
    const r = await call('POST', '/recordings', { token: legacy, body: submission() });
    assert.equal(r.status, 409);
    assert.match(r.data.errors.title, /already been submitted/);
    assert.deepEqual(r.data.existing, { objectID: first.objectID, slug: first.slug, status: 'pending' });
    const blank = await call('POST', '/recordings', { token: legacy, body: submission({ tournament: '' }) });
    assert.equal(blank.status, 409, 'leaving the tournament out does not get round it');
  });
  await test('the same teams at the same stage of another tournament is not a duplicate', async () => {
    const r = await call('POST', '/recordings', { token: legacy, body: submission({ tournament: 'Rice Classic' }) });
    assert.equal(r.status, 201);
    assert.notEqual(r.data.slug, first.slug);
  });
  await test('if search refuses the round, no row is left behind and the retry is not a duplicate', async () => {
    const body = submission({ title: 'Semifinals - Cal MS vs Rice JJ' });
    searchDown = true;
    const down = await call('POST', '/recordings', { token: ada, body });
    searchDown = false;
    assert.equal(down.status, 502);
    const list = await call('GET', '/admin/submissions?q=semifinals&records=0', { token: owner });
    assert.equal(list.data.total, 0);
    assert.equal((await call('POST', '/recordings', { token: ada, body })).status, 201);
  });

  // ── progress ──────────────────────────────────────────────────────────────
  section('round progress');
  const states = p => Object.fromEntries(p.stages.map(s => [s.key, s.state]));
  const progress = async ref => (await call('GET', `/rounds/${encodeURIComponent(ref)}/progress`)).data;
  await test('GET /rounds/:ref/progress is public and found by id or slug', async () => {
    const byId = await call('GET', `/rounds/${first.objectID}/progress`);
    const bySlug = await call('GET', `/rounds/${first.slug}/progress`);
    assert.equal(byId.status, 200);
    assert.equal(bySlug.status, 200);
    assert.equal(byId.data.id, bySlug.data.id);
    assert.equal((await call('GET', '/rounds/no-such-round-zzzzzz/progress')).status, 404);
    assert.equal(byId.headers.get('cache-control'), 'no-store');
  });
  await test('a new submission: submitted done, audio active, the rest waiting, playable from its own link', async () => {
    const p = await progress(first.slug);
    assert.deepEqual(p.stages.map(s => s.key), ['submitted', 'audio', 'transcript', 'speeches', 'page']);
    assert.deepEqual(states(p), { submitted: 'done', audio: 'active', transcript: 'waiting', speeches: 'waiting', page: 'waiting' });
    assert.equal(p.status, 'fetching');
    assert.equal(p.title, 'Finals - Cal MS vs Pacific BP');
    assert.equal(p.round, 'Finals');
    assert.deepEqual(p.teams, { aff: 'Cal MS', neg: 'Pacific BP' });
    assert.deepEqual({ tournament: p.tournament, year: p.year, submitter: p.submitter }, { tournament: 'Paul Winters', year: '2026-27', submitter: 'Ada' });
    assert.ok(Math.abs(p.submittedAt - Date.now() / 1000) < 120);
    assert.equal(p.stages[0].at, p.submittedAt);
    assert.deepEqual(p.audio, { url: `${MOCK}/files/round.m4a`, source: 'submitted', peaksUrl: null });
    assert.equal(p.linkKind, 'file');
    assert.deepEqual(p.page, { path: `/recordings/${first.slug}`, url: `${MOCK}/recordings/${first.slug}`, exists: false, hasPlayer: false, builtAt: null });
    assert.deepEqual(p.media, { audio: false, peaks: false, transcript: false, speeches: false });
    assert.equal(p.failure, null);
    assert.deepEqual({ lastRunAt: p.pipeline.lastRunAt, stalled: p.pipeline.stalled }, { lastRunAt: null, stalled: false });
    // How long each step usually takes, and when the whole thing should be there.
    assert.deepEqual(p.stages.map(s => s.typicalSeconds), [null, 1200, 3600, 1200, 900]);
    const audio = p.stages[1];
    assert.equal(audio.expectedAt, p.updatedAt + 1200);
    assert.ok(p.stages.every(s => s.stuck === false));
    assert.deepEqual({ stuck: p.stuck, stuckStage: p.stuckStage }, { stuck: false, stuckStage: null });
    assert.equal(p.estimatedDoneAt, p.updatedAt + 1200 + 3600 + 1200, 'audio, then transcript, then speeches');
    assert.equal(p.submitted, undefined, 'the submission itself is only sent when asked for');
  });
  await test('?submitted=1 returns what was sent in, to the submitter and to an admin only', async () => {
    const path = `/rounds/${first.slug}/progress?submitted=1`;
    assert.equal((await call('GET', path)).data.submitted, null);
    assert.equal((await call('GET', path, { token: legacy })).data.submitted, null);
    const mine = (await call('GET', path, { token: ada })).data.submitted;
    assert.deepEqual(mine, {
      title: 'Finals - Cal MS vs Pacific BP', link: `${MOCK}/files/round.m4a`, year: '2026-27', tournament: 'Paul Winters',
      format: 'parli', level: 'college', resolution: 'This house would test its own code',
      aff: 'topical (war)', neg: '2-off (t, cap k)', decision: '3-0 Aff', tags: ['#k-aff'],
    });
    assert.deepEqual((await call('GET', path, { token: owner })).data.submitted, mine);
    // Sending it straight back is a valid submission (refused here only as a duplicate).
    const back = await call('POST', '/recordings', { token: ada, body: mine });
    assert.equal(back.status, 409);
  });
  await test('a Dropbox share link is offered in its direct-download form', async () => {
    // Dropbox itself cannot be reached from here, so the row is written directly.
    sql(`INSERT INTO submissions (object_id, slug, title, link, year, user_id, status, created_at, updated_at)
         VALUES ('dbx111-sub-1', 'dropbox-round-dbx111', 'Quarters - A vs B',
                 'https://www.dropbox.com/scl/fi/abc/round.mp4?rlkey=k&dl=0', '2026-27', 'u-legacy', 'pending', ${t0}, ${t0});`);
    const p = await progress('dbx111-sub-1');
    assert.equal(p.audio.url, 'https://dl.dropboxusercontent.com/scl/fi/abc/round.mp4?rlkey=k&dl=1');
    assert.equal(p.pipeline.stalled, true, 'twenty days pending with no run reported is stalled');
    assert.equal(p.stuck, false, 'with no run running nothing is "stuck": it is all stopped');
    assert.equal(p.estimatedDoneAt, null, 'and no finish time is guessed');
  });
  await test('POST /ingest/events needs the ingest token and checks what it is given', async () => {
    const events = [{ stage: 'run', state: 'started' }];
    assert.equal((await call('POST', '/ingest/events', { body: { events } })).status, 403);
    assert.equal((await call('POST', '/ingest/events', { token: ada, body: { events } })).status, 403);
    assert.equal((await call('POST', '/ingest/events', { token: 'wrong-token-of-same-len', body: { events } })).status, 403);
    assert.equal((await call('POST', '/ingest/events', { token: INGEST_TOKEN, body: { events: [{ stage: 'nonsense', state: 'started' }] } })).status, 400);
    assert.equal((await call('POST', '/ingest/events', { token: INGEST_TOKEN, body: { events: [{ stage: 'audio', state: 'nonsense' }] } })).status, 400);
    const ok = await call('POST', '/ingest/events', { token: INGEST_TOKEN, body: { events: [...events, { stage: 'audio', state: 'started', objectID: first.objectID }] } });
    assert.deepEqual(ok.data, { ok: true, recorded: 2 });
    assert.deepEqual((await call('POST', '/ingest/events', { token: INGEST_TOKEN, body: { events: [] } })).data, { ok: true, recorded: 0 });
    assert.equal((await call('POST', '/ingest/events', { token: INGEST_TOKEN, body: { events: [{ stage: 'dispatch', state: 'failed' }] } })).status, 400, 'that stage is the Worker\'s own');
  });
  await test('a report that repeats the last one for a round is not stored again', async () => {
    const waiting = { stage: 'transcript', state: 'skipped', slug: 'dropbox-round-dbx111', note: 'every transcription job was busy' };
    const once = await call('POST', '/ingest/events', { token: INGEST_TOKEN, body: { events: [waiting, waiting] } });
    assert.equal(once.data.recorded, 1);
    const again = await call('POST', '/ingest/events', { token: INGEST_TOKEN, body: { events: [waiting] } });
    assert.equal(again.data.recorded, 0);
    const changed = await call('POST', '/ingest/events', { token: INGEST_TOKEN, body: { events: [{ ...waiting, note: 'not signed in to Azure' }, { stage: 'run', state: 'done' }, { stage: 'run', state: 'done' }] } });
    assert.equal(changed.data.recorded, 3, 'a different reason is news, and the run\'s own heartbeat always is');
  });
  await test('once the run reports in, progress shows when the audio was started and that the pipeline is alive', async () => {
    const p = await progress(first.objectID);
    const audio = p.stages.find(s => s.key === 'audio');
    assert.equal(audio.state, 'active');
    assert.ok(audio.startedAt >= p.submittedAt);
    assert.ok(p.pipeline.lastRunAt >= p.submittedAt);
    const old = await progress('dbx111-sub-1');
    assert.equal(old.pipeline.stalled, false, 'a run just reported');
    // The run is alive and this round has still waited twenty days for audio.
    assert.deepEqual({ stuck: old.stuck, stuckStage: old.stuckStage }, { stuck: true, stuckStage: 'audio' });
    assert.equal(old.stages[1].stuck, true);
    assert.ok(old.estimatedDoneAt >= old.now, 'overdue is due now, not in the past');
  });
  const YT_ERROR = "ERROR: [youtube] aaaaaaaaaaa: Sign in to confirm you're not a bot. Use --cookies-from-browser or --cookies for the authentication.";
  await test('POST /recordings/:id/status: token only, stores the error, 404 for an unknown id', async () => {
    assert.equal((await call('POST', `/recordings/${first.objectID}/status`, { token: ada, body: { status: 'failed' } })).status, 403);
    assert.equal((await call('POST', '/recordings/nope/status', { token: INGEST_TOKEN, body: { status: 'failed' } })).status, 404);
    assert.equal((await call('POST', `/recordings/${first.objectID}/status`, { token: INGEST_TOKEN, body: { status: 'weird' } })).status, 400);
    const r = await call('POST', `/recordings/${first.objectID}/status`, { token: INGEST_TOKEN, body: { status: 'failed', note: YT_ERROR } });
    assert.deepEqual(r.data, { ok: true });
  });
  await test('a failed fetch: audio failed with a plain reason, nothing playable, marked final', async () => {
    const p = await progress(first.slug);
    assert.equal(p.status, 'failed');
    assert.deepEqual(states(p), { submitted: 'done', audio: 'failed', transcript: 'waiting', speeches: 'waiting', page: 'waiting' });
    assert.match(p.failure.reason, /without signing in/);
    assert.doesNotMatch(p.failure.reason, /ERROR|yt-dlp|cookies-from-browser/);
    assert.deepEqual({ stage: p.failure.stage, final: p.failure.final }, { stage: 'audio', final: true });
    assert.equal(p.stages[1].reason, p.failure.reason);
    assert.ok(p.stages[1].at > 0);
    assert.equal(p.audio, null);
  });
  await test('the old command-line note still gets a plain reason, not the command', async () => {
    const p = await progress('sub-1790000000000-abc123');
    assert.equal(p.status, 'failed');
    assert.equal(p.linkKind, 'youtube');
    assert.doesNotMatch(p.failure.reason, /Command failed|yt-dlp/);
  });
  await test('GET /me/submissions lists the caller\'s own rounds with status and reason', async () => {
    assert.equal((await call('GET', '/me/submissions')).status, 401);
    const r = await call('GET', '/me/submissions', { token: ada });
    assert.equal(r.status, 200);
    assert.equal(r.data.submissions.length, 5);
    const mine = r.data.submissions.find(s => s.object_id === first.objectID);
    assert.equal(mine.status, 'failed');
    assert.match(mine.reason, /without signing in/);
    assert.deepEqual(Object.keys(mine).sort(), ['created_at', 'estimatedDoneAt', 'object_id', 'reason', 'slug', 'stalled', 'status', 'stuck',
      'submitted', 'title', 'tournament', 'updated_at', 'year']);
    // Enough to fill the form and send it again, in the shape POST /recordings takes.
    assert.deepEqual(mine.submitted, {
      title: 'Finals - Cal MS vs Pacific BP', link: `${MOCK}/files/round.m4a`, year: '2026-27', tournament: 'Paul Winters',
      format: 'parli', level: 'college', resolution: 'This house would test its own code',
      aff: 'topical (war)', neg: '2-off (t, cap k)', decision: '3-0 Aff', tags: ['#k-aff'],
    });
    const other = await call('GET', '/me/submissions', { token: owner });
    assert.equal(other.data.submissions.length, 0);
  });
  await test('somebody else sending in a failed round is told it exists, and nothing of it changes', async () => {
    // What the review demonstrated: another account taking the round over,
    // replacing its link and record and deleting what was stored for it.
    r2put(`transcripts/${first.slug}.json`, '{"segments":["kept"]}');
    const before = structuredClone(records.get(first.objectID));
    const r = await call('POST', '/recordings', { token: legacy, body: submission({ link: `${MOCK}/files/takeover.m4a`, resolution: 'Not theirs' }) });
    assert.equal(r.status, 409, JSON.stringify(r.data));
    assert.match(r.data.errors.title, /already been submitted/);
    assert.deepEqual(r.data.existing, { objectID: first.objectID, slug: first.slug, status: 'failed' });
    assert.deepEqual(records.get(first.objectID), before, 'search is untouched');
    assert.ok(r2get(`transcripts/${first.slug}.json`), 'nothing stored was deleted');
    const p = await progress(first.slug);
    assert.deepEqual({ status: p.status, link: p.link }, { status: 'failed', link: `${MOCK}/files/round.m4a` });
    assert.equal((await call('GET', '/recordings/pending')).data.pending.some(s => s.object_id === first.objectID), false);
  });
  await test('a failed round can be submitted again by its submitter: same id and slug, new link, back in the queue', async () => {
    const r = await call('POST', '/recordings', { token: ada, body: submission({ link: `${MOCK}/files/second-try.m4a`, resolution: 'A corrected resolution' }) });
    assert.equal(r.status, 200);
    assert.deepEqual({ objectID: r.data.objectID, slug: r.data.slug, resubmitted: r.data.resubmitted, status: r.data.status },
      { objectID: first.objectID, slug: first.slug, resubmitted: true, status: 'pending' });
    assert.equal(records.get(first.objectID).link, `${MOCK}/files/second-try.m4a`);
    assert.equal(records.get(first.objectID).resolution, 'A corrected resolution');
    const p = await progress(first.slug);
    assert.equal(p.status, 'fetching');
    assert.equal(p.failure, null);
    assert.equal(p.link, `${MOCK}/files/second-try.m4a`);
    assert.equal(p.submitter, 'Ada', 'the round stays its first submitter\'s');
    const pending = await call('GET', '/recordings/pending');
    assert.ok(pending.data.pending.some(s => s.object_id === first.objectID && s.link.endsWith('second-try.m4a')));
  });

  // ── the later stages, from what is in the bucket ──────────────────────────
  section('stages from storage');
  await test('audio in the bucket: audio done with its time, stored copy offered, transcript and page both active', async () => {
    r2put(`audio/${first.slug}.m4a`, 'audio-bytes');
    r2put(`peaks/${first.slug}.json`, '{"peaks":[]}');
    await call('POST', `/recordings/${first.objectID}/status`, { token: INGEST_TOKEN, body: { status: 'ingested' } });
    const p = await progress(first.slug);
    assert.equal(p.status, 'transcribing');
    assert.deepEqual(states(p), { submitted: 'done', audio: 'done', transcript: 'active', speeches: 'waiting', page: 'active' });
    assert.ok(Math.abs(p.stages[1].at - Date.now() / 1000) < 120, 'when the file reached the bucket');
    assert.deepEqual(p.audio, {
      url: `https://media.test/audio/${first.slug}.m4a`, source: 'stored',
      peaksUrl: `https://media.test/peaks/${first.slug}.json`,
    });
    assert.deepEqual(p.media, { audio: true, peaks: true, transcript: false, speeches: false });
    assert.equal(p.ingestStatus, 'ingested');
    assert.equal(p.stages[4].startedAt, p.stages[1].at, 'the page is started on when the audio lands');
    assert.equal(p.stages[4].expectedAt, p.stages[1].at + 900);
    await call('POST', '/ingest/events', { token: INGEST_TOKEN, body: { events: [{ stage: 'page', state: 'started', slug: first.slug }] } });
    const reported = (await progress(first.slug)).stages[4].startedAt;
    assert.ok(reported >= p.stages[4].startedAt, 'or when the run says the rebuild began');
  });
  await test('the run\'s reports show on the transcript stage: started, then a failed attempt that is not final', async () => {
    await call('POST', '/ingest/events', { token: INGEST_TOKEN, body: { events: [{ stage: 'transcript', state: 'started', slug: first.slug }] } });
    let p = await progress(first.slug);
    assert.ok(p.stages[2].startedAt > 0);
    assert.equal(p.stages[2].state, 'active');
    await call('POST', '/ingest/events', { token: INGEST_TOKEN, body: { events: [{ stage: 'transcript', state: 'failed', slug: first.slug, note: 'could not start gt-rx-2' }] } });
    p = await progress(first.slug);
    assert.equal(p.stages[2].state, 'failed');
    assert.match(p.stages[2].reason, /tried again/);
    assert.deepEqual({ stage: p.failure.stage, final: p.failure.final }, { stage: 'transcript', final: false });
    assert.equal(p.status, 'transcribing', 'a retried step does not fail the round');
  });
  await test('transcript, then speeches, arriving in the bucket move the round on', async () => {
    r2put(`transcripts/${first.slug}.json`, '{"segments":[]}');
    let p = await progress(first.slug);
    assert.equal(p.status, 'labelling');
    assert.deepEqual(states(p), { submitted: 'done', audio: 'done', transcript: 'done', speeches: 'active', page: 'active' });
    r2put(`speeches/${first.slug}.json`, '{"speeches":[]}');
    p = await progress(first.slug);
    assert.equal(p.status, 'publishing');
    assert.equal(p.stages[3].state, 'done');
    assert.ok(p.stages[3].at > 0);
  });
  await test('the site is asked about a round\'s page at most once a minute', async () => {
    const asked = () => mockLog.filter(l => l === `HEAD /recordings/${first.slug}/`).length;
    const n = asked();
    assert.ok(n >= 1, 'it was asked at least once');
    pages.set(first.slug, new Date(Date.now() + 60_000));
    const p = await progress(first.slug);
    assert.equal(asked(), n, 'not asked again inside the minute');
    assert.equal(p.page.exists, false);
  });
  let second, third;
  await test('a page built before the audio arrived exists but is not "published"', async () => {
    second = (await call('POST', '/recordings', { token: ada, body: submission({ title: 'Quarterfinals - Rice LL vs Cal MS' }) })).data;
    r2put(`audio/${second.slug}.m4a`, 'audio-bytes');
    await call('POST', `/recordings/${second.objectID}/status`, { token: INGEST_TOKEN, body: { status: 'ingested' } });
    pages.set(second.slug, new Date(Date.now() - 3600_000));
    const p = await progress(second.slug);
    assert.deepEqual({ exists: p.page.exists, hasPlayer: p.page.hasPlayer }, { exists: true, hasPlayer: false });
    assert.ok(p.page.builtAt > 0);
    assert.equal(states(p).page, 'active');
    assert.deepEqual(p.audio.peaksUrl, null, 'no waveform file yet');
  });
  await test('a page built after the audio: page done, and with everything else in, published', async () => {
    third = (await call('POST', '/recordings', { token: ada, body: submission({ title: 'Octafinals - Nueva LJ vs Menlo SG' }) })).data;
    for (const [dir, ext] of [['audio', 'm4a'], ['peaks', 'json'], ['transcripts', 'json'], ['speeches', 'json']]) {
      r2put(`${dir}/${third.slug}.${ext}`, '{}');
    }
    await call('POST', `/recordings/${third.objectID}/status`, { token: INGEST_TOKEN, body: { status: 'ingested' } });
    const built = new Date(Date.now() + 120_000);
    pages.set(third.slug, built);
    const p = await progress(third.slug);
    assert.equal(p.status, 'published');
    assert.ok(p.stages.every(s => s.state === 'done'));
    assert.equal(p.stages[4].at, Math.floor(built.getTime() / 1000));
    assert.deepEqual({ exists: p.page.exists, hasPlayer: p.page.hasPlayer }, { exists: true, hasPlayer: true });
    assert.equal(p.failure, null);
    // Remembered: the site is not asked again once the page has been seen.
    pages.delete(third.slug);
    const n = mockLog.length;
    assert.equal((await progress(third.slug)).status, 'published');
    assert.equal(mockLog.length, n);
  });

  // ── admin: submissions ────────────────────────────────────────────────────
  section('admin: submissions');
  await test('GET /admin/submissions: every submission with its record, progress and ingest events', async () => {
    const r = await call('GET', '/admin/submissions', { token: owner });
    assert.equal(r.status, 200);
    assert.equal(r.data.total, 10);
    assert.equal(r.data.submissions.length, 10);
    assert.deepEqual(r.data.counts, { pending: 6, ingested: 3, failed: 1, removed: 0 });
    assert.ok(r.data.pipeline.lastRunAt > 0);
    const row = r.data.submissions.find(s => s.object_id === first.objectID);
    assert.deepEqual(Object.keys(row).sort(), ['attempts', 'author', 'author_email', 'author_id', 'created_at', 'events', 'link',
      'note', 'object_id', 'progress', 'record', 'review', 'slug', 'status', 'title', 'tournament', 'updated_at', 'year']);
    assert.deepEqual({ author: row.author, author_email: row.author_email, author_id: row.author_id }, { author: 'Ada', author_email: 'ada@example.com', author_id: adaId });
    assert.equal(row.attempts, 2, 'one failed, one ingested');
    assert.equal(row.record.resolution, 'A corrected resolution');
    assert.equal(row.record.format, 'parli');
    assert.equal(row.progress.status, 'publishing');
    assert.ok(row.events.length >= 4 && row.events.length <= 10);
    assert.ok(row.events[0].id > row.events[1].id, 'newest first');
    const legacyRow = r.data.submissions.find(s => s.object_id === 'sub-1790000000000-abc123');
    assert.match(legacyRow.note, /^Command failed/);
    assert.equal(legacyRow.record, null, 'not in search');
    assert.equal(legacyRow.progress.status, 'failed');
  });
  await test('GET /admin/submissions filters and pages', async () => {
    const failed = await call('GET', '/admin/submissions?status=failed', { token: owner });
    assert.deepEqual(failed.data.submissions.map(s => s.object_id), ['sub-1790000000000-abc123']);
    assert.equal(failed.data.total, 1);
    const q = await call('GET', '/admin/submissions?q=QUARTERfinals', { token: owner });
    assert.deepEqual(q.data.submissions.map(s => s.object_id), [second.objectID]);
    const hers = await call('GET', `/admin/submissions?user=${adaId}&records=0`, { token: owner });
    assert.equal(hers.data.total, 7);
    assert.ok(hers.data.submissions.every(s => s.author_id === adaId));
    const his = await call('GET', '/admin/submissions?user=u-legacy&records=0', { token: owner });
    assert.deepEqual(his.data.submissions.map(s => s.title).sort(), ['Finals - Cal MS vs Pacific BP', 'Octafinals - Nueva LJ vs Menlo-Atherton SG', 'Quarters - A vs B']);
    const page1 = await call('GET', '/admin/submissions?limit=4&offset=0&records=0', { token: owner });
    const page2 = await call('GET', '/admin/submissions?limit=4&offset=4&records=0', { token: owner });
    assert.equal(page1.data.submissions.length, 4);
    assert.equal(page1.data.total, 10);
    assert.equal(page1.data.submissions[0].record, null, 'records=0 skips search');
    assert.equal(new Set([...page1.data.submissions, ...page2.data.submissions].map(s => s.object_id)).size, 8);
    assert.ok(page1.data.submissions[0].created_at >= page1.data.submissions[3].created_at, 'newest first');
  });
  await test('GET /admin/submissions/:id: one submission with all its events', async () => {
    const r = await call('GET', `/admin/submissions/${first.objectID}`, { token: owner });
    assert.equal(r.status, 200);
    assert.equal(r.data.submission.object_id, first.objectID);
    const stages = r.data.submission.events.map(e => `${e.stage}:${e.state}`);
    for (const want of ['audio:queued', 'audio:started', 'audio:failed', 'audio:done', 'transcript:started', 'transcript:failed']) {
      assert.ok(stages.includes(want), `missing ${want} in ${stages}`);
    }
    assert.equal(r.data.submission.events.find(e => e.state === 'failed' && e.stage === 'audio').note, YT_ERROR);
    assert.equal((await call('GET', '/admin/submissions/nope', { token: owner })).status, 404);
  });
  await test('GET /admin/ingest/events: the run\'s log, for one round or all', async () => {
    const one = await call('GET', `/admin/ingest/events?ref=${first.objectID}`, { token: owner });
    assert.ok(one.data.events.length >= 6);
    assert.ok(one.data.events.every(e => e.slug === first.slug));
    const all = await call('GET', '/admin/ingest/events?limit=500', { token: owner });
    assert.ok(all.data.events.some(e => e.stage === 'run'));
    assert.ok(all.data.events.length > one.data.events.length);
    assert.ok('stalled' in all.data.pipeline);
  });
  await test('POST /admin/submissions/:id/retry puts a failed round back in the queue', async () => {
    const id = 'sub-1790000000000-abc123';
    const r = await call('POST', `/admin/submissions/${id}/retry`, { token: machine });
    assert.deepEqual(r.data, { ok: true, status: 'pending' });
    const p = await progress(id);
    assert.equal(p.status, 'fetching');
    assert.equal(p.failure, null);
    assert.ok((await call('GET', '/recordings/pending')).data.pending.some(s => s.object_id === id));
    const detail = await call('GET', `/admin/submissions/${id}`, { token: owner });
    assert.equal(detail.data.submission.note, null);
    assert.equal(detail.data.submission.events[0].state, 'queued');
    assert.equal((await call('POST', '/admin/submissions/nope/retry', { token: owner })).status, 404);
  });
  await test('POST /admin/submissions/:id/link checks the new link before touching anything', async () => {
    const path = `/admin/submissions/${first.objectID}/link`;
    assert.equal((await call('POST', path, { token: owner, body: {} })).status, 400);
    assert.equal((await call('POST', path, { token: owner, body: { link: 'not a url' } })).status, 400);
    const dead = await call('POST', path, { token: owner, body: { link: `${MOCK}/files/missing.m4a` } });
    assert.equal(dead.status, 400);
    assert.match(dead.data.errors.link, /not found/);
    searchDown = true;
    const down = await call('POST', path, { token: owner, body: { link: `${MOCK}/files/third.m4a` } });
    searchDown = false;
    assert.equal(down.status, 502);
    assert.equal((await progress(first.slug)).media.audio, true, 'nothing was deleted');
    assert.equal((await call('POST', '/admin/submissions/nope/link', { token: owner, body: { link: `${MOCK}/files/a.m4a` } })).status, 404);
  });
  await test('correcting the link deletes what was stored from the old one, delists it and re-queues the round', async () => {
    r2put('index.json', JSON.stringify({ generated: 'x', playable: [first.slug, 'someone-else-abc123'], transcribed: [first.slug] }));
    const r = await call('POST', `/admin/submissions/${first.objectID}/link`, { token: owner, body: { link: `${MOCK}/files/third.m4a` } });
    assert.equal(r.status, 200);
    assert.deepEqual({ ok: r.data.ok, status: r.data.status, link: r.data.link, rebuilding: r.data.rebuilding },
      { ok: true, status: 'pending', link: `${MOCK}/files/third.m4a`, rebuilding: true });
    assert.match(r.data.probe, /56MB/);
    assert.deepEqual(r.data.removed.sort(), [`audio/${first.slug}.m4a`, `peaks/${first.slug}.json`, `speeches/${first.slug}.json`, `transcripts/${first.slug}.json`]);
    assert.equal(records.get(first.objectID).link, `${MOCK}/files/third.m4a`);
    assert.equal(records.get(first.objectID).title, 'Finals - Cal MS vs Pacific BP', 'the rest of the record is untouched');
    const p = await progress(first.slug);
    assert.equal(p.status, 'fetching');
    assert.deepEqual(p.media, { audio: false, peaks: false, transcript: false, speeches: false });
    assert.equal(p.audio.url, `${MOCK}/files/third.m4a`);
    const index = JSON.parse(r2get('index.json'));
    assert.deepEqual(index, { generated: 'x', playable: ['someone-else-abc123'], transcribed: [] });
  });
  await test('DELETE /admin/submissions/:id removes it from search, storage and the media index', async () => {
    r2put('index.json', JSON.stringify({ generated: 'x', playable: [third.slug, 'someone-else-abc123'], transcribed: [third.slug] }));
    const r = await call('DELETE', `/admin/submissions/${third.objectID}`, { token: owner, body: { note: 'wrong round' } });
    assert.equal(r.status, 200);
    assert.deepEqual({ ok: r.data.ok, review: r.data.review, n: r.data.removed.length }, { ok: true, review: 'removed', n: 4 });
    assert.equal(records.has(third.objectID), false);
    assert.deepEqual(JSON.parse(r2get('index.json')).playable, ['someone-else-abc123']);
    assert.equal(r2get(`audio/${third.slug}.m4a`), null);
    const p = await progress(third.slug);
    assert.equal(p.status, 'removed');
    assert.equal(p.link, null, 'a removed round\'s link is not handed out');
    assert.equal(p.audio, null);
    assert.deepEqual({ stage: p.failure.stage, final: p.failure.final }, { stage: null, final: true });
    assert.equal((await call('DELETE', '/admin/submissions/nope', { token: owner })).status, 404);
  });
  await test('a removed round cannot be retried or relinked, but its submitter can send it again as a new round', async () => {
    assert.equal((await call('POST', `/admin/submissions/${third.objectID}/retry`, { token: owner })).status, 409);
    assert.equal((await call('POST', `/admin/submissions/${third.objectID}/link`, { token: owner, body: { link: `${MOCK}/files/a.m4a` } })).status, 409);
    const theirs = await call('POST', '/recordings', { token: legacy, body: submission({ title: 'Octafinals - Nueva LJ vs Menlo SG' }) });
    assert.equal(theirs.status, 409, 'not by somebody else');
    assert.deepEqual(theirs.data.existing, { objectID: third.objectID, slug: third.slug, status: 'removed' });
    const again = await call('POST', '/recordings', { token: ada, body: submission({ title: 'Octafinals - Nueva LJ vs Menlo SG' }) });
    assert.equal(again.status, 201);
    assert.equal(again.data.resubmitted, false);
    assert.notEqual(again.data.objectID, third.objectID);
    assert.notEqual(again.data.slug, third.slug);
  });
  await test('the older DELETE /recordings/:id and GET /recordings/submissions still work', async () => {
    const r = await call('DELETE', `/recordings/${second.objectID}`, { token: owner });
    assert.equal(r.status, 200);
    assert.equal(r.data.review, 'removed');
    const list = await call('GET', '/recordings/submissions', { token: owner });
    assert.equal(list.status, 200);
    assert.ok(list.data.submissions.every(s => s.review !== 'removed'));
    const removed = await call('GET', '/admin/submissions?review=removed&records=0', { token: owner });
    assert.deepEqual(removed.data.submissions.map(s => s.object_id).sort(), [second.objectID, third.objectID].sort());
    assert.equal(removed.data.counts.removed, 2);
    assert.equal(removed.data.submissions.find(s => s.object_id === third.objectID).note, 'wrong round');
    // An admin may send in a removed round that is not theirs.
    const byAdmin = await call('POST', '/recordings', { token: owner, body: submission({ title: 'Quarterfinals - Rice LL vs Cal MS' }) });
    assert.equal(byAdmin.status, 201, JSON.stringify(byAdmin.data));
    assert.notEqual(byAdmin.data.objectID, second.objectID);
    // removed=0 leaves them out of a filter by status.
    const ingested = await call('GET', '/admin/submissions?status=ingested&records=0', { token: owner });
    const stillHere = await call('GET', '/admin/submissions?status=ingested&removed=0&records=0', { token: owner });
    assert.ok(ingested.data.submissions.some(s => s.review === 'removed'));
    assert.ok(stillHere.data.submissions.every(s => s.review !== 'removed'));
    assert.equal(stillHere.data.total, ingested.data.total - ingested.data.submissions.filter(s => s.review === 'removed').length);
  });
  await test('a removed round\'s details are still there for whoever sent it, to send it again', async () => {
    assert.equal(records.has(third.objectID), false, 'search has forgotten it');
    const p = await call('GET', `/rounds/${third.slug}/progress?submitted=1`, { token: ada });
    assert.equal(p.data.status, 'removed');
    assert.deepEqual({ format: p.data.submitted.format, level: p.data.submitted.level, neg: p.data.submitted.neg, tags: p.data.submitted.tags, title: p.data.submitted.title },
      { format: 'parli', level: 'college', neg: '2-off (t, cap k)', tags: ['#k-aff'], title: 'Octafinals - Nueva LJ vs Menlo SG' });
    assert.equal((await call('GET', `/rounds/${third.slug}/progress?submitted=1`)).data.submitted, null);
  });

  // ── admin: data ───────────────────────────────────────────────────────────
  section('admin: users, sessions, rounds, telemetry');
  await test('GET /admin/users: each account with its counts and flags', async () => {
    await call('POST', '/me/favorites', { token: ada, body: { kind: 'recording', ref: first.slug } });
    await call('POST', `/rounds/${first.slug}/rating`, { token: ada, body: { stars: 4 } });
    await call('POST', '/me/notes', { token: ada, body: { slug: first.slug, atS: 12, body: 'a note' } });
    await call('POST', '/me/tags', { token: ada, body: { slug: first.slug, tag: 'good' } });
    await call('POST', `/rounds/${first.slug}/proposals`, { token: ada, body: { kind: 'transcript', anchor: 'seg-1', original: 'a', proposed: 'b' } });
    const r = await call('GET', '/admin/users', { token: owner });
    assert.equal(r.status, 200);
    assert.equal(r.data.total, 6);
    const u = r.data.users.find(x => x.email === 'ada@example.com');
    assert.deepEqual(Object.keys(u).sort(), ['created_at', 'display_name', 'email', 'favorites', 'has_password', 'id', 'is_admin',
      'last_seen_at', 'notes', 'prep_access', 'proposals', 'proposals_accepted', 'ratings', 'rep', 'sessions_active', 'submissions', 'tags']);
    assert.deepEqual({ proposals: u.proposals, proposals_accepted: u.proposals_accepted, submissions: u.submissions, favorites: u.favorites, notes: u.notes, ratings: u.ratings, tags: u.tags },
      { proposals: 1, proposals_accepted: 0, submissions: 8, favorites: 1, notes: 1, ratings: 1, tags: 1 });
    assert.deepEqual({ is_admin: u.is_admin, prep_access: u.prep_access, has_password: u.has_password }, { is_admin: false, prep_access: false, has_password: true });
    assert.ok(Math.abs(u.last_seen_at - Date.now() / 1000) < 300);
    assert.equal(u.sessions_active, 1);
    assert.equal(r.data.users.find(x => x.email === OWNER).is_admin, true);
    assert.equal(r.data.users.find(x => x.email === SPARE).is_admin, false);
    assert.ok(!JSON.stringify(r.data).includes('password_hash'));
  });
  await test('GET /admin/users filters, sorts and pages', async () => {
    const q = await call('GET', '/admin/users?q=ADA@', { token: owner });
    assert.deepEqual(q.data.users.map(u => u.email), ['ada@example.com']);
    const admins = await call('GET', '/admin/users?admin=1', { token: owner });
    assert.deepEqual(admins.data.users.map(u => u.email).sort(), [MACHINE, OWNER].sort());
    const byName = await call('GET', '/admin/users?sort=name&limit=2', { token: owner });
    assert.deepEqual(byName.data.users.map(u => u.display_name), ['Ada', 'Legacy']);
    assert.equal(byName.data.total, 6);
    const next = await call('GET', '/admin/users?sort=name&limit=2&offset=2', { token: owner });
    assert.deepEqual(next.data.users.map(u => u.display_name), ['Lookalike', 'Machine']);
    const bad = await call('GET', '/admin/users?sort=1;DROP TABLE users', { token: owner });
    assert.equal(bad.status, 200, 'an unknown sort falls back');
    const seen = await call('GET', '/admin/users?sort=seen', { token: owner });
    assert.ok(seen.data.users[0].last_seen_at >= seen.data.users[1].last_seen_at);
  });
  await test('GET /admin/users/:id: one account with its sessions and refused sign-ins, by id or email', async () => {
    const r = await call('GET', `/admin/users/${adaId}`, { token: owner });
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.data).sort(), ['auth_failures', 'sessions', 'user']);
    assert.equal(r.data.user.email, 'ada@example.com');
    assert.equal(r.data.user.submissions, 8);
    assert.equal(typeof r.data.user.is_admin, 'boolean');
    assert.equal(r.data.sessions.length, 1);
    assert.deepEqual(Object.keys(r.data.sessions[0]).sort(), ['active', 'created_at', 'expires_at', 'last_seen_at']);
    assert.equal(r.data.sessions[0].active, true);
    assert.deepEqual(r.data.auth_failures.map(f => f.reason), ['wrong_password']);
    assert.ok(!JSON.stringify(r.data).includes(ada), 'no token');
    const byEmail = await call('GET', `/admin/users/${encodeURIComponent('Ada@Example.com')}`, { token: owner });
    assert.equal(byEmail.data.user.id, adaId);
    const reserved = await call('GET', `/admin/users/${encodeURIComponent(MACHINE)}`, { token: owner });
    assert.ok(reserved.data.auth_failures.some(f => f.reason === 'no_password'), 'attempts on an address count, not only on the account');
    assert.equal((await call('GET', '/admin/users/nobody', { token: owner })).status, 404);
  });
  await test('GET /admin/proposals carries start_s and end_s; history and revisions say what was settled and how', async () => {
    const mine = await call('POST', `/rounds/${first.slug}/proposals`, { token: owner, body: { kind: 'boundary', anchor: 'PMC', original: '0', proposed: '12.5', startS: 12.5, endS: 430 } });
    assert.equal(mine.data.accepted, true, 'an admin\'s own edit is the decision');
    const open = await call('GET', '/admin/proposals', { token: owner });
    assert.equal(open.data.proposals.length, 1);
    assert.deepEqual(Object.keys(open.data.proposals[0]).sort(), ['anchor', 'author', 'author_id', 'created_at', 'end_s', 'id', 'kind', 'note',
      'original', 'proposed', 'score', 'slug', 'start_s', 'status']);
    const pid = open.data.proposals[0].id;
    await call('POST', `/admin/proposals/${pid}/resolve`, { token: machine, body: { action: 'reject' } });

    const h = await call('GET', '/admin/proposals/history', { token: owner });
    assert.equal(h.status, 200);
    assert.equal(h.data.total, 2);
    const rejected = h.data.proposals.find(p => p.id === pid);
    assert.deepEqual({ status: rejected.status, original: rejected.original, proposed: rejected.proposed, author: rejected.author, how: rejected.resolved_how, by: rejected.resolved_by },
      { status: 'rejected', original: 'a', proposed: 'b', author: 'Ada', how: 'admin', by: 'Machine' });
    assert.ok(rejected.resolved_at >= rejected.created_at);
    const accepted = h.data.proposals.find(p => p.id === mine.data.id);
    assert.deepEqual({ status: accepted.status, start_s: accepted.start_s, end_s: accepted.end_s, how: accepted.resolved_how, by: accepted.resolved_by },
      { status: 'accepted', start_s: 12.5, end_s: 430, how: 'admin', by: 'Owner' });
    const only = await call('GET', '/admin/proposals/history?status=rejected', { token: owner });
    assert.deepEqual(only.data.proposals.map(p => p.id), [pid]);
    assert.equal((await call('GET', `/admin/proposals/history?user=${adaId}`, { token: owner })).data.total, 1);
    assert.equal((await call('GET', '/admin/proposals/history?slug=no-such', { token: owner })).data.total, 0);

    const r = await call('GET', '/admin/revisions', { token: owner });
    assert.equal(r.data.total, 1);
    assert.deepEqual(Object.keys(r.data.revisions[0]).sort(), ['anchor', 'applied_at', 'author', 'author_id', 'end_s', 'id', 'kind', 'original',
      'proposal_id', 'slug', 'start_s', 'value']);
    assert.deepEqual({ slug: r.data.revisions[0].slug, value: r.data.revisions[0].value, author: r.data.revisions[0].author, proposal_id: r.data.revisions[0].proposal_id },
      { slug: first.slug, value: '12.5', author: 'Owner', proposal_id: mine.data.id });
    assert.equal((await call('GET', '/admin/revisions?slug=no-such', { token: owner })).data.total, 0);
  });
  await test('GET /admin/sessions: counts and recent sessions, no tokens', async () => {
    const r = await call('GET', '/admin/sessions', { token: owner });
    assert.equal(r.status, 200);
    assert.ok(r.data.active >= 5);
    assert.ok(r.data.active_users >= 4 && r.data.active_users <= r.data.active);
    assert.equal(r.data.expired, 0);
    assert.deepEqual(Object.keys(r.data.seen), ['h24', 'd7', 'd30']);
    assert.ok(r.data.seen.h24 >= 4);
    assert.ok(r.data.signins.h24 >= 5);
    assert.deepEqual(Object.keys(r.data.recent[0]).sort(), ['created_at', 'display_name', 'email', 'expires_at', 'last_seen_at', 'user_id']);
    for (const t of [owner, ada, legacy, machine]) assert.ok(!JSON.stringify(r.data).includes(t));
  });
  await test('GET /admin/rounds: search records, submissions and stray files, each with what it has', async () => {
    records.set('ffee0400f9790_dashboard_generated_id', { objectID: 'ffee0400f9790_dashboard_generated_id', title: 'Berkeley LS vs USC', year: '2019-20', format: 'parli', level: 'college', link: 'https://x/y.mp4' });
    r2put('audio/berkeley-ls-vs-usc-ffee04.m4a', 'a');
    r2put('transcripts/orphan-round-zzzzzz.json', '{}');
    const fourth = (await call('POST', '/recordings', { token: ada, body: submission({ title: 'Doubles - A vs B' }) })).data;
    pages.set(fourth.slug, new Date(Date.now() - 1000));
    const r = await call('GET', '/admin/rounds', { token: owner });
    assert.equal(r.status, 200);
    assert.equal(r.data.index_error, null);
    assert.equal(r.data.site.last_deploy_at, Math.floor(siteDeployed.getTime() / 1000));
    const bySlug = Object.fromEntries(r.data.rounds.map(x => [x.slug, x]));
    const archive = bySlug['berkeley-ls-vs-usc-ffee04'];
    assert.deepEqual({ source: archive.source, has_audio: archive.has_audio, has_transcript: archive.has_transcript, has_page: archive.has_page, page_verified: archive.page_verified, submission: archive.submission },
      { source: 'index', has_audio: true, has_transcript: false, has_page: true, page_verified: false, submission: null });
    assert.deepEqual(Object.keys(archive).sort(), ['added_at', 'audio_at', 'format', 'has_audio', 'has_page', 'has_peaks', 'has_speeches', 'has_transcript', 'level', 'link',
      'object_id', 'page_at', 'page_verified', 'slug', 'source', 'speeches_at', 'submission', 'title', 'tournament', 'transcript_at', 'year']);
    assert.ok(Math.abs(archive.added_at - Date.now() / 1000) < 300, 'an archive round is dated by its first file');
    assert.equal(archive.audio_at, archive.added_at);
    assert.equal(bySlug['orphan-round-zzzzzz'].transcript_at > 0, true);
    const orphan = bySlug['orphan-round-zzzzzz'];
    assert.deepEqual({ source: orphan.source, object_id: orphan.object_id, has_transcript: orphan.has_transcript, has_page: orphan.has_page },
      { source: 'media', object_id: null, has_transcript: true, has_page: false });
    const gone = bySlug[third.slug];
    assert.deepEqual({ source: gone.source, review: gone.submission.review, has_audio: gone.has_audio }, { source: 'submission', review: 'removed', has_audio: false });
    const live = bySlug[fourth.slug];
    assert.equal(live.added_at, live.submission.created_at, 'a submitted round is dated by its submission');
    assert.deepEqual({ source: live.source, has_page: live.has_page, page_verified: live.page_verified, status: live.submission.status },
      { source: 'index', has_page: true, page_verified: true, status: 'pending' });
    assert.equal(r.data.counts.orphans, 1);
    assert.equal(r.data.total, r.data.rounds.length);
    assert.equal(new Set(r.data.rounds.map(x => x.slug)).size, r.data.rounds.length, 'no round listed twice');
  });
  await test('GET /admin/rounds filters, and survives the search index being down', async () => {
    const noAudio = await call('GET', '/admin/rounds?missing=audio', { token: owner });
    assert.ok(noAudio.data.rounds.length > 0 && noAudio.data.rounds.every(x => !x.has_audio));
    const q = await call('GET', '/admin/rounds?q=berkeley', { token: owner });
    assert.deepEqual(q.data.rounds.map(x => x.slug), ['berkeley-ls-vs-usc-ffee04']);
    assert.ok(q.data.counts.audio >= 1, 'counts are over everything');
    searchDown = true;
    const down = await call('GET', '/admin/rounds', { token: owner });
    searchDown = false;
    assert.equal(down.status, 200);
    assert.match(down.data.index_error, /could not be read/);
    assert.ok(down.data.rounds.some(x => x.source === 'submission'));
  });
  await test('GET /admin/stats no longer fails on a payload that is not JSON', async () => {
    const r = await call('GET', '/admin/stats?days=365', { token: owner });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.ok(r.data.searches.some(s => s.term === 'framework'));
    for (const k of ['users', 'proposals', 'accepted', 'votes', 'notes', 'favorites', 'events', 'ratings', 'submissions', 'sessions_active', 'prep_users', 'auth_failed']) {
      assert.equal(typeof r.data.totals[k], 'number', k);
    }
    assert.equal(r.data.totals.users, 6);
    assert.ok(r.data.totals.auth_failed >= 4);
  });
  await test('POST /events stores an over-long payload as valid JSON, and stats still answers', async () => {
    const q = 'q'.repeat(5000);
    const r = await call('POST', '/events', { body: { kind: 'search', payload: { q, page: 3 } } });
    assert.equal(r.status, 200);
    const tail = await call('GET', '/admin/events?kind=search&limit=1', { token: owner });
    const stored = JSON.parse(tail.data.events[0].payload);
    assert.deepEqual(stored, { q: 'q'.repeat(120), page: 3, truncated: true });
    assert.equal((await call('GET', '/admin/stats?days=1', { token: owner })).status, 200);
    assert.equal((await call('POST', '/events', { body: { kind: 'made.up' } })).status, 400);
  });
  await test('GET /admin/events: user_id on each row, and filters by kind, round, person and position', async () => {
    const all = await call('GET', '/admin/events?limit=200', { token: owner });
    assert.ok(all.data.events.every(e => 'user_id' in e && 'who' in e));
    const kind = await call('GET', '/admin/events?kind=recording.submitted&limit=200', { token: owner });
    assert.ok(kind.data.events.length >= 8 && kind.data.events.every(e => e.kind === 'recording.submitted'));
    const slug = await call('GET', `/admin/events?slug=${first.slug}&limit=200`, { token: owner });
    assert.ok(slug.data.events.length >= 3 && slug.data.events.every(e => e.slug === first.slug));
    const person = await call('GET', `/admin/events?user=${adaId}&limit=200`, { token: owner });
    assert.ok(person.data.events.length >= 8 && person.data.events.every(e => e.user_id === adaId));
    const mid = all.data.events[5].id;
    const older = await call('GET', `/admin/events?before=${mid}&limit=3`, { token: owner });
    assert.ok(older.data.events.every(e => e.id < mid));
    assert.equal(older.data.events[0].id, all.data.events[6].id);
    const since = await call('GET', `/admin/events?since=${mid}`, { token: owner });
    assert.ok(since.data.events.every(e => e.id > mid));
  });

  // ── what the review of this change found, each fixed and held to it ──────
  section('late reports, removed rounds, limits, restarts');
  const pendingRow = async objectID => (await call('GET', '/recordings/pending')).data.pending.find(p => p.object_id === objectID);
  const ownSubmit = async (title, over = {}) => {
    const r = await call('POST', '/recordings', { token: owner, body: submission({ title, ...over }) });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    return r.data;
  };
  const report = (objectID, body) => call('POST', `/recordings/${objectID}/status`, { token: INGEST_TOKEN, body });
  let lateRemoved, restartRound;

  await test('removing a round empties the media domain\'s cache of its files, both copies of each', async () => {
    const audio = `https://media.test/audio/${third.slug}.m4a`;
    const asked = purged.filter(p => p.files.includes(audio));
    assert.equal(asked.length, 1, JSON.stringify(purged).slice(0, 600));
    assert.ok(asked[0].files.some(f => f.url === audio && f.headers?.Origin === new URL(MOCK).origin));
    assert.ok(asked[0].files.includes('https://media.test/index.json'));
    assert.deepEqual({ zone: asked[0].zone, auth: asked[0].auth }, { zone: '7627240c9688e6514a397b9509758a2a', auth: 'Bearer test-purge-token' });
  });
  await test('a report from before a link correction is refused, and the audio it uploaded is taken back out', async () => {
    const s = await ownSubmit('Late - Relinked AA vs BB');
    const was = await pendingRow(s.objectID);
    assert.equal(typeof was.attempt, 'number');
    assert.equal((await call('POST', `/admin/submissions/${s.objectID}/link`, { token: owner, body: { link: `${MOCK}/files/relinked.m4a` } })).status, 200);
    // The run that read the queue before the correction finishes, with the old link.
    r2put(`audio/${s.slug}.m4a`, 'the-old-recording');
    r2put(`peaks/${s.slug}.json`, '{}');
    const late = await report(s.objectID, { status: 'ingested', attempt: was.attempt, link: was.link });
    assert.equal(late.status, 409, JSON.stringify(late.data));
    assert.equal(r2get(`audio/${s.slug}.m4a`), null, 'the old recording is not left under the round');
    assert.equal(r2get(`peaks/${s.slug}.json`), null);
    const p = await progress(s.slug);
    assert.deepEqual({ status: p.status, ingest: p.ingestStatus, link: p.link },
      { status: 'fetching', ingest: 'pending', link: `${MOCK}/files/relinked.m4a` });
    const now = await pendingRow(s.objectID);
    assert.ok(now && now.attempt > was.attempt, 'still queued, as a new attempt');
    assert.deepEqual((await report(s.objectID, { status: 'failed', note: 'x', attempt: now.attempt, link: now.link })).data, { ok: true },
      'a report for the current attempt is taken');
  });
  await test('a report for a round removed while it was being fetched is refused, and the files it uploaded are deleted', async () => {
    const s = await ownSubmit('Late - Removed CC vs DD');
    const was = await pendingRow(s.objectID);
    assert.equal((await call('DELETE', `/admin/submissions/${s.objectID}`, { token: owner })).status, 200);
    r2put(`audio/${s.slug}.m4a`, 'uploaded-after-the-removal');
    r2put(`peaks/${s.slug}.json`, '{}');
    const late = await report(s.objectID, { status: 'ingested', attempt: was.attempt, link: was.link });
    assert.equal(late.status, 409);
    assert.equal(r2get(`audio/${s.slug}.m4a`), null);
    assert.equal(r2get(`peaks/${s.slug}.json`), null);
    assert.equal((await report(s.objectID, { status: 'ingested' })).status, 409, 'and from a run too old to send its attempt');
    assert.equal((await progress(s.slug)).status, 'removed');
    lateRemoved = s;
  });
  await test('confirm and edit refuse a removed round, which stays out of search and out of the queue', async () => {
    assert.equal((await call('POST', `/recordings/${lateRemoved.objectID}/confirm`, { token: owner })).status, 409);
    assert.equal((await call('PATCH', `/recordings/${lateRemoved.objectID}`, { token: owner, body: { title: 'Revived' } })).status, 409);
    assert.equal(records.has(lateRemoved.objectID), false, 'no stub record made');
    assert.equal(await pendingRow(lateRemoved.objectID), undefined);
    assert.equal((await progress(lateRemoved.slug)).review, 'removed');
  });
  await test('removing a round already removed changes nothing and asks for no rebuild', async () => {
    const n = dispatched.length;
    const r = await call('DELETE', `/admin/submissions/${lateRemoved.objectID}`, { token: owner });
    assert.deepEqual(r.data, { ok: true, review: 'removed', removed: [], rebuilding: false });
    assert.equal(dispatched.length, n);
  });
  await test('a search index that never answers a removal is a 502, and nothing has been deleted', async () => {
    const s = await ownSubmit('Unanswered - EE vs FF');
    r2put(`audio/${s.slug}.m4a`, 'kept');
    searchHangs = true;
    const r = await call('DELETE', `/admin/submissions/${s.objectID}`, { token: owner });
    searchHangs = false;
    assert.equal(r.status, 502, JSON.stringify(r.data));
    assert.ok(r2get(`audio/${s.slug}.m4a`));
    assert.equal((await progress(s.slug)).review, 'unreviewed');
  });
  await test('confirming or editing a round does not restart the clock it has been waiting on', async () => {
    const s = await ownSubmit('Clock - GG vs HH');
    sql(`UPDATE submissions SET updated_at = updated_at - 600 WHERE object_id = '${s.objectID}';`);
    const before = (await progress(s.slug)).updatedAt;
    assert.equal((await call('POST', `/recordings/${s.objectID}/confirm`, { token: owner })).status, 200);
    assert.equal((await call('PATCH', `/recordings/${s.objectID}`, { token: owner, body: { resolution: 'r' } })).status, 200);
    assert.equal((await progress(s.slug)).updatedAt, before);
  });
  await test('a link is a video only when its host is one; "youtube.com" elsewhere in it is checked like any link', async () => {
    const sneaky = await call('POST', '/recordings', { token: owner, body: submission({ title: 'Sneaky - II vs JJ', link: 'http://127.0.0.1:9/internal?x=youtube.com' }) });
    assert.equal(sneaky.status, 400, JSON.stringify(sneaky.data));
    assert.match(sneaky.data.errors.link, /could not be reached/);
    const file = await ownSubmit('Sneaky - KK vs LL', { link: `${MOCK}/files/round.m4a?v=youtube.com` });
    assert.equal((await progress(file.slug)).linkKind, 'file');
    for (const [link, kind] of [['https://youtu.be/aaaaaaaaaaa', 'youtube'], ['https://m.youtube.com/watch?v=aaaaaaaaaaa', 'youtube'], ['https://player.vimeo.com/video/1', 'vimeo']]) {
      const s = await ownSubmit(`Video ${kind} ${link.length} - MM vs NN`, { link });
      assert.equal(s.probe, 'video host, checked at ingest');
      assert.equal((await progress(s.slug)).linkKind, kind);
    }
  });
  await test('a host that never answers the link check is "could not be reached", within the deadline', async () => {
    const started = Date.now();
    const r = await call('POST', '/recordings', { token: owner, body: submission({ title: 'Hung - OO vs PP', link: `${MOCK}/files/hang-probe.m4a` }) });
    assert.equal(r.status, 400);
    assert.match(r.data.errors.link, /could not be reached/);
    assert.ok(Date.now() - started < 10_000, `took ${Date.now() - started}ms`);
  });
  await test('the Worker will not read an answer far larger than it asked for', async () => {
    const r = await call('GET', '/recordings/huge-record', { token: owner });
    assert.equal(r.status, 502, JSON.stringify(r.data).slice(0, 200));
  });
  await test('a malformed address or body is answered 4xx, not 500', async () => {
    assert.equal((await call('GET', '/rounds/%E0%A4%A/progress')).status, 404);
    assert.equal((await call('GET', '/admin/submissions/%E0%A4%A', { token: owner })).status, 404);
    assert.equal((await call('DELETE', '/admin/submissions/%E0%A4%A', { token: owner })).status, 404);
    assert.equal((await call('POST', '/admin/submissions/%E0%A4%A/retry', { token: owner })).status, 404);
    assert.equal((await call('POST', '/auth/session', { body: { mode: 'signin', email: 12345, password: 'whatever-123' } })).status, 400);
    assert.equal((await call('POST', '/auth/session', { body: null })).status, 400);
    assert.equal((await call('POST', '/events', { body: null })).status, 400);
    assert.equal((await call('POST', '/admin/proposals/x/resolve', { token: owner, body: null })).status, 400);
    assert.equal((await call('POST', '/me/notes', { token: ada, body: null })).status, 400);
  });
  await test('POST /events keeps no field at the length it arrived, and sign-up refuses an address longer than any can be', async () => {
    assert.equal((await call('POST', '/events', { body: { kind: 'round.view', slug: 's'.repeat(400_000) } })).status, 200);
    assert.equal((await call('POST', '/events', { body: { kind: 'round.view', slug: { not: 'a string' } } })).status, 200);
    const tail = await call('GET', '/admin/events?kind=round.view&limit=2', { token: owner });
    assert.deepEqual(tail.data.events.map(e => e.slug), [null, 's'.repeat(120)]);
    assert.equal((await signUp(`${'a'.repeat(300)}@example.com`, 'long-password', 'Long')).status, 400);
  });
  await test('admin list parameters out of range are clamped, and a doubled slash reaches the same route', async () => {
    for (const path of ['/admin/stats?days=abc', '/admin/events?limit=abc', '/admin/events?limit=-1&since=x&before=y', '/recordings/submissions?limit=abc']) {
      const r = await call('GET', path, { token: owner });
      assert.equal(r.status, 200, `${path} -> ${r.status} ${JSON.stringify(r.data).slice(0, 200)}`);
    }
    const all = await call('GET', '/admin/events?limit=-1', { token: owner });
    assert.equal(all.data.events.length, 1, 'a limit below one is one, not everything');
    const twice = await call('GET', `//rounds/${first.slug}/progress`);
    assert.equal(twice.status, 200);
    assert.equal(twice.data.slug, first.slug);
  });
  await test('submissions close together ask for one site build between them', async () => {
    sql(`DELETE FROM pipeline_state WHERE key = 'rebuild_requested_at';`);
    const builds = () => dispatched.filter(d => d.event_type === 'rounds-changed').length;
    const n = builds();
    const got = [];
    for (const t of ['Burst 1 - A vs B', 'Burst 2 - A vs B', 'Burst 3 - A vs B']) got.push((await ownSubmit(t)).rebuilding);
    assert.deepEqual(got, [true, false, false]);
    assert.equal(builds(), n + 1);
  });
  await test('one account may send in only so many rounds an hour, and a day; an admin is not counted', async () => {
    let refused = null;
    for (let i = 0; i < 25 && !refused; i++) {
      const r = await call('POST', '/recordings', { token: legacy, body: submission({ title: `Busy ${i} - A vs B` }) });
      if (r.status !== 201) refused = r;
    }
    assert.equal(refused?.status, 429, JSON.stringify(refused?.data));
    assert.match(refused.data.error, /at most 20 rounds in an hour/);
    assert.equal(refused.headers.get('retry-after'), '3600');
    // Two hours on, with forty more earlier in the day: the day's limit.
    const earlier = Math.floor(Date.now() / 1000) - 7200;
    sql(`UPDATE events SET created_at = ${earlier} WHERE user_id = 'u-legacy' AND kind IN ('recording.submitted', 'recording.resubmitted');
         WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 40)
         INSERT INTO events (kind, user_id, slug, payload, created_at) SELECT 'recording.submitted', 'u-legacy', NULL, '{}', ${earlier} FROM n;`);
    const day = await call('POST', '/recordings', { token: legacy, body: submission({ title: 'Busy late - A vs B' }) });
    assert.equal(day.status, 429, JSON.stringify(day.data));
    assert.match(day.data.error, /at most 60 rounds in a day/);
    await ownSubmit('Busy admin - A vs B');
  });
  await test('dispatches GitHub accepts with no run reported after them are said to be unanswered', async () => {
    assert.equal(await tick(), 200);
    const pipeline = async () => (await call('GET', '/admin/ingest/events?limit=1', { token: owner })).data.pipeline;
    let pipe = await pipeline();
    assert.ok(Math.abs(pipe.lastDispatchAt - Date.now() / 1000) < 60);
    assert.equal(pipe.dispatchUnanswered, false, 'a request just accepted is not overdue');
    // Forty-six minutes on, and the run has not reported since.
    sql(`UPDATE pipeline_state SET value = value - 2760 WHERE key = 'dispatch_unanswered_since';
         UPDATE ingest_events SET created_at = created_at - 2820 WHERE stage = 'run';`);
    pipe = await pipeline();
    assert.equal(pipe.dispatchUnanswered, true);
    const p = await progress(first.slug);
    assert.deepEqual(Object.keys(p.pipeline).sort(), ['dispatchUnanswered', 'lastDispatchAt', 'lastRunAt', 'stalled']);
    assert.equal(p.pipeline.dispatchUnanswered, true);
    assert.equal((await call('GET', '/admin/submissions?limit=1&records=0', { token: owner })).data.pipeline.dispatchUnanswered, true);
    // The run reports in.
    await call('POST', '/ingest/events', { token: INGEST_TOKEN, body: { events: [{ stage: 'run', state: 'started' }] } });
    assert.equal((await pipeline()).dispatchUnanswered, false);
  });

  // ── restarting from a stage ───────────────────────────────────────────────
  await test('retry with { from: "speeches" } clears the speeches and nothing before them', async () => {
    const s = restartRound = await ownSubmit('Restart - QQ vs RR');
    const att = (await pendingRow(s.objectID)).attempt;
    for (const [dir, ext] of [['audio', 'm4a'], ['peaks', 'json'], ['transcripts', 'json'], ['speeches', 'json']]) r2put(`${dir}/${s.slug}.${ext}`, '{}');
    assert.deepEqual((await report(s.objectID, { status: 'ingested', attempt: att, link: `${MOCK}/files/round.m4a` })).data, { ok: true });
    await call('POST', '/ingest/events', { token: INGEST_TOKEN, body: { events: [{ stage: 'speeches', state: 'started', slug: s.slug }] } });
    const n = dispatched.length;
    const r = await call('POST', `/admin/submissions/${s.objectID}/retry`, { token: owner, body: { from: 'speeches' } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual({ ok: r.data.ok, from: r.data.from, status: r.data.status, removed: r.data.removed, rebuilding: r.data.rebuilding },
      { ok: true, from: 'speeches', status: 'ingested', removed: [`speeches/${s.slug}.json`], rebuilding: true });
    const p = r.data.progress;
    assert.equal(p.id, s.objectID);
    assert.deepEqual(states(p), { submitted: 'done', audio: 'done', transcript: 'done', speeches: 'active', page: 'active' });
    assert.equal(p.stages[3].startedAt, null, 'what was reported before the restart belongs to the outputs it cleared');
    assert.ok(p.stages[3].expectedAt >= p.now + 1200 - 5, 'its clock starts at the restart');
    assert.ok(r2get(`transcripts/${s.slug}.json`) && r2get(`audio/${s.slug}.m4a`), 'nothing earlier is touched');
    assert.equal(await pendingRow(s.objectID), undefined, 'the audio is not queued again');
    assert.equal(dispatched.length, n + 1, 'the page is rebuilt');
  });
  await test('from "transcript": transcript and speeches go, the audio stays, and an old failure no longer shows', async () => {
    const s = restartRound;
    r2put(`speeches/${s.slug}.json`, '{}');
    r2put('index.json', JSON.stringify({ generated: 'x', playable: [s.slug], transcribed: [s.slug] }));
    await call('POST', '/ingest/events', { token: INGEST_TOKEN, body: { events: [{ stage: 'transcript', state: 'failed', slug: s.slug, note: 'old' }] } });
    const r = await call('POST', `/admin/submissions/${s.objectID}/retry`, { token: owner, body: { from: 'transcript' } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual(r.data.removed.sort(), [`speeches/${s.slug}.json`, `transcripts/${s.slug}.json`]);
    assert.deepEqual(states(r.data.progress), { submitted: 'done', audio: 'done', transcript: 'active', speeches: 'waiting', page: 'active' });
    assert.equal(r.data.progress.failure, null);
    assert.equal(r.data.progress.status, 'transcribing');
    assert.ok(r2get(`audio/${s.slug}.m4a`));
    assert.deepEqual(JSON.parse(r2get('index.json')), { generated: 'x', playable: [s.slug], transcribed: [] }, 'still playable, no longer transcribed');
    assert.equal(await pendingRow(s.objectID), undefined);
  });
  await test('from "page": a rebuild is asked for, and only a page built after it counts', async () => {
    const s = restartRound;
    r2put(`transcripts/${s.slug}.json`, '{}');
    r2put(`speeches/${s.slug}.json`, '{}');
    pages.set(s.slug, new Date());
    sql(`UPDATE submissions SET page_checked_at = NULL WHERE object_id = '${s.objectID}';`);
    assert.equal((await progress(s.slug)).status, 'published', 'the page built after the audio is there');
    await new Promise(r => setTimeout(r, 1100));
    const n = dispatched.length;
    const r = await call('POST', `/admin/submissions/${s.objectID}/retry`, { token: owner, body: { from: 'page' } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.deepEqual({ from: r.data.from, removed: r.data.removed, status: r.data.progress.status }, { from: 'page', removed: [], status: 'publishing' });
    assert.deepEqual(states(r.data.progress), { submitted: 'done', audio: 'done', transcript: 'done', speeches: 'done', page: 'active' });
    assert.equal(dispatched.length, n + 1);
    // The rebuild lands.
    pages.set(s.slug, new Date(Date.now() + 2000));
    sql(`UPDATE submissions SET page_checked_at = NULL WHERE object_id = '${s.objectID}';`);
    assert.equal((await progress(s.slug)).status, 'published');
  });
  await test('from "audio": everything goes and the round is queued again, as a new attempt', async () => {
    const s = restartRound;
    const r = await call('POST', `/admin/submissions/${s.objectID}/retry`, { token: owner, body: { from: 'audio' } });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    assert.equal(r.data.status, 'pending');
    assert.deepEqual(r.data.removed.sort(), ['audio', 'peaks', 'speeches', 'transcripts'].map(d => `${d}/${s.slug}.${d === 'audio' ? 'm4a' : 'json'}`).sort());
    assert.equal(r.data.progress.status, 'fetching');
    assert.deepEqual(r.data.progress.media, { audio: false, peaks: false, transcript: false, speeches: false });
    assert.ok(await pendingRow(s.objectID));
    assert.deepEqual(JSON.parse(r2get('index.json')).playable, []);
  });
  await test('a stage the round has not reached cannot be restarted (409), an unknown one is a 400, and no body is the old retry', async () => {
    const s = restartRound;
    for (const from of ['transcript', 'speeches', 'page']) {
      const r = await call('POST', `/admin/submissions/${s.objectID}/retry`, { token: owner, body: { from } });
      assert.equal(r.status, 409, `${from} -> ${r.status}`);
      assert.match(r.data.error, /has no (audio|transcript) yet/);
    }
    assert.equal((await call('POST', `/admin/submissions/${s.objectID}/retry`, { token: owner, body: { from: 'everything' } })).status, 400);
    assert.equal((await call('POST', `/admin/submissions/${lateRemoved.objectID}/retry`, { token: owner, body: { from: 'page' } })).status, 409);
    assert.deepEqual((await call('POST', `/admin/submissions/${s.objectID}/retry`, { token: owner, body: {} })).data, { ok: true, status: 'pending' });
    assert.deepEqual((await call('POST', `/admin/submissions/${s.objectID}/retry`, { token: owner })).data, { ok: true, status: 'pending' });
  });

  // ── prep ──────────────────────────────────────────────────────────────────
  section('prep access');
  await test('POST /admin/prep/grant by email and by user id; revoke; unknown accounts refused', async () => {
    assert.equal((await call('POST', '/admin/prep/grant', { token: owner, body: {} })).status, 400);
    assert.equal((await call('POST', '/admin/prep/grant', { token: owner, body: { email: 'nobody@example.com' } })).status, 404);
    assert.equal((await call('POST', '/admin/prep/grant', { token: owner, body: { userId: 'no-such-id' } })).status, 404);
    const byEmail = await call('POST', '/admin/prep/grant', { token: owner, body: { email: ' ADA@example.com ' } });
    assert.deepEqual(byEmail.data, { ok: true, user: { id: adaId, email: 'ada@example.com', display_name: 'Ada', prep_access: true } });
    const byId = await call('POST', '/admin/prep/grant', { token: owner, body: { userId: 'u-legacy' } });
    assert.equal(byId.data.user.prep_access, true);
    assert.equal((await call('GET', '/me', { token: ada })).data.prep, true);
    assert.equal((await signIn('ada@example.com', 'ada-password')).data.prep, true);
    const listed = await call('GET', '/admin/users?prep=1', { token: owner });
    assert.deepEqual(listed.data.users.map(u => u.email).sort(), ['ada@example.com', 'legacy@example.com']);
    const off = await call('POST', '/admin/prep/revoke', { token: owner, body: { userId: 'u-legacy' } });
    assert.equal(off.data.user.prep_access, false);
    assert.equal((await call('GET', '/me', { token: legacy })).data.prep, false);
  });
  await test('GET /prep/key: 403 with a reason for the signed-out and the not-allowed', async () => {
    const out = await call('GET', '/prep/key');
    assert.equal(out.status, 403);
    assert.equal(out.data.reason, 'signed_out');
    const expired = await call('GET', '/prep/key', { token: 'not-a-session' });
    assert.deepEqual({ status: expired.status, reason: expired.data.reason }, { status: 403, reason: 'signed_out' });
    const no = await call('GET', '/prep/key', { token: legacy });
    assert.deepEqual({ status: no.status, reason: no.data.reason }, { status: 403, reason: 'not_allowed' });
    assert.equal(no.data.key, undefined);
  });
  await test('GET /prep/key: a secured key for one index, a few hours, carrying the user id', async () => {
    const r = await call('GET', '/prep/key', { token: ada });
    assert.equal(r.status, 200);
    assert.deepEqual(Object.keys(r.data).sort(), ['appId', 'indexName', 'key', 'validUntil']);
    assert.deepEqual({ appId: r.data.appId, indexName: r.data.indexName }, { appId: 'TESTAPP', indexName: PREP_INDEX });
    const ttl = r.data.validUntil - Date.now() / 1000;
    assert.ok(ttl > 4 * 3600 - 60 && ttl <= 4 * 3600 + 5, `valid for ${ttl}s`);

    const decoded = Buffer.from(r.data.key, 'base64').toString();
    const mac = decoded.slice(0, 64);
    const params = decoded.slice(64);
    assert.match(mac, /^[0-9a-f]{64}$/);
    assert.equal(mac, createHmac('sha256', PREP_PARENT_KEY).update(params).digest('hex'), 'HMAC-SHA256 of the restrictions under the parent key');
    const q = new URLSearchParams(params);
    assert.deepEqual([...q.keys()], ['restrictIndices', 'userToken', 'validUntil']);
    assert.equal(q.get('restrictIndices'), PREP_INDEX);
    assert.equal(q.get('userToken'), adaId);
    assert.equal(Number(q.get('validUntil')), r.data.validUntil);
    assert.ok(!r.data.key.includes(PREP_PARENT_KEY) && !decoded.includes(PREP_PARENT_KEY), 'the parent key is not in it');
    assert.equal(r.headers.get('cache-control'), 'no-store');

    if (process.env.ALGOLIASEARCH) {
      const { algoliasearch } = await import(pathToFileURL(process.env.ALGOLIASEARCH).href);
      const theirs = algoliasearch('TESTAPP', PREP_PARENT_KEY).generateSecuredApiKey({
        parentApiKey: PREP_PARENT_KEY,
        restrictions: { restrictIndices: [PREP_INDEX], userToken: adaId, validUntil: r.data.validUntil },
      });
      assert.equal(r.data.key, theirs, 'byte for byte what Algolia\'s own client generates');
      console.log('        (matches algoliasearch.generateSecuredApiKey)');
    }
  });
  await test('an admin gets a prep key without being granted; a revoked account stops getting one', async () => {
    assert.equal((await call('GET', '/prep/key', { token: machine })).status, 200);
    await call('POST', '/admin/prep/revoke', { token: owner, body: { email: 'ada@example.com' } });
    assert.equal((await call('GET', '/prep/key', { token: ada })).status, 403);
  });

  // ── the ingest scripts themselves, against this Worker ────────────────────
  section('the ingest scripts (scripts/ingest), run for real against this Worker');
  const REPO = join(WORKER, '..');
  const TSX = join(REPO, 'node_modules', '.bin', 'tsx');
  const haveFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;
  if (!existsSync(TSX) || !haveFfmpeg) {
    console.log(`  SKIPPED: ${!existsSync(TSX) ? 'no node_modules at the repo root (pnpm install)' : 'no ffmpeg'}`);
  } else {
    // The tools the scripts shell out to, each replaced by a few lines that
    // behave the way the real one does in the case being tested.
    const bin = join(STATE, 'bin');
    mkdirSync(bin);
    const tool = (name, script) => { writeFileSync(join(bin, name), `#!/bin/sh\n${script}\n`); chmodSync(join(bin, name), 0o755); };
    tool('yt-dlp', `echo "WARNING: [youtube] Falling back to generic n function search" >&2
echo "ERROR: [youtube] aaaaaaaaaaa: Sign in to confirm you're not a bot. Use --cookies-from-browser or --cookies for the authentication." >&2
exit 1`);
    tool('az', `echo "$@" >> "$FAKE_AZ_LOG"
case "$*" in
  "account show"*) if [ -n "$FAKE_AZ_SIGNED_OUT" ]; then echo "ERROR: Please run 'az login' to setup account." >&2; exit 1; fi;;
  *"execution list"*) echo 0;;
  *"job start -n gt-broken"*) echo "ERROR: (ContainerAppJobNotFound) The job gt-broken was not found." >&2; exit 1;;
esac
exit 0`);
    // The fitter is not this suite's to test, and reaches the real bucket. Its
    // stand-in fits every round it is given except ones named "nofit".
    tool('npx', `if [ "$2" = "scripts/segment/run.ts" ]; then
  echo "fitting (stand-in): $SLUGS"
  for s in $SLUGS; do
    case "$s" in *nofit*) continue;; esac
    curl -s -X PUT --data '{"speeches":[]}' "$CLOUDFLARE_S3_ENDPOINT/goldenturn-media/speeches/$s.json" > /dev/null
  done
  exit 0
fi
exec "$REAL_NPX" "$@"`);
    const realNpx = execFileSync('sh', ['-c', 'command -v npx'], { encoding: 'utf8' }).trim();
    const azLog = join(STATE, 'az.log');
    const ingestEnv = {
      ...env,
      PATH: `${bin}:${env.PATH}`,
      REAL_NPX: realNpx,
      FAKE_AZ_LOG: azLog,
      GT_API: API,
      GT_ADMIN_TOKEN: INGEST_TOKEN,
      CLOUDFLARE_ACCOUNT_ID: 'stand-in', CLOUDFLARE_S3_KEY: 'stand-in', CLOUDFLARE_S3_SECRET: 'stand-in',
      CLOUDFLARE_S3_ENDPOINT: MOCK,
      TX_JOBS: 'gt-ok',
    };
    delete ingestEnv.GITHUB_ACTIONS;
    delete ingestEnv.GITHUB_OUTPUT;
    // Not spawnSync: the scripts talk to the stand-in server, which lives in
    // this process and cannot answer while it is blocked waiting for them.
    const runScript = (script, over = {}) => new Promise(done => {
      const e = { ...ingestEnv, ...over };
      for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k];
      const child = spawn(TSX, [join('scripts', 'ingest', script)], { cwd: REPO, env: e, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      child.stdout.on('data', d => { out += d; });
      child.stderr.on('data', d => { out += d; });
      const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
      child.on('exit', status => { clearTimeout(timer); done({ status, out }); });
    });

    // Five minutes and ten seconds of tone: the shortest thing the ingest
    // will accept as a round.
    const tone = join(STATE, 'tone.m4a');
    execFileSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=330:duration=310',
      '-ac', '1', '-c:a', 'aac', '-b:a', '24k', tone]);
    realRound = readFileSync(tone);

    // Everything still pending from the tests above would be fetched too.
    sql(`UPDATE submissions SET review = 'removed' WHERE status = 'pending';`);
    const submit = async over => {
      const r = await call('POST', '/recordings', { token: ada, body: submission(over) });
      assert.equal(r.status, 201, JSON.stringify(r.data));
      return r.data;
    };
    const good = await submit({ title: 'Finals - Ingest AA vs Test BB', link: `${MOCK}/files/real-round.m4a` });
    const video = await submit({ title: 'Semis - Ingest CC vs Test DD', link: 'https://www.youtube.com/watch?v=aaaaaaaaaaa' });
    const junk = await submit({ title: 'Quarters - Ingest EE vs Test FF', link: `${MOCK}/files/not-a-recording.m4a` });
    const detail = async sub => (await call('GET', `/admin/submissions/${sub.objectID}`, { token: owner })).data.submission;
    const ingestLog = async () => (await call('GET', '/admin/ingest/events?limit=500', { token: owner })).data.events;

    await test('drain-submissions.ts refuses to start when its token is wrong, or missing on a runner', async () => {
      const wrong = await runScript('drain-submissions.ts', { GT_ADMIN_TOKEN: 'not-the-ingest-token' });
      assert.equal(wrong.status, 2, wrong.out);
      assert.match(wrong.out, /GT_ADMIN_TOKEN is refused by the API/);
      const none = await runScript('drain-submissions.ts', { GT_ADMIN_TOKEN: undefined, GITHUB_ACTIONS: 'true' });
      assert.equal(none.status, 2, none.out);
      assert.match(none.out, /GT_ADMIN_TOKEN is not set/);
      assert.equal(bucket.size, 0, 'nothing was fetched or uploaded');
      assert.equal((await call('GET', '/recordings/pending')).data.pending.length, 3, 'the queue is untouched');
    });
    await test('drain-submissions.ts: a real file is transcoded, uploaded and reported ingested', async () => {
      const r = await runScript('drain-submissions.ts');
      assert.equal(r.status, 0, r.out);
      assert.match(r.out, /ingested 1 of 3/);
      assert.ok(bucket.get(`audio/${good.slug}.m4a`).length > 500_000, 'the audio is in the bucket');
      const peaks = JSON.parse(bucket.get(`peaks/${good.slug}.json`).toString());
      assert.ok(peaks.duration >= 300 && peaks.peaks.length === 3000);
      const d = await detail(good);
      assert.deepEqual({ status: d.status, note: d.note, attempts: d.attempts }, { status: 'ingested', note: null, attempts: 1 });
      assert.deepEqual(d.events.map(e => `${e.stage}:${e.state}`), ['audio:done', 'audio:started', 'audio:queued']);
    });
    await test('a failed fetch is stored as what the tool said, not the command that was run', async () => {
      const yt = await detail(video);
      assert.equal(yt.status, 'failed');
      assert.equal(yt.note, "ERROR: [youtube] aaaaaaaaaaa: Sign in to confirm you're not a bot. Use --cookies-from-browser or --cookies for the authentication.");
      assert.match(yt.progress.failure.reason, /without signing in/);
      const bad = await detail(junk);
      assert.equal(bad.status, 'failed');
      assert.match(bad.note, /Invalid data found when processing input/);
      assert.doesNotMatch(bad.note, /Command failed|-movflags/);
      assert.match(bad.progress.failure.reason, /could not be read as audio or video/);
      assert.deepEqual(bad.events.map(e => `${e.stage}:${e.state}`), ['audio:failed', 'audio:started', 'audio:queued']);
    });
    await test('auto.ts: one run reports in, pulls audio, starts transcription, fits speeches and publishes the index', async () => {
      bucket.set('transcripts/fit-ok-aaaaaa.json', Buffer.from('{"segments":[]}'));
      bucket.set('transcripts/nofit-bbbbbb.json', Buffer.from('{"segments":[]}'));
      const late = await submit({ title: 'Doubles - Ingest GG vs Test HH', link: 'https://vimeo.com/123456789' });
      const output = join(STATE, 'github-output');
      writeFileSync(output, '');
      const r = await runScript('auto.ts', { GITHUB_OUTPUT: output });
      assert.equal(r.status, 0, r.out);
      assert.equal(readFileSync(output, 'utf8'), 'changed=true\n', 'the workflow is told to rebuild');
      assert.equal((await detail(late)).status, 'failed', 'the pending round was taken by the audio step');

      // Transcription: the one playable round with no transcript, handed to the idle job.
      const az = readFileSync(azLog, 'utf8');
      assert.match(az, new RegExp(`job update -n gt-ok -g thava --set-env-vars SLUGS=${good.slug} `));
      assert.match(az, /job start -n gt-ok/);
      // Speeches: only the rounds that needed fitting were handed to the fitter.
      assert.match(r.out, /fitting \(stand-in\): fit-ok-aaaaaa nofit-bbbbbb\n/);
      assert.ok(bucket.has('speeches/fit-ok-aaaaaa.json'));
      const index = JSON.parse(bucket.get('index.json').toString());
      assert.deepEqual({ playable: index.playable, transcribed: index.transcribed },
        { playable: [good.slug], transcribed: ['fit-ok-aaaaaa', 'nofit-bbbbbb'] });

      const said = (await ingestLog()).map(e => `${e.stage}:${e.state}:${e.slug ?? ''}:${e.note ?? ''}`);
      for (const want of [
        'run:started::',
        `transcript:started:${good.slug}:gt-ok`,
        'speeches:started:fit-ok-aaaaaa:', 'speeches:started:nofit-bbbbbb:',
        'speeches:failed:nofit-bbbbbb:the fitter produced no timings',
        'index:done::',
        'run:done::audio for 1 submitted; transcription started for 1; speeches for 1',
      ]) assert.ok(said.includes(want), `the run did not report ${want}\n${said.slice(0, 14).join('\n')}`);
      assert.ok(!said.includes('speeches:failed:fit-ok-aaaaaa:the fitter produced no timings'));

      const p = await progress(good.slug);
      assert.ok(Date.now() / 1000 - p.pipeline.lastRunAt < 60, 'the run was heard from');
      assert.equal(p.pipeline.stalled, false);
    });
    await test('auto.ts says why transcription did not start: not signed in to Azure, then a job that will not start', async () => {
      const out = await runScript('auto.ts', { FAKE_AZ_SIGNED_OUT: '1' });
      assert.equal(out.status, 0, out.out);
      assert.match(out.out, /not signed in to Azure, so no transcription job can be started/);
      let said = (await ingestLog()).map(e => `${e.stage}:${e.state}:${e.slug ?? ''}:${e.note ?? ''}`);
      assert.ok(said.includes(`transcript:skipped:${good.slug}:not signed in to Azure`));

      const broken = await runScript('auto.ts', { TX_JOBS: 'gt-broken' });
      assert.equal(broken.status, 0, broken.out);
      said = (await ingestLog()).map(e => `${e.stage}:${e.state}:${e.slug ?? ''}:${e.note ?? ''}`);
      assert.ok(said.some(l => l.startsWith(`transcript:failed:${good.slug}:gt-broken could not be started: ERROR: (ContainerAppJobNotFound)`)), said.slice(0, 6).join('\n'));
    });
    await test('auto.ts ends in error, having done nothing, when the API refuses its token', async () => {
      await submit({ title: 'Triples - Ingest II vs Test JJ', link: `${MOCK}/files/real-round.m4a` });
      const before = bucket.size;
      const r = await runScript('auto.ts', { GT_ADMIN_TOKEN: 'not-the-ingest-token' });
      assert.equal(r.status, 1, r.out);
      assert.match(r.out, /finished with problems: GT_ADMIN_TOKEN is refused by the API; pulling audio/);
      assert.equal(bucket.size, before, 'no audio was pulled that could not be reported');
      assert.equal((await call('GET', '/recordings/pending')).data.pending.length, 1);
    });
    await test('the next run with the right token takes that round, and reports its page as started', async () => {
      const r = await runScript('auto.ts');
      assert.equal(r.status, 0, r.out);
      const left = (await call('GET', '/admin/submissions?q=triples&records=0', { token: owner })).data.submissions[0];
      assert.equal(left.status, 'ingested');
      assert.ok(bucket.has(`audio/${left.slug}.m4a`));
      const said = (await ingestLog()).map(e => `${e.stage}:${e.state}:${e.slug ?? ''}`);
      assert.ok(said.includes(`page:started:${left.slug}`));
      assert.ok(JSON.parse(bucket.get('index.json').toString()).playable.includes(left.slug));
    });
    const submitAsOwner = async over => {
      const r = await call('POST', '/recordings', { token: owner, body: submission(over) });
      assert.equal(r.status, 201, JSON.stringify(r.data));
      return r.data;
    };
    await test('the ingest scripts are started with an explicit environment, and a .env cannot add to it', async () => {
      const ours = new Set([...SYSTEM_VARS, 'WRANGLER_SEND_METRICS', 'CI', 'DOTENV_CONFIG_PATH', 'REAL_NPX', 'FAKE_AZ_LOG', 'GT_API',
        'GT_ADMIN_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_S3_KEY', 'CLOUDFLARE_S3_SECRET', 'CLOUDFLARE_S3_ENDPOINT', 'TX_JOBS']);
      assert.deepEqual(Object.keys(ingestEnv).filter(k => !ours.has(k)), [], 'nothing of the caller\'s but the system paths');
      // A .env where a script is run from, as the repo's own would be.
      const dir = mkdtempSync(join(STATE, 'dotenv-'));
      writeFileSync(join(dir, '.env'), 'CLOUDFLARE_API_TOKEN=from-a-real-env\nGT_DOTENV_MARKER=loaded\n');
      const config = pathToFileURL(join(REPO, 'node_modules', 'dotenv', 'config.js')).href;
      const probe = spawnSync(process.execPath, ['--input-type=module', '-e',
        `await import(${JSON.stringify(config)}); console.log('read:', process.env.GT_DOTENV_MARKER ?? 'nothing', process.env.CLOUDFLARE_API_TOKEN ?? 'nothing')`],
        { cwd: dir, env: ingestEnv, encoding: 'utf8' });
      assert.match(probe.stdout, /read: nothing nothing/, probe.stdout + probe.stderr);
    });
    await test('a link that only mentions youtube.com is downloaded as a file, not handed to yt-dlp', async () => {
      const s = await submitAsOwner({ title: 'Mentions - Ingest OO vs Test PP', link: `${MOCK}/files/real-round.m4a?from=youtube.com` });
      const r = await runScript('drain-submissions.ts');
      assert.equal(r.status, 0, r.out);
      assert.equal((await detail(s)).status, 'ingested', r.out);
      assert.ok(bucket.has(`audio/${s.slug}.m4a`));
    });
    await test('a link that stops sending, or never stops, fails that round with a plain reason, and the run goes on', async () => {
      const hang = await submitAsOwner({ title: 'Hang - Ingest QQ vs Test RR', link: `${MOCK}/files/hang.m4a` });
      const endless = await submitAsOwner({ title: 'Endless - Ingest SS vs Test TT', link: `${MOCK}/files/endless.m4a` });
      const started = Date.now();
      const r = await runScript('drain-submissions.ts', { GT_STALL_LIMIT_S: '2', GT_STEP_LIMIT_S: '30', GT_MAX_DOWNLOAD_MB: '1' });
      assert.equal(r.status, 0, r.out);
      assert.ok(Date.now() - started < 60_000, `took ${Date.now() - started}ms`);
      const h = await detail(hang);
      assert.equal(h.status, 'failed');
      assert.match(h.note, /download stalled: nothing arrived for 2 seconds/);
      assert.match(h.progress.failure.reason, /stalled or took far too long/);
      const e = await detail(endless);
      assert.equal(e.status, 'failed');
      assert.match(e.note, /larger than 1MB/);
      assert.match(e.progress.failure.reason, /too large to be one round/);
    });
    await test('a step that runs past its limit is stopped, and a run out of time leaves the rest for the next one', async () => {
      const slow = await submitAsOwner({ title: 'Slow - Ingest UU vs Test VV', link: `${MOCK}/files/hang.m4a` });
      const later = await submitAsOwner({ title: 'Later - Ingest WW vs Test XX', link: `${MOCK}/files/real-round.m4a` });
      const r = await runScript('drain-submissions.ts', { GT_STALL_LIMIT_S: '30', GT_STEP_LIMIT_S: '2', GT_RUN_BUDGET_S: '1' });
      assert.equal(r.status, 0, r.out);
      assert.match(r.out, /1 not started, out of time for this run/);
      const s = await detail(slow);
      assert.deepEqual({ status: s.status, note: s.note }, { status: 'failed', note: 'download took longer than 2 seconds' });
      assert.equal((await detail(later)).status, 'pending');
      assert.equal((await call('DELETE', `/admin/submissions/${later.objectID}`, { token: owner })).status, 200);
    });
    await test('a round restarted from "transcript" keeps its audio: the next run transcribes it and does not fetch it again', async () => {
      // The Worker's bucket and the stand-in are two stores here; in production
      // they are one, so what is in one is put in the other.
      bucket.set(`transcripts/${good.slug}.json`, Buffer.from('{"segments":[]}'));
      bucket.set(`speeches/${good.slug}.json`, Buffer.from('{"speeches":[]}'));
      for (const key of [`audio/${good.slug}.m4a`, `transcripts/${good.slug}.json`, `speeches/${good.slug}.json`]) r2put(key, bucket.get(key));
      const audioBefore = bucket.get(`audio/${good.slug}.m4a`);
      const r = await call('POST', `/admin/submissions/${good.objectID}/retry`, { token: owner, body: { from: 'transcript' } });
      assert.equal(r.status, 200, JSON.stringify(r.data));
      assert.deepEqual({ status: r.data.status, progress: r.data.progress.status }, { status: 'ingested', progress: 'transcribing' });
      for (const key of r.data.removed) bucket.delete(key);
      assert.ok(!bucket.has(`transcripts/${good.slug}.json`));

      writeFileSync(azLog, '');
      const mark = mockLog.length;
      const run = await runScript('auto.ts');
      assert.equal(run.status, 0, run.out);
      assert.doesNotMatch(run.out, /pulling audio/);
      assert.ok(!mockLog.slice(mark).some(l => l.includes('/files/real-round.m4a')), 'the audio was not fetched again');
      assert.equal(bucket.get(`audio/${good.slug}.m4a`), audioBefore, 'the same audio, untouched');
      assert.match(readFileSync(azLog, 'utf8'), new RegExp(`--set-env-vars SLUGS=[^\\n]*${good.slug}`), 'handed to transcription');
    });
    await test('a transcript the fitter cannot fit does not make every run rebuild the site', async () => {
      const output = join(STATE, 'github-output-unfitted');
      writeFileSync(output, '');
      const r = await runScript('auto.ts', { GITHUB_OUTPUT: output });
      assert.equal(r.status, 0, r.out);
      assert.match(r.out, /fitting \(stand-in\): nofit-bbbbbb\n/);
      assert.equal(readFileSync(output, 'utf8'), '', 'no rebuild asked for');
      assert.match(r.out, /nothing to do/);
    });
  }

  section('the rest still stands');
  await test('CORS preflight, unknown routes and the health check are unchanged', async () => {
    const pre = await fetch(`${API}/admin/users`, { method: 'OPTIONS', headers: { Origin: 'https://goldenturn.org' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), 'https://goldenturn.org');
    assert.equal((await call('GET', '/nope')).status, 404);
    const health = await call('GET', '/health');
    assert.deepEqual(health.data, { ok: true, users: 6 });
  });
} finally {
  await stopWorker();
  for (const r of hanging) r.destroy();
  mock.closeAllConnections();
  mock.close();
  rmSync(STATE, { recursive: true, force: true });
}

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  failed: ${f}`);
  process.exit(1);
}
