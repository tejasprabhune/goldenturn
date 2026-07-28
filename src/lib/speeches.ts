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

/** The six speeches of a parli round, in the order they are given. */
export const SPEECH_ORDER = ['PMC', 'LOC', 'MG', 'MO', 'LOR', 'PMR'] as const;

/** Whether the fitter actually found this speech. */
export function placed(s: Speech): boolean {
  return s.confidence > 0 && s.end > s.start;
}

/**
 * Every speech the fitter reported, placed or not.
 *
 * Unplaced ones are kept rather than dropped: a speech the fitter could not
 * find is the case most in need of a person, and one that has been filtered
 * out cannot be offered for correction or carry an accepted one. Anything that
 * draws or jumps filters with `placed` at the point of use instead.
 */
export function usable(speeches: Speech[]): Speech[] {
  const known = new Map(speeches.map(s => [s.label, s]));
  const extra = speeches.filter(s => !(SPEECH_ORDER as readonly string[]).includes(s.label));
  return [
    ...SPEECH_ORDER.map(label => known.get(label) ?? { label, start: 0, end: 0, confidence: 0 }),
    ...extra,
  ];
}

/** Time order for the ones that have a time; the rest keep to the end. */
export function byTime(a: Speech, b: Speech): number {
  if (!placed(a) && !placed(b)) return 0;
  if (!placed(a)) return 1;
  if (!placed(b)) return -1;
  return a.start - b.start;
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
      return m ? { ...s, start: m.start, end: m.end, confidence: Math.max(s.confidence, 1) } : s;
    })
    .sort(byTime);
}

/**
 * Which of these proposed spans cannot be applied together. A speech has to
 * start before it ends and cannot overlap its neighbours, so a set of
 * corrections that would produce an impossible round is refused rather than
 * silently drawn. Returns the labels at fault.
 */
export function conflicts(speeches: Speech[], moves: Map<string, Span>): Set<string> {
  const bad = new Set<string>();
  // A speech the fitter never placed sits at zero and would appear to overlap
  // everything; it constrains nothing until someone gives it a time.
  const merged = withSpans(speeches, moves).filter(placed);

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
    .sort(byTime);
}
