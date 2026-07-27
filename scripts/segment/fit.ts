/**
 * Fits the six parli speeches to a diarized transcript.
 *
 * Rather than looking for speaker changes, this fits blocks of known length in
 * known order (PMC 7, LOC 8, MG 8, MO 8, LOR 4, PMR 5). Crosstalk, judge
 * questions and setup chatter do not match a multi-minute continuous block from
 * one voice, so they fall out as gaps instead of being mistaken for speeches.
 *
 * The PM and LO each speak twice (PMC/PMR and LOC/LOR), which is the strongest
 * signal available: the same voice must return for the rebuttal.
 */

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  speaker: string | null;
}

export interface Speech {
  label: string;
  side: 'aff' | 'neg';
  /** Nominal length in minutes. */
  minutes: number;
  /** Which earlier speech shares this speaker, if any. */
  sameVoiceAs?: string;
}

export const SPEECHES: Speech[] = [
  { label: 'PMC', side: 'aff', minutes: 7 },
  { label: 'LOC', side: 'neg', minutes: 8 },
  { label: 'MG', side: 'aff', minutes: 8 },
  { label: 'MO', side: 'neg', minutes: 8 },
  { label: 'LOR', side: 'neg', minutes: 4, sameVoiceAs: 'LOC' },
  { label: 'PMR', side: 'aff', minutes: 5, sameVoiceAs: 'PMC' },
];

export interface FittedSpeech {
  label: string;
  start: number;
  end: number;
  speaker: string | null;
  confidence: number;
}

export interface FitResult {
  slug: string;
  speeches: FittedSpeech[];
  /** Voices that hold a real share of the round, longest first. */
  primarySpeakers: string[];
  /** Set when the recording looks like more than a single round. */
  suspectLength: boolean;
  coverage: number;
}

interface Turn {
  speaker: string;
  start: number;
  end: number;
}

/**
 * Collapses consecutive segments by the same speaker into turns, bridging short
 * gaps so a breath between sentences does not split a speech in two.
 */
export function toTurns(segments: TranscriptSegment[], bridgeSeconds = 6): Turn[] {
  const turns: Turn[] = [];
  for (const seg of segments) {
    if (!seg.speaker) continue;
    const last = turns[turns.length - 1];
    if (last && last.speaker === seg.speaker && seg.start - last.end <= bridgeSeconds) {
      last.end = Math.max(last.end, seg.end);
    } else {
      turns.push({ speaker: seg.speaker, start: seg.start, end: seg.end });
    }
  }
  return turns;
}

/**
 * Diarization reliably finds the debaters but also emits sub-minute fragments
 * for crosstalk. Anything under a small share of speaking time is noise.
 */
export function primarySpeakers(turns: Turn[], minShare = 0.05): string[] {
  const totals = new Map<string, number>();
  for (const t of turns) totals.set(t.speaker, (totals.get(t.speaker) ?? 0) + (t.end - t.start));
  const total = [...totals.values()].reduce((a, b) => a + b, 0);
  return [...totals.entries()]
    .filter(([, secs]) => secs / total >= minShare)
    .sort((a, b) => b[1] - a[1])
    .map(([spk]) => spk);
}

/** Merges turns from the same speaker separated only by noise from others. */
function blocksFor(turns: Turn[], speaker: string, tolerate = 25): Turn[] {
  const mine = turns.filter(t => t.speaker === speaker);
  const blocks: Turn[] = [];
  for (const t of mine) {
    const last = blocks[blocks.length - 1];
    if (last && t.start - last.end <= tolerate) last.end = Math.max(last.end, t.end);
    else blocks.push({ ...t });
  }
  return blocks;
}

/**
 * Scores how well a block matches an expected speech: mostly duration, since
 * the format fixes it, with a penalty for running far over or under.
 */
function durationScore(actualSeconds: number, expectedMinutes: number): number {
  const expected = expectedMinutes * 60;
  const ratio = actualSeconds / expected;
  if (ratio <= 0) return 0;
  // Speeches routinely run short and are capped by the clock, so overrunning is
  // far more suspicious than underrunning.
  const spread = ratio < 1 ? 0.55 : 0.22;
  return Math.exp(-Math.pow(Math.log(ratio), 2) / (2 * spread * spread));
}

/**
 * Scores a complete assignment. Doing this over whole assignments rather than
 * one speech at a time is what makes the paired-voice constraint usable: PMR
 * can only be checked against PMC once both are chosen.
 */
function scoreAssignment(
  picks: Array<{ cand: Candidate; speech: Speech } | null>,
): number {
  let total = 0;
  const chosen = new Map<string, Candidate>();

  for (const p of picks) {
    if (!p) { total -= 0.9; continue; }   // a missing speech is costly but legal
    total += durationScore(p.cand.length, p.speech.minutes);
    chosen.set(p.speech.label, p.cand);
  }

  for (const p of picks) {
    if (!p?.speech.sameVoiceAs) continue;
    const partner = chosen.get(p.speech.sameVoiceAs);
    if (!partner) continue;
    // The same debater must deliver the constructive and its rebuttal.
    total += partner.speaker === p.cand.speaker ? 0.8 : -1.2;
  }

  for (let i = 1; i < picks.length; i++) {
    const a = picks[i - 1], b = picks[i];
    // Sides alternate, so back-to-back speeches are never the same voice.
    if (a && b && a.cand.speaker === b.cand.speaker) total -= 0.7;
  }

  const first = picks.find(Boolean);
  if (first) total -= Math.min(first.cand.start / 600, 1) * 0.4;  // PMC opens the round

  return total;
}

interface Candidate extends Turn { length: number }

/** No parli speech survives past this multiple of its slot, even with POIs. */
const MAX_OVERRUN = 1.45;

export function fitSpeeches(slug: string, segments: TranscriptSegment[], duration: number): FitResult {
  const turns = toTurns(segments);
  const primaries = primarySpeakers(turns);

  const candidates: Candidate[] = [];
  for (const spk of primaries) {
    for (const b of blocksFor(turns, spk)) {
      const length = b.end - b.start;
      if (length >= 90) candidates.push({ ...b, length });
    }
  }
  candidates.sort((a, b) => a.start - b.start);

  // Search every chronological assignment of candidates to the six speeches,
  // allowing gaps for speeches missing from the recording.
  let bestPicks: Array<{ cand: Candidate; speech: Speech } | null> = SPEECHES.map(() => null);
  let bestScore = -Infinity;
  const current: Array<{ cand: Candidate; speech: Speech } | null> = [];

  function search(speechIdx: number, candIdx: number) {
    if (speechIdx === SPEECHES.length) {
      const score = scoreAssignment(current);
      if (score > bestScore) { bestScore = score; bestPicks = [...current]; }
      return;
    }
    const speech = SPEECHES[speechIdx];
    const prev = [...current].reverse().find(Boolean) ?? null;

    for (let k = candIdx; k < candidates.length; k++) {
      const cand = candidates[k];

      // Hard constraints, not scoring nudges. Index order is not time order,
      // so overlap has to be rejected explicitly.
      if (prev && cand.start < prev.cand.end - 1) continue;
      if (prev && cand.speaker === prev.cand.speaker) continue;
      if (cand.length > speech.minutes * 60 * MAX_OVERRUN) continue;
      if (durationScore(cand.length, speech.minutes) < 0.12) continue;

      current.push({ cand, speech });
      search(speechIdx + 1, k + 1);
      current.pop();
    }
    current.push(null);          // this speech is absent from the recording
    search(speechIdx + 1, candIdx);
    current.pop();
  }
  search(0, 0);

  const fitted: FittedSpeech[] = bestPicks.map((p, i) => {
    const speech = SPEECHES[i];
    if (!p) return { label: speech.label, start: 0, end: 0, speaker: null, confidence: 0 };
    let confidence = durationScore(p.cand.length, speech.minutes);
    if (speech.sameVoiceAs) {
      const partner = bestPicks.find(q => q?.speech.label === speech.sameVoiceAs);
      if (partner) confidence *= partner.cand.speaker === p.cand.speaker ? 1 : 0.5;
    }
    return {
      label: speech.label,
      start: Math.round(p.cand.start),
      end: Math.round(p.cand.end),
      speaker: p.cand.speaker,
      confidence: Number(Math.min(1, confidence).toFixed(2)),
    };
  });

  const covered = fitted.reduce((a, f) => a + (f.end - f.start), 0);
  return {
    slug,
    speeches: fitted,
    primarySpeakers: primaries,
    suspectLength: duration > 7200,
    coverage: Number((covered / Math.max(duration, 1)).toFixed(3)),
  };
}
