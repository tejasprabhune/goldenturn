/**
 * Word-level diff for transcript corrections.
 *
 * A correction is almost always one contiguous change inside a passage, so
 * trimming the shared head and tail isolates it exactly. That is enough to show
 * a reader what actually changed instead of two near-identical blocks of text.
 */

export interface Diff {
  /** Unchanged text before the edit. */
  prefix: string;
  /** Text the correction takes out. Empty on a pure insertion. */
  removed: string;
  /** Text the correction puts in. Empty on a pure deletion. */
  added: string;
  /** Unchanged text after the edit. */
  suffix: string;
}

/** Split on whitespace but keep it, so the pieces rejoin exactly. */
function tokenize(s: string): string[] {
  return s.split(/(\s+)/).filter(t => t !== '');
}

export function diffWords(before: string, after: string): Diff {
  const a = tokenize(before);
  const b = tokenize(after);

  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;

  let tail = 0;
  while (
    tail < a.length - head
    && tail < b.length - head
    && a[a.length - 1 - tail] === b[b.length - 1 - tail]
  ) tail++;

  return {
    prefix: a.slice(0, head).join(''),
    removed: a.slice(head, a.length - tail).join(''),
    added: b.slice(head, b.length - tail).join(''),
    suffix: a.slice(a.length - tail).join(''),
  };
}

/** Keep the last `max` characters, snapped to a word boundary. */
export function tailContext(s: string, max = 34): { text: string; clipped: boolean } {
  if (s.length <= max) return { text: s, clipped: false };
  const cut = s.slice(s.length - max);
  const space = cut.indexOf(' ');
  return { text: space === -1 ? cut : cut.slice(space + 1), clipped: true };
}

/** Keep the first `max` characters, snapped to a word boundary. */
export function headContext(s: string, max = 34): { text: string; clipped: boolean } {
  if (s.length <= max) return { text: s, clipped: false };
  const cut = s.slice(0, max);
  const space = cut.lastIndexOf(' ');
  return { text: space === -1 ? cut : cut.slice(0, space), clipped: true };
}

/**
 * Widen a selection to a readable passage: a little context either side,
 * snapped outward to word boundaries and clamped to the paragraph.
 */
export function windowAround(
  text: string,
  selStart: number,
  selEnd: number,
  pad = 90,
): { start: number; end: number } {
  let start = Math.max(0, selStart - pad);
  let end = Math.min(text.length, selEnd + pad);

  if (start > 0) {
    const space = text.lastIndexOf(' ', start);
    start = space === -1 ? 0 : space + 1;
  }
  if (end < text.length) {
    const space = text.indexOf(' ', end);
    end = space === -1 ? text.length : space;
  }
  return { start, end };
}

