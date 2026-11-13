/**
 * A submitted round's steps drawn as one thin bar, and the one quiet line
 * under it.
 *
 * Shared by the two places a round in processing is shown: its own page once
 * that has been built, where the bar stands in for the transcript until there
 * is one, and /recordings/pending before it has been. Both poll the same
 * record on the same schedule, so that lives here too. The styles are in
 * styles/progress.css.
 */

import {
  stamp, aboutDuration, inMinutes, pendingHref, RUN_EVERY,
  type Progress, type Stage, type StageKey,
} from './progress';

/** The ingest moves every 15 minutes; checking every 20 seconds is plenty. */
export const POLL_MS = 20_000;

const SHORT: Record<StageKey, string> = {
  submitted: 'Submitted', audio: 'Audio', transcript: 'Transcript', speeches: 'Speeches', page: 'Page',
};

const STATE_WORD: Record<string, string> = {
  done: 'done', active: 'in progress', waiting: 'waiting', failed: 'failed',
};

export const FAILED_TITLE: Record<string, string> = {
  audio: 'The audio could not be fetched from the link.',
  transcript: 'The transcript could not be made this time.',
  speeches: 'The speeches could not be marked this time.',
  page: 'The page could not be published.',
};

/**
 * One segment per stage in one bar; under each its name and one figure.
 * `omit` leaves stages out, as the round's own page does with the page.
 */
export function renderSteps(list: HTMLElement, p: Progress, omit: StageKey[] = []) {
  list.innerHTML = '';
  for (const s of p.stages) {
    if (omit.includes(s.key)) continue;
    const li = document.createElement('li');
    li.className = 'step';
    li.dataset.state = s.stuck ? 'stuck' : s.state;
    li.dataset.key = s.key;

    const seg = document.createElement('span');
    seg.className = 'step-seg';
    seg.setAttribute('aria-hidden', 'true');

    const label = document.createElement('span');
    label.className = 'step-label';
    label.textContent = SHORT[s.key] ?? s.label;
    const sr = document.createElement('span');
    sr.className = 'sr-only';
    sr.textContent = `: ${STATE_WORD[s.state]}`;
    label.appendChild(sr);

    const at = document.createElement('span');
    at.className = 'step-at';
    at.textContent = stepFigure(s, p);

    li.append(seg, label, at);
    list.appendChild(li);
  }
}

/** When it finished, or how long it usually takes while it is under way. */
export function stepFigure(s: Stage, p: Progress): string {
  if (s.state === 'done' && s.at) return stamp(s.at, p.now);
  if (s.state === 'failed') return 'failed';
  if (s.state === 'active') {
    if (s.stuck) return 'taking longer';
    return s.typicalSeconds ? aboutDuration(s.typicalSeconds).replace(' minutes', ' min') : '';
  }
  return '';
}

/** The quiet line under the bar while nothing has stopped for good. */
export function progressNote(p: Progress): { text: string; tone: string } {
  if (finished(p)) return { text: '', tone: '' };
  if (p.pipeline.stalled) {
    return { text: 'The ingest is not running; Tejas has been told.', tone: 'bad' };
  }
  if (p.stuck) {
    return { text: 'This is taking much longer than usual; Tejas can see it.', tone: 'bad' };
  }
  if (p.estimatedDoneAt !== null) {
    return {
      text: p.estimatedDoneAt - p.now <= 60
        ? 'Usually done any minute now'
        : `Usually done about ${stamp(p.estimatedDoneAt, p.now)}`,
      tone: '',
    };
  }
  return { text: `Next check ${inMinutes(nextRun(p), p.now)}`, tone: '' };
}

/**
 * The single line the round's own page keeps under the bar: a failure that
 * nothing will retry, with its reason, wins over a stalled or stuck ingest,
 * which wins over a step that is retried by itself, which wins over the
 * estimate. `resubmit` is whether the failure is one a new link can fix.
 */
export function statusLine(p: Progress): { text: string; tone: string; resubmit: boolean } {
  const f = p.failure;
  if (p.status === 'removed') {
    return { text: f?.reason ?? 'This round was removed.', tone: 'bad', resubmit: false };
  }
  if (f && f.final && f.stage) return { text: firstSentence(f.reason), tone: 'bad', resubmit: true };
  if (f && !f.final && f.stage && !p.pipeline.stalled && !p.stuck) {
    return {
      text: `${FAILED_TITLE[f.stage] ?? 'A step failed.'} It is tried again at the next run.`,
      tone: '',
      resubmit: false,
    };
  }
  return { ...progressNote(p), resubmit: false };
}

/** The first sentence says what went wrong; the button says what to do. */
export function firstSentence(reason: string): string {
  return reason.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? reason;
}

export function resubmitHref(p: Progress): string {
  return `/recordings/add?resubmit=${encodeURIComponent(p.id)}`;
}

export function nextRun(p: Progress): number {
  const last = p.pipeline.lastRunAt ?? p.now;
  let next = last + RUN_EVERY;
  while (next < p.now) next += RUN_EVERY;
  return next;
}

/** Nothing more will happen to it by itself. */
export function finished(p: Progress): boolean {
  return p.status === 'published' || p.status === 'removed'
    || (p.status === 'failed' && (p.failure?.final ?? true));
}

/** Where to follow a round: its own page once that exists, the pending page before. */
export function followHref(p: Progress): string {
  return p.page.exists && p.status !== 'removed' ? p.page.path : pendingHref(p.id);
}

/**
 * Runs `tick` every POLL_MS while the tab is visible, and at once when the
 * reader comes back to it after a while.
 */
export function poller(tick: () => Promise<void> | void) {
  let timer: number | undefined;
  const stop = () => {
    window.clearInterval(timer);
    timer = undefined;
  };
  const start = () => {
    stop();
    timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void tick();
    }, POLL_MS);
  };
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && timer !== undefined) void tick();
  });
  return { start, stop, running: () => timer !== undefined };
}
