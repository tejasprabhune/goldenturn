/**
 * What kind of debate a reader wants to see.
 *
 * The archive started as one format and is now several, which makes "policy or
 * parli, college or high school" the first question anyone has about a list of
 * rounds. It is also a standing answer rather than a per-visit one, so it is
 * remembered: in the browser for a guest, and on the account for anyone signed
 * in, because a preference that does not survive opening the site on a phone
 * is not really a preference.
 */

import { getPrefs, getToken, setPrefs } from './api';

export const FORMATS = ['parli', 'policy'] as const;
export const LEVELS = ['college', 'hs'] as const;

export type Format = (typeof FORMATS)[number];
export type Level = (typeof LEVELS)[number];

export interface ViewPrefs {
  formats: string[];
  levels: string[];
}

/**
 * Parli only, because that is what the archive is: several hundred rounds
 * catalogued by hand against a few hundred policy rounds nobody asked for on
 * their way in. Both levels, because that division is a detail until someone
 * makes it a filter.
 */
export const DEFAULT_PREFS: ViewPrefs = { formats: ['parli'], levels: [...LEVELS] };

const LOCAL_KEY = 'gt:view-prefs';
const TIP_KEY = 'gt:view-prefs-tip';

export function sameAsDefault(p: ViewPrefs): boolean {
  const eq = (a: string[], b: string[]) => a.length === b.length && [...a].sort().join() === [...b].sort().join();
  return eq(p.formats, DEFAULT_PREFS.formats) && eq(p.levels, DEFAULT_PREFS.levels);
}

/** Drops anything unrecognised, and never returns an empty group. */
export function clean(raw: unknown): ViewPrefs {
  const p = (raw ?? {}) as Partial<ViewPrefs>;
  const pick = (v: unknown, allowed: readonly string[], fallback: string[]) => {
    const out = Array.isArray(v) ? v.filter(x => typeof x === 'string' && allowed.includes(x)) : [];
    return out.length ? [...new Set(out)] : [...fallback];
  };
  return {
    formats: pick(p.formats, FORMATS, DEFAULT_PREFS.formats),
    levels: pick(p.levels, LEVELS, DEFAULT_PREFS.levels),
  };
}

export function readLocal(): ViewPrefs {
  try {
    return clean(JSON.parse(localStorage.getItem(LOCAL_KEY) ?? '{}'));
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

function writeLocal(p: ViewPrefs) {
  try { localStorage.setItem(LOCAL_KEY, JSON.stringify(p)); } catch {}
}

/**
 * The account's answer if there is one, otherwise this browser's.
 *
 * Signing in on a new machine should bring the choice with it, so the stored
 * preference wins over whatever the browser happens to remember.
 */
export async function loadPrefs(): Promise<ViewPrefs> {
  const local = readLocal();
  if (!getToken()) return local;
  const res = await getPrefs().catch(() => null);
  if (!res?.prefs || (!res.prefs.formats && !res.prefs.levels)) return local;
  const remote = clean(res.prefs);
  writeLocal(remote);
  return remote;
}

/** Always to the browser, and to the account when there is one to save it to. */
export function savePrefs(p: ViewPrefs) {
  writeLocal(p);
  if (getToken()) void setPrefs({ formats: p.formats, levels: p.levels }).catch(() => {});
}

/**
 * Whether to mention that signing in would keep this.
 *
 * Once, on the first change made without an account, and never again: someone
 * who changes the filter a second time has understood the control and does not
 * need telling what it does.
 */
export function shouldOfferToRemember(): boolean {
  if (getToken()) return false;
  try {
    if (localStorage.getItem(TIP_KEY)) return false;
    localStorage.setItem(TIP_KEY, '1');
    return true;
  } catch {
    return false;
  }
}

/** The Algolia clause for a group, or nothing when it excludes nothing. */
function clause(attr: string, chosen: string[], all: readonly string[]): string | null {
  if (chosen.length === 0 || chosen.length === all.length) return null;
  return `(${chosen.map(v => `${attr}:"${v}"`).join(' OR ')})`;
}

export function prefsFilter(p: ViewPrefs): string[] {
  return [clause('format', p.formats, FORMATS), clause('level', p.levels, LEVELS)]
    .filter((c): c is string => c !== null);
}
