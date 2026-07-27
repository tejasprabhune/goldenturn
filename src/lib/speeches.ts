/**
 * The six parli speeches, shared by the player and the transcript.
 *
 * Both read the machine fit from R2 and both have to lay the same accepted
 * timing corrections over it, so the merge lives here rather than in each
 * component. A boundary that moved in the player has to move the transcript's
 * dividers, tinting and minimap with it.
 */

export interface Speech {
  label: string;
  start: number;
  end: number;
  confidence: number;
}

export interface Revision {
  kind: string;
  anchor: string;
  value: string;
}

/** Aff speeches read gold, neg read sky. */
export const AFF = new Set(['PMC', 'MG', 'PMR']);

export function sideOf(label: string): 'aff' | 'neg' {
  return AFF.has(label) ? 'aff' : 'neg';
}

/** Drop the speeches the fitter could not place. */
export function usable(speeches: Speech[]): Speech[] {
  return speeches.filter(s => s.confidence > 0 && s.end > s.start);
}

/** A proposed span for one speech, as stored in a boundary proposal. */
export interface Span {
  start: number;
  end: number;
}

/** Boundary values are JSON `{start, end}`; the first written were a bare start. */
export function parseSpan(value: string, fallback?: Span): Span | null {
  try {
    const v = JSON.parse(value);
    const start = Number(v.start);
    const end = Number(v.end);
    if (!Number.isFinite(start)) return null;
    return { start, end: Number.isFinite(end) ? end : (fallback?.end ?? start) };
  } catch {
    const start = Number(value);
    if (!Number.isFinite(start)) return null;
    return { start, end: fallback?.end ?? start };
  }
}

/** Lays a set of proposed spans over the current fit, keeping it in time order. */
export function withSpans(speeches: Speech[], moves: Map<string, Span>): Speech[] {
  if (moves.size === 0) return speeches;
  return speeches
    .map(s => {
      const m = moves.get(s.label);
      return m ? { ...s, start: m.start, end: m.end } : s;
    })
    .sort((a, b) => a.start - b.start);
}

/**
 * Which of these proposed spans cannot be applied together. A speech has to
 * start before it ends and cannot overlap its neighbours, so a set of
 * corrections that would produce an impossible round is refused rather than
 * silently drawn. Returns the labels at fault.
 */
export function conflicts(speeches: Speech[], moves: Map<string, Span>): Set<string> {
  const bad = new Set<string>();
  const merged = withSpans(speeches, moves);

  for (const s of merged) {
    if (s.end <= s.start && moves.has(s.label)) bad.add(s.label);
  }
  for (let i = 1; i < merged.length; i++) {
    const prev = merged[i - 1];
    const cur = merged[i];
    // A one second touch is rounding, not an overlap.
    if (cur.start < prev.end - 1) {
      if (moves.has(prev.label)) bad.add(prev.label);
      if (moves.has(cur.label)) bad.add(cur.label);
      // An overlap that survives with neither end moved is already in the fit.
      if (!moves.has(prev.label) && !moves.has(cur.label)) continue;
    }
  }
  return bad;
}

/**
 * Accepted boundary revisions win over the machine fit, and a corrected speech
 * is certain by definition.
 */
export function applyBoundaries(speeches: Speech[], revisions: Revision[]): Speech[] {
  const moves = new Map<string, Span>();

  for (const r of revisions) {
    if (r.kind !== 'boundary') continue;
    const current = speeches.find(s => s.label === r.anchor);
    const span = parseSpan(r.value, current);
    if (span) moves.set(r.anchor, span);
  }

  if (moves.size === 0) return speeches;

  return speeches
    .map(s => {
      const m = moves.get(s.label);
      return m ? { ...s, start: m.start, end: m.end, confidence: 1 } : s;
    })
    .sort((a, b) => a.start - b.start);
}
