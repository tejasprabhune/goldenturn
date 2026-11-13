/**
 * A submitted round between its submission and its page.
 *
 * The page a round lives on is built at deploy time, so for the first stretch
 * of its life a round has no page at all. The Worker keeps track of how far
 * the ingest has got with it, and this is the client for that record: the
 * waiting page polls it, the account page lists a submitter's own rounds by
 * it, and the submit form uses it to send a submitter somewhere that exists.
 */

import { API, getToken, signOut, NotSignedIn } from './api';

export type StageKey = 'submitted' | 'audio' | 'transcript' | 'speeches' | 'page';
export type StageState = 'done' | 'active' | 'waiting' | 'failed';
export type RoundStatus =
  | 'fetching' | 'transcribing' | 'labelling' | 'publishing' | 'published' | 'failed' | 'removed';

export interface Stage {
  key: StageKey;
  label: string;
  state: StageState;
  /** When it was done, or when it failed. */
  at: number | null;
  /**
   * When the ingest reported starting it, if it has. For the page, when the
   * rebuild was reported or else when the audio arrived.
   */
  startedAt: number | null;
  reason: string | null;
  /** How long the stage usually takes once it can start; null for `submitted`. */
  typicalSeconds: number | null;
  /** When a stage still owed should be done. In the past means overdue. */
  expectedAt: number | null;
  /** Owed far longer than normal while the ingest is running. */
  stuck: boolean;
}

/** What was sent in, in the shape `POST /recordings` takes. */
export interface SubmittedFields {
  title: string;
  link: string;
  year: string;
  tournament: string;
  format: string;
  level: string;
  resolution: string;
  aff: string;
  neg: string;
  decision: string;
  tags: string[];
}

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
  status: RoundStatus;
  ingestStatus: 'pending' | 'ingested' | 'failed';
  review: 'unreviewed' | 'confirmed' | 'removed';
  stages: Stage[];
  failure: { stage: StageKey | null; reason: string; at: number | null; final: boolean } | null;
  audio: { url: string; source: 'stored' | 'submitted'; peaksUrl: string | null } | null;
  /** Null once an admin has removed the round. */
  link: string | null;
  linkKind: 'youtube' | 'vimeo' | 'file';
  media: { audio: boolean; peaks: boolean; transcript: boolean; speeches: boolean };
  page: { path: string; url: string; exists: boolean; hasPlayer: boolean; builtAt: number | null };
  pipeline: { lastRunAt: number | null; stalled: boolean };
  /** The server's own "stuck" signal, and the first stage it is about. */
  stuck: boolean;
  stuckStage: StageKey | null;
  /** When every stage should be done; null once settled or while the ingest is stalled. */
  estimatedDoneAt: number | null;
  now: number;
  /** Only with `?submitted=1`, and null unless asked by the submitter or an admin. */
  submitted?: SubmittedFields | null;
}

/** A round that was never submitted, or an address that names nothing. */
export class NoSuchRound extends Error {
  constructor() {
    super('no such submission');
    this.name = 'NoSuchRound';
  }
}

/**
 * Anonymous and safe to poll: the ingest moves every 15 minutes at most.
 * `submitted` asks for what was sent in as well, which only the submitter (or
 * an admin) is given, so the session goes with it; ask once, not every poll.
 */
export async function getProgress(ref: string, opts: { submitted?: boolean } = {}): Promise<Progress> {
  const token = opts.submitted ? getToken() : null;
  const res = await fetch(
    `${API}/rounds/${encodeURIComponent(ref)}/progress${opts.submitted ? '?submitted=1' : ''}`,
    token ? { headers: { Authorization: `Bearer ${token}` } } : {},
  );
  if (res.status === 404) throw new NoSuchRound();
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as any).error ?? `request failed (${res.status})`);
  return body as Progress;
}

export interface MySubmission {
  object_id: string;
  slug: string;
  title: string;
  year: string | null;
  tournament: string | null;
  /** Exactly the progress object's status, one of the seven words. */
  status: RoundStatus;
  reason: string | null;
  created_at: number;
  updated_at: number;
  stuck: boolean;
  /** The progress object's `pipeline.stalled`. */
  stalled: boolean;
  estimatedDoneAt: number | null;
  /** Null only for an old round that has left search. */
  submitted: SubmittedFields | null;
}

export async function listMySubmissions(): Promise<{ submissions: MySubmission[] }> {
  const token = getToken();
  if (!token) throw new NotSignedIn();
  const res = await fetch(`${API}/me/submissions`, { headers: { Authorization: `Bearer ${token}` } });
  if (res.status === 401) { signOut(); throw new NotSignedIn(); }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error((body as any).error ?? `request failed (${res.status})`);
  return body as { submissions: MySubmission[] };
}

/** Where a round's progress is shown. Takes a slug or an objectID. */
export function pendingHref(ref: string): string {
  return `/recordings/pending/?ref=${encodeURIComponent(ref)}`;
}

/**
 * "4 min ago", against the server's clock rather than the browser's, which
 * can be anything.
 */
export function ago(at: number, now: number): string {
  const s = Math.max(0, now - at);
  if (s < 45) return 'just now';
  if (s < 90 * 60) return `${Math.max(1, Math.round(s / 60))} min ago`;
  if (s < 36 * 3600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} days ago`;
}

/** "in 6 min", for the next scheduled ingest run. */
export function inMinutes(at: number, now: number): string {
  const s = at - now;
  if (s <= 60) return 'any minute now';
  return `in about ${Math.round(s / 60)} min`;
}

/** "about 20 minutes", "about an hour": a typical duration, said roughly. */
export function aboutDuration(seconds: number): string {
  const min = Math.max(1, Math.round(seconds / 60));
  if (min < 55) return `about ${min} minutes`;
  const h = Math.round(min / 60);
  return h === 1 ? 'about an hour' : `about ${h} hours`;
}

const DAY = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
const CLOCK = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit' });

/** Time of day when it was today, the date and time when it was not. */
export function stamp(at: number, now: number): string {
  const d = new Date(at * 1000);
  const sameDay = DAY.format(d) === DAY.format(new Date(now * 1000));
  return sameDay ? CLOCK.format(d) : `${DAY.format(d)} ${CLOCK.format(d)}`;
}

/** The whole date, for the head of the page. */
export function longDate(at: number): string {
  const d = new Date(at * 1000);
  return `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })} at ${CLOCK.format(d)}`;
}

/** The ingest runs on a 15 minute schedule; the next stage moves at the next run. */
export const RUN_EVERY = 15 * 60;

/** One word for each summary status, as the account page and the queue show it. */
export const STATUS_WORD: Record<RoundStatus, string> = {
  fetching: 'fetching audio',
  transcribing: 'transcribing',
  labelling: 'labelling speeches',
  publishing: 'publishing',
  published: 'published',
  failed: 'failed',
  removed: 'removed',
};
