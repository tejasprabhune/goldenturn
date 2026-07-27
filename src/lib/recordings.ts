import { algoliasearch } from 'algoliasearch';

export interface Recording {
  objectID: string;
  title: string;
  link: string;
  resolution?: string;
  aff?: string;
  neg?: string;
  decision?: string;
  year?: string;
  tournament?: string;
  teams?: string[];
  aff_type?: string;
  neg_strategy_count?: number;
  _tags?: string[];
}

/**
 * Permalinks are built from the title plus a slice of the objectID. The
 * objectIDs Algolia generated are opaque (`ffee0400f9790_dashboard_generated_id`),
 * so the title carries the meaning and the suffix guarantees uniqueness.
 */
export function recordingSlug(hit: { title?: string; objectID: string }): string {
  const base = (hit.title ?? 'round')
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70)
    .replace(/-+$/g, '');
  const suffix = hit.objectID.replace(/[^a-z0-9]/gi, '').slice(0, 6).toLowerCase();
  return `${base}-${suffix}`;
}

export function recordingHref(hit: { title?: string; objectID: string }): string {
  return `/recordings/${recordingSlug(hit)}`;
}

/** Tags are stored with a leading '#'; strip it for display. */
export function tagLabel(tag: string): string {
  return tag.replace(/^#/, '');
}

export function mediaKind(link: string): 'youtube' | 'vimeo' | 'video' | 'audio' | 'unknown' {
  if (/(?:youtu\.be\/|youtube\.com\/)/.test(link)) return 'youtube';
  if (/vimeo\.com\//.test(link)) return 'vimeo';
  const ext = link.split('?')[0].split('.').pop()?.toLowerCase() ?? '';
  if (['mp4', 'mov', 'webm'].includes(ext)) return 'video';
  if (['mp3', 'm4a', 'wav', 'ogg', 'aac'].includes(ext)) return 'audio';
  if (link.includes('dropbox.com')) return 'audio';
  return 'unknown';
}

export function youtubeId(link: string): string | null {
  const m = link.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([\w-]{11})/);
  return m ? m[1] : null;
}

export function vimeoId(link: string): string | null {
  const m = link.match(/vimeo\.com\/(?:video\/|showcase\/\d+\/video\/)?(\d{6,11})/);
  return m ? m[1] : null;
}

/** Dropbox share links need rewriting before a media element will accept them. */
export function directMediaUrl(link: string): string {
  if (!link.includes('dropbox.com')) return link;
  if (link.includes('/scl/fi/')) return link.replace(/\bdl=0\b/, 'dl=1');
  return link
    .replace('www.dropbox.com', 'dl.dropboxusercontent.com')
    .replace('dl.dropbox.com', 'dl.dropboxusercontent.com')
    .split('?')[0];
}

/**
 * Pulls the whole index at build time so every round gets a static page.
 * Returns an empty list when Algolia credentials are absent, which keeps local
 * builds working without a .env.
 */
export async function fetchAllRecordings(): Promise<Recording[]> {
  const appId = import.meta.env.PUBLIC_ALGOLIA_APP_ID;
  const searchKey = import.meta.env.PUBLIC_ALGOLIA_SEARCH_KEY;
  const indexName = import.meta.env.PUBLIC_ALGOLIA_INDEX_NAME ?? 'all_rounds';

  if (!appId || !searchKey) {
    console.warn('[recordings] Algolia credentials missing; no recording pages built.');
    return [];
  }

  const client = algoliasearch(appId, searchKey);
  const all: Recording[] = [];
  let page = 0;

  while (true) {
    const res = await client.searchSingleIndex({
      indexName,
      searchParams: { query: '', hitsPerPage: 1000, page },
    });
    all.push(...(res.hits as unknown as Recording[]));
    if (page >= (res.nbPages ?? 1) - 1) break;
    page += 1;
  }

  return all;
}

/**
 * Slugs that have audio and peaks in R2, published by the ingest pipeline.
 * Fetched once at build time so pages know whether to render the player.
 */
export async function fetchMediaIndex(): Promise<{ playable: Set<string>; transcribed: Set<string> }> {
  try {
    const res = await fetch('https://media.goldenturn.org/index.json');
    if (!res.ok) throw new Error(String(res.status));
    const json = await res.json();
    return {
      playable: new Set<string>(json.playable ?? []),
      transcribed: new Set<string>(json.transcribed ?? []),
    };
  } catch (e) {
    console.warn('[recordings] media index unavailable; players will fall back to embeds.');
    return { playable: new Set(), transcribed: new Set() };
  }
}
