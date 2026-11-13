/**
 * Proposals: open corrections to review, as on the old page; the history of
 * settled ones with their text and who settled them, and every correction
 * applied; and one round's proposals and applied revisions
 * (`#proposals/<slug>`).
 */

import { renderDiff, renderTimingDiff } from '../../diffview';
import { playClip, stop, onClipChange } from '../../clip';
import { parseSpan, type Span } from '../../speeches';
import { formatTime } from '../../waveform';
import type { Proposal } from '../../api';
import * as api from '../api';
import * as store from '../store';
import {
  h, clear, batch, mark, num, ago, when, errorBlock, loading, button, table, choices, status, link,
  roundHref, slugWords, describeError, capital, type Tone,
} from '../ui';
import type { View } from '../view';

type Tab = 'open' | 'history';
let tab: Tab = 'open';

function readSpans(p: Proposal): { from: Span; to: Span } | null {
  const to = parseSpan(p.proposed ?? '');
  const from = parseSpan(p.original ?? '', to ?? undefined);
  return from && to ? { from, to } : null;
}

function describeSpan(s: Span): string {
  return `${formatTime(s.start)} to ${formatTime(s.end)}`;
}

function diffOf(p: Proposal): HTMLElement {
  // A timing correction is a pair of times; a transcript correction is a
  // passage. Both read as a diff, but only one of them is prose.
  const span = p.kind === 'boundary' ? readSpans(p) : null;
  return span
    ? renderTimingDiff(`${p.anchor}  ${describeSpan(span.from)}`, `${p.anchor}  ${describeSpan(span.to)}`)
    : renderDiff(p.original ?? '', p.proposed ?? '');
}

// One clip plays at a time, so every button reads the same signal.
onClipChange(id => {
  document.querySelectorAll<HTMLElement>('[data-clip]').forEach(b => {
    const on = b.dataset.clip === id;
    b.setAttribute('aria-pressed', String(on));
    b.textContent = on ? 'Stop' : b.dataset.label!;
  });
});

const STATUS_TONE: Record<string, Tone> = { open: 'wait', accepted: 'ok', rejected: 'bad', superseded: 'none' };

function openItem(p: api.AdminProposal, after: () => void): HTMLElement {
  const result = h('p.adm-status', { role: 'status' });
  const actions = h('div.adm-actions');

  // Reviewing means hearing it: the speech's opening for a timing, the
  // moment around the passage for a transcript edit.
  // A transcript edit carries the times of its passage; the clip covers it.
  const span = p.kind === 'boundary' ? readSpans(p) : null;
  const at = span ? span.to.start : (p.start_s ?? null);
  if (at !== null) {
    const label = `Listen at ${formatTime(at)}`;
    const passage = !span && p.start_s !== null && p.end_s !== null && p.end_s > p.start_s
      ? Math.min(60, p.end_s - p.start_s + 4) : null;
    actions.append(h('button.adm-button', {
      type: 'button', 'data-clip': p.id, 'data-label': label, 'aria-pressed': 'false',
      onclick: () => playClip(p.id, p.slug, Math.max(0, at - 2), { seconds: passage ?? (p.kind === 'boundary' ? 10 : 14) }),
    }, label));
  }

  for (const action of ['accept', 'reject'] as const) {
    const b = button(action === 'accept' ? 'Accept' : 'Reject', async () => {
      for (const x of actions.querySelectorAll('button')) (x as HTMLButtonElement).disabled = true;
      try {
        stop();
        const r = await api.resolveProposal(p.id, action);
        status(result, `${capital(r.status)}.`);
        li.dataset.done = r.status;
        store.forget('proposals');
        setTimeout(after, 900);
      } catch (e) {
        for (const x of actions.querySelectorAll('button')) (x as HTMLButtonElement).disabled = false;
        status(result, describeError(e).text, true);
      }
    }, action === 'accept' ? 'primary' : '');
    actions.append(b);
  }
  actions.append(result);

  const li = h('li.adm-proposal', null,
    h('div.adm-proposal-head', null,
      link(roundHref(p.slug), slugWords(p.slug)),
      h('span.adm-quiet', null, `${p.kind === 'boundary' ? 'Timing' : 'Transcript'}, ${p.anchor}`),
      h('span.adm-quiet', null, 'by ', link(`#users/${p.author_id}`, p.author), `, ${ago(p.created_at)}`),
      h('span.adm-quiet', null, `score ${num(p.score)}`),
      link(`#proposals/${p.slug}`, 'Round history'),
    ),
    diffOf(p),
    p.note ? h('p.adm-proposal-note', null, p.note) : null,
    actions,
  );
  return li;
}

async function drawOpen(body: HTMLElement) {
  clear(body, loading());
  let open: api.AdminProposal[];
  try {
    ({ proposals: open } = await store.proposals());
  } catch (e) {
    clear(body, errorBlock(e, () => { store.forget('proposals'); void drawOpen(body); }));
    return;
  }
  const contributors = h('div', null, loading());
  clear(body,
    batch('Awaiting review', open.length ? `${num(open.length)} open, highest score first` : 'None',
      open.length
        ? h('ul.adm-proposals', null, open.map(p => openItem(p, () => void drawOpen(body))))
        : h('p.adm-empty', null, 'No proposals wait for review.')),
    batch('Contributors', 'Top 15 by reputation', contributors),
  );
  store.stats().then(s => clear(contributors, table({
    rows: s.contributors.map((c, i) => ({ ...c, i: i + 1 })),
    columns: [
      { key: 'i', label: '#', num: true, cell: c => num(c.i), class: 'adm-rank' },
      { key: 'name', label: 'Name', sort: c => c.name, cell: c => c.name },
      { key: 'rep', label: 'Rep', num: true, sort: c => c.rep, cell: c => num(c.rep) },
      { key: 'proposals', label: 'Proposals', num: true, sort: c => c.proposals, cell: c => num(c.proposals) },
    ],
  }))).catch(e => clear(contributors, errorBlock(e)));
}

/* History: settled proposals with their text, and what was applied. */

type Outcome = 'all' | 'accepted' | 'rejected' | 'superseded';
let outcome: Outcome = 'all';

function howSettled(p: api.ResolvedProposal): string {
  if (p.resolved_how === 'admin') return p.resolved_by ? `by ${p.resolved_by}` : 'by an admin';
  if (p.resolved_how === 'votes') return 'by votes';
  return p.status === 'superseded' ? 'by a later edit' : '';
}

function settledItem(p: api.ResolvedProposal): HTMLElement {
  return h('li.adm-proposal', null,
    h('div.adm-proposal-head', null,
      mark(capital(p.status), STATUS_TONE[p.status] ?? 'wait'),
      link(`#proposals/${p.slug}`, slugWords(p.slug)),
      h('span.adm-quiet', null, `${p.kind === 'boundary' ? 'Timing' : 'Transcript'}, ${p.anchor}`),
      h('span.adm-quiet', null, 'by ', link(`#users/${p.author_id}`, p.author), `, ${ago(p.created_at)}`),
      p.resolved_at || p.resolved_how
        ? h('span.adm-quiet', null, [capital(p.status), howSettled(p), p.resolved_at ? ago(p.resolved_at) : ''].filter(Boolean).join(' '))
        : null,
      h('span.adm-quiet', null, `score ${num(p.score)}`),
    ),
    diffOf(p),
    p.note ? h('p.adm-proposal-note', null, p.note) : null,
  );
}

function revisionTable(rows: api.AdminRevision[], withRound: boolean): HTMLElement {
  return table<api.AdminRevision>({
    rows,
    columns: [
      { key: 'at', label: 'Applied', cell: r => when(r.applied_at), class: 'adm-nowrap' },
      ...(withRound ? [{ key: 'round', label: 'Round', cell: (r: api.AdminRevision) => link(`#proposals/${r.slug}`, slugWords(r.slug)) }] : []),
      { key: 'kind', label: 'Kind', cell: r => r.kind === 'boundary' ? 'Timing' : capital(r.kind) },
      { key: 'anchor', label: 'Where', cell: r => h('code', null, r.anchor) },
      { key: 'value', label: 'Value now', cell: r => {
        const s = r.kind === 'boundary' ? parseSpan(r.value) : null;
        return s ? describeSpan(s) : r.value;
      } },
      { key: 'by', label: 'Proposed by', cell: r => r.author_id ? link(`#users/${r.author_id}`, r.author ?? 'unknown') : h('span.adm-quiet', null, r.author ?? 'unknown') },
    ],
    empty: 'Nothing has been applied.',
  });
}

async function drawHistory(body: HTMLElement) {
  clear(body, loading());
  const box = h('div.adm-group');
  const revBox = h('div.adm-group', null, loading());
  const lookup = h('input.adm-field.adm-search', { type: 'search', placeholder: 'Open a round by its slug', 'aria-label': 'Round slug' });
  const lookupForm = h('form.adm-toolbar', null, lookup, h('button.adm-button', { type: 'submit' }, 'Open'));
  lookupForm.addEventListener('submit', e => {
    e.preventDefault();
    const v = lookup.value.trim().replace(/^.*\/recordings\//, '').replace(/[/?#].*$/, '');
    if (v) location.hash = `#proposals/${v}`;
  });
  const filter = choices<Outcome>([['all', 'All'], ['accepted', 'Accepted'], ['rejected', 'Rejected'], ['superseded', 'Superseded']],
    outcome, o => { outcome = o; void load(0); });

  let rows: api.ResolvedProposal[] = [];
  let total = 0;
  const PAGE = 50;

  const load = async (offset: number) => {
    if (!offset) clear(box, loading());
    try {
      const res = await api.proposalHistory({ status: outcome === 'all' ? undefined : outcome, limit: PAGE, offset });
      rows = offset ? [...rows, ...res.proposals] : res.proposals;
      total = res.total;
      draw();
    } catch (e) {
      clear(box, errorBlock(e, () => void load(0)));
    }
  };

  const draw = () => clear(box,
    h('p.adm-count', null, `${num(total)} settled${rows.length < total ? `, ${num(rows.length)} shown` : ''}`),
    rows.length ? h('ul.adm-proposals', null, rows.map(settledItem)) : h('p.adm-empty', null, 'Nothing has been settled yet.'),
    rows.length < total ? h('button.adm-more', { type: 'button', onclick: () => void load(rows.length) },
      `Show ${num(Math.min(PAGE, total - rows.length))} more of ${num(total - rows.length)}`) : null,
  );

  clear(body,
    batch('Settled', 'Newest proposal first', h('div.adm-group', null, h('div.adm-toolbar', null, filter), lookupForm, box)),
    batch('Applied', 'Every correction readers see, newest first', revBox),
  );
  api.revisions({ limit: 100 }).then(r => clear(revBox,
    revisionTable(r.revisions, true),
    r.total > r.revisions.length ? h('p.adm-quiet.adm-note', null, `The newest ${num(r.revisions.length)} of ${num(r.total)}.`) : null,
  )).catch(e => clear(revBox, errorBlock(e)));
  await load(0);
}

/* One round. */

async function drawRound(body: HTMLElement, slug: string) {
  clear(body, loading());
  let open: Proposal[], settled: api.ResolvedProposal[], applied: api.AdminRevision[];
  try {
    const [r, hist, rev] = await Promise.all([
      api.roundProposals(slug), api.proposalHistory({ slug, limit: 200 }), api.revisions({ slug, limit: 200 }),
    ]);
    open = r.proposals.filter(p => p.status === 'open').sort((a, b) => b.created_at - a.created_at);
    settled = hist.proposals;
    applied = rev.revisions;
  } catch (e) {
    clear(body, errorBlock(e, () => void drawRound(body, slug)));
    return;
  }
  const count = (s: string) => settled.filter(p => p.status === s).length;

  clear(body,
    h('div.adm-detail-head', null,
      h('h2', null, slugWords(slug)),
      h('p.adm-quiet', null, h('code', null, slug), ' ', link(roundHref(slug), 'Open the round', true)),
    ),
    batch('Proposals', `${num(open.length)} open, ${num(count('accepted'))} accepted, ${num(count('rejected'))} rejected, ${num(count('superseded'))} superseded`,
      open.length || settled.length ? h('ul.adm-proposals', null,
        open.map(p => h('li.adm-proposal', null,
          h('div.adm-proposal-head', null,
            mark('Open', STATUS_TONE.open),
            h('span.adm-quiet', null, `${p.kind === 'boundary' ? 'Timing' : 'Transcript'}, ${p.anchor}`),
            h('span.adm-quiet', null, `by `, p.author_id ? link(`#users/${p.author_id}`, p.author) : p.author, `, ${ago(p.created_at)}`),
            h('span.adm-quiet', null, `score ${num(p.score)}`),
          ),
          diffOf(p),
          p.note ? h('p.adm-proposal-note', null, p.note) : null,
        )),
        settled.map(settledItem),
      ) : h('p.adm-empty', null, 'No proposals for this round.')),
    batch('Revisions', `${num(applied.length)} applied`, revisionTable(applied, false)),
  );
}

export const proposals: View = {
  show(body, tools, arg) {
    stop();
    const isTab = !arg || arg === 'history' || arg === 'open';
    if (arg === 'history') tab = 'history';
    if (!arg || arg === 'open') tab = 'open';
    clear(tools,
      choices<Tab>([['open', 'Open'], ['history', 'History']], isTab ? tab : ('' as Tab), t => { location.hash = `#proposals/${t}`; }),
      button('Refresh', () => { store.forget('proposals'); this.show(body, tools, arg); }),
    );
    if (!isTab) { void drawRound(body, arg!); return; }
    if (tab === 'history') void drawHistory(body);
    else void drawOpen(body);
  },
  hide() {
    stop();
  },
};
