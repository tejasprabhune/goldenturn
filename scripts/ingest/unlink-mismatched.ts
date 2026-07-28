/**
 * Stops the rounds identified by audit-match.ts from serving media.
 *
 * Those rounds are matched to a recording of a different debate, so their
 * audio, waveform, transcript and speech timings all describe a round nobody
 * asked for. Wrong media is worse than none: a reader has no way to tell.
 *
 * The R2 objects are left in place and only the index is rewritten, because the
 * files themselves are fine and belong to whichever round actually matches
 * them. Re-linking is a matter of putting the slug back, not re-ingesting.
 */
import 'dotenv/config';
import { readFileSync } from 'fs';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';

const BUCKET = 'goldenturn-media';

async function main() {
  const audit = JSON.parse(readFileSync('scripts/ingest/match-audit.json', 'utf8'));
  const drop = new Set<string>(audit.wrong.map((r: any) => r.slug));
  if (drop.size === 0) throw new Error('audit lists nothing to unlink; run audit-match.ts first');

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

  const before = {
    playable: index.playable.length,
    transcribed: index.transcribed.length,
  };

  index.playable = index.playable.filter((s: string) => !drop.has(s));
  index.transcribed = index.transcribed.filter((s: string) => !drop.has(s));
  // Kept so a later run can tell a deliberate exclusion from a missing file.
  index.unlinked = [...drop].sort();
  index.generated = new Date().toISOString();

  console.log(`playable   ${before.playable} -> ${index.playable.length}`);
  console.log(`transcribed ${before.transcribed} -> ${index.transcribed.length}`);
  console.log(`unlinked   ${index.unlinked.length} slugs`);

  await client.send(new PutObjectCommand({
    Bucket: BUCKET, Key: 'index.json',
    Body: JSON.stringify(index), ContentType: 'application/json',
    CacheControl: 'public, max-age=300',
  }));
  console.log('index.json updated');
}

main().catch(err => { console.error(err); process.exit(1); });
