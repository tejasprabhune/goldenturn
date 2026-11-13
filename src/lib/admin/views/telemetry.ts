/**
 * Telemetry: the activity chart, the four ranked views the old page drew as
 * bar charts, what people are searching for right now, and the live tail.
 *
 * Each ranked view keeps its top-ten chart and sets the full list the API
 * returns (up to 25) beside it as a table, so a long label is readable and a
 * round can be opened. The tail now shows the date as well as the time, who
 * did it with a link to their account, and can be narrowed by kind and paged
 * back.
 */

import { areaChart, barChart } from '../../chart';
import * as api from '../api';
import * as store from '../store';
import {
  h, clear, batch, group, num, slugWords, roundHref, errorBlock, loading, rangeControl,
  button, table, when, link,
} from '../ui';
import { dailySeries } from './overview';
import type { View } from '../view';

type Row = { label: string; value: number; href?: string };

const charts: Array<() => void> = [];
function redraw() { for (const c of charts) c(); }
window.addEventListener('resize', redraw);

/** What an event was about, from its payload, in a few words. */
export function describe(e: api.AdminEvent): string {
  let extra = '';
  try {
    const p = JSON.parse(e.payload || '{}');
    if (p.q) extra = `"${p.q}"`;
    else if (p.label) extra = p.label;
    else if (p.tag) extra = p.tag;
    else if (p.stars) extra = `${p.stars} stars`;
    else if (p.reason) extra = String(p.reason).replace(/_/g, ' ');
    else if (p.by) extra = `by ${p.by}`;
  } catch { /* payload is best effort */ }
  return extra;
}

function ranked(name: string, rows: Row[], accent: 'gold' | 'sky', unit: string): HTMLElement {
  if (!rows.length) return group(name, h('p.adm-empty', null, 'None in this range.'));
  const canvas = h('canvas.admin-canvas', { 'aria-label': `${name}, top ${Math.min(10, rows.length)}` });
  const draw = () => { if (canvas.isConnected) barChart(canvas, rows.slice(0, 10), accent); };
  charts.push(draw);
  requestAnimationFrame(draw);
  const total = rows.reduce((a, r) => a + r.value, 0);
  return h('div.adm-pair', null,
    group(`Top ${Math.min(10, rows.length)}`, h('div.chart-wrap', null, canvas)),
    group(`All ${rows.length} returned, by count`, table<Row & { i: number }>({
      rows: rows.map((r, i) => ({ ...r, i: i + 1 })),
      columns: [
        { key: 'i', label: '#', num: true, cell: r => num(r.i), class: 'adm-rank' },
        { key: 'label', label: name, cell: r => r.href ? link(r.href, r.label) : r.label,
          sort: r => r.label },
        { key: 'value', label: unit, num: true, sort: r => r.value, cell: r => num(r.value) },
        { key: 'share', label: 'Share', num: true, wide: true, cell: r => `${Math.round(r.value / total * 100)}%` },
      ],
      page: 10,
    })),
  );
}

/* The live tail. */

let lastId = 0;
let oldestId = 0;
let live = true;
let timer: ReturnType<typeof setInterval> | undefined;
let kindFilter = '';
let tailBody: HTMLTableSectionElement | null = null;
let tailMore: HTMLButtonElement | null = null;

function eventRow(e: api.AdminEvent, fresh: boolean): HTMLTableRowElement {
  const extra = describe(e);
  return h('tr', fresh ? { class: 'is-new' } : null,
    h('td.adm-nowrap', null, when(e.created_at)),
    h('td.adm-nowrap', null, e.user_id ? link(`#users/${e.user_id}`, e.who) : h('span.adm-quiet', null, e.who)),
    h('td.adm-nowrap', null, e.kind),
    h('td', null, extra),
    h('td', null, e.slug ? link(roundHref(e.slug), slugWords(e.slug)) : ''),
  );
}

async function poll() {
  if (!tailBody) return;
  try {
    const { events } = await api.events({ since: lastId, limit: 60, kind: kindFilter || undefined });
    const first = lastId === 0;
    // Newest first from the server; prepend oldest first so the newest ends on top.
    for (const e of [...events].reverse()) {
      if (e.id <= lastId) continue;
      lastId = e.id;
      if (!oldestId || e.id < oldestId) oldestId = e.id;
      const tr = eventRow(e, !first);
      tailBody.prepend(tr);
      if (!first) setTimeout(() => tr.classList.remove('is-new'), 2000);
    }
    if (first && tailMore) tailMore.hidden = events.length < 60;
    while (tailBody.children.length > 500) tailBody.lastElementChild?.remove();
  } catch { /* the next tick tries again */ }
}

async function older() {
  if (!tailBody || !tailMore) return;
  tailMore.disabled = true;
  try {
    const { events } = await api.events({ before: oldestId, limit: 100, kind: kindFilter || undefined });
    for (const e of events) {
      tailBody.append(eventRow(e, false));
      oldestId = Math.min(oldestId, e.id);
    }
    tailMore.hidden = events.length < 100;
  } finally {
    tailMore.disabled = false;
  }
}

function startTail() {
  clearInterval(timer);
  if (live) timer = setInterval(poll, 5000);
}

function tail(kinds: string[]): HTMLElement {
  lastId = 0;
  oldestId = 0;
  tailBody = h('tbody');
  tailMore = h('button.adm-more', { type: 'button', onclick: () => void older() }, 'Older events');
  const select = h('select.adm-field.adm-select', { 'aria-label': 'Kind of event' },
    h('option', { value: '' }, 'Every kind'),
    kinds.map(k => h('option', { value: k, selected: k === kindFilter }, k)));
  select.addEventListener('change', () => {
    kindFilter = select.value;
    lastId = 0;
    oldestId = 0;
    tailBody!.replaceChildren();
    void poll();
  });
  const toggle = h('button.adm-button', { type: 'button', 'aria-pressed': String(live) }, live ? 'Live' : 'Paused');
  toggle.addEventListener('click', () => {
    live = !live;
    toggle.setAttribute('aria-pressed', String(live));
    toggle.textContent = live ? 'Live' : 'Paused';
    startTail();
    if (live) void poll();
  });
  void poll();
  startTail();
  return h('div.adm-group', null,
    h('div.adm-actions', null, select, toggle),
    h('div.adm-table-wrap.adm-tail', null, h('table.adm-table', null,
      h('thead', null, h('tr', null, ['When', 'Who', 'Kind', 'Detail', 'Round'].map(t => h('th', null, t)))),
      tailBody)),
    tailMore,
  );
}

/* Recent searches: what people typed, newest first. */

async function recentSearches(into: HTMLElement) {
  try {
    const [a, b] = await Promise.all([
      api.events({ kind: 'search', limit: 40 }),
      api.events({ kind: 'transcript.search', limit: 20 }),
    ]);
    const rows = [...a.events, ...b.events].sort((x, y) => y.created_at - x.created_at).slice(0, 40);
    clear(into, table({
      rows,
      columns: [
        { key: 'at', label: 'When', cell: e => when(e.created_at), class: 'adm-nowrap' },
        { key: 'q', label: 'Query', cell: e => describe(e).replace(/^"|"$/g, '') },
        { key: 'where', label: 'Where', wide: true, cell: e => e.kind === 'search' ? 'list' : e.slug ? link(roundHref(e.slug), 'transcript') : 'transcript' },
        { key: 'who', label: 'Who', cell: e => e.user_id ? link(`#users/${e.user_id}`, e.who) : h('span.adm-quiet', null, e.who) },
      ],
      empty: 'No searches yet.',
    }));
  } catch (e) {
    clear(into, errorBlock(e));
  }
}

async function render(body: HTMLElement) {
  charts.length = 0;
  clearInterval(timer);
  clear(body, loading());
  let s: api.Stats;
  try {
    s = await store.stats();
  } catch (e) {
    clear(body, errorBlock(e, () => { store.forget('stats'); void render(body); }));
    return;
  }

  const area = h('canvas.admin-canvas.adm-canvas-tall', { 'aria-label': `Events per day over the last ${s.days} days` });
  const series = dailySeries(s.daily, s.days);
  const drawArea = () => { if (area.isConnected) areaChart(area, series, [`${s.days} days ago`, 'today']); };
  charts.push(drawArea);

  const recent = h('div', null, loading());
  const range = `Last ${s.days} days`;

  clear(body,
    batch('Activity', `${num(s.daily.reduce((a, d) => a + d.n, 0))} events, ${range.toLowerCase()}`,
      h('div.chart-wrap.adm-chart', null, area)),
    batch('Searches', range,
      ranked('Search term', s.searches.map(x => ({ label: x.term, value: x.n })), 'gold', 'Searches'),
      group('Recent queries', recent)),
    batch('Most opened rounds', range,
      ranked('Round', s.rounds.map(x => ({ label: slugWords(x.slug), value: x.n, href: roundHref(x.slug) })), 'sky', 'Opens')),
    batch('Tags in use', 'All time',
      ranked('Tag', s.tags.map(x => ({ label: x.tag, value: x.n })), 'sky', 'Uses')),
    batch('Events by kind', range,
      ranked('Kind', s.kinds.map(x => ({ label: x.kind, value: x.n })), 'gold', 'Events')),
    batch('Live events', 'Every 5 seconds while open', tail(s.kinds.map(k => k.kind).sort())),
  );
  requestAnimationFrame(redraw);
  void recentSearches(recent);
}

let rendered = 0;

export const telemetry: View = {
  show(body, tools) {
    clear(tools,
      rangeControl(store.days, d => { store.setDays(d); void render(body); }),
      button('Refresh', () => { store.forget('stats'); void render(body); }),
    );
    if (rendered !== store.days || !body.childElementCount) {
      rendered = store.days;
      void render(body);
    } else {
      startTail();
      requestAnimationFrame(redraw);
    }
  },
  hide() {
    clearInterval(timer);
  },
};

