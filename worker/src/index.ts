/**
 * API for accounts, transcript corrections, votes, notes and tags.
 *
 * Reading is anonymous. Proposing and voting require a session, because
 * reputation only means something when identities are stable and one person
 * cannot vote a proposal through on their own.
 */

export interface Env {
  DB: D1Database;
  MEDIA: R2Bucket;
  SESSION_TTL_DAYS: string;
  ALLOWED_ORIGINS: string;
  ADMIN_EMAIL: string;
  /** Server-side Algolia write key, so the browser never carries one. */
  ALGOLIA_APP_ID: string;
  ALGOLIA_ADMIN_KEY: string;
  ALGOLIA_INDEX: string;
  /** Lets the unattended onboarding run report ingest status. */
  INGEST_TOKEN: string;
  /**
   * Lets the cron trigger start the onboarding run, and an edit ask GitHub to
   * rebuild the site. Without it an edit still lands and waits for the next
   * deploy to reach the round's page, but nothing starts the run: submitted
   * rounds wait until somebody starts it by hand.
   */
  GITHUB_DISPATCH_TOKEN?: string;
  GITHUB_REPO?: string;
  /**
   * Authorises POST /admin/bootstrap, the one way an account becomes an admin.
   * Unset, that endpoint is closed, which is how it should sit between uses.
   */
  ADMIN_BOOTSTRAP_SECRET?: string;
  /**
   * The prep index's search-only key. Never sent anywhere: each key handed to
   * a browser is derived from it, limited to the one index and a few hours.
   */
  ALGOLIA_PREP_KEY?: string;
  ALGOLIA_PREP_INDEX?: string;
  /** Where the built site and the bucket are served, to ask what exists. */
  SITE_URL?: string;
  MEDIA_URL?: string;
  /**
   * How many rounds one account may send in, per hour and per day. Each one
   * writes a public search record and queues a download, so an account that
   * posts in a loop is a cost to everyone. Admins are not counted.
   */
  SUBMISSIONS_PER_HOUR?: string;
  SUBMISSIONS_PER_DAY?: string;
  /**
   * Lets the Worker empty the media domain's cache of a file it has just
   * deleted. Without the token nothing is purged, and a removed round's audio
   * can still be served from the edge until it ages out.
   */
  MEDIA_ZONE_ID?: string;
  CACHE_PURGE_TOKEN?: string;
  /** Tests only: send search-index, GitHub and Cloudflare calls to a stand-in. */
  ALGOLIA_HOST?: string;
  GITHUB_API?: string;
  CLOUDFLARE_API?: string;
  /** Tests only: a shorter deadline for every outbound request. */
  FETCH_TIMEOUT_MS?: string;
}

const ACCEPT_THRESHOLD = 5;
// The two labels a round is filtered by. Kept in step with src/lib/prefs.ts.
const FORMATS = ['parli', 'policy'];
const LEVELS = ['college', 'hs'];
// Workers cap PBKDF2 at 100k iterations; requesting more throws at runtime.
const PBKDF2_ITERATIONS = 100_000;
// How stale "last seen" may be. Every signed-in request reads the session; this
// keeps it from also being a write.
const SEEN_EVERY_S = 300;
// A run is due every fifteen minutes. Two hours without one is not lateness.
const STALLED_AFTER_S = 2 * 3600;
// How long a round's page is taken to still be missing before asking again.
const PAGE_RECHECK_S = 60;
const PREP_KEY_TTL_S = 4 * 3600;
// A dispatch GitHub accepted is only a request. A run that has not reported
// in this long after one was accepted is a run that did not start.
const UNANSWERED_AFTER_S = 45 * 60;
// Submissions inside this long of a rebuild request share it. The rounds
// they leave out are pending, so the next ingest run builds them anyway.
const REBUILD_COALESCE_S = 10 * 60;
const SUBMISSIONS_PER_HOUR = 20;
const SUBMISSIONS_PER_DAY = 60;
// Every request the Worker makes has a deadline and a ceiling on what it will
// read back: a host that answers slowly or at length is not allowed to hold a
// request open, or to fill the Worker's memory.
const FETCH_TIMEOUT_MS = 10_000;
const ONE_RECORD_BYTES = 1_000_000;
const MANY_RECORDS_BYTES = 16_000_000;
// The longest an address can be (RFC 5321), and the longest slug an event may
// carry; nothing anonymous is stored at whatever length it arrives.
const EMAIL_MAX = 254;
const EVENT_SLUG_MAX = 120;
/**
 * How long each step usually takes once it is able to start, and how long
 * before its not having finished is worth somebody's attention.
 *
 * Reckoned from how the run is scheduled rather than measured: it comes round
 * every fifteen minutes, pulls audio and rebuilds the site in the same pass,
 * hands transcription to a GPU job that a later pass collects, and marks the
 * speeches on the pass after that. Kept here, in one place, so the pages do
 * not each invent a threshold of their own.
 */
const STAGE_PACE: Record<string, { typical: number; stuck: number }> = {
  audio: { typical: 20 * 60, stuck: 2 * 3600 },
  transcript: { typical: 60 * 60, stuck: 6 * 3600 },
  speeches: { typical: 20 * 60, stuck: 2 * 3600 },
  page: { typical: 15 * 60, stuck: 2 * 3600 },
};

function b64(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)));
}

function unb64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}

/** PBKDF2-SHA256 with a per-user salt; the parameters travel with the hash. */
async function derive(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' }, key, 256,
  );
  return b64(bits);
}

async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, PBKDF2_ITERATIONS);
  return `${PBKDF2_ITERATIONS}:${b64(salt.buffer)}:${hash}`;
}

async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [iterStr, saltStr, expected] = stored.split(':');
  if (!iterStr || !saltStr || !expected) return false;
  const actual = await derive(password, unb64(saltStr), Number(iterStr));
  // Constant-time compare so a wrong password cannot be narrowed by timing.
  if (actual.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

interface User {
  id: string;
  email: string;
  display_name: string;
  rep: number;
  is_admin: number;
  prep_access: number;
}

/** The account as a page may see it. The flags travel beside it, not in it. */
function publicUser(u: User) {
  return { id: u.id, email: u.email, display_name: u.display_name, rep: u.rep };
}

/** Constant-time, so a wrong secret cannot be narrowed by how fast it fails. */
function sameSecret(given: string, expected: string | undefined): boolean {
  if (!expected || given.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < given.length; i++) diff |= given.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function bearerOf(req: Request): string {
  return (req.headers.get('Authorization') ?? '').replace(/^Bearer /, '');
}

function cors(origin: string | null, allowed: string[]): Record<string, string> {
  const ok = origin && allowed.includes(origin) ? origin : allowed[0];
  return {
    'Access-Control-Allow-Origin': ok,
    // PATCH included: an edit from the admin page is a PATCH, and a method
    // missing from this list is refused at the preflight, before the handler
    // it would have reached ever runs.
    'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Credentials': 'true',
    Vary: 'Origin',
  };
}

function json(body: unknown, init: ResponseInit = {}, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...headers, ...(init.headers ?? {}) },
  });
}

function id(): string {
  return crypto.randomUUID();
}

function now(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * A request's JSON body as an object. No body, a body that is not JSON, and
 * one that is JSON but not an object (null, a list, a number) all read as an
 * empty object, so a handler that destructures it cannot be made to throw.
 */
async function bodyOf<T = Record<string, unknown>>(req: Request): Promise<T> {
  const v = await req.json().catch(() => null);
  return (v && typeof v === 'object' && !Array.isArray(v) ? v : {}) as T;
}

/** A path segment as it was meant, or null when its escapes are malformed. */
function segment(url: URL, n: number): string | null {
  try {
    return decodeURIComponent(url.pathname.split('/')[n] ?? '');
  } catch {
    return null;
  }
}

/**
 * A request to somewhere else, with a deadline.
 *
 * Nothing the Worker asked of another host had one, so a host that accepted
 * the connection and then said nothing held the request open until the
 * platform gave up on it. Past the deadline the fetch rejects, and every
 * caller already treats a rejection as "could not be reached".
 */
function outbound(env: Env, url: string, init: RequestInit = {}): Promise<Response> {
  const ms = Number(env.FETCH_TIMEOUT_MS) || FETCH_TIMEOUT_MS;
  return fetch(url, { ...init, signal: AbortSignal.timeout(ms) });
}

/** A response's body read whole, unless it is longer than `max` bytes. */
async function textWithin(res: Response, max: number): Promise<string> {
  if (Number(res.headers.get('content-length') ?? 0) > max) {
    await res.body?.cancel();
    throw new Error(`the answer was larger than ${max} bytes`);
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel();
      throw new Error(`the answer was larger than ${max} bytes`);
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { all.set(c, at); at += c.byteLength; }
  return new TextDecoder().decode(all);
}

async function jsonWithin<T>(res: Response, max: number): Promise<T> {
  return JSON.parse(await textWithin(res, max)) as T;
}

/**
 * Whether a query failed because the database is behind the code: a column
 * or table this deploy reads that the migrations for it have not added yet.
 */
function schemaBehind(e: unknown): boolean {
  return /no such (column|table)|has no column named/i.test(String((e as Error)?.message ?? e));
}

let warnedSchema = false;
/**
 * Runs the query this code was written for, and if the database has not been
 * migrated to it yet, the one the previous deploy ran instead.
 *
 * The Worker deployed ahead of its migrations used to answer 500 to every
 * signed-in request and every sign-in, because reading the session reads the
 * new admin flag. The deploy script now applies the migrations first; this is
 * for when that order is got wrong anyway, so the site keeps its sign-in
 * while somebody notices. It says so in the log, once per isolate.
 */
async function tolerant<T>(fresh: () => Promise<T>, old: () => Promise<T>): Promise<T> {
  try {
    return await fresh();
  } catch (e) {
    if (!schemaBehind(e)) throw e;
    if (!warnedSchema) {
      warnedSchema = true;
      console.error(`the database is behind this deploy (${String((e as Error)?.message ?? e)}); `
        + 'falling back to the previous queries. Run: wrangler d1 migrations apply goldenturn --remote');
    }
    return old();
  }
}

async function currentUser(req: Request, env: Env): Promise<User | null> {
  const auth = req.headers.get('Authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;

  // Before migration 0007 there is no admin flag, no prep flag and no "last
  // seen". The fallback reads the account the way the previous deploy did,
  // with both flags off: not being an admin until the migration runs is the
  // safe way to be wrong, and nobody is signed out.
  const row = await tolerant(
    () => env.DB.prepare(
      `SELECT u.id, u.email, u.display_name, u.rep, u.is_admin, u.prep_access,
              s.last_seen_at AS seen
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token = ?1 AND s.expires_at > ?2`
    ).bind(token, now()).first<User & { seen: number | null }>(),
    () => env.DB.prepare(
      `SELECT u.id, u.email, u.display_name, u.rep, 0 AS is_admin, 0 AS prep_access,
              ?2 AS seen
         FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token = ?1 AND s.expires_at > ?2`
    ).bind(token, now()).first<User & { seen: number | null }>(),
  );
  if (!row) return null;

  const { seen, ...user } = row;
  if (!seen || seen < now() - SEEN_EVERY_S) {
    await env.DB.batch([
      env.DB.prepare(`UPDATE sessions SET last_seen_at = ?1 WHERE token = ?2`).bind(now(), token),
      env.DB.prepare(`UPDATE users SET last_seen_at = ?1 WHERE id = ?2`).bind(now(), user.id),
    ]);
  }
  return user;
}

async function logEvent(env: Env, kind: string, userId: string | null, slug: string | null, payload: unknown) {
  await env.DB.prepare(
    `INSERT INTO events (kind, user_id, slug, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5)`
  ).bind(kind, userId, slug, JSON.stringify(payload ?? {}), now()).run();
}

/**
 * Promotes a proposal and writes the revision, which is what readers actually
 * see. The vote threshold, an admin's resolve and an admin's own edit all land
 * here so there is one definition of what acceptance does.
 */
async function acceptProposal(env: Env, proposal: any) {
  await env.DB.batch([
    env.DB.prepare(`UPDATE proposals SET status = 'accepted' WHERE id = ?1`).bind(proposal.id),
    env.DB.prepare(
      `INSERT INTO revisions (id, slug, kind, anchor, value, proposal_id, applied_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
    ).bind(id(), proposal.slug, proposal.kind, proposal.anchor, proposal.proposed, proposal.id, now()),
    // Reputation follows accepted work, not raw activity.
    env.DB.prepare(`UPDATE users SET rep = rep + 10 WHERE id = ?1`).bind(proposal.user_id),
  ]);
}

/**
 * Recomputes a proposal's score and promotes it once the margin clears the
 * threshold.
 */
async function settleProposal(env: Env, proposalId: string) {
  const tally = await env.DB.prepare(
    `SELECT COALESCE(SUM(value), 0) AS score FROM votes WHERE proposal_id = ?1`
  ).bind(proposalId).first<{ score: number }>();
  const score = tally?.score ?? 0;

  await env.DB.prepare(`UPDATE proposals SET score = ?1 WHERE id = ?2`).bind(score, proposalId).run();

  const proposal = await env.DB.prepare(
    `SELECT * FROM proposals WHERE id = ?1`
  ).bind(proposalId).first<any>();
  if (!proposal || proposal.status !== 'open') return { score, accepted: false };

  if (score >= ACCEPT_THRESHOLD) {
    await acceptProposal(env, proposal);
    await logEvent(env, 'proposal.accepted', proposal.user_id, proposal.slug, { proposalId, score });
    return { score, accepted: true };
  }
  return { score, accepted: false };
}

/**
 * Admin is a flag on the account, set by migration for the accounts that held
 * it and by POST /admin/bootstrap for any other.
 *
 * It used to be "the session's email is on the ADMIN_EMAIL list". Sign-up
 * takes any unused address without checking who owns it, so that made an admin
 * of whoever registered a listed address first.
 */
function isAdmin(user: User | null): boolean {
  return Boolean(user && user.is_admin);
}

/**
 * Addresses nobody may register or claim through the ordinary door.
 *
 * The ADMIN_EMAIL list no longer grants anything. What it still does is keep
 * these addresses out of sign-up, so an account under the owner's address is
 * always one the owner made.
 */
function isReserved(email: string, env: Env): boolean {
  const reserved = (env.ADMIN_EMAIL ?? '')
    .toLowerCase().split(',').map(e => e.trim()).filter(Boolean);
  return reserved.includes(email);
}

/** Admins are let into prep without being listed for it. */
function hasPrep(user: User | null): boolean {
  return Boolean(user && (user.prep_access || user.is_admin));
}

/**
 * Must match recordingSlug in src/lib/recordings.ts: the page a round lives at
 * is derived from these two strings on both sides, and a submission that lands
 * at a different address than the site builds is a round nobody can open.
 */
function slugFor(title: string, objectID: string): string {
  const base = (title || 'round')
    .toLowerCase()
    // Only the ASCII apostrophe, matching the site exactly. Stripping the
    // curly ones here as well looked like tidying and was a divergence: the
    // site turns them into a dash, so a title with one was filed under a slug
    // whose page does not exist, and its audio would never be found.
    .replace(/[']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70)
    .replace(/-+$/g, '');
  const suffix = objectID.replace(/[^a-z0-9]/gi, '').slice(0, 6).toLowerCase();
  return `${base}-${suffix}`;
}

/**
 * Asks GitHub to rebuild the site.
 *
 * The pages are static, so a correction reaches search the moment it is saved
 * and the round's own page only when the site is next built. Waiting for a
 * person to push is waiting for a person to remember, so the edit asks for the
 * build itself. The workflow already listens for this event; the ingest run
 * used to print a reminder instead.
 *
 * Quiet when there is no token: an edit that landed is not a failure because
 * the rebuild could not be requested, and the next deploy will pick it up
 * anyway. The caller is told which of the two happened.
 */
async function requestRebuild(env: Env, reason: string): Promise<boolean> {
  const { ok } = await dispatch(env, 'rounds-changed', { reason });
  if (ok) await setState(env, { rebuild_requested_at: now() });
  return ok;
}

/**
 * A few facts about the pipeline that belong to no round: when a rebuild was
 * last asked for, and when GitHub last accepted a request to start the run.
 */
async function readState(env: Env): Promise<Record<string, number | null>> {
  const { results } = await env.DB.prepare(`SELECT key, value FROM pipeline_state`)
    .all<{ key: string; value: number | null }>();
  return Object.fromEntries(results.map(r => [r.key, r.value]));
}

async function setState(env: Env, values: Record<string, number | null>): Promise<void> {
  await env.DB.batch(Object.entries(values).map(([key, value]) => env.DB.prepare(
    `INSERT INTO pipeline_state (key, value) VALUES (?1, ?2)
     ON CONFLICT(key) DO UPDATE SET value = ?2`
  ).bind(key, value)));
}

interface Pipeline {
  lastRunAt: number | null;
  lastDispatchAt: number | null;
  dispatchUnanswered: boolean;
}

/**
 * Whether the ingest run is coming when it is asked to.
 *
 * GitHub answers 204 to a dispatch whether or not a workflow is listening:
 * a disabled workflow ignores it, and the Worker heard nothing wrong. So the
 * first accepted dispatch with no run reported after it is remembered, and
 * once that has gone unanswered for longer than a run takes to start, it is
 * said: the requests are being accepted and nothing is running.
 */
async function pipelineFacts(env: Env): Promise<Pipeline> {
  const [lastRunAt, state] = await Promise.all([lastIngestRun(env), readState(env)]);
  const since = state.dispatch_unanswered_since ?? null;
  return {
    lastRunAt,
    lastDispatchAt: state.dispatch_accepted_at ?? null,
    dispatchUnanswered: since !== null && (lastRunAt ?? 0) < since && since < now() - UNANSWERED_AFTER_S,
  };
}

/** Sends the repository an event one of its workflows is listening for. */
async function dispatch(
  env: Env, eventType: string, payload: Record<string, unknown>,
): Promise<{ ok: boolean; why: string | null }> {
  if (!env.GITHUB_DISPATCH_TOKEN) return { ok: false, why: 'GITHUB_DISPATCH_TOKEN is not set' };
  const repo = env.GITHUB_REPO ?? 'tejasprabhune/goldenturn';
  const res = await outbound(env, `${env.GITHUB_API ?? 'https://api.github.com'}/repos/${repo}/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.GITHUB_DISPATCH_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      // GitHub refuses a request with no agent, which reads as a network fault.
      'User-Agent': 'goldenturn-api',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ event_type: eventType, client_payload: payload }),
  }).catch(() => null);
  if (res?.ok) return { ok: true, why: null };
  return { ok: false, why: res ? `GitHub answered ${res.status}` : 'GitHub could not be reached' };
}

/**
 * Starts the onboarding run. Called by the cron trigger, every fifteen minutes.
 *
 * The run used to start itself on a GitHub schedule, and GitHub disables a
 * scheduled workflow in a repository that has had no activity for sixty days.
 * It did, and submitted rounds stopped getting pages with nothing to show for
 * it. The workflow has no schedule now; this is its clock.
 *
 * When the event cannot be sent (no token, an expired one) that is written
 * where the admin page reads the run's history, under a stage of its own, so
 * it is never mistaken for the run reporting in. Only a change is written:
 * the first failure and the first success after it, not one row a quarter
 * hour for as long as a token stays expired.
 */
async function startIngestRun(env: Env): Promise<void> {
  const sent = await dispatch(env, 'onboard-due', {});
  const last = await env.DB.prepare(
    `SELECT state, note FROM ingest_events WHERE stage = 'dispatch' ORDER BY id DESC LIMIT 1`
  ).first<{ state: string; note: string | null }>();

  if (!sent.ok && !(last?.state === 'failed' && last.note === sent.why)) {
    await recordIngest(env, null, null, 'dispatch', 'failed', sent.why);
  } else if (sent.ok && last?.state === 'failed') {
    await recordIngest(env, null, null, 'dispatch', 'done', 'the run is being started again');
  }

  // Accepted is not the same as started; see pipelineFacts. The clock starts
  // at the first acceptance since the run last reported, and is not moved on
  // by the ones after it, or a run that never comes would never be overdue.
  if (sent.ok) {
    const [lastRunAt, state] = await Promise.all([lastIngestRun(env), readState(env)]);
    const since = state.dispatch_unanswered_since ?? null;
    await setState(env, {
      dispatch_accepted_at: now(),
      dispatch_unanswered_since: since !== null && since > (lastRunAt ?? 0) ? since : now(),
    });
  }
}

/**
 * How the archive files a description of a side.
 *
 * Lower case throughout, because "T-Framework", "t-framework" and "T-framework"
 * are one argument written three ways, and a reader scanning a list of rounds
 * should not have to notice which was typed.
 */
function described(v: string): string {
  return v.trim().toLowerCase();
}

/** The direct-download form; a share page is HTML and streams nothing. */
function directUrl(url: string): string {
  try {
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
  } catch {
    return url;
  }
}

/**
 * Confirms the link serves a recording rather than a web page or a 404.
 * YouTube and Vimeo are taken on trust: their pages are HTML by design and the
 * ingest run pulls the audio through yt-dlp.
 */
async function probeMedia(env: Env, link: string): Promise<{ ok: true; info: string } | { ok: false; reason: string }> {
  if (videoHost(link)) {
    return { ok: true, info: 'video host, checked at ingest' };
  }
  try {
    const res = await outbound(env, directUrl(link), { headers: { Range: 'bytes=0-1023' } });
    // Only the headers are wanted. A host that ignores the range would
    // otherwise stream the whole recording into nothing.
    await res.body?.cancel().catch(() => {});
    if (res.status === 404) return { ok: false, reason: 'That link returns not found' };
    if (!res.ok && res.status !== 206) {
      return { ok: false, reason: `That link answered ${res.status}` };
    }
    const type = res.headers.get('content-type') ?? '';
    if (type.includes('text/html')) {
      return { ok: false, reason: 'That link opens a web page rather than a file. Use a direct or shared file link.' };
    }
    const size = Number(res.headers.get('content-range')?.split('/')[1] ?? res.headers.get('content-length') ?? 0);
    if (size && size < 100_000) {
      return { ok: false, reason: 'That file is too small to be a round' };
    }
    return { ok: true, info: size ? `${Math.round(size / 1e6)}MB ${type || 'media'}` : (type || 'media') };
  } catch (err) {
    return { ok: false, reason: 'That link could not be reached' };
  }
}

/**
 * The search index, addressed from one place so every call carries the same
 * credentials and a test can stand something in for it.
 */
function algolia(env: Env, path: string, init: RequestInit = {}): Promise<Response> {
  const host = env.ALGOLIA_HOST ?? `https://${env.ALGOLIA_APP_ID}.algolia.net`;
  return outbound(env, `${host}/1/indexes/${path}`, {
    ...init,
    headers: {
      'X-Algolia-API-Key': env.ALGOLIA_ADMIN_KEY,
      'X-Algolia-Application-Id': env.ALGOLIA_APP_ID,
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
}

/**
 * A round's id and the slug that follows from it.
 *
 * The slug's suffix is the first six letters and digits of the id, on the site
 * and in every ingest script as well as here. Ids used to begin "sub-" and a
 * millisecond clock, so those six characters were "sub" and three digits that
 * change every 115 days: every round submitted in the same season of the year
 * with the same title got the same slug, the same page and the same audio
 * file. The random part leads now, so the six characters are the random part,
 * and nothing that derives a slug had to change to agree.
 */
async function newSubmissionId(env: Env, title: string): Promise<{ objectID: string; slug: string }> {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  for (let attempt = 0; attempt < 5; attempt++) {
    const random = [...crypto.getRandomValues(new Uint8Array(6))]
      .map(b => alphabet[b % alphabet.length]).join('');
    const objectID = `${random}-sub-${Date.now()}`;
    const slug = slugFor(title, objectID);
    const taken = await env.DB.prepare(`SELECT 1 FROM submissions WHERE slug = ?1`).bind(slug).first();
    if (!taken) return { objectID, slug };
  }
  throw new Error('no free slug for that title');
}

/** The four files a round can have in the bucket, and where each is filed. */
type MediaKind = 'audio' | 'peaks' | 'transcript' | 'speeches';
const MEDIA_FILES: Record<MediaKind, { prefix: string; ext: string }> = {
  audio: { prefix: 'audio/', ext: '.m4a' },
  peaks: { prefix: 'peaks/', ext: '.json' },
  transcript: { prefix: 'transcripts/', ext: '.json' },
  speeches: { prefix: 'speeches/', ext: '.json' },
};
const MEDIA_KINDS = Object.keys(MEDIA_FILES) as MediaKind[];
/** When each file reached the bucket, or null where there is none. */
type Media = Record<MediaKind, number | null>;

function mediaKey(kind: MediaKind, slug: string): string {
  return `${MEDIA_FILES[kind].prefix}${slug}${MEDIA_FILES[kind].ext}`;
}

/**
 * What is in the bucket for these rounds.
 *
 * The bucket is the answer to "how far has this round got": the run's own
 * reports say what it tried, and a transcript arrives from a GPU job that
 * reports to nobody. A few rounds are asked for by name; more than that and
 * listing the bucket is fewer requests than a HEAD for every file.
 */
async function mediaFor(env: Env, slugs: string[]): Promise<Map<string, Media>> {
  const out = new Map<string, Media>();
  const seconds = (o: R2Object | null) => (o ? Math.floor(o.uploaded.getTime() / 1000) : null);

  if (slugs.length <= 3) {
    for (const slug of slugs) {
      const [audio, peaks, transcript, speeches] = await Promise.all(
        MEDIA_KINDS.map(kind => env.MEDIA.head(mediaKey(kind, slug))),
      );
      out.set(slug, {
        audio: seconds(audio), peaks: seconds(peaks),
        transcript: seconds(transcript), speeches: seconds(speeches),
      });
    }
    return out;
  }

  const listed = await mediaListing(env);
  for (const slug of slugs) {
    out.set(slug, {
      audio: listed.audio.get(slug) ?? null, peaks: listed.peaks.get(slug) ?? null,
      transcript: listed.transcript.get(slug) ?? null, speeches: listed.speeches.get(slug) ?? null,
    });
  }
  return out;
}

/** Every round's files, by kind and slug. */
async function mediaListing(env: Env): Promise<Record<MediaKind, Map<string, number>>> {
  const one = async (kind: MediaKind) => {
    const { prefix, ext } = MEDIA_FILES[kind];
    const found = new Map<string, number>();
    let cursor: string | undefined;
    do {
      const page = await env.MEDIA.list({ prefix, cursor, limit: 1000 });
      for (const o of page.objects) {
        if (o.key.endsWith(ext)) {
          found.set(o.key.slice(prefix.length, -ext.length), Math.floor(o.uploaded.getTime() / 1000));
        }
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return found;
  };
  const [audio, peaks, transcript, speeches] = await Promise.all(MEDIA_KINDS.map(one));
  return { audio, peaks, transcript, speeches };
}

/** Deletes whatever a round has in the bucket, and says what that was. */
async function dropMedia(env: Env, slug: string, kinds: MediaKind[] = MEDIA_KINDS): Promise<string[]> {
  const removed: string[] = [];
  for (const kind of kinds) {
    const key = mediaKey(kind, slug);
    if (await env.MEDIA.head(key)) {
      await env.MEDIA.delete(key);
      removed.push(key);
    }
  }
  // Gone from the bucket is not gone from the media domain's cache, which
  // keeps a copy at the same address; and after a link is corrected the new
  // recording is uploaded to that same address.
  if (removed.length) await purgeMedia(env, removed);
  return removed;
}

/**
 * Empties the media domain's cache of these files and of the media index.
 *
 * Both copies of each: the domain caches by Origin as well as by address, so
 * the plain one and the one the site's own pages get are separate (see
 * purge in scripts/ingest/auto.ts). Quiet when there is no token, and never
 * a reason to fail what asked for it: the files are already deleted.
 */
async function purgeMedia(env: Env, keys: string[]): Promise<boolean> {
  if (!env.CACHE_PURGE_TOKEN || !env.MEDIA_ZONE_ID) return false;
  const base = mediaUrl(env);
  const origin = new URL(siteUrl(env)).origin;
  const files: Array<string | { url: string; headers: Record<string, string> }> = [];
  for (const key of [...keys, 'index.json']) {
    files.push(`${base}/${key}`, { url: `${base}/${key}`, headers: { Origin: origin } });
  }
  const api = env.CLOUDFLARE_API ?? 'https://api.cloudflare.com/client/v4';
  const res = await outbound(env, `${api}/zones/${env.MEDIA_ZONE_ID}/purge_cache`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.CACHE_PURGE_TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ files }),
  }).catch(() => null);
  if (!res?.ok) console.error(`cache purge for ${keys.join(', ')} failed: ${res ? res.status : 'unreachable'}`);
  return Boolean(res?.ok);
}

/**
 * Takes a round out of the media index.
 *
 * The site decides at build time which pages get a player by reading
 * index.json, and only an ingest run rewrote it. A round removed here stayed
 * listed as playable until the next run that happened to change something, so
 * the rebuild a removal asks for built a player over audio that was gone.
 */
async function unlistMedia(env: Env, slug: string, only?: 'transcribed'): Promise<void> {
  const current = await env.MEDIA.get('index.json');
  if (!current) return;
  let index: { playable?: string[]; transcribed?: string[] };
  try { index = await current.json(); } catch { return; }

  const playable = only ? (index.playable ?? []) : (index.playable ?? []).filter(s => s !== slug);
  const transcribed = (index.transcribed ?? []).filter(s => s !== slug);
  if (playable.length === (index.playable ?? []).length
    && transcribed.length === (index.transcribed ?? []).length) return;

  await env.MEDIA.put('index.json', JSON.stringify({ ...index, playable, transcribed }), {
    httpMetadata: { contentType: 'application/json', cacheControl: 'public, max-age=60' },
  });
  // The rebuild that follows reads it through the media domain.
  await purgeMedia(env, []);
}

interface IngestEvent {
  id: number;
  object_id: string | null;
  slug: string | null;
  stage: string;
  state: string;
  note: string | null;
  created_at: number;
}

const INGEST_STAGES = ['run', 'audio', 'transcript', 'speeches', 'index', 'page'];
const INGEST_STATES = ['queued', 'started', 'done', 'failed', 'skipped'];

async function recordIngest(
  env: Env, objectID: string | null, slug: string | null, stage: string, state: string, note?: string | null,
) {
  await env.DB.prepare(
    `INSERT INTO ingest_events (object_id, slug, stage, state, note, created_at) VALUES (?1,?2,?3,?4,?5,?6)`
  ).bind(objectID, slug, stage, state, note ? String(note).slice(0, 1000) : null, now()).run();
}

/** Each round's ingest events, newest first. */
async function ingestEventsFor(env: Env, slugs: string[], each: number): Promise<Map<string, IngestEvent[]>> {
  const out = new Map<string, IngestEvent[]>(slugs.map(s => [s, []]));
  // D1 takes a hundred bound values a query, so a long list goes in pieces.
  for (let i = 0; i < slugs.length; i += 80) {
    const chunk = slugs.slice(i, i + 80);
    const placeholders = chunk.map((_, n) => `?${n + 1}`).join(',');
    const { results } = await env.DB.prepare(
      `SELECT id, object_id, slug, stage, state, note, created_at
         FROM ingest_events WHERE slug IN (${placeholders})
        ORDER BY id DESC LIMIT 4000`
    ).bind(...chunk).all<IngestEvent>();
    for (const e of results) {
      const list = out.get(e.slug ?? '');
      if (list && list.length < each) list.push(e);
    }
  }
  return out;
}

/**
 * When the ingest run last reported in while able to work. A run that stopped
 * at once because it was not configured, or because storage refused its key,
 * reported in but could not have taken any round, so it does not count:
 * rounds waiting behind it are stalled, and are said to be.
 */
async function lastIngestRun(env: Env): Promise<number | null> {
  const row = await env.DB.prepare(
    `SELECT MAX(e.created_at) AS at FROM ingest_events e
      WHERE e.stage = 'run' AND e.state != 'failed'
        AND NOT EXISTS (
          SELECT 1 FROM ingest_events f
           WHERE f.id = (SELECT MIN(n.id) FROM ingest_events n WHERE n.stage = 'run' AND n.id > e.id)
             AND f.state = 'failed'
             AND (f.note LIKE 'storage:%' OR f.note LIKE 'not configured:%'))`
  ).first<{ at: number | null }>();
  return row?.at ?? null;
}

function isStalled(lastRunAt: number | null, waitingSince: number | null): boolean {
  const limit = now() - STALLED_AFTER_S;
  return waitingSince !== null && waitingSince < limit && (lastRunAt ?? 0) < limit;
}

/** "Finals - Cal MS vs Rice JJ" taken back apart, which is how the form built it. */
function titleParts(title: string): { round: string; teams: { aff: string; neg: string } | null } {
  const full = title.match(/^(.*?)\s+-\s+(.+?)\s+vs\.?\s+(.+)$/i);
  if (full) return { round: full[1].trim(), teams: { aff: full[2].trim(), neg: full[3].trim() } };
  const bare = title.match(/^(.+?)\s+vs\.?\s+(.+)$/i);
  if (bare) return { round: '', teams: { aff: bare[1].trim(), neg: bare[2].trim() } };
  return { round: title, teams: null };
}

/**
 * Which video host a link is on, decided by its host name.
 *
 * It used to be whether "youtube.com" appeared anywhere in the link, so
 * `http://127.0.0.1:9/x?youtube.com` was waved through unchecked as a video
 * and handed to yt-dlp on the runner, which will fetch whatever it is given.
 * Must match videoHost in scripts/ingest/lib.ts.
 */
function videoHost(link: string): 'youtube' | 'vimeo' | null {
  let host: string;
  try { host = new URL(link).hostname.toLowerCase().replace(/\.$/, ''); } catch { return null; }
  const on = (domain: string) => host === domain || host.endsWith(`.${domain}`);
  if (on('youtube.com') || on('youtu.be') || on('youtube-nocookie.com')) return 'youtube';
  if (on('vimeo.com')) return 'vimeo';
  return null;
}

function linkKind(link: string): 'youtube' | 'vimeo' | 'file' {
  return videoHost(link) ?? 'file';
}

/**
 * Why the audio could not be fetched, for the person who submitted it.
 *
 * The stored note is the tool's own last words, which is what an admin wants
 * and not what a submitter can act on. Each of these says what happened and,
 * where there is one, what to do about it.
 */
function plainReason(note: string | null): string {
  const n = note ?? '';
  const short = n.match(/only (\d+)s of audio/);
  if (short) {
    return `The file holds only ${short[1]} seconds of audio, which is too short to be a round. Check the link points at the whole recording.`;
  }
  const refused = n.match(/download (\d{3})/);
  if (refused) {
    return refused[1] === '404'
      ? 'The link no longer leads to a file. Check it still opens, then submit the round again with a working link.'
      : `The host refused the download (it answered ${refused[1]}). Check the link is shared so anyone can open it, then submit the round again.`;
  }
  if (/sign in to confirm|not a bot|confirm your age|cookies/i.test(n)) {
    return 'The video host would not let our server download this video without signing in. Uploading the recording as a file (Dropbox works) and submitting that link gets round it.';
  }
  if (/private video|video unavailable|has been removed|is not available|members-only|no longer available/i.test(n)) {
    return 'The video is private, removed or not available to our server. Make it public or unlisted, or submit a link to the file instead.';
  }
  if (/unsupported url|produced no file|is not a valid url/i.test(n)) {
    return 'That link is not one the recording could be downloaded from. Submit a link to the video itself or to the file.';
  }
  if (/invalid data found|moov atom|does not contain any stream|could not find codec|invalid argument/i.test(n)) {
    return 'The file at that link could not be read as audio or video. Check it plays, then submit the round again.';
  }
  // The ingest's own limits (scripts/ingest/drain-submissions.ts).
  if (/larger than \d+MB|max-filesize|File is larger than/i.test(n)) {
    return 'The file at that link is too large to be one round. Check the link points at a single recording, then submit the round again.';
  }
  if (/took longer than|download stalled/i.test(n)) {
    return 'The download from that link stalled or took far too long, so it was stopped. Check the link opens and downloads at a normal speed; an admin can retry it, or submit the round again with another link.';
  }
  // Ours, not the link's: the ingest could not write to its own storage.
  if (/signature we calculated|SignatureDoesNotMatch|InvalidAccessKeyId|AccessDenied|ExpiredToken/i.test(n)) {
    return 'Our storage refused the upload, so nothing is wrong with your link. Tejas can see the error; the round is fetched again once that is fixed.';
  }
  if (/timed? ?out|ETIMEDOUT|ECONNRESET|ENOTFOUND|fetch failed|network/i.test(n)) {
    return 'The link could not be reached from our server. It may have been a passing fault; an admin can retry it.';
  }
  return 'The recording could not be fetched from the link. Tejas can see the exact error and retry it; submitting the round again with a different link also works.';
}

/**
 * A submission as it was sent in, in the shape POST /recordings takes, so a
 * form can be filled with it and sent again.
 *
 * Search is asked first because that is where an admin's corrections land.
 * The copy kept on the row is for a round that has left search: one that was
 * removed is exactly the one somebody comes back to send in again.
 */
function asSubmitted(sub: SubmissionRow, record: any): Record<string, unknown> | null {
  let kept: any = null;
  try { kept = sub.details ? JSON.parse(sub.details) : null; } catch { kept = null; }
  const from = record ?? kept;
  if (!from) return null;
  return {
    title: sub.title, link: sub.link, year: sub.year ?? '', tournament: sub.tournament ?? '',
    format: from.format ?? '', level: from.level ?? '',
    resolution: from.resolution ?? '', aff: from.aff ?? '', neg: from.neg ?? '',
    decision: from.decision ?? '',
    tags: Array.isArray(from._tags) ? from._tags : Array.isArray(from.tags) ? from.tags : [],
  };
}

interface SubmissionRow {
  object_id: string;
  slug: string;
  title: string;
  link: string;
  year: string | null;
  tournament: string | null;
  user_id: string | null;
  status: 'pending' | 'ingested' | 'failed';
  review: 'unreviewed' | 'confirmed' | 'removed';
  note: string | null;
  attempts: number;
  created_at: number;
  updated_at: number;
  page_checked_at: number | null;
  page_seen_at: number | null;
  page_at: number | null;
  page_after: number | null;
  details: string | null;
  author: string | null;
  author_email?: string | null;
}

/** A submission with its submitter, which is how every reader of one wants it. */
const SUBMISSION_SELECT = `SELECT s.object_id, s.slug, s.title, s.link, s.year, s.tournament, s.user_id,
       s.status, s.review, s.note, s.attempts, s.created_at, s.updated_at,
       s.page_checked_at, s.page_seen_at, s.page_at, s.page_after, s.details,
       u.display_name AS author, u.email AS author_email
  FROM submissions s LEFT JOIN users u ON u.id = s.user_id`;

/** By id or by slug: a waiting page knows whichever the link it was given holds. */
async function findSubmission(env: Env, ref: string): Promise<SubmissionRow | null> {
  return env.DB.prepare(
    `${SUBMISSION_SELECT} WHERE s.object_id = ?1 OR s.slug = ?1
      ORDER BY (s.object_id = ?1) DESC, s.created_at DESC LIMIT 1`
  ).bind(ref).first<SubmissionRow>();
}

function siteUrl(env: Env): string {
  return (env.SITE_URL ?? 'https://goldenturn.org').replace(/\/+$/, '');
}

function mediaUrl(env: Env): string {
  return (env.MEDIA_URL ?? 'https://media.goldenturn.org').replace(/\/+$/, '');
}

/** When a page of the built site was deployed, or null if it is not there. */
async function deployedAt(env: Env, path: string): Promise<{ exists: boolean; builtAt: number | null } | null> {
  const res = await outbound(env, `${siteUrl(env)}${path}`, { method: 'HEAD', redirect: 'follow' }).catch(() => null);
  // No answer is not "no page": the caller keeps what it knew.
  if (!res || res.status >= 500) return null;
  if (!res.ok) return { exists: false, builtAt: null };
  const modified = Date.parse(res.headers.get('last-modified') ?? '');
  return { exists: true, builtAt: Number.isFinite(modified) ? Math.floor(modified / 1000) : null };
}

interface PageState { exists: boolean; hasPlayer: boolean; builtAt: number | null }

/**
 * Whether the round has a page, from what was last seen.
 *
 * A page exists for every round in search as of the last build, but whether
 * it shows a player was decided at that build from what was in the bucket. So
 * "published" means a page built after the audio arrived; one built before is
 * a page that says there is no hosted audio.
 */
function pageRemembered(sub: SubmissionRow, media: Media): PageState {
  if (sub.page_at) return { exists: true, hasPlayer: true, builtAt: sub.page_at };
  const exists = sub.page_seen_at !== null;
  return {
    exists,
    // A round restarted from a stage wants a page built since the restart:
    // the one from before still shows what was cleared.
    hasPlayer: exists && media.audio !== null
      && sub.page_seen_at! >= Math.max(media.audio, sub.page_after ?? 0),
    builtAt: sub.page_seen_at,
  };
}

/** The same, asking the site first unless it was asked within the minute. */
async function pageNow(env: Env, sub: SubmissionRow, media: Media): Promise<PageState> {
  const settled = Boolean(sub.page_at) || sub.review === 'removed';
  const recent = sub.page_checked_at !== null && sub.page_checked_at > now() - PAGE_RECHECK_S;
  if (settled || recent) return pageRemembered(sub, media);

  const seen = await deployedAt(env, `/recordings/${sub.slug}/`);
  if (!seen) return pageRemembered(sub, media);

  sub.page_checked_at = now();
  // A host that sends no date is taken at its word that the page is current.
  sub.page_seen_at = seen.exists ? (seen.builtAt ?? now()) : null;
  const state = pageRemembered(sub, media);
  if (state.hasPlayer) sub.page_at = sub.page_seen_at;

  await env.DB.prepare(
    `UPDATE submissions SET page_checked_at = ?1, page_seen_at = ?2, page_at = ?3 WHERE object_id = ?4`
  ).bind(sub.page_checked_at, sub.page_seen_at, sub.page_at, sub.object_id).run();
  return state;
}

type StageState = 'done' | 'active' | 'waiting' | 'failed';

/**
 * Where a submitted round has got to, stage by stage.
 *
 * Built from what exists rather than from what was reported: a stage is done
 * when its file is in the bucket (or its page is on the site), whatever the
 * status column says, because the transcript arrives from a job that reports
 * to nobody and a report can be lost. The run's reports fill in the rest:
 * when a stage was started, and why one failed.
 */
function buildProgress(
  env: Env, sub: SubmissionRow, media: Media, events: IngestEvent[], page: PageState, pipe: Pipeline,
) {
  const { lastRunAt } = pipe;
  const removed = sub.review === 'removed';
  // A stage's history begins again where it was last queued: a round
  // restarted from a stage carries a "queued" row for it and for every stage
  // after it, and what was reported before that row was about the outputs
  // the restart cleared.
  const current = (stage: string) => {
    const out: IngestEvent[] = [];
    for (const e of events) {
      if (e.stage !== stage) continue;
      out.push(e);
      if (e.state === 'queued') break;
    }
    return out;
  };
  const latest = (stage: string) => current(stage)[0];
  const startedAt = (stage: string) =>
    current(stage).find(e => e.state === 'started')?.created_at ?? null;
  const queuedAt = (stage: string) => current(stage).find(e => e.state === 'queued')?.created_at ?? null;
  const after = (a: number | null, b: number | null) => (a === null ? null : Math.max(a, b ?? 0));

  // When each step became able to start: the audio when the round was last
  // queued, the transcript and the page when the audio arrived, the speeches
  // when the transcript did; or, for a step restarted since, the restart.
  const since: Record<string, number | null> = {
    submitted: null, audio: sub.updated_at,
    transcript: after(media.audio, queuedAt('transcript')),
    speeches: after(media.transcript, queuedAt('speeches')),
    page: after(media.audio, Math.max(queuedAt('page') ?? 0, sub.page_after ?? 0)),
  };
  const running = (lastRunAt ?? 0) > now() - STALLED_AFTER_S;
  const stage = (key: string, label: string, state: StageState, at: number | null = null, reason: string | null = null) => {
    const pace = STAGE_PACE[key];
    // Still to come, counting an attempt that failed and will be made again.
    const owed = state === 'active' || (state === 'failed' && key !== 'audio');
    const began = owed ? since[key] : null;
    return {
      key, label, state, at,
      // The site build is not reported by anybody; it starts when the audio
      // lands, or when the round was restarted.
      startedAt: startedAt(key) ?? (key === 'page' ? since.page : null),
      reason,
      typicalSeconds: pace?.typical ?? null,
      expectedAt: began && pace ? began + pace.typical : null,
      // Only while the run is alive. When it is not, nothing is stuck; it is
      // all stopped, and pipeline.stalled says that instead.
      stuck: Boolean(began && pace && running && now() - began > pace.stuck),
    };
  };

  const stages = [stage('submitted', 'Submitted', 'done', sub.created_at)];

  if (media.audio) {
    stages.push(stage('audio', 'Audio fetched', 'done', media.audio));
  } else if (sub.status === 'failed') {
    stages.push(stage('audio', 'Audio fetched', 'failed', sub.updated_at, plainReason(sub.note)));
  } else if (sub.status === 'ingested' && !removed) {
    // Recorded as fetched, and not there. Nothing will fetch it again unasked.
    stages.push(stage('audio', 'Audio fetched', 'failed', sub.updated_at,
      'The stored audio for this round has gone missing. An admin needs to fetch it again.'));
  } else {
    stages.push(stage('audio', 'Audio fetched', removed ? 'waiting' : 'active'));
  }

  // The two steps after the audio are retried by every run, so a failure here
  // is the last attempt's, not the round's.
  const later = (key: 'transcript' | 'speeches', label: string, needs: number | null, reason: string) => {
    if (media[key]) return stage(key, label, 'done', media[key]);
    if (!needs || removed) return stage(key, label, 'waiting');
    const last = latest(key);
    if (last?.state === 'failed') return stage(key, label, 'failed', last.created_at, reason);
    return stage(key, label, 'active');
  };
  stages.push(later('transcript', 'Transcribed', media.audio,
    'The transcription could not be started this time. It is tried again on the next run.'));
  stages.push(later('speeches', 'Speeches labelled', media.transcript,
    'The speeches could not be marked automatically this time. It is tried again on the next run.'));

  if (page.hasPlayer) stages.push(stage('page', 'Page published', 'done', page.builtAt));
  else stages.push(stage('page', 'Page published', media.audio && !removed ? 'active' : 'waiting'));

  const state = (key: string) => stages.find(s => s.key === key)!.state;
  const status = removed ? 'removed'
    : state('audio') === 'failed' ? 'failed'
    : state('audio') !== 'done' ? 'fetching'
    : state('transcript') !== 'done' ? 'transcribing'
    : state('speeches') !== 'done' ? 'labelling'
    : state('page') !== 'done' ? 'publishing'
    : 'published';

  const failed = stages.find(s => s.state === 'failed');
  const failure = removed
    ? { stage: null, reason: 'This round was removed by an admin.', at: sub.updated_at, final: true }
    : failed
      ? { stage: failed.key, reason: failed.reason, at: failed.at, final: failed.key === 'audio' }
      : null;

  const kind = linkKind(sub.link);
  const base = mediaUrl(env);
  const audio = media.audio
    ? {
        url: `${base}/${mediaKey('audio', sub.slug)}`,
        source: 'stored',
        peaksUrl: media.peaks ? `${base}/${mediaKey('peaks', sub.slug)}` : null,
      }
    // The link as submitted plays in an audio element when it is a file. Not
    // offered once fetching it has failed: it is the thing that did not work.
    : kind === 'file' && !removed && sub.status === 'pending'
      ? { url: directUrl(sub.link), source: 'submitted', peaksUrl: null }
      : null;

  const inFlight = ['fetching', 'transcribing', 'labelling', 'publishing'].includes(status);
  const path = `/recordings/${sub.slug}`;
  const stalled = inFlight && isStalled(lastRunAt, Math.max(sub.updated_at, sub.page_after ?? 0));
  const stuckStage = stages.find(s => s.stuck)?.key ?? null;

  // When it should all be there, each remaining step taking its usual time
  // after the one it waits on. Never earlier than now: a step that is overdue
  // is due, not done. No guess is offered for a run that is not running.
  const t = now();
  const ends = (key: string, after: number) => {
    const s = stages.find(x => x.key === key)!;
    return s.state === 'done' ? s.at! : Math.max(t, after + STAGE_PACE[key].typical);
  };
  const audioEnd = ends('audio', sub.updated_at);
  const transcriptEnd = ends('transcript', after(audioEnd, queuedAt('transcript'))!);
  const estimatedDoneAt = inFlight && !stalled
    ? Math.max(ends('speeches', after(transcriptEnd, queuedAt('speeches'))!),
      ends('page', after(audioEnd, Math.max(queuedAt('page') ?? 0, sub.page_after ?? 0))!))
    : null;

  return {
    id: sub.object_id,
    slug: sub.slug,
    title: sub.title,
    ...titleParts(sub.title),
    tournament: sub.tournament,
    year: sub.year,
    submitter: sub.author,
    submittedAt: sub.created_at,
    updatedAt: sub.updated_at,
    status,
    ingestStatus: sub.status,
    review: sub.review,
    stages,
    failure,
    audio,
    // A removed round was taken down for a reason; its link goes with it.
    link: removed ? null : sub.link,
    linkKind: kind,
    media: {
      audio: media.audio !== null, peaks: media.peaks !== null,
      transcript: media.transcript !== null, speeches: media.speeches !== null,
    },
    page: { path, url: `${siteUrl(env)}${path}`, exists: page.exists, hasPlayer: page.hasPlayer, builtAt: page.builtAt },
    pipeline: { lastRunAt, stalled, lastDispatchAt: pipe.lastDispatchAt, dispatchUnanswered: pipe.dispatchUnanswered },
    stuck: stuckStage !== null,
    stuckStage,
    estimatedDoneAt,
    now: t,
  };
}

/**
 * Puts a submission back in the queue.
 *
 * With a new link it is a different recording, so what was stored for the old
 * one goes: left in place, the audio would be overwritten but the transcript
 * would not, because a round that has one is never transcribed again.
 */
async function requeue(env: Env, sub: { object_id: string; slug: string }, why: string, newLink?: string): Promise<string[]> {
  let removed: string[] = [];
  if (newLink) {
    removed = await dropMedia(env, sub.slug);
    await unlistMedia(env, sub.slug);
  }
  await env.DB.prepare(
    `UPDATE submissions
        SET status = 'pending', note = NULL, link = COALESCE(?1, link), updated_at = ?2,
            page_checked_at = CASE WHEN ?1 IS NULL THEN page_checked_at ELSE NULL END,
            page_seen_at = CASE WHEN ?1 IS NULL THEN page_seen_at ELSE NULL END,
            page_at = CASE WHEN ?1 IS NULL THEN page_at ELSE NULL END
      WHERE object_id = ?3`
  ).bind(newLink ?? null, now(), sub.object_id).run();
  // This row is also what an ingest report is checked against: the run is
  // handed its id as the attempt it is working on, and a report for any
  // earlier one is refused (see POST /recordings/:id/status).
  await recordIngest(env, sub.object_id, sub.slug, 'audio', 'queued', why);
  return removed;
}

/** The stages a round can be started again from, in the order they happen. */
const RESTART_STAGES = ['audio', 'transcript', 'speeches', 'page'] as const;
type RestartStage = typeof RESTART_STAGES[number];

/**
 * Starts a round again from one stage, keeping everything before it.
 *
 * What that stage and every later one produced is deleted, and each of them
 * gets a "queued" row so its history starts again from now. Nothing earlier
 * is touched: a round restarted from the transcript keeps its audio, is not
 * put back in the download queue, and is found by the next run the way any
 * round is, by having audio and no transcript. Only a restart from the audio
 * puts it back in the queue. The page is rebuilt in every case, since it
 * shows what was cleared.
 */
async function restartFrom(
  env: Env, sub: { object_id: string; slug: string }, from: RestartStage, media: Media,
): Promise<{ refused: string } | { removed: string[]; rebuilding: boolean }> {
  // Each stage needs the one it is made from. The page is made from the
  // audio, not from the speeches.
  if ((from === 'transcript' || from === 'page') && !media.audio) {
    return { refused: `that round has no audio yet, so there is no ${from === 'page' ? 'page' : 'transcript'} to redo; restart it from "audio"` };
  }
  if (from === 'speeches' && !media.transcript) {
    return { refused: 'that round has no transcript yet, so there are no speeches to redo; restart it from "transcript" or "audio"' };
  }

  const files: Record<RestartStage, MediaKind[]> = {
    audio: MEDIA_KINDS, transcript: ['transcript', 'speeches'], speeches: ['speeches'], page: [],
  };
  const removed = await dropMedia(env, sub.slug, files[from]);
  if (from === 'audio') await unlistMedia(env, sub.slug);
  if (from === 'transcript') await unlistMedia(env, sub.slug, 'transcribed');

  await env.DB.prepare(
    `UPDATE submissions SET page_checked_at = NULL, page_seen_at = NULL, page_at = NULL, page_after = ?1
      WHERE object_id = ?2`
  ).bind(now(), sub.object_id).run();
  const why = `restarted from ${from} by an admin`;
  if (from === 'audio') await requeue(env, sub, why);
  for (const stage of RESTART_STAGES.slice(RESTART_STAGES.indexOf(from))) {
    if (stage !== 'audio') await recordIngest(env, sub.object_id, sub.slug, stage, 'queued', why);
  }
  const rebuilding = await requestRebuild(env, `restarted ${sub.slug} from ${from}`);
  return { removed, rebuilding };
}

/**
 * A search key for one person, for the prep index only, for a few hours.
 *
 * Algolia checks these without being told about them: the key is the HMAC of
 * the restrictions under a parent key, followed by the restrictions, so the
 * limits cannot be edited without the parent key and the parent key never
 * leaves here. Serialised the way Algolia's own client does it (keys in
 * alphabetical order, each value URL-encoded), so the two produce the same
 * key for the same limits.
 */
async function securedSearchKey(parentKey: string, indexName: string, userToken: string, validUntil: number): Promise<string> {
  const params = [
    `restrictIndices=${encodeURIComponent(indexName)}`,
    `userToken=${encodeURIComponent(userToken)}`,
    `validUntil=${validUntil}`,
  ].join('&');
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(parentKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(params));
  const hex = [...new Uint8Array(mac)].map(b => b.toString(16).padStart(2, '0')).join('');
  return btoa(hex + params);
}

/**
 * A telemetry payload cut to fit, and still JSON.
 *
 * It used to be serialised and then sliced at 500 characters, which leaves
 * half an object whenever somebody pastes a paragraph into a search box. One
 * such row made every stats query that touched it fail, and the admin page
 * reports any failure as "access denied". Long strings are shortened inside
 * the object instead, and anything still too big is dropped rather than cut.
 */
function fitPayload(payload: unknown): string {
  const whole = JSON.stringify(payload ?? {});
  if (whole.length <= 500) return whole;
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    const trimmed: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(payload as Record<string, unknown>).slice(0, 12)) {
      trimmed[k.slice(0, 40)] = typeof v === 'string' ? v.slice(0, 120)
        : (typeof v === 'number' || typeof v === 'boolean' || v === null) ? v : undefined;
    }
    const fitted = JSON.stringify({ ...trimmed, truncated: true });
    if (fitted.length <= 500) return fitted;
  }
  return JSON.stringify({ truncated: true });
}

/** Rounds as search holds them, by id. Empty when search cannot be asked. */
async function searchRecords(env: Env, objectIDs: string[]): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  if (objectIDs.length === 0) return out;
  try {
    const res = await algolia(env, '*/objects', {
      method: 'POST',
      body: JSON.stringify({
        requests: objectIDs.map(objectID => ({ indexName: env.ALGOLIA_INDEX, objectID })),
      }),
    });
    if (!res.ok) return out;
    const { results } = await jsonWithin<{ results: Array<{ objectID: string } | null> }>(res, MANY_RECORDS_BYTES);
    for (const r of results ?? []) if (r) out.set(r.objectID, r);
  } catch { /* the list is still worth showing without them */ }
  return out;
}

/** One round's progress object, the page checked unless `fresh` is false. */
async function progressOf(env: Env, sub: SubmissionRow, fresh: boolean) {
  const files = (await mediaFor(env, [sub.slug])).get(sub.slug)!;
  const [events, pipe, page] = await Promise.all([
    ingestEventsFor(env, [sub.slug], 100),
    pipelineFacts(env),
    fresh ? pageNow(env, sub, files) : pageRemembered(sub, files),
  ]);
  return buildProgress(env, sub, files, events.get(sub.slug) ?? [], page, pipe);
}

/**
 * Submissions as the admin page wants them: the row, the round as search
 * holds it, where the ingest has got to, and what the run said along the way.
 */
async function describeSubmissions(
  env: Env, rows: SubmissionRow[], opts: { records: boolean; events: number; fresh: boolean },
) {
  const slugs = rows.map(r => r.slug);
  const [media, events, pipe, records] = await Promise.all([
    mediaFor(env, slugs),
    ingestEventsFor(env, slugs, Math.max(opts.events, 50)),
    pipelineFacts(env),
    opts.records ? searchRecords(env, rows.map(r => r.object_id)) : new Map<string, unknown>(),
  ]);

  const out = [];
  for (const row of rows) {
    const files = media.get(row.slug)!;
    const said = events.get(row.slug) ?? [];
    const page = opts.fresh ? await pageNow(env, row, files) : pageRemembered(row, files);
    out.push({
      object_id: row.object_id, slug: row.slug, title: row.title, link: row.link,
      year: row.year, tournament: row.tournament,
      status: row.status, review: row.review, note: row.note, attempts: row.attempts,
      created_at: row.created_at, updated_at: row.updated_at,
      author: row.author, author_id: row.user_id, author_email: row.author_email ?? null,
      record: records.get(row.object_id) ?? null,
      progress: buildProgress(env, row, files, said, page, pipe),
      events: said.slice(0, opts.events)
        .map(({ id, stage, state, note, created_at }) => ({ id, stage, state, note, created_at })),
    });
  }
  return out;
}

/**
 * Remove it. A round that should not be here has to go from everywhere it
 * reached on its own: out of search, and its audio, transcript and timings
 * out of the bucket, or the files stay served at a guessable address.
 */
async function removeSubmission(req: Request, env: Env, objectID: string | null, user: User | null): Promise<Response> {
  if (!isAdmin(user)) return json({ error: 'not permitted' }, { status: 403 });
  const row = await env.DB.prepare(
    `SELECT slug, title, review FROM submissions WHERE object_id = ?1`
  ).bind(objectID).first<{ slug: string; title: string; review: string }>();
  if (!row) return json({ error: 'no such submission' }, { status: 404 });
  // Already done: removing it again would only ask for another rebuild.
  if (row.review === 'removed') return json({ ok: true, review: 'removed', removed: [], rebuilding: false });

  const { note } = await bodyOf<{ note?: unknown }>(req);

  // Unreachable is a refusal too, and nothing has been deleted yet.
  const search = await algolia(env, `${env.ALGOLIA_INDEX}/${objectID}`, { method: 'DELETE' }).catch(() => null);
  if (!search || (!search.ok && search.status !== 404)) {
    return json({ error: `search index refused the removal (${search?.status ?? 'unreachable'})` }, { status: 502 });
  }

  const removed = await dropMedia(env, row.slug);
  // Before the rebuild is asked for, so the build reads an index without it.
  await unlistMedia(env, row.slug);

  await env.DB.prepare(
    `UPDATE submissions SET review = 'removed', note = ?1, updated_at = ?2 WHERE object_id = ?3`
  ).bind(typeof note === 'string' ? note.slice(0, 1000) : null, now(), objectID).run();
  // The round's page outlives its record until the site is built again.
  const rebuilding = await requestRebuild(env, `removed ${row.slug}`);
  await logEvent(env, 'recording.removed', user!.id, row.slug,
    { objectID, removed: removed.length, rebuilding });

  return json({ ok: true, review: 'removed', removed, rebuilding });
}

/**
 * An account as the admin page lists it.
 *
 * Last seen is only recorded from the deploy that added the column. An
 * account not seen since falls back to its latest sign-in or event, which is
 * the most that is known about it.
 */
const userSelect = () => `SELECT u.id, u.email, u.display_name, u.created_at,
       COALESCE(u.last_seen_at,
                (SELECT MAX(created_at) FROM sessions WHERE user_id = u.id),
                (SELECT MAX(created_at) FROM events WHERE user_id = u.id)) AS last_seen_at,
       u.rep, u.is_admin, u.prep_access,
       (u.password_hash IS NOT NULL AND u.password_hash != '') AS has_password,
       (SELECT COUNT(*) FROM proposals WHERE user_id = u.id) AS proposals,
       (SELECT COUNT(*) FROM proposals WHERE user_id = u.id AND status = 'accepted') AS proposals_accepted,
       (SELECT COUNT(*) FROM submissions WHERE user_id = u.id) AS submissions,
       (SELECT COUNT(*) FROM favorites WHERE user_id = u.id) AS favorites,
       (SELECT COUNT(*) FROM notes WHERE user_id = u.id) AS notes,
       (SELECT COUNT(*) FROM ratings WHERE user_id = u.id) AS ratings,
       (SELECT COUNT(*) FROM user_tags WHERE user_id = u.id) AS tags,
       (SELECT COUNT(*) FROM sessions WHERE user_id = u.id AND expires_at > ${now()}) AS sessions_active
  FROM users u`;

function userRow(u: any) {
  return {
    ...u,
    is_admin: Boolean(u.is_admin),
    prep_access: Boolean(u.prep_access),
    has_password: Boolean(u.has_password),
  };
}

/** Opens or closes the prep area for one account, named by id or by email. */
async function setPrepAccess(req: Request, env: Env, admin: User | null, allowed: boolean): Promise<Response> {
  if (!isAdmin(admin)) return json({ error: 'not permitted' }, { status: 403 });
  const body = await bodyOf<{ userId?: string; email?: string }>(req);
  const userId = typeof body.userId === 'string' ? body.userId.trim() : '';
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
  if (!userId && !email) return json({ error: 'userId or email required' }, { status: 400 });

  // Only an account that exists. Sign-up does not prove an address, so access
  // promised to an address nobody has registered would go to whoever did.
  const target = await env.DB.prepare(
    userId ? `SELECT id, email, display_name FROM users WHERE id = ?1`
      : `SELECT id, email, display_name FROM users WHERE email = ?1`
  ).bind(userId || email).first<{ id: string; email: string; display_name: string }>();
  if (!target) return json({ error: 'no such account' }, { status: 404 });

  await env.DB.prepare(`UPDATE users SET prep_access = ?1 WHERE id = ?2`)
    .bind(allowed ? 1 : 0, target.id).run();
  await logEvent(env, allowed ? 'prep.granted' : 'prep.revoked', admin!.id, null, { userId: target.id });
  return json({ ok: true, user: { ...target, prep_access: allowed } });
}

/** Kinds accepted from the browser, so the events table cannot be filled with junk. */
/**
 * The events a page may record. Anything else is refused, so a stray or forged
 * kind cannot fill the table.
 *
 * Every kind the site actually sends has to be in here. Three were not, and a
 * client that never looks at the reply had no way to say so: sorting, changing
 * format or level, and proposing a boundary were all being dropped at the
 * door, which is why the dashboard has never shown them.
 */
const PUBLIC_EVENTS = new Set([
  'search', 'round.view', 'tag.add', 'transcript.search', 'speech.jump',
  'recordings.sort', 'recordings.kinds', 'boundary.propose',
]);

const routes: Record<string, (req: Request, env: Env, url: URL, user: User | null) => Promise<Response>> = {
  'GET /health': async (_req, env) => {
    const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
    return json({ ok: true, users: r?.n ?? 0 });
  },

  /**
   * Sign in and sign up are separate modes on purpose: a single endpoint that
   * creates an account on any unknown email turns a mistyped address into a
   * silent new account rather than an error.
   */
  'POST /auth/session': async (req, env) => {
    const body = await bodyOf<{
      email?: unknown; password?: unknown; displayName?: unknown; mode?: unknown;
    }>(req);
    // Anything but a string is no answer at all, rather than a method call on
    // a number that answers 500.
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const mode = body.mode === 'signup' ? 'signup' : 'signin';
    if (!email || !email.includes('@') || email.length > EMAIL_MAX) {
      return json({ error: 'valid email required' }, { status: 400 });
    }
    if (password.length < 8) return json({ error: 'password must be at least 8 characters' }, { status: 400 });

    // Before migration 0007 the flags are not there to read; see tolerant.
    const existing = await tolerant(
      () => env.DB.prepare(
        `SELECT id, email, display_name, rep, is_admin, prep_access, password_hash
           FROM users WHERE email = ?1`
      ).bind(email).first<User & { password_hash: string | null }>(),
      () => env.DB.prepare(
        `SELECT id, email, display_name, rep, 0 AS is_admin, 0 AS prep_access, password_hash
           FROM users WHERE email = ?1`
      ).bind(email).first<User & { password_hash: string | null }>(),
    );

    // Every refusal is kept, with the address tried and why, so a run of them
    // can be seen for what it is. The address is cut short because this is
    // anonymous input.
    const refuse = (reason: string) =>
      logEvent(env, 'auth.failed', existing?.id ?? null, null, { email: email.slice(0, 120), reason });

    let user: User;
    if (mode === 'signup') {
      // Nothing here proves the address is the caller's, so the addresses that
      // matter are not available here at all. Checked before "already exists"
      // so the answer does not say whether the owner has registered yet.
      if (isReserved(email, env)) {
        await refuse('reserved_address');
        return json({ error: 'that address is reserved and cannot be registered here' }, { status: 403 });
      }
      if (existing) {
        return json({ error: 'an account with that email already exists' }, { status: 409 });
      }
      const name = typeof body.displayName === 'string' ? body.displayName.trim() : '';
      if (!name) return json({ error: 'display name required' }, { status: 400 });
      const uid = id();
      const hash = await hashPassword(password);
      await tolerant(
        () => env.DB.prepare(
          `INSERT INTO users (id, email, display_name, created_at, rep, password_hash, last_seen_at)
           VALUES (?1, ?2, ?3, ?4, 0, ?5, ?4)`
        ).bind(uid, email, name.slice(0, 60), now(), hash).run(),
        () => env.DB.prepare(
          `INSERT INTO users (id, email, display_name, created_at, rep, password_hash)
           VALUES (?1, ?2, ?3, ?4, 0, ?5)`
        ).bind(uid, email, name.slice(0, 60), now(), hash).run(),
      );
      user = { id: uid, email, display_name: name.slice(0, 60), rep: 0, is_admin: 0, prep_access: 0 };
      await logEvent(env, 'user.created', uid, null, {});
    } else {
      if (!existing) {
        await refuse('no_account');
        return json({ error: 'no account with that email' }, { status: 404 });
      }
      if (!existing.password_hash) {
        // Account predates passwords; the first sign-in sets one. That is a
        // claim by whoever arrives first, which is tolerable for an ordinary
        // account nobody has used since and not for one that carries admin.
        if (existing.is_admin || isReserved(email, env)) {
          await refuse('no_password');
          return json({ error: 'this account has no password yet; ask Tejas to set one' }, { status: 403 });
        }
        await env.DB.prepare(`UPDATE users SET password_hash = ?1 WHERE id = ?2`)
          .bind(await hashPassword(password), existing.id).run();
      } else if (!(await verifyPassword(password, existing.password_hash))) {
        await refuse('wrong_password');
        return json({ error: 'wrong password for that email' }, { status: 401 });
      }
      const { password_hash: _hash, ...account } = existing;
      user = account;
    }

    const token = id() + id().replace(/-/g, '');
    const ttl = Number(env.SESSION_TTL_DAYS ?? '30') * 86400;
    await tolerant(
      () => env.DB.prepare(
        `INSERT INTO sessions (token, user_id, created_at, expires_at, last_seen_at) VALUES (?1, ?2, ?3, ?4, ?3)`
      ).bind(token, user.id, now(), now() + ttl).run(),
      () => env.DB.prepare(
        `INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)`
      ).bind(token, user.id, now(), now() + ttl).run(),
    );
    await tolerant(
      () => env.DB.prepare(`UPDATE users SET last_seen_at = ?1 WHERE id = ?2`).bind(now(), user.id).run(),
      async () => null,
    );

    return json({ token, user: publicUser(user), admin: isAdmin(user), prep: hasPrep(user) });
  },

  /**
   * Makes an account an admin: the one way that happens.
   *
   * Authorised by a secret held by the Worker rather than by a session, since
   * the point is to be usable when no admin can sign in: the address has no
   * account, or has one from before passwords, or has one somebody else
   * registered first. It creates the account if there is none, sets the
   * password either way, and ends every session the account had, so whoever
   * held it before is out. Not something the site calls; the owner runs it,
   * and can unset the secret afterwards to close it.
   */
  'POST /admin/bootstrap': async (req, env) => {
    const secret = env.ADMIN_BOOTSTRAP_SECRET ?? '';
    // A short secret is a guessable one, and this endpoint hands out the site.
    if (secret.length < 24) return json({ error: 'admin bootstrap is not configured' }, { status: 503 });
    if (!sameSecret(bearerOf(req), secret)) return json({ error: 'not permitted' }, { status: 403 });

    const body = await bodyOf<{
      email?: unknown; password?: unknown; displayName?: unknown; revoke?: boolean;
    }>(req);
    const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : '';
    if (!email || !email.includes('@') || email.length > EMAIL_MAX) {
      return json({ error: 'valid email required' }, { status: 400 });
    }

    const existing = await env.DB.prepare(`SELECT id, display_name FROM users WHERE email = ?1`)
      .bind(email).first<{ id: string; display_name: string }>();

    if (body.revoke) {
      if (!existing) return json({ error: 'no account with that email' }, { status: 404 });
      const [, ended] = await env.DB.batch([
        env.DB.prepare(`UPDATE users SET is_admin = 0 WHERE id = ?1`).bind(existing.id),
        env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?1`).bind(existing.id),
      ]);
      await logEvent(env, 'admin.revoked', existing.id, null, {});
      return json({
        ok: true, admin: false,
        user: { id: existing.id, email, display_name: existing.display_name },
        sessions_revoked: ended.meta.changes ?? 0,
      });
    }

    const password = typeof body.password === 'string' ? body.password : '';
    if (password.length < 8) return json({ error: 'password must be at least 8 characters' }, { status: 400 });
    const hash = await hashPassword(password);
    const name = typeof body.displayName === 'string' ? body.displayName.trim().slice(0, 60) : '';

    if (!existing) {
      const uid = id();
      const display = name || email.split('@')[0];
      await env.DB.prepare(
        `INSERT INTO users (id, email, display_name, created_at, rep, password_hash, is_admin)
         VALUES (?1, ?2, ?3, ?4, 0, ?5, 1)`
      ).bind(uid, email, display, now(), hash).run();
      await logEvent(env, 'admin.granted', uid, null, { created: true });
      return json({
        ok: true, created: true, admin: true,
        user: { id: uid, email, display_name: display }, sessions_revoked: 0,
      }, { status: 201 });
    }

    const [, ended] = await env.DB.batch([
      env.DB.prepare(
        `UPDATE users SET is_admin = 1, password_hash = ?1, display_name = COALESCE(?2, display_name) WHERE id = ?3`
      ).bind(hash, name || null, existing.id),
      env.DB.prepare(`DELETE FROM sessions WHERE user_id = ?1`).bind(existing.id),
    ]);
    await logEvent(env, 'admin.granted', existing.id, null, { created: false });
    return json({
      ok: true, created: false, admin: true,
      user: { id: existing.id, email, display_name: name || existing.display_name },
      sessions_revoked: ended.meta.changes ?? 0,
    });
  },

  // Anonymous telemetry: what people search for and which rounds they open.
  'POST /events': async (req, env, _url, user) => {
    const body = await bodyOf<{ kind?: unknown; slug?: unknown; payload?: unknown }>(req);
    const kind = String(body.kind ?? '');
    if (!PUBLIC_EVENTS.has(kind)) return json({ error: 'unknown event' }, { status: 400 });
    // Every field stored here is bounded: the kind by the list above, the
    // payload by fitPayload, and the slug here. Anyone can post these, and a
    // field kept at whatever length it arrived is a way to fill the database.
    const slug = typeof body.slug === 'string' && body.slug ? body.slug.slice(0, EVENT_SLUG_MAX) : null;
    const payload = fitPayload(body.payload);
    await env.DB.prepare(
      `INSERT INTO events (kind, user_id, slug, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5)`
    ).bind(kind, user?.id ?? null, slug, payload, now()).run();
    return json({ ok: true });
  },

  'GET /admin/stats': async (_req, env, url, user) => {
    if (!isAdmin(user)) return json({ error: 'not permitted' }, { status: 403 });
    const days = Math.min(Math.max(Number(url.searchParams.get('days') ?? 30) || 30, 1), 365);
    const since = now() - days * 86400;

    const q = (sql: string, ...binds: unknown[]) =>
      env.DB.prepare(sql).bind(...binds).all().then(r => r.results);

    const [searches, tags, rounds, daily, kinds, totals, contributors] = await Promise.all([
      // json_extract raises on a payload that is not JSON, and one such row
      // fails the whole query, so each row is checked before it is read. New
      // payloads are always JSON; the check is for the ones already stored.
      q(`SELECT term, COUNT(*) AS n FROM (
           SELECT CASE WHEN json_valid(payload) THEN json_extract(payload,'$.q') END AS term
             FROM events WHERE kind IN ('search','transcript.search') AND created_at > ?1
         ) WHERE term IS NOT NULL AND term != ''
          GROUP BY term ORDER BY n DESC LIMIT 25`, since),
      q(`SELECT tag, COUNT(*) AS n FROM user_tags GROUP BY tag ORDER BY n DESC LIMIT 25`),
      q(`SELECT slug, COUNT(*) AS n FROM events
          WHERE kind='round.view' AND created_at > ?1 AND slug IS NOT NULL
          GROUP BY slug ORDER BY n DESC LIMIT 25`, since),
      q(`SELECT CAST(created_at/86400 AS INTEGER) AS day, COUNT(*) AS n
           FROM events WHERE created_at > ?1 GROUP BY day ORDER BY day`, since),
      q(`SELECT kind, COUNT(*) AS n FROM events WHERE created_at > ?1
          GROUP BY kind ORDER BY n DESC`, since),
      q(`SELECT
           (SELECT COUNT(*) FROM users) AS users,
           (SELECT COUNT(*) FROM proposals) AS proposals,
           (SELECT COUNT(*) FROM proposals WHERE status='accepted') AS accepted,
           (SELECT COUNT(*) FROM votes) AS votes,
           (SELECT COUNT(*) FROM notes) AS notes,
           (SELECT COUNT(*) FROM favorites) AS favorites,
           (SELECT COUNT(*) FROM events) AS events,
           (SELECT COUNT(*) FROM ratings) AS ratings,
           (SELECT COUNT(*) FROM submissions) AS submissions,
           (SELECT COUNT(*) FROM sessions WHERE expires_at > ?1) AS sessions_active,
           (SELECT COUNT(*) FROM users WHERE prep_access = 1) AS prep_users,
           (SELECT COUNT(*) FROM events WHERE kind = 'auth.failed' AND created_at > ?2) AS auth_failed`,
        now(), since),
      q(`SELECT u.display_name AS name, u.rep,
                (SELECT COUNT(*) FROM proposals p WHERE p.user_id=u.id) AS proposals
           FROM users u ORDER BY u.rep DESC, proposals DESC LIMIT 15`),
    ]);

    return json({ days, searches, tags, rounds, daily, kinds, totals: totals[0] ?? {}, contributors });
  },

  // A live tail of what is happening, attributed where an account was signed in.
  'GET /admin/events': async (_req, env, url, user) => {
    if (!isAdmin(user)) return json({ error: 'not permitted' }, { status: 403 });
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 60) || 60, 1), 200);
    const since = Number(url.searchParams.get('since') ?? '0') || 0;
    // Narrowing by kind, round or person, and paging back past the newest
    // page. An absent filter is passed as null and matches everything.
    const before = Number(url.searchParams.get('before') ?? '0') || 0;
    const { results } = await env.DB.prepare(
      `SELECT e.id, e.kind, e.slug, e.payload, e.created_at, e.user_id,
              COALESCE(u.display_name, 'guest') AS who
         FROM events e LEFT JOIN users u ON u.id = e.user_id
        WHERE e.id > ?1
          AND (?3 = 0 OR e.id < ?3)
          AND (?4 IS NULL OR e.kind = ?4)
          AND (?5 IS NULL OR e.slug = ?5)
          AND (?6 IS NULL OR e.user_id = ?6)
        ORDER BY e.id DESC LIMIT ?2`
    ).bind(since, limit, before, url.searchParams.get('kind'), url.searchParams.get('slug'),
      url.searchParams.get('user')).all();
    return json({ events: results });
  },

  'GET /admin/proposals': async (_req, env, _url, user) => {
    if (!isAdmin(user)) return json({ error: 'not permitted' }, { status: 403 });
    const { results } = await env.DB.prepare(
      `SELECT p.id, p.slug, p.kind, p.anchor, p.start_s, p.end_s, p.original, p.proposed, p.note,
              p.score, p.status, p.created_at, u.display_name AS author, p.user_id AS author_id
         FROM proposals p JOIN users u ON u.id = p.user_id
        WHERE p.status = 'open'
        ORDER BY p.score DESC, p.created_at ASC LIMIT 100`
    ).all();
    return json({ proposals: results });
  },

  /**
   * Proposals that have been settled, with what they said.
   *
   * The list above is only what is still open. Once a proposal was accepted
   * or rejected it left the page for good, text and all, and "what did we
   * change, and who decided" had no answer short of the database.
   */
  'GET /admin/proposals/history': async (_req, env, url, user) => {
    if (!isAdmin(user)) return json({ error: 'not permitted' }, { status: 403 });
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 50) || 50, 1), 200);
    const offset = Math.max(Number(url.searchParams.get('offset') ?? 0) || 0, 0);
    const wanted = url.searchParams.get('status');
    const status = wanted && ['accepted', 'rejected', 'superseded'].includes(wanted) ? wanted : null;
    const slug = url.searchParams.get('slug') || null;
    const by = url.searchParams.get('user') || null;

    const where = `WHERE p.status != 'open' AND (?1 IS NULL OR p.status = ?1)
                     AND (?2 IS NULL OR p.slug = ?2) AND (?3 IS NULL OR p.user_id = ?3)`;
    const [{ results }, total] = await Promise.all([
      env.DB.prepare(
        `SELECT p.id, p.slug, p.kind, p.anchor, p.start_s, p.end_s, p.original, p.proposed, p.note,
                p.score, p.status, p.created_at, u.display_name AS author, p.user_id AS author_id,
                (SELECT MAX(applied_at) FROM revisions WHERE proposal_id = p.id) AS applied_at
           FROM proposals p JOIN users u ON u.id = p.user_id ${where}
          ORDER BY p.created_at DESC LIMIT ?4 OFFSET ?5`
      ).bind(status, slug, by, limit, offset).all<any>(),
      env.DB.prepare(`SELECT COUNT(*) AS n FROM proposals p ${where}`).bind(status, slug, by).first<{ n: number }>(),
    ]);

    // When each was settled, and how, is only in the event that recorded it.
    // Those name the proposal inside their payload, under one of two keys, so
    // they are fetched by round and matched here.
    const settled = new Map<string, { at: number; how: string; who: string | null }>();
    const slugs = [...new Set(results.map(p => p.slug as string))];
    for (let i = 0; i < slugs.length; i += 80) {
      const chunk = slugs.slice(i, i + 80);
      const { results: events } = await env.DB.prepare(
        `SELECT e.kind, e.payload, e.created_at, u.display_name AS who
           FROM events e LEFT JOIN users u ON u.id = e.user_id
          WHERE e.kind IN ('proposal.accepted', 'proposal.rejected')
            AND e.slug IN (${chunk.map((_, n) => `?${n + 1}`).join(',')})
          ORDER BY e.id ASC`
      ).bind(...chunk).all<{ kind: string; payload: string; created_at: number; who: string | null }>();
      for (const e of events) {
        let payload: any = {};
        try { payload = JSON.parse(e.payload ?? '{}'); } catch { continue; }
        const pid = payload.pid ?? payload.proposalId;
        if (typeof pid !== 'string') continue;
        // A rejection is always an admin's; an acceptance is one when it says so.
        const admin = e.kind === 'proposal.rejected' || Boolean(payload.by);
        settled.set(pid, { at: e.created_at, how: admin ? 'admin' : 'votes', who: admin ? e.who : null });
      }
    }

    const proposals = results.map(({ applied_at, ...p }) => {
      const end = settled.get(p.id);
      return {
        ...p,
        resolved_at: end?.at ?? applied_at ?? null,
        resolved_how: end?.how ?? null,
        resolved_by: end?.who ?? null,
      };
    });
    return json({ total: total?.n ?? 0, proposals });
  },

  /**
   * Every accepted correction, newest first, across all rounds: what readers
   * are actually shown in place of the machine's text, who proposed it, and
   * what it replaced.
   */
  'GET /admin/revisions': async (_req, env, url, user) => {
    if (!isAdmin(user)) return json({ error: 'not permitted' }, { status: 403 });
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 50) || 50, 1), 200);
    const offset = Math.max(Number(url.searchParams.get('offset') ?? 0) || 0, 0);
    const slug = url.searchParams.get('slug') || null;
    const [{ results }, total] = await Promise.all([
      env.DB.prepare(
        `SELECT r.id, r.slug, r.kind, r.anchor, r.value, r.proposal_id, r.applied_at,
                p.original, p.start_s, p.end_s, p.user_id AS author_id, u.display_name AS author
           FROM revisions r
           LEFT JOIN proposals p ON p.id = r.proposal_id
           LEFT JOIN users u ON u.id = p.user_id
          WHERE (?1 IS NULL OR r.slug = ?1)
          ORDER BY r.applied_at DESC, r.id DESC LIMIT ?2 OFFSET ?3`
      ).bind(slug, limit, offset).all(),
      env.DB.prepare(`SELECT COUNT(*) AS n FROM revisions r WHERE (?1 IS NULL OR r.slug = ?1)`)
        .bind(slug).first<{ n: number }>(),
    ]);
    return json({ total: total?.n ?? 0, revisions: results });
  },

  /** Admin override: accept or reject without waiting for the vote threshold. */
  'POST /admin/proposals/:id/resolve': async (req, env, url, user) => {
    if (!isAdmin(user)) return json({ error: 'not permitted' }, { status: 403 });
    const pid = url.pathname.split('/')[3];
    const { action } = await bodyOf<{ action?: string }>(req);
    if (action !== 'accept' && action !== 'reject') {
      return json({ error: 'action must be accept or reject' }, { status: 400 });
    }

    const proposal = await env.DB.prepare(`SELECT * FROM proposals WHERE id = ?1`)
      .bind(pid).first<any>();
    if (!proposal) return json({ error: 'no such proposal' }, { status: 404 });
    if (proposal.status !== 'open') return json({ error: 'already resolved' }, { status: 409 });

    if (action === 'reject') {
      await env.DB.prepare(`UPDATE proposals SET status = 'rejected' WHERE id = ?1`).bind(pid).run();
      await logEvent(env, 'proposal.rejected', user!.id, proposal.slug, { pid });
      return json({ ok: true, status: 'rejected' });
    }

    await acceptProposal(env, proposal);
    await logEvent(env, 'proposal.accepted', user!.id, proposal.slug, { pid, by: 'admin' });
    return json({ ok: true, status: 'accepted' });
  },

  /**
   * The accounts, each with what it has done.
   *
   * The dashboard had a count of users and the top fifteen by reputation,
   * which answers neither "who is this" nor "who signed up last week".
   */
  'GET /admin/users': async (_req, env, url, user) => {
    if (!isAdmin(user)) return json({ error: 'not permitted' }, { status: 403 });
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 100) || 100, 1), 500);
    const offset = Math.max(Number(url.searchParams.get('offset') ?? 0) || 0, 0);
    const q = (url.searchParams.get('q') ?? '').trim().toLowerCase() || null;
    const prepOnly = url.searchParams.get('prep') === '1' ? 1 : 0;
    const adminOnly = url.searchParams.get('admin') === '1' ? 1 : 0;
    // Chosen from a fixed set, never passed through: this is spliced into SQL.
    const order = ({
      created: 'u.created_at DESC',
      seen: 'last_seen_at DESC, u.created_at DESC',
      rep: 'u.rep DESC, u.created_at DESC',
      name: 'lower(u.display_name) ASC',
    } as Record<string, string>)[url.searchParams.get('sort') ?? 'created'] ?? 'u.created_at DESC';

    const where = `WHERE (?1 IS NULL OR instr(lower(u.email), ?1) > 0 OR instr(lower(u.display_name), ?1) > 0)
                     AND (?2 = 0 OR u.prep_access = 1) AND (?3 = 0 OR u.is_admin = 1)`;
    const [{ results }, total] = await Promise.all([
      env.DB.prepare(`${userSelect()} ${where} ORDER BY ${order} LIMIT ?4 OFFSET ?5`)
        .bind(q, prepOnly, adminOnly, limit, offset).all<any>(),
      env.DB.prepare(`SELECT COUNT(*) AS n FROM users u ${where}`)
        .bind(q, prepOnly, adminOnly).first<{ n: number }>(),
    ]);
    return json({ total: total?.n ?? 0, users: results.map(userRow) });
  },

  /**
   * One account: the same row as the list, with its sessions and the
   * sign-ins refused under its address. Found by id or by email.
   */
  'GET /admin/users/:id': async (_req, env, url, user) => {
    if (!isAdmin(user)) return json({ error: 'not permitted' }, { status: 403 });
    const ref = segment(url, 3)?.trim() ?? '';
    const found = await env.DB.prepare(
      `${userSelect()} WHERE u.id = ?1 OR u.email = lower(?1) LIMIT 1`
    ).bind(ref).first<any>();
    if (!found) return json({ error: 'no such account' }, { status: 404 });

    const t = now();
    const [{ results: sessions }, { results: failures }] = await Promise.all([
      env.DB.prepare(
        `SELECT created_at, COALESCE(last_seen_at, created_at) AS last_seen_at, expires_at,
                (expires_at > ?2) AS active
           FROM sessions WHERE user_id = ?1 ORDER BY created_at DESC LIMIT 50`
      ).bind(found.id, t).all<any>(),
      env.DB.prepare(
        `SELECT e.id, e.created_at,
                COALESCE(CASE WHEN json_valid(e.payload) THEN json_extract(e.payload,'$.reason') END, 'wrong_password') AS reason
           FROM events e
          WHERE e.kind = 'auth.failed'
            AND (e.user_id = ?1 OR CASE WHEN json_valid(e.payload) THEN json_extract(e.payload,'$.email') END = ?2)
          ORDER BY e.id DESC LIMIT 20`
      ).bind(found.id, found.email).all(),
    ]);
    return json({
      user: userRow(found),
      sessions: sessions.map(s => ({ ...s, active: Boolean(s.active) })),
      auth_failures: failures,
    });
  },

  /** How many people are signed in and how recently they were here. No tokens. */
  'GET /admin/sessions': async (_req, env, _url, user) => {
    if (!isAdmin(user)) return json({ error: 'not permitted' }, { status: 403 });
    const t = now();
    const [counts, { results: recent }] = await Promise.all([
      env.DB.prepare(
        `SELECT
           (SELECT COUNT(*) FROM sessions WHERE expires_at > ?1) AS active,
           (SELECT COUNT(DISTINCT user_id) FROM sessions WHERE expires_at > ?1) AS active_users,
           (SELECT COUNT(*) FROM sessions WHERE expires_at <= ?1) AS expired,
           (SELECT COUNT(*) FROM users WHERE last_seen_at > ?1 - 86400) AS seen_h24,
           (SELECT COUNT(*) FROM users WHERE last_seen_at > ?1 - 7 * 86400) AS seen_d7,
           (SELECT COUNT(*) FROM users WHERE last_seen_at > ?1 - 30 * 86400) AS seen_d30,
           (SELECT COUNT(*) FROM sessions WHERE created_at > ?1 - 86400) AS in_h24,
           (SELECT COUNT(*) FROM sessions WHERE created_at > ?1 - 7 * 86400) AS in_d7,
           (SELECT COUNT(*) FROM sessions WHERE created_at > ?1 - 30 * 86400) AS in_d30`
      ).bind(t).first<Record<string, number>>(),
      env.DB.prepare(
        `SELECT s.user_id, u.email, u.display_name, s.created_at,
                COALESCE(s.last_seen_at, s.created_at) AS last_seen_at, s.expires_at
           FROM sessions s JOIN users u ON u.id = s.user_id
          WHERE s.expires_at > ?1
          ORDER BY COALESCE(s.last_seen_at, s.created_at) DESC LIMIT 50`
      ).bind(t).all(),
    ]);
    const c = counts ?? {};
    return json({
      active: c.active ?? 0, active_users: c.active_users ?? 0, expired: c.expired ?? 0,
      seen: { h24: c.seen_h24 ?? 0, d7: c.seen_d7 ?? 0, d30: c.seen_d30 ?? 0 },
      signins: { h24: c.in_h24 ?? 0, d7: c.in_d7 ?? 0, d30: c.in_d30 ?? 0 },
      recent,
    });
  },

  /**
   * Sign-ins that were refused: who was tried, when, and why.
   *
   * These were recorded as a bare event and shown as one bar among the event
   * kinds. A wrong password now and then is somebody's memory; forty against
   * one address is somebody else's.
   */
  'GET /admin/auth-failures': async (_req, env, url, user) => {
    if (!isAdmin(user)) return json({ error: 'not permitted' }, { status: 403 });
    const days = Math.min(Math.max(Number(url.searchParams.get('days') ?? 30) || 30, 1), 365);
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 100) || 100, 1), 500);
    const since = now() - days * 86400;

    // Older rows carry no payload worth reading: the address is the account's
    // and the reason was always a wrong password, the only one then recorded.
    const failed = `SELECT e.id, e.created_at, e.user_id, u.display_name,
                           COALESCE(CASE WHEN json_valid(e.payload) THEN json_extract(e.payload,'$.email') END, u.email) AS email,
                           COALESCE(CASE WHEN json_valid(e.payload) THEN json_extract(e.payload,'$.reason') END, 'wrong_password') AS reason
                      FROM events e LEFT JOIN users u ON u.id = e.user_id
                     WHERE e.kind = 'auth.failed' AND e.created_at > ?1`;
    const [{ results: failures }, { results: byEmail }, total] = await Promise.all([
      env.DB.prepare(`${failed} ORDER BY e.id DESC LIMIT ?2`).bind(since, limit).all(),
      env.DB.prepare(
        `SELECT f.email, COUNT(*) AS n, MAX(f.created_at) AS last_at,
                EXISTS (SELECT 1 FROM users WHERE email = f.email) AS known
           FROM (${failed}) f GROUP BY f.email ORDER BY n DESC, last_at DESC LIMIT 50`
      ).bind(since).all<any>(),
      env.DB.prepare(`SELECT COUNT(*) AS n FROM events WHERE kind = 'auth.failed' AND created_at > ?1`)
        .bind(since).first<{ n: number }>(),
    ]);
    return json({
      days,
      total: total?.n ?? 0,
      by_email: byEmail.map(r => ({ ...r, known: Boolean(r.known) })),
      failures,
    });
  },

  /**
   * Every round there is, and what each one has.
   *
   * A round is known three ways that do not always agree: search has a record
   * of it, somebody submitted it, or files for it sit in the bucket. Listing
   * the union is what shows the disagreements: a round in search with no
   * audio, audio that belongs to no round.
   *
   * Whether a round has a page is a fact about the built site. For submitted
   * rounds the site is asked (a few each call, and the answers are kept); for
   * the rest it is worked out, since every round in search when the site was
   * last built got a page, and it says which of the two it was.
   */
  'GET /admin/rounds': async (_req, env, url, user) => {
    if (!isAdmin(user)) return json({ error: 'not permitted' }, { status: 403 });

    const [listed, { results: subs }, deploy] = await Promise.all([
      mediaListing(env),
      env.DB.prepare(`${SUBMISSION_SELECT} ORDER BY s.created_at DESC`).all<SubmissionRow>(),
      deployedAt(env, '/recordings/'),
    ]);
    const lastDeployAt = deploy?.exists ? deploy.builtAt : null;

    // The whole index, a thousand at a time; search stops at a thousand hits,
    // browsing does not.
    const records: any[] = [];
    let indexError: string | null = null;
    try {
      let cursor: string | undefined;
      for (let page = 0; page < 30; page++) {
        const res = await algolia(env, `${env.ALGOLIA_INDEX}/browse`, {
          method: 'POST',
          body: JSON.stringify(cursor ? { cursor } : {
            hitsPerPage: 1000,
            attributesToRetrieve: ['title', 'slug', 'year', 'tournament', 'format', 'level', 'link'],
          }),
        });
        if (!res.ok) throw new Error(`the search index answered ${res.status}`);
        const body = await jsonWithin<{ hits: any[]; cursor?: string }>(res, MANY_RECORDS_BYTES);
        records.push(...(body.hits ?? []));
        cursor = body.cursor;
        if (!cursor) break;
      }
    } catch (e: any) {
      indexError = `The search index could not be read (${String(e?.message ?? e).slice(0, 120)}); this list is submissions and stored files only.`;
    }

    const filesOf = (slug: string): Media => ({
      audio: listed.audio.get(slug) ?? null, peaks: listed.peaks.get(slug) ?? null,
      transcript: listed.transcript.get(slug) ?? null, speeches: listed.speeches.get(slug) ?? null,
    });
    const subById = new Map(subs.map(s => [s.object_id, s]));

    // A few each call: every one is a request to the site and a write, and a
    // Worker is allowed only so many of those per request. The answers are
    // kept, so the next call asks about the next few.
    let asks = 10;
    const pageOf = async (sub: SubmissionRow | undefined, files: Media, inSearch: boolean) => {
      if (sub && sub.review !== 'removed') {
        if (sub.page_at) return { has_page: true, page_verified: true };
        if (asks > 0) {
          asks--;
          const state = await pageNow(env, sub, files);
          if (sub.page_checked_at) return { has_page: state.exists, page_verified: true };
        }
        return { has_page: lastDeployAt ? sub.created_at <= lastDeployAt : null, page_verified: false };
      }
      if (!inSearch) return { has_page: false, page_verified: false };
      return { has_page: lastDeployAt ? true : null, page_verified: false };
    };

    const rounds: any[] = [];
    const seen = new Set<string>();
    const add = async (source: string, slug: string, fields: Record<string, unknown>, sub: SubmissionRow | undefined) => {
      seen.add(slug);
      const files = filesOf(slug);
      rounds.push({
        object_id: null, slug, title: null, year: null, tournament: null, format: null, level: null, link: null,
        ...fields,
        source,
        has_audio: files.audio !== null, has_peaks: files.peaks !== null,
        has_transcript: files.transcript !== null, has_speeches: files.speeches !== null,
        ...(await pageOf(sub, files, source === 'index')),
        // Search keeps no dates. A submitted round was added when it was
        // submitted; for the rest the nearest thing is when its first file
        // reached the bucket.
        added_at: sub?.created_at
          ?? ([files.audio, files.peaks, files.transcript, files.speeches]
            .filter((n): n is number => n !== null).sort((a, b) => a - b)[0] ?? null),
        audio_at: files.audio, transcript_at: files.transcript, speeches_at: files.speeches,
        page_at: sub?.page_at ?? null,
        submission: sub
          ? { object_id: sub.object_id, status: sub.status, review: sub.review, created_at: sub.created_at }
          : null,
      });
    };

    const inIndex = new Set<string>();
    for (const r of records) {
      inIndex.add(r.objectID);
      await add('index', r.slug || slugFor(r.title ?? '', r.objectID), {
        object_id: r.objectID, title: r.title ?? null, year: r.year || null,
        tournament: r.tournament || null, format: r.format ?? null, level: r.level ?? null, link: r.link ?? null,
      }, subById.get(r.objectID));
    }
    for (const s of subs) {
      if (inIndex.has(s.object_id)) continue;
      await add('submission', s.slug, {
        object_id: s.object_id, title: s.title, year: s.year, tournament: s.tournament, link: s.link,
      }, s);
    }
    for (const kind of MEDIA_KINDS) {
      for (const slug of listed[kind].keys()) {
        if (!seen.has(slug)) await add('media', slug, {}, undefined);
      }
    }

    const counts = {
      audio: rounds.filter(r => r.has_audio).length,
      transcript: rounds.filter(r => r.has_transcript).length,
      speeches: rounds.filter(r => r.has_speeches).length,
      page: rounds.filter(r => r.has_page).length,
      orphans: rounds.filter(r => r.source === 'media').length,
    };

    const missing = url.searchParams.get('missing');
    const q = (url.searchParams.get('q') ?? '').trim().toLowerCase();
    const lacks: Record<string, (r: any) => boolean> = {
      audio: r => !r.has_audio, transcript: r => !r.has_transcript,
      speeches: r => !r.has_speeches, page: r => r.has_page === false,
    };
    const shown = rounds
      .filter(r => !missing || !lacks[missing] || lacks[missing](r))
      .filter(r => !q || `${r.title ?? ''} ${r.slug}`.toLowerCase().includes(q));

    return json({
      generated_at: now(),
      index_error: indexError,
      site: { last_deploy_at: lastDeployAt },
      total: shown.length,
      counts,
      rounds: shown,
    });
  },

  'POST /admin/prep/grant': (req, env, _url, user) => setPrepAccess(req, env, user, true),
  'POST /admin/prep/revoke': (req, env, _url, user) => setPrepAccess(req, env, user, false),

  /**
   * A search key for the prep index, for an account that has been let in.
   *
   * The prep index is private, so its key cannot ship in the page the way the
   * public one does. The parent key stays here; what a browser gets works for
   * that one index, for a few hours, and carries the account's id so what it
   * is used for can be attributed.
   *
   * Refused with 403 either way, and a reason, because the site's client
   * reads a 401 as "the session has gone" and signs the person out.
   */
  'GET /prep/key': async (_req, env, _url, user) => {
    if (!user) return json({ error: 'sign in required', reason: 'signed_out' }, { status: 403 });
    if (!hasPrep(user)) {
      return json({ error: 'this account does not have prep access', reason: 'not_allowed' }, { status: 403 });
    }
    // The write key must never be a parent: a key derived from it is still a
    // search key, but it would be one mistake away from not being.
    const parent = env.ALGOLIA_PREP_KEY ?? '';
    if (!parent || !env.ALGOLIA_PREP_INDEX || parent === env.ALGOLIA_ADMIN_KEY) {
      return json({ error: 'prep search is not configured' }, { status: 503 });
    }

    const validUntil = now() + PREP_KEY_TTL_S;
    const key = await securedSearchKey(parent, env.ALGOLIA_PREP_INDEX, user.id, validUntil);
    await logEvent(env, 'prep.key', user.id, null, {});
    return json(
      { appId: env.ALGOLIA_APP_ID, indexName: env.ALGOLIA_PREP_INDEX, key, validUntil },
      {}, { 'Cache-Control': 'no-store' },
    );
  },

  'GET /me': async (_req, _env, _url, user) =>
    user
      ? json({ user: publicUser(user), admin: isAdmin(user), prep: hasPrep(user) })
      : json({ error: 'not signed in' }, { status: 401 }),

  'GET /rounds/:slug/proposals': async (_req, env, url) => {
    const slug = url.pathname.split('/')[2];
    const { results } = await env.DB.prepare(
      `SELECT p.id, p.kind, p.anchor, p.start_s, p.end_s, p.original, p.proposed,
              p.note, p.score, p.status, p.created_at, u.display_name AS author,
              p.user_id AS author_id
         FROM proposals p JOIN users u ON u.id = p.user_id
        WHERE p.slug = ?1 ORDER BY p.score DESC, p.created_at ASC`
    ).bind(slug).all();
    return json({ proposals: results });
  },

  /**
   * Submits a round.
   *
   * The write key used to sit in the page, which meant anyone could rewrite or
   * empty the index, and an empty form submitted happily and reported success.
   * Submission is now attributable, validated, and checked against the source
   * actually playing something before it reaches search: a round matched to a
   * dead or wrong link is the failure that cost eighteen rounds their audio.
   */
  'POST /recordings': async (req, env, _url, user) => {
    if (!user) return json({ error: 'sign in to submit a recording' }, { status: 401 });

    const body = await bodyOf<any>(req);
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    const title = str(body.title);
    const link = str(body.link);
    const year = str(body.year);
    const decision = str(body.decision);
    const format = str(body.format);
    const level = str(body.level);
    const tags: string[] = Array.isArray(body.tags)
      ? body.tags.map(str).filter((t: string) => t.startsWith('#'))
      : [];

    const errors: Record<string, string> = {};
    if (!title) errors.title = 'A round title is required';
    else if (title.length > 200) errors.title = 'That title is too long';
    if (!link) errors.link = 'A link to the recording is required';
    else if (!/^https?:\/\//i.test(link)) errors.link = 'That does not look like a URL';
    if (year && !/^\d{4}-\d{2}$/.test(year)) errors.year = 'Expected a season like 2020-21';
    // The default view is parli only, so an unlabelled round would land in the
    // index and show up in nobody's list. Ask rather than guess a label.
    if (!FORMATS.includes(format)) errors.format = 'Choose parli or policy';
    if (!LEVELS.includes(level)) errors.level = 'Choose college or high school';
    if (decision && !/^(\d+-\d+\s+(aff|neg)|aff|neg|\d+-\d+\s+split)$/i.test(decision)) {
      errors.decision = 'Expected Aff, Neg, 3-0 Aff, or 1-1 Split';
    }
    if (Object.keys(errors).length) return json({ errors }, { status: 400 });

    const norm = title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
    const tournament = str(body.tournament);
    // The same round is the same title in the same season at the same
    // tournament. Tournament is compared because the same two teams do meet
    // twice in a season at the same stage, and a blank one matches anything
    // because half the submissions leave it out.
    const { results: same } = await env.DB.prepare(
      `SELECT object_id, slug, status, review, user_id FROM submissions
        WHERE lower(title) = ?1 AND COALESCE(year,'') = ?2
          AND (?3 = '' OR COALESCE(tournament,'') = '' OR lower(tournament) = ?3)
        ORDER BY created_at DESC`
    ).bind(title.toLowerCase(), year, tournament.toLowerCase())
      .all<{ object_id: string; slug: string; status: string; review: string; user_id: string | null }>();
    const duplicate = (r: { object_id: string; slug: string; status: string; review: string }) => json({
      errors: { title: 'That round has already been submitted' },
      existing: { objectID: r.object_id, slug: r.slug, status: r.review === 'removed' ? 'removed' : r.status },
    }, { status: 409 });

    const kept = same.filter(r => r.review !== 'removed');
    const live = kept.find(r => r.status !== 'failed');
    if (live) return duplicate(live);

    // A round that failed, or was removed, is still somebody's round. Its
    // submitter, or an admin, may send it in again: a failed one with a link
    // that might work, a removed one as a new round. Anybody else is told it
    // exists and changes nothing. Sending it in again replaces its link and
    // its record and deletes what was stored for it, so letting any account
    // do that let any account put its own recording on somebody else's page.
    const theirs = (r: { user_id: string | null }) => r.user_id === user.id || isAdmin(user);
    const failedRows = kept.filter(r => r.status === 'failed');
    const failed = failedRows.find(theirs) ?? null;
    if (!failed && failedRows.length) return duplicate(failedRows[0]);
    const removedRows = same.filter(r => r.review === 'removed');
    if (!failed && removedRows.length && !removedRows.some(theirs)) return duplicate(removedRows[0]);

    // Each submission is a public search record, a download and, often, a
    // site build, so one account gets so many an hour and a day. Counted from
    // the log, where every accepted submission and resubmission is written.
    if (!isAdmin(user)) {
      const perHour = Number(env.SUBMISSIONS_PER_HOUR) || SUBMISSIONS_PER_HOUR;
      const perDay = Number(env.SUBMISSIONS_PER_DAY) || SUBMISSIONS_PER_DAY;
      const count = await env.DB.prepare(
        `SELECT COALESCE(SUM(created_at > ?2), 0) AS hour, COUNT(*) AS day FROM events
          WHERE user_id = ?1 AND kind IN ('recording.submitted', 'recording.resubmitted') AND created_at > ?3`
      ).bind(user.id, now() - 3600, now() - 86400).first<{ hour: number; day: number }>();
      const over = (count?.hour ?? 0) >= perHour ? `${perHour} rounds in an hour`
        : (count?.day ?? 0) >= perDay ? `${perDay} rounds in a day` : null;
      if (over) {
        return json(
          { error: `One account can send in at most ${over}. Try again later, or ask Tejas if you have more to add.` },
          { status: 429 }, { 'Retry-After': (count?.hour ?? 0) >= perHour ? '3600' : '86400' },
        );
      }
    }

    // Does the link actually serve a recording? A range GET, because Dropbox
    // answers HEAD with the content type of its own web page.
    const probe = await probeMedia(env, link);
    if (!probe.ok) {
      return json({ errors: { link: probe.reason } }, { status: 400 });
    }

    const { objectID, slug } = failed
      ? { objectID: failed.object_id, slug: failed.slug }
      : await newSubmissionId(env, title);

    const record = {
      objectID, title, link,
      // The slug travels with the round rather than being derived from its
      // title on the way out, so the title can be corrected later without
      // moving the page or orphaning the audio filed under the old name.
      slug,
      resolution: str(body.resolution),
      aff: described(str(body.aff)),
      neg: described(str(body.neg)),
      _tags: tags,
      searchable_tags: tags,
      decision, year, format, level,
      tournament,
      teams: [],
      aff_type: tags.includes('#k-aff') ? 'k-aff'
        : tags.includes('#performance') ? 'performance' : 'topical',
      neg_strategy_count: Number(str(body.neg).match(/(\d+)-off/i)?.[1]) || null,
    };
    const toSearch = () => algolia(env, `${env.ALGOLIA_INDEX}/${objectID}`, {
      method: 'PUT', body: JSON.stringify(record),
    }).catch(() => null);

    // What search is given, kept on the row as well: search forgets a round
    // the moment it is removed, and that is when its details are wanted back.
    const details = JSON.stringify({
      format, level, resolution: record.resolution, aff: record.aff, neg: record.neg, decision, tags,
    });

    if (failed) {
      const res = await toSearch();
      if (!res?.ok) {
        return json({ error: `search index rejected the round (${res?.status ?? 'unreachable'})` }, { status: 502 });
      }
      await env.DB.prepare(
        `UPDATE submissions SET title = ?1, year = ?2, tournament = ?3, details = ?4 WHERE object_id = ?5`
      ).bind(title, year || null, tournament || null, details, objectID).run();
      await requeue(env, { object_id: objectID, slug }, 'submitted again', link);
      await logEvent(env, 'recording.resubmitted', user.id, slug, { objectID, norm });
      return json({ objectID, slug, status: 'pending', probe: probe.info, resubmitted: true, rebuilding: false });
    }

    // The row first, search second. The other way round, a failed insert left
    // a card in search that no queue knew about: never ingested, invisible to
    // the admin page, and no bar to the retry that then made a second card.
    //
    // Pending until its audio is in R2: appearing in search is not the same as
    // being playable, and the ingest run reads this to know what is owed.
    await env.DB.prepare(
      `INSERT INTO submissions (object_id, slug, title, link, year, tournament, user_id, status, created_at, updated_at, details)
       VALUES (?1,?2,?3,?4,?5,?6,?7,'pending',?8,?8,?9)`
    ).bind(objectID, slug, title, link, year || null, tournament || null,
      user.id, now(), details).run();

    const res = await toSearch();
    if (!res?.ok) {
      await env.DB.prepare(`DELETE FROM submissions WHERE object_id = ?1`).bind(objectID).run();
      return json({ error: `search index rejected the round (${res?.status ?? 'unreachable'})` }, { status: 502 });
    }

    await recordIngest(env, objectID, slug, 'audio', 'queued', 'submitted');
    // The round is in search from this moment and its card links to a page
    // that only a build creates, so the build is asked for now rather than
    // left to the run that fetches the audio.
    //
    // Unless one was asked for in the last few minutes. Every submission
    // used to start a full build and deploy of its own, so twenty in a row
    // were twenty builds. The rounds a recent build misses are pending, and
    // the ingest run that fetches their audio, within fifteen minutes, builds
    // the site anyway; `rebuilding` is false for them, and their page comes
    // with that run.
    const { rebuild_requested_at: lastBuild } = await readState(env);
    const recent = (lastBuild ?? 0) > now() - REBUILD_COALESCE_S;
    const rebuilding = recent ? false : await requestRebuild(env, `submitted ${slug}`);
    await logEvent(env, 'recording.submitted', user.id, slug, { objectID, norm });
    return json({ objectID, slug, status: 'pending', probe: probe.info, resubmitted: false, rebuilding },
      { status: 201 });
  },

  /** What has been submitted but not yet ingested. Drives the onboarding run. */
  'GET /recordings/pending': async (_req, env) => {
    // `attempt` names this time round the queue, for the run to hand back
    // with what it found: the id of the row that last queued the audio.
    const { results } = await env.DB.prepare(
      `SELECT s.object_id, s.slug, s.title, s.link, s.year, s.tournament, s.created_at,
              u.display_name AS author,
              (SELECT MAX(e.id) FROM ingest_events e
                WHERE e.slug = s.slug AND e.stage = 'audio' AND e.state = 'queued') AS attempt
         FROM submissions s
         LEFT JOIN users u ON u.id = s.user_id
        WHERE s.status = 'pending' AND s.review != 'removed'
        ORDER BY s.created_at ASC`
    ).all();
    return json({ pending: results });
  },

  /**
   * Every submission and where it has got to, for the admin page. A round goes
   * live on its own; this is where it is looked at afterwards.
   */
  'GET /recordings/submissions': async (_req, env, url, user) => {
    if (!isAdmin(user)) return json({ error: 'not permitted' }, { status: 403 });
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 50) || 50, 1), 200);
    const { results } = await env.DB.prepare(
      `SELECT s.object_id, s.slug, s.title, s.link, s.year, s.tournament,
              s.status, s.review, s.note, s.created_at, u.display_name AS author
         FROM submissions s
         LEFT JOIN users u ON u.id = s.user_id
        WHERE s.review != 'removed'
        ORDER BY (s.review = 'unreviewed') DESC, s.created_at DESC
        LIMIT ?1`
    ).bind(limit).all();
    return json({ submissions: results });
  },

  /**
   * The onboarding run reporting how far it got. Not a judgement on the round.
   *
   * It accepts a token of its own as well as an admin session: the run is
   * unattended and a session expires, which would leave every submission stuck
   * at pending and re-ingested on every pass. The token authorises this one
   * report and nothing else.
   */
  'POST /recordings/:id/status': async (req, env, url, user) => {
    const isRunner = sameSecret(bearerOf(req), env.INGEST_TOKEN);
    if (!isRunner && !isAdmin(user)) return json({ error: 'not permitted' }, { status: 403 });
    const objectID = segment(url, 2);
    const { status, note, attempt, link } =
      await bodyOf<{ status?: string; note?: unknown; attempt?: unknown; link?: unknown }>(req);
    if (!['pending', 'ingested', 'failed'].includes(status ?? '')) {
      return json({ error: 'bad status' }, { status: 400 });
    }
    const row = await env.DB.prepare(
      `SELECT s.slug, s.link, s.review,
              (SELECT MAX(e.id) FROM ingest_events e
                WHERE e.slug = s.slug AND e.stage = 'audio' AND e.state = 'queued') AS attempt
         FROM submissions s WHERE s.object_id = ?1`
    ).bind(objectID).first<{ slug: string; link: string; review: string; attempt: number | null }>();
    if (!row) return json({ error: 'no such submission' }, { status: 404 });

    // A run reads the queue once, at its start, and can spend minutes on a
    // round. A report that arrives after the round was removed, or queued
    // again (a corrected link, a resubmission, a restart), is about a round
    // that is no longer there to report on, and recording it would mark the
    // new attempt done with the old one's audio. So it is refused, and what
    // the late run uploaded is taken back out where it does not belong: all
    // of a removed round's files, and audio fetched from a link that has
    // since been replaced. A report with no attempt is from a run older than
    // this check and is taken as before, unless the round was removed.
    if (row.review === 'removed') {
      const dropped = await dropMedia(env, row.slug);
      await unlistMedia(env, row.slug);
      return json({ error: 'that round was removed; this result was not kept', removed: dropped }, { status: 409 });
    }
    if (typeof attempt === 'number' && row.attempt !== null && attempt !== row.attempt) {
      const replaced = status === 'ingested' && typeof link === 'string' && link !== row.link;
      const dropped = replaced ? await dropMedia(env, row.slug, ['audio', 'peaks']) : [];
      if (replaced) await unlistMedia(env, row.slug);
      await recordIngest(env, objectID, row.slug, 'audio', 'skipped',
        `a ${status} report for an earlier attempt was not kept`);
      return json({ error: 'that round was queued again since this attempt began; this result was not kept', removed: dropped },
        { status: 409 });
    }

    const kept = typeof note === 'string' && note.trim() ? note.trim().slice(0, 1000) : null;
    // An outcome is an attempt; being put back in the queue is not.
    await env.DB.prepare(
      `UPDATE submissions SET status = ?1, note = ?2, updated_at = ?3,
              attempts = attempts + ?4 WHERE object_id = ?5`
    ).bind(status, kept, now(), status === 'pending' ? 0 : 1, objectID).run();
    await recordIngest(env, objectID, row.slug, 'audio',
      status === 'ingested' ? 'done' : status === 'failed' ? 'failed' : 'queued', kept);
    // A link that is itself a video file has just been fetched whole, so the
    // page may offer the picture. Until this, only video-check.ts said so,
    // and that is run by hand: a round submitted since had its audio and no
    // video. Search not hearing it costs the picture, not the round.
    if (status === 'ingested' && /\.(mp4|mov|webm)$/i.test(row.link.split('?')[0])) {
      await algolia(env, `${env.ALGOLIA_INDEX}/${objectID}/partial?createIfNotExists=false`, {
        method: 'POST', body: JSON.stringify({ objectID, video_ok: true }),
      }).catch(() => null);
    }
    return json({ ok: true });
  },

  /**
   * The onboarding run saying what it is doing, as it does it.
   *
   * The status report above covers one step, the audio, and only its end. A
   * round then waits on a transcript and on speech labels with nothing to say
   * whether anybody is working on them, and the run as a whole could stop
   * without a trace. Each run reports in (stage "run"), and each step reports
   * the rounds it starts on and the ones it could not do.
   */
  'POST /ingest/events': async (req, env, _url, user) => {
    const isRunner = sameSecret(bearerOf(req), env.INGEST_TOKEN);
    if (!isRunner && !isAdmin(user)) return json({ error: 'not permitted' }, { status: 403 });

    const body = await bodyOf<{ events?: unknown }>(req);
    const events = Array.isArray(body.events) ? body.events.slice(0, 200) : [];
    const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
    for (const e of events) {
      if (!INGEST_STAGES.includes(e?.stage)) return json({ error: 'bad stage' }, { status: 400 });
      if (!INGEST_STATES.includes(e?.state)) return json({ error: 'bad state' }, { status: 400 });
    }
    if (events.length === 0) return json({ ok: true, recorded: 0 });

    // The later steps know a round only by the slug its files are under; the
    // audio step knows the submission. Either is enough to find the other.
    //
    // A report that repeats the last one for the same round and step is not
    // kept. A round waiting on a busy GPU is "skipped" by every run, and a
    // hundred identical rows say no more than the first; keeping the first
    // also keeps when the waiting began.
    const stmts = events.map(e => env.DB.prepare(
      `INSERT INTO ingest_events (object_id, slug, stage, state, note, created_at)
       SELECT v.object_id, v.slug, ?3, ?4, ?5, ?6
         FROM (SELECT COALESCE(?1, (SELECT object_id FROM submissions WHERE slug = ?2 ORDER BY created_at DESC LIMIT 1)) AS object_id,
                      COALESCE(?2, (SELECT slug FROM submissions WHERE object_id = ?1)) AS slug) v
        WHERE v.slug IS NULL
           OR NOT EXISTS (
                SELECT 1 FROM ingest_events last
                 WHERE last.id = (SELECT MAX(id) FROM ingest_events WHERE slug = v.slug AND stage = ?3)
                   AND last.state = ?4 AND COALESCE(last.note, '') = COALESCE(?5, ''))`
    ).bind(str(e.objectID), str(e.slug), e.stage, e.state, str(e.note)?.slice(0, 1000) ?? null, now()));
    const kept = stmts.length;

    // A run reports in every fifteen minutes. A week of those says everything
    // the oldest one could.
    if (events.some(e => e.stage === 'run')) {
      stmts.push(env.DB.prepare(
        `DELETE FROM ingest_events WHERE stage = 'run' AND created_at < ?1`
      ).bind(now() - 7 * 86400));
    }
    const done = await env.DB.batch(stmts);
    const recorded = done.slice(0, kept).reduce((n, r) => n + (r.meta.changes ?? 0), 0);
    return json({ ok: true, recorded });
  },

  /** Keep it. Nothing changes for the round; it stops asking to be looked at. */
  'POST /recordings/:id/confirm': async (_req, env, url, user) => {
    if (!isAdmin(user)) return json({ error: 'not permitted' }, { status: 403 });
    const objectID = url.pathname.split('/')[2];
    const row = await env.DB.prepare(`SELECT slug, review FROM submissions WHERE object_id = ?1`)
      .bind(objectID).first<{ slug: string; review: string }>();
    if (!row) return json({ error: 'no such submission' }, { status: 404 });
    // Confirming a removed round would put it back in the queue while it is
    // out of search, and fetch audio for a round nobody can find.
    if (row.review === 'removed') {
      return json({ error: 'that round was removed; it has to be submitted again' }, { status: 409 });
    }

    // Not updated_at: that is when the round was last queued, which the
    // progress clocks run from, and keeping it is not queuing it.
    await env.DB.prepare(
      `UPDATE submissions SET review = 'confirmed' WHERE object_id = ?1`
    ).bind(objectID).run();
    await logEvent(env, 'recording.confirmed', user!.id, row.slug, { objectID });
    return json({ ok: true, review: 'confirmed' });
  },

  /** The round as search holds it, so the admin editor starts from the truth. */
  'GET /recordings/:id': async (_req, env, url, user) => {
    if (!isAdmin(user)) return json({ error: 'not permitted' }, { status: 403 });
    const objectID = url.pathname.split('/')[2];
    const res = await algolia(env, `${env.ALGOLIA_INDEX}/${objectID}`).catch(() => null);
    if (res?.status === 404) return json({ error: 'no such round' }, { status: 404 });
    if (!res?.ok) return json({ error: `search index refused (${res?.status ?? 'unreachable'})` }, { status: 502 });
    const record = await jsonWithin(res, ONE_RECORD_BYTES).catch(() => null);
    if (!record) return json({ error: 'search index answered with something that is not a round' }, { status: 502 });
    return json({ record });
  },

  /**
   * Corrects what a submission says.
   *
   * What it says, not where it lives: submitters describe a round in their own
   * words and someone has to be able to fix a title, but the slug is the
   * round's address and the name its audio is filed under in R2, so it is left
   * exactly as it was. The link is not editable here either, because a
   * different link is a different recording and would have to be probed and
   * ingested rather than typed over.
   */
  'PATCH /recordings/:id': async (req, env, url, user) => {
    if (!isAdmin(user)) return json({ error: 'not permitted' }, { status: 403 });
    const objectID = url.pathname.split('/')[2];
    const row = await env.DB.prepare(
      `SELECT slug, title, review FROM submissions WHERE object_id = ?1`
    ).bind(objectID).first<{ slug: string; title: string; review: string }>();
    if (!row) return json({ error: 'no such submission' }, { status: 404 });
    // Search no longer holds it, and a partial update would make a stub
    // record of just the edited fields, which the next build makes a page of.
    if (row.review === 'removed') {
      return json({ error: 'that round was removed; it has to be submitted again' }, { status: 409 });
    }

    const body = await bodyOf<any>(req);
    const str = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
    const has = (k: string) => Object.prototype.hasOwnProperty.call(body, k);

    const errors: Record<string, string> = {};
    const patch: Record<string, unknown> = { objectID };

    if (has('title')) {
      const title = str(body.title);
      if (!title) errors.title = 'A round title is required';
      else if (title.length > 200) errors.title = 'That title is too long';
      else patch.title = title;
    }
    if (has('year')) {
      const year = str(body.year);
      if (year && !/^\d{4}-\d{2}$/.test(year)) errors.year = 'Expected a season like 2020-21';
      else patch.year = year;
    }
    if (has('decision')) {
      const decision = str(body.decision);
      if (decision && !/^(\d+-\d+\s+(aff|neg)|aff|neg|\d+-\d+\s+split)$/i.test(decision)) {
        errors.decision = 'Expected Aff, Neg, 3-0 Aff, or 1-1 Split';
      } else patch.decision = decision;
    }
    if (has('format')) {
      const format = str(body.format);
      if (!FORMATS.includes(format)) errors.format = 'Choose parli or policy';
      else patch.format = format;
    }
    if (has('level')) {
      const level = str(body.level);
      if (!LEVELS.includes(level)) errors.level = 'Choose college or high school';
      else patch.level = level;
    }
    if (has('resolution')) patch.resolution = str(body.resolution);
    if (has('tournament')) patch.tournament = str(body.tournament);
    if (has('aff')) patch.aff = described(str(body.aff));
    if (has('neg')) patch.neg = described(str(body.neg));
    if (has('tags')) {
      const tags: string[] = Array.isArray(body.tags)
        ? body.tags.map(str).filter((t: string) => t.startsWith('#'))
        : [];
      patch._tags = tags;
      patch.searchable_tags = tags;
      patch.aff_type = tags.includes('#k-aff') ? 'k-aff'
        : tags.includes('#performance') ? 'performance' : 'topical';
    }
    if (has('neg') || has('tags')) {
      const neg = has('neg') ? described(str(body.neg)) : '';
      patch.neg_strategy_count = Number(neg.match(/(\d+)-off/i)?.[1]) || null;
    }

    if (Object.keys(errors).length) return json({ errors }, { status: 400 });
    if (Object.keys(patch).length === 1) return json({ error: 'nothing to change' }, { status: 400 });

    const res = await algolia(env, `${env.ALGOLIA_INDEX}/${objectID}/partial`, {
      method: 'POST', body: JSON.stringify(patch),
    }).catch(() => null);
    if (!res?.ok) return json({ error: `search index refused the edit (${res?.status ?? 'unreachable'})` }, { status: 502 });

    // The queue reads from D1, so the columns it shows follow the record.
    await env.DB.prepare(
      `UPDATE submissions
          SET title = COALESCE(?1, title),
              year = COALESCE(?2, year),
              tournament = COALESCE(?3, tournament)
        WHERE object_id = ?4`
    ).bind(
      patch.title ?? null,
      has('year') ? (patch.year || null) : null,
      has('tournament') ? (patch.tournament || null) : null,
      objectID,
    ).run();

    const changed = Object.keys(patch).filter(k => k !== 'objectID');
    const rebuilding = await requestRebuild(env, `edited ${row.slug}`);
    await logEvent(env, 'recording.edited', user!.id, row.slug, { objectID, fields: changed, rebuilding });
    return json({ ok: true, slug: row.slug, changed, rebuilding });
  },

  'DELETE /recordings/:id': (req, env, url, user) =>
    removeSubmission(req, env, segment(url, 2), user),

  'DELETE /admin/submissions/:id': (req, env, url, user) =>
    removeSubmission(req, env, segment(url, 3), user),

  /**
   * How far a submitted round has got, for the page somebody waits on.
   *
   * Anonymous, like the round itself: beyond what search already says, it
   * gives which steps are finished, the review state and the submitter's
   * display name, and nothing else about anybody. Found by id or by slug,
   * since a link to the round carries one and the submit form the other.
   */
  'GET /rounds/:slug/progress': async (_req, env, url, user) => {
    // A reference that is not even well-formed names no submission.
    const ref = segment(url, 2);
    const sub = ref === null ? null : await findSubmission(env, ref);
    if (!sub) return json({ error: 'no such submission' }, { status: 404 });

    const progress = await progressOf(env, sub, true);

    // What was sent in, for filling the form to send it again. Only when it
    // is asked for, since a waiting page polls this and search need not be
    // asked each time; and only to whoever sent it, or an admin.
    if (url.searchParams.get('submitted') !== '1') return json(progress, {}, { 'Cache-Control': 'no-store' });
    const theirs = Boolean(user && (user.id === sub.user_id || isAdmin(user)));
    const submitted = theirs
      ? asSubmitted(sub, (await searchRecords(env, [sub.object_id])).get(sub.object_id) ?? null)
      : null;
    return json({ ...progress, submitted }, {}, { 'Cache-Control': 'no-store' });
  },

  /**
   * The signed-in person's own submissions, so a round can be found again
   * after the confirmation is gone and a failure is not something only the
   * admin ever sees.
   */
  'GET /me/submissions': async (_req, env, _url, user) => {
    if (!user) return json({ error: 'not signed in' }, { status: 401 });
    const { results: rows } = await env.DB.prepare(
      `${SUBMISSION_SELECT} WHERE s.user_id = ?1 ORDER BY s.created_at DESC LIMIT 100`
    ).bind(user.id).all<SubmissionRow>();

    const slugs = rows.map(r => r.slug);
    const [media, events, pipe, records] = await Promise.all([
      mediaFor(env, slugs), ingestEventsFor(env, slugs, 50), pipelineFacts(env),
      searchRecords(env, rows.map(r => r.object_id)),
    ]);
    const submissions = rows.map(row => {
      const files = media.get(row.slug)!;
      const progress = buildProgress(env, row, files, events.get(row.slug) ?? [],
        pageRemembered(row, files), pipe);
      return {
        object_id: row.object_id, slug: row.slug, title: row.title,
        year: row.year, tournament: row.tournament,
        status: progress.status, reason: progress.failure?.reason ?? null,
        created_at: row.created_at, updated_at: row.updated_at,
        stuck: progress.stuck, stalled: progress.pipeline.stalled,
        estimatedDoneAt: progress.estimatedDoneAt,
        // Theirs, so theirs to have back: what a second attempt starts from.
        submitted: asSubmitted(row, records.get(row.object_id) ?? null),
      };
    });
    return json({ submissions });
  },

  /**
   * Every submission with everything known about it, removed ones included.
   *
   * The older list above shows a title and a stage word. Deciding what to do
   * about a round that has not arrived needs the rest: when it was sent, what
   * the run said, which files exist, and what the submitter actually typed.
   */
  'GET /admin/submissions': async (_req, env, url, user) => {
    if (!isAdmin(user)) return json({ error: 'not permitted' }, { status: 403 });
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 50) || 50, 1), 200);
    const offset = Math.max(Number(url.searchParams.get('offset') ?? 0) || 0, 0);
    const oneOf = (name: string, allowed: string[]) => {
      const v = url.searchParams.get(name);
      return v && allowed.includes(v) ? v : null;
    };
    const status = oneOf('status', ['pending', 'ingested', 'failed']);
    const review = oneOf('review', ['unreviewed', 'confirmed', 'removed']);
    const q = (url.searchParams.get('q') ?? '').trim().toLowerCase() || null;
    const by = url.searchParams.get('user') || null;
    // "Everything that failed" nearly always means everything that failed and
    // is still here; a round removed after failing is a closed matter.
    const live = url.searchParams.get('removed') === '0' ? 1 : 0;

    const where = `WHERE (?1 IS NULL OR s.status = ?1) AND (?2 IS NULL OR s.review = ?2)
                     AND (?3 IS NULL OR instr(lower(s.title), ?3) > 0)
                     AND (?4 IS NULL OR s.user_id = ?4)
                     AND (?5 = 0 OR s.review != 'removed')`;
    const [page, total, counts, oldest] = await Promise.all([
      env.DB.prepare(`${SUBMISSION_SELECT} ${where} ORDER BY s.created_at DESC LIMIT ?6 OFFSET ?7`)
        .bind(status, review, q, by, live, limit, offset).all<SubmissionRow>(),
      env.DB.prepare(`SELECT COUNT(*) AS n FROM submissions s ${where}`)
        .bind(status, review, q, by, live).first<{ n: number }>(),
      env.DB.prepare(
        `SELECT COALESCE(SUM(review != 'removed' AND status = 'pending'), 0) AS pending,
                COALESCE(SUM(review != 'removed' AND status = 'ingested'), 0) AS ingested,
                COALESCE(SUM(review != 'removed' AND status = 'failed'), 0) AS failed,
                COALESCE(SUM(review = 'removed'), 0) AS removed
           FROM submissions`
      ).first(),
      env.DB.prepare(
        `SELECT MIN(updated_at) AS at FROM submissions WHERE status = 'pending' AND review != 'removed'`
      ).first<{ at: number | null }>(),
    ]);

    const submissions = await describeSubmissions(env, page.results, {
      records: url.searchParams.get('records') !== '0', events: 10, fresh: false,
    });
    const pipe = await pipelineFacts(env);
    return json({
      total: total?.n ?? 0,
      counts,
      pipeline: { ...pipe, stalled: isStalled(pipe.lastRunAt, oldest?.at ?? null) },
      submissions,
    });
  },

  /** One submission, with the whole of what the run said and the page checked now. */
  'GET /admin/submissions/:id': async (_req, env, url, user) => {
    if (!isAdmin(user)) return json({ error: 'not permitted' }, { status: 403 });
    const ref = segment(url, 3);
    const sub = ref === null ? null : await findSubmission(env, ref);
    if (!sub) return json({ error: 'no such submission' }, { status: 404 });
    const [submission] = await describeSubmissions(env, [sub], { records: true, events: 200, fresh: true });
    return json({ submission });
  },

  /**
   * Try it again, with the link it has.
   *
   * A failed submission is never looked at by the run again, because the run
   * only takes what is pending. For a fault that has passed (a host that was
   * down, a download that was refused once) asking again is the whole fix.
   */
  'POST /admin/submissions/:id/retry': async (req, env, url, user) => {
    if (!isAdmin(user)) return json({ error: 'not permitted' }, { status: 403 });
    const { from } = await bodyOf<{ from?: unknown }>(req);
    if (from !== undefined && from !== null && !RESTART_STAGES.includes(from as RestartStage)) {
      return json({ error: `from must be one of ${RESTART_STAGES.join(', ')}` }, { status: 400 });
    }
    const id = segment(url, 3);
    const sub = id === null ? null : await findSubmission(env, id);
    if (!sub || sub.object_id !== id) return json({ error: 'no such submission' }, { status: 404 });
    // Removing it took it out of search, and nothing here can put it back.
    if (sub.review === 'removed') {
      return json({ error: 'that round was removed; it has to be submitted again' }, { status: 409 });
    }

    if (from === undefined || from === null) {
      await requeue(env, sub, 'retried by an admin');
      await logEvent(env, 'recording.retried', user!.id, sub.slug, { objectID: sub.object_id });
      return json({ ok: true, status: 'pending' });
    }

    // From one stage on: see restartFrom.
    const stage = from as RestartStage;
    const files = (await mediaFor(env, [sub.slug])).get(sub.slug)!;
    const done = await restartFrom(env, sub, stage, files);
    if ('refused' in done) return json({ error: done.refused }, { status: 409 });
    await logEvent(env, 'recording.restarted', user!.id, sub.slug,
      { objectID: sub.object_id, from: stage, removed: done.removed.length, rebuilding: done.rebuilding });

    const after = (await findSubmission(env, sub.object_id))!;
    const progress = await progressOf(env, after, true);
    return json({
      ok: true, status: after.status, from: stage, removed: done.removed, rebuilding: done.rebuilding, progress,
    });
  },

  /**
   * Corrects the link, which the editor above deliberately will not.
   *
   * A different link is a different recording, so this is not typing over a
   * field: the link is checked the way a submission's is, what was stored
   * from the old one is deleted, and the round goes back in the queue to be
   * fetched, transcribed and labelled from the start.
   */
  'POST /admin/submissions/:id/link': async (req, env, url, user) => {
    if (!isAdmin(user)) return json({ error: 'not permitted' }, { status: 403 });
    const sub = await env.DB.prepare(
      `SELECT object_id, slug, review FROM submissions WHERE object_id = ?1`
    ).bind(segment(url, 3))
      .first<{ object_id: string; slug: string; review: string }>();
    if (!sub) return json({ error: 'no such submission' }, { status: 404 });
    if (sub.review === 'removed') {
      return json({ error: 'that round was removed; it has to be submitted again' }, { status: 409 });
    }

    const body = await bodyOf<{ link?: unknown }>(req);
    const link = typeof body.link === 'string' ? body.link.trim() : '';
    if (!link) return json({ errors: { link: 'A link to the recording is required' } }, { status: 400 });
    if (!/^https?:\/\//i.test(link)) return json({ errors: { link: 'That does not look like a URL' } }, { status: 400 });
    const probe = await probeMedia(env, link);
    if (!probe.ok) return json({ errors: { link: probe.reason } }, { status: 400 });

    // Search first: if it refuses, nothing has been deleted yet. Told not to
    // create the record, so a round that has left search is not half remade.
    const res = await algolia(env, `${env.ALGOLIA_INDEX}/${sub.object_id}/partial?createIfNotExists=false`, {
      method: 'POST', body: JSON.stringify({ objectID: sub.object_id, link }),
    }).catch(() => null);
    if (!res?.ok) {
      return json({ error: `search index refused the edit (${res?.status ?? 'unreachable'})` }, { status: 502 });
    }

    const removed = await requeue(env, sub, 'link corrected by an admin', link);
    // The page was built with a player for the old recording.
    const rebuilding = await requestRebuild(env, `relinked ${sub.slug}`);
    await logEvent(env, 'recording.relinked', user!.id, sub.slug,
      { objectID: sub.object_id, removed: removed.length, rebuilding });
    return json({ ok: true, status: 'pending', link, probe: probe.info, removed, rebuilding });
  },

  /** What the ingest run has reported, newest first; for one round or for all. */
  'GET /admin/ingest/events': async (_req, env, url, user) => {
    if (!isAdmin(user)) return json({ error: 'not permitted' }, { status: 403 });
    const limit = Math.min(Math.max(Number(url.searchParams.get('limit') ?? 100) || 100, 1), 500);
    const ref = url.searchParams.get('ref');
    const slug = ref ? ((await findSubmission(env, ref))?.slug ?? ref) : null;

    const [{ results }, pipe, oldest] = await Promise.all([
      env.DB.prepare(
        `SELECT id, object_id, slug, stage, state, note, created_at
           FROM ingest_events WHERE (?1 IS NULL OR slug = ?1)
          ORDER BY id DESC LIMIT ?2`
      ).bind(slug, limit).all<IngestEvent>(),
      pipelineFacts(env),
      env.DB.prepare(
        `SELECT MIN(updated_at) AS at FROM submissions WHERE status = 'pending' AND review != 'removed'`
      ).first<{ at: number | null }>(),
    ]);
    return json({
      pipeline: { ...pipe, stalled: isStalled(pipe.lastRunAt, oldest?.at ?? null) },
      events: results,
    });
  },

  /**
   * A round's rating, and the reader's own if they have one.
   *
   * Anonymous, so the page can draw the stars before anyone signs in; `mine`
   * is simply null for a reader without a session.
   */
  'GET /rounds/:slug/rating': async (_req, env, url, user) => {
    const slug = url.pathname.split('/')[2];
    const agg = await env.DB.prepare(
      `SELECT AVG(stars) AS average, COUNT(*) AS count FROM ratings WHERE slug = ?1`
    ).bind(slug).first<{ average: number | null; count: number }>();

    const mine = user
      ? await env.DB.prepare(`SELECT stars FROM ratings WHERE slug = ?1 AND user_id = ?2`)
          .bind(slug, user.id).first<{ stars: number }>()
      : null;

    return json({
      average: agg?.average ? Number(agg.average.toFixed(2)) : 0,
      count: agg?.count ?? 0,
      mine: mine?.stars ?? null,
    });
  },

  /** Rates a round one to five. Zero withdraws a rating already given. */
  'POST /rounds/:slug/rating': async (req, env, url, user) => {
    if (!user) return json({ error: 'sign in to rate a round' }, { status: 401 });
    const slug = url.pathname.split('/')[2];
    const { stars } = await bodyOf<{ stars?: number }>(req);
    const value = Math.round(Number(stars));

    if (!Number.isFinite(value) || value < 0 || value > 5) {
      return json({ error: 'stars must be 0 to 5' }, { status: 400 });
    }

    if (value === 0) {
      await env.DB.prepare(`DELETE FROM ratings WHERE slug = ?1 AND user_id = ?2`)
        .bind(slug, user.id).run();
    } else {
      await env.DB.prepare(
        `INSERT INTO ratings (slug, user_id, stars, created_at, updated_at) VALUES (?1,?2,?3,?4,?4)
         ON CONFLICT(slug, user_id) DO UPDATE SET stars = ?3, updated_at = ?4`
      ).bind(slug, user.id, value, now()).run();
    }

    const agg = await env.DB.prepare(
      `SELECT AVG(stars) AS average, COUNT(*) AS count FROM ratings WHERE slug = ?1`
    ).bind(slug).first<{ average: number | null; count: number }>();

    await logEvent(env, 'round.rated', user.id, slug, { stars: value });
    return json({
      average: agg?.average ? Number(agg.average.toFixed(2)) : 0,
      count: agg?.count ?? 0,
      mine: value === 0 ? null : value,
    });
  },

  /**
   * Ratings for a page of results in one request.
   *
   * A list draws twenty cards at a time and a request each would be twenty
   * round trips to put a number under twenty titles.
   */
  'POST /ratings': async (req, env) => {
    const body = await bodyOf<{ slugs?: unknown }>(req);
    const slugs = Array.isArray(body.slugs)
      ? body.slugs.filter((s): s is string => typeof s === 'string' && s.length > 0).slice(0, 100)
      : [];
    if (slugs.length === 0) return json({ ratings: {} });

    const placeholders = slugs.map((_, i) => `?${i + 1}`).join(',');
    const { results } = await env.DB.prepare(
      `SELECT slug, AVG(stars) AS average, COUNT(*) AS count
         FROM ratings WHERE slug IN (${placeholders}) GROUP BY slug`
    ).bind(...slugs).all<{ slug: string; average: number; count: number }>();

    const ratings: Record<string, { average: number; count: number }> = {};
    for (const r of results) {
      ratings[r.slug] = { average: Number(r.average.toFixed(2)), count: r.count };
    }
    return json({ ratings });
  },

  /**
   * Standing preferences, so a choice made once follows the person rather than
   * the browser they made it in.
   */
  /**
   * The rounds this reader has rated, their own best first.
   *
   * Ordered here rather than in the page, because "which rounds did I think
   * were worth it" is the question being asked and the answer is a ranking.
   */
  'GET /me/ratings': async (_req, env, _url, user) => {
    if (!user) return json({ error: 'not signed in' }, { status: 401 });
    const { results } = await env.DB.prepare(
      `SELECT slug, stars, updated_at FROM ratings
        WHERE user_id = ?1 ORDER BY stars DESC, updated_at DESC`
    ).bind(user.id).all();
    return json({ ratings: results });
  },

  'GET /me/prefs': async (_req, env, _url, user) => {
    if (!user) return json({ error: 'not signed in' }, { status: 401 });
    const row = await env.DB.prepare(`SELECT prefs FROM users WHERE id = ?1`)
      .bind(user.id).first<{ prefs: string | null }>();
    let prefs: Record<string, unknown> = {};
    try { prefs = row?.prefs ? JSON.parse(row.prefs) : {}; } catch { prefs = {}; }
    return json({ prefs });
  },

  /** Merges into what is stored, so one page saving one key clears none. */
  'POST /me/prefs': async (req, env, _url, user) => {
    if (!user) return json({ error: 'sign in required' }, { status: 401 });
    const body = await bodyOf<{ prefs?: unknown }>(req);
    if (!body.prefs || typeof body.prefs !== 'object' || Array.isArray(body.prefs)) {
      return json({ error: 'prefs must be an object' }, { status: 400 });
    }

    const row = await env.DB.prepare(`SELECT prefs FROM users WHERE id = ?1`)
      .bind(user.id).first<{ prefs: string | null }>();
    let current: Record<string, unknown> = {};
    try { current = row?.prefs ? JSON.parse(row.prefs) : {}; } catch { current = {}; }

    const merged = { ...current, ...(body.prefs as Record<string, unknown>) };
    const encoded = JSON.stringify(merged);
    if (encoded.length > 4000) return json({ error: 'prefs too large' }, { status: 400 });

    await env.DB.prepare(`UPDATE users SET prefs = ?1 WHERE id = ?2`)
      .bind(encoded, user.id).run();
    return json({ prefs: merged });
  },

  'GET /rounds/:slug/revisions': async (_req, env, url) => {
    const slug = url.pathname.split('/')[2];
    const { results } = await env.DB.prepare(
      `SELECT kind, anchor, value, applied_at FROM revisions WHERE slug = ?1`
    ).bind(slug).all();
    return json({ revisions: results });
  },

  'POST /rounds/:slug/proposals': async (req, env, url, user) => {
    if (!user) return json({ error: 'sign in to propose an edit' }, { status: 401 });
    const slug = url.pathname.split('/')[2];
    const body = await bodyOf<any>(req);
    const { kind, anchor, original, proposed, note, startS, endS } = body;

    if (!['transcript', 'boundary'].includes(kind)) return json({ error: 'bad kind' }, { status: 400 });
    if (!anchor || typeof proposed !== 'string' || !proposed.trim()) {
      return json({ error: 'anchor and proposed text required' }, { status: 400 });
    }
    if (proposed.length > 4000) return json({ error: 'proposal too long' }, { status: 400 });

    const pid = id();
    await env.DB.prepare(
      `INSERT INTO proposals (id, slug, kind, anchor, start_s, end_s, original, proposed, note, user_id, created_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)`
    ).bind(pid, slug, kind, String(anchor), startS ?? null, endS ?? null,
      String(original ?? ''), proposed.trim(), note ?? null, user.id, now()).run();

    // The author's own vote counts, so a proposal starts at +1.
    await env.DB.prepare(
      `INSERT INTO votes (proposal_id, user_id, value, created_at) VALUES (?1,?2,1,?3)`
    ).bind(pid, user.id, now()).run();

    await logEvent(env, 'proposal.created', user.id, slug, { pid, kind });

    // An admin does not have to wait on the vote: their edit is the decision.
    if (isAdmin(user)) {
      const proposal = await env.DB.prepare(`SELECT * FROM proposals WHERE id = ?1`)
        .bind(pid).first<any>();
      await env.DB.prepare(`UPDATE proposals SET score = 1 WHERE id = ?1`).bind(pid).run();
      await acceptProposal(env, proposal);
      await logEvent(env, 'proposal.accepted', user.id, slug, { pid, by: 'admin-author' });
      return json({ id: pid, score: 1, accepted: true }, { status: 201 });
    }

    const settled = await settleProposal(env, pid);
    return json({ id: pid, ...settled }, { status: 201 });
  },

  'POST /proposals/:id/vote': async (req, env, url, user) => {
    if (!user) return json({ error: 'sign in to vote' }, { status: 401 });
    const pid = url.pathname.split('/')[2];
    const body = await bodyOf<{ value?: number }>(req);
    const value = body.value === -1 ? -1 : body.value === 1 ? 1 : 0;

    if (value === 0) {
      await env.DB.prepare(`DELETE FROM votes WHERE proposal_id = ?1 AND user_id = ?2`)
        .bind(pid, user.id).run();
    } else {
      await env.DB.prepare(
        `INSERT INTO votes (proposal_id, user_id, value, created_at) VALUES (?1,?2,?3,?4)
         ON CONFLICT(proposal_id, user_id) DO UPDATE SET value = ?3, created_at = ?4`
      ).bind(pid, user.id, value, now()).run();
    }

    const settled = await settleProposal(env, pid);
    await logEvent(env, 'proposal.voted', user.id, null, { pid, value });
    return json(settled);
  },

  /** An author may revise or withdraw their own proposal while it is open. */
  'POST /proposals/:id/update': async (req, env, url, user) => {
    if (!user) return json({ error: 'sign in required' }, { status: 401 });
    const pid = url.pathname.split('/')[2];
    const { proposed, note } = await bodyOf<{ proposed?: string; note?: string }>(req);
    const row = await env.DB.prepare(`SELECT user_id, status FROM proposals WHERE id = ?1`)
      .bind(pid).first<{ user_id: string; status: string }>();
    if (!row) return json({ error: 'no such proposal' }, { status: 404 });
    if (row.user_id !== user.id) return json({ error: 'not your proposal' }, { status: 403 });
    if (row.status !== 'open') return json({ error: 'already resolved' }, { status: 409 });
    if (!proposed?.trim()) return json({ error: 'proposed text required' }, { status: 400 });

    await env.DB.prepare(`UPDATE proposals SET proposed = ?1, note = ?2 WHERE id = ?3`)
      .bind(proposed.trim().slice(0, 4000), note?.slice(0, 200) ?? null, pid).run();
    await logEvent(env, 'proposal.updated', user.id, null, { pid });
    return json({ ok: true });
  },

  'POST /proposals/:id/delete': async (_req, env, url, user) => {
    if (!user) return json({ error: 'sign in required' }, { status: 401 });
    const pid = url.pathname.split('/')[2];
    const row = await env.DB.prepare(`SELECT user_id, status FROM proposals WHERE id = ?1`)
      .bind(pid).first<{ user_id: string; status: string }>();
    if (!row) return json({ error: 'no such proposal' }, { status: 404 });
    if (row.user_id !== user.id) return json({ error: 'not your proposal' }, { status: 403 });
    if (row.status !== 'open') return json({ error: 'already resolved' }, { status: 409 });

    await env.DB.batch([
      env.DB.prepare(`DELETE FROM votes WHERE proposal_id = ?1`).bind(pid),
      env.DB.prepare(`DELETE FROM proposals WHERE id = ?1`).bind(pid),
    ]);
    await logEvent(env, 'proposal.deleted', user.id, null, { pid });
    return json({ ok: true });
  },

  'GET /me/favorites': async (_req, env, _url, user) => {
    if (!user) return json({ error: 'not signed in' }, { status: 401 });
    const { results } = await env.DB.prepare(
      `SELECT kind, ref, created_at FROM favorites WHERE user_id = ?1 ORDER BY created_at DESC`
    ).bind(user.id).all();
    return json({ favorites: results });
  },

  'POST /me/favorites': async (req, env, _url, user) => {
    if (!user) return json({ error: 'sign in to save favorites' }, { status: 401 });
    const { kind, ref, remove } = await bodyOf<any>(req);
    if (!kind || !ref) return json({ error: 'kind and ref required' }, { status: 400 });

    if (remove) {
      await env.DB.prepare(`DELETE FROM favorites WHERE user_id=?1 AND kind=?2 AND ref=?3`)
        .bind(user.id, kind, ref).run();
    } else {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO favorites (user_id, kind, ref, created_at) VALUES (?1,?2,?3,?4)`
      ).bind(user.id, kind, ref, now()).run();
    }
    return json({ ok: true });
  },

  'GET /me/notes': async (_req, env, url, user) => {
    if (!user) return json({ error: 'not signed in' }, { status: 401 });
    const slug = url.searchParams.get('slug');
    const stmt = slug
      ? env.DB.prepare(`SELECT id, slug, at_s, body, created_at FROM notes WHERE user_id=?1 AND slug=?2 ORDER BY at_s`).bind(user.id, slug)
      : env.DB.prepare(`SELECT id, slug, at_s, body, created_at FROM notes WHERE user_id=?1 ORDER BY created_at DESC`).bind(user.id);
    const { results } = await stmt.all();
    return json({ notes: results });
  },

  'POST /me/notes': async (req, env, _url, user) => {
    if (!user) return json({ error: 'sign in to take notes' }, { status: 401 });
    const { slug, atS, body } = await bodyOf<any>(req);
    if (!slug || typeof atS !== 'number' || !body?.trim()) {
      return json({ error: 'slug, atS and body required' }, { status: 400 });
    }
    const nid = id();
    await env.DB.prepare(
      `INSERT INTO notes (id, user_id, slug, at_s, body, created_at) VALUES (?1,?2,?3,?4,?5,?6)`
    ).bind(nid, user.id, slug, atS, String(body).slice(0, 4000), now()).run();
    return json({ id: nid }, { status: 201 });
  },

  'GET /me/tags': async (_req, env, _url, user) => {
    if (!user) return json({ error: 'not signed in' }, { status: 401 });
    const { results } = await env.DB.prepare(
      `SELECT slug, tag FROM user_tags WHERE user_id = ?1`
    ).bind(user.id).all();
    return json({ tags: results });
  },

  'POST /me/tags': async (req, env, _url, user) => {
    if (!user) return json({ error: 'sign in to tag rounds' }, { status: 401 });
    const { slug, tag, remove } = await bodyOf<any>(req);
    if (!slug || !tag) return json({ error: 'slug and tag required' }, { status: 400 });
    const clean = String(tag).trim().toLowerCase().replace(/^#/, '').slice(0, 40);
    if (remove) {
      await env.DB.prepare(`DELETE FROM user_tags WHERE user_id=?1 AND slug=?2 AND tag=?3`)
        .bind(user.id, slug, clean).run();
    } else {
      await env.DB.prepare(
        `INSERT OR IGNORE INTO user_tags (user_id, slug, tag, created_at) VALUES (?1,?2,?3,?4)`
      ).bind(user.id, slug, clean, now()).run();
    }
    return json({ ok: true });
  },
};

/** Matches a concrete path against the ':param' patterns in the route table. */
function matchRoute(method: string, pathname: string): string | null {
  const parts = pathname.replace(/\/+$/, '').split('/').filter(Boolean);
  for (const key of Object.keys(routes)) {
    const [m, pattern] = key.split(' ');
    if (m !== method) continue;
    const pp = pattern.split('/').filter(Boolean);
    if (pp.length !== parts.length) continue;
    if (pp.every((seg, i) => seg.startsWith(':') || seg === parts[i])) return key;
  }
  return null;
}

export default {
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    // Logged rather than thrown: there is nobody to tell but the log, and the
    // next tick is fifteen minutes away whatever happens to this one.
    try {
      await startIngestRun(env);
    } catch (e: any) {
      console.error('the cron tick could not start the ingest run:', e?.stack ?? e);
    }
  },

  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    // "//rounds/x" is "/rounds/x": the handlers read the path by position, and
    // the matcher already ignores empty segments.
    url.pathname = url.pathname.replace(/\/{2,}/g, '/');
    const allowed = (env.ALLOWED_ORIGINS ?? 'https://goldenturn.org').split(',').map(s => s.trim());
    const headers = cors(req.headers.get('Origin'), allowed);

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });

    const key = matchRoute(req.method, url.pathname);
    if (!key) return json({ error: 'not found' }, { status: 404 }, headers);

    let user: User | null = null;
    try {
      user = await currentUser(req, env);
      const res = await routes[key](req, env, url, user);
      const merged = new Headers(res.headers);
      for (const [k, v] of Object.entries(headers)) merged.set(k, v);
      return new Response(res.body, { status: res.status, headers: merged });
    } catch (e: any) {
      // What went wrong goes to the log, under an id the caller is given, and
      // to nobody else: the message can hold SQL, column names and whatever
      // the caller sent. An admin, who reads the log anyway, also gets it here.
      const requestId = req.headers.get('cf-ray') ?? id();
      console.error(`[${requestId}] ${key} failed:`, e?.stack ?? e);
      return json({
        error: 'server error', requestId,
        ...(isAdmin(user) ? { detail: String(e?.message ?? e).slice(0, 200) } : {}),
      }, { status: 500 }, headers);
    }
  },
};
