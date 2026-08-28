/**
 * Builds the ingest manifest: every recording that is live on the site, paired
 * with the Dropbox file it actually came from.
 *
 * The Algolia index is the allowlist. Rounds that are not indexed are never
 * added here, so unconsented recordings in the Dropbox tree stay untouched.
 */
import 'dotenv/config';
import { writeFileSync } from 'fs';
import { algoliasearch } from 'algoliasearch';
import {
  dropboxToken, listMedia, normalizeName, tokens, overlap, filenameFromLink,
  loadEnv, type DbxFile,
} from './lib.js';

const ARCHIVE_ROOT = '/Debate Round Recordings';
const FUZZY_THRESHOLD = 0.55;

interface ManifestEntry {
  objectID: string;
  title: string;
  slug: string;
  link: string;
  year?: string;
  tournament?: string;
  match: 'exact' | 'fuzzy' | 'external' | 'unmatched';
  score?: number;
  dropbox?: { id: string; path: string; size: number };
}

function recordingSlug(hit: { title?: string; objectID: string; slug?: string }): string {
  if (hit.slug) return hit.slug;
  const base = (hit.title ?? 'round')
    .toLowerCase().replace(/['']/g, '').replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 70).replace(/-+$/g, '');
  return `${base}-${hit.objectID.replace(/[^a-z0-9]/gi, '').slice(0, 6).toLowerCase()}`;
}

async function main() {
  const client = algoliasearch(loadEnv('PUBLIC_ALGOLIA_APP_ID'), loadEnv('PUBLIC_ALGOLIA_SEARCH_KEY'));
  const indexName = process.env.PUBLIC_ALGOLIA_INDEX_NAME ?? 'all_rounds';

  const rounds: any[] = [];
  for (let page = 0; ; page++) {
    const res = await client.searchSingleIndex({
      indexName, searchParams: { query: '', hitsPerPage: 1000, page },
    });
    rounds.push(...res.hits);
    if (page >= (res.nbPages ?? 1) - 1) break;
  }
  console.log(`indexed rounds: ${rounds.length}`);

  const token = await dropboxToken();
  const media = await listMedia(token, ARCHIVE_ROOT);
  console.log(`dropbox media files: ${media.length}`);

  const byName = new Map<string, DbxFile>();
  for (const f of media) {
    const k = normalizeName(f.name);
    if (!byName.has(k)) byName.set(k, f);
  }
  const candidates = [...byName.entries()].map(([k, f]) => ({ k, t: tokens(k), f }));

  const manifest: ManifestEntry[] = [];
  const counts = { exact: 0, fuzzy: 0, external: 0, unmatched: 0 };

  for (const hit of rounds) {
    const base: ManifestEntry = {
      objectID: hit.objectID,
      title: hit.title ?? '',
      slug: recordingSlug(hit),
      link: hit.link ?? '',
      year: hit.year,
      tournament: hit.tournament,
      match: 'unmatched',
    };

    if (!base.link.includes('dropbox.com')) {
      base.match = 'external';
      counts.external++;
      manifest.push(base);
      continue;
    }

    const key = normalizeName(filenameFromLink(base.link));
    const exact = byName.get(key);
    if (exact) {
      base.match = 'exact';
      base.score = 1;
      base.dropbox = { id: exact.id, path: exact.path, size: exact.size };
      counts.exact++;
      manifest.push(base);
      continue;
    }

    const kt = tokens(key);
    let best: { score: number; f: DbxFile } | null = null;
    for (const c of candidates) {
      const score = overlap(kt, c.t);
      if (!best || score > best.score) best = { score, f: c.f };
    }
    if (best && best.score >= FUZZY_THRESHOLD) {
      base.match = 'fuzzy';
      base.score = Number(best.score.toFixed(3));
      base.dropbox = { id: best.f.id, path: best.f.path, size: best.f.size };
      counts.fuzzy++;
    } else {
      counts.unmatched++;
    }
    manifest.push(base);
  }

  const resolved = manifest.filter(m => m.dropbox);
  const bytes = resolved.reduce((a, m) => a + (m.dropbox?.size ?? 0), 0);

  writeFileSync('scripts/ingest/manifest.json', JSON.stringify(manifest, null, 2));
  console.log('\n' + JSON.stringify(counts, null, 2));
  console.log(`resolved to media: ${resolved.length}/${manifest.length}`);
  console.log(`ingest payload: ${(bytes / 1e9).toFixed(1)} GB`);
  console.log('wrote scripts/ingest/manifest.json');

  const unmatched = manifest.filter(m => m.match === 'unmatched');
  if (unmatched.length) {
    console.log('\nunmatched (will be skipped):');
    unmatched.forEach(u => console.log(`  ${u.title.slice(0, 60)}`));
  }
}

main().catch(e => { console.error(e); process.exit(1); });
