/**
 * Publishes the list of slugs that have media in R2.
 *
 * The site build needs to know which rounds are playable without issuing 279
 * HEAD requests, so ingest leaves a single index behind.
 */
import 'dotenv/config';
import { S3Client, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import { r2 } from './lib.js';

const BUCKET = 'goldenturn-media';

async function listSlugs(client: S3Client, prefix: string, suffix: string) {
  const out = new Set<string>();
  let token: string | undefined;
  do {
    const res = await client.send(new ListObjectsV2Command({
      Bucket: BUCKET, Prefix: prefix, ContinuationToken: token,
    }));
    for (const o of res.Contents ?? []) {
      if (o.Key?.endsWith(suffix)) out.add(o.Key.slice(prefix.length, -suffix.length));
    }
    token = res.NextContinuationToken;
  } while (token);
  return out;
}

async function main() {
  const client = r2();

  const audio = await listSlugs(client, 'audio/', '.m4a');
  const peaks = await listSlugs(client, 'peaks/', '.json');
  const transcripts = await listSlugs(client, 'transcripts/', '.json');

  const playable = [...audio].filter(s => peaks.has(s)).sort();
  const index = {
    generated: new Date().toISOString(),
    playable,
    transcribed: [...transcripts].sort(),
  };

  await client.send(new PutObjectCommand({
    Bucket: BUCKET, Key: 'index.json',
    Body: JSON.stringify(index), ContentType: 'application/json',
    CacheControl: 'public, max-age=60',
  }));

  console.log(`playable: ${playable.length} | transcribed: ${index.transcribed.length}`);
  console.log('published https://media.goldenturn.org/index.json');
}

main().catch(e => { console.error(e); process.exit(1); });
