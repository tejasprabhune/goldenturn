/**
 * What a debater types, as opposed to what the file says.
 *
 * In prep a debater searches in flow shorthand ("econ da spending", "a2 heg
 * bad", "tix thumpers") while the file is written in sentences. The
 * alternatives built here bridge the two. They are generated, not written: the
 * same file always yields the same phrasings, from the block's title, family,
 * side and Use line plus the table of debate shorthand below, so re-indexing
 * never churns them.
 */
import type { PrepSide, PrepType } from '../../src/lib/prep/types';

/**
 * Debate shorthand. Each row is one idea; every spelling in a row is taken to
 * mean the same thing. The first entry is the one generated phrasings use.
 * These rows are also pushed to the index as synonyms, so a query in any
 * spelling finds blocks written in another.
 */
export const SHORTHAND: string[][] = [
  ['uq', 'uniqueness', 'unique', 'squo', 'status quo'],
  ['link', 'links', 'link story'],
  ['il', 'internal link', 'internal links', 'internals'],
  ['impact', 'impacts', 'impx', 'imp', 'terminal impact'],
  ['at', 'a2', 'answers to', 'answer to', 'answers', 'responses to', 'they say'],
  ['da', 'disad', 'disadvantage', 'dis ad'],
  ['adv', 'advantage', 'advantages'],
  ['aff', 'affirmative', 'gov', 'government', 'pm', 'pmc'],
  ['neg', 'negative', 'opp', 'opposition', 'loc', 'lo'],
  ['nuq', 'non unique', 'not unique', 'no uniqueness'],
  ['thumper', 'thumpers', 'already happening'],
  ['no brink', 'resilient', 'no tipping point'],
  ['turns case', 'turns the case', 'tc', 'case turn'],
  ['econ', 'economy', 'economic', 'markets', 'recession'],
  ['heg', 'hegemony', 'us leadership', 'primacy', 'unipolarity'],
  ['heg bad', 'restraint', 'offshore balancing'],
  ['prolif', 'proliferation', 'nuclear proliferation', 'nukes'],
  ['politics', 'ptx', 'tix', 'pc', 'political capital', 'agenda'],
  ['ai', 'artificial intelligence'],
  ['china', 'prc', 'beijing', 'ccp'],
  ['war', 'great power war', 'gpw', 'conflict'],
  ['extinction', 'extinct', 'existential'],
  ['ext', 'extension', 'extend', 'xt'],
  ['pp', 'plan passes'],
  ['nwm', 'normal means'],
  ['cp', 'counterplan'],
  ['k', 'kritik', 'critique'],
  ['fdi', 'foreign investment', 'foreign direct investment'],
  ['regs', 'regulation', 'regulations', 'regulate'],
  ['data centers', 'data center', 'datacenters', 'buildout', 'compute'],
  ['grid', 'power grid', 'electricity', 'blackouts'],
  ['chips', 'chip', 'semiconductors', 'export controls'],
  ['shutdown', 'government shutdown', 'funding deal', 'cr'],
  ['ndaa', 'defense bill'],
];

/** The shorthand for a file, read off its slug: econ-investor-confidence is econ. */
function fileTopics(slug: string, title: string): string[] {
  const head = slug.split('-')[0];
  const topics = new Set<string>();
  const known: Record<string, string> = { econ: 'econ', heg: 'heg', ai: 'ai', politics: 'politics', prolif: 'prolif' };
  if (known[head]) topics.add(known[head]);
  if (slug === 'heg-bad') topics.add('heg bad');
  if (slug === 'heg-good') topics.add('heg good');
  // The part of the title after the dash is the scenario: "Investor Confidence".
  const scenario = title.split(/\s+[—–-]\s+/)[1];
  if (scenario) topics.add(scenario.toLowerCase());
  return [...topics];
}

const TYPE_WORDS: Record<PrepType, string[]> = {
  uq: ['uq', 'uniqueness'],
  link: ['link', 'links'],
  il: ['il', 'internal link'],
  impact: ['impact', 'impx'],
  answer: ['at', 'a2', 'answers to'],
  other: ['block', 'shell'],
};

/**
 * Which side reads a block. The heading says it first when it starts "Aff —"
 * or "Neg —"; otherwise the Use line says who it is for ("Use on neg ...",
 * "Use for AI affs ...", "Use on either side ..."). A block whose Use line
 * names no side ("Use when you're running the scenario ...") is either.
 */
export function parseSide(title: string, use: string): PrepSide {
  const t = title.match(/^(aff|neg)\b\s*[—–:-]/i);
  if (t) return t[1].toLowerCase() as PrepSide;
  const u = use.replace(/^use\s+/i, '');
  if (/^(on|for)\s+(the\s+)?neg\b/i.test(u)) return 'neg';
  if (/^(on|for)\s+(the\s+)?aff\b/i.test(u)) return 'aff';
  if (/^(on|for)\s+either\b/i.test(u)) return 'either';
  // "for AI affs to say", "for any aff that spends": an aff named before the verb.
  const lead = u.split(/\s+to\s+(say|answer|get|weigh)\b/i)[0];
  if (/^for\b/i.test(lead) && /\baffs?\b/i.test(lead) && !/\bneg\b/i.test(lead)) return 'aff';
  if (/^for\b/i.test(lead) && /\bnegs?\b/i.test(lead) && !/\baff\b/i.test(lead)) return 'neg';
  return 'either';
}

export function parseType(family: string): PrepType | null {
  const f = family.trim().toLowerCase();
  if (f === 'uq' || f.startsWith('uniqueness')) return 'uq';
  if (f.startsWith('link')) return 'link';
  if (f === 'il' || f.startsWith('internal')) return 'il';
  if (f.startsWith('impact')) return 'impact';
  if (f.startsWith('answer') || f === 'at' || f === 'a2') return 'answer';
  return null;
}

/** Families that are context for the reader, not something a debater pulls. */
const NOT_BLOCKS = /^(story|freshness|examples|notes|sources)\b/i;

/**
 * What kind of block this is. The five families name themselves; in files with
 * other families (counterplans, kritik answers, tricks) an `AT:` title is an
 * answer and everything else is `other`, so nothing a debater can pull is
 * left out of the index.
 */
export function blockType(family: string, title: string): PrepType | null {
  if (NOT_BLOCKS.test(family.trim())) return null;
  if (/^at:/i.test(title.trim())) return 'answer';
  return parseType(family) ?? (/answer/i.test(family) ? 'answer' : 'other');
}

/** Drop the article and filler words a debater would not type. */
function terse(s: string): string {
  return s
    .toLowerCase()
    .replace(/[“”"]/g, '')
    .replace(/[—–]/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\b(the|a|an|that|their|its|it's|is|are|of|to|and|or|just|any)\b/g, ' ')
    .replace(/[.,:;!?()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function clean(s: string): string {
  return s.toLowerCase().replace(/[—–]/g, ' ').replace(/[.,:;!?()“”"]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** Rewrites a phrase with the first shorthand spelling of each idea it names. */
function shorten(s: string): string {
  let out = ` ${s.toLowerCase()} `;
  for (const row of SHORTHAND) {
    for (const spelling of row.slice(1)) {
      if (spelling.length < 4) continue;
      out = out.replace(new RegExp(`\\b${spelling.replace(/\s+/g, '\\s+')}\\b`, 'g'), row[0]);
    }
  }
  return out.replace(/\s+/g, ' ').trim();
}

export interface PhrasingInput {
  fileSlug: string;
  fileTitle: string;
  family: string;
  type: PrepType;
  side: PrepSide;
  title: string;
  use: string;
}

/**
 * The phrasings for one block, most specific first, at most a dozen.
 *
 * - topic + family in shorthand ("econ uq", "heg impact");
 * - the side's argument name: neg reads a disad, aff an advantage ("econ da
 *   uq", "econ adv link"); a link names the plan it is for ("econ da vs
 *   spending aff");
 * - answers keep what they answer in the words the other team says it
 *   ("a2 stock market isn't economy", "they say markets aren't the economy");
 * - the Use line's own "they say ...", "to answer ..." and "against ..."
 *   clauses, which are written in the debater's voice already.
 */
export function alternativePhrasings(b: PhrasingInput): string[] {
  const out: string[] = [];
  const add = (s: string) => {
    // Shortening can leave a word twice ("no brink no brink"); once is enough.
    const t = [...new Set(s.split(/\s+/).filter(Boolean))].join(' ');
    if (t && t.length <= 90) out.push(t);
  };

  const topics = fileTopics(b.fileSlug, b.fileTitle);
  const topic = topics[0] ?? '';
  const arg = b.side === 'neg' ? ['da'] : b.side === 'aff' ? ['adv'] : ['da', 'adv'];
  const [fam, famLong] = TYPE_WORDS[b.type];
  const titleTerse = terse(b.title.replace(/^(aff|neg)\s*[—–:-]\s*/i, '').replace(/^at:\s*/i, ''));

  if (b.type === 'answer') {
    const what = titleTerse;
    add(`a2 ${what}`);
    add(`at ${shorten(what)}`);
    add(`answers to ${what}`);
    const said = clean(b.title.replace(/^at:\s*/i, ''));
    if (/^at:/i.test(b.title)) add(`they say ${said}`);
    if (topic) add(`${topic} ${arg[0]} at ${shorten(what)}`);
  } else {
    for (const t of topics.slice(0, 2)) {
      add(`${t} ${fam}`);
      for (const a of arg) add(`${t} ${a} ${fam}`);
    }
    if (topic) add(`${topic} ${famLong} ${shorten(titleTerse)}`);
  }

  // A link plug-in is named for the plan it beats: "Neg — spending or deficit".
  if (b.type === 'link' && topic) {
    const plan = terse(b.title.replace(/^(aff|neg)\s*[—–:-]\s*/i, '')).split(' ').slice(0, 3).join(' ');
    if (b.side === 'neg') add(`${topic} da vs ${plan} aff`);
    if (b.side === 'aff') add(`${topic} adv ${plan}`);
  }

  if (b.type === 'impact' || b.type === 'il') add(`${shorten(titleTerse)} ${fam}`);

  const use = b.use.replace(/^use\s+/i, '');
  const theySay = use.match(/they say (.+?)(?:[.,;]|$)/i);
  if (theySay) add(`they say ${clean(theySay[1])}`);
  const answer = use.match(/to answer (?:an? |the )?(.+?)(?: by | to |[.,;]|$)/i);
  if (answer) add(`at ${terse(answer[1])}`);
  // "against any aff that restricts, taxes or slows AI to say ..." is "da vs
  // restricts taxes slows ai": what the plan does is the part worth typing.
  const against = use.match(/against (.+?)(?: to (?:say|answer|get)\b|[.;]|$)/i);
  if (against) {
    const what = terse(
      against[1]
        .replace(/^(an?|any|the)\s+/i, '')
        .replace(/^(affs?|plans?|negs?|ones?)\s+(that|which|where|with|when)\s+/i, ''),
    ).split(' ').slice(0, 5).join(' ');
    if (what && !/^(them|affs?|plans?)$/.test(what)) add(`${topic ? topic + ' ' : ''}${arg[0]} vs ${what}`);
  }

  return [...new Set(out)].slice(0, 12);
}

/**
 * HOOK: richer generated phrasings.
 *
 * Everything above is deterministic and cheap. Phrasings written by a model
 * (or by hand) for a block can be supplied here later: return them for the
 * block and they are merged after the generated ones. The indexer passes in
 * the contents of `--phrasings <file.json>` (objectID to a list of strings),
 * so a separate step can produce that file without this script changing.
 */
export function extraPhrasings(objectID: string, supplied: Record<string, string[]> | null): string[] {
  return supplied?.[objectID] ?? [];
}
