/**
 * Prep access: who may open the private prep page, with grant by email and
 * revoke.
 *
 * The flag is stored on the account. Granting looks the address up first, so
 * the dialog names the account it is about to change, and an address with no
 * account is refused with the reason rather than queued: sign-up does not
 * verify email, so access granted ahead of time would go to whoever
 * registered the address first.
 */

import * as api from '../api';
import * as store from '../store';
import {
  h, clear, batch, num, ago, date, when, errorBlock, loading, button, table, confirm, status,
  link, describeError,
} from '../ui';
import { prepButton, roleMarks } from './users';
import type { View } from '../view';

async function render(body: HTMLElement) {
  const listBox = h('div', null, loading());
  const adminBox = h('div', null, loading());
  const count = h('span');

  const email = h('input.adm-field', {
    type: 'email', placeholder: 'name@example.edu', 'aria-label': 'Email of the account', autocomplete: 'off', required: true,
  });
  const result = h('p.adm-status', { role: 'status' });
  const grant = h('button.adm-button.primary', { type: 'submit' }, 'Grant access');
  const form = h('form.adm-actions.adm-grant', null, email, grant);

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const address = email.value.trim().toLowerCase();
    if (!address) return;
    status(result, 'Looking up the account.');
    grant.disabled = true;
    let match: api.AdminUser | undefined;
    try {
      ({ user: match } = await api.getUser(address));
    } catch (err) {
      if (!(err instanceof api.Refused && err.status === 404)) {
        status(result, describeError(err).text, true);
        grant.disabled = false;
        return;
      }
    }
    grant.disabled = false;
    if (!match) {
      status(result, `No account uses ${address}. Ask them to create one on the site first, then grant access here.`, true);
      return;
    }
    if (match.prep_access) {
      status(result, `${match.display_name} already has prep access.`);
      return;
    }
    status(result, '');
    const who = match;
    const changed = await confirm({
      title: 'Grant prep access?',
      body: [
        h('p', null, h('strong', null, who.display_name), ` (${who.email}), joined ${date(who.created_at)}, last seen ${who.last_seen_at ? ago(who.last_seen_at) : 'never'}.`),
        'They will be able to open the private prep page and search the prep index from their next request.',
      ],
      action: 'Grant',
      run: async () => {
        const r = await api.grantPrep({ email: who.email });
        return `${r.user.display_name} (${r.user.email}) now has prep access.`;
      },
    });
    if (changed) {
      email.value = '';
      status(result, `Granted to ${who.display_name}.`);
      void lists();
    }
  });

  clear(body,
    batch('What it does', null,
      h('div.adm-prose', null,
        h('p', null, 'Prep access lets an account open the private prep page and search the prep index, which is separate from the public archive. Without it the page refuses them, signed in or not.'),
        h('p', null, 'The flag is checked whenever the page asks for a search key. A key lasts four hours, so a revoked account can keep searching until its current key runs out.'),
        h('p', null, 'Administrators always have access, whether or not the flag is set.'),
        h('p', null, 'Access can only be given to an account that already exists. Sign-up does not verify email, so access granted to an address in advance would go to whoever registered it first.'),
      )),
    batch('Grant', 'By the account\'s email', h('div.adm-group', null, form, result)),
    batch('Who has it', count, listBox),
    batch('Administrators', 'Always have access', adminBox),
  );

  async function lists() {
    try {
      const [granted, admins] = await Promise.all([
        api.listUsers({ prep: true, sort: 'name', limit: 500 }),
        api.listUsers({ admin: true, sort: 'name', limit: 100 }),
      ]);
      count.textContent = `${num(granted.total)} ${granted.total === 1 ? 'account' : 'accounts'}`;
      clear(listBox, table<api.AdminUser>({
        rows: granted.users,
        sortKey: 'name',
        columns: [
          { key: 'name', label: 'Name', sort: u => u.display_name, cell: u => link(`#users/${u.id}`, u.display_name) },
          { key: 'email', label: 'Email', sort: u => u.email, cell: u => h('span.adm-email', null, u.email) },
          { key: 'seen', label: 'Last seen', num: true, sort: u => u.last_seen_at ?? 0, cell: u => u.last_seen_at ? when(u.last_seen_at, () => ago(u.last_seen_at)) : h('span.adm-quiet', null, 'never') },
          { key: 'role', label: '', cell: u => u.is_admin ? roleMarks({ ...u, prep_access: false }) : '' },
          { key: 'act', label: '', class: 'adm-row-action', cell: u => prepButton(u, () => void lists(), true) },
        ],
        empty: 'No account has been granted access.',
      }));
      clear(adminBox, table<api.AdminUser>({
        rows: admins.users,
        columns: [
          { key: 'name', label: 'Name', cell: u => link(`#users/${u.id}`, u.display_name) },
          { key: 'email', label: 'Email', cell: u => h('span.adm-email', null, u.email) },
          { key: 'flag', label: 'Flag', cell: u => u.prep_access ? 'set' : h('span.adm-quiet', null, 'not set, not needed') },
          { key: 'seen', label: 'Last seen', num: true, cell: u => u.last_seen_at ? when(u.last_seen_at, () => ago(u.last_seen_at)) : 'never' },
        ],
      }));
    } catch (e) {
      clear(listBox, errorBlock(e, () => void lists()));
      clear(adminBox);
    }
  }
  void lists();
}

export const prep: View = {
  show(body, tools) {
    clear(tools, button('Refresh', () => { store.forget('prep'); void render(body); }));
    if (!body.childElementCount) void render(body);
  },
};

