/**
 * Indexes the prep backfiles for the private prep search at /prep.
 *
 *   tsx scripts/prep/index_prep.ts --dir ../prep-gen/files --dry-run [--out records.json]
 *   tsx scripts/prep/index_prep.ts --dir ../prep-gen/files            (writes the index)
 *
 * One record per `###` block in the UQ, Links, IL, Impacts and Answers
 * families; Story and Freshness are context, not something a debater pulls,
 * so they are not records (the file's Freshness date rides on every record
 * instead). Files with none of those families, such as a planning list, are
 * skipped whole.
 *
 * Options:
 *   --dir <path>        the prep files (default: $PREP_DIR, else ../prep-gen/files)
 *   --manifest <path>   slug to Google Doc id (default: <dir>/manifest.json)
 *   --phrasings <path>  optional extra phrasings, objectID to strings (see extraPhrasings)
 *   --dry-run           build the records and write them to --out; touch nothing else
 *   --out <path>        where a dry run writes (default: node_modules/.cache/prep/records.json,
 *                       which git ignores: these files are private and this repo is public)
 *
 * Writing needs ALGOLIA_ADMIN_KEY and PREP_ALGOLIA_APP_ID (falling back to
 * PUBLIC_ALGOLIA_APP_ID); the index is PREP_ALGOLIA_INDEX, default "prep".
 */
import 'dotenv/config';
import fg from 'fast-glob';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { basename, dirname, join, resolve } from 'path';
import { algoliasearch } from 'algoliasearch';
import type { PrepRecord } from '../../src/lib/prep/types';
import { bodyHtml, bodyText, parseFile } from './parse';
import { SHORTHAND, alternativePhrasings, blockType, extraPhrasings, parseSide } from './phrasings';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const DRY_RUN = process.argv.includes('--dry-run');
const DIR = resolve(arg('dir') ?? process.env.PREP_DIR ?? '../prep-gen/files');
const MANIFEST = resolve(arg('manifest') ?? join(DIR, 'manifest.json'));
const PHRASINGS = arg('phrasings');
const OUT = resolve(arg('out') ?? 'node_modules/.cache/prep/records.json');
const INDEX_NAME = process.env.PREP_ALGOLIA_INDEX ?? 'prep';

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
}

function readManifest(): Record<string, string> {
  if (!existsSync(MANIFEST)) {
    console.warn(`No manifest at ${MANIFEST}; records will have no doc_url.`);
    return {};
  }
  const json = JSON.parse(readFileSync(MANIFEST, 'utf-8'));
  return (json.docs ?? json) as Record<string, string>;
}

function buildRecords(): PrepRecord[] {
  const docs = readManifest();
  const supplied = PHRASINGS ? (JSON.parse(readFileSync(PHRASINGS, 'utf-8')) as Record<string, string[]>) : null;
  const files = fg.sync('*.md', { cwd: DIR }).sort();
  const records: PrepRecord[] = [];

  for (const name of files) {
    const slug = basename(name, '.md');
    const parsed = parseFile(readFileSync(join(DIR, name), 'utf-8'));
    const blocks = parsed.blocks
      .map(b => ({ ...b, type: blockType(b.family, b.title) }))
      .filter(b => b.type !== null);

    if (blocks.length === 0) {
      console.warn(`  skip  ${name}: no blocks`);
      continue;
    }
    if (!docs[slug]) console.warn(`  note  ${name}: not in the manifest, so no Google Doc link`);

    const seen = new Map<string, number>();
    blocks.forEach((b, i) => {
      // A heading repeated within a family gets a counter, so ids stay unique
      // without depending on where the block sits.
      let id = `${slug}--${slugify(b.family)}--${slugify(b.title)}`;
      const n = (seen.get(id) ?? 0) + 1;
      seen.set(id, n);
      if (n > 1) id += `-${n}`;

      if (!b.use) console.warn(`  note  ${name}: "${b.title}" has no Use line`);
      const side = parseSide(b.title, b.use);
      const generated = alternativePhrasings({
        fileSlug: slug,
        fileTitle: parsed.title,
        family: b.family,
        type: b.type!,
        side,
        title: b.title,
        use: b.use,
      });

      records.push({
        objectID: id,
        file: parsed.title,
        file_slug: slug,
        family: b.family,
        type: b.type!,
        title: b.title,
        use: b.use,
        side,
        text: bodyText(b.body),
        html: bodyHtml(b.body),
        alternatives: [...new Set([...generated, ...extraPhrasings(id, supplied)])],
        doc_url: docs[slug] ? `https://docs.google.com/document/d/${docs[slug]}/edit` : null,
        position: i + 1,
        file_blocks: blocks.length,
        freshness: parsed.freshness,
      });
    });
    console.log(`  ${String(blocks.length).padStart(4)}  ${name}`);
  }

  return records;
}

/**
 * Search settings, applied with the records. The title and the Use line are
 * what a debater recognises a block by, so they rank first; the phrasings
 * catch shorthand; the argument text is last so a word buried in a warrant
 * never outranks a block named for it. Ties fall to reading order.
 */
const SETTINGS = {
  searchableAttributes: ['title', 'use', 'alternatives', 'family,file', 'text'],
  attributesForFaceting: ['side', 'type', 'searchable(file)', 'file_slug'],
  customRanking: ['asc(position)'],
  attributesToHighlight: ['title', 'use'],
  highlightPreTag: '<mark>',
  highlightPostTag: '</mark>',
  attributesToSnippet: [],
  typoTolerance: true,
  minWordSizefor1Typo: 4,
  minWordSizefor2Typos: 8,
  disableTypoToleranceOnWords: ['da', 'il', 'uq', 'at', 'a2', 'adv', 'aff', 'neg', 'tix', 'ptx', 'heg', 'k', 'cp'],
  ignorePlurals: ['en'],
  removeStopWords: ['en'],
  queryLanguages: ['en'],
  // Two or three typed words that match nothing together still find the block
  // that matches most of them, which beats an empty list in prep.
  removeWordsIfNoResults: 'allOptional',
  hitsPerPage: 30,
  paginationLimitedTo: 1000,
} as const;

async function main() {
  console.log(`Reading ${DIR}`);
  const records = buildRecords();
  if (records.length === 0) throw new Error('Refusing to empty the index: no records were built');

  const bySide = records.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.side]: (acc[r.side] ?? 0) + 1 }), {});
  console.log(`${records.length} records (${Object.entries(bySide).map(([k, v]) => `${k} ${v}`).join(', ')})`);

  if (DRY_RUN) {
    mkdirSync(dirname(OUT), { recursive: true });
    writeFileSync(OUT, JSON.stringify({ index: INDEX_NAME, settings: SETTINGS, synonyms: SHORTHAND, records }, null, 2));
    console.log(`Dry run: wrote ${OUT}. Nothing was sent to Algolia.`);
    return;
  }

  const appId = process.env.PREP_ALGOLIA_APP_ID ?? process.env.PUBLIC_ALGOLIA_APP_ID;
  const adminKey = process.env.ALGOLIA_ADMIN_KEY;
  if (!appId || !adminKey) throw new Error('PREP_ALGOLIA_APP_ID (or PUBLIC_ALGOLIA_APP_ID) and ALGOLIA_ADMIN_KEY are required');
  const client = algoliasearch(appId, adminKey);

  console.log(`Indexing ${records.length} records to ${INDEX_NAME}...`);
  // replaceAllObjects, as for the site's content: a block cut from a file has
  // to leave search rather than linger.
  await client.replaceAllObjects({ indexName: INDEX_NAME, objects: records as unknown as Record<string, unknown>[] });
  await client.setSettings({ indexName: INDEX_NAME, indexSettings: { ...SETTINGS } as never });
  await client.saveSynonyms({
    indexName: INDEX_NAME,
    synonymHit: SHORTHAND.map((row, i) => ({ objectID: `shorthand-${i}`, type: 'synonym', synonyms: row })),
    replaceExistingSynonyms: true,
  });
  console.log('Done.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
