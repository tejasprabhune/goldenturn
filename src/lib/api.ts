/**
 * Client for the Worker API.
 *
 * Reading is anonymous, so every call works signed out; the ones that need a
 * session send the token and surface a 401 the caller can turn into a prompt.
 */

const API = 'https://goldenturn-api.tejas-prabhune.workers.dev';
const TOKEN_KEY = 'gt:token';
const USER_KEY = 'gt:user';

export interface User {
  id: string;
  email: string;
  display_name: string;
  rep: number;
}

export interface Proposal {
  id: string;
  kind: 'transcript' | 'boundary';
  anchor: string;
  start_s: number | null;
  end_s: number | null;
  original: string;
  proposed: string;
  note: string | null;
  score: number;
  status: 'open' | 'accepted' | 'rejected' | 'superseded';
  created_at: number;
  author: string;
}

export interface Revision {
  kind: string;
  anchor: string;
  value: string;
  applied_at: number;
}

export class NotSignedIn extends Error {
  constructor() {
    super('sign in required');
    this.name = 'NotSignedIn';
  }
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function getUser(): User | null {
  const raw = localStorage.getItem(USER_KEY);
  return raw ? (JSON.parse(raw) as User) : null;
}

export function signOut() {
  localStorage.removeItem(TOKEN_KEY);
  localStorage.removeItem(USER_KEY);
}

async function call<T>(path: string, init: RequestInit = {}, auth = false): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (auth) {
    const token = getToken();
    if (!token) throw new NotSignedIn();
    headers.Authorization = `Bearer ${token}`;
  }

  const res = await fetch(`${API}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } });
  if (res.status === 401) {
    // Sign-in rejects with 401 for a bad password; that is not a lost session.
    if (path !== '/auth/session') {
      if (auth) signOut();
      throw new NotSignedIn();
    }
    const body = await res.json().catch(() => ({}));
    throw new Error((body as any).error ?? 'sign in failed');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as any).error ?? `request failed (${res.status})`);
  return body as T;
}

export async function signIn(email: string, password: string, displayName?: string): Promise<User> {
  const { token, user } = await call<{ token: string; user: User }>('/auth/session', {
    method: 'POST',
    body: JSON.stringify({ email, password, displayName }),
  });
  localStorage.setItem(TOKEN_KEY, token);
  localStorage.setItem(USER_KEY, JSON.stringify(user));
  return user;
}

export function listProposals(slug: string) {
  return call<{ proposals: Proposal[] }>(`/rounds/${encodeURIComponent(slug)}/proposals`);
}

export function listRevisions(slug: string) {
  return call<{ revisions: Revision[] }>(`/rounds/${encodeURIComponent(slug)}/revisions`);
}

export function propose(slug: string, payload: {
  kind: 'transcript' | 'boundary';
  anchor: string;
  original: string;
  proposed: string;
  note?: string;
  startS?: number;
  endS?: number;
}) {
  return call<{ id: string; score: number; accepted: boolean }>(
    `/rounds/${encodeURIComponent(slug)}/proposals`,
    { method: 'POST', body: JSON.stringify(payload) },
    true,
  );
}

export function vote(proposalId: string, value: -1 | 0 | 1) {
  return call<{ score: number; accepted: boolean }>(
    `/proposals/${encodeURIComponent(proposalId)}/vote`,
    { method: 'POST', body: JSON.stringify({ value }) },
    true,
  );
}

export function listFavorites() {
  return call<{ favorites: Array<{ kind: string; ref: string }> }>('/me/favorites', {}, true);
}

export function setFavorite(kind: string, ref: string, remove = false) {
  return call<{ ok: true }>('/me/favorites', {
    method: 'POST',
    body: JSON.stringify({ kind, ref, remove }),
  }, true);
}

export function listNotes(slug?: string) {
  const q = slug ? `?slug=${encodeURIComponent(slug)}` : '';
  return call<{ notes: Array<{ id: string; slug: string; at_s: number; body: string }> }>(
    `/me/notes${q}`, {}, true,
  );
}

export function addNote(slug: string, atS: number, body: string) {
  return call<{ id: string }>('/me/notes', {
    method: 'POST',
    body: JSON.stringify({ slug, atS, body }),
  }, true);
}

export function listTags() {
  return call<{ tags: Array<{ slug: string; tag: string }> }>('/me/tags', {}, true);
}

export function setTag(slug: string, tag: string, remove = false) {
  return call<{ ok: true }>('/me/tags', {
    method: 'POST',
    body: JSON.stringify({ slug, tag, remove }),
  }, true);
}
