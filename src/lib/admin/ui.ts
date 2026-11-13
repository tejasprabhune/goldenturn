/**
 * The console's building blocks: an element helper, time and number formats,
 * status marks, a sortable table, a confirmation dialog and the error line.
 *
 * Everything is built with DOM calls rather than HTML strings, because nearly
 * every string shown here (titles, notes, search queries, error text) was
 * typed by someone else.
 */

import { Denied, ServerError, SignedOut, Unreachable, Refused, FieldErrors } from './api';

type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, string | number | boolean | null | undefined | ((e: any) => void)>;

/** `h('a.cls', { href }, 'text')`: a tag with optional classes after dots. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K | `${K}.${string}`, attrs: Attrs | null = null, ...children: Array<Child | Child[]>
): HTMLElementTagNameMap[K] {
  const [name, ...classes] = tag.split('.');
  const el = document.createElement(name as K);
  if (classes.length) el.className = classes.join(' ');
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (typeof v === 'function') el.addEventListener(k.replace(/^on/, ''), v);
      else if (k === 'class') el.className = [el.className, String(v)].filter(Boolean).join(' ');
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el: Element, children: Array<Child | Child[]>) {
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : String(c));
  }
}

export function clear(el: Element, ...children: Array<Child | Child[]>) {
  el.replaceChildren();
  append(el, children);
}

/* Numbers and times. */

const NUM = new Intl.NumberFormat('en-US');

export function num(n: number | null | undefined): string {
  return n === null || n === undefined ? '' : NUM.format(n);
}

/**
 * The server's clock, when an answer carried one. Ages are worked out against
 * it so a browser with a wrong clock does not make a fresh submission look a
 * day old.
 */
let skew = 0;
export function syncClock(serverNow: number | null | undefined) {
  if (serverNow) skew = serverNow - Date.now() / 1000;
}

export function nowS(): number {
  return Math.floor(Date.now() / 1000 + skew);
}

/** "4 min", "3 h", "12 d": an age without "ago", for a column headed Age. */
export function age(t: number | null | undefined): string {
  if (!t) return '';
  const s = Math.max(0, nowS() - t);
  if (s < 60) return 'now';
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400 * 2) return `${Math.floor(s / 3600)} h`;
  if (s < 86400 * 60) return `${Math.floor(s / 86400)} d`;
  if (s < 86400 * 730) return `${Math.floor(s / (86400 * 30))} mo`;
  return `${Math.floor(s / (86400 * 365))} y`;
}

export function ago(t: number | null | undefined): string {
  const a = age(t);
  return !a ? '' : a === 'now' ? 'just now' : `${a} ago`;
}

const DATE = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
const DAY = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
const TIME = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });

/** "Nov 13, 2026". */
export function date(t: number | null | undefined): string {
  return t ? DATE.format(new Date(t * 1000)) : '';
}

/**
 * "Nov 13 19:42", or "19:42" for today. The old tail showed only the time,
 * so yesterday's events read as this morning's.
 */
export function stamp(t: number | null | undefined): string {
  if (!t) return '';
  const d = new Date(t * 1000);
  const today = new Date(nowS() * 1000);
  const time = TIME.format(d);
  if (d.toDateString() === today.toDateString()) return time;
  const sameYear = d.getFullYear() === today.getFullYear();
  return `${sameYear ? DAY.format(d) : DATE.format(d)} ${time}`;
}

/** Full date and time, for a title attribute or a record. */
export function full(t: number | null | undefined): string {
  if (!t) return '';
  return new Date(t * 1000).toLocaleString('en-US', {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

/** A time cell: the short form shown, the full one on hover. */
export function when(t: number | null | undefined, fmt: (t: number) => string = stamp): HTMLElement {
  const el = h('time.adm-when', t ? { datetime: new Date(t * 1000).toISOString(), title: full(t) } : null,
    t ? fmt(t) : '');
  return el;
}

/** A slug read as words, for a round known only by its address. */
export function slugWords(slug: string): string {
  return slug.replace(/-[a-z0-9]{6}$/, '').replace(/-/g, ' ');
}

export function roundHref(slug: string): string {
  return `/recordings/${slug}`;
}

/* Status marks: an ink word on a soft fill, never a dot. */

export type Tone = 'ok' | 'bad' | 'wait' | 'busy' | 'none';

export function mark(text: string, tone: Tone = 'wait', title?: string): HTMLElement {
  return h('span.adm-mark', { 'data-tone': tone, title: title ?? null }, text);
}

/** Yes or no in a table: present is quiet, missing is the one to see. */
export function have(v: boolean | null | undefined, missing = 'missing'): HTMLElement {
  if (v === null || v === undefined) return h('span.adm-have', { 'data-v': 'unknown' }, 'unknown');
  return v ? h('span.adm-have', { 'data-v': 'yes' }, 'yes') : h('span.adm-have', { 'data-v': 'no' }, missing);
}

export const STATUS_WORD: Record<string, string> = {
  fetching: 'Fetching audio',
  transcribing: 'Transcribing',
  labelling: 'Labelling speeches',
  publishing: 'Publishing',
  published: 'Published',
  failed: 'Failed',
  removed: 'Removed',
};

export const STATUS_TONE: Record<string, Tone> = {
  fetching: 'busy', transcribing: 'busy', labelling: 'busy', publishing: 'busy',
  published: 'ok', failed: 'bad', removed: 'none',
};

export function statusMark(status: string): HTMLElement {
  return mark(STATUS_WORD[status] ?? status, STATUS_TONE[status] ?? 'wait');
}

/* Errors. */

/**
 * One line that says which of the failures it was. "Access denied" is kept for
 * a real 403; a server error says so and carries what the server sent.
 */
export function describeError(e: unknown): { kind: string; text: string; detail?: string } {
  if (e instanceof SignedOut) return { kind: 'signed-out', text: 'Your session has ended. Sign in again.' };
  if (e instanceof Denied) return { kind: 'denied', text: `Access denied: ${e.message}.` };
  if (e instanceof ServerError) {
    return {
      kind: 'server',
      text: `The server failed (${e.status}) on ${e.path.split('?')[0]}: ${e.message}.`,
      detail: e.detail ?? undefined,
    };
  }
  if (e instanceof Unreachable) {
    return { kind: 'network', text: `Could not reach the API (${e.path.split('?')[0]}): ${e.message}.` };
  }
  if (e instanceof FieldErrors) {
    return { kind: 'refused', text: Object.values(e.fields).join(' ') };
  }
  if (e instanceof Refused) return { kind: 'refused', text: capital(e.message) + '.' };
  return { kind: 'unknown', text: e instanceof Error ? e.message : String(e) };
}

export function capital(s: string): string {
  return s ? s[0].toUpperCase() + s.slice(1) : s;
}

/** An error in place of the content that failed to load. */
export function errorBlock(e: unknown, retry?: () => void): HTMLElement {
  const d = describeError(e);
  return h('div.adm-error', { 'data-kind': d.kind, role: 'alert' },
    h('p', null, d.text),
    d.detail ? h('pre.adm-pre', null, d.detail) : null,
    retry ? h('button.adm-button', { type: 'button', onclick: retry }, 'Try again') : null,
  );
}

/** A result line that sits beside the control that caused it. */
export function status(el: HTMLElement, text: string, error = false) {
  el.textContent = text;
  el.toggleAttribute('data-error', error);
}

/* Tables. */

export interface Column<T> {
  key: string;
  label: string;
  /** Right-aligned, tabular. */
  num?: boolean;
  /** Value to sort by; absent means the column is not sortable. */
  sort?: (row: T) => string | number | null;
  cell: (row: T) => Child | Child[];
  /** Hidden below this container width, so a phone keeps the columns that matter. */
  wide?: boolean;
  class?: string;
}

export interface TableOptions<T> {
  columns: Column<T>[];
  rows: T[];
  /** Initial sort: a column key and a direction. */
  sortKey?: string;
  sortDir?: 'asc' | 'desc';
  /** When set, sorting is done by the caller (the server sorts). */
  onSort?: (key: string, dir: 'asc' | 'desc') => void;
  onOpen?: (row: T) => void;
  rowHref?: (row: T) => string;
  empty?: string;
  /** Rows drawn at first; more are added by a button under the table. */
  page?: number;
  rowAttrs?: (row: T) => Attrs;
}

/**
 * A compact table whose headers sort it. Rows open on click or Enter when the
 * caller gives `onOpen`; links inside a row keep working as links.
 */
export function table<T>(opts: TableOptions<T>): HTMLElement {
  let key = opts.sortKey ?? '';
  let dir: 'asc' | 'desc' = opts.sortDir ?? 'asc';
  let shown = opts.page ?? Infinity;
  const wrap = h('div.adm-table-wrap');

  function sorted(): T[] {
    const col = opts.columns.find(c => c.key === key);
    if (!col?.sort || opts.onSort) return opts.rows;
    const f = col.sort;
    const out = [...opts.rows].sort((a, b) => {
      const x = f(a), y = f(b);
      // Blanks go last whichever way the column is sorted.
      if (x === null || x === '') return y === null || y === '' ? 0 : 1;
      if (y === null || y === '') return -1;
      const c = typeof x === 'number' && typeof y === 'number'
        ? x - y : String(x).localeCompare(String(y), 'en', { numeric: true, sensitivity: 'base' });
      return dir === 'asc' ? c : -c;
    });
    return out;
  }

  function draw() {
    const head = h('tr', null, opts.columns.map(c => {
      const th = h('th', {
        class: [c.num ? 'num' : '', c.wide ? 'wide' : '', c.class ?? ''].filter(Boolean).join(' ') || null,
        scope: 'col',
      }, c.label);
      if (c.sort) {
        th.classList.add('sortable');
        th.tabIndex = 0;
        th.setAttribute('aria-sort', c.key === key ? (dir === 'asc' ? 'ascending' : 'descending') : 'none');
        const go = () => {
          if (key === c.key) dir = dir === 'asc' ? 'desc' : 'asc';
          else { key = c.key; dir = c.num ? 'desc' : 'asc'; }
          if (opts.onSort) opts.onSort(key, dir);
          else draw();
        };
        th.addEventListener('click', go);
        th.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
      }
      return th;
    }));

    const rows = sorted();
    const body = h('tbody', null, rows.slice(0, shown).map(r => {
      const tr = h('tr', opts.rowAttrs ? opts.rowAttrs(r) : null, opts.columns.map(c => h('td', {
        class: [c.num ? 'num' : '', c.wide ? 'wide' : '', c.class ?? ''].filter(Boolean).join(' ') || null,
      }, c.cell(r))));
      if (opts.onOpen) {
        tr.classList.add('is-openable');
        tr.tabIndex = 0;
        tr.addEventListener('click', e => {
          if ((e.target as HTMLElement).closest('a, button, input, select')) return;
          opts.onOpen!(r);
        });
        tr.addEventListener('keydown', e => {
          if (e.key === 'Enter' && e.target === tr) opts.onOpen!(r);
        });
      }
      return tr;
    }));

    const t = h('table.adm-table', null, h('thead', null, head), body);
    const parts: Node[] = [t];
    if (!rows.length) parts.push(h('p.adm-empty', null, opts.empty ?? 'None.'));
    if (rows.length > shown) {
      const left = rows.length - shown;
      parts.push(h('button.adm-more', {
        type: 'button',
        onclick: () => { shown += opts.page ?? 100; draw(); },
      }, left <= (opts.page ?? 100) ? `Show the other ${num(left)}` : `Show ${num(opts.page ?? 100)} more of ${num(left)}`));
    }
    wrap.replaceChildren(...parts);
  }

  draw();
  return wrap;
}

/* Confirmation. */

export interface ConfirmOptions {
  title: string;
  body: Array<Node | string>;
  action: string;
  danger?: boolean;
  /** A text field inside the dialog; its value is passed to `run`. */
  field?: { label: string; value?: string; placeholder?: string; required?: boolean; type?: string };
  /**
   * Does the work. A string returned is shown as the result and the dialog
   * stays open on it; a thrown error is shown and the dialog stays open so
   * the action can be tried again.
   */
  run: (value: string) => Promise<string | void>;
}

/**
 * Asks before an action that changes something, then shows what happened in
 * the same dialog. The result stays until the admin closes it, so a removal
 * that deleted four files says which four.
 */
export function confirm(opts: ConfirmOptions): Promise<boolean> {
  return new Promise(resolve => {
    const opener = document.activeElement as HTMLElement | null;
    const result = h('p.adm-status', { role: 'status' });
    const input = opts.field
      ? h('input.adm-field', {
        type: opts.field.type ?? 'text',
        value: opts.field.value ?? '',
        placeholder: opts.field.placeholder ?? null,
        'aria-label': opts.field.label,
        required: opts.field.required ?? false,
      }) : null;
    const go = h(`button.adm-button.${opts.danger ? 'danger' : 'primary'}`, { type: 'submit' }, opts.action);
    const cancel = h('button.adm-button', { type: 'button' }, 'Cancel');
    let done = false;

    const form = h('form.adm-dialog-form', { method: 'dialog' },
      h('h2', null, opts.title),
      ...opts.body.map(b => typeof b === 'string' ? h('p', null, b) : b),
      input ? h('label.adm-dialog-field', null, h('span', null, opts.field!.label), input) : null,
      result,
      h('div.adm-dialog-actions', null, cancel, go),
    );
    const dialog = h('dialog.adm-dialog', null, form);
    document.body.append(dialog);

    const close = () => {
      dialog.close();
      dialog.remove();
      opener?.focus?.();
      resolve(done);
    };
    cancel.addEventListener('click', close);
    dialog.addEventListener('cancel', e => { e.preventDefault(); close(); });
    dialog.addEventListener('click', e => { if (e.target === dialog) close(); });

    form.addEventListener('submit', async e => {
      e.preventDefault();
      if (done) { close(); return; }
      const value = input?.value.trim() ?? '';
      if (opts.field?.required && !value) { status(result, `${opts.field.label} is required.`, true); return; }
      go.disabled = true;
      cancel.disabled = true;
      status(result, 'Working.');
      try {
        const msg = await opts.run(value);
        done = true;
        status(result, msg || 'Done.');
        go.textContent = 'Close';
        go.className = 'adm-button';
        go.disabled = false;
        cancel.hidden = true;
        if (input) input.disabled = true;
        go.focus();
      } catch (err) {
        status(result, describeError(err).text, true);
        go.disabled = false;
        cancel.disabled = false;
      }
    });

    dialog.showModal();
    (input ?? go).focus();
  });
}

/* Batches: the label column beside a panel. */

export function batch(label: string, context: Child | Child[], ...body: Array<Child | Child[]>): HTMLElement {
  return h('section.adm-batch', null,
    h('div.adm-batch-label', null, h('h2', null, label), context ? h('p', null, context) : null),
    h('div.adm-batch-body', null, ...body),
  );
}

export function group(name: string | null, ...body: Array<Child | Child[]>): HTMLElement {
  return h('div.adm-group', null, name ? h('h3', null, name) : null, ...body);
}

/** Headline figures: a quiet label over a large value. */
export function figures(items: Array<[string, Child | Child[], string?]>): HTMLElement {
  return h('dl.adm-figures', null, items.map(([label, value, hint]) =>
    h('div', hint ? { title: hint } : null, h('dt', null, label), h('dd', null, value))));
}

/** Label and value pairs, read across. */
export function pairs(items: Array<[string, Child | Child[]]>): HTMLElement {
  return h('dl.adm-pairs', null, items.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)]));
}

export function link(href: string, text: Child, external = false): HTMLAnchorElement {
  return h('a.adm-link', external ? { href, target: '_blank', rel: 'noopener noreferrer' } : { href }, text);
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms = 250) {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...a: A) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

/** The time range: plain words, the current one in ink. */
export function rangeControl(current: number, onChange: (days: number) => void): HTMLElement {
  const el = choices<string>([['7', '7 days'], ['30', '30 days'], ['90', '90 days'], ['365', 'Year']],
    String(current), v => onChange(Number(v)));
  el.setAttribute('aria-label', 'Time range');
  return el;
}

/** A row of choices that filter a list: the current one in ink. */
export function choices<T extends string>(
  items: Array<[T, string, (number | null)?]>, current: T, onChange: (v: T) => void,
): HTMLElement {
  const el = h('div.adm-choices', { role: 'group' });
  for (const [value, label, n] of items) {
    const b = h('button', { type: 'button', 'aria-pressed': String(value === current) },
      label, n !== undefined && n !== null ? h('span.adm-n', null, num(n)) : null);
    b.addEventListener('click', () => {
      for (const x of el.querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b));
      onChange(value);
    });
    el.append(b);
  }
  return el;
}

export function button(label: string, onclick: (e: MouseEvent) => void, cls = ''): HTMLButtonElement {
  return h(`button.adm-button${cls ? '.' + cls.split(' ').join('.') : ''}` as 'button', { type: 'button', onclick }, label);
}

export function loading(text = 'Loading.'): HTMLElement {
  return h('p.adm-loading', { role: 'status' }, text);
}
