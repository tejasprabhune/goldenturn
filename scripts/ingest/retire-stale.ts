/**
 * Moves the transcripts and speech fits made from the wrong recording aside.
 *
 * Those rounds now carry the right audio, but the transcript and the timings in
 * R2 under the same slug were produced from the recording they were wrongly
 * matched to. The transcript component fetches them by slug directly rather
 * than through the index, so leaving them in place would put the words of one
 * debate under the audio of another, which is the failure this whole exercise
 * was meant to end.
 *
 * They are copied to a `stale/` prefix rather than deleted: they are somebody's
 * round, correctly transcribed, just filed under the wrong name.
 */
import 'dotenv/config';
import { readFileSync } from 'fs';
import {
  S3Client, CopyObjectCommand, DeleteObjectCommand, HeadObjectCommand,
  GetObjectCommand, PutObjectCommand,
} from '@aws-sdk/client-s3';

const BUCKET = 'goldenturn-media';

async function exists(client: S3Client, key: string) {
  try { await client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key })); return true; }
  catch { return false; }
}

async function main() {
  const slugs: string[] = JSON.parse(readFileSync('scripts/ingest/relinked.json', 'utf8'));
  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.CLOUDFLARE_S3_KEY!,
      secretAccessKey: process.env.CLOUDFLARE_S3_SECRET!,
    },
  });

  let moved = 0;
  for (const slug of slugs) {
    for (const prefix of ['transcripts', 'speeches']) {
      const key = `${prefix}/${slug}.json`;
      if (!await exists(client, key)) continue;
      await client.send(new CopyObjectCommand({
        Bucket: BUCKET, Key: `stale/${key}`, CopySource: `${BUCKET}/${key}`,
      }));
      await client.send(new DeleteObjectCommand({ Bucket: BUCKET, Key: key }));
      console.log(`moved ${key} -> stale/${key}`);
      moved++;
    }
  }

  // The index has to agree: these rounds are playable but not transcribed.
  const res = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'index.json' }));
  const index = JSON.parse(await res.Body!.transformToString());
  const drop = new Set(slugs);
  index.transcribed = index.transcribed.filter((s: string) => !drop.has(s));
  index.generated = new Date().toISOString();
  await client.send(new PutObjectCommand({
    Bucket: BUCKET, Key: 'index.json',
    Body: JSON.stringify(index), ContentType: 'application/json',
    CacheControl: 'public, max-age=300',
  }));

  console.log(`\nmoved ${moved} objects; transcribed now ${index.transcribed.length}`);
}

main().catch(err => { console.error(err); process.exit(1); });
