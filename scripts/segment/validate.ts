/**
 * Sanity-checks fitted speeches against facts the format guarantees, rather
 * than trusting the fitter's own confidence score. A fit can be confidently
 * wrong, so these assertions are deliberately independent of how it scored.
 */
import 'dotenv/config';
import { S3Client, ListObjectsV2Command, GetObjectCommand } from '@aws-sdk/client-s3';

const BUCKET = 'goldenturn-media';

/**
 * What each format guarantees, as facts rather than as scores.
 *
 * `pairs` is the strongest of them: a rebuttal has to come back to the voice
 * that gave the matching constructive. Parli has two such pairs and policy has
 * four, which is why policy is the easier format to check and the harder one
 * to fit.
 */
const SHAPES: Record<string, {
  order: string[];
  pairs: Array<[string, string]>;
  longestSpeechSeconds: number;
}> = {
  parli: {
    order: ['PMC', 'LOC', 'MG', 'MO', 'LOR', 'PMR'],
    pairs: [['PMR', 'PMC'], ['LOR', 'LOC']],
    // No parli speech runs past this even with heavy POIs.
    longestSpeechSeconds: 11 * 60,
  },
  policy: {
    order: ['1AC', '1NC', '2AC', '2NC', '1NR', '1AR', '2NR', '2AR'],
    pairs: [['1AR', '1AC'], ['2AR', '2AC'], ['1NR', '1NC'], ['2NR', '2NC']],
    // A nine minute constructive, plus the overrun the fitter tolerates.
    longestSpeechSeconds: 13 * 60,
  },
};

interface Fitted { label: string; start: number; end: number; speaker: string | null; confidence: number }

interface Fitted { label: string; start: number; end: number; speaker: string | null; confidence: number }

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
    const r = await c.send(new ListObjectsV2Command({ Bucket: BUCKET, Prefix: 'speeches/', ContinuationToken: token }));
    for (const o of r.Contents ?? []) if (o.Key?.endsWith('.json')) keys.push(o.Key);
    token = r.NextContinuationToken;
  } while (token);

  const fails = {
    outOfOrder: [] as string[],
    overlap: [] as string[],
    pairedVoice: [] as string[],
    adjacentSameVoice: [] as string[],
    tooLong: [] as string[],
    startsLate: [] as string[],
  };
  let complete = 0;

  for (const key of keys) {
    const slug = key.slice('speeches/'.length, -'.json'.length);
    const body = await c.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const fit = JSON.parse(await body.Body!.transformToString());
    // Fits written before there was a second format carry no name; those are
    // all parli, because that is all there was.
    const shape = SHAPES[fit.format ?? 'parli'] ?? SHAPES.parli;
    const found: Fitted[] = fit.speeches.filter((s: Fitted) => s.confidence > 0 && s.end > s.start);
    if (found.length === shape.order.length) complete++;
    if (found.length < 2) continue;

    // Speeches must run in format order and never overlap.
    for (let i = 1; i < found.length; i++) {
      if (found[i].start < found[i - 1].start) fails.outOfOrder.push(slug);
      if (found[i].start < found[i - 1].end - 1) fails.overlap.push(slug);
      if (found[i].speaker && found[i].speaker === found[i - 1].speaker) {
        fails.adjacentSameVoice.push(slug);
      }
    }

    // A rebuttal must return to the voice that gave the constructive.
    const by = new Map(found.map(s => [s.label, s]));
    for (const [reb, con] of shape.pairs) {
      const a = by.get(reb), b = by.get(con);
      if (a?.speaker && b?.speaker && a.speaker !== b.speaker) fails.pairedVoice.push(`${slug} (${reb})`);
    }

    for (const s of found) {
      if (s.end - s.start > shape.longestSpeechSeconds) {
        fails.tooLong.push(`${slug} ${s.label} ${((s.end - s.start) / 60).toFixed(1)}min`);
      }
    }

    const first = found.find(s => s.label === shape.order[0]);
    if (first && first.start > 20 * 60) fails.startsLate.push(`${slug} ${(first.start / 60).toFixed(1)}min`);
  }

  console.log(`validated ${keys.length} rounds | every speech placed: ${complete}\n`);
  for (const [name, list] of Object.entries(fails)) {
    const uniq = [...new Set(list)];
    console.log(`  ${name.padEnd(19)} ${uniq.length}`);
    uniq.slice(0, 4).forEach(s => console.log(`      ${s}`));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
