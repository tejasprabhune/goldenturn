/**
 * Who may open /prep, and the search key that lets them.
 *
 * The Worker decides access. The page asks it for a prep key and reads the
 * refusal; the nav only needs a hint, so it keeps the `prep` flag that came
 * with the sign-in (see api.ts) for an hour, tied to the user it was read
 * for, and re-reads it from `GET /me` after that, since access can be granted
 * or taken away while somebody stays signed in.
 *
 * Calls go straight to fetch rather than through api.ts's call(): that treats a
 * 401 as a lost session, and `GET /prep/key` answers 403 with a `reason` for a
 * signed-out caller on purpose.
 */
import { API, getToken, getUser, readPrepFlag as readFlag, writePrepFlag as writeFlag } from '../api';
import type { PrepKey } from './types';

const FLAG_TTL_MS = 60 * 60 * 1000;
const KEY_CACHE = 'gt:prep-key';

/** What the nav believes, without asking: true only for the signed-in user it was read for. */
export function hasPrepAccess(): boolean {
  const user = getUser();
  const flag = readFlag();
  return Boolean(user && flag && flag.user === user.id && flag.prep);
}

/**
 * Re-reads the flag from `GET /me` when it is missing, an hour old, or for
 * someone else. Returns whether anything changed, so the nav can re-render.
 * A failure leaves the old hint alone; the page checks for real anyway.
 */
export async function refreshPrepFlag(force = false): Promise<boolean> {
  const user = getUser();
  const token = getToken();
  if (!user || !token) return false;
  const flag = readFlag();
  if (!force && flag && flag.user === user.id && Date.now() - flag.at < FLAG_TTL_MS) return false;
  try {
    const res = await fetch(`${API}/me`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return false;
    const body = (await res.json()) as { prep?: boolean; admin?: boolean };
    const before = hasPrepAccess();
    writeFlag(Boolean(body.prep));
    return before !== hasPrepAccess();
  } catch {
    return false;
  }
}

export type PrepRefusalReason = 'signed_out' | 'not_allowed' | 'not_configured' | 'offline' | 'error';

export class PrepRefusal extends Error {
  constructor(public reason: PrepRefusalReason, message: string) {
    super(message);
    this.name = 'PrepRefusal';
  }
}

/**
 * A key is reused until it is five minutes from expiring. It is kept in
 * sessionStorage, which ends with the tab, so a reload in the middle of prep
 * does not wait on the Worker; it never goes to localStorage.
 */
const MARGIN_S = 5 * 60;

function cachedKey(): PrepKey | null {
  try {
    const raw = sessionStorage.getItem(KEY_CACHE);
    if (!raw) return null;
    const { user, key } = JSON.parse(raw) as { user: string; key: PrepKey };
    if (user !== getUser()?.id) return null;
    return key.validUntil - MARGIN_S > Date.now() / 1000 ? key : null;
  } catch {
    return null;
  }
}

export function forgetPrepKey() {
  sessionStorage.removeItem(KEY_CACHE);
}

export async function fetchPrepKey(fresh = false): Promise<PrepKey> {
  if (!fresh) {
    const hit = cachedKey();
    if (hit) return hit;
  }
  const token = getToken();
  if (!token || !getUser()) throw new PrepRefusal('signed_out', 'sign in required');

  let res: Response;
  try {
    res = await fetch(`${API}/prep/key`, { headers: { Authorization: `Bearer ${token}` } });
  } catch {
    throw new PrepRefusal(navigator.onLine ? 'error' : 'offline', 'could not reach the server');
  }
  const body = (await res.json().catch(() => ({}))) as Partial<PrepKey> & { error?: string; reason?: string };

  if (res.ok && body.key && body.appId && body.indexName && body.validUntil) {
    writeFlag(true);
    const key = body as PrepKey;
    sessionStorage.setItem(KEY_CACHE, JSON.stringify({ user: getUser()?.id, key }));
    return key;
  }
  if (res.status === 403 && body.reason === 'not_allowed') {
    writeFlag(false);
    throw new PrepRefusal('not_allowed', body.error ?? 'this account does not have prep access');
  }
  if (res.status === 403 || res.status === 401) throw new PrepRefusal('signed_out', body.error ?? 'sign in required');
  if (res.status === 503) throw new PrepRefusal('not_configured', body.error ?? 'prep search is not configured');
  throw new PrepRefusal('error', body.error ?? `request failed (${res.status})`);
}
