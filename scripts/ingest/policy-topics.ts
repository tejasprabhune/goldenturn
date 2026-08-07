/**
 * Works out which topic a policy round was debating, and says so.
 *
 * The source gives a tournament and a calendar year but never a season, and a
 * season cannot be inferred from a calendar year alone: a tournament in the
 * autumn of 2016 is the 2016-17 topic and one in the spring of 2016 is the
 * 2015-16 topic. Which of the two a given tournament is depends on when in the
 * year it runs, which the source never says and which changes over thirty
 * years of the circuit.
 *
 * So this does not guess from the tournament name. It reads what was actually
 * said in the round. The two candidate topics for a calendar year are always
 * wildly different from each other -- nuclear no-first-use against artificial
 * intelligence and animal rights, visas against democracy assistance -- so
 * counting which one's distinctive words turn up in the transcript settles it
 * with room to spare. Where it does not, the round is left without a topic
 * rather than given a plausible wrong one, because a resolution is the first
 * thing a reader takes on trust.
 *
 *   npx tsx scripts/ingest/policy-topics.ts [--dry] [--limit N]
 */
import 'dotenv/config';
import { readFileSync } from 'fs';
import { join } from 'path';
import { pathToFileURL } from 'url';
import { algoliasearch } from 'algoliasearch';
import { S3Client, GetObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import type { PolicyRound } from './policy-source';
import { slugFor } from './lib';

const INDEX = process.env.PUBLIC_ALGOLIA_INDEX_NAME ?? 'all_rounds';
const BUCKET = 'goldenturn-media';
const SOURCE = join('scripts', 'ingest', 'policy-rounds.json');

/**
 * The national college policy topic for each season, worded as adopted.
 *
 * 1990-91 to 2023-24 from the NDT's own list of topics; 2024-25 and 2025-26
 * from CEDA, which the NDT list does not yet carry. The season is named by the
 * autumn year, so "2016" here is the 2016-17 topic.
 */
export const TOPICS: Record<number, string> = {
  1994: 'That the United States government should substantially increase its security assistance to one or more of the following: Egypt, Israel, Jordan, Palestinian National Authority, Syria.',
  1995: 'That the United States government should substantially increase its security assistance to one or more of the following: Egypt, Israel, Jordan, Palestinian National Authority, Syria.',
  1996: 'That the United States Federal Government should increase regulations requiring industries to substantially decrease the domestic emission and/or production of environmental pollutants.',
  1997: 'The United States Federal Government should substantially increase its security assistance to one or more of the following Southeast Asian nations: Brunei, Burma (Myanmar), Cambodia, Indonesia, Laos, Malaysia, Philippines, Singapore, Thailand, Vietnam.',
  1998: 'That the United States Federal Government should amend Title VII of the Civil Rights Act of 1964, through legislation, to create additional protections against racial and/or gender discrimination.',
  1999: 'That the United States Federal Government should adopt a policy of constructive engagement, including the immediate removal of all or nearly all economic sanctions, with the government(s) of one or more of the following nation-states: Cuba, Iran, Iraq, Syria, North Korea.',
  2000: 'That the United States Federal Government should substantially increase its development assistance, including increasing government to government assistance, within the Greater Horn of Africa.',
  2001: 'That the United States Federal Government should substantially increase federal control throughout Indian Country in one or more of the following areas: child welfare, criminal justice, employment, environmental protection, gaming, resource management, taxation.',
  2002: 'That the United States Federal Government should ratify or accede to, and implement, one or more of the following: The Comprehensive Nuclear Test Ban Treaty; The Kyoto Protocol; The Rome Statute of the International Criminal Court; The Second Optional Protocol to the International Covenant on Civil and Political Rights aiming at the Abolition of the Death Penalty; The Treaty between the United States of America and the Russian Federation on Strategic Offensive Reductions.',
  2003: 'That the United States Federal Government should enact one or more of the following: withdrawal of its World Trade Organization complaint against the European Union’s restrictions on genetically modified foods; a substantial increase in its government-to-government economic and/or conflict prevention assistance to Turkey and/or Greece; full withdrawal from the North Atlantic Treaty Organization; removal of its barriers to and encouragement of substantial European Union and/or North Atlantic Treaty Organization participation in peacekeeping in Iraq and reconstruction in Iraq; removal of its tactical nuclear weapons from Europe; harmonization of its intellectual property law with the European Union in the area of human DNA sequences; rescission of all or nearly all agriculture subsidy increases in the 2002 Farm Bill.',
  2004: 'That the United States Federal Government should establish an energy policy requiring a substantial reduction in the total non-governmental consumption of fossil fuels in the United States.',
  2005: 'The United States Federal Government should substantially increase diplomatic and economic pressure on the People’s Republic of China in one or more of the following areas: trade, human rights, weapons nonproliferation, Taiwan.',
  2006: 'The United States Supreme Court should overrule one or more of the following decisions: Planned Parenthood v. Casey, 505 U.S. 833 (1992); Ex parte Quirin, 317 U.S. 1 (1942); U.S. v. Morrison, 529 U.S. 598 (2000); Milliken v. Bradley, 418 U.S. 717 (1974).',
  2007: 'That the United States Federal Government should increase its constructive engagement with the government of one or more of: Afghanistan, Iran, Lebanon, the Palestinian Authority, and Syria, and it should include offering them a security guarantee(s) and/or a substantial increase in foreign assistance.',
  2008: 'That the United States Federal Government should substantially reduce its agricultural support, at least eliminating nearly all of the domestic subsidies, for biofuels, Concentrated Animal Feeding Operations, corn, cotton, dairy, fisheries, rice, soybeans, sugar and/or wheat.',
  2009: 'The United States Federal Government should substantially reduce the size of its nuclear weapons arsenal, and/or substantially reduce and restrict the role and/or missions of its nuclear weapons arsenal.',
  2010: 'The United States Federal Government should substantially increase the number of and/or substantially expand beneficiary eligibility for its visas for one or more of the following: employment-based immigrant visas, nonimmigrant temporary worker visas, family-based visas, human trafficking-based visas.',
  2011: 'The United States Federal Government should substantially increase its democracy assistance for one or more of the following: Bahrain, Egypt, Libya, Syria, Tunisia, Yemen.',
  2012: 'The United States Federal Government should substantially reduce restrictions on and/or substantially increase financial incentives for energy production in the United States of one or more of the following: coal, crude oil, natural gas, nuclear power, solar power, wind power.',
  2013: 'The United States Federal Government should substantially increase statutory and/or judicial restrictions on the war powers authority of the President of the United States in one or more of the following areas: targeted killing; indefinite detention; offensive cyber operations; or introducing United States Armed Forces into hostilities.',
  2014: 'The United States should legalize all or nearly all of one or more of the following in the United States: marihuana, online gambling, physician-assisted suicide, prostitution, the sale of human organs.',
  2015: 'The United States should significantly reduce its military presence in one or more of the following: the Arab states of the Persian Gulf, the Greater Horn of Africa, Northeast Asia.',
  2016: 'The United States Federal Government should establish a domestic climate policy, including at least substantially increasing restrictions on private sector emissions of greenhouse gases in the United States.',
  2017: 'The United States Federal Government should establish national health insurance in the United States.',
  2018: 'The United States Federal Government should substantially increase statutory and/or judicial restrictions on the executive power of the President of the United States in one or more of the following areas: authority to conduct first-use nuclear strikes; congressionally delegated trade power; exit from congressional-executive agreements and Article II treaties; judicial deference to all or nearly all federal administrative agency interpretations of statutes and/or regulations; the bulk incidental collection of all or nearly all foreign intelligence information on United States persons without a warrant.',
  2019: 'The United States Federal Government should establish a national space policy substantially increasing its international space cooperation with the People’s Republic of China and/or the Russian Federation in one or more of the following areas: arms control of space weapons; exchange and management of space situational awareness information; joint human spaceflight for deep space exploration; planetary defense; space traffic management; space-based solar power.',
  2020: 'The United States Federal Government should reduce its alliance commitments with Japan, the Republic of Korea, North Atlantic Treaty Organization member states, and/or the Republic of the Philippines, by at least substantially limiting the conditions under which its defense pact can be activated.',
  2021: 'The United States Federal Government should substantially increase prohibitions on anticompetitive business practices by the private sector by at least expanding the scope of its core antitrust laws.',
  2022: 'The United States should vest legal rights and/or duties in one or more of the following: artificial intelligence, nature, nonhuman animal species.',
  2023: 'The United States should restrict its nuclear forces in one or more of the following ways: adopting a nuclear no-first-use policy; eliminating one or more of the legs of its nuclear triad; disarming its nuclear forces.',
  2024: 'The United States Federal Government should adopt a clean energy policy for decarbonization in the United States, including a market-based instrument.',
  2025: 'The United States Federal Government should substantially strengthen collective bargaining rights for workers in the United States.',
};

/** How a season is written for a reader, matching the parli rounds. */
export function seasonLabel(autumnYear: number): string {
  return `${autumnYear}-${String((autumnYear + 1) % 100).padStart(2, '0')}`;
}

const STOP = new Set(`the a an and or of to in on for its it is that this these those with without at
by from as be should would substantially increase increase increases increased increasing reduce
reduces reducing reduction one more following united states federal government policy all nearly
least their his her they them we you i not no than then there here which who whom what when where
about into over under between among such other others any some each both`.split(/\s+/));

/**
 * The words that tell one season's topic apart from every other season's.
 *
 * A word both topics share cannot decide between them, and the resolutions are
 * full of shared boilerplate about what the federal government should
 * substantially do. What is left is the subject matter, which is never shared.
 */
function distinctive(year: number): string[] {
  const own = terms(TOPICS[year] ?? '');
  const elsewhere = new Set<string>();
  for (const [y, text] of Object.entries(TOPICS)) {
    if (Number(y) === year) continue;
    for (const w of terms(text)) elsewhere.add(w);
  }
  const mine = [...own].filter(w => !elsewhere.has(w));
  // A topic whose every word appears in some other topic still has to be
  // scorable, so fall back to its own rarer words.
  return mine.length >= 3 ? mine : [...own];
}

function terms(text: string): Set<string> {
  return new Set(
    text.toLowerCase()
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 3 && !STOP.has(w)),
  );
}

/** How often a topic's distinctive words appear in what was said. */
function score(transcriptWords: Map<string, number>, year: number): number {
  let hits = 0;
  for (const w of distinctive(year)) hits += transcriptWords.get(w) ?? 0;
  return hits;
}

function s3(): S3Client {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.CLOUDFLARE_S3_KEY!,
      secretAccessKey: process.env.CLOUDFLARE_S3_SECRET!,
    },
  });
}

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}

async function main() {
  const dry = process.argv.includes('--dry');
  const limit = Number(arg('--limit') ?? '1000');
  const rounds = JSON.parse(readFileSync(SOURCE, 'utf-8')) as PolicyRound[];
  const client = s3();

  const transcribed = new Set<string>();
  let token: string | undefined;
  do {
    const r = await client.send(new ListObjectsV2Command({
      Bucket: BUCKET, Prefix: 'transcripts/', ContinuationToken: token,
    }));
    for (const o of r.Contents ?? []) {
      if (o.Key?.endsWith('.json')) transcribed.add(o.Key.slice('transcripts/'.length, -'.json'.length));
    }
    token = r.NextContinuationToken;
  } while (token);

  const algolia = algoliasearch(process.env.PUBLIC_ALGOLIA_APP_ID!, process.env.ALGOLIA_ADMIN_KEY!);

  const updates: Array<{ objectID: string; resolution: string; year: string }> = [];
  let noYear = 0, notTranscribed = 0, tooClose = 0;

  for (const round of rounds.slice(0, limit)) {
    const slug = slugFor(round.title, round.objectID);
    if (!transcribed.has(slug)) { notTranscribed += 1; continue; }

    const calendar = Number(round.year);
    if (!Number.isFinite(calendar) || calendar < 1990) { noYear += 1; continue; }

    // A tournament in calendar year Y is either that year's autumn, which is
    // season Y, or that year's spring, which is season Y-1.
    const candidates = [calendar - 1, calendar].filter(y => TOPICS[y]);
    if (candidates.length === 0) { noYear += 1; continue; }
    if (candidates.length === 1) {
      updates.push({ objectID: round.objectID, resolution: TOPICS[candidates[0]], year: seasonLabel(candidates[0]) });
      continue;
    }

    const body = await client.send(new GetObjectCommand({ Bucket: BUCKET, Key: `transcripts/${slug}.json` }));
    const tx = JSON.parse(await body.Body!.transformToString());
    const counts = new Map<string, number>();
    for (const seg of tx.segments ?? []) {
      for (const w of String(seg.text ?? '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').split(/\s+/)) {
        if (w.length > 3) counts.set(w, (counts.get(w) ?? 0) + 1);
      }
    }

    const scored = candidates.map(y => ({ y, n: score(counts, y) })).sort((a, b) => b.n - a.n);
    const [best, second] = scored;
    // Two topics from adjacent seasons have nothing in common, so a real match
    // wins by a mile. Anything close is a round that talked about neither, and
    // guessing between them would be inventing a fact.
    if (best.n < 8 || best.n < (second?.n ?? 0) * 2.5) { tooClose += 1; continue; }

    updates.push({ objectID: round.objectID, resolution: TOPICS[best.y], year: seasonLabel(best.y) });
    console.log(`  ${seasonLabel(best.y)}  ${String(best.n).padStart(4)} vs ${second?.n ?? 0}  ${round.title.slice(0, 50)}`);
  }

  console.log(`\n${updates.length} round(s) matched to a topic`);
  console.log(`  not transcribed yet : ${notTranscribed}`);
  console.log(`  no usable year      : ${noYear}`);
  console.log(`  too close to call   : ${tooClose}`);

  if (!updates.length || dry) {
    if (dry) console.log('\n--dry, nothing written');
    return;
  }
  await algolia.partialUpdateObjects({ indexName: INDEX, objects: updates });
  console.log(`wrote resolutions and seasons for ${updates.length} round(s)`);
}

// Only when run, never when imported. This module exports the topic table,
// which is the reason to import it, and it also writes to the index: importing
// it for the table alone once ran the whole pass and wrote for real during
// what was meant to be a dry run.
if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch(err => { console.error(err); process.exit(1); });
}
