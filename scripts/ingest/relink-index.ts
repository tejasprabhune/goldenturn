/**
 * Puts the re-ingested rounds back into the media index.
 *
 * They come back as playable but not transcribed: the audio and peaks are in
 * R2 now, the transcript is a separate GPU run. Leaving them out of
 * `transcribed` is what makes the round page say so rather than hunt for a
 * file that is not there.
 */
import 'dotenv/config';
import { readFileSync } from 'fs';
import { S3Client, GetObjectCommand, PutObjectCommand, HeadObjectCommand } from '@aws-sdk/client-s3';

const BUCKET = 'goldenturn-media';

async function exists(client: S3Client, key: string): Promise<boolean> {
  try {
    await client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return true;
  } catch {
    return false;
  }
}

async function main() {
  const relinked: string[] = JSON.parse(readFileSync('scripts/ingest/relinked.json', 'utf8'));

  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.CLOUDFLARE_S3_KEY!,
      secretAccessKey: process.env.CLOUDFLARE_S3_SECRET!,
    },
  });

  const res = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'index.json' }));
  const index = JSON.parse(await res.Body!.transformToString());

  const playable = new Set<string>(index.playable);
  const transcribed = new Set<string>(index.transcribed);
  const unlinked = new Set<string>(index.unlinked ?? []);

  let added = 0;
  for (const slug of relinked) {
    // Both objects or neither: a slug in the index with no peaks renders a
    // player that never loads.
    const ok = await exists(client, `audio/${slug}.m4a`) && await exists(client, `peaks/${slug}.json`);
    if (!ok) {
      console.log(`skip ${slug}: audio or peaks missing`);
      continue;
    }
    playable.add(slug);
    unlinked.delete(slug);
    if (await exists(client, `transcripts/${slug}.json`)) transcribed.add(slug);
    added++;
  }

  index.playable = [...playable].sort();
  index.transcribed = [...transcribed].sort();
  index.unlinked = [...unlinked].sort();
  index.generated = new Date().toISOString();

  console.log(`relinked ${added}; playable ${index.playable.length}, `
    + `transcribed ${index.transcribed.length}, still unlinked ${index.unlinked.length}`);

  await client.send(new PutObjectCommand({
    Bucket: BUCKET, Key: 'index.json',
    Body: JSON.stringify(index), ContentType: 'application/json',
    CacheControl: 'public, max-age=300',
  }));
  console.log('index.json updated');
}

main().catch(err => { console.error(err); process.exit(1); });
