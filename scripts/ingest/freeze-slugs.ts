/**
 * Writes each round's current address onto the round.
 *
 * A slug used to be derived from the title every time anything needed one: the
 * page a round is built at, the key its audio is stored under in R2, the name
 * the transcript and timings are filed as. That was fine while titles never
 * changed. Titles are editable now, and a derived slug would mean correcting a
 * typo moves the page and orphans four files under the old name.
 *
 * So the slug becomes data. This writes it exactly as it is derived today, so
 * nothing moves and no link breaks; it only stops the answer changing later.
 *
 * Idempotent: it writes only to rounds that have no slug yet, so it can be run
 * again after any ingest and costs nothing when there is nothing to do.
 */
import 'dotenv/config';
import { algoliasearch } from 'algoliasearch';

const INDEX = process.env.PUBLIC_ALGOLIA_INDEX_NAME ?? 'all_rounds';

/**
 * Mirrors recordingSlug in src/lib/recordings.ts, before it prefers a stored
 * one, down to the apostrophes it does not strip.
 *
 * Only the ASCII apostrophe is removed here. A curly one falls through to the
 * separator rule and becomes a dash, so "Saint Mary’s" is "saint-mary-s" and
 * not "saint-marys". That is the address these rounds are built at and the key
 * their audio is stored under, so it is the address to write down, however it
 * reads.
 */
function derive(title: string, objectID: string): string {
  const base = (title ?? 'round')
    .toLowerCase()
    .replace(/[']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70)
    .replace(/-+$/g, '');
  return `${base}-${objectID.replace(/[^a-z0-9]/gi, '').slice(0, 6).toLowerCase()}`;
}

async function main() {
  const dryRun = process.argv.includes('--dry-run');
  const client = algoliasearch(
    process.env.PUBLIC_ALGOLIA_APP_ID!,
    process.env.ALGOLIA_ADMIN_KEY!,
  );

  const all: Array<Record<string, unknown>> = [];
  for (let page = 0; ; page++) {
    const res = await client.searchSingleIndex({
      indexName: INDEX,
      searchParams: { query: '', hitsPerPage: 1000, page, attributesToRetrieve: ['objectID', 'title', 'slug'] },
    });
    all.push(...(res.hits as Array<Record<string, unknown>>));
    if (page >= (res.nbPages ?? 1) - 1) break;
  }
  console.log(`${all.length} rounds in the index`);

  const missing = all.filter(h => !h.slug);
  if (missing.length === 0) {
    console.log('every round already carries its slug');
    return;
  }

  const updates = missing.map(h => ({
    objectID: h.objectID as string,
    slug: derive(h.title as string, h.objectID as string),
  }));

  console.log(`${updates.length} to write, for example:`);
  for (const u of updates.slice(0, 3)) console.log(`  ${u.slug}`);

  if (dryRun) {
    console.log('dry run, nothing written');
    return;
  }

  await client.partialUpdateObjects({ indexName: INDEX, objects: updates });
  console.log(`wrote ${updates.length} slug(s)`);
}

main().catch(err => { console.error(err); process.exit(1); });
