/**
 * The two-line diff shown wherever a correction is reviewed.
 *
 * A correction shares nearly all its words with the original, so showing both
 * in full asks the reader to spot the difference themselves. This lays them out
 * the way a diff does: the removed line, the added line, each marked in the
 * gutter, with the run that actually changed picked out inside them and the
 * unchanged ends trimmed to a little context.
 */

import { diffWords, headContext, tailContext } from './textdiff';

function ellipsis(): HTMLElement {
  const e = document.createElement('span');
  e.className = 'diff-clip';
  e.textContent = '…';
  return e;
}

function line(kind: 'del' | 'ins', before: { text: string; clipped: boolean },
              changed: string, after: { text: string; clipped: boolean }): HTMLElement {
  const row = document.createElement('div');
  row.className = `diff-line diff-line--${kind}`;

  const gutter = document.createElement('span');
  gutter.className = 'diff-gutter';
  gutter.setAttribute('aria-hidden', 'true');
  gutter.textContent = kind === 'del' ? '−' : '+';

  const body = document.createElement('span');
  body.className = 'diff-text';
  if (before.clipped) body.append(ellipsis());
  if (before.text) body.append(document.createTextNode(before.text));
  if (changed) {
    const mark = document.createElement('span');
    mark.className = `diff-mark diff-mark--${kind}`;
    mark.textContent = changed;
    body.append(mark);
  }
  if (after.text) body.append(document.createTextNode(after.text));
  if (after.clipped) body.append(ellipsis());

  // Screen readers get the intent rather than the punctuation.
  const label = document.createElement('span');
  label.className = 'sr-only';
  label.textContent = kind === 'del' ? 'was: ' : 'becomes: ';

  row.append(gutter, label, body);
  return row;
}

/** Context kept either side of the change, in characters. */
const CONTEXT = 42;

export function renderDiff(original: string, proposed: string): HTMLElement {
  const box = document.createElement('div');
  box.className = 'diff';

  const d = diffWords(original, proposed);
  if (!d.removed && !d.added) {
    const same = document.createElement('div');
    same.className = 'diff-line diff-line--same';
    same.textContent = headContext(proposed, 160).text;
    box.append(same);
    return box;
  }

  const before = tailContext(d.prefix, CONTEXT);
  const after = headContext(d.suffix, CONTEXT);

  box.append(line('del', before, d.removed, after));
  box.append(line('ins', before, d.added, after));
  return box;
}

/** Boundary corrections are times, not prose, so they get their own two lines. */
export function renderTimingDiff(from: string, to: string): HTMLElement {
  const box = document.createElement('div');
  box.className = 'diff';
  for (const [kind, text] of [['del', from], ['ins', to]] as const) {
    const row = document.createElement('div');
    row.className = `diff-line diff-line--${kind}`;
    const gutter = document.createElement('span');
    gutter.className = 'diff-gutter';
    gutter.setAttribute('aria-hidden', 'true');
    gutter.textContent = kind === 'del' ? '−' : '+';
    const body = document.createElement('span');
    body.className = 'diff-text diff-text--times';
    body.textContent = text;
    row.append(gutter, body);
    box.append(row);
  }
  return box;
}
