import 'dotenv/config';
import { readFileSync } from 'fs';
import { S3Client } from '@aws-sdk/client-s3';

export interface DbxFile {
  name: string;
  path: string;
  id: string;
  size: number;
}

/** Dropbox access tokens last 4 hours, so every run mints a fresh one. */
export async function dropboxToken(): Promise<string> {
  const key = process.env.DROPBOX_APP_KEY!;
  const secret = process.env.DROPBOX_APP_SECRET!;
  const refresh = process.env.DROPBOX_OAUTH_REFRESH_TOKEN!;
  const auth = Buffer.from(`${key}:${secret}`).toString('base64');
  const res = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST',
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh }),
  });
  const json = await res.json();
  if (!json.access_token) throw new Error(`Dropbox token refresh failed: ${JSON.stringify(json)}`);
  return json.access_token;
}

export async function dbx(token: string, endpoint: string, body: unknown): Promise<any> {
  const res = await fetch(`https://api.dropboxapi.com/2/${endpoint}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${endpoint} ${res.status}: ${JSON.stringify(json).slice(0, 200)}`);
  return json;
}

/** Walks a folder recursively and returns every media file under it. */
export async function listMedia(token: string, root: string): Promise<DbxFile[]> {
  const out: DbxFile[] = [];
  let page = await dbx(token, 'files/list_folder', { path: root, recursive: true, limit: 2000 });
  const take = (entries: any[]) => {
    for (const e of entries) {
      if (e['.tag'] !== 'file') continue;
      if (!/\.(m4a|mp3|mp4|mov|wav|aac|webm)$/i.test(e.name)) continue;
      out.push({ name: e.name, path: e.path_display, id: e.id, size: e.size ?? 0 });
    }
  };
  take(page.entries);
  while (page.has_more) {
    page = await dbx(token, 'files/list_folder/continue', { cursor: page.cursor });
    take(page.entries);
  }
  return out;
}

/**
 * The archive and the older share links disagree on school names; normalising
 * these is what takes filename matching from ~89% to ~98%.
 */
const ALIASES: Array<[RegExp, string]> = [
  [/\bberkeley\b/g, 'cal'],
  [/\butt\b/g, 'urban texas'],
  [/\bunt\b/g, 'north texas'],
];

export function normalizeName(raw: string): string {
  let t = decodeURIComponent(raw)
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  for (const [re, to] of ALIASES) t = t.replace(re, to);
  return t.replace(/\s+/g, ' ').trim();
}

export function tokens(s: string): Set<string> {
  return new Set(s.split(' ').filter(w => w.length > 2));
}

export function overlap(a: Set<string>, b: Set<string>): number {
  let hits = 0;
  a.forEach(w => { if (b.has(w)) hits++; });
  return hits / Math.max(a.size, b.size, 1);
}

export function filenameFromLink(link: string): string {
  return decodeURIComponent(link.split('?')[0].split('/').pop() ?? '');
}

/**
 * A round's permalink and media key. Mirrors recordingSlug in
 * src/lib/recordings.ts, and the two must not drift: the site looks for audio
 * at the slug it builds, so a mismatch is a round with a silent player.
 *
 * It lives here rather than beside the script that first needed it because
 * every ingest script needs it, and importing it from one that runs on import
 * starts a download nobody asked for.
 */
export function slugFor(title: string, objectID: string, stored?: string): string {
  // A round that carries its own slug keeps it, so a corrected title does not
  // send the ingest looking for audio under a name nothing is filed under.
  if (stored) return stored;
  const base = (title ?? 'round')
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 70)
    .replace(/-+$/g, '');
  return `${base}-${objectID.replace(/[^a-z0-9]/gi, '').slice(0, 6).toLowerCase()}`;
}

export function loadEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} in .env`);
  return v;
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf-8')) as T;
}

export const API = process.env.GT_API ?? 'https://goldenturn-api.tejas-prabhune.workers.dev';

/**
 * A request with a deadline. An unattended run that waits on a host that has
 * stopped answering waits until GitHub kills it six hours later, and every
 * round behind it waits with it.
 */
export function fetchWithin(url: string, init: RequestInit = {}, seconds = 30): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(seconds * 1000) });
}

/**
 * Which video host a link is on, by its host name. It used to be whether the
 * text "youtube.com" appeared anywhere in it, which any link can arrange.
 * Must match videoHost in worker/src/index.ts.
 */
export function videoHost(link: string): 'youtube' | 'vimeo' | null {
  let host: string;
  try { host = new URL(link).hostname.toLowerCase().replace(/\.$/, ''); } catch { return null; }
  const on = (domain: string) => host === domain || host.endsWith(`.${domain}`);
  if (on('youtube.com') || on('youtu.be') || on('youtube-nocookie.com')) return 'youtube';
  if (on('vimeo.com')) return 'vimeo';
  return null;
}

/**
 * The media bucket. CLOUDFLARE_S3_ENDPOINT points it somewhere else, which is
 * only for running the ingest against a stand-in; a stand-in has no bucket
 * subdomains, so the bucket goes in the path there.
 */
export function r2(): S3Client {
  const standIn = process.env.CLOUDFLARE_S3_ENDPOINT;
  return new S3Client({
    region: 'auto',
    endpoint: standIn ?? `https://${process.env.CLOUDFLARE_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    forcePathStyle: Boolean(standIn),
    credentials: {
      accessKeyId: process.env.CLOUDFLARE_S3_KEY!,
      secretAccessKey: process.env.CLOUDFLARE_S3_SECRET!,
    },
  });
}

/**
 * What a command actually said went wrong.
 *
 * The message of a failed execFile is "Command failed:" followed by the whole
 * command line, and only then whatever the tool printed. Cut to fit a note,
 * that was a yt-dlp invocation with a temp path in it and none of the error,
 * which is all an admin looking at a failed round had to go on. The tool's own
 * last words are on stderr, so those are what is kept: the ERROR lines if it
 * marks them (yt-dlp does, after any number of warnings), the tail if not.
 */
export function errorText(err: unknown): string {
  const e = err as { stderr?: string | Buffer; message?: string; cmd?: string; code?: number | string; signal?: string };
  const lines = String(e?.stderr ?? '').split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.length) {
    const marked = lines.filter(l => /^ERROR\b/i.test(l));
    return (marked.length ? marked : lines).slice(-3).join(' | ').slice(-600);
  }
  const message = String(e?.message ?? err);
  if (!message.startsWith('Command failed')) return message.slice(0, 600);
  // Nothing on stderr: say which tool, and how it ended, not how it was called.
  const tool = (e.cmd ?? message.replace(/^Command failed:\s*/, '')).split(/\s+/)[0].split('/').pop();
  return e.signal ? `${tool} was stopped (${e.signal})` : `${tool} exited with ${e.code ?? 'an error'} and said nothing`;
}

export interface IngestEvent {
  stage: 'run' | 'audio' | 'transcript' | 'speeches' | 'index' | 'page';
  state: 'started' | 'done' | 'failed' | 'skipped';
  slug?: string;
  objectID?: string;
  note?: string;
}

/**
 * Tells the API what the run is doing, so a round's page can say "being
 * transcribed" rather than "queued", and so a run that has stopped coming is
 * missed.
 *
 * The answer matters only when it is a refusal. `refused` means the token is
 * wrong, and then nothing this run did could be recorded either, so the caller
 * stops rather than doing the work again every fifteen minutes. Anything else
 * that is not a yes (an API from before this endpoint, a network fault) is
 * `unavailable`, and the run carries on: the work is the point, and the files
 * in the bucket say what was done regardless.
 */
export async function reportEvents(events: IngestEvent[]): Promise<'ok' | 'refused' | 'unavailable' | 'no-token'> {
  const token = process.env.GT_ADMIN_TOKEN;
  if (!token) return 'no-token';
  try {
    // At least one request even with nothing to say: an empty report is how
    // the token is checked before any work is started.
    for (let i = 0; i < Math.max(events.length, 1); i += 200) {
      const res = await fetchWithin(`${API}/ingest/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ events: events.slice(i, i + 200) }),
      });
      if (res.status === 401 || res.status === 403) return 'refused';
      if (!res.ok) return 'unavailable';
    }
    return 'ok';
  } catch {
    return 'unavailable';
  }
}
