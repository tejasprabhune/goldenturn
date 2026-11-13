/**
 * Overview: what needs the owner now, then the totals and the activity chart
 * the old page opened with.
 *
 * "Needs attention" is gathered here from what the API reports: the
 * pipeline's last run, failed submissions, the ones the server calls stuck, open proposals,
 * repeated failed sign-ins and gaps in the archive. Each line links to the
 * screen where it can be dealt with.
 */

import { areaChart } from '../../chart';
import type { AdminSubmission } from '../api';
import * as store from '../store';
import {
  h, clear, batch, figures, pairs, mark, num, ago, age, stamp, date, errorBlock, loading,
  rangeControl, button, syncClock, type Tone,
} from '../ui';
import { restartButton } from '../restart';
import type { View } from '../view';

const TOTALS: Array<[string, string]> = [
  ['users', 'Accounts'],
  ['events', 'Events'],
  ['proposals', 'Edits proposed'],
  ['accepted', 'Edits accepted'],
  ['votes', 'Votes'],
  ['notes', 'Notes'],
  ['favorites', 'Saved rounds'],
  ['ratings', 'Ratings'],
  ['submissions', 'Submissions'],
  ['sessions_active', 'Active sessions'],
  ['prep_users', 'Prep access'],
];

/** A stage that has not finished, as a sentence opening. */
const NOT_YET: Record<string, string> = {
  audio: 'Audio not fetched',
  transcript: 'Not transcribed',
  speeches: 'Speeches not labelled',
  page: 'Page not published',
};

interface Item {
  tone: Tone;
  word: string;
  text: string;
  detail?: string;
  href: string;
  action: string;
  /** A failed or stuck round, restarted from the list itself. */
  restart?: AdminSubmission;
}

let chartCanvas: HTMLCanvasElement | null = null;
let chartSeries: number[] = [];
let chartDays = 30;

function drawChart() {
  if (chartCanvas && chartCanvas.isConnected) {
    areaChart(chartCanvas, chartSeries, [`${chartDays} days ago`, 'today']);
  }
}
window.addEventListener('resize', drawChart);

/** Days with no events still get a slot, or the curve hides the gaps. */
export function dailySeries(daily: Array<{ day: number; n: number }>, days: number): number[] {
  const byDay = new Map(daily.map(d => [d.day, d.n]));
  const today = Math.floor(Date.now() / 86_400_000);
  const out: number[] = [];
  for (let d = today - days + 1; d <= today; d++) out.push(byDay.get(d) ?? 0);
  return out;
}

async function attention(): Promise<{ items: Item[]; errors: unknown[] }> {
  const items: Item[] = [];
  const errors: unknown[] = [];
  const [subs, failedSubs, props, auth, rounds] = await Promise.allSettled([
    store.submissionSummary(), store.failedSubmissions(), store.proposals(), store.authFailures(), store.rounds(),
  ]);

  if (subs.status === 'fulfilled') {
    const s = subs.value;
    syncClock(s.submissions[0]?.progress.now);
    const waiting = s.submissions.filter(x => x.review !== 'removed'
      && ['fetching', 'transcribing', 'labelling', 'publishing'].includes(x.progress.status));
    const { lastRunAt, stalled } = s.pipeline;
    if (!lastRunAt) {
      items.push({ tone: 'bad', word: 'Ingest', text: 'The ingest run has never reported in.', href: '#submissions/ingest', action: 'Ingest log' });
    } else if (stalled || Date.now() / 1000 - lastRunAt > 2 * 3600) {
      items.push({
        tone: 'bad', word: 'Ingest',
        text: `The ingest has not run since ${stamp(lastRunAt)} (${ago(lastRunAt)}).`,
        detail: `${num(waiting.length)} ${waiting.length === 1 ? 'round is' : 'rounds are'} waiting on it. It runs every 15 minutes when healthy; check the "onboard submitted rounds" workflow.`,
        href: '#submissions/ingest', action: 'Ingest log',
      });
    }

    // Failed rounds come from their own query, so one older than the newest
    // 200 is not missed; removed ones are left out by the server.
    if (failedSubs.status === 'fulfilled') {
      const failed = failedSubs.value.submissions;
      const total = failedSubs.value.total;
      for (const f of failed.slice(0, 6)) items.push(failedItem(f));
      if (total > 6) {
        items.push({ tone: 'bad', word: 'Failed', text: `${num(total - 6)} more failed submissions.`, href: '#submissions/failed', action: 'All failed' });
      }
    } else errors.push(failedSubs.reason);

    // Stuck is the server's call, the same one the submitter's page makes.
    const stuck = s.submissions
      .map(x => ({ x, at: store.stuckAt(x) }))
      .filter((e): e is { x: AdminSubmission; at: NonNullable<ReturnType<typeof store.stuckAt>> } => e.at !== null)
      .sort((a, b) => a.at.since - b.at.since);
    for (const { x, at } of stuck.slice(0, 6)) {
      const { stage, since } = at;
      items.push({
        tone: 'wait', word: 'Stuck',
        text: x.title,
        detail: `${NOT_YET[stage.key] ?? stage.label} after ${age(since)}; the ingest ${stage.startedAt ? 'started it but has not finished' : 'has not started it'}. Submitted ${ago(x.created_at)} by ${x.author ?? 'a removed account'}.`,
        href: `#submissions/${x.object_id}`, action: 'Open', restart: x,
      });
    }
    if (stuck.length > 6) {
      items.push({ tone: 'wait', word: 'Stuck', text: `${num(stuck.length - 6)} more submissions waiting longer than usual.`, href: '#submissions', action: 'Submissions' });
    }

    const unreviewed = s.submissions.filter(x => x.review === 'unreviewed' && x.status !== 'failed').length;
    if (unreviewed) {
      items.push({ tone: 'none', word: 'Review', text: `${num(unreviewed)} ${unreviewed === 1 ? 'submission has' : 'submissions have'} not been confirmed.`, href: '#submissions', action: 'Submissions' });
    }
  } else errors.push(subs.reason);

  if (props.status === 'fulfilled') {
    const open = props.value.proposals;
    if (open.length) {
      const oldest = Math.min(...open.map(p => p.created_at));
      items.push({
        tone: 'wait', word: 'Proposals',
        text: `${num(open.length)} ${open.length === 1 ? 'correction waits' : 'corrections wait'} for review.`,
        detail: `The oldest was proposed ${ago(oldest)}.`,
        href: '#proposals', action: 'Review',
      });
    }
  } else errors.push(props.reason);

  if (auth.status === 'fulfilled') {
    for (const e of auth.value.by_email.filter(e => e.n >= 5).slice(0, 3)) {
      items.push({
        tone: 'wait', word: 'Sign-ins',
        text: `${num(e.n)} failed sign-ins for ${e.email} in ${auth.value.days} days.`,
        detail: `${e.known ? 'The account exists' : 'No account has this address'}; the last attempt was ${ago(e.last_at)}.`,
        href: '#users/sign-ins', action: 'Sign-ins',
      });
    }
  } else errors.push(auth.reason);

  if (rounds.status === 'fulfilled') {
    const r = rounds.value;
    if (r.index_error) {
      items.push({ tone: 'bad', word: 'Search', text: 'The search index could not be read.', detail: r.index_error, href: '#rounds', action: 'Rounds' });
    }
    const listed = r.rounds.filter(x => x.source !== 'media');
    const noAudio = listed.filter(x => !x.has_audio && x.submission?.review !== 'removed').length;
    const noTx = listed.filter(x => x.has_audio && !x.has_transcript).length;
    if (noAudio) items.push({ tone: 'none', word: 'Archive', text: `${num(noAudio)} rounds have no hosted audio.`, href: '#rounds/no-audio', action: 'Rounds' });
    if (noTx) items.push({ tone: 'none', word: 'Archive', text: `${num(noTx)} rounds have audio but no transcript.`, href: '#rounds/no-transcript', action: 'Rounds' });
    if (r.counts.orphans) {
      items.push({ tone: 'none', word: 'Archive', text: `${num(r.counts.orphans)} ${r.counts.orphans === 1 ? 'set' : 'sets'} of files in storage belong to no round.`, href: '#rounds/orphans', action: 'Rounds' });
    }
  } else errors.push(rounds.reason);

  return { items, errors };
}

function failedItem(f: AdminSubmission): Item {
  const reason = f.progress.failure?.reason ?? f.note ?? 'No reason was stored.';
  return {
    tone: 'bad', word: 'Failed', text: f.title,
    detail: `${reason} Submitted ${ago(f.created_at)} by ${f.author ?? 'a removed account'}; ${f.attempts} ${f.attempts === 1 ? 'attempt' : 'attempts'}.`,
    href: `#submissions/${f.object_id}`, action: 'Diagnose', restart: f,
  };
}

function attentionList(items: Item[], changed: () => void): HTMLElement {
  if (!items.length) return h('p.adm-empty', null, 'Nothing needs attention.');
  return h('ul.adm-attn', null, items.map(i => h('li', null,
    mark(i.word, i.tone),
    h('div.adm-attn-text', null, h('p', null, i.text), i.detail ? h('p.adm-quiet', null, i.detail) : null),
    h('span.adm-attn-actions', null,
      i.restart ? restartButton(i.restart, changed) : null,
      h('a.adm-link', { href: i.href }, i.action)),
  )));
}

async function render(body: HTMLElement) {
  clear(body, loading());

  const attnBody = h('div', null, loading('Looking for problems.'));
  const totalsBody = h('div', null, loading());
  const chartWrap = h('div.chart-wrap.adm-chart', null);
  const pipeBody = h('div', null, loading());
  const attnCount = h('span');

  clear(body,
    batch('Needs attention', attnCount, attnBody),
    batch('Totals', 'All time', totalsBody),
    batch('Activity', `Events per day, last ${store.days} days`,
      h('div.adm-panel-tools', null, rangeControl(store.days, d => { store.setDays(d); void render(body); })),
      chartWrap),
    batch('Pipeline', 'Submissions and ingest', pipeBody),
  );

  void attention().then(({ items, errors }) => {
    attnCount.textContent = items.length ? `${num(items.length)} ${items.length === 1 ? 'item' : 'items'}` : 'None';
    clear(attnBody, attentionList(items, () => void render(body)), errors.map(e => errorBlock(e)));
  });

  store.stats().then(s => {
    const t = s.totals;
    clear(totalsBody, figures([
      ...TOTALS.map(([k, label]): [string, string] => [label, num(t[k] ?? 0)]),
      ['Failed sign-ins', h('span', null, num(t.auth_failed ?? 0), h('span.adm-context', null, ` / ${s.days} d`))],
    ]));
    chartCanvas = h('canvas.admin-canvas.adm-canvas-tall', { 'aria-label': `Events per day over the last ${s.days} days` });
    chartSeries = dailySeries(s.daily, s.days);
    chartDays = s.days;
    clear(chartWrap, chartCanvas);
    requestAnimationFrame(drawChart);
  }).catch(e => {
    clear(totalsBody, errorBlock(e, () => { store.forget('stats'); void render(body); }));
    clear(chartWrap);
  });

  Promise.all([store.submissionSummary(), store.rounds().catch(() => null)]).then(([s, r]) => {
    clear(pipeBody, pairs([
      ['Last ingest run', s.pipeline.lastRunAt
        ? h('span', null, `${stamp(s.pipeline.lastRunAt)} `, h('span.adm-quiet', null, `(${ago(s.pipeline.lastRunAt)})`))
        : 'never'],
      ['Ingest state', s.pipeline.stalled ? mark('Stalled', 'bad') : mark('Running', 'ok')],
      ['Waiting for audio', num(s.counts.pending)],
      ['Audio in', num(s.counts.ingested)],
      ['Failed', s.counts.failed ? mark(num(s.counts.failed), 'bad') : '0'],
      ['Removed', num(s.counts.removed)],
      ['Site last deployed', r?.site.last_deploy_at ? `${date(r.site.last_deploy_at)} (${ago(r.site.last_deploy_at)})` : 'unknown'],
    ]));
  }).catch(e => clear(pipeBody, errorBlock(e)));
}

export const overview: View = {
  show(body, tools) {
    clear(tools, button('Refresh', () => { store.forget(); void render(body); }));
    if (!body.childElementCount) void render(body);
    else requestAnimationFrame(drawChart);
  },
};
