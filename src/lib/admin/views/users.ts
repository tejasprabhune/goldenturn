/**
 * Users: every account, searchable, with what each has done; session and
 * sign-in health underneath; and one account in full (`#users/<id>`).
 *
 * The list is sorted and paged by the server, since it can outgrow one
 * response. One account's page is the account endpoint (with its sessions
 * and refused sign-ins), plus its submissions, edits and events, each asked
 * for by the account's id.
 */

import * as api from '../api';
import * as store from '../store';
import {
  h, clear, batch, group, figures, pairs, mark, statusMark, num, ago, full, date, when, errorBlock,
  loading, button, table, choices, confirm, link, debounce, roundHref, slugWords, capital,
} from '../ui';
import { describe } from './telemetry';
import type { View } from '../view';

type Sort = 'created' | 'seen' | 'rep' | 'name';
type Filter = 'all' | 'admin' | 'prep';
const PAGE = 100;

let sort: Sort = 'seen';
let filter: Filter = 'all';
let query = '';


export function roleMarks(u: Pick<api.AdminUser, 'is_admin' | 'prep_access' | 'has_password'>): HTMLElement {
  return h('span.adm-inline', null,
    u.is_admin ? mark('Admin', 'ok') : null,
    u.prep_access ? mark('Prep', 'none') : null,
    u.has_password ? null : mark('No password', 'bad', 'This account has no password set'),
  );
}

const SORT_OF: Record<string, Sort> = { name: 'name', created: 'created', seen: 'seen', rep: 'rep' };

const REASON: Record<string, string> = {
  wrong_password: 'Wrong password',
  no_account: 'No such account',
  reserved_address: 'Sign-up with an admin address',
  no_password: 'Claim of a passwordless admin address',
};

function userColumns(): Array<import('../ui').Column<api.AdminUser>> {
  return [
    { key: 'name', label: 'Name', sort: u => u.display_name,
      cell: u => h('a.adm-link', { href: `#users/${u.id}` }, u.display_name) },
    { key: 'email', label: 'Email', cell: u => h('span.adm-email', null, u.email) },
    { key: 'created', label: 'Joined', num: true, sort: u => u.created_at, cell: u => when(u.created_at, date) },
    { key: 'seen', label: 'Last seen', num: true, sort: u => u.last_seen_at ?? 0, cell: u => u.last_seen_at ? when(u.last_seen_at, () => ago(u.last_seen_at)) : h('span.adm-quiet', null, 'never') },
    { key: 'rep', label: 'Rep', num: true, sort: u => u.rep, cell: u => num(u.rep) },
    { key: 'proposals', label: 'Edits', num: true, cell: u => u.proposals ? `${num(u.proposals_accepted)} / ${num(u.proposals)}` : '' },
    { key: 'submissions', label: 'Subs', num: true, wide: true, cell: u => u.submissions ? num(u.submissions) : '' },
    { key: 'favorites', label: 'Saved', num: true, wide: true, cell: u => u.favorites ? num(u.favorites) : '' },
    { key: 'notes', label: 'Notes', num: true, wide: true, cell: u => u.notes ? num(u.notes) : '' },
    { key: 'ratings', label: 'Ratings', num: true, wide: true, cell: u => u.ratings ? num(u.ratings) : '' },
    { key: 'sessions', label: 'Sessions', num: true, wide: true, cell: u => u.sessions_active ? num(u.sessions_active) : '' },
    { key: 'role', label: 'Access', cell: roleMarks },
  ];
}

async function drawList(body: HTMLElement, tools: HTMLElement) {
  clear(tools, button('Refresh', () => { store.forget('sessions', 'auth'); void drawList(body, tools); }));

  const figs = h('div.adm-panel', null, loading());
  const listBox = h('div.adm-group', null, loading());
  const sessBox = h('div', null, loading());
  const authBox = h('div', null, loading());
  const search = h('input.adm-field.adm-search', {
    type: 'search', placeholder: 'Search name or email', 'aria-label': 'Search users', value: query,
  });
  const filters = choices<Filter>([['all', 'All'], ['admin', 'Admins'], ['prep', 'Prep access']], filter,
    f => { filter = f; void load(0); });

  clear(body,
    figs,
    h('div.adm-panel', null, h('div.adm-toolbar', null, search, filters), listBox),
    batch('Recent sessions', 'The 50 most recently used', sessBox),
    h('div', { id: 'sign-ins' }, batch('Failed sign-ins', 'Last 30 days', authBox)),
  );

  let rows: api.AdminUser[] = [];
  let total = 0;

  async function load(offset: number) {
    if (!offset) clear(listBox, loading());
    try {
      const res = await api.listUsers({
        q: query.trim() || undefined, admin: filter === 'admin', prep: filter === 'prep',
        sort, limit: PAGE, offset,
      });
      rows = offset ? [...rows, ...res.users] : res.users;
      total = res.total;
      draw();
    } catch (e) {
      clear(listBox, errorBlock(e, () => void load(0)));
    }
  }

  function draw() {
    clear(listBox,
      h('p.adm-count', null, `${num(total)} ${total === 1 ? 'account' : 'accounts'}${rows.length < total ? `, ${num(rows.length)} shown` : ''}`),
      table<api.AdminUser>({
        rows,
        columns: userColumns(),
        sortKey: sort,
        sortDir: sort === 'name' ? 'asc' : 'desc',
        // The server sorts each of these one way only: newest, most recent,
        // highest, or A to Z.
        onSort: key => { if (SORT_OF[key]) { sort = SORT_OF[key]; void load(0); } },
        onOpen: u => { location.hash = `#users/${u.id}`; },
        empty: 'No accounts match.',
      }),
      rows.length < total ? h('button.adm-more', { type: 'button', onclick: () => void load(rows.length) },
        `Show ${num(Math.min(PAGE, total - rows.length))} more of ${num(total - rows.length)}`) : null,
    );
  }

  search.addEventListener('input', debounce(() => { query = search.value; void load(0); }, 300));
  void load(0);

  store.sessions().then(s => {
    clear(figs, figures([
      ['Active sessions', num(s.active)],
      ['Signed-in accounts', num(s.active_users)],
      ['Seen in 24 h', h('span', null, num(s.seen.h24), h('span.adm-context', null, ` / ${num(s.seen.d7)} / ${num(s.seen.d30)}`)), 'Accounts seen in the last day / 7 days / 30 days'],
      ['Sign-ins in 24 h', h('span', null, num(s.signins.h24), h('span.adm-context', null, ` / ${num(s.signins.d7)} / ${num(s.signins.d30)}`)), 'Sessions started in the last day / 7 days / 30 days'],
      ['Expired sessions', num(s.expired)],
    ]), h('p.adm-quiet.adm-note', null, 'Seen and sign-ins read: last day / 7 days / 30 days.'));
    clear(sessBox, table({
      rows: s.recent,
      page: 15,
      columns: [
        { key: 'who', label: 'Account', cell: r => link(`#users/${r.user_id}`, r.display_name) },
        { key: 'email', label: 'Email', wide: true, cell: r => h('span.adm-email', null, r.email) },
        { key: 'created', label: 'Signed in', num: true, sort: r => r.created_at, cell: r => when(r.created_at) },
        { key: 'seen', label: 'Last used', num: true, sort: r => r.last_seen_at ?? 0, cell: r => when(r.last_seen_at, () => ago(r.last_seen_at)) },
        { key: 'expires', label: 'Expires', num: true, wide: true, sort: r => r.expires_at, cell: r => when(r.expires_at, date) },
      ],
      empty: 'No active sessions.',
    }));
  }).catch(e => { clear(figs, errorBlock(e)); clear(sessBox, errorBlock(e)); });

  store.authFailures().then(a => {
    clear(authBox,
      h('div.adm-pair', null,
        group(`By address, ${num(a.total)} in all`, table({
          rows: a.by_email,
          page: 10,
          sortKey: 'n',
          sortDir: 'desc',
          columns: [
            { key: 'email', label: 'Email', sort: r => r.email, cell: r => h('span.adm-email', null, r.email) },
            { key: 'n', label: 'Attempts', num: true, sort: r => r.n, cell: r => r.n >= 5 ? h('span.adm-bad', null, num(r.n)) : num(r.n) },
            { key: 'last', label: 'Last', num: true, sort: r => r.last_at, cell: r => when(r.last_at, () => ago(r.last_at)) },
            { key: 'known', label: 'Account', cell: r => r.known ? 'exists' : h('span.adm-quiet', null, 'none') },
          ],
          empty: 'No failed sign-ins.',
        })),
        group('Latest', table({
          rows: a.failures,
          page: 10,
          columns: [
            { key: 'at', label: 'When', cell: r => when(r.created_at), class: 'adm-nowrap' },
            { key: 'email', label: 'Email', cell: r => r.user_id ? link(`#users/${r.user_id}`, r.email) : h('span.adm-email', null, r.email) },
            { key: 'reason', label: 'Reason', cell: r => REASON[r.reason] ?? r.reason },
          ],
          empty: 'None.',
        })),
      ),
    );
  }).catch(e => clear(authBox, errorBlock(e)));

  if (location.hash === '#users/sign-ins') {
    requestAnimationFrame(() => setTimeout(() => document.getElementById('sign-ins')?.scrollIntoView({ block: 'start' }), 300));
  }
}

export function prepButton(
  u: { id: string; display_name: string; email: string; prep_access: boolean }, after: () => void, short = false,
): HTMLButtonElement {
  const granting = !u.prep_access;
  const label = granting ? 'Grant prep access' : 'Revoke prep access';
  return button(short ? label.split(' ')[0] : label, () => void confirm({
    title: granting ? 'Grant prep access?' : 'Revoke prep access?',
    body: [
      granting
        ? `${u.display_name} (${u.email}) will be able to open the private prep page and search the prep index from their next request.`
        : `${u.display_name} (${u.email}) will no longer be able to open the prep page. A search key already issued to them stays valid until it expires, at most four hours.`,
    ],
    action: granting ? 'Grant' : 'Revoke',
    danger: !granting,
    run: async () => {
      const r = granting ? await api.grantPrep({ userId: u.id }) : await api.revokePrep({ userId: u.id });
      store.forget('prep');
      return r.user.prep_access ? `${r.user.display_name} now has prep access.` : `${r.user.display_name} no longer has prep access.`;
    },
  }).then(changed => { if (changed) after(); }), granting ? '' : 'danger');
}

async function drawDetail(body: HTMLElement, tools: HTMLElement, id: string) {
  const reload = () => void drawDetail(body, tools, id);
  clear(tools, h('a.adm-link', { href: '#users' }, 'All users'), button('Refresh', reload));
  clear(body, loading());

  let detail: api.UserDetail;
  try {
    detail = await api.getUser(id);
  } catch (e) {
    if (e instanceof api.Refused && e.status === 404) {
      clear(body, h('p.adm-empty', null, 'No account has that id.'), link('#users', 'All users'));
    } else {
      clear(body, errorBlock(e, reload));
    }
    return;
  }
  const user = detail.user;

  const subsBox = h('div', null, loading());
  const editsBox = h('div', null, loading());
  const evBody = h('tbody');
  const evMore = h('button.adm-more', { type: 'button' }, 'Older activity');

  clear(body,
    h('div.adm-detail-head', null,
      h('h2', null, user.display_name),
      roleMarks(user),
      h('p.adm-quiet', null, user.email),
      h('div.adm-actions', null, prepButton(user, reload)),
    ),
    batch('Account', `Joined ${ago(user.created_at)}`, pairs([
      ['Email', user.email],
      ['Joined', full(user.created_at)],
      ['Last seen', user.last_seen_at ? `${full(user.last_seen_at)} (${ago(user.last_seen_at)})` : 'never'],
      ['Reputation', num(user.rep)],
      ['Password', user.has_password ? 'set' : h('span.adm-bad', null, 'not set: the account cannot be signed in to safely')],
      ['Admin', user.is_admin ? 'yes' : 'no'],
      ['Prep access', user.prep_access ? 'granted' : user.is_admin ? 'not granted, but admins always have it' : 'no'],
      ['Active sessions', num(user.sessions_active)],
      ['Id', h('code', null, user.id)],
    ])),
    batch('Contributions', 'All time', figures([
      ['Edits accepted', h('span', null, num(user.proposals_accepted), h('span.adm-context', null, ` / ${num(user.proposals)}`))],
      ['Submissions', num(user.submissions)],
      ['Saved rounds', num(user.favorites)],
      ['Notes', num(user.notes)],
      ['Ratings', num(user.ratings)],
      ['Tags', num(user.tags)],
    ])),
    batch('Submissions', 'Rounds this account submitted', subsBox),
    batch('Edits', 'Proposals that have been settled, newest first', editsBox),
    batch('Activity', 'Events, newest first', h('div.adm-group', null,
      h('div.adm-table-wrap', null, h('table.adm-table', null,
        h('thead', null, h('tr', null, ['When', 'Kind', 'Detail', 'Round'].map(t => h('th', null, t)))), evBody)),
      evMore)),
    batch('Sessions', 'The 50 most recent, expired ones included', table({
      rows: detail.sessions,
      columns: [
        { key: 'created', label: 'Signed in', cell: r => when(r.created_at) },
        { key: 'seen', label: 'Last used', cell: r => when(r.last_seen_at, () => ago(r.last_seen_at)) },
        { key: 'expires', label: 'Expires', cell: r => when(r.expires_at, date) },
        { key: 'state', label: 'State', cell: r => r.active ? mark('Active', 'ok') : mark('Expired', 'none') },
      ],
      empty: 'This account has never signed in.',
    })),
    batch('Failed sign-ins', 'The 20 most recent, against the account or its address', table({
      rows: detail.auth_failures,
      columns: [
        { key: 'at', label: 'When', cell: r => when(r.created_at) },
        { key: 'reason', label: 'Reason', cell: r => REASON[r.reason] ?? capital(r.reason) },
      ],
      empty: 'None.',
    })),
  );

  // Activity, paged back with `before`.
  let oldest = 0;
  const more = async () => {
    evMore.disabled = true;
    try {
      const { events } = await api.events({ user: user.id, limit: 50, before: oldest || undefined });
      for (const e of events) {
        oldest = oldest ? Math.min(oldest, e.id) : e.id;
        evBody.append(h('tr', null,
          h('td.adm-nowrap', null, when(e.created_at)),
          h('td.adm-nowrap', null, e.kind),
          h('td', null, describe(e)),
          h('td', null, e.slug ? link(roundHref(e.slug), slugWords(e.slug)) : '')));
      }
      if (!events.length && !evBody.childElementCount) {
        evBody.append(h('tr', null, h('td', { colspan: 4 }, h('span.adm-quiet', null, 'No recorded activity.'))));
      }
      evMore.hidden = events.length < 50;
    } catch (e) {
      evBody.append(h('tr', null, h('td', { colspan: 4 }, errorBlock(e))));
      evMore.hidden = true;
    } finally {
      evMore.disabled = false;
    }
  };
  evMore.addEventListener('click', () => void more());
  void more();

  if (user.submissions) {
    api.listSubmissions({ user: user.id, limit: 200, records: false }).then(res => {
      clear(subsBox, table<api.AdminSubmission>({
        rows: res.submissions,
        columns: [
          { key: 'title', label: 'Round', cell: s => link(`#submissions/${s.object_id}`, s.title) },
          { key: 'stage', label: 'Stage', cell: s => statusMark(s.review === 'removed' ? 'removed' : s.progress.status) },
          { key: 'at', label: 'Submitted', num: true, cell: s => when(s.created_at, date) },
        ],
        empty: 'None.',
      }), res.total > res.submissions.length ? h('p.adm-quiet.adm-note', null,
        `The newest ${num(res.submissions.length)} of ${num(res.total)}.`) : null);
    }).catch(e => clear(subsBox, errorBlock(e)));
  } else {
    clear(subsBox, h('p.adm-empty', null, 'None.'));
  }

  if (user.proposals) {
    api.proposalHistory({ user: user.id, limit: 50 }).then(res => {
      clear(editsBox, table<api.ResolvedProposal>({
        rows: res.proposals,
        columns: [
          { key: 'at', label: 'Proposed', cell: p => when(p.created_at), class: 'adm-nowrap' },
          { key: 'round', label: 'Round', cell: p => link(`#proposals/${p.slug}`, slugWords(p.slug)) },
          { key: 'kind', label: 'Kind', cell: p => `${p.kind === 'boundary' ? 'Timing' : 'Transcript'}, ${p.anchor}` },
          { key: 'status', label: 'Outcome', cell: p => mark(capital(p.status), p.status === 'accepted' ? 'ok' : p.status === 'rejected' ? 'bad' : 'none') },
        ],
        empty: user.proposals > user.proposals_accepted ? 'None settled yet; the rest are open.' : 'None settled yet.',
      }), res.total > res.proposals.length ? h('p.adm-quiet.adm-note', null,
        `The newest ${num(res.proposals.length)} of ${num(res.total)}.`) : null);
    }).catch(e => clear(editsBox, errorBlock(e)));
  } else {
    clear(editsBox, h('p.adm-empty', null, 'None.'));
  }
}

export const users: View = {
  show(body, tools, arg) {
    if (arg && arg !== 'sign-ins') {
      body.dataset.mode = `detail:${arg}`;
      void drawDetail(body, tools, arg);
      return;
    }
    if (body.dataset.mode !== 'list' || arg) {
      body.dataset.mode = 'list';
      void drawList(body, tools);
    }
  },
};
