/**
 * Progress of the relink: which rounds carry audio that was actually replaced,
 * and whether their transcript is the new one or the one left by the wrong
 * match. The wrong objects were never deleted, only unindexed, so presence
 * alone proves nothing; the timestamp is what distinguishes them.
 */
import 'dotenv/config';
import { readFileSync } from 'fs';
import { S3Client, HeadObjectCommand } from '@aws-sdk/client-s3';

const BUCKET = 'goldenturn-media';
/** Everything written by the relink is newer than the audit that started it. */
const CUTOFF = new Date('2026-07-28T04:30:00Z');

async function main() {
  const all: string[] = JSON.parse(readFileSync('scripts/ingest/relink.json', 'utf8')).map((t: any) => t.slug);
  const client = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.CLOUDFLARE_S3_KEY!,
      secretAccessKey: process.env.CLOUDFLARE_S3_SECRET!,
    },
  });

  const when = async (k: string): Promise<Date | null> => {
    try {
      const r = await client.send(new HeadObjectCommand({ Bucket: BUCKET, Key: k }));
      return r.LastModified ?? null;
    } catch { return null; }
  };

  let fresh = 0, tx = 0, stale = 0;
  for (const slug of all) {
    const a = await when(`audio/${slug}.m4a`);
    const t = await when(`transcripts/${slug}.json`);
    const aOk = a !== null && a > CUTOFF;
    const tOk = t !== null && t > CUTOFF;
    const tStale = t !== null && !tOk;
    if (aOk) fresh++;
    if (tOk) tx++;
    if (tStale) stale++;
    console.log(`${aOk ? 'audio' : a ? 'OLD  ' : '  -  '}  ${tOk ? 'tx' : tStale ? 'TX-STALE' : '-'}`.padEnd(18) + slug);
  }
  console.log(`\naudio replaced ${fresh}/${all.length}   new transcripts ${tx}   stale transcripts still present ${stale}`);
}
main().catch(e => { console.error(e); process.exit(1); });
