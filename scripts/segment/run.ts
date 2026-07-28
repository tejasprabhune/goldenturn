/** Runs the speech fitter over every transcribed round and stores the result. */
import 'dotenv/config';
import { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { fitSpeeches, SPEECHES, type TranscriptSegment } from './fit.js';

const BUCKET = 'goldenturn-media';

function client() {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.CLOUDFLARE_S3_KEY!,
      secretAccessKey: process.env.CLOUDFLARE_S3_SECRET!,
    },
  });
}

async function main() {
  const c = client();
  const dryRun = process.env.DRY_RUN === '1';

  // SLUGS narrows the run to a few rounds; without it every transcript is
  // refitted, which is what a change to the fitter itself wants.
  const only = new Set((process.env.SLUGS ?? '').split(/[\s,]+/).filter(Boolean));

  const keys: string[] = [];
  let token: string | undefined;
  do {
    const r = await c.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: 'transcripts/', ContinuationToken: token }));
    for (const o of r.Contents ?? []) if (o.Key?.endsWith('.json')) keys.push(o.Key);
    token = r.NextContinuationToken;
  } while (token);

  if (only.size) {
    const wanted = keys.filter(k => only.has(k.slice('transcripts/'.length, -'.json'.length)));
    keys.length = 0;
    keys.push(...wanted);
  }

  console.log(`fitting ${keys.length} transcribed rounds${dryRun ? ' (dry run)' : ''}\n`);

  const stats = { full: 0, partial: 0, poor: 0, suspect: 0 };
  const rows: string[] = [];

  for (const key of keys) {
    const slug = key.slice('transcripts/'.length, -'.json'.length);
    const body = await c.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const tx = JSON.parse(await body.Body!.transformToString());
    const segments: TranscriptSegment[] = tx.segments ?? [];

    const fit = fitSpeeches(slug, segments, tx.duration ?? 0);
    const found = fit.speeches.filter(s => s.confidence > 0).length;
    const mean = fit.speeches.filter(s => s.confidence > 0)
      .reduce((a, s) => a + s.confidence, 0) / Math.max(found, 1);

    if (found === 6 && mean >= 0.6) stats.full++;
    else if (found >= 4) stats.partial++;
    else stats.poor++;
    if (fit.suspectLength) stats.suspect++;

    rows.push(`${found}/6  conf ${mean.toFixed(2)}  cov ${(fit.coverage * 100).toFixed(0)}%  ${slug.slice(0, 46)}`);

    if (!dryRun) {
      await c.send(new PutObjectCommand({
        Bucket: BUCKET, Key: `speeches/${slug}.json`,
        ContentType: 'application/json', Body: JSON.stringify(fit),
      }));
    }
  }

  rows.sort();
  rows.slice(0, 12).forEach(r => console.log('  ' + r));
  if (rows.length > 12) console.log(`  ... ${rows.length - 12} more`);
  console.log(`\nall six, confident : ${stats.full}`);
  console.log(`partial            : ${stats.partial}`);
  console.log(`poor fit           : ${stats.poor}`);
  console.log(`suspect length     : ${stats.suspect}`);
  console.log(`expected speeches  : ${SPEECHES.map(s => `${s.label} ${s.minutes}m`).join(', ')}`);
}

main().catch(e => { console.error(e); process.exit(1); });
