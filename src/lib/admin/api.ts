/**
 * Client for the Worker's admin endpoints.
 *
 * Kept apart from `src/lib/api.ts` because the console needs to tell its
 * failures apart: the old page caught everything and printed "Access denied",
 * so a 500 from the stats query read as a permissions problem (audit B6).
 * Every call here throws one of four kinds, and the console words each one
 * differently.
 *
 * Shapes follow the API document for the admin endpoints field for field;
 * nothing here renames what the server sends.
 */

import { API, getToken, signOut, FieldErrors, type Proposal } from '../api';

/** No session, or the session has expired. */
export class SignedOut extends Error {
  constructor() {
    super('sign in required');
    this.name = 'SignedOut';
  }
}

/** Signed in, but not as an admin. The server said 403. */
export class Denied extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'Denied';
  }
}

/** The server answered, and the answer was a failure on its side. */
export class ServerError extends Error {
  constructor(public status: number, message: string, public detail: string | null, public path: string) {
    super(message);
    this.name = 'ServerError';
  }
}

/** The request never got an answer: offline, DNS, CORS, a dropped connection. */
export class Unreachable extends Error {
  constructor(public path: string, cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'Unreachable';
  }
}

/** A refusal about the request itself (404, 409, 400 without field errors). */
export class Refused extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'Refused';
  }
}

export { FieldErrors };

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getToken();
  if (!token) throw new SignedOut();
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        ...(init.headers ?? {}),
      },
    });
  } catch (e) {
    throw new Unreachable(path, e);
  }
  const body: any = await res.json().catch(() => ({}));
  if (res.status === 401) {
    signOut();
    throw new SignedOut();
  }
  if (res.status === 403) throw new Denied(body.error ?? 'not permitted');
  if (res.status >= 500) {
    throw new ServerError(res.status, body.error ?? `server error (${res.status})`, body.detail ?? null, path);
  }
  if (!res.ok) {
    if (body.errors) throw new FieldErrors(body.errors);
    throw new Refused(res.status, body.error ?? `request failed (${res.status})`);
  }
  return body as T;
}

function qs(params: Record<string, string | number | boolean | null | undefined>): string {
  const out = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '' || v === false) continue;
    out.set(k, v === true ? '1' : String(v));
  }
  const s = out.toString();
  return s ? `?${s}` : '';
}

const enc = encodeURIComponent;

/* Shared shapes. */

export interface Pipeline {
  lastRunAt: number | null;
  stalled: boolean;
}

export type StageKey = 'submitted' | 'audio' | 'transcript' | 'speeches' | 'page';
export type StageState = 'done' | 'active' | 'waiting' | 'failed';

export interface Stage {
  key: StageKey;
  label: string;
  state: StageState;
  at: number | null;
  startedAt: number | null;
  reason: string | null;
  /** How long it usually takes once it can start; null for `submitted`. */
  typicalSeconds: number | null;
  /** When a stage still owed should be done; in the past means overdue. */
  expectedAt: number | null;
  /** The server's judgement: owed far longer than normal while the ingest runs. */
  stuck: boolean;
}

export type ProgressStatus =
  'fetching' | 'transcribing' | 'labelling' | 'publishing' | 'published' | 'failed' | 'removed';

export interface Progress {
  id: string;
  slug: string;
  title: string;
  round: string;
  teams: { aff: string; neg: string } | null;
  tournament: string | null;
  year: string | null;
  submitter: string | null;
  submittedAt: number;
  updatedAt: number;
  status: ProgressStatus;
  ingestStatus: 'pending' | 'ingested' | 'failed';
  review: 'unreviewed' | 'confirmed' | 'removed';
  stages: Stage[];
  failure: { stage: StageKey | null; reason: string; at: number | null; final: boolean } | null;
  audio: { url: string; source: 'stored' | 'submitted'; peaksUrl: string | null } | null;
  /** Null for a removed round. */
  link: string | null;
  linkKind: 'youtube' | 'vimeo' | 'file';
  media: { audio: boolean; peaks: boolean; transcript: boolean; speeches: boolean };
  page: { path: string; url: string; exists: boolean; hasPlayer: boolean; builtAt: number | null };
  pipeline: Pipeline;
  stuck: boolean;
  stuckStage: StageKey | null;
  estimatedDoneAt: number | null;
  now: number;
}

export interface IngestEvent {
  id: number;
  /** `dispatch` rows are the Worker failing (or managing again) to start a run. */
  stage: 'run' | 'audio' | 'transcript' | 'speeches' | 'index' | 'page' | 'dispatch';
  /** `queued` is written by the Worker when a round enters the queue. */
  state: 'queued' | 'started' | 'done' | 'failed' | 'skipped';
  note: string | null;
  created_at: number;
  object_id?: string | null;
  slug?: string | null;
}

export interface SearchRecord {
  objectID: string;
  title?: string;
  resolution?: string;
  aff?: string;
  neg?: string;
  decision?: string;
  year?: string;
  tournament?: string;
  format?: string;
  level?: string;
  link?: string;
  slug?: string;
  _tags?: string[];
  [k: string]: unknown;
}

export interface AdminSubmission {
  object_id: string;
  slug: string;
  title: string;
  link: string;
  year: string | null;
  tournament: string | null;
  status: 'pending' | 'ingested' | 'failed';
  review: 'unreviewed' | 'confirmed' | 'removed';
  note: string | null;
  attempts: number;
  created_at: number;
  updated_at: number | null;
  author: string | null;
  author_id: string | null;
  author_email: string | null;
  record: SearchRecord | null;
  progress: Progress;
  events: IngestEvent[];
}

export interface SubmissionList {
  total: number;
  counts: { pending: number; ingested: number; failed: number; removed: number };
  pipeline: Pipeline;
  submissions: AdminSubmission[];
}

/* Submissions. */

export function listSubmissions(p: {
  status?: string; review?: string; q?: string; limit?: number; offset?: number; records?: boolean;
  /** One submitter's, by user id. */
  user?: string;
  /** False leaves removed rows out, so a status filter matches its count. */
  removed?: boolean;
} = {}) {
  return call<SubmissionList>(`/admin/submissions${qs({
    status: p.status, review: p.review, q: p.q, user: p.user, limit: p.limit, offset: p.offset,
    removed: p.removed === false ? '0' : undefined,
    records: p.records === false ? '0' : undefined,
  })}`);
}

export function getSubmission(id: string) {
  return call<{ submission: AdminSubmission }>(`/admin/submissions/${enc(id)}`);
}

export type RestartFrom = 'audio' | 'transcript' | 'speeches' | 'page';

/**
 * Puts a submission back in the queue: the whole round with no `from`, or
 * from one stage on. The Worker takes the whole-round form today and gains
 * `from` later; until then it answers without echoing `from`, which means the
 * round was restarted from the beginning, and the caller says so.
 */
export function retrySubmission(id: string, from?: RestartFrom) {
  return call<{ ok: true; status: string; from?: RestartFrom; removed?: string[]; rebuilding?: boolean }>(`/admin/submissions/${enc(id)}/retry`,
    from ? { method: 'POST', body: JSON.stringify({ from }) } : { method: 'POST' });
}

export function relinkSubmission(id: string, link: string) {
  return call<{
    ok: true; status: 'pending'; link: string; probe: string | null; removed: string[]; rebuilding: boolean;
  }>(`/admin/submissions/${enc(id)}/link`, { method: 'POST', body: JSON.stringify({ link }) });
}

export function removeSubmission(id: string, note?: string) {
  return call<{ ok: true; review: 'removed'; removed: string[]; rebuilding: boolean }>(
    `/admin/submissions/${enc(id)}`, { method: 'DELETE', body: JSON.stringify({ note }) });
}

/** The existing confirm endpoint: marks a submission as looked at. */
export function confirmSubmission(id: string) {
  return call<{ ok: true }>(`/recordings/${enc(id)}/confirm`, { method: 'POST' });
}

/** The existing edit endpoint: corrects what search says about a round. */
export function editSubmission(id: string, fields: Partial<SearchRecord> & { tags?: string[] }) {
  return call<{ ok: true; slug: string; changed: string[]; rebuilding: boolean }>(
    `/recordings/${enc(id)}`, { method: 'PATCH', body: JSON.stringify(fields) });
}

export function ingestEvents(ref?: string, limit = 100) {
  return call<{ pipeline: Pipeline; events: Required<IngestEvent>[] }>(
    `/admin/ingest/events${qs({ ref, limit })}`);
}

/* Rounds. */

export interface AdminRound {
  object_id: string | null;
  slug: string;
  title: string | null;
  year: string | null;
  tournament: string | null;
  format: string | null;
  level: string | null;
  link: string | null;
  source: 'index' | 'submission' | 'media';
  has_audio: boolean;
  has_peaks: boolean;
  has_transcript: boolean;
  has_speeches: boolean;
  has_page: boolean | null;
  page_verified: boolean;
  /** Submitted, or else when its first file reached storage; null when neither is known. */
  added_at: number | null;
  audio_at: number | null;
  transcript_at: number | null;
  speeches_at: number | null;
  /** When the page with a player was first seen live; submitted rounds only. */
  page_at: number | null;
  submission: { object_id: string; status: string; review: string; created_at: number } | null;
}

export interface RoundList {
  generated_at: number;
  index_error: string | null;
  site: { last_deploy_at: number | null };
  total: number;
  counts: { audio: number; transcript: number; speeches: number; page: number; orphans: number };
  rounds: AdminRound[];
}

export function listRounds() {
  return call<RoundList>('/admin/rounds');
}

/* Users, sessions, sign-ins. */

export interface AdminUser {
  id: string;
  email: string;
  display_name: string;
  created_at: number;
  last_seen_at: number | null;
  rep: number;
  is_admin: boolean;
  prep_access: boolean;
  has_password: boolean;
  proposals: number;
  proposals_accepted: number;
  submissions: number;
  favorites: number;
  notes: number;
  ratings: number;
  tags: number;
  sessions_active: number;
}

export function listUsers(p: {
  q?: string; prep?: boolean; admin?: boolean; sort?: 'created' | 'seen' | 'rep' | 'name';
  limit?: number; offset?: number;
} = {}) {
  return call<{ total: number; users: AdminUser[] }>(`/admin/users${qs(p)}`);
}

export type AuthFailureReason = 'wrong_password' | 'no_account' | 'reserved_address' | 'no_password';

export interface UserDetail {
  user: AdminUser;
  /** The 50 most recent, expired ones included. */
  sessions: Array<{ created_at: number; last_seen_at: number; expires_at: number; active: boolean }>;
  /** The 20 most recent refused sign-ins against the account or its address. */
  auth_failures: Array<{ id: number; created_at: number; reason: AuthFailureReason }>;
}

/** One account, by id or email. */
export function getUser(ref: string) {
  return call<UserDetail>(`/admin/users/${enc(ref)}`);
}

export interface SessionSummary {
  active: number;
  active_users: number;
  expired: number;
  seen: { h24: number; d7: number; d30: number };
  signins: { h24: number; d7: number; d30: number };
  recent: Array<{
    user_id: string; email: string; display_name: string;
    created_at: number; last_seen_at: number | null; expires_at: number;
  }>;
}

export function sessions() {
  return call<SessionSummary>('/admin/sessions');
}

export interface AuthFailures {
  days: number;
  total: number;
  by_email: Array<{ email: string; n: number; last_at: number; known: boolean }>;
  failures: Array<{
    id: number; created_at: number; email: string; user_id: string | null;
    display_name: string | null;
    reason: AuthFailureReason;
  }>;
}

export function authFailures(days = 30, limit = 100) {
  return call<AuthFailures>(`/admin/auth-failures${qs({ days, limit })}`);
}

/* Prep access. */

export function grantPrep(target: { userId?: string; email?: string }) {
  return call<{ ok: true; user: { id: string; email: string; display_name: string; prep_access: boolean } }>(
    '/admin/prep/grant', { method: 'POST', body: JSON.stringify(target) });
}

export function revokePrep(target: { userId?: string; email?: string }) {
  return call<{ ok: true; user: { id: string; email: string; display_name: string; prep_access: boolean } }>(
    '/admin/prep/revoke', { method: 'POST', body: JSON.stringify(target) });
}

/* Telemetry. */

export interface Stats {
  days: number;
  searches: Array<{ term: string; n: number }>;
  tags: Array<{ tag: string; n: number }>;
  rounds: Array<{ slug: string; n: number }>;
  daily: Array<{ day: number; n: number }>;
  kinds: Array<{ kind: string; n: number }>;
  totals: Record<string, number>;
  contributors: Array<{ name: string; rep: number; proposals: number }>;
}

export function stats(days = 30) {
  return call<Stats>(`/admin/stats?days=${days}`);
}

export interface AdminEvent {
  id: number;
  kind: string;
  slug: string | null;
  payload: string;
  created_at: number;
  who: string;
  user_id: string | null;
}

export function events(p: {
  since?: number; before?: number; limit?: number; kind?: string; slug?: string; user?: string;
} = {}) {
  return call<{ events: AdminEvent[] }>(`/admin/events${qs(p)}`);
}

/* Proposals. */

export type AdminProposal = Proposal & { slug: string; author_id: string };

export function openProposals() {
  return call<{ proposals: AdminProposal[] }>('/admin/proposals');
}

export function resolveProposal(id: string, action: 'accept' | 'reject') {
  return call<{ ok: true; status: string }>(`/admin/proposals/${enc(id)}/resolve`,
    { method: 'POST', body: JSON.stringify({ action }) });
}

export type ResolvedProposal = AdminProposal & {
  status: 'accepted' | 'rejected' | 'superseded';
  /** When it was settled, or null if that cannot be found. */
  resolved_at: number | null;
  resolved_how: 'admin' | 'votes' | null;
  /** The admin's display name when `resolved_how` is `admin`. */
  resolved_by: string | null;
};

/** Proposals no longer open, with their text, newest proposal first. */
export function proposalHistory(p: {
  status?: 'accepted' | 'rejected' | 'superseded'; slug?: string; user?: string; limit?: number; offset?: number;
} = {}) {
  return call<{ total: number; proposals: ResolvedProposal[] }>(`/admin/proposals/history${qs(p)}`);
}

export interface AdminRevision {
  id: string;
  slug: string;
  kind: 'transcript' | 'boundary';
  anchor: string;
  /** What readers are shown. */
  value: string;
  proposal_id: string | null;
  applied_at: number;
  /** From the proposal it was accepted from; null if that is gone. */
  original: string | null;
  start_s: number | null;
  end_s: number | null;
  author: string | null;
  author_id: string | null;
}

/** Every accepted correction, newest first; one round's with `slug`. */
export function revisions(p: { slug?: string; limit?: number; offset?: number } = {}) {
  return call<{ total: number; revisions: AdminRevision[] }>(`/admin/revisions${qs(p)}`);
}

/** A round's proposals in every state: the public round-page endpoint. */
export function roundProposals(slug: string) {
  return call<{ proposals: Proposal[] }>(`/rounds/${enc(slug)}/proposals`);
}
