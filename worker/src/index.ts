/**
 * API for accounts, transcript corrections, votes, notes and tags.
 *
 * Reading is anonymous. Proposing and voting require a session, because
 * reputation only means something when identities are stable and one person
 * cannot vote a proposal through on their own.
 */

export interface Env {
  DB: D1Database;
  SESSION_TTL_DAYS: string;
  ALLOWED_ORIGINS: string;
}

const ACCEPT_THRESHOLD = 5;

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
 * Recomputes a proposal's score and promotes it once the margin clears the
 * threshold. Acceptance writes a revision, which is what readers actually see.
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
    await env.DB.batch([
      env.DB.prepare(`UPDATE proposals SET status = 'accepted' WHERE id = ?1`).bind(proposalId),
      env.DB.prepare(
        `INSERT INTO revisions (id, slug, kind, anchor, value, proposal_id, applied_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`
      ).bind(id(), proposal.slug, proposal.kind, proposal.anchor, proposal.proposed, proposalId, now()),
      // Reputation follows accepted work, not raw activity.
      env.DB.prepare(`UPDATE users SET rep = rep + 10 WHERE id = ?1`).bind(proposal.user_id),
    ]);
    await logEvent(env, 'proposal.accepted', proposal.user_id, proposal.slug, { proposalId, score });
    return { score, accepted: true };
  }
  return { score, accepted: false };
}

const routes: Record<string, (req: Request, env: Env, url: URL, user: User | null) => Promise<Response>> = {
  'GET /health': async (_req, env) => {
    const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>();
    return json({ ok: true, users: r?.n ?? 0 });
  },

  'POST /auth/session': async (req, env) => {
    const body = await req.json<{ email?: string; displayName?: string }>().catch(() => ({}));
    const email = (body.email ?? '').trim().toLowerCase();
    if (!email || !email.includes('@')) return json({ error: 'valid email required' }, { status: 400 });

    let user = await env.DB.prepare(`SELECT id, email, display_name, rep FROM users WHERE email = ?1`)
      .bind(email).first<User>();

    if (!user) {
      const uid = id();
      const name = (body.displayName ?? email.split('@')[0]).slice(0, 60);
      await env.DB.prepare(
        `INSERT INTO users (id, email, display_name, created_at, rep) VALUES (?1, ?2, ?3, ?4, 0)`
      ).bind(uid, email, name, now()).run();
      user = { id: uid, email, display_name: name, rep: 0 };
      await logEvent(env, 'user.created', uid, null, {});
    }

    const token = id() + id().replace(/-/g, '');
    const ttl = Number(env.SESSION_TTL_DAYS ?? '30') * 86400;
    await env.DB.prepare(
      `INSERT INTO sessions (token, user_id, created_at, expires_at) VALUES (?1, ?2, ?3, ?4)`
    ).bind(token, user.id, now(), now() + ttl).run();

    return json({ token, user });
  },

  'GET /me': async (_req, _env, _url, user) =>
    user ? json({ user }) : json({ error: 'not signed in' }, { status: 401 }),

  'GET /rounds/:slug/proposals': async (_req, env, url) => {
    const slug = url.pathname.split('/')[2];
    const { results } = await env.DB.prepare(
      `SELECT p.id, p.kind, p.anchor, p.start_s, p.end_s, p.original, p.proposed,
              p.note, p.score, p.status, p.created_at, u.display_name AS author
         FROM proposals p JOIN users u ON u.id = p.user_id
        WHERE p.slug = ?1 ORDER BY p.score DESC, p.created_at ASC`
    ).bind(slug).all();
    return json({ proposals: results });
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
    const settled = await settleProposal(env, pid);

    await logEvent(env, 'proposal.created', user.id, slug, { pid, kind });
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
