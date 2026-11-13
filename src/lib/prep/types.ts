/**
 * The shape of one prep block as the prep index holds it. Written by
 * scripts/prep/index_prep.ts and read by the prep page, so both sides import
 * it from here rather than agreeing on it by hand.
 */

export type PrepSide = 'aff' | 'neg' | 'either';

/** The block families a file is searched by. Story and Freshness are not. */
export type PrepType = 'uq' | 'link' | 'il' | 'impact' | 'answer' | 'other';

export interface PrepRecord {
  /** `<file slug>--<family>--<block title>`, so it survives blocks moving. */
  objectID: string;
  /** The file's `#` title, e.g. "Econ — Investor Confidence". */
  file: string;
  file_slug: string;
  /** The `##` heading as written: UQ, Links, IL, Impacts, Answers. */
  family: string;
  type: PrepType;
  /** The `###` heading. */
  title: string;
  /** The italic line under the heading, without its asterisks. */
  use: string;
  side: PrepSide;
  /** The argument as plain words, links reduced to their text. */
  text: string;
  /** The argument as clean HTML: nested lists as in the source, links kept. */
  html: string;
  /** Things a debater might type for this block; see alternativePhrasings. */
  alternatives: string[];
  /** The Google Doc the file was uploaded as, or null if it has none yet. */
  doc_url: string | null;
  /** 1-based place of the block among the file's blocks, in reading order. */
  position: number;
  /** How many searchable blocks the file has, so a hit can say "4 of 38". */
  file_blocks: number;
  /** The date the file's Freshness table was checked (YYYY-MM-DD), if stated. */
  freshness: string | null;
}

/** `GET /prep/key`, as the Worker API document gives it. */
export interface PrepKey {
  appId: string;
  indexName: string;
  key: string;
  /** Unix seconds. */
  validUntil: number;
}

export const TYPE_LABELS: Record<PrepType, string> = {
  uq: 'UQ',
  link: 'Link',
  il: 'IL',
  impact: 'Impact',
  answer: 'AT',
  // Shells, framework, theory and tricks: blocks outside the five families.
  other: 'Other',
};

export const SIDE_LABELS: Record<PrepSide, string> = {
  aff: 'aff',
  neg: 'neg',
  either: 'both',
};
