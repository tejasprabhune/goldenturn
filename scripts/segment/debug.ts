import 'dotenv/config';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { toTurns, primarySpeakers } from './fit.js';

async function main() {
  const c = new S3Client({ region:'auto', endpoint:`https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials:{ accessKeyId:process.env.CLOUDFLARE_S3_KEY!, secretAccessKey:process.env.CLOUDFLARE_S3_SECRET! }});
  const slug = process.env.SLUG ?? 'round-4-cal-dr-vs-oregon-gl-f97e29';
  const r = await c.send(new GetObjectCommand({ Bucket:'goldenturn-media', Key:`transcripts/${slug}.json` }));
  const tx = JSON.parse(await r.Body!.transformToString());
  const turns = toTurns(tx.segments);
  const prim = primarySpeakers(turns);
  console.log('duration', (tx.duration/60).toFixed(1), 'min | turns', turns.length, '| primaries', prim.join(','));
  for (const spk of prim) {
    const mine = turns.filter(t => t.speaker === spk);
    const blocks: any[] = [];
    for (const t of mine) {
      const last = blocks[blocks.length-1];
      if (last && t.start - last.end <= 45) last.end = Math.max(last.end, t.end);
      else blocks.push({ ...t });
    }
    const big = blocks.filter(b => b.end-b.start >= 90);
    console.log(`\n${spk}: ${mine.length} turns -> ${blocks.length} blocks, ${big.length} over 90s`);
    big.slice(0,8).forEach(b => console.log(`   ${(b.start/60).toFixed(1)}-${(b.end/60).toFixed(1)}min  len ${((b.end-b.start)/60).toFixed(1)}min`));
  }
}
main();

// second pass: trace the fit decisions
import { fitSpeeches } from './fit.js';
async function trace() {
  const c = new S3Client({ region:'auto', endpoint:`https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials:{ accessKeyId:process.env.CLOUDFLARE_S3_KEY!, secretAccessKey:process.env.CLOUDFLARE_S3_SECRET! }});
  const slug = process.env.SLUG ?? 'round-4-cal-dr-vs-oregon-gl-f97e29';
  const r = await c.send(new GetObjectCommand({ Bucket:'goldenturn-media', Key:`transcripts/${slug}.json` }));
  const tx = JSON.parse(await r.Body!.transformToString());
  const fit = fitSpeeches(slug, tx.segments, tx.duration);
  console.log('\n--- fit result ---');
  fit.speeches.forEach(s => console.log(`  ${s.label.padEnd(4)} ${(s.start/60).toFixed(1)}-${(s.end/60).toFixed(1)}min conf ${s.confidence} spk ${s.speaker}`));
}
trace();
