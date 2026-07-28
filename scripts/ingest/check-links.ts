/**
 * Probes the share link each round was submitted with.
 *
 * These rounds were never in the archive folder the matcher searched: their
 * recordings live behind the share URL on the record, and the filename inside
 * that URL names the round exactly. A range GET rather than a HEAD, because
 * Dropbox answers HEAD with a content-type that describes its own web page.
 */
import 'dotenv/config';
import { readFileSync, writeFileSync } from 'fs';

interface Entry { objectID: string; title: string; slug: string; link: string; year?: string; tournament?: string }

const manifest: Entry[] = JSON.parse(readFileSync('scripts/ingest/manifest.json', 'utf8'));
const audit = JSON.parse(readFileSync('scripts/ingest/match-audit.json', 'utf8'));
const targets = audit.wrong
  .map((w: any) => manifest.find(m => m.slug === w.slug))
  .filter(Boolean) as Entry[];

/** The direct-download form; the share page is HTML and streams nothing. */
export function directUrl(url: string): string {
  if (url.includes('/scl/fi/')) {
    const u = new URL(url);
    u.hostname = 'dl.dropboxusercontent.com';
    u.searchParams.set('dl', '1');
    return u.toString();
  }
  return url
    .replace('www.dropbox.com', 'dl.dropboxusercontent.com')
    .replace('dl.dropbox.com', 'dl.dropboxusercontent.com')
    .split('?')[0];
}

function filenameOf(url: string): string {
  try {
    const path = new URL(url).pathname;
    return decodeURIComponent(path.split('/').pop() ?? '');
  } catch {
    return '';
  }
}

async function main() {
  const out: any[] = [];
  for (const e of targets) {
    const url = directUrl(e.link);
    let status = 0, type = '', len = '';
    try {
      const res = await fetch(url, { headers: { Range: 'bytes=0-1023' } });
      status = res.status;
      type = res.headers.get('content-type') ?? '';
      len = res.headers.get('content-range')?.split('/')[1] ?? res.headers.get('content-length') ?? '';
    } catch (err) {
      type = `error: ${(err as Error).message}`;
    }
    const alive = (status === 206 || status === 200) && !type.includes('text/html');
    const mb = len ? (Number(len) / 1e6).toFixed(0) : '?';
    console.log(`${alive ? 'ok  ' : 'DEAD'} ${String(status).padEnd(4)} ${mb.padStart(4)}MB  ${e.title}`);
    console.log(`         ${filenameOf(e.link)}`);
    out.push({ slug: e.slug, title: e.title, url, alive, status, type, bytes: Number(len) || 0,
               filename: filenameOf(e.link) });
  }
  const alive = out.filter(o => o.alive).length;
  console.log(`\n${alive} of ${out.length} share links serve media`);
  writeFileSync('scripts/ingest/relink.json', JSON.stringify(out, null, 2));
}

main().catch(err => { console.error(err); process.exit(1); });
