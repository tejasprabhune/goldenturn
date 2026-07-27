/**
 * Stamps Cache-Control onto existing R2 objects.
 *
 * R2 custom domains do not honour zone cache rules, so edge caching depends on
 * the object carrying the header itself. Copy is server-side, so nothing is
 * downloaded or re-uploaded.
 */
import 'dotenv/config';
import { S3Client, ListObjectsV2Command, CopyObjectCommand } from '@aws-sdk/client-s3';

const BUCKET = 'goldenturn-media';
const CACHE = 'public, max-age=31536000, immutable';

const TYPES: Record<string, string> = {
  m4a: 'audio/mp4',
  json: 'application/json',
};

async function main() {
  const c = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.CLOUDFLARE_S3_KEY!,
      secretAccessKey: process.env.CLOUDFLARE_S3_SECRET!,
    },
  });

  const keys: string[] = [];
  let token: string | undefined;
  do {
    const r = await c.send(new ListObjectsV2Command({ Bucket: BUCKET, ContinuationToken: token }));
    for (const o of r.Contents ?? []) if (o.Key) keys.push(o.Key);
    token = r.NextContinuationToken;
  } while (token);

  console.log(`stamping ${keys.length} objects`);
  let done = 0, failed = 0;
  const queue = [...keys];

  await Promise.all(Array.from({ length: 12 }, async () => {
    while (queue.length) {
      const key = queue.shift()!;
      const ext = key.split('.').pop() ?? '';
      try {
        await c.send(new CopyObjectCommand({
          Bucket: BUCKET,
          Key: key,
          CopySource: `${BUCKET}/${encodeURIComponent(key)}`,
          MetadataDirective: 'REPLACE',
          CacheControl: CACHE,
          ContentType: TYPES[ext] ?? 'application/octet-stream',
        }));
        if (++done % 200 === 0) console.log(`  ${done}/${keys.length}`);
      } catch (e: any) {
        failed++;
        if (failed < 4) console.log(`  FAIL ${key}: ${e.message.slice(0, 90)}`);
      }
    }
  }));

  console.log(`done ${done}, failed ${failed}`);
}

main().catch(e => { console.error(e); process.exit(1); });
