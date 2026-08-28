/**
 * Runs the speech fitter over every transcribed round and stores the result.
 *
 * Which format a round is fitted as comes from the index rather than from a
 * guess about its length or its title, because the index is where the rest of
 * the site reads it: a round that says policy in search must be fitted as
 * policy, or the eight speeches a reader is offered will not be the eight the
 * player draws.
 */
import 'dotenv/config';
import { S3Client, ListObjectsV2Command, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { algoliasearch } from 'algoliasearch';
import { fitSpeeches, FORMATS, type RoundFormat, type TranscriptSegment } from './fit.js';

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

/** Mirrors recordingSlug in src/lib/recordings.ts, stored slug included. */
function slugFor(title: string, objectID: string, stored?: string): string {
  if (stored) return stored;
  const base = (title ?? 'round')
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70)
    .replace(/-+$/g, '');
  return `${base}-${objectID.replace(/[^a-z0-9]/gi, '').slice(0, 6).toLowerCase()}`;
}

/**
 * What each round is, by slug. An unlabelled round is parli, which is what
 * every round in the archive was before there was anything to label.
 */
async function formatsBySlug(): Promise<Map<string, RoundFormat>> {
  const out = new Map<string, RoundFormat>();
  const appId = process.env.PUBLIC_ALGOLIA_APP_ID;
  const key = process.env.PUBLIC_ALGOLIA_SEARCH_KEY;
  if (!appId || !key) {
    console.log('no Algolia credentials; fitting everything as parli');
    return out;
  }

  const c = algoliasearch(appId, key);
  const indexName = process.env.PUBLIC_ALGOLIA_INDEX_NAME ?? 'all_rounds';
  let page = 0;
  while (true) {
    const res = await c.searchSingleIndex({
      indexName,
      searchParams: {
        query: '', hitsPerPage: 1000, page,
        attributesToRetrieve: ['objectID', 'title', 'format', 'level'],
      },
    });
    for (const h of res.hits as Array<any>) {
      const format = h.format === 'policy'
        ? (h.level === 'hs' ? FORMATS['policy-hs'] : FORMATS.policy)
        : FORMATS.parli;
      out.set(slugFor(h.title, h.objectID, h.slug), format);
    }
    if (page >= (res.nbPages ?? 1) - 1) break;
    page += 1;
  }
  return out;
}

async function main() {
  const c = client();
  const dryRun = process.env.DRY_RUN === '1';

  // SLUGS narrows the run to a few rounds; without it every transcript is
  // refitted, which is what a change to the fitter itself wants.
  const only = new Set((process.env.SLUGS ?? '').split(/[\s,]+/).filter(Boolean));

  const bySlug = await formatsBySlug();

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
    const format = bySlug.get(slug) ?? FORMATS.parli;
    const n = format.speeches.length;

    const fit = fitSpeeches(slug, segments, tx.duration ?? 0, format);
    const found = fit.speeches.filter(s => s.confidence > 0).length;
    const mean = fit.speeches.filter(s => s.confidence > 0)
      .reduce((a, s) => a + s.confidence, 0) / Math.max(found, 1);

    if (found === n && mean >= 0.6) stats.full++;
    else if (found >= n - 2) stats.partial++;
    else stats.poor++;
    if (fit.suspectLength) stats.suspect++;

    rows.push(`${found}/${n}  conf ${mean.toFixed(2)}  cov ${(fit.coverage * 100).toFixed(0)}%  ${format.name.padEnd(9)} ${slug.slice(0, 44)}`);

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
  console.log(`\nevery speech, confident : ${stats.full}`);
  console.log(`partial                 : ${stats.partial}`);
  console.log(`poor fit                : ${stats.poor}`);
  console.log(`suspect length          : ${stats.suspect}`);
}

main().catch(e => { console.error(e); process.exit(1); });
