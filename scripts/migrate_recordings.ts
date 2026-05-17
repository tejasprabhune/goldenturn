import { algoliasearch } from 'algoliasearch';
import * as dotenv from 'dotenv';
dotenv.config();

const client = algoliasearch(
  process.env.PUBLIC_ALGOLIA_APP_ID!,
  process.env.ALGOLIA_ADMIN_KEY!
);

const INDEX_NAME = process.env.PUBLIC_ALGOLIA_INDEX_NAME ?? 'all_rounds';

function computeAffType(tags: string[]): string {
  if (tags.some(t => t === '#k-aff')) return 'k-aff';
  if (tags.some(t => t === '#performance')) return 'performance';
  return 'topical';
}

function computeNegStrategyCount(neg: string): number | null {
  const match = neg?.match(/(\d+)-off/i);
  return match ? parseInt(match[1], 10) : null;
}

async function main() {
  console.log('Setting index settings (attributesForFaceting, searchableAttributes)...');
  await client.setSettings({
    indexName: INDEX_NAME,
    indexSettings: {
      attributesForFaceting: [
        'year',
        'tournament',
        'aff_type',
        'filterOnly(_tags)',
      ],
    },
  });
  console.log('Settings applied.');

  const allRecords: Record<string, unknown>[] = [];

  await client.browseObjects({
    indexName: INDEX_NAME,
    browse: ({ objects }) => {
      allRecords.push(...(objects as Record<string, unknown>[]));
    },
  });

  console.log(`Found ${allRecords.length} records.`);

  const toUpdate: Record<string, unknown>[] = [];

  for (const record of allRecords) {
    const tags: string[] = Array.isArray(record['_tags']) ? (record['_tags'] as string[]) : [];
    const neg: string = typeof record['neg'] === 'string' ? record['neg'] : '';

    const expectedAffType = computeAffType(tags);
    const expectedNegCount = computeNegStrategyCount(neg);

    const affTypeChanged = record['aff_type'] !== expectedAffType;
    const negCountChanged = record['neg_strategy_count'] !== expectedNegCount;

    if (affTypeChanged || negCountChanged) {
      toUpdate.push({
        objectID: record['objectID'],
        aff_type: expectedAffType,
        neg_strategy_count: expectedNegCount,
      });
    }
  }

  console.log(`Records that need updating: ${toUpdate.length}`);

  if (toUpdate.length > 0) {
    await client.partialUpdateObjects({
      indexName: INDEX_NAME,
      objects: toUpdate,
    });
    console.log(`Wrote ${toUpdate.length} records back to Algolia.`);
  } else {
    console.log('No records needed updating.');
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
