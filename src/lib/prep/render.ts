/**
 * Markup for the prep page: result rows, the file index, and the block as it
 * reads in the doc. Strings rather than components because every keypress
 * redraws the list and this is the cheapest way to do it.
 */
import type { PrepHit } from './search';
import { SIDE_LABELS, TYPE_LABELS, type PrepRecord, type PrepType } from './types';

export function escapeHtml(s: string): string {
  return (s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Algolia's highlight value is the attribute escaped with <mark> around the
 * matched words. Only those tags are let through.
 */
function highlighted(hit: PrepHit, attr: 'title' | 'use'): string {
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

/** "11/13" from "2026-11-13", for the quiet freshness note. */
export function shortDate(iso: string | null): string {
  if (!iso) return '';
  const [, m, d] = iso.split('-');
  return `${Number(m)}/${Number(d)}`;
}

export function rowHtml(hit: PrepHit, index: number, selected: boolean, showFile = true): string {
  return `<li class="prep-row" role="option" id="prep-opt-${index}" data-index="${index}" aria-selected="${selected}">
    ${sideMark(hit.side)}
    <span class="prep-row-title">${highlighted(hit, 'title')}</span>
    ${showFile ? `<span class="prep-row-file">${escapeHtml(hit.file)}</span>` : ''}
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

const TYPE_ORDER: PrepType[] = ['uq', 'link', 'il', 'impact', 'answer', 'other'];

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

export function fileRowHtml(f: FileSummary, index: number, selected: boolean): string {
  const counts = TYPE_ORDER
    .map(t => [t, f.blocks.filter(b => b.type === t).length] as const)
    .filter(([, n]) => n > 0)
    .map(([t, n]) => `${n} ${TYPE_LABELS[t]}`)
    .join('<span class="prep-dot">·</span>');
  return `<li class="prep-row prep-row--file" role="option" id="prep-opt-${index}" data-index="${index}" aria-selected="${selected}">
    <span class="prep-count">${f.blocks.length}</span>
    <span class="prep-row-title">${escapeHtml(f.title)}</span>
    ${f.freshness ? `<span class="prep-row-file">checked ${shortDate(f.freshness)}</span>` : '<span class="prep-row-file"></span>'}
    <span class="prep-row-use">${counts}</span>
  </li>`;
}

/** The right-hand pane for a file in the index: its blocks as a table of contents. */
export function tocHtml(f: FileSummary): string {
  const groups = new Map<string, PrepRecord[]>();
  for (const b of f.blocks) groups.set(b.family, [...(groups.get(b.family) ?? []), b]);
  return `<div class="prep-view-head">
      <p class="prep-crumbs">${f.blocks.length} blocks${f.freshness ? ` <span class="prep-dot">·</span> checked ${shortDate(f.freshness)}` : ''}</p>
      <div class="prep-actions">
        <button class="prep-act" type="button" data-act="open-file">Show blocks <kbd>↵</kbd></button>
        ${f.docUrl ? `<a class="prep-act" href="${escapeHtml(f.docUrl)}" target="_blank" rel="noopener">Open doc <kbd>⌘↵</kbd></a>` : ''}
      </div>
    </div>
    <article class="prep-doc prep-doc--toc">
      <h2 class="prep-toc-title">${escapeHtml(f.title)}</h2>
      ${[...groups].map(([family, blocks]) => `
        <h3 class="prep-toc-family">${escapeHtml(family)}</h3>
        <ol class="prep-toc-list">
          ${blocks.map(b => `<li>${sideMark(b.side)}<span>${escapeHtml(b.title)}</span></li>`).join('')}
        </ol>`).join('')}
    </article>`;
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

const MOD = /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? '') ? '⌘' : 'Ctrl';

/** The block as it reads in the doc, under the controls for taking it. */
export function viewHtml(rec: PrepRecord): string {
  return `<div class="prep-view-head">
      <p class="prep-crumbs">
        ${rec.doc_url ? `<a href="${escapeHtml(rec.doc_url)}" target="_blank" rel="noopener">${escapeHtml(rec.file)}</a>` : escapeHtml(rec.file)}
        <span class="prep-dot">/</span>${escapeHtml(rec.family)}
        <span class="prep-dot">/</span>${rec.position} of ${rec.file_blocks}
        ${rec.freshness ? `<span class="prep-dot">·</span>checked ${shortDate(rec.freshness)}` : ''}
      </p>
      <div class="prep-actions">
        <button class="prep-act prep-act--copy" type="button" data-act="copy">Copy block <kbd>↵</kbd></button>
        <button class="prep-act" type="button" data-act="link">Copy link <kbd>⇧↵</kbd></button>
        ${rec.doc_url ? `<a class="prep-act" data-act="doc" href="${escapeHtml(rec.doc_url)}" target="_blank" rel="noopener">Open doc <kbd>${MOD}↵</kbd></a>` : ''}
      </div>
    </div>
    <article class="prep-doc" id="prep-doc">
      <h3 class="prep-doc-title">${sideMark(rec.side)}${escapeHtml(rec.title)}</h3>
      ${rec.use ? `<p class="prep-doc-use">${escapeHtml(rec.use)}</p>` : ''}
      <div class="prep-doc-body">${safeHtml(rec.html)}</div>
    </article>`;
}

export { MOD };
