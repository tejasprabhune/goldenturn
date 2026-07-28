/**
 * Checks every round's title against the Dropbox filename it was matched to.
 *
 * The manifest was built with a fuzzy string match, which is fine for spelling
 * ("Mound High Swing" for "Mile High Swing") but has no idea that Cal BC and
 * Cal PZ are different teams. A match that scores well on the school names can
 * still pair a round with a recording of an entirely different debate, and
 * wrong audio is worse than none: the player, the transcript and the speech
 * timings all then describe a round nobody asked for.
 *
 * This reads only the two strings that already exist locally. It does not
 * touch Dropbox.
 */
import { readFileSync, writeFileSync } from 'fs';

interface Entry {
  objectID: string;
  title: string;
  slug: string;
  year?: string;
  tournament?: string;
  match?: string;
  score?: number;
  dropbox?: { path: string } | null;
}

const manifest: Entry[] = JSON.parse(readFileSync('scripts/ingest/manifest.json', 'utf8'));

/** School names are multi-word, so a team code is the short all-caps token. */
const CODE = /\b([A-Z]{2,3})\b/g;

function codes(s: string): string[] {
  // Drop the round label first: "Elim 3", "R2" and "Octos" are not teams.
  const body = s
    .replace(/\.[a-z0-9]+$/i, '')
    .replace(/^.*?(?:round|elim|octos?|octafinals?|quarters?|quarterfinals?|semis?|semifinals?|finals?|doubles?|double-octafinals?|debate-in|prelim)\s*\d*\s*[-–—:]?\s*/i, '')
    .replace(/\bvs?\.?\b/gi, ' ');
  return [...body.matchAll(CODE)].map(m => m[1]).filter(c => c !== 'US');
}

const rows: any[] = [];
const byFile = new Map<string, Entry[]>();

for (const e of manifest) {
  if (!e.dropbox?.path) continue;
  const file = e.dropbox.path.split('/').pop()!;
  byFile.set(file, [...(byFile.get(file) ?? []), e]);

  const titleCodes = codes(e.title);
  const fileCodes = codes(file);
  const missing = titleCodes.filter(c => !fileCodes.includes(c));
  const extra = fileCodes.filter(c => !titleCodes.includes(c));

  if (missing.length || extra.length) {
    rows.push({
      slug: e.slug, title: e.title, file,
      match: e.match, score: e.score,
      titleCodes, fileCodes, missing, extra,
    });
  }
}

const duplicates = [...byFile.entries()]
  .filter(([, list]) => list.length > 1)
  .map(([file, list]) => ({ file, rounds: list.map(e => ({ slug: e.slug, title: e.title })) }));

/**
 * Two kinds of disagreement hide in here and only one is a fault.
 *
 * Harmless: the same team with the two debaters' initials the other way round,
 * or a typo in one of them. "Rice AL" and "Rice LA" are the same pair, and the
 * tournament and round agree. These score 1.00 and share a team with the file.
 *
 * A fault: the file describes a different debate. Either the two names share no
 * team at all, or a better-matching round claims the same file, which means the
 * fuzzy matcher handed one recording to two rounds and at most one can be right.
 */
/** "AL" and "LA" are one team written two ways, so codes compare unordered. */
function norm(code: string): string {
  return [...code].sort().join('');
}

function shared(a: string[], b: string[]): boolean {
  const bn = b.map(norm);
  return a.some(c => bn.includes(norm(c)));
}

const claimants = new Map<string, Entry[]>(byFile);

function bestClaimant(file: string): Entry | null {
  const list = claimants.get(file) ?? [];
  if (list.length < 2) return null;
  const fileCodes = codes(file).map(norm);
  const scored = list
    .map(e => ({ e, n: codes(e.title).filter(c => fileCodes.includes(norm(c))).length }))
    .sort((a, b) => b.n - a.n);
  return scored[0].n > scored[1].n ? scored[0].e : null;
}

const wrong = rows.filter(r => {
  // A filename that names no team at all cannot contradict the title; those
  // were matched on the school names, which is all the file offers.
  if (r.fileCodes.length === 0) return false;
  if (!shared(r.titleCodes, r.fileCodes)) return true;
  const best = bestClaimant(r.file);
  return Boolean(best && best.slug !== r.slug);
});

const benign = rows.filter(r => !wrong.includes(r));

console.log(`\n=== ${wrong.length} matched to a recording of a different debate`);
for (const r of wrong) {
  const why = !shared(r.titleCodes, r.fileCodes) ? 'no team in common' : 'another round matches this file better';
  console.log(`  ${r.title}`);
  console.log(`      -> ${r.file}`);
  console.log(`         ${why} (${r.match} ${r.score?.toFixed(2)})`);
}

console.log(`\n=== ${benign.length} where only the debaters' initials are transposed or misspelt`);
for (const r of benign) console.log(`  ${r.title}  ->  ${r.file}`);

const withMedia = manifest.filter(e => e.dropbox?.path).length;
console.log(`${manifest.length} rounds, ${withMedia} matched to a file`);
console.log(`${rows.length} where the team codes disagree`);
console.log(`${duplicates.length} files claimed by more than one round\n`);

const byMatch: Record<string, number> = {};
for (const r of rows) byMatch[r.match ?? '?'] = (byMatch[r.match ?? '?'] ?? 0) + 1;
console.log('disagreements by match kind:', byMatch);

console.log('\n--- worst offenders (both sides name a team the other does not)');
for (const r of rows.filter(r => r.missing.length && r.extra.length).slice(0, 40)) {
  console.log(`  ${r.score?.toFixed(2)}  ${r.title}`);
  console.log(`        -> ${r.file}`);
}

console.log('\n--- one file, several rounds');
for (const d of duplicates) {
  console.log(`  ${d.file}`);
  for (const r of d.rounds) console.log(`        ${r.title}`);
}

writeFileSync(
  'scripts/ingest/match-audit.json',
  JSON.stringify({
    generated: 'audit-match.ts',
    wrong: wrong.map(r => ({ slug: r.slug, title: r.title, file: r.file, match: r.match, score: r.score })),
    benign: benign.map(r => ({ slug: r.slug, title: r.title, file: r.file })),
    duplicates,
  }, null, 2),
);
console.log('\nwrote scripts/ingest/match-audit.json');
