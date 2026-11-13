/**
 * Markup for the prep page: result rows, the file index, and the block as it
 * reads in the doc. Strings rather than components because every keypress
 * redraws the list and this is the cheapest way to do it.
 */
import type { PrepHit } from './search';
import { SIDE_LABELS, TYPE_LABELS, type PrepRecord, type PrepSide, type PrepType } from './types';

/**
 * Where the reader is on the page, as the URL holds it, so every step is a
 * history entry that can be reloaded or shared:
 * `?q=econ&side=aff&types=uq,link&file=<slug>&block=<objectID>`.
 */
export interface PrepView {
  q: string;
  side: PrepSide | null;
  types: PrepType[];
  file: string | null;
  block: string | null;
}

export const MOD = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? '') ? '⌘' : 'Ctrl';

export const NO_VIEW: PrepView = { q: '', side: null, types: [], file: null, block: null };

const TYPE_ORDER: PrepType[] = ['uq', 'link', 'il', 'impact', 'answer', 'other'];

export function readView(search: string): PrepView {
  const p = new URLSearchParams(search);
  const side = p.get('side');
  const types = (p.get('types') ?? '').split(',').filter((t): t is PrepType => (TYPE_ORDER as string[]).includes(t));
  return {
    q: (p.get('q') ?? '').trim(),
    side: side === 'aff' || side === 'neg' ? side : side === 'both' ? 'either' : null,
    types: TYPE_ORDER.filter(t => types.includes(t)),
    file: p.get('file') || null,
    // `b` is the link Copy link made before blocks had their own URL.
    block: p.get('block') || p.get('b') || null,
  };
}

/** The query string for a view, empty for the bare page. */
export function viewQuery(v: PrepView): string {
  const p = new URLSearchParams();
  if (v.q) p.set('q', v.q);
  if (v.side) p.set('side', v.side === 'either' ? 'both' : v.side);
  if (v.types.length) p.set('types', v.types.join(','));
  if (v.file) p.set('file', v.file);
  if (v.block) p.set('block', v.block);
  const qs = p.toString().replace(/%2C/g, ',');
  return qs ? `?${qs}` : '';
}

export function viewHref(v: PrepView): string {
  return `/prep/${viewQuery(v)}`;
}

/** True when a block shows under the side filter: one side includes the blocks either side reads. */
export function sideMatches(side: PrepSide, filter: PrepSide | null): boolean {
  return !filter || side === filter || (filter !== 'either' && side === 'either');
}

export function escapeHtml(s: string): string {
  return (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Algolia's highlight value is the attribute escaped with <mark> around the
 * matched words (the index sets highlightPreTag to <mark>). Only those tags
 * are let through.
 */
function highlighted(hit: PrepHit, attr: 'title' | 'use' | 'file'): string {
  const value = hit._highlightResult?.[attr]?.value;
  if (!value) return escapeHtml(hit[attr]);
  return escapeHtml(value.replace(/<mark>/g, '\u0001').replace(/<\/mark>/g, '\u0002'))
    .replace(/&amp;(amp|lt|gt|quot|#39);/g, '&$1;')
    .replace(/\u0001/g, '<mark>')
    .replace(/\u0002/g, '</mark>');
}

export function sideMark(side: PrepRecord['side']): string {
  return `<span class="prep-side prep-side--${side}" title="${side === 'either' ? 'either side' : side}">${SIDE_LABELS[side]}</span>`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Nov 13" from "2026-11-13", for the quiet freshness note. */
export function shortDate(iso: string | null): string {
  if (!iso) return '';
  const [, m, d] = iso.split('-');
  const month = MONTHS[Number(m) - 1];
  return month ? `${month} ${Number(d)}` : '';
}

/** A link the page follows itself; a modified click still opens a new tab. */
function navLink(cls: string, v: PrepView, label: string, attrs = ''): string {
  return `<a class="${cls}" href="${escapeHtml(viewHref(v))}" data-nav${attrs ? ` ${attrs}` : ''}>${label}</a>`;
}

export function rowHtml(hit: PrepHit, index: number, selected: boolean, showFile = true): string {
  return `<li class="prep-row" role="option" id="prep-opt-${index}" data-index="${index}" aria-selected="${selected}">
    ${sideMark(hit.side)}
    <span class="prep-row-title">${highlighted(hit, 'title')}</span>
    ${showFile ? `<span class="prep-row-file">${highlighted(hit, 'file')}</span>` : ''}
    <span class="prep-row-use"><span class="prep-row-type">${TYPE_LABELS[hit.type]}</span>${highlighted(hit, 'use')}</span>
  </li>`;
}

/** A section label inside a file's list: UQ, Links, and so on. Not selectable. */
export function familyHead(family: string): string {
  return `<li class="prep-family" role="presentation">${escapeHtml(family)}</li>`;
}

export interface FileSummary {
  slug: string;
  title: string;
  docUrl: string | null;
  freshness: string | null;
  blocks: PrepRecord[];
}

export function summarise(records: PrepRecord[]): FileSummary[] {
  const files = new Map<string, FileSummary>();
  for (const r of records) {
    let f = files.get(r.file_slug);
    if (!f) {
      f = { slug: r.file_slug, title: r.file, docUrl: r.doc_url, freshness: r.freshness, blocks: [] };
      files.set(r.file_slug, f);
    }
    f.blocks.push(r);
  }
  for (const f of files.values()) f.blocks.sort((a, b) => a.position - b.position);
  return [...files.values()].sort((a, b) => a.title.localeCompare(b.title));
}

/** A file in the index. Each count opens the file with that type picked. */
export function fileRowHtml(f: FileSummary, index: number, selected: boolean, v: PrepView): string {
  const counts = TYPE_ORDER
    .map(t => [t, f.blocks.filter(b => b.type === t).length] as const)
    .filter(([, n]) => n > 0)
    .map(([t, n]) => navLink('prep-count-part', { ...v, q: '', file: f.slug, types: [t], block: null }, `${n} ${TYPE_LABELS[t]}`,
      `title="${escapeHtml(`${f.title}, ${TYPE_LABELS[t]} blocks`)}"`))
    .join('');
  return `<li class="prep-row prep-row--file" role="option" id="prep-opt-${index}" data-index="${index}" aria-selected="${selected}">
    <span class="prep-row-title">${escapeHtml(f.title)}</span>
    <span class="prep-row-file">${f.freshness ? `checked ${shortDate(f.freshness)}` : ''}</span>
    <span class="prep-row-counts">${counts}</span>
  </li>`;
}

/**
 * A file title for the serif heading. PP Editorial New draws its em dash as a
 * bare 1.2em rule with no side bearings, which next to its narrow word spaces
 * reads as a doubled dash at heading size. The heading shows an en dash
 * instead; the title itself is unchanged.
 */
function headingTitle(title: string): string {
  return escapeHtml(title).replace(/ \u2014 /g, ' <span class="prep-dash">\u2013</span> ');
}

/**
 * The right-hand pane for a file: its blocks as a table of contents. `open`
 * is false while the file is only previewed from the index, so the links
 * there open it. Every part is a link: a row opens its block, a family
 * heading picks that type, a side tag picks that side, and clicking a picked
 * one again clears it.
 */
export function tocHtml(f: FileSummary, v: PrepView, open: boolean): string {
  const at: PrepView = { ...v, q: '', file: f.slug, block: null };
  const shown = f.blocks.filter(b => sideMatches(b.side, v.side) && (!v.types.length || v.types.includes(b.type)));
  const groups = new Map<string, PrepRecord[]>();
  for (const b of shown) groups.set(b.family, [...(groups.get(b.family) ?? []), b]);
  const narrowed = shown.length !== f.blocks.length;
  return `<div class="prep-view-head">
      <p class="prep-crumbs">
        ${narrowed ? `<span>${shown.length} shown</span>` : ''}
        ${navLink('prep-crumb-link', { ...at, side: null, types: [] }, `${narrowed ? 'all ' : ''}${f.blocks.length} blocks`)}
        ${f.freshness ? `<span>checked ${shortDate(f.freshness)}</span>` : ''}
      </p>
      <div class="prep-actions">
        <button class="prep-act" type="button" data-act="${open ? 'first-block' : 'open-file'}">Show blocks <kbd>↵</kbd></button>
        ${f.docUrl ? `<a class="prep-act" href="${escapeHtml(f.docUrl)}" target="_blank" rel="noopener">Open doc <kbd>${MOD}↵</kbd></a>` : ''}
      </div>
    </div>
    <article class="prep-doc prep-doc--toc">
      <h2 class="prep-toc-title">${headingTitle(f.title)}</h2>
      ${shown.length ? '' : '<p class="prep-toc-none">No blocks here with these filters.</p>'}
      ${[...groups].map(([family, blocks]) => {
        const type = blocks[0].type;
        const on = v.types.length === 1 && v.types[0] === type;
        return `
        <h3 class="prep-toc-family">${navLink('prep-toc-family-link', { ...at, types: on ? [] : [type] }, escapeHtml(family),
          `data-on="${on}" title="${on ? 'Show every type' : `Only ${escapeHtml(TYPE_LABELS[type])} blocks`}"`)}</h3>
        <ol class="prep-toc-list">
          ${blocks.map(b => `<li>${sideLink(b.side, at)}${navLink('prep-toc-link', { ...at, block: b.objectID }, escapeHtml(b.title))}</li>`).join('')}
        </ol>`;
      }).join('')}
    </article>`;
}

function sideLink(side: PrepSide, at: PrepView): string {
  const on = at.side === side;
  const label = side === 'either' ? 'blocks either side reads' : `${side} blocks`;
  return navLink(`prep-side prep-side--${side}`, { ...at, side: on ? null : side }, SIDE_LABELS[side],
    `data-on="${on}" title="${on ? 'Show both sides' : `Only ${label}`}"`);
}

const ALLOWED = new Set(['OL', 'UL', 'LI', 'P', 'A', 'B', 'I', 'STRONG', 'EM', 'BR']);

/**
 * The block HTML comes from our own indexer, which escapes the markdown, but
 * it is still put into the page as markup, so anything beyond lists, links and
 * emphasis is dropped on the way in. Links open in a new tab, since leaving
 * the page in the middle of prep loses the search.
 */
export function safeHtml(html: string): string {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const walk = (node: Element | DocumentFragment) => {
    for (const el of Array.from(node.children)) {
      if (!ALLOWED.has(el.tagName)) {
        el.replaceWith(document.createTextNode(el.textContent ?? ''));
        continue;
      }
      for (const attr of Array.from(el.attributes)) {
        if (!(el.tagName === 'A' && attr.name === 'href')) el.removeAttribute(attr.name);
      }
      if (el.tagName === 'A') {
        if (!/^(https?:|mailto:)/i.test(el.getAttribute('href') ?? '')) el.removeAttribute('href');
        el.setAttribute('target', '_blank');
        el.setAttribute('rel', 'noopener');
      }
      walk(el);
    }
  };
  walk(tpl.content);
  const box = document.createElement('div');
  box.appendChild(tpl.content);
  return box.innerHTML;
}

/**
 * Marks the query's words in a block's body. Search highlights only the fields
 * it searches, and the body is not one, so this is done here: a word is marked
 * when it starts with a query word, or equals it when the query word is short.
 * It works on text nodes only, so links and lists are left as they are, and
 * copying is unaffected because a copy is built from the record.
 */
export function markTerms(html: string, q: string): string {
  const terms = [...new Set(q.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(t => t.length >= 2))];
  if (!terms.length) return html;
  const escape = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = terms.map(t => (t.length < 4 ? `${escape(t)}(?![\\p{L}\\p{N}])` : `${escape(t)}[\\p{L}\\p{N}]*`));
  const re = new RegExp(`(?<![\\p{L}\\p{N}])(?:${parts.join('|')})`, 'giu');
  const box = document.createElement('div');
  box.innerHTML = html;
  const walker = document.createTreeWalker(box, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode as Text);
  for (const node of nodes) {
    const text = node.data;
    const frag = document.createDocumentFragment();
    let last = 0;
    for (const m of text.matchAll(re)) {
      frag.append(text.slice(last, m.index));
      const mark = document.createElement('mark');
      mark.textContent = m[0];
      frag.append(mark);
      last = (m.index ?? 0) + m[0].length;
    }
    if (last) {
      frag.append(text.slice(last));
      node.replaceWith(frag);
    }
  }
  return box.innerHTML;
}

/** The block as it reads in the doc, under the controls for taking it. */
export function viewHtml(rec: PrepHit, v: PrepView): string {
  const file: PrepView = { ...v, q: '', file: rec.file_slug, block: null };
  return `<div class="prep-view-head">
      <p class="prep-crumbs">
        <span class="prep-path">${navLink('prep-crumb-link', file, escapeHtml(rec.file), 'data-up')}<span class="prep-sep">/</span>${navLink('prep-crumb-link', { ...file, types: [rec.type] }, escapeHtml(rec.family))}<span class="prep-sep">/</span>${rec.position} of ${rec.file_blocks}</span>
        ${rec.freshness ? `<span>checked ${shortDate(rec.freshness)}</span>` : ''}
      </p>
      <div class="prep-actions">
        <button class="prep-act prep-act--copy" type="button" data-act="copy">Copy block <kbd>↵</kbd></button>
        <button class="prep-act" type="button" data-act="link">Copy link <kbd>⇧↵</kbd></button>
        ${rec.doc_url ? `<a class="prep-act" data-act="doc" href="${escapeHtml(rec.doc_url)}" target="_blank" rel="noopener">Open doc <kbd>${MOD}↵</kbd></a>` : ''}
      </div>
    </div>
    <article class="prep-doc" id="prep-doc">
      <h3 class="prep-doc-title">${sideMark(rec.side)}<span>${highlighted(rec, 'title')}</span></h3>
      ${rec.use ? `<p class="prep-doc-use">${highlighted(rec, 'use')}</p>` : ''}
      <div class="prep-doc-body">${markTerms(safeHtml(rec.html), v.q)}</div>
    </article>`;
}

