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

/** "Semifinals" plus "Kansas RS vs Emory GH", matching how the archive titles rounds. */
function titleFor(round: string, teams: string): string {
  // Some rows repeat the stage inside the teams field.
  const cleaned = teams.replace(/^\s*[\w ]+:\s*/, '').trim();
  return round ? `${round} - ${cleaned}` : cleaned;
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
      title: titleFor(round, teams || get('Title')),
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
