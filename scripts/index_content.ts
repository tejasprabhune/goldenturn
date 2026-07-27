import 'dotenv/config';
import fg from 'fast-glob';
import matter from 'gray-matter';
import { readFileSync } from 'fs';
import { algoliasearch } from 'algoliasearch';

const APP_ID = process.env.PUBLIC_ALGOLIA_APP_ID!;
const ADMIN_KEY = process.env.ALGOLIA_ADMIN_KEY!;
const INDEX_NAME = 'goldenturn_content';

const client = algoliasearch(APP_ID, ADMIN_KEY);

type RecordType = 'curriculum' | 'lecture';

interface ContentRecord {
  objectID: string;
  type: RecordType;
  title: string;
  url: string;
  description?: string;
  section?: string;
  tags?: string[];
}

/**
 * Only the sections that are live on the site are indexed. The k, files and
 * playbooks collections still exist on disk but have no routes, so anything
 * indexed from them would be a search result that 404s.
 */
const LIVE_GLOBS = ['src/content/curriculum/**/*.{md,mdx,typ}', 'src/content/lectures/**/*.{md,mdx}'];

function stripMarkdown(raw: string): string {
  return raw
    .replace(/^---[\s\S]*?---/, '')
    .replace(/[#*_`\[\]()]/g, '')
    .trim()
    .slice(0, 200);
}

/** Typst frontmatter is a `#metadata((...))<frontmatter>` block, not YAML. */
function parseTypst(raw: string): { data: Record<string, unknown>; body: string } {
  const block = raw.match(/#metadata\(\(([\s\S]*?)\)\)\s*<frontmatter>/);
  const data: Record<string, unknown> = {};
  if (block) {
    const str = /(\w+)\s*:\s*"([^"]*)"/g;
    for (const m of block[1].matchAll(str)) data[m[1]] = m[2];
    const bool = /(\w+)\s*:\s*(true|false)\b/g;
    for (const m of block[1].matchAll(bool)) data[m[1]] = m[2] === 'true';
  }

  const body = raw
    .slice(block ? block.index! + block[0].length : 0)
    .replace(/```[\s\S]*?```/g, '')
    .split('\n')
    .filter(line => {
      const t = line.trim();
      return t && !t.startsWith('#') && !t.startsWith('=') && !t.startsWith(')');
    })
    .join(' ')
    .replace(/[*_`@\[\]]/g, '')
    .replace(/---/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return { data, body };
}

function cleanPath(filePath: string): string {
  return filePath
    .replace(/^src\/content\//, '')
    .replace(/\/index\.(mdx?|typ)$/, '')
    .replace(/\.(mdx?|typ)$/, '');
}

async function buildRecords(): Promise<ContentRecord[]> {
  const files = await fg(LIVE_GLOBS, { cwd: process.cwd() });
  const records: ContentRecord[] = [];

  for (const filePath of files) {
    // Typst partials such as _setup.typ carry no frontmatter and no route.
    if (/(^|\/)_/.test(filePath.replace(/^src\/content\//, ''))) continue;

    const raw = readFileSync(filePath, 'utf-8');
    const isTypst = filePath.endsWith('.typ');
    const { data, description } = isTypst
      ? (() => {
          const parsed = parseTypst(raw);
          return { data: parsed.data, description: parsed.body.slice(0, 200) };
        })()
      : (() => {
          const parsed = matter(raw);
          return { data: parsed.data as Record<string, unknown>, description: stripMarkdown(parsed.content) };
        })();

    if (data.draft === true) continue;
    if (!data.title) {
      console.warn(`Skipping ${filePath}: no title in frontmatter`);
      continue;
    }

    const stem = cleanPath(filePath);
    records.push({
      objectID: stem.replace(/\//g, '-'),
      type: filePath.startsWith('src/content/lectures/') ? 'lecture' : 'curriculum',
      title: String(data.title),
      url: '/' + stem,
      description,
      section: data.section ? String(data.section) : undefined,
      tags: [],
    });
  }

  return records;
}

async function main() {
  const records = await buildRecords();
  if (records.length === 0) throw new Error('Refusing to empty the index: no records were built');

  console.log(`Indexing ${records.length} records to ${INDEX_NAME}...`);
  for (const r of records) console.log(`  ${r.type}  ${r.url}`);

  // replaceAllObjects, not saveObjects: pages that were removed from the site
  // have to disappear from search rather than linger as 404 results.
  await client.replaceAllObjects({ indexName: INDEX_NAME, objects: records });

  await client.setSettings({
    indexName: INDEX_NAME,
    indexSettings: {
      searchableAttributes: ['title', 'description', 'tags'],
      attributesForFaceting: ['type', 'section'],
      customRanking: ['desc(type)'],
    },
  });

  console.log('Done.');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
