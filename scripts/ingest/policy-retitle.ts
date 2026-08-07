/**
 * Brings the index and the bucket into line after a title changes.
 *
 * A round's permalink and every one of its media keys are built from its
 * title, so correcting a title moves the round: its audio, waveform,
 * transcript and speech timings are all still filed under the old name, and
 * the page built from the new one finds nothing.
 *
 * This renames them. Copying inside the bucket rather than downloading and
 * re-uploading, because the audio is the large part and the server can move it
 * without it crossing anybody's connection. The three JSON files also carry
 * their own slug inside them, so those are rewritten rather than copied.
 *
 *   npx tsx scripts/ingest/policy-retitle.ts [--dry]
 */
import 'dotenv/config';
import { readFileSync } from 'fs';
import { join } from 'path';
import { algoliasearch } from 'algoliasearch';
import {
  S3Client, CopyObjectCommand, DeleteObjectCommand, GetObjectCommand,
  HeadObjectCommand, PutObjectCommand,
} from '@aws-sdk/client-s3';
import type { PolicyRound } from './policy-source';
import { slugFor } from './lib';

const INDEX = process.env.PUBLIC_ALGOLIA_INDEX_NAME ?? 'all_rounds';
const BUCKET = 'goldenturn-media';
const SOURCE = join('scripts', 'ingest', 'policy-rounds.json');

/** The audio is copied; the rest is rewritten because it names itself inside. */
const PARTS = [
  { prefix: 'audio', ext: 'm4a', json: false, type: 'audio/mp4' },
  { prefix: 'peaks', ext: 'json', json: true, type: 'application/json' },
  { prefix: 'transcripts', ext: 'json', json: true, type: 'application/json' },
  { prefix: 'speeches', ext: 'json', json: true, type: 'application/json' },
];

function s3(): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.CLOUDFLARE_S3_KEY!,
      secretAccessKey: process.env.CLOUDFLARE_S3_SECRET!,
    },
  });
}

async function exists(client: S3Client, key: string): Promise<boolean> {
  try {
    await client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

async function move(client: S3Client, from: string, to: string, part: typeof PARTS[number]) {
  if (part.json) {
    const body = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: from }));
    const doc = JSON.parse(await body.Body!.transformToString());
    doc.slug = to.slice(part.prefix.length + 1, -(part.ext.length + 1));
    await client.send(new PutObjectCommand({
      Bucket: BUCKET, Key: to, ContentType: part.type,
      CacheControl: 'public, max-age=31536000, immutable',
      Body: JSON.stringify(doc),
    }));
  } else {
    await client.send(new CopyObjectCommand({
      Bucket: BUCKET, Key: to, CopySource: `/${BUCKET}/${encodeURIComponent(from)}`,
      CacheControl: 'public, max-age=31536000, immutable',
      MetadataDirective: 'REPLACE', ContentType: part.type,
    }));
  }
  await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: from }));
}

async function main() {
  const dry = process.argv.includes('--dry');
  const rounds = JSON.parse(readFileSync(SOURCE, 'utf-8')) as PolicyRound[];
  const wanted = new Map(rounds.map(r => [r.objectID, r.title]));

  const algolia = algoliasearch(process.env.PUBLIC_ALGOLIA_APP_ID!, process.env.ALGOLIA_ADMIN_KEY!);

  const current: Array<{ objectID: string; title: string }> = [];
  let page = 0;
  while (true) {
    const res = await algolia.searchSingleIndex({
      indexName: INDEX,
      searchParams: { query: '', hitsPerPage: 1000, page, attributesToRetrieve: ['objectID', 'title'] },
    });
    for (const h of res.hits as Array<any>) current.push({ objectID: h.objectID, title: h.title });
    if (page >= (res.nbPages ?? 1) - 1) break;
    page += 1;
  }

  const changes = current
    .filter(h => wanted.has(h.objectID) && wanted.get(h.objectID) !== h.title)
    .map(h => ({
      objectID: h.objectID,
      from: h.title,
      to: wanted.get(h.objectID)!,
      oldSlug: slugFor(h.title, h.objectID),
      newSlug: slugFor(wanted.get(h.objectID)!, h.objectID),
    }))
    .filter(c => c.oldSlug !== c.newSlug);

  console.log(`${changes.length} round(s) need renaming`);
  if (!changes.length) return;

  const client = s3();
  let moved = 0;
  for (const c of changes) {
    const parts: string[] = [];
    for (const part of PARTS) {
      const from = `${part.prefix}/${c.oldSlug}.${part.ext}`;
      const to = `${part.prefix}/${c.newSlug}.${part.ext}`;
      if (!(await exists(client, from))) continue;
      parts.push(part.prefix);
      if (!dry) await move(client, from, to, part);
    }
    moved += parts.length;
    console.log(`  ${c.to}`);
    console.log(`    ${c.oldSlug} -> ${c.newSlug}${parts.length ? `  [${parts.join(', ')}]` : '  (no media yet)'}`);
  }

  if (dry) {
    console.log(`\n--dry, nothing moved or written (${moved} file(s) would move)`);
    return;
  }

  await algolia.partialUpdateObjects({
    indexName: INDEX,
    objects: changes.map(c => ({ objectID: c.objectID, title: c.to })),
  });
  console.log(`\nmoved ${moved} file(s) and retitled ${changes.length} round(s)`);
  console.log('next: publish-index.ts, then a deploy so the pages are built at the new addresses');
}

main().catch(err => { console.error(err); process.exit(1); });
