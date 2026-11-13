/**
 * Copying a block so it pastes into a Google Doc as the file reads: Heading 3
 * title, numbered and nested lists, links, Calibri 12pt.
 *
 * Docs takes formatting from inline styles on pasted HTML and ignores
 * stylesheets, so every element carries its own, the way
 * prep-gen/scripts/build_html.py writes them. The plain-text copy keeps the
 * numbering as text for anything that only takes text.
 */
import type { PrepRecord } from './types';

const FONT = 'font-family:Calibri,sans-serif;color:#000000;';
const STYLE: Record<string, string> = {
  h3: FONT + 'font-size:13pt;font-weight:700;line-height:1.15;margin:0;',
  p: FONT + 'font-size:12pt;line-height:1.15;margin:0;',
  li: FONT + 'font-size:12pt;line-height:1.15;',
  ol: 'list-style-type:decimal;margin-top:0;margin-bottom:0;',
  ul: 'list-style-type:disc;margin-top:0;margin-bottom:0;',
  a: 'color:#1155cc;text-decoration:underline;',
  b: 'font-weight:700;',
  i: 'font-style:italic;',
};

function parse(html: string): HTMLElement {
  const tpl = document.createElement('template');
  tpl.innerHTML = html;
  const box = document.createElement('div');
  box.appendChild(tpl.content);
  return box;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** The block as styled HTML for the clipboard: its title, then its argument. */
export function blockHtml(rec: Pick<PrepRecord, 'title' | 'html'>): string {
  const body = parse(rec.html);
  body.querySelectorAll<HTMLElement>('*').forEach(el => {
    const style = STYLE[el.tagName.toLowerCase()];
    if (style) el.setAttribute('style', style);
  });
  return (
    '<meta charset="utf-8">' +
    `<h3 style="${STYLE.h3}">${escapeHtml(rec.title)}</h3>` +
    body.innerHTML
  );
}

/** The block as text: "1." numbering and four spaces per level, as the source has it. */
export function blockText(rec: Pick<PrepRecord, 'title' | 'html'>): string {
  const lines: string[] = [rec.title];

  function walk(list: Element, depth: number) {
    let n = 0;
    for (const li of Array.from(list.children)) {
      if (li.tagName !== 'LI') continue;
      n += 1;
      const marker = list.tagName === 'OL' ? `${n}.` : '-';
      const own = Array.from(li.childNodes)
        .filter(c => !(c instanceof Element && (c.tagName === 'OL' || c.tagName === 'UL')))
        .map(c => c.textContent ?? '')
        .join('')
        .trim();
      lines.push(`${'    '.repeat(depth)}${marker} ${own}`);
      for (const sub of Array.from(li.children)) {
        if (sub.tagName === 'OL' || sub.tagName === 'UL') walk(sub, depth + 1);
      }
    }
  }

  for (const el of Array.from(parse(rec.html).children)) {
    if (el.tagName === 'OL' || el.tagName === 'UL') walk(el, 0);
    else lines.push((el.textContent ?? '').trim());
  }
  return lines.join('\n');
}

/**
 * Puts both forms on the clipboard. The async Clipboard API is tried first;
 * where it is missing or refuses (an older Safari, an insecure origin), a copy
 * event on a throwaway selection does the same job inside the key press.
 */
export async function copyRich(html: string, text: string): Promise<void> {
  if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          'text/html': new Blob([html], { type: 'text/html' }),
          'text/plain': new Blob([text], { type: 'text/plain' }),
        }),
      ]);
      return;
    } catch {
      // fall through to the copy event
    }
  }
  copyViaEvent({ 'text/html': html, 'text/plain': text });
}

export async function copyPlain(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // fall through
    }
  }
  copyViaEvent({ 'text/plain': text });
}

function copyViaEvent(data: Record<string, string>) {
  const onCopy = (e: ClipboardEvent) => {
    e.preventDefault();
    for (const [type, value] of Object.entries(data)) e.clipboardData?.setData(type, value);
  };
  const active = document.activeElement as HTMLElement | null;
  const scratch = document.createElement('textarea');
  scratch.value = data['text/plain'] ?? ' ';
  scratch.setAttribute('readonly', '');
  scratch.style.cssText = 'position:fixed;top:-100px;opacity:0;';
  document.body.appendChild(scratch);
  scratch.select();
  document.addEventListener('copy', onCopy, true);
  const ok = document.execCommand('copy');
  document.removeEventListener('copy', onCopy, true);
  scratch.remove();
  active?.focus();
  if (!ok) throw new Error('copy refused');
}
