/**
 * Search over the prep index with the short-lived key the Worker hands out.
 *
 * The key lasts four hours. It is swapped for a new one shortly before it
 * runs out, and again whenever Algolia refuses it (an expired or revoked key
 * answers 403), with the query retried once on the new key so the person
 * typing never sees the change.
 */
import { algoliasearch } from 'algoliasearch';
import { fetchPrepKey, forgetPrepKey } from './access';
import type { PrepKey, PrepRecord, PrepSide, PrepType } from './types';

type Client = ReturnType<typeof algoliasearch>;

export interface PrepFilters {
  /**
   * Empty means both. aff or neg includes the blocks either side can read;
   * either alone means only those.
   */
  sides: Set<PrepSide>;
  /** Empty means every type. */
  types: Set<PrepType>;
  file: string | null;
}

export type PrepHit = PrepRecord & {
  _highlightResult?: Partial<Record<'title' | 'use' | 'file', { value: string }>>;
};

export interface SearchResult {
  hits: PrepHit[];
  nbHits: number;
  /** Measured round trip in the browser, not Algolia's processing time. */
  ms: number;
}

/** What the list needs to draw a row and the view needs to render a block. */
const LIST_ATTRIBUTES = [
  'file', 'file_slug', 'family', 'type', 'title', 'use', 'side', 'html',
  'doc_url', 'position', 'file_blocks', 'freshness',
];

/** Enough of every block to draw the file index and its tables of contents. */
const OVERVIEW_ATTRIBUTES = ['file', 'file_slug', 'family', 'type', 'title', 'side', 'position', 'doc_url', 'freshness'];

export function facetFilters(f: PrepFilters): string[][] {
  const out: string[][] = [];
  // One side on means that side plus the blocks either side reads; both on is
  // the same as neither.
  if (f.sides.size === 1) {
    const [side] = [...f.sides];
    out.push(side === 'either' ? ['side:either'] : [`side:${side}`, 'side:either']);
  }
  if (f.types.size) out.push([...f.types].map(t => `type:${t}`));
  if (f.file) out.push([`file_slug:${f.file}`]);
  return out;
}

function status(e: unknown): number | undefined {
  return (e as { status?: number })?.status;
}

export class PrepSearch {
  private key: PrepKey | null = null;
  private client: Client | null = null;
  private refreshing: Promise<void> | null = null;

  /** Throws PrepRefusal when the Worker says no. */
  async connect(): Promise<void> {
    this.use(await fetchPrepKey());
  }

  private use(key: PrepKey) {
    this.key = key;
    this.client = algoliasearch(key.appId, key.key);
  }

  private async refresh(): Promise<void> {
    // Several queries in flight can all see the old key fail; one fetch serves them.
    this.refreshing ??= (async () => {
      forgetPrepKey();
      this.use(await fetchPrepKey(true));
    })().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async run<T>(fn: (client: Client, indexName: string) => Promise<T>): Promise<T> {
    if (!this.key || !this.client) await this.connect();
    if (this.key!.validUntil - 5 * 60 < Date.now() / 1000) await this.refresh();
    const used = this.key;
    try {
      return await fn(this.client!, this.key!.indexName);
    } catch (e) {
      if (status(e) !== 403 && status(e) !== 401) throw e;
      // Queries sent on the old key fail together; only the first replaces it.
      if (this.key === used) await this.refresh();
      else await this.refreshing;
      return fn(this.client!, this.key!.indexName);
    }
  }

  async search(query: string, filters: PrepFilters): Promise<SearchResult> {
    return this.run(async (client, indexName) => {
      const t0 = performance.now();
      const res = await client.searchSingleIndex<PrepRecord>({
        indexName,
        searchParams: {
          query,
          hitsPerPage: 30,
          facetFilters: facetFilters(filters),
          attributesToRetrieve: LIST_ATTRIBUTES,
          attributesToHighlight: ['title', 'use', 'file'],
        },
      });
      return { hits: res.hits as PrepHit[], nbHits: res.nbHits ?? res.hits.length, ms: performance.now() - t0 };
    });
  }

  /** Every block, lightly, for the file index. One request, made once. */
  async overview(): Promise<PrepRecord[]> {
    return this.run(async (client, indexName) => {
      const res = await client.searchSingleIndex<PrepRecord>({
        indexName,
        searchParams: { query: '', hitsPerPage: 1000, attributesToRetrieve: OVERVIEW_ATTRIBUTES, attributesToHighlight: [] },
      });
      return res.hits as PrepRecord[];
    });
  }

  /** A file's blocks in reading order, ready to render. */
  async file(slug: string, filters: PrepFilters): Promise<SearchResult> {
    return this.run(async (client, indexName) => {
      const t0 = performance.now();
      const res = await client.searchSingleIndex<PrepRecord>({
        indexName,
        searchParams: {
          query: '',
          hitsPerPage: 500,
          facetFilters: facetFilters({ ...filters, file: slug }),
          attributesToRetrieve: LIST_ATTRIBUTES,
          attributesToHighlight: [],
        },
      });
      const hits = (res.hits as PrepHit[]).slice().sort((a, b) => a.position - b.position);
      return { hits, nbHits: hits.length, ms: performance.now() - t0 };
    });
  }

  /** One block by id, for a copied link. */
  async block(id: string): Promise<PrepHit | null> {
    return this.run(async (client, indexName) => {
      const res = await client.searchSingleIndex<PrepRecord>({
        indexName,
        searchParams: {
          query: '',
          hitsPerPage: 1,
          filters: `objectID:"${id.replace(/"/g, '')}"`,
          attributesToRetrieve: LIST_ATTRIBUTES,
          attributesToHighlight: [],
        },
      });
      return (res.hits[0] as PrepHit) ?? null;
    });
  }
}
