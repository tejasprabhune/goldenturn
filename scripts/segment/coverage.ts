/**
 * How much of the audible speech in a round the transcript actually contains.
 *
 * A transcript can look complete and be missing half a round: whisper emits
 * nothing where it hears nothing it can parse, and very fast delivery is
 * exactly where that happens. Comparing the segments against the waveform
 * answers the question the transcript cannot answer about itself.
 *
 *   npx tsx scripts/segment/coverage.ts <slug> [slug...]
 */
import 'dotenv/config';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';

const c = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.CLOUDFLARE_S3_KEY!,
    secretAccessKey: process.env.CLOUDFLARE_S3_SECRET!,
  },
});

/**
 * Where to draw the line between speech and room tone, for this recording.
 *
 * A fixed level does not survive contact with an archive recorded over thirty
 * years on whatever equipment was to hand: the same threshold called one round
 * 52% transcribed and another 87%, mostly because one was quieter. Half the
 * loudest bucket is a threshold each recording sets for itself.
 */
function loudEnough(peaks: number[]): number {
  const sorted = [...peaks].sort((a, b) => a - b);
  const top = sorted[Math.floor(sorted.length * 0.95)] ?? 255;
  return Math.max(8, top * 0.35);
}

const fmt = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

async function get(key: string) {
  const b = await c.send(new GetObjectCommand({ Bucket: 'goldenturn-media', Key: key }));
  return JSON.parse(await b.Body!.transformToString());
}

async function report(slug: string) {
  const [tx, pk] = await Promise.all([get(`transcripts/${slug}.json`), get(`peaks/${slug}.json`)]);
  const per = pk.duration / pk.buckets;

  const covered = new Uint8Array(pk.buckets);
  for (const s of tx.segments ?? []) {
    const from = Math.max(0, Math.floor(s.start / per));
    const to = Math.min(pk.buckets - 1, Math.floor(s.end / per));
    for (let i = from; i <= to; i++) covered[i] = 1;
  }

  const LOUD = loudEnough(pk.peaks);
  let loud = 0, loudCovered = 0;
  for (let i = 0; i < pk.buckets; i++) {
    if (pk.peaks[i] < LOUD) continue;
    loud++;
    if (covered[i]) loudCovered++;
  }

  const words = (tx.segments ?? [])
    .reduce((a: number, s: any) => a + s.text.trim().split(/\s+/).filter(Boolean).length, 0);
  const transcribedMin = Math.max(loudCovered * per / 60, 1);

  console.log(slug);
  console.log(`  audible ${Math.round(loud * per / 60)}m, transcribed ${Math.round(loudCovered * per / 60)}m`
    + ` -> ${Math.round(loudCovered / Math.max(loud, 1) * 100)}% covered`);
  console.log(`  ${words} words, ${Math.round(words / transcribedMin)} wpm over what was transcribed`);

  // Where the round is plainly audible and the transcript says nothing. These
  // spans are the whole question: either that audio is not speech, or the
  // transcription dropped it.
  const spans: Array<[number, number]> = [];
  let open: number | null = null;
  for (let i = 0; i < pk.buckets; i++) {
    const missing = pk.peaks[i] >= LOUD && !covered[i];
    if (missing && open === null) open = i;
    if (!missing && open !== null) { spans.push([open * per, i * per]); open = null; }
  }
  if (open !== null) spans.push([open * per, pk.duration]);

  const big = spans.filter(([a, b]) => b - a >= 60).sort((a, b) => (b[1] - b[0]) - (a[1] - a[0]));
  console.log(`  ${big.length} loud stretches over a minute with nothing transcribed:`);
  for (const [a, b] of big.slice(0, 10)) {
    console.log(`    ${fmt(a)}-${fmt(b)}  ${Math.round((b - a) / 6) / 10}m`);
  }
}

for (const slug of process.argv.slice(2)) await report(slug);
