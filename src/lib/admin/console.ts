/**
 * Starts the console: checks access, then shows the section the address names.
 *
 * Access is checked by asking for something only an admin may read. The answer
 * decides which of four states the page is in, and each is worded for what it
 * is: signed out, signed in without admin rights (a real 403), the server
 * failing, or the API out of reach. The old page said "Access denied" for all
 * of them, which sent the owner looking for a permissions problem when the
 * stats query had thrown (audit B6).
 */

import { getUser, signOut } from '../api';
import { Denied, SignedOut, ServerError, Unreachable } from './api';
import * as store from './store';
import { SECTIONS, DEFAULT_SECTION } from './sections';
import { describeError, h, num } from './ui';
import type { View } from './view';
import { overview } from './views/overview';
import { telemetry } from './views/telemetry';
import { rounds } from './views/rounds';
import { submissions } from './views/submissions';
import { proposals } from './views/proposals';
import { users } from './views/users';
import { prep } from './views/prep';

const VIEWS: Record<string, View> = { overview, telemetry, rounds, submissions, proposals, users, prep };

const root = document.getElementById('adm')!;
const gate = document.getElementById('adm-gate')!;
const gateText = document.getElementById('adm-gate-text')!;
const gateDetail = document.getElementById('adm-gate-detail')!;
const gateActions = document.getElementById('adm-gate-actions')!;
const banner = document.getElementById('adm-banner')!;

let ready = false;
let current: string | null = null;
let currentArg: string | null = null;

function setGate(text: string, opts: { detail?: string; actions?: HTMLElement[]; kind: string }) {
  ready = false;
  root.dataset.state = opts.kind;
  gate.hidden = false;
  gateText.textContent = text;
  gateDetail.hidden = !opts.detail;
  gateDetail.textContent = opts.detail ?? '';
  gateActions.replaceChildren(...(opts.actions ?? []));
  for (const v of document.querySelectorAll<HTMLElement>('.adm-view')) v.hidden = true;
}

function signInButton(): HTMLElement {
  return h('button.adm-button.primary', {
    type: 'button',
    onclick: () => document.dispatchEvent(new CustomEvent('gt:open-signin')),
  }, 'Sign in');
}

function retryButton(): HTMLElement {
  return h('button.adm-button', { type: 'button', onclick: () => void check() }, 'Try again');
}

function renderUser() {
  const user = getUser();
  document.getElementById('adm-user')!.textContent = user ? user.display_name : 'Signed out';
  document.getElementById('adm-signout')!.hidden = !user;
}

async function check() {
  renderUser();
  const user = getUser();
  if (!user) {
    setGate('Sign in with an administrator account to use the console.', { kind: 'signed-out', actions: [signInButton()] });
    return;
  }
  setGate('Checking access.', { kind: 'checking' });

  // Sessions is cheap and admin-only. If it fails for a reason other than
  // permission, stats is tried as well, so one broken query does not lock
  // the owner out of every section.
  let failure: unknown = null;
  for (const probe of [store.sessions, store.stats]) {
    try {
      await probe();
      failure = null;
      break;
    } catch (e) {
      if (e instanceof SignedOut || e instanceof Denied) { failure = e; break; }
      failure = failure ?? e;
    }
  }

  if (failure instanceof SignedOut) {
    renderUser();
    setGate('Your session has ended. Sign in again to use the console.', { kind: 'signed-out', actions: [signInButton()] });
    return;
  }
  if (failure instanceof Denied) {
    setGate(`Access denied. You are signed in as ${user.display_name} (${user.email}), which is not an administrator account.`,
      { kind: 'denied' });
    return;
  }
  if (failure instanceof ServerError || failure instanceof Unreachable || failure) {
    const d = describeError(failure);
    setGate(`${failure instanceof Unreachable ? 'The API could not be reached' : 'The server returned an error'} while checking access. This is not a permissions problem.`,
      { kind: 'error', detail: [d.text, d.detail].filter(Boolean).join('\n'), actions: [retryButton()] });
    return;
  }

  gate.hidden = true;
  root.dataset.state = 'ready';
  ready = true;
  current = null;
  route();
  void counts();
}

/** The small figures beside a section's name: what is waiting there. */
async function counts() {
  const set = (id: string, n: number | null, tone?: string) => {
    const el = document.querySelector<HTMLElement>(`[data-count="${id}"]`);
    if (!el) return;
    el.textContent = n ? num(n) : '';
    if (tone) el.dataset.tone = tone; else delete el.dataset.tone;
  };
  store.submissionSummary().then(s => {
    set('submissions', s.counts.failed || null, s.counts.failed ? 'bad' : undefined);
  }).catch(() => set('submissions', null));
  store.proposals().then(p => set('proposals', p.proposals.length || null)).catch(() => set('proposals', null));
}

function parseHash(): { id: string; arg: string | null } {
  const raw = decodeURIComponent(location.hash.replace(/^#/, ''));
  const [id, ...rest] = raw.split('/');
  const known = SECTIONS.some(s => s.id === id);
  return { id: known ? id : DEFAULT_SECTION, arg: known && rest.length ? rest.join('/') : null };
}

function route() {
  if (!ready) return;
  const { id, arg } = parseHash();
  const def = SECTIONS.find(s => s.id === id)!;

  for (const a of document.querySelectorAll<HTMLAnchorElement>('[data-nav]')) {
    if (a.dataset.nav === id) a.setAttribute('aria-current', 'page');
    else a.removeAttribute('aria-current');
  }
  setMenu(false);

  if (current !== id) {
    if (current) VIEWS[current]?.hide?.();
    for (const v of document.querySelectorAll<HTMLElement>('.adm-view')) v.hidden = v.dataset.view !== id;
  }
  // A new section or a new record within one starts at the top.
  if (current !== id || currentArg !== arg) window.scrollTo(0, 0);
  current = id;
  currentArg = arg;
  document.title = `${def.label} | admin | the golden turn`;

  const section = document.getElementById(`view-${id}`)!;
  const body = section.querySelector<HTMLElement>('[data-body]')!;
  const tools = section.querySelector<HTMLElement>('[data-tools]')!;
  banner.hidden = true;
  void Promise.resolve(VIEWS[id].show(body, tools, arg)).catch(e => {
    banner.hidden = false;
    banner.textContent = describeError(e).text;
  });
}

/* The phone menu. */
const side = root.querySelector<HTMLElement>('.adm-side')!;
const menu = root.querySelector<HTMLButtonElement>('.adm-side-menu')!;

function setMenu(open: boolean) {
  side.classList.toggle('open', open);
  menu.setAttribute('aria-expanded', String(open));
}

export function boot() {
  menu.addEventListener('click', () => setMenu(!side.classList.contains('open')));
  document.getElementById('adm-signout')!.addEventListener('click', () => {
    signOut();
    store.forget();
    location.reload();
  });
  window.addEventListener('hashchange', route);
  document.addEventListener('gt:signed-in', () => { store.forget(); void check(); });
  // Counts change after an action; the sidebar follows.
  store.onForget(prefixes => {
    if (ready && (!prefixes.length || prefixes.some(p => p.startsWith('submissions') || p.startsWith('proposals')))) void counts();
  });
  void check();
}
