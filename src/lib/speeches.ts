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

/**
 * Accepted boundary revisions win over the machine fit, and a corrected speech
 * is certain by definition. Revision values are JSON `{start, end}`; the first
 * ones written stored a bare start time.
 */
export function applyBoundaries(speeches: Speech[], revisions: Revision[]): Speech[] {
  const moves = new Map<string, { start: number; end?: number }>();

  for (const r of revisions) {
    if (r.kind !== 'boundary') continue;
    try {
      const v = JSON.parse(r.value);
      const start = Number(v.start);
      const end = Number(v.end);
      moves.set(r.anchor, { start, end: Number.isFinite(end) ? end : undefined });
    } catch {
      moves.set(r.anchor, { start: Number(r.value) });
    }
  }

  if (moves.size === 0) return speeches;

  return speeches
    .map(s => {
      const m = moves.get(s.label);
      if (!m || !Number.isFinite(m.start)) return s;
      return { ...s, start: m.start, end: m.end ?? s.end, confidence: 1 };
    })
    .sort((a, b) => a.start - b.start);
}
