/**
 * What more than one section reads, fetched once and shared.
 *
 * Overview needs the submission counts, the open proposals, the failed
 * sign-ins and the stats that the sections of their own also show; asking
 * twice would double the load on the Worker for nothing. Each entry is a
 * promise kept until something changes it (an action, the range control,
 * Refresh), so two sections opened in a row see the same numbers.
 */

import * as api from './api';

const cache = new Map<string, Promise<unknown>>();

function once<T>(key: string, load: () => Promise<T>): Promise<T> {
  let p = cache.get(key) as Promise<T> | undefined;
  if (!p) {
    p = load();
    cache.set(key, p);
    // A failure is not worth keeping: the next reader tries again.
    p.catch(() => { if (cache.get(key) === p) cache.delete(key); });
  }
  return p;
}

export function forget(...prefixes: string[]) {
  for (const k of [...cache.keys()]) {
    if (!prefixes.length || prefixes.some(p => k.startsWith(p))) cache.delete(k);
  }
  for (const fn of listeners) fn(prefixes);
}

const listeners = new Set<(prefixes: string[]) => void>();

/** Called after `forget`, so a section showing the data can redraw. */
export function onForget(fn: (prefixes: string[]) => void) {
  listeners.add(fn);
}

/** The range the telemetry views and the overview chart share. */
export let days = 30;
export function setDays(d: number) {
  days = d;
  forget('stats');
}

export const stats = () => once(`stats:${days}`, () => api.stats(days));

/**
 * The newest 200 submissions without their search records: enough for the
 * counts, the pipeline state and what is failed or stuck, and light enough to
 * load on every visit to the overview.
 */
export const submissionSummary = () =>
  once('submissions:summary', () => api.listSubmissions({ limit: 200, records: false }));

/**
 * Every failed submission still here, however old: the summary above is only
 * the newest 200, and a failure is what the overview exists to surface.
 */
export const failedSubmissions = () =>
  once('submissions:failed', () => api.listSubmissions({ status: 'failed', removed: false, limit: 200, records: false }));

/**
 * Whether the server calls a submission stuck, at which stage, and since when
 * that stage has been owed (its expected time less its typical length). The
 * judgement is the Worker's (`progress.stuck`), so the console and the
 * submitter's page never disagree about it.
 */
export function stuckAt(s: api.AdminSubmission): { stage: api.Stage; since: number } | null {
  const p = s.progress;
  if (!p.stuck || !p.stuckStage) return null;
  const stage = p.stages.find(st => st.key === p.stuckStage);
  if (!stage) return null;
  const since = stage.expectedAt !== null && stage.typicalSeconds !== null
    ? stage.expectedAt - stage.typicalSeconds
    : stage.startedAt ?? s.updated_at ?? s.created_at;
  return { stage, since };
}

export const proposals = () => once('proposals:open', () => api.openProposals());

export const sessions = () => once('sessions', () => api.sessions());

export const authFailures = () => once('auth', () => api.authFailures(30, 200));

export const rounds = () => once('rounds', () => api.listRounds());
