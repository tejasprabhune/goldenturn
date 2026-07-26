import 'dotenv/config';
import { readFileSync } from 'fs';

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

export function loadEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing ${name} in .env`);
  return v;
}

export function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf-8')) as T;
}
