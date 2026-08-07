/**
 * Reads the Dartmouth debate video database.
 *
 * It is a public Notion table of college policy rounds with YouTube links, and
 * it is the closest thing the activity has to an index of recorded policy
 * debate. Notion renders it in the browser, so the page itself is an empty
 * shell; the table comes from the same private API the page calls, which
 * public pages answer without a key.
 *
 * The output is written to disk rather than ingested here, so what the source
 * says and what the archive does with it stay separate steps: the file can be
 * read, diffed and corrected before anything is downloaded or indexed.
 *
 *   npx tsx scripts/ingest/policy-source.ts
 */
import { writeFileSync } from 'fs';
import { join } from 'path';

const HOST = 'https://dartmouth-debate.notion.site';
const PAGE = '25c28c91-c917-8042-904d-db0fea160347';
const OUT = join('scripts', 'ingest', 'policy-rounds.json');

export interface PolicyRound {
  /** The YouTube id, which is the only identifier both stable and unique. */
  objectID: string;
  title: string;
  link: string;
  teams: string;
  tournament: string;
  /** Calendar year of the tournament, not the debate season. */
  year: string;
  round: string;
  durationS: number | null;
}

/** Notion stores every text property as an array of [text, ...formatting]. */
function flat(v: unknown): string {
  return Array.isArray(v) ? v.map((seg: any) => seg[0]).join('') : '';
}

async function api(path: string, body: unknown): Promise<any> {
  const res = await fetch(`${HOST}/api/v3/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path} ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

function youtubeId(url: string): string | null {
  const m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([\w-]{11})/);
  return m ? m[1] : null;
}

/**
 * The stage of the tournament, however this row happens to spell it.
 *
 * The database was filled in by hand over years, so the stage turns up in its
 * own column, or glued to the front of the teams, or both, and spelled Octas,
 * Octafinals or once Ocats. Everything maps onto the vocabulary the rest of
 * the archive already uses.
 */
// Longest spelling first in every alternation. "Octa" placed before "Octas"
// matches the shorter one and leaves the s behind, turning a team name into
// "s CSU Long Beach FO".
const STAGES: Array<[RegExp, string]> = [
  [/^round\s*(\d+)/i, 'Round $1'],
  [/^(double-?octafinals|double-?octas|doubles)/i, 'Doubles'],
  [/^(triple-?octafinals|triple-?octas|triples)/i, 'Triples'],
  [/^(octafinals|ocats|octas|octa)/i, 'Octafinals'],
  [/^(quarterfinals|quarters|quarter)/i, 'Quarterfinals'],
  [/^(semifinals|semis|semi)/i, 'Semifinals'],
  [/^(finals|final)/i, 'Finals'],
  [/^(prelims|prelim)/i, 'Prelim'],
  [/^fyb/i, 'FYB'],
];

function canonicalStage(raw: string): string {
  const t = raw.trim();
  for (const [re, name] of STAGES) {
    if (re.test(t)) return t.replace(re, name).split(/\s{2,}|:/)[0].trim();
  }
  return t;
}

/** Pulls a stage off the front of a team string, returning both parts. */
function splitStage(teams: string): { stage: string; rest: string } {
  const t = teams.replace(/^\s*[\w ]+:\s*/, '').trim();
  for (const [re, name] of STAGES) {
    const m = t.match(re);
    if (!m) continue;
    const rest = t.slice(m[0].length).replace(/^[\s:.-]+/, '').trim();
    // Only a prefix, never the whole thing: "Finals" alone is not two teams.
    if (rest) return { stage: name.replace('$1', m[1] ?? ''), rest };
  }
  return { stage: '', rest: t };
}

/**
 * "Semifinals - Kansas RS vs Emory GH", matching how the archive titles rounds.
 *
 * A round whose stage nobody recorded says so rather than quietly dropping the
 * field, so every policy round reads the same way in a list and a reader can
 * tell "we do not know" from "this was a prelim".
 */
function titleFor(round: string, teams: string, fallback: string): string {
  const source = teams.trim() || fallback.replace(/^[^:]*:\s*/, '');
  const { stage, rest } = splitStage(source);
  const named = round.trim() ? canonicalStage(round) : stage;
  const who = rest || source;
  if (!who) return named || 'Round UNK';
  return `${named || 'Round UNK'} - ${who}`;
}

async function main() {
  const chunk = await api('loadPageChunk', {
    pageId: PAGE, limit: 50, cursor: { stack: [] }, chunkNumber: 0, verticalColumns: false,
  });

  const pageBlock: any = Object.values(chunk.recordMap.block)[0];
  const block = pageBlock.value?.value ?? pageBlock.value;
  const spaceId: string = block.space_id;
  const collectionId: string = block.collection_id;
  const viewId: string = Object.keys(chunk.recordMap.collection_view ?? {})[0];

  const collectionRecord: any = Object.values(chunk.recordMap.collection)[0];
  const schema = (collectionRecord.value?.value ?? collectionRecord.value).schema;
  const key: Record<string, string> = {};
  for (const [k, v] of Object.entries<any>(schema)) key[v.name] = k;

  const query = await api('queryCollection?src=initial_load', {
    source: { type: 'collection', id: collectionId, spaceId },
    collectionView: { id: viewId, spaceId },
    loader: {
      type: 'reducer',
      reducers: { collection_group_results: { type: 'results', limit: 5000 } },
      searchQuery: '',
      userTimeZone: 'America/New_York',
    },
  });

  const ids: string[] = query.result.reducerResults.collection_group_results.blockIds;
  const blocks = query.recordMap.block;

  const rounds: PolicyRound[] = [];
  let noLink = 0;
  for (const rowId of ids) {
    const row = blocks[rowId]?.value?.value ?? blocks[rowId]?.value;
    if (!row?.properties) continue;
    const get = (name: string) => flat(row.properties[key[name]]);

    const link = get('YouTube URL');
    const id = link ? youtubeId(link) : null;
    if (!id) { noLink += 1; continue; }

    const teams = get('Teams');
    const round = get('Round');
    const duration = Number(get('Duration (seconds)'));

    rounds.push({
      objectID: id,
      title: titleFor(round, teams, get('Title')),
      link,
      teams,
      tournament: get('Tournament'),
      year: get('Year'),
      round,
      durationS: Number.isFinite(duration) && duration > 0 ? Math.round(duration) : null,
    });
  }

  // The id is what every slug, every media key and every index record hangs
  // off, so a duplicate would mean two rounds sharing one audio file.
  const seen = new Map<string, string>();
  for (const r of rounds) {
    const prior = seen.get(r.objectID);
    if (prior) throw new Error(`two rows share video ${r.objectID}: "${prior}" and "${r.title}"`);
    seen.set(r.objectID, r.title);
  }

  rounds.sort((a, b) => a.title.localeCompare(b.title));
  writeFileSync(OUT, `${JSON.stringify(rounds, null, 2)}\n`);
  console.log(`${rounds.length} rounds with a video, ${noLink} row(s) without one`);
  console.log(`wrote ${OUT}`);
}

main().catch(err => { console.error(err); process.exit(1); });
