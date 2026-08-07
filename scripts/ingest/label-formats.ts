/**
 * Gives every round a format and a level.
 *
 * The archive was one thing for long enough that neither needed saying: every
 * round in it was college parli. Policy rounds and high school rounds make
 * both a question a reader has to be able to answer before anything else, so
 * they become fields rather than something inferred from a tournament name.
 *
 * Idempotent by design. It only writes to records that are missing a label, so
 * it can be run after any ingest to catch whatever arrived without one, and
 * running it twice costs nothing.
 */
import 'dotenv/config';
import { algoliasearch } from 'algoliasearch';

const INDEX = process.env.PUBLIC_ALGOLIA_INDEX_NAME ?? 'all_rounds';

/** What the archive was before it had anything else in it. */
const DEFAULT_FORMAT = 'parli';
const DEFAULT_LEVEL = 'college';

async function main() {
  const client = algoliasearch(
    process.env.PUBLIC_ALGOLIA_APP_ID!,
    process.env.ALGOLIA_ADMIN_KEY!,
  );

  // A filter on an attribute Algolia does not facet is silently ignored, which
  // would show every round while claiming to have narrowed them.
  const settings = await client.getSettings({ indexName: INDEX });
  const faceting = new Set(settings.attributesForFaceting ?? []);
  const before = faceting.size;
  faceting.add('format');
  faceting.add('level');
  if (faceting.size !== before) {
    await client.setSettings({
      indexName: INDEX,
      indexSettings: { ...settings, attributesForFaceting: [...faceting] },
    });
    console.log(`faceting now: ${[...faceting].join(', ')}`);
  } else {
    console.log('faceting already set');
  }

  const all: Array<Record<string, unknown>> = [];
  let page = 0;
  while (true) {
    const res = await client.searchSingleIndex({
      indexName: INDEX,
      searchParams: { query: '', hitsPerPage: 1000, page },
    });
    all.push(...(res.hits as Array<Record<string, unknown>>));
    if (page >= (res.nbPages ?? 1) - 1) break;
    page += 1;
  }
  console.log(`${all.length} rounds in the index`);

  const unlabelled = all.filter(h => !h.format || !h.level);
  if (unlabelled.length === 0) {
    console.log('every round already carries a format and a level');
    return;
  }

  const updates = unlabelled.map(h => ({
    objectID: h.objectID as string,
    format: (h.format as string) ?? DEFAULT_FORMAT,
    level: (h.level as string) ?? DEFAULT_LEVEL,
  }));

  await client.partialUpdateObjects({ indexName: INDEX, objects: updates });
  console.log(`labelled ${updates.length} round(s) as ${DEFAULT_FORMAT}/${DEFAULT_LEVEL}`);
}

main().catch(err => { console.error(err); process.exit(1); });
