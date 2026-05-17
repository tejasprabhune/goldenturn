import 'dotenv/config';
import fg from 'fast-glob';
import matter from 'gray-matter';
import { readFileSync } from 'fs';
import { algoliasearch } from 'algoliasearch';

const APP_ID = process.env.PUBLIC_ALGOLIA_APP_ID!;
const ADMIN_KEY = process.env.ALGOLIA_ADMIN_KEY!;
const INDEX_NAME = 'goldenturn_content';

const client = algoliasearch(APP_ID, ADMIN_KEY);

type RecordType = 'curriculum' | 'k' | 'file' | 'playbook';

interface ContentRecord {
  objectID: string;
  type: RecordType;
  title: string;
  url: string;
  description?: string;
  section?: string;
  tags?: string[];
  playbook?: string;
}

function stripMarkdown(raw: string): string {
  return raw
    .replace(/^---[\s\S]*?---/, '')
    .replace(/[#*_`\[\]()]/g, '')
    .trim()
    .slice(0, 200);
}

function urlFromPath(filePath: string): string {
  return '/' + filePath
    .replace(/^src\/content\//, '')
    .replace(/\/index\.mdx?$/, '')
    .replace(/\.mdx?$/, '');
}

function objectIDFromPath(filePath: string): string {
  return filePath
    .replace(/^src\/content\//, '')
    .replace(/\/index\.mdx?$/, '')
    .replace(/\.mdx?$/, '')
    .replace(/\//g, '-');
}

async function buildRecords(): Promise<ContentRecord[]> {
  const files = await fg('src/content/**/*.{md,mdx}', { cwd: process.cwd() });
  const records: ContentRecord[] = [];

  for (const filePath of files) {
    const raw = readFileSync(filePath, 'utf-8');
    const { data, content } = matter(raw);
    const description = stripMarkdown(content);
    const url = urlFromPath(filePath);
    const objectID = objectIDFromPath(filePath);

    if (filePath.startsWith('src/content/curriculum/')) {
      if (data.draft === true) continue;
      records.push({
        objectID,
        type: 'curriculum',
        title: data.title,
        url,
        description,
        section: data.section,
        tags: [],
      });
    } else if (filePath.startsWith('src/content/k/')) {
      records.push({
        objectID,
        type: 'k',
        title: data.name,
        url,
        description,
        tags: data.tags ?? [],
      });
    } else if (filePath.startsWith('src/content/files/')) {
      records.push({
        objectID,
        type: 'file',
        title: data.title,
        url,
        description,
        tags: data.tags ?? [],
        playbook: data.playbook,
      });
    } else if (filePath.startsWith('src/content/playbooks/')) {
      if (!data.title) continue;
      records.push({
        objectID,
        type: 'playbook',
        title: data.title,
        url,
        description,
      });
    }
  }

  return records;
}

async function main() {
  const records = await buildRecords();
  console.log(`Indexing ${records.length} records to ${INDEX_NAME}...`);

  await client.saveObjects({ indexName: INDEX_NAME, objects: records });

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
