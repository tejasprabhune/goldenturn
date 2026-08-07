/**
 * Shows what the fitter sees for one round, and what it decided.
 *
 * The fit is only as good as the diarization under it, and a confident wrong
 * fit looks the same as a confident right one from the outside. This prints
 * the speaker time, the blocks each voice holds and the resulting assignment
 * together, so which of the three went wrong is visible.
 *
 *   SLUG=... FORMAT=policy npx tsx scripts/segment/debug.ts
 */
import 'dotenv/config';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { toTurns, primarySpeakers, fitSpeeches, FORMATS } from './fit.js';

const mins = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, '0')}`;

async function main() {
  const c = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.CLOUDFLARE_S3_KEY!,
      secretAccessKey: process.env.CLOUDFLARE_S3_SECRET!,
    },
  });

  const slug = process.env.SLUG ?? process.argv[2];
  if (!slug) throw new Error('give a slug: SLUG=... or as the first argument');
  const format = FORMATS[process.env.FORMAT ?? 'parli'];
  if (!format) throw new Error(`no such format: ${process.env.FORMAT}`);

  const r = await c.send(new GetObjectCommand({ Bucket: 'goldenturn-media', Key: `transcripts/${slug}.json` }));
  const tx = JSON.parse(await r.Body!.transformToString());
  const turns = toTurns(tx.segments);
  const primaries = primarySpeakers(turns);

  const held = new Map<string, number>();
  for (const t of turns) held.set(t.speaker, (held.get(t.speaker) ?? 0) + (t.end - t.start));
  const talking = [...held.values()].reduce((a, b) => a + b, 0);

  console.log(`${slug}  ${mins(tx.duration)} long, fitting as ${format.name}`);
  console.log(`${turns.length} turns, ${mins(talking)} of labelled speech`);
  console.log('by voice: ' + [...held].sort((a, b) => b[1] - a[1])
    .map(([s, n]) => `${s.replace('SPEAKER_', 'S')} ${mins(n)}`).join('  '));
  console.log(`primaries: ${primaries.map(s => s.replace('SPEAKER_', 'S')).join(', ')}`);

  const fit = fitSpeeches(slug, tx.segments, tx.duration, format);
  console.log('\nfit:');
  for (const s of fit.speeches) {
    console.log(`  ${s.label.padEnd(4)} ` + (s.confidence > 0
      ? `${mins(s.start)}-${mins(s.end)}  ${mins(s.end - s.start)}  conf ${s.confidence}  ${s.speaker?.replace('SPEAKER_', 'S')}`
      : 'not found'));
  }
  console.log(`\nplaced ${fit.speeches.filter(s => s.confidence > 0).length}/${format.speeches.length},`
    + ` coverage ${(fit.coverage * 100).toFixed(0)}%`);
}

main().catch(e => { console.error(e); process.exit(1); });
