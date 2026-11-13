/**
 * Submissions: every round submitted through the site, and one submission in
 * full.
 *
 * The list is the queue: stage, age and submitter, filterable by state. A
 * submission opened (`#submissions/<id>`) shows everything needed to tell why
 * it is where it is without leaving the screen: the failure in plain words and
 * the raw error the ingest stored, each stage with its times, the files in
 * storage, whether the page exists and has a player, and every event the
 * ingest reported for it. From there it can be retried, given a corrected
 * link, removed, confirmed or have its details edited, each with a dialog that
 * says what will happen and then what did.
 */

import * as api from '../api';
import * as store from '../store';
import {
  h, clear, batch, figures, pairs, mark, statusMark, num, age, ago, stamp, full, when, errorBlock,
  loading, button, table, choices, confirm, status, link, roundHref, debounce, describeError,
  syncClock, have, capital, type Tone,
} from '../ui';
import { restartButton, restartMenu, submitterMustFix, emailSubmitter } from '../restart';
import type { View } from '../view';

type Filter = 'all' | 'failed' | 'pending' | 'ingested' | 'removed';
const PAGE = 50;

let filter: Filter = 'all';
let query = '';

/* The list. */

function listParams(offset: number) {
  return {
    status: filter === 'failed' || filter === 'pending' || filter === 'ingested' ? filter : undefined,
    review: filter === 'removed' ? 'removed' : undefined,
    // The counts beside each filter leave removed rounds out; so does the list.
    removed: filter === 'failed' || filter === 'pending' || filter === 'ingested' ? false : undefined,
    q: query.trim() || undefined,
    limit: PAGE,
    offset,
    records: false,
  };
}

const KIND: Record<string, string> = { youtube: 'YouTube', vimeo: 'Vimeo', file: 'File' };

function stageCell(s: api.AdminSubmission): HTMLElement {
  const st = s.review === 'removed' ? 'removed' : s.progress.status;
  const el = statusMark(st);
  const stuck = store.stuckAt(s);
  if (stuck) {
    return h('span.adm-stack', null, el,
      h('span.adm-bad', null, `stuck: ${stuck.stage.label.toLowerCase()}, ${age(stuck.since)}`));
  }
  return el;
}

async function drawList(body: HTMLElement, tools: HTMLElement) {
  clear(tools,
    button('Refresh', () => { store.forget('submissions'); clear(body); void drawList(body, tools); }));

  const figs = h('div.adm-panel', null, loading());
  const listBox = h('div.adm-group', null, loading());
  const logBox = h('div', null, loading());
  const search = h('input.adm-field.adm-search', {
    type: 'search', placeholder: 'Search titles', 'aria-label': 'Search submissions', value: query,
  });
  const filterBox = h('div');
  clear(body,
    figs,
    h('div.adm-panel', null, h('div.adm-toolbar', null, search, filterBox), listBox),
    h('div', { id: 'ingest-log' }, batch('Ingest log', 'Newest first', logBox)),
  );

  let rows: api.AdminSubmission[] = [];
  let total = 0;

  const load = async (offset: number) => {
    if (!offset) clear(listBox, loading());
    let res: api.SubmissionList;
    try {
      res = await api.listSubmissions(listParams(offset));
    } catch (e) {
      clear(listBox, errorBlock(e, () => void load(0)));
      return null;
    }
    syncClock(res.submissions[0]?.progress.now);
    rows = offset ? [...rows, ...res.submissions] : res.submissions;
    total = res.total;
    drawTable();
    return res;
  };

  const drawTable = () => {
    const more = rows.length < total
      ? h('button.adm-more', { type: 'button', onclick: () => void load(rows.length) },
        `Show ${num(Math.min(PAGE, total - rows.length))} more of ${num(total - rows.length)}`)
      : null;
    clear(listBox,
      h('p.adm-count', null, `${num(total)} ${total === 1 ? 'submission' : 'submissions'}${rows.length < total ? `, ${num(rows.length)} shown` : ''}`),
      table<api.AdminSubmission>({
        rows,
        sortKey: 'age',
        sortDir: 'asc',
        columns: [
          { key: 'title', label: 'Round', sort: s => s.title,
            cell: s => h('span.adm-stack', null, h('a.adm-link', { href: `#submissions/${s.object_id}` }, s.title),
              h('span.adm-quiet', null, [s.tournament, s.year].filter(Boolean).join(', '))) },
          { key: 'stage', label: 'Stage', sort: s => s.review === 'removed' ? 'zz' : s.progress.status, cell: stageCell },
          { key: 'age', label: 'Age', num: true, sort: s => -s.created_at, cell: s => when(s.created_at, () => age(s.created_at)) },
          { key: 'updated', label: 'Updated', num: true, wide: true, sort: s => -(s.updated_at ?? 0), cell: s => when(s.updated_at, () => ago(s.updated_at)) },
          { key: 'author', label: 'Submitter', sort: s => s.author ?? '',
            cell: s => s.author_id ? link(`#users/${s.author_id}`, s.author ?? 'unknown') : h('span.adm-quiet', null, 'account gone') },
          { key: 'attempts', label: 'Tries', num: true, wide: true, sort: s => s.attempts, cell: s => num(s.attempts) },
          { key: 'kind', label: 'Source', wide: true, sort: s => s.progress.linkKind, cell: s => KIND[s.progress.linkKind] ?? s.progress.linkKind },
          // Failed or stuck: restarted from here, without opening the round.
          { key: 'act', label: '', class: 'adm-row-action', cell: s =>
            (s.progress.status === 'failed' || s.progress.stuck) && s.review !== 'removed'
              ? restartButton(s, () => void load(0)) ?? '' : '' },
        ],
        onOpen: s => { location.hash = `#submissions/${s.object_id}`; },
        empty: query ? 'No submissions match.' : 'None.',
      }),
      more,
    );
  };

  search.addEventListener('input', debounce(() => { query = search.value; void load(0); }, 300));

  const first = await load(0);
  if (first) {
    const c = first.counts;
    const p = first.pipeline;
    clear(filterBox, choices<Filter>([
      ['all', 'All'],
      ['failed', 'Failed', c.failed],
      ['pending', 'Waiting for audio', c.pending],
      ['ingested', 'Audio in', c.ingested],
      ['removed', 'Removed', c.removed],
    ], filter, f => { filter = f; void load(0); }));
    clear(figs,
      figures([
        ['Waiting for audio', num(c.pending)],
        ['Audio in', num(c.ingested)],
        ['Failed', c.failed ? h('span.adm-bad', null, num(c.failed)) : '0'],
        ['Removed', num(c.removed)],
        ['Last ingest run', p.lastRunAt ? ago(p.lastRunAt) : 'never', p.lastRunAt ? full(p.lastRunAt) : undefined],
      ]),
      p.stalled ? h('p.adm-note.adm-bad', null,
        `The ingest has not reported for more than two hours (last ${p.lastRunAt ? stamp(p.lastRunAt) : 'never'}). Nothing below will move until it runs again.`) : null,
    );
  } else {
    clear(figs, h('p.adm-quiet', null, 'Counts unavailable.'));
  }

  void ingestLog(logBox);
  if (location.hash === '#submissions/ingest') {
    requestAnimationFrame(() => document.getElementById('ingest-log')?.scrollIntoView({ block: 'start' }));
  }
}

const STATE_TONE: Record<string, Tone> = { done: 'ok', failed: 'bad', started: 'busy', queued: 'wait', skipped: 'wait', active: 'busy', waiting: 'none' };

async function ingestLog(into: HTMLElement) {
  try {
    const { events } = await api.ingestEvents(undefined, 100);
    clear(into, table<Required<api.IngestEvent>>({
      rows: events,
      page: 25,
      columns: [
        { key: 'at', label: 'When', cell: e => when(e.created_at), class: 'adm-nowrap' },
        { key: 'stage', label: 'Stage', cell: e => e.stage },
        { key: 'state', label: 'State', cell: e => mark(capital(e.state), STATE_TONE[e.state] ?? 'wait') },
        { key: 'round', label: 'Round', cell: e => e.object_id ? link(`#submissions/${e.object_id}`, e.slug ?? e.object_id)
          : h('span.adm-quiet', null, e.stage === 'run' ? 'run heartbeat' : e.stage === 'dispatch' ? 'starting the run' : '') },
        { key: 'note', label: 'Note', cell: e => e.note ? h('span.adm-clip', { title: e.note }, e.note) : '' },
      ],
      empty: 'The ingest has reported nothing.',
    }));
  } catch (e) {
    clear(into, errorBlock(e));
  }
}

/* One submission. */

function hintFor(s: api.AdminSubmission): string | null {
  const note = s.note ?? '';
  if (s.progress.linkKind === 'youtube' && /bot|sign in|cookies/i.test(note)) {
    return 'YouTube is refusing the ingest runner (its bot check). Retrying from the same runner usually fails the same way; a Dropbox or direct file link for the same recording avoids it.';
  }
  if (/moov atom|Invalid data/i.test(note)) {
    return 'The downloaded file is not a complete recording. Open the link: it is likely a preview page, a folder, or a file still uploading. Correct the link to the file itself.';
  }
  if (/403|404|not found|forbidden/i.test(note)) {
    return 'The source refused the download or the file is gone. Check the link opens in a private window.';
  }
  return null;
}

function diagnosis(s: api.AdminSubmission, after: () => void): HTMLElement | null {
  const p = s.progress;
  const f = p.failure;
  const lastRun = p.pipeline.lastRunAt;
  if (s.review === 'removed') {
    return batch('Removed', f?.at ? ago(f.at) : '',
      h('p', null, f?.reason ?? 'This round was removed by an admin.'),
      s.note ? pairs([['Note', s.note]]) : null);
  }

  if (f) {
    const hint = hintFor(s);
    const lastFail = s.events.find(e => e.state === 'failed');
    // Who can mend it decides what comes first: the submitter's link, or a
    // restart from here.
    const theirs = f.final && submitterMustFix(s);
    const email = f.final ? emailSubmitter(s, !theirs) : null;
    return batch('Diagnosis', h('span.adm-bad', null, 'Failed'),
      h('p.adm-lead', null, f.reason),
      hint ? h('p', null, hint) : null,
      h('div.adm-actions', null,
        theirs ? email : restartMenu(s, after, true),
        theirs ? restartMenu(s, after) : email,
        theirs ? h('span.adm-quiet', null, 'Only the submitter can fix this link.') : null),
      pairs([
        ['Stage', f.stage ? p.stages.find(st => st.key === f.stage)?.label ?? f.stage : 'none'],
        ['Failed at', f.at ? `${full(f.at)} (${ago(f.at)})` : 'unknown'],
        ['Retries', f.final ? 'None by itself. Restart it, correct the link, or have it submitted again.' : 'The next ingest run tries again.'],
        ['Attempts', num(s.attempts)],
        ['Source', h('span.adm-inline', null, KIND[p.linkKind] ?? p.linkKind, link(s.link, s.link, true))],
        ['Ingest', p.pipeline.stalled || !lastRun || p.now - lastRun > 2 * 3600
          ? h('span.adm-bad', null, `Not running; last reported ${lastRun ? `${stamp(lastRun)} (${ago(lastRun)})` : 'never'}. A retry waits until it runs again.`)
          : `Last reported ${lastRun ? ago(lastRun) : 'never'}`],
      ]),
      h('div.adm-group', null,
        h('h3', null, 'Stored error'),
        s.note ? h('pre.adm-pre.adm-error-text', null, s.note) : h('p.adm-quiet', null, 'The ingest stored no error text.'),
        lastFail && lastFail.note && lastFail.note !== s.note
          ? h('div.adm-group', null, h('h3', null, `Last failed event, ${stamp(lastFail.created_at)}`), h('pre.adm-pre', null, lastFail.note))
          : null,
      ),
    );
  }

  const stuck = store.stuckAt(s);
  if (stuck || p.pipeline.stalled) {
    const active = p.stages.filter(st => st.state === 'active');
    const typical = stuck?.stage.typicalSeconds;
    return batch('Diagnosis', h('span', null, stuck ? 'Stuck' : 'Waiting'),
      h('p.adm-lead', null, stuck
        ? `${stuck.stage.label} has been owed for ${age(stuck.since)}${typical ? `; it usually takes ${duration(typical)}` : ''}.`
        : `${active.map(st => st.label).join(' and ') || 'The next stage'} has not finished.`),
      stuck ? h('div.adm-actions', null, restartMenu(s, after, true)) : null,
      p.pipeline.stalled
        ? h('p', null, `The ingest has not reported since ${lastRun ? `${stamp(lastRun)} (${ago(lastRun)})` : 'ever'}. Nothing moves until it runs again; check the "onboard submitted rounds" workflow before retrying.`)
        : h('p', null, 'The ingest is running, so this round is being skipped or retried without success. The events below say which.'),
    );
  }
  return null;
}

/** "1 min", "3 h 10 min": how long a stage took. */
function duration(s: number): string {
  if (s < 60) return `${Math.max(0, Math.round(s))} s`;
  if (s < 3600) return `${Math.round(s / 60)} min`;
  const hrs = Math.floor(s / 3600);
  const min = Math.round((s % 3600) / 60);
  if (hrs < 48) return min ? `${hrs} h ${min} min` : `${hrs} h`;
  return `${Math.round(s / 86400)} d`;
}

function stagesTable(p: api.Progress): HTMLElement {
  return table<api.Stage>({
    rows: p.stages,
    columns: [
      { key: 'label', label: 'Stage', cell: st => st.label, class: 'adm-nowrap' },
      { key: 'state', label: 'State', cell: st => st.stuck
        ? mark('Stuck', 'bad', 'Owed far longer than usual while the ingest is running')
        : mark(capital(st.state === 'active' ? (st.startedAt ? 'under way' : 'next') : st.state), STATE_TONE[st.state] ?? 'wait') },
      { key: 'started', label: 'Started', cell: st => when(st.startedAt), class: 'adm-nowrap' },
      { key: 'at', label: 'Ended', cell: st => when(st.at), class: 'adm-nowrap' },
      { key: 'took', label: 'Took', num: true, cell: st => st.at && st.startedAt && st.state === 'done' ? duration(Math.max(0, st.at - st.startedAt)) : '' },
      { key: 'due', label: 'Due', cell: st => st.expectedAt
        ? h('span', st.expectedAt < p.now ? { class: 'adm-bad', title: 'Overdue' } : null, when(st.expectedAt))
        : '', class: 'adm-nowrap' },
      { key: 'typical', label: 'Usually', num: true, wide: true, cell: st => st.typicalSeconds ? duration(st.typicalSeconds) : '' },
      { key: 'reason', label: 'Reason', cell: st => st.reason ?? '' },
    ],
  });
}

function mediaPairs(p: api.Progress): HTMLElement {
  return pairs([
    ['Audio', h('span.adm-inline', null, have(p.media.audio),
      p.audio ? link(p.audio.url, p.audio.source === 'stored' ? 'stored copy' : 'playing from the submitted link', true) : null)],
    ['Waveform', have(p.media.peaks)],
    ['Transcript', have(p.media.transcript)],
    ['Speech labels', have(p.media.speeches)],
    ['Page', h('span.adm-inline', null,
      p.page.exists ? (p.page.hasPlayer ? mark('Live with player', 'ok') : mark('Live, no player', 'wait')) : mark('Not built', 'none'),
      link(p.page.url, p.page.path, true))],
    ['Page built', p.page.builtAt ? `${full(p.page.builtAt)} (${ago(p.page.builtAt)})` : 'not yet'],
  ]);
}

function recordPairs(s: api.AdminSubmission): HTMLElement {
  const r = s.record;
  return pairs([
    ['Title', s.title],
    ['Round', s.progress.teams ? `${s.progress.round}: ${s.progress.teams.aff} (aff) vs ${s.progress.teams.neg} (neg)` : s.progress.round],
    ['Tournament', [s.tournament, s.year].filter(Boolean).join(', ')],
    ['Link', h('span.adm-inline', null, link(s.link, s.link, true), h('span.adm-quiet', null, KIND[s.progress.linkKind] ?? ''))],
    ['Submitter', s.author_id
      ? h('span.adm-inline', null, link(`#users/${s.author_id}`, s.author ?? 'unknown'), h('span.adm-quiet', null, s.author_email ?? ''))
      : h('span.adm-quiet', null, 'The account is gone')],
    ['Submitted', `${full(s.created_at)} (${ago(s.created_at)})`],
    ['Updated', s.updated_at ? `${full(s.updated_at)} (${ago(s.updated_at)})` : ''],
    ['Ingest status', h('code', null, s.status)],
    ['Review', h('code', null, s.review)],
    ['Object id', h('code', null, s.object_id)],
    ['Slug', h('code', null, s.slug)],
    ...(r ? ([
      ['Resolution', r.resolution ?? ''],
      ['Aff', r.aff ?? ''],
      ['Neg', r.neg ?? ''],
      ['Decision', r.decision ?? ''],
      ['Format', [r.format, r.level].filter(Boolean).join(', ')],
      ['Tags', (r._tags ?? []).join(', ')],
    ] as Array<[string, string]>) : [['Search record', h('span.adm-bad', null, 'Not in search, or search could not be reached')] as [string, HTMLElement]]),
    ...(s.note && !s.progress.failure ? [['Note', s.note] as [string, string]] : []),
  ]);
}

function eventsTable(events: api.IngestEvent[]): HTMLElement {
  return table<api.IngestEvent>({
    rows: events,
    columns: [
      { key: 'at', label: 'When', cell: e => when(e.created_at), class: 'adm-nowrap' },
      { key: 'stage', label: 'Stage', cell: e => e.stage },
      { key: 'state', label: 'State', cell: e => mark(capital(e.state), STATE_TONE[e.state] ?? 'wait') },
      { key: 'note', label: 'Note', cell: e => e.note ? h('pre.adm-pre.adm-pre-inline', null, e.note) : '' },
    ],
    empty: 'The ingest has reported nothing for this round yet.',
  });
}

/**
 * Corrects what search says about a round. The fields come from the search
 * record rather than the queue, which only keeps a handful of columns. The
 * slug cannot be edited (it is the round's address and the name its audio is
 * filed under) and neither can the link, which has its own action because a
 * different link is a different recording.
 */
const EDIT_FIELDS: Array<{ name: string; label: string; wide?: boolean; options?: Array<[string, string]> }> = [
  { name: 'title', label: 'Round title', wide: true },
  { name: 'resolution', label: 'Resolution', wide: true },
  { name: 'aff', label: 'Aff', wide: true },
  { name: 'neg', label: 'Neg', wide: true },
  { name: 'tags', label: 'Tags', wide: true },
  { name: 'decision', label: 'Decision' },
  { name: 'year', label: 'Year' },
  { name: 'tournament', label: 'Tournament' },
  { name: 'format', label: 'Format', options: [['parli', 'parli'], ['policy', 'policy']] },
  { name: 'level', label: 'Level', options: [['college', 'college'], ['hs', 'high school']] },
];

function editor(s: api.AdminSubmission, done: () => void): HTMLElement {
  const r = s.record!;
  const form = h('form.adm-edit');
  const grid = h('div.adm-edit-grid');
  for (const f of EDIT_FIELDS) {
    const input = f.options
      ? h('select.adm-field', { name: f.name }, f.options.map(([v, t]) => h('option', { value: v, selected: (r as any)[f.name] === v }, t)))
      : h('input.adm-field', { name: f.name, type: 'text', value: f.name === 'tags' ? (r._tags ?? []).join(', ') : String((r as any)[f.name] ?? '') });
    // The two descriptions are filed in lower case, so the field shows what
    // will be filed rather than leaving the server to correct it quietly.
    if (f.name === 'aff' || f.name === 'neg') {
      input.addEventListener('blur', () => { (input as HTMLInputElement).value = (input as HTMLInputElement).value.trim().toLowerCase(); });
    }
    grid.append(h(`label.adm-edit-field${f.wide ? '.wide' : ''}` as 'label', null,
      h('span', null, f.label), input, h('span.adm-hint', { 'data-hint': f.name })));
  }
  const result = h('p.adm-status', { role: 'status' });
  const save = h('button.adm-button.primary', { type: 'submit' }, 'Save');
  form.append(grid, h('div.adm-actions', null, save, button('Cancel', () => form.remove()), result));
  form.addEventListener('submit', async e => {
    e.preventDefault();
    form.querySelectorAll<HTMLElement>('[data-hint]').forEach(x => { x.textContent = ''; });
    const v = (n: string) => (form.querySelector(`[name="${n}"]`) as HTMLInputElement).value.trim();
    save.disabled = true;
    status(result, 'Saving.');
    try {
      const saved = await api.editSubmission(s.object_id, {
        title: v('title'), resolution: v('resolution'), aff: v('aff'), neg: v('neg'), decision: v('decision'),
        year: v('year'), tournament: v('tournament'), format: v('format'), level: v('level'),
        tags: v('tags').split(',').map(t => t.trim()).filter(Boolean),
      });
      // Search has it already; the page follows a rebuild, so say which.
      status(result, `Saved ${saved.changed.length ? saved.changed.join(', ') : 'with no changes'}. ${saved.rebuilding ? 'The page is rebuilding.' : 'The page follows on the next deploy.'}`);
      store.forget('submissions', 'rounds');
      setTimeout(done, 1600);
    } catch (err) {
      save.disabled = false;
      if (err instanceof api.FieldErrors) {
        for (const [name, message] of Object.entries(err.fields)) {
          const hint = form.querySelector<HTMLElement>(`[data-hint="${name}"]`);
          if (hint) hint.textContent = message;
        }
        status(result, 'Not saved.', true);
      } else {
        status(result, describeError(err).text, true);
      }
    }
  });
  return form;
}

async function drawDetail(body: HTMLElement, tools: HTMLElement, id: string) {
  const reload = () => { clear(body); void drawDetail(body, tools, id); };
  clear(tools,
    h('a.adm-link', { href: '#submissions' }, 'All submissions'),
    button('Refresh', reload));
  clear(body, loading());

  let s: api.AdminSubmission;
  try {
    ({ submission: s } = await api.getSubmission(id));
  } catch (e) {
    clear(body, errorBlock(e, reload));
    return;
  }
  syncClock(s.progress.now);
  const p = s.progress;
  const removed = s.review === 'removed';
  const result = h('p.adm-status', { role: 'status' });
  const after = (msg: string) => { store.forget('submissions', 'rounds'); return msg; };
  // Whole, or from one stage; only the stages the round has got to.
  const restart = restartMenu(s, reload);

  const relink = button('Correct link', () => void confirm({
    title: 'Correct the link',
    body: [
      'The new link is checked the same way a submission is, then the round is queued again.',
      h('p.adm-bad', null, 'Any audio, waveform, transcript and speech labels already stored for this round are deleted, because they belong to the old recording.'),
      h('p.adm-quiet', null, 'Current: ', h('code', null, s.link)),
    ],
    field: { label: 'New link', placeholder: 'https://www.dropbox.com/…', required: true, type: 'url' },
    action: 'Check and queue',
    run: async link => {
      const r = await api.relinkSubmission(s.object_id, link);
      return after([
        'Queued with the new link.',
        r.probe ? `The link answered: ${r.probe}.` : '',
        r.removed.length ? `Deleted ${r.removed.join(', ')}.` : 'No stored files to delete.',
        r.rebuilding ? 'The site is rebuilding.' : '',
      ].filter(Boolean).join(' '));
    },
  }).then(changed => { if (changed) reload(); }));

  const remove = button('Remove', () => void confirm({
    title: 'Remove this round?',
    body: [
      `"${s.title}" is taken out of search and the media index, and its audio, waveform, transcript and speech labels are deleted. This cannot be undone; the round would have to be submitted again.`,
    ],
    field: { label: 'Reason (optional, kept as the note)' },
    action: 'Remove',
    danger: true,
    run: async note => {
      const r = await api.removeSubmission(s.object_id, note || undefined);
      return after(`Removed. ${r.removed.length ? `Deleted ${r.removed.join(', ')}.` : 'There were no stored files.'} ${r.rebuilding ? 'The site is rebuilding.' : ''}`);
    },
  }).then(changed => { if (changed) reload(); }), 'danger');

  const confirmBtn = button(s.review === 'confirmed' ? 'Confirmed' : 'Confirm', async () => {
    confirmBtn.disabled = true;
    try {
      await api.confirmSubmission(s.object_id);
      status(result, after('Confirmed.'));
      confirmBtn.textContent = 'Confirmed';
    } catch (e) {
      confirmBtn.disabled = false;
      status(result, describeError(e).text, true);
    }
  });
  confirmBtn.disabled = s.review !== 'unreviewed';
  confirmBtn.title = 'Marks the submission as looked at';

  const editBox = h('div');
  const edit = button('Edit details', () => {
    if (editBox.firstChild) { clear(editBox); return; }
    if (!s.record) { status(result, 'Search has no record for this round, so there is nothing to edit.', true); return; }
    clear(editBox, batch('Edit details', 'Search record', editor(s, reload)));
    editBox.scrollIntoView({ block: 'start', behavior: 'smooth' });
  });

  for (const b of [relink, remove]) b.disabled = removed;
  edit.disabled = removed || !s.record;

  const marks = h('span.adm-inline', null,
    statusMark(removed ? 'removed' : p.status),
    s.review === 'confirmed' ? mark('Confirmed', 'none') : s.review === 'unreviewed' ? mark('Not confirmed', 'none') : null);

  clear(body,
    h('div.adm-detail-head', null,
      h('h2', null, s.title),
      marks,
      h('p.adm-quiet', null,
        [s.tournament, s.year].filter(Boolean).join(', '),
        `. Submitted ${ago(s.created_at)} by `,
        s.author_id ? link(`#users/${s.author_id}`, s.author ?? 'unknown') : 'an account that is gone', '.'),
      h('div.adm-actions', null, restart, relink, remove, confirmBtn, edit,
        link(p.page.url, 'Open page', true), result),
    ),
    editBox,
    diagnosis(s, reload),
    batch('Progress', p.status === 'published' ? 'All five stages done' : STATUS_LINE[p.status] ?? '', stagesTable(p)),
    batch('Storage and page', 'Checked when opened', mediaPairs(p)),
    batch('Record', 'Database and search', recordPairs(s)),
    batch('Ingest events', `${num(s.events.length)} for this round`, eventsTable(s.events)),
  );
}

const STATUS_LINE: Record<string, string> = {
  fetching: 'Audio not in yet',
  transcribing: 'Audio in, no transcript yet',
  labelling: 'Transcript in, speeches not marked',
  publishing: 'Everything in, page not live yet',
  failed: 'Stopped',
  removed: 'Removed',
};

const FILTER_ARGS = new Set(['failed', 'pending', 'ingested', 'removed', 'all']);

export const submissions: View = {
  show(body, tools, arg) {
    if (arg && arg !== 'ingest' && !FILTER_ARGS.has(arg)) {
      void drawDetail(body, tools, arg);
      body.dataset.mode = `detail:${arg}`;
      return;
    }
    if (arg && FILTER_ARGS.has(arg)) filter = arg as Filter;
    if (body.dataset.mode !== 'list' || arg) {
      body.dataset.mode = 'list';
      void drawList(body, tools);
    } else if (!body.childElementCount) {
      void drawList(body, tools);
    }
  },
};
