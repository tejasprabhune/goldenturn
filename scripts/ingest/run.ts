/** Ingest driver: runs N recordings from the manifest with bounded concurrency. */
import 'dotenv/config';
import { readFileSync } from 'fs';
import { ingestOne, type ManifestEntry } from './process.js';

const limit = Number(process.env.LIMIT ?? '2');
const concurrency = Number(process.env.CONCURRENCY ?? '2');
const offset = Number(process.env.OFFSET ?? '0');
// Work is split across parallel workers by index so each shard is disjoint.
const shard = Number(process.env.SHARD ?? '0');
const shardCount = Number(process.env.SHARD_COUNT ?? '1');

async function main() {
  const manifestPath = process.env.MANIFEST ?? 'scripts/ingest/manifest.json';
  const all: ManifestEntry[] = JSON.parse(readFileSync(manifestPath, 'utf-8'));
  const eligible = all.filter(m => m.dropbox);
  const mine = shardCount > 1 ? eligible.filter((_, i) => i % shardCount === shard) : eligible;
  const queue = mine.slice(offset, offset + limit);
  console.log(`shard ${shard}/${shardCount}: ingesting ${queue.length} of ${eligible.length}, concurrency ${concurrency}`);

  let done = 0;
  const results: any[] = [];
  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const entry = queue.shift()!;
      try {
        const r = await ingestOne(entry);
        results.push(r);
        console.log(`[${++done}] ${r.skipped ? 'skip' : 'ok'} ${entry.slug.slice(0, 55)} ${JSON.stringify(r)}`);
      } catch (e: any) {
        results.push({ slug: entry.slug, error: e.message.slice(0, 160) });
        console.log(`[${++done}] FAIL ${entry.slug.slice(0, 55)} :: ${e.message.slice(0, 160)}`);
      }
    }
  });
  await Promise.all(workers);

  const ok = results.filter(r => !r.error && !r.skipped);
  if (ok.length) {
    const avg = ok.reduce((a, r) => a + r.seconds, 0) / ok.length;
    const audio = ok.reduce((a, r) => a + r.audioMB, 0);
    const src = ok.reduce((a, r) => a + r.sourceMB, 0);
    console.log(`\nok ${ok.length} | avg ${avg.toFixed(1)}s each | ${src.toFixed(0)}MB source -> ${audio.toFixed(0)}MB audio`);
  }
  console.log(`errors: ${results.filter(r => r.error).length}`);
}

main().catch(e => { console.error(e); process.exit(1); });
