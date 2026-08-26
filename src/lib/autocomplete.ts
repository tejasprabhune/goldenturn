/**
 * A fuzzy suggestion list under a text input.
 *
 * The archive's tags and tournament names are a vocabulary, not free text: a
 * round filed under "#topicality" and one under "#topicalty" are two filters
 * for one idea, and nobody browsing ever finds the second. Suggesting what is
 * already in use is cheaper than reconciling near-duplicates later.
 *
 * Matching is fuzzy because the submitter is recalling a name rather than
 * copying one, so "milehigh" should still reach "Mile High Swing 1".
 */

/** Higher is closer. Null when the query is not in the candidate at all. */
export function fuzzyScore(query: string, candidate: string): number | null {
  const q = query.toLowerCase().trim();
  const c = candidate.toLowerCase();
  if (!q) return 0;

  // A prefix is what the typist meant; a substring is probably it; a run of
  // characters in order is a guess worth offering, and shorter names win ties.
  if (c.startsWith(q)) return 1000 - c.length;
  const at = c.indexOf(q);
  if (at > -1) return 600 - at * 5 - c.length;

  let score = 300;
  let from = 0;
  let prev = -2;
  for (const ch of q) {
    const idx = c.indexOf(ch, from);
    if (idx === -1) return null;
    if (idx === prev + 1) score += 8;
    score -= idx - from;
    prev = idx;
    from = idx + 1;
  }
  return score - c.length;
}

export function fuzzyRank(query: string, items: string[], limit = 8): string[] {
  return items
    .map(item => ({ item, score: fuzzyScore(query, item) }))
    .filter((r): r is { item: string; score: number } => r.score !== null)
    .sort((a, b) => b.score - a.score || a.item.localeCompare(b.item))
    .slice(0, limit)
    .map(r => r.item);
}

export interface AutocompleteOptions {
  /**
   * Whether the field holds a list. In segment mode only the text after the
   * last comma is matched and replaced, so a second tag can be typed without
   * the suggestion eating the first.
   */
  segment?: boolean;
  limit?: number;
  /** Runs after a suggestion is taken, so a preview can be redrawn. */
  onPick?: () => void;
}

export function attachAutocomplete(
  input: HTMLInputElement,
  items: () => string[],
  opts: AutocompleteOptions = {},
) {
  const { segment = false, limit = 8, onPick } = opts;

  const wrap = input.parentElement!;
  const list = document.createElement('ul');
  list.className = 'ac-list';
  list.role = 'listbox';
  list.id = `${input.id}-suggestions`;
  list.hidden = true;
  wrap.appendChild(list);

  input.setAttribute('role', 'combobox');
  input.setAttribute('aria-autocomplete', 'list');
  input.setAttribute('aria-expanded', 'false');
  input.setAttribute('aria-controls', list.id);
  input.autocomplete = 'off';

  let shown: string[] = [];
  let active = -1;

  const current = () => {
    const v = input.value;
    return segment ? v.slice(v.lastIndexOf(',') + 1).trim() : v.trim();
  };

  function close() {
    list.hidden = true;
    list.innerHTML = '';
    shown = [];
    active = -1;
    input.setAttribute('aria-expanded', 'false');
    input.removeAttribute('aria-activedescendant');
  }

  function paint() {
    list.querySelectorAll<HTMLLIElement>('li').forEach((li, i) => {
      li.classList.toggle('is-active', i === active);
      li.setAttribute('aria-selected', String(i === active));
    });
    if (active >= 0) input.setAttribute('aria-activedescendant', `${list.id}-${active}`);
    else input.removeAttribute('aria-activedescendant');
  }

  function open() {
    const pool = items();
    if (pool.length === 0) return close();
    shown = fuzzyRank(current(), pool, limit).filter(s => s !== current());
    if (shown.length === 0) return close();

    list.innerHTML = '';
    shown.forEach((item, i) => {
      const li = document.createElement('li');
      li.id = `${list.id}-${i}`;
      li.role = 'option';
      li.textContent = item;
      li.setAttribute('aria-selected', 'false');
      // mousedown, because a click would land after blur has closed the list.
      li.addEventListener('mousedown', e => { e.preventDefault(); pick(item); });
      list.appendChild(li);
    });
    active = -1;
    list.hidden = false;
    input.setAttribute('aria-expanded', 'true');
    paint();
  }

  function pick(item: string) {
    if (segment) {
      const cut = input.value.lastIndexOf(',');
      const head = cut === -1 ? '' : `${input.value.slice(0, cut + 1)} `;
      input.value = `${head}${item}, `;
    } else {
      input.value = item;
    }
    close();
    input.dispatchEvent(new Event('input', { bubbles: true }));
    onPick?.();
    input.focus();
  }

  input.addEventListener('input', open);
  input.addEventListener('focus', open);
  input.addEventListener('blur', () => setTimeout(close, 0));

  input.addEventListener('keydown', e => {
    if (list.hidden) return;
    // Past either end is back in the field itself, which is where someone
    // arrowing through suggestions goes to keep typing their own.
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      active = active >= shown.length - 1 ? -1 : active + 1;
      paint();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      active = active <= -1 ? shown.length - 1 : active - 1;
      paint();
    } else if (e.key === 'Enter' && active >= 0) {
      e.preventDefault();
      pick(shown[active]);
    } else if (e.key === 'Escape') {
      close();
    }
  });

  return { close };
}
