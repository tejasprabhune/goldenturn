/**
 * Files every aff and neg description in lower case.
 *
 * The submit form and the admin editor both lower these now, because
 * "T-Framework", "t-framework" and "T-framework" are one argument written
 * three ways and a reader scanning a list should not have to notice which was
 * typed. The rounds catalogued before that was true still carry whatever
 * capitals their describer used.
 *
 * It lowers proper nouns too: "Deleuze" becomes "deleuze", which is the same
 * choice the rest of the site makes about its own labels. Nothing else about
 * the round is touched.
 *
 * Idempotent: it writes only where lowering would change something, so a
 * second run reports nothing to do.
 */
import 'dotenv/config';
import { algoliasearch } from 'algoliasearch';

const INDEX = process.env.PUBLIC_ALGOLIA_INDEX_NAME ?? 'all_rounds';

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
      searchParams: {
        query: '', hitsPerPage: 1000, page,
        attributesToRetrieve: ['objectID', 'title', 'aff', 'neg'],
      },
    });
    all.push(...(res.hits as Array<Record<string, unknown>>));
    if (page >= (res.nbPages ?? 1) - 1) break;
  }
  console.log(`${all.length} rounds in the index`);

  const updates: Array<Record<string, string>> = [];
  for (const hit of all) {
    const patch: Record<string, string> = { objectID: hit.objectID as string };
    let changed = false;
    for (const field of ['aff', 'neg'] as const) {
      const value = hit[field];
      if (typeof value !== 'string') continue;
      const lowered = value.trim().toLowerCase();
      if (lowered !== value) { patch[field] = lowered; changed = true; }
    }
    if (changed) updates.push(patch);
  }

  if (updates.length === 0) {
    console.log('every description is already in lower case');
    return;
  }

  console.log(`${updates.length} round(s) to lower:`);
  for (const u of updates.slice(0, 8)) {
    const was = all.find(h => h.objectID === u.objectID)!;
    for (const field of ['aff', 'neg'] as const) {
      if (u[field]) console.log(`  ${field}: ${JSON.stringify(was[field])} -> ${JSON.stringify(u[field])}`);
    }
  }
  if (updates.length > 8) console.log(`  ...and ${updates.length - 8} more`);

  if (dryRun) {
    console.log('dry run, nothing written');
    return;
  }

  await client.partialUpdateObjects({ indexName: INDEX, objects: updates });
  console.log(`lowered ${updates.length} round(s)`);
}

main().catch(err => { console.error(err); process.exit(1); });
