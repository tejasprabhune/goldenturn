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
}

const ACCEPT_THRESHOLD = 5;
// The two labels a round is filtered by. Kept in step with src/lib/prefs.ts.
const FORMATS = ['parli', 'policy'];
const LEVELS = ['college', 'hs'];
// Workers cap PBKDF2 at 100k iterations; requesting more throws at runtime.
const PBKDF2_ITERATIONS = 100_000;

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
}

function cors(origin: string | null, allowed: string[]): Record<string, string> {
  const ok = origin && allowed.includes(origin) ? origin : allowed[0];
  return {
    'Access-Control-Allow-Origin': ok,
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
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

async function currentUser(req: Request, env: Env): Promise<User | null> {
  const auth = req.headers.get('Authorization');
  const token = auth?.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return null;

  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.display_name, u.rep
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token = ?1 AND s.expires_at > ?2`
  ).bind(token, now()).first<User>();
  return row ?? null;
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

function isAdmin(user: User | null, env: Env): boolean {
  return Boolean(user && user.email === (env.ADMIN_EMAIL ?? '').toLowerCase());
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
async function probeMedia(link: string): Promise<{ ok: true; info: string } | { ok: false; reason: string }> {
  if (/youtube\.com|youtu\.be|vimeo\.com/i.test(link)) {
    return { ok: true, info: 'video host, checked at ingest' };
  }
  try {
    const res = await fetch(directUrl(link), { headers: { Range: 'bytes=0-1023' } });
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
    const body = await req.json<{
      email?: string; password?: string; displayName?: string; mode?: string;
    }>().catch(() => ({}));
    const email = (body.email ?? '').trim().toLowerCase();
    const password = body.password ?? '';
    const mode = body.mode === 'signup' ? 'signup' : 'signin';
    if (!email || !email.includes('@')) return json({ error: 'valid email required' }, { status: 400 });
    if (password.length < 8) return json({ error: 'password must be at least 8 characters' }, { status: 400 });

    const existing = await env.DB.prepare(
      `SELECT id, email, display_name, rep, password_hash FROM users WHERE email = ?1`
    ).bind(email).first<User & { password_hash: string | null }>();

    let user: User;
    if (mode === 'signup') {
      if (existing) {
        return json({ error: 'an account with that email already exists' }, { status: 409 });
      }
      const name = (body.displayName ?? '').trim();
      if (!name) return json({ error: 'display name required' }, { status: 400 });
      const uid = id();
      await env.DB.prepare(
        `INSERT INTO users (id, email, display_name, created_at, rep, password_hash)
         VALUES (?1, ?2, ?3, ?4, 0, ?5)`
      ).bind(uid, email, name.slice(0, 60), now(), await hashPassword(password)).run();
      user = { id: uid, email, display_name: name.slice(0, 60), rep: 0 };
      await logEvent(env, 'user.created', uid, null, {});
    } else {
      if (!existing) {
        return json({ error: 'no account with that email' }, { status: 404 });
      }
      if (!existing.password_hash) {
        // Account predates passwords; the first sign-in sets one.
        await env.DB.prepare(`UPDATE users SET password_hash = ?1 WHERE id = ?2`)
          .bind(await hashPassword(password), existing.id).run();
      } else if (!(await verifyPassword(password, existing.password_hash))) {
        await logEvent(env, 'auth.failed', existing.id, null, {});
        return json({ error: 'wrong password for that email' }, { status: 401 });
      }
      user = {
        id: existing.id, email: existing.email,
        display_name: existing.display_name, rep: existing.rep,
      };
    }

    const token = id() + id().replace(/-/g, '');
    const ttl = Number(env.SESSION_TTL_DAYS ?? '30') * 86400;
    await env.DB.prepare(
      `INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)`
    ).bind(token, user.id, now(), now() + ttl).run();

    return json({ token, user, admin: isAdmin(user, env) });
  },

  // Anonymous telemetry: what people search for and which rounds they open.
  'POST /events': async (req, env, _url, user) => {
    const body = await req.json<{ kind?: string; slug?: string; payload?: unknown }>().catch(() => ({}));
    const kind = String(body.kind ?? '');
    if (!PUBLIC_EVENTS.has(kind)) return json({ error: 'unknown event' }, { status: 400 });
    const payload = JSON.stringify(body.payload ?? {}).slice(0, 500);
    await env.DB.prepare(
      `INSERT INTO events (kind, user_id, slug, payload, created_at) VALUES (?1, ?2, ?3, ?4, ?5)`
    ).bind(kind, user?.id ?? null, body.slug ?? null, payload, now()).run();
    return json({ ok: true });
  },

  'GET /admin/stats': async (_req, env, url, user) => {
    if (!isAdmin(user, env)) return json({ error: 'not permitted' }, { status: 403 });
    const days = Math.min(Number(url.searchParams.get('days') ?? '30'), 365);
    const since = now() - days * 86400;

    const q = (sql: string, ...binds: unknown[]) =>
      env.DB.prepare(sql).bind(...binds).all().then(r => r.results);

    const [searches, tags, rounds, daily, kinds, totals, contributors] = await Promise.all([
      q(`SELECT json_extract(payload,'$.q') AS term, COUNT(*) AS n
           FROM events WHERE kind IN ('search','transcript.search') AND created_at > ?1
            AND json_extract(payload,'$.q') IS NOT NULL AND json_extract(payload,'$.q') != ''
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
           (SELECT COUNT(*) FROM events) AS events`),
      q(`SELECT u.display_name AS name, u.rep,
                (SELECT COUNT(*) FROM proposals p WHERE p.user_id=u.id) AS proposals
           FROM users u ORDER BY u.rep DESC, proposals DESC LIMIT 15`),
    ]);

    return json({ days, searches, tags, rounds, daily, kinds, totals: totals[0] ?? {}, contributors });
  },

  // A live tail of what is happening, attributed where an account was signed in.
  'GET /admin/events': async (_req, env, url, user) => {
    if (!isAdmin(user, env)) return json({ error: 'not permitted' }, { status: 403 });
    const limit = Math.min(Number(url.searchParams.get('limit') ?? '60'), 200);
    const since = Number(url.searchParams.get('since') ?? '0');
    const { results } = await env.DB.prepare(
      `SELECT e.id, e.kind, e.slug, e.payload, e.created_at,
              COALESCE(u.display_name, 'guest') AS who
         FROM events e LEFT JOIN users u ON u.id = e.user_id
        WHERE e.id > ?1
        ORDER BY e.id DESC LIMIT ?2`
    ).bind(since, limit).all();
    return json({ events: results });
  },

  'GET /admin/proposals': async (_req, env, _url, user) => {
    if (!isAdmin(user, env)) return json({ error: 'not permitted' }, { status: 403 });
    const { results } = await env.DB.prepare(
      `SELECT p.id, p.slug, p.kind, p.anchor, p.original, p.proposed, p.note,
              p.score, p.status, p.created_at, u.display_name AS author
         FROM proposals p JOIN users u ON u.id = p.user_id
        WHERE p.status = 'open'
        ORDER BY p.score DESC, p.created_at ASC LIMIT 100`
    ).all();
    return json({ proposals: results });
  },

  /** Admin override: accept or reject without waiting for the vote threshold. */
  'POST /admin/proposals/:id/resolve': async (req, env, url, user) => {
    if (!isAdmin(user, env)) return json({ error: 'not permitted' }, { status: 403 });
    const pid = url.pathname.split('/')[3];
    const { action } = await req.json<{ action?: string }>().catch(() => ({}));
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

  'GET /me': async (_req, env, _url, user) =>
    user ? json({ user, admin: isAdmin(user, env) }) : json({ error: 'not signed in' }, { status: 401 }),

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

    const body = await req.json<any>().catch(() => ({}));
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
    const dup = await env.DB.prepare(
      `SELECT object_id FROM submissions WHERE lower(title) = ?1 AND COALESCE(year,'') = ?2`
    ).bind(title.toLowerCase(), year).first();
    if (dup) return json({ errors: { title: 'That round has already been submitted' } }, { status: 409 });

    // Does the link actually serve a recording? A range GET, because Dropbox
    // answers HEAD with the content type of its own web page.
    const probe = await probeMedia(link);
    if (!probe.ok) {
      return json({ errors: { link: probe.reason } }, { status: 400 });
    }

    const objectID = `sub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const slug = slugFor(title, objectID);

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
      tournament: str(body.tournament),
      teams: [],
      aff_type: tags.includes('#k-aff') ? 'k-aff'
        : tags.includes('#performance') ? 'performance' : 'topical',
      neg_strategy_count: Number(str(body.neg).match(/(\d+)-off/i)?.[1]) || null,
    };

    const res = await fetch(
      `https://${env.ALGOLIA_APP_ID}.algolia.net/1/indexes/${env.ALGOLIA_INDEX}/${objectID}`,
      {
        method: 'PUT',
        headers: {
          'X-Algolia-API-Key': env.ALGOLIA_ADMIN_KEY,
          'X-Algolia-Application-Id': env.ALGOLIA_APP_ID,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(record),
      },
    );
    if (!res.ok) {
      return json({ error: `search index rejected the round (${res.status})` }, { status: 502 });
    }

    // Pending until its audio is in R2: appearing in search is not the same as
    // being playable, and the ingest run reads this to know what is owed.
    await env.DB.prepare(
      `INSERT INTO submissions (object_id, slug, title, link, year, tournament, user_id, status, created_at, updated_at)
       VALUES (?1,?2,?3,?4,?5,?6,?7,'pending',?8,?8)`
    ).bind(objectID, slug, title, link, year || null, str(body.tournament) || null,
      user.id, now()).run();

    await logEvent(env, 'recording.submitted', user.id, slug, { objectID, norm });
    return json({ objectID, slug, status: 'pending', probe: probe.info }, { status: 201 });
  },

  /** What has been submitted but not yet ingested. Drives the onboarding run. */
  'GET /recordings/pending': async (_req, env) => {
    const { results } = await env.DB.prepare(
      `SELECT s.object_id, s.slug, s.title, s.link, s.year, s.tournament, s.created_at,
              u.display_name AS author
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
    if (!isAdmin(user, env)) return json({ error: 'not permitted' }, { status: 403 });
    const limit = Math.min(Number(url.searchParams.get('limit') ?? 50), 200);
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
    const bearer = (req.headers.get('Authorization') ?? '').replace(/^Bearer /, '');
    const isRunner = Boolean(env.INGEST_TOKEN) && bearer === env.INGEST_TOKEN;
    if (!isRunner && !isAdmin(user, env)) return json({ error: 'not permitted' }, { status: 403 });
    const objectID = url.pathname.split('/')[2];
    const { status, note } = await req.json<{ status?: string; note?: string }>().catch(() => ({} as any));
    if (!['pending', 'ingested', 'failed'].includes(status ?? '')) {
      return json({ error: 'bad status' }, { status: 400 });
    }
    await env.DB.prepare(
      `UPDATE submissions SET status = ?1, note = ?2, updated_at = ?3 WHERE object_id = ?4`
    ).bind(status, note ?? null, now(), objectID).run();
    return json({ ok: true });
  },

  /** Keep it. Nothing changes for the round; it stops asking to be looked at. */
  'POST /recordings/:id/confirm': async (_req, env, url, user) => {
    if (!isAdmin(user, env)) return json({ error: 'not permitted' }, { status: 403 });
    const objectID = url.pathname.split('/')[2];
    const row = await env.DB.prepare(`SELECT slug FROM submissions WHERE object_id = ?1`)
      .bind(objectID).first<{ slug: string }>();
    if (!row) return json({ error: 'no such submission' }, { status: 404 });

    await env.DB.prepare(
      `UPDATE submissions SET review = 'confirmed', updated_at = ?1 WHERE object_id = ?2`
    ).bind(now(), objectID).run();
    await logEvent(env, 'recording.confirmed', user!.id, row.slug, { objectID });
    return json({ ok: true, review: 'confirmed' });
  },

  /** The round as search holds it, so the admin editor starts from the truth. */
  'GET /recordings/:id': async (_req, env, url, user) => {
    if (!isAdmin(user, env)) return json({ error: 'not permitted' }, { status: 403 });
    const objectID = url.pathname.split('/')[2];
    const res = await fetch(
      `https://${env.ALGOLIA_APP_ID}.algolia.net/1/indexes/${env.ALGOLIA_INDEX}/${objectID}`,
      {
        headers: {
          'X-Algolia-API-Key': env.ALGOLIA_ADMIN_KEY,
          'X-Algolia-Application-Id': env.ALGOLIA_APP_ID,
        },
      },
    );
    if (res.status === 404) return json({ error: 'no such round' }, { status: 404 });
    if (!res.ok) return json({ error: `search index refused (${res.status})` }, { status: 502 });
    return json({ record: await res.json() });
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
    if (!isAdmin(user, env)) return json({ error: 'not permitted' }, { status: 403 });
    const objectID = url.pathname.split('/')[2];
    const row = await env.DB.prepare(
      `SELECT slug, title FROM submissions WHERE object_id = ?1`
    ).bind(objectID).first<{ slug: string; title: string }>();
    if (!row) return json({ error: 'no such submission' }, { status: 404 });

    const body = await req.json<any>().catch(() => ({}));
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

    const res = await fetch(
      `https://${env.ALGOLIA_APP_ID}.algolia.net/1/indexes/${env.ALGOLIA_INDEX}/${objectID}/partial`,
      {
        method: 'POST',
        headers: {
          'X-Algolia-API-Key': env.ALGOLIA_ADMIN_KEY,
          'X-Algolia-Application-Id': env.ALGOLIA_APP_ID,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(patch),
      },
    );
    if (!res.ok) return json({ error: `search index refused the edit (${res.status})` }, { status: 502 });

    // The queue reads from D1, so the columns it shows follow the record.
    await env.DB.prepare(
      `UPDATE submissions
          SET title = COALESCE(?1, title),
              year = COALESCE(?2, year),
              tournament = COALESCE(?3, tournament),
              updated_at = ?4
        WHERE object_id = ?5`
    ).bind(
      patch.title ?? null,
      has('year') ? (patch.year || null) : null,
      has('tournament') ? (patch.tournament || null) : null,
      now(), objectID,
    ).run();

    await logEvent(env, 'recording.edited', user!.id, row.slug, {
      objectID, fields: Object.keys(patch).filter(k => k !== 'objectID'),
    });
    return json({ ok: true, slug: row.slug, changed: Object.keys(patch).filter(k => k !== 'objectID') });
  },

  /**
   * Remove it. A round that should not be here has to go from everywhere it
   * reached on its own: out of search, and its audio, transcript and timings
   * out of the bucket, or the files stay served at a guessable address.
   */
  'DELETE /recordings/:id': async (req, env, url, user) => {
    if (!isAdmin(user, env)) return json({ error: 'not permitted' }, { status: 403 });
    const objectID = url.pathname.split('/')[2];
    const row = await env.DB.prepare(
      `SELECT slug, title FROM submissions WHERE object_id = ?1`
    ).bind(objectID).first<{ slug: string; title: string }>();
    if (!row) return json({ error: 'no such submission' }, { status: 404 });

    const { note } = await req.json<{ note?: string }>().catch(() => ({} as any));

    const search = await fetch(
      `https://${env.ALGOLIA_APP_ID}.algolia.net/1/indexes/${env.ALGOLIA_INDEX}/${objectID}`,
      {
        method: 'DELETE',
        headers: {
          'X-Algolia-API-Key': env.ALGOLIA_ADMIN_KEY,
          'X-Algolia-Application-Id': env.ALGOLIA_APP_ID,
        },
      },
    );
    if (!search.ok && search.status !== 404) {
      return json({ error: `search index refused the removal (${search.status})` }, { status: 502 });
    }

    const keys = [
      `audio/${row.slug}.m4a`,
      `peaks/${row.slug}.json`,
      `transcripts/${row.slug}.json`,
      `speeches/${row.slug}.json`,
    ];
    const removed: string[] = [];
    for (const key of keys) {
      if (await env.MEDIA.head(key)) {
        await env.MEDIA.delete(key);
        removed.push(key);
      }
    }

    await env.DB.prepare(
      `UPDATE submissions SET review = 'removed', note = ?1, updated_at = ?2 WHERE object_id = ?3`
    ).bind(note ?? null, now(), objectID).run();
    await logEvent(env, 'recording.removed', user!.id, row.slug, { objectID, removed: removed.length });

    return json({ ok: true, review: 'removed', removed });
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
    const { stars } = await req.json<{ stars?: number }>().catch(() => ({}));
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
    const body = await req.json<{ slugs?: unknown }>().catch(() => ({}));
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
    const body = await req.json<{ prefs?: unknown }>().catch(() => ({}));
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
    const body = await req.json<any>().catch(() => ({}));
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
    if (isAdmin(user, env)) {
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
    const body = await req.json<{ value?: number }>().catch(() => ({}));
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
    const { proposed, note } = await req.json<{ proposed?: string; note?: string }>().catch(() => ({}));
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
    const { kind, ref, remove } = await req.json<any>().catch(() => ({}));
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
    const { slug, atS, body } = await req.json<any>().catch(() => ({}));
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
    const { slug, tag, remove } = await req.json<any>().catch(() => ({}));
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
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const allowed = (env.ALLOWED_ORIGINS ?? 'https://goldenturn.org').split(',').map(s => s.trim());
    const headers = cors(req.headers.get('Origin'), allowed);

    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });

    const key = matchRoute(req.method, url.pathname);
    if (!key) return json({ error: 'not found' }, { status: 404 }, headers);

    try {
      const user = await currentUser(req, env);
      const res = await routes[key](req, env, url, user);
      const merged = new Headers(res.headers);
      for (const [k, v] of Object.entries(headers)) merged.set(k, v);
      return new Response(res.body, { status: res.status, headers: merged });
    } catch (e: any) {
      return json({ error: 'server error', detail: String(e?.message ?? e).slice(0, 200) },
        { status: 500 }, headers);
    }
  },
};
