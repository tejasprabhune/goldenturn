/**
 * Fits a round's speeches to a diarized transcript.
 *
 * Rather than looking for speaker changes, this fits blocks of known length in
 * known order. Crosstalk, judge questions and setup chatter do not match a
 * multi-minute continuous block from one voice, so they fall out as gaps
 * instead of being mistaken for speeches.
 *
 * The strongest signal available is that debaters speak more than once: in
 * parli the PM and LO each give a constructive and a rebuttal, and in policy
 * all four debaters do. The same voice has to come back, and an assignment
 * that says otherwise is almost certainly wrong.
 *
 * Policy differs from parli in three ways that matter here. There are eight
 * speeches rather than six. The negative block puts the 2NC and the 1NR back
 * to back, so the sides do not simply alternate, though the speakers still
 * change. And every constructive is followed by three minutes of cross
 * examination in which the person who just spoke keeps answering, which would
 * otherwise be swallowed into their speech and make a nine minute constructive
 * look like twelve.
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

/** College policy: nine minute constructives, six minute rebuttals. */
export const POLICY_COLLEGE: Speech[] = [
  { label: '1AC', side: 'aff', minutes: 9 },
  { label: '1NC', side: 'neg', minutes: 9 },
  { label: '2AC', side: 'aff', minutes: 9 },
  { label: '2NC', side: 'neg', minutes: 9 },
  { label: '1NR', side: 'neg', minutes: 6, sameVoiceAs: '1NC' },
  { label: '1AR', side: 'aff', minutes: 6, sameVoiceAs: '1AC' },
  { label: '2NR', side: 'neg', minutes: 6, sameVoiceAs: '2NC' },
  { label: '2AR', side: 'aff', minutes: 6, sameVoiceAs: '2AC' },
];

/** High school policy: the same eight speeches, a minute shorter each. */
export const POLICY_HS: Speech[] = POLICY_COLLEGE.map(s => ({
  ...s,
  minutes: s.minutes === 9 ? 8 : 5,
}));

export interface RoundFormat {
  name: string;
  speeches: Speech[];
  /**
   * How much of somebody else's talk can sit inside one speaker's block before
   * it stops being their speech.
   *
   * Parli has none: a POI is short, interruptions are rare, and the setting
   * that worked over two hundred and seventy nine rounds is left alone. Policy
   * needs one, because cross examination is three minutes in which the speaker
   * who just finished keeps talking, and without a limit their constructive and
   * their cross examination merge into one twelve minute block.
   */
  maxForeignSeconds: number;
}

export const FORMATS: Record<string, RoundFormat> = {
  parli: { name: 'parli', speeches: SPEECHES, maxForeignSeconds: Infinity },
  policy: { name: 'policy', speeches: POLICY_COLLEGE, maxForeignSeconds: 10 },
  'policy-hs': { name: 'policy-hs', speeches: POLICY_HS, maxForeignSeconds: 10 },
};

export interface FittedSpeech {
  label: string;
  start: number;
  end: number;
  speaker: string | null;
  confidence: number;
}

export interface FitResult {
  slug: string;
  /** Which format this was fitted as, so the site does not have to guess. */
  format: string;
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

/**
 * Merges turns from the same speaker separated only by noise from others.
 *
 * A block ends either at a long silence or, where a format sets a limit, once
 * enough of somebody else's talk has accumulated inside it. The second test is
 * what separates a policy constructive from the cross examination that follows
 * it: the questions are individually short enough to look like breaths, and
 * only add up to something once you stop resetting the count at every answer.
 */
function blocksFor(turns: Turn[], speaker: string, tolerate = 25, maxForeign = Infinity): Turn[] {
  const blocks: Turn[] = [];
  let current: Turn | null = null;
  let foreign = 0;

  for (const t of turns) {
    if (t.speaker !== speaker) {
      if (current) foreign += t.end - t.start;
      continue;
    }
    if (current && t.start - current.end <= tolerate && foreign <= maxForeign) {
      current.end = Math.max(current.end, t.end);
    } else {
      if (current) blocks.push(current);
      current = { ...t };
      foreign = 0;
    }
  }
  if (current) blocks.push(current);
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
  speeches: Speech[],
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
  if (first) total -= Math.min(first.cand.start / 600, 1) * 0.4;  // the first constructive opens the round

  // A round is not a round with two speeches in it. Scoring each absence the
  // same makes an eight speech format cheap to give up on, so the penalty
  // grows with how much of the round has gone missing.
  const missing = picks.filter(p => !p).length;
  if (missing > speeches.length / 2) total -= missing * 0.5;

  return total;
}

interface Candidate extends Turn { length: number }

/** No speech survives past this multiple of its slot, even with POIs. */
const MAX_OVERRUN = 1.45;

/**
 * The most one speech can add to an assignment's score: a perfect length, plus
 * the bonus for the right voice coming back for the rebuttal.
 *
 * Used only as a ceiling. The search is over every way of assigning candidate
 * blocks to speeches in order, which is fine for six speeches and a handful of
 * blocks and is not fine for eight speeches and the thirty-odd blocks a two
 * hour policy round breaks into. Since every other term in the score is a
 * penalty, ignoring them gives a bound that is never too low, so a branch it
 * prunes could never have won.
 */
const MAX_SPEECH_SCORE = 1.8;

export function fitSpeeches(
  slug: string,
  segments: TranscriptSegment[],
  duration: number,
  format: RoundFormat = FORMATS.parli,
): FitResult {
  const SPEECHES = format.speeches;
  const turns = toTurns(segments);
  const primaries = primarySpeakers(turns);

  const candidates: Candidate[] = [];
  for (const spk of primaries) {
    for (const b of blocksFor(turns, spk, 25, format.maxForeignSeconds)) {
      const length = b.end - b.start;
      if (length >= 90) candidates.push({ ...b, length });
    }
  }
  candidates.sort((a, b) => a.start - b.start);

  // Search every chronological assignment of candidates to the speeches,
  // allowing gaps for speeches missing from the recording.
  let bestPicks: Array<{ cand: Candidate; speech: Speech } | null> = SPEECHES.map(() => null);
  let bestScore = -Infinity;
  const current: Array<{ cand: Candidate; speech: Speech } | null> = [];

  function search(speechIdx: number, candIdx: number, earned: number) {
    if (speechIdx === SPEECHES.length) {
      const score = scoreAssignment(current, SPEECHES);
      if (score > bestScore) { bestScore = score; bestPicks = [...current]; }
      return;
    }
    // Even a perfect run from here could not catch the best assignment found
    // so far, so there is nothing under this branch worth looking at.
    if (earned + (SPEECHES.length - speechIdx) * MAX_SPEECH_SCORE <= bestScore) return;

    const speech = SPEECHES[speechIdx];
    const prev = [...current].reverse().find(Boolean) ?? null;

    for (let k = candIdx; k < candidates.length; k++) {
      const cand = candidates[k];

      // Hard constraints, not scoring nudges. Index order is not time order,
      // so overlap has to be rejected explicitly.
      if (prev && cand.start < prev.cand.end - 1) continue;
      if (prev && cand.speaker === prev.cand.speaker) continue;
      if (cand.length > speech.minutes * 60 * MAX_OVERRUN) continue;
      const fit = durationScore(cand.length, speech.minutes);
      if (fit < 0.12) continue;

      current.push({ cand, speech });
      search(speechIdx + 1, k + 1, earned + fit + 0.8);
      current.pop();
    }
    current.push(null);          // this speech is absent from the recording
    search(speechIdx + 1, candIdx, earned);
    current.pop();
  }
  search(0, 0, 0);

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
  // Sixty minutes of parli speech fits in two hours with room to spare, so
  // more than that was two rounds in one file. Policy is sixty minutes of
  // speech plus twelve of cross examination plus twenty of prep before anyone
  // runs long, and three hours is an ordinary elimination round.
  const tooLong = format.name === 'parli' ? 7200 : 16200;
  return {
    slug,
    format: format.name,
    speeches: fitted,
    primarySpeakers: primaries,
    suspectLength: duration > tooLong,
    coverage: Number((covered / Math.max(duration, 1)).toFixed(3)),
  };
}
