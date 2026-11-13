/**
 * Rounds: every round the site knows, from search, from submissions and from
 * storage, with which of its parts exist.
 *
 * The list arrives whole (about 700 rows), so searching, filtering and
 * sorting happen here without another request. The address can carry a
 * filter (`#rounds/no-audio`), which is how the overview links to a gap.
 */

import type { AdminRound, RoundList } from '../api';
import * as store from '../store';
import {
  h, clear, figures, num, have, mark, errorBlock, loading, button, table, choices, stamp, date, full,
  when, link, roundHref, debounce, type Tone,
} from '../ui';
import type { View } from '../view';

type Filter = 'all' | 'no-audio' | 'no-transcript' | 'no-speeches' | 'no-page' | 'submitted' | 'orphans';

const FILTERS: Record<Filter, (r: AdminRound) => boolean> = {
  all: () => true,
  'no-audio': r => r.source !== 'media' && !r.has_audio,
  'no-transcript': r => r.source !== 'media' && !r.has_transcript,
  'no-speeches': r => r.source !== 'media' && !r.has_speeches,
  'no-page': r => r.source !== 'media' && r.has_page === false,
  submitted: r => r.submission !== null,
  orphans: r => r.source === 'media',
};

let filter: Filter = 'all';
let query = '';

const SUB: Record<string, [string, Tone]> = {
  pending: ['Waiting', 'busy'],
  ingested: ['Ingested', 'ok'],
  failed: ['Failed', 'bad'],
};

function source(r: AdminRound): HTMLElement | string {
  if (r.source === 'media') return mark('Orphan files', 'wait', 'Files in storage that belong to no round');
  if (!r.submission) return h('span.adm-quiet', null, 'Archive');
  const [word, tone] = r.submission.review === 'removed' ? ['Removed', 'none' as Tone] : SUB[r.submission.status] ?? [r.submission.status, 'wait' as Tone];
  return link(`#submissions/${r.submission.object_id}`, mark(word, tone));
}

/** When a file reached storage, on hover over its yes. */
function timed(el: HTMLElement, at: number | null): HTMLElement {
  if (at) el.title = `In storage since ${full(at)}`;
  return el;
}

function pageCell(r: AdminRound, deploy: number | null): HTMLElement {
  if (r.source === 'media') return h('span');
  const el = have(r.has_page);
  el.title = r.page_verified ? `Checked against the live site${r.page_at ? `; live with its player since ${full(r.page_at)}` : ''}`
    : r.has_page === null ? 'Cannot be told'
      : `Inferred: in search before the last deploy${deploy ? ` (${date(deploy)})` : ''}`;
  if (!r.page_verified && r.has_page !== null) el.classList.add('is-inferred');
  return el;
}

function draw(into: HTMLElement, data: RoundList) {
  const q = query.trim().toLowerCase();
  const rows = data.rounds.filter(FILTERS[filter]).filter(r => !q
    || (r.title ?? '').toLowerCase().includes(q) || r.slug.includes(q)
    || (r.tournament ?? '').toLowerCase().includes(q));
  const deploy = data.site.last_deploy_at;
  clear(into,
    h('p.adm-count', null, `${num(rows.length)} ${rows.length === 1 ? 'round' : 'rounds'}`),
    table<AdminRound>({
      rows,
      page: 100,
      // Newest first: what was added lately is what most often needs a look.
      sortKey: 'added',
      sortDir: 'desc',
      columns: [
        { key: 'title', label: 'Round', sort: r => r.title ?? r.slug,
          cell: r => r.title ? link(roundHref(r.slug), r.title) : h('code', null, r.slug) },
        { key: 'year', label: 'Season', sort: r => r.year, cell: r => r.year ?? '', class: 'adm-nowrap' },
        { key: 'tournament', label: 'Tournament', sort: r => r.tournament, cell: r => r.tournament ?? '', wide: true },
        { key: 'added', label: 'Added', num: true, sort: r => r.added_at ?? 0, class: 'adm-nowrap',
          cell: r => r.added_at ? when(r.added_at, date) : h('span.adm-quiet', null, 'unknown') },
        { key: 'format', label: 'Format', sort: r => r.format, cell: r => r.format ?? '', wide: true },
        { key: 'audio', label: 'Audio', sort: r => r.audio_at ?? Number(r.has_audio), cell: r => timed(have(r.has_audio), r.audio_at) },
        { key: 'transcript', label: 'Transcript', sort: r => r.transcript_at ?? Number(r.has_transcript), cell: r => timed(have(r.has_transcript), r.transcript_at) },
        { key: 'speeches', label: 'Speeches', sort: r => r.speeches_at ?? Number(r.has_speeches), cell: r => timed(have(r.has_speeches), r.speeches_at) },
        { key: 'page', label: 'Page', sort: r => r.has_page === null ? null : Number(r.has_page), cell: r => pageCell(r, deploy) },
        { key: 'source', label: 'Source', sort: r => r.source === 'media' ? 'z' : r.submission ? `s${r.submission.status}` : 'a', cell: source },
      ],
      empty: 'No rounds match.',
    }),
  );
}

async function render(body: HTMLElement) {
  clear(body, loading('Reading every round. This takes a few seconds.'));
  let data: RoundList;
  try {
    data = await store.rounds();
  } catch (e) {
    clear(body, errorBlock(e, () => { store.forget('rounds'); void render(body); }));
    return;
  }
  const c = data.counts;
  const listed = data.rounds.filter(r => r.source !== 'media').length;
  const of = (n: number) => h('span', null, num(n), h('span.adm-context', null, ` / ${num(listed)}`));

  const list = h('div.adm-group');
  const search = h('input.adm-field.adm-search', {
    type: 'search', placeholder: 'Search title, slug or tournament', 'aria-label': 'Search rounds', value: query,
  });
  search.addEventListener('input', debounce(() => { query = search.value; draw(list, data); }, 150));

  const n = (f: Filter) => data.rounds.filter(FILTERS[f]).length;
  const filters = choices<Filter>([
    ['all', 'All', data.rounds.length],
    ['no-audio', 'No audio', n('no-audio')],
    ['no-transcript', 'No transcript', n('no-transcript')],
    ['no-speeches', 'No speeches', n('no-speeches')],
    ['no-page', 'No page', n('no-page')],
    ['submitted', 'Submitted', n('submitted')],
    ['orphans', 'Orphans', n('orphans')],
  ], filter, f => { filter = f; draw(list, data); });

  clear(body,
    data.index_error ? h('p.adm-banner', { role: 'alert' }, `Search could not be read, so only submissions and storage are listed: ${data.index_error}`) : null,
    h('div.adm-panel', null,
      figures([
        ['Rounds', num(listed)],
        ['Audio', of(c.audio)],
        ['Transcript', of(c.transcript)],
        ['Speeches', of(c.speeches)],
        ['Page', of(c.page)],
        ['Orphans', num(c.orphans)],
      ]),
      h('p.adm-quiet.adm-note', null,
        `Read ${stamp(data.generated_at)}. Site last deployed ${data.site.last_deploy_at ? stamp(data.site.last_deploy_at) : 'at an unknown time'}. `,
        'A page is checked against the live site for submitted rounds; for the rest it is inferred from the last deploy (shown in grey).'),
    ),
    h('div.adm-panel', null,
      h('div.adm-toolbar', null, search, filters),
      list,
    ),
  );
  draw(list, data);
}

export const rounds: View = {
  show(body, tools, arg) {
    clear(tools, button('Refresh', () => { store.forget('rounds'); void render(body); }));
    const wanted = (arg && arg in FILTERS ? arg : null) as Filter | null;
    if (wanted && wanted !== filter) {
      filter = wanted;
      clear(body);
    }
    if (!body.childElementCount) void render(body);
  },
};
