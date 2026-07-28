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

const ADMIN_KEY = 'gt:admin';

export function isAdmin(): boolean {
  return localStorage.getItem(ADMIN_KEY) === '1';
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
  author_id?: string;
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
  localStorage.removeItem(ADMIN_KEY);
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

async function authenticate(payload: Record<string, unknown>): Promise<User> {
  const res = await call<{ token: string; user: User; admin?: boolean }>('/auth/session', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  localStorage.setItem(TOKEN_KEY, res.token);
  localStorage.setItem(USER_KEY, JSON.stringify(res.user));
  localStorage.setItem(ADMIN_KEY, res.admin ? '1' : '0');
  return res.user;
}

export function signIn(email: string, password: string): Promise<User> {
  return authenticate({ mode: 'signin', email, password });
}

export function signUp(email: string, password: string, displayName: string): Promise<User> {
  return authenticate({ mode: 'signup', email, password, displayName });
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

/** Field-level complaints from the server, keyed by field name. */
export class FieldErrors extends Error {
  constructor(public fields: Record<string, string>) {
    super('validation failed');
    this.name = 'FieldErrors';
  }
}

export interface Submission {
  object_id: string;
  slug: string;
  title: string;
  link: string;
  year: string | null;
  tournament: string | null;
  author: string | null;
  created_at: number;
}

/**
 * Submits a round. The server validates, checks the link plays something and
 * writes to the index with its own key, so the browser carries none.
 */
export async function submitRecording(payload: Record<string, unknown>) {
  const token = getToken();
  if (!token) throw new NotSignedIn();
  const res = await fetch(`${API}/recordings`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  const body = await res.json().catch(() => ({} as any));
  if (res.status === 401) { signOut(); throw new NotSignedIn(); }
  if (!res.ok) {
    if ((body as any).errors) throw new FieldErrors((body as any).errors);
    throw new Error((body as any).error ?? `submission failed (${res.status})`);
  }
  return body as { objectID: string; slug: string; status: string; probe?: string };
}

export function pendingRecordings() {
  return call<{ pending: Submission[] }>('/recordings/pending');
}

export interface ReviewedSubmission extends Submission {
  status: 'pending' | 'ingested' | 'failed';
  review: 'unreviewed' | 'confirmed' | 'removed';
  note: string | null;
}

export function listSubmissions() {
  return call<{ submissions: ReviewedSubmission[] }>('/recordings/submissions', {}, true);
}

export function confirmRecording(objectID: string) {
  return call<{ ok: true }>(`/recordings/${encodeURIComponent(objectID)}/confirm`,
    { method: 'POST' }, true);
}

/** Removes the round from search and deletes its media. Not reversible. */
export function removeRecording(objectID: string, note?: string) {
  return call<{ ok: true; removed: string[] }>(`/recordings/${encodeURIComponent(objectID)}`,
    { method: 'DELETE', body: JSON.stringify({ note }) }, true);
}

export function vote(proposalId: string, value: -1 | 0 | 1) {
  return call<{ score: number; accepted: boolean }>(
    `/proposals/${encodeURIComponent(proposalId)}/vote`,
    { method: 'POST', body: JSON.stringify({ value }) },
    true,
  );
}

export function updateProposal(proposalId: string, proposed: string, note?: string) {
  return call<{ ok: true }>(`/proposals/${encodeURIComponent(proposalId)}/update`,
    { method: 'POST', body: JSON.stringify({ proposed, note }) }, true);
}

export function deleteProposal(proposalId: string) {
  return call<{ ok: true }>(`/proposals/${encodeURIComponent(proposalId)}/delete`,
    { method: 'POST' }, true);
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

export interface AdminStats {
  days: number;
  searches: Array<{ term: string; n: number }>;
  tags: Array<{ tag: string; n: number }>;
  rounds: Array<{ slug: string; n: number }>;
  daily: Array<{ day: number; n: number }>;
  kinds: Array<{ kind: string; n: number }>;
  totals: Record<string, number>;
  contributors: Array<{ name: string; rep: number; proposals: number }>;
}

export function adminStats(days = 30) {
  return call<AdminStats>(`/admin/stats?days=${days}`, {}, true);
}

/**
 * Fire-and-forget telemetry. Never awaited and never throws, so a blocked
 * request or an offline browser cannot interfere with the page.
 */
export function track(kind: string, slug?: string, payload?: Record<string, unknown>) {
  try {
    const token = getToken();
    void fetch(`${API}/events`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ kind, slug, payload }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* telemetry is best effort */
  }
}

export interface AdminEvent {
  id: number; kind: string; slug: string | null;
  payload: string; created_at: number; who: string;
}

export function adminEvents(since = 0, limit = 60) {
  return call<{ events: AdminEvent[] }>(`/admin/events?since=${since}&limit=${limit}`, {}, true);
}

export function adminProposals() {
  return call<{ proposals: Proposal[] & Array<{ slug: string }> }>('/admin/proposals', {}, true);
}

export function adminResolve(proposalId: string, action: 'accept' | 'reject') {
  return call<{ ok: true; status: string }>(
    `/admin/proposals/${encodeURIComponent(proposalId)}/resolve`,
    { method: 'POST', body: JSON.stringify({ action }) },
    true,
  );
}
