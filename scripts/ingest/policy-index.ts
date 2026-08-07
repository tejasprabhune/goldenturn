/**
 * Puts the policy rounds into search.
 *
 * Metadata only, and deliberately first: a round with a YouTube link already
 * plays in a card, because the player falls back to the source embed for
 * anything without audio in R2. So indexing costs nothing, makes the rounds
 * findable straight away, and the audio, transcript and speech timings improve
 * them as they arrive rather than gating them.
 *
 * What it does not do is guess. The source gives a tournament and a calendar
 * year but not a season, and a tournament's season depends on whether it runs
 * in the autumn or the spring, which the source never says. Naming the wrong
 * topic is worse than naming none, so the resolution is left for the step that
 * can measure it against what was actually said in the round. Everything else
 * a round wants (the aff, the neg's strategy, the decision, tags) is left for
 * people, the same way the parli rounds were catalogued.
 *
 *   npx tsx scripts/ingest/policy-index.ts [--dry]
 */
import 'dotenv/config';
import { readFileSync } from 'fs';
import { join } from 'path';
import { algoliasearch } from 'algoliasearch';
import type { PolicyRound } from './policy-source';

const INDEX = process.env.PUBLIC_ALGOLIA_INDEX_NAME ?? 'all_rounds';
const SOURCE = join('scripts', 'ingest', 'policy-rounds.json');

/** Every round from this source is college policy; nothing else is in it. */
const FORMAT = 'policy';
const LEVEL = 'college';

export function teamsOf(round: PolicyRound): string[] {
  return round.teams
    .replace(/^\s*[\w ]+:\s*/, '')
    .split(/\s+vs\.?\s+/i)
    .map(s => s.trim())
    .filter(Boolean);
}

async function main() {
  const dry = process.argv.includes('--dry');
  const rounds = JSON.parse(readFileSync(SOURCE, 'utf-8')) as PolicyRound[];

  const client = algoliasearch(
    process.env.PUBLIC_ALGOLIA_APP_ID!,
    process.env.ALGOLIA_ADMIN_KEY!,
  );

  // Only what is not already there, so a rerun after a partial one is cheap
  // and cannot overwrite a title or a resolution somebody has since corrected.
  const existing = new Set<string>();
  let page = 0;
  while (true) {
    const res = await client.searchSingleIndex({
      indexName: INDEX,
      searchParams: { query: '', hitsPerPage: 1000, page, attributesToRetrieve: ['objectID'] },
    });
    for (const h of res.hits) existing.add(h.objectID);
    if (page >= (res.nbPages ?? 1) - 1) break;
    page += 1;
  }
  console.log(`${existing.size} rounds already indexed`);

  const fresh = rounds.filter(r => !existing.has(r.objectID));
  if (fresh.length === 0) {
    console.log('every policy round is already in the index');
    return;
  }

  const records = fresh.map(r => ({
    objectID: r.objectID,
    title: r.title,
    link: r.link,
    year: r.year || '',
    tournament: r.tournament || '',
    teams: teamsOf(r),
    format: FORMAT,
    level: LEVEL,
  }));

  console.log(`${records.length} new policy round(s) to index`);
  console.log(records.slice(0, 3).map(r => `  ${r.title} (${r.tournament} ${r.year})`).join('\n'));
  if (dry) {
    console.log('\n--dry, nothing written');
    return;
  }

  await client.saveObjects({ indexName: INDEX, objects: records });
  console.log(`indexed ${records.length} policy round(s)`);
}

main().catch(err => { console.error(err); process.exit(1); });
