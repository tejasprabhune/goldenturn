/**
 * Records which rounds still have a video at the far end of their link.
 *
 * A third of the parli rounds were recorded as Dropbox mp4s and movs, and
 * about half of those links now answer 403: the link carries the file's name,
 * so renaming it in Dropbox breaks the link while leaving the file there. The
 * page needs to know which is which, and it cannot find out by asking the
 * browser to load the video, because that is a several hundred megabyte file
 * and the answer would cost every visitor the wait.
 *
 * So it is settled here, once, and written to the index the page is built
 * from. Re-run it when links go stale; nothing else has to change.
 *
 *   npx tsx scripts/ingest/video-check.ts [--dry]
 */
import 'dotenv/config';
import { algoliasearch } from 'algoliasearch';
import { directMediaUrl, mediaKind } from '../../src/lib/recordings';

const INDEX = process.env.PUBLIC_ALGOLIA_INDEX_NAME ?? 'all_rounds';

/** Dropbox answers a bare request differently from a browser's. */
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/126.0 Safari/537.36';

/** One kilobyte is enough to learn whether there is a video there. */
async function reachable(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      headers: { Range: 'bytes=0-1024', 'User-Agent': UA },
      redirect: 'follow',
      signal: AbortSignal.timeout(20000),
    });
    if (!res.ok && res.status !== 206) return false;
    const type = res.headers.get('content-type') ?? '';
    // A dead share link answers with an HTML error page, not with video.
    return type.startsWith('video/') || type === 'application/octet-stream';
  } catch {
    return false;
  }
}

async function main() {
  const dry = process.argv.includes('--dry');
  const client = algoliasearch(process.env.PUBLIC_ALGOLIA_APP_ID!, process.env.ALGOLIA_ADMIN_KEY!);

  const hits: Array<{ objectID: string; title: string; link: string; video_ok?: boolean }> = [];
  let page = 0;
  while (true) {
    const res = await client.searchSingleIndex({
      indexName: INDEX,
      searchParams: {
        query: '', hitsPerPage: 1000, page,
        attributesToRetrieve: ['objectID', 'title', 'link', 'video_ok'],
      },
    });
    hits.push(...(res.hits as any));
    if (page >= (res.nbPages ?? 1) - 1) break;
    page += 1;
  }

  const videos = hits.filter(h => mediaKind(h.link ?? '') === 'video');
  console.log(`${videos.length} round(s) linked to a video file`);

  const results: Array<{ objectID: string; video_ok: boolean }> = [];
  let live = 0;
  const size = 6;
  for (let i = 0; i < videos.length; i += size) {
    const batch = videos.slice(i, i + size);
    const checked = await Promise.all(batch.map(async h => ({
      h, ok: await reachable(directMediaUrl(h.link)),
    })));
    for (const { h, ok } of checked) {
      if (ok) live += 1;
      results.push({ objectID: h.objectID, video_ok: ok });
    }
    process.stdout.write(`  checked ${Math.min(i + size, videos.length)}/${videos.length}\r`);
  }
  console.log(`\n${live} still playable, ${videos.length - live} gone`);

  if (dry) { console.log('--dry, nothing written'); return; }
  await client.partialUpdateObjects({ indexName: INDEX, objects: results });
  console.log(`wrote video_ok for ${results.length} round(s)`);
}

main().catch(err => { console.error(err); process.exit(1); });
