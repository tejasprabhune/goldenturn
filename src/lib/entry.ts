/**
 * How the parts of a submission become the one line an entry carries.
 *
 * A round is only findable if every round says the same thing the same way:
 * "3-off (framework-t, actor spec)", not "three off" or "3 off - fw, actor
 * spec". The submit form used to ask for that line in a text box and hope,
 * with the convention living in a placeholder. It asks for the pieces now, and
 * writes the line here, so the archive stays one vocabulary.
 */

export interface TitleParts {
  stage: string;
  affTeam: string;
  negTeam: string;
}

/** "Finals - Cal MR vs Rice AL", and something sensible while half typed. */
export function composeTitle({ stage, affTeam, negTeam }: TitleParts): string {
  const teams = affTeam && negTeam ? `${affTeam} vs ${negTeam}` : affTeam || negTeam;
  return [stage, teams].filter(Boolean).join(' - ');
}

export interface AffParts {
  topical: boolean;
  advantages: string[];
  mg: string;
  pmr: string;
  other: string;
  /** What a nontopical aff read, which is what it is filed under. */
  free: string;
}

/**
 * "topical (war, econ), mg reads pics bad, pmr goes for case", or the same
 * with what a nontopical aff read in place of the advantages.
 *
 * What the MG added and what the PMR went for are asked either way: a
 * nontopical aff has both, and the rest of the round is what a reader is
 * usually looking for the round to see.
 */
export function composeAff({ topical, advantages, mg, pmr, other, free }: AffParts): string {
  const rest = [
    mg.trim() && `mg reads ${mg.trim()}`,
    pmr.trim() && `pmr goes for ${pmr.trim()}`,
    other.trim(),
  ].filter(Boolean) as string[];

  const advs = advantages.map(a => a.trim()).filter(Boolean);
  // Nothing said at all is nothing filed, rather than a bare "topical" on
  // every round whose aff nobody got round to describing.
  const lead = topical
    ? (advs.length ? `topical (${advs.join(', ')})` : 'topical')
    : free.trim();

  if (topical && advs.length === 0 && rest.length === 0) return '';
  if (!lead && rest.length === 0) return '';

  return [lead, ...rest].filter(Boolean).join(', ');
}

/** "3-off (framework-t, actor spec, orientalism)". */
export function composeNeg(count: number, positions: string[]): string {
  if (!Number.isFinite(count) || count <= 0) return '';
  const named = positions.map(p => p.trim()).filter(Boolean);
  return named.length ? `${count}-off (${named.join(', ')})` : `${count}-off`;
}

export interface DecisionParts {
  /** '' until the submitter says which kind of decision it was. */
  kind: 'prelim' | 'panel' | '';
  /** 'Aff' or 'Neg', as the entry spells them. */
  side: string;
  won: string;
  lost: string;
}

/**
 * A prelim is one judge, so the side is the whole decision. A panel is a count
 * of ballots, and a panel that splits them evenly has no winner to name.
 */
export function composeDecision({ kind, side, won, lost }: DecisionParts): string {
  if (kind !== 'panel') return side;
  if (won === '' || lost === '') return side;
  if (Number(won) === Number(lost)) return `${won}-${lost} Split`;
  return side ? `${won}-${lost} ${side}` : '';
}
