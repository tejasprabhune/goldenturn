/**
 * Lists the Dropbox filenames relevant to a rematch, so a human can see what
 * is actually there rather than trusting a score. Read-only, and it prints
 * names only for the teams already asked about.
 */
import 'dotenv/config';
import { dropboxToken, listMedia } from './lib';

const ARCHIVE_ROOT = '/Debate Round Recordings';

async function main() {
  const token = await dropboxToken();
  const files = await listMedia(token, ARCHIVE_ROOT);
  const needles = process.argv.slice(2);
  if (!needles.length) {
    // No filter: show the folders, which say which tournaments were archived.
    const folders = new Map<string, number>();
    for (const f of files) {
      const dir = f.path.split('/').slice(0, -1).join('/');
      folders.set(dir, (folders.get(dir) ?? 0) + 1);
    }
    for (const [dir, n] of [...folders].sort()) console.log(`${String(n).padStart(4)}  ${dir}`);
    return;
  }

  for (const needle of needles) {
    const re = new RegExp(needle, 'i');
    const hits = files.filter(f => re.test(f.name));
    console.log(`\n=== /${needle}/i  ${hits.length} files`);
    for (const f of hits) console.log(`  ${f.name}`);
  }
}

main().catch(err => { console.error(err); process.exit(1); });
