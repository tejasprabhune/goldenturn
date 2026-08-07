/**
 * Star ratings, shared by the round page and the cards.
 *
 * The archive can establish what happened in a round; it cannot establish
 * whether the round is worth an hour. That is the one thing only the people
 * who watched it know, so it is the one thing collected by asking them.
 *
 * The same markup is used read-only on a card and interactively on a round
 * page, which is what keeps 4.2 stars looking the same in both places.
 */

import { getRating, setRating, NotSignedIn, type Rating } from './api';

const GLYPHS = '★★★★★';

/** One decimal, always shown, so 4 reads as 4.0 next to 4.2. */
function format(average: number): string {
  return average.toFixed(1);
}

export function ratingHtml(average: number, count: number): string {
  const pct = Math.max(0, Math.min(100, (average / 5) * 100));
  const label = count
    ? `${format(average)} out of 5, ${count} rating${count === 1 ? '' : 's'}`
    : 'not yet rated';
  return `
    <span class="stars" data-empty="${count === 0}" role="img" aria-label="${label}">
      <span class="stars__value">${format(average)}</span>
      <span class="stars__glyphs" aria-hidden="true"
        ><span class="stars__track">${GLYPHS}</span
        ><span class="stars__fill" style="width: ${pct.toFixed(1)}%">${GLYPHS}</span
      ></span>
      <span class="stars__count">(${count})</span>
    </span>`;
}

/**
 * One person's own rating, with no average and no count beside it.
 *
 * Used where the number is already known to be theirs, so saying "4.0 (1)"
 * would be answering a question nobody asked.
 */
export function ownStarsHtml(stars: number): string {
  const pct = Math.max(0, Math.min(100, (stars / 5) * 100));
  return `
    <span class="stars" role="img" aria-label="${stars} out of 5">
      <span class="stars__glyphs" aria-hidden="true"
        ><span class="stars__track">${GLYPHS}</span
        ><span class="stars__fill" style="width: ${pct}%">${GLYPHS}</span
      ></span>
    </span>`;
}

/** Repaints an existing block in place, so a rating never remounts its own DOM. */
function paint(el: HTMLElement, average: number, count: number) {
  const fill = el.querySelector('.stars__fill') as HTMLElement | null;
  const value = el.querySelector('.stars__value') as HTMLElement | null;
  const countEl = el.querySelector('.stars__count') as HTMLElement | null;
  if (fill) fill.style.width = `${Math.max(0, Math.min(100, (average / 5) * 100)).toFixed(1)}%`;
  if (value) value.textContent = format(average);
  if (countEl) countEl.textContent = `(${count})`;
  el.dataset.empty = String(count === 0);
  el.setAttribute('aria-label', count
    ? `${format(average)} out of 5, ${count} rating${count === 1 ? '' : 's'}`
    : 'not yet rated');
}

/**
 * The rating on a round page: the aggregate, and the five stars that make it
 * are also how a reader adds theirs.
 *
 * Signing in is asked for at the point of clicking rather than up front, so a
 * reader who only wanted to look never sees a prompt.
 */
export function mountRating(host: HTMLElement, slug: string) {
  host.innerHTML = `
    ${ratingHtml(0, 0)}
    <button class="stars__note" type="button" data-role="note">rate this round</button>`;

  const stars = host.querySelector('.stars') as HTMLElement;
  const glyphs = host.querySelector('.stars__glyphs') as HTMLElement;
  const note = host.querySelector('[data-role="note"]') as HTMLButtonElement;
  const fill = host.querySelector('.stars__fill') as HTMLElement;

  stars.classList.add('stars--live');

  const pick = document.createElement('span');
  pick.className = 'stars__pick';
  for (let n = 1; n <= 5; n++) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'stars__star';
    b.dataset.stars = String(n);
    b.setAttribute('aria-label', `Rate ${n} star${n === 1 ? '' : 's'}`);
    pick.appendChild(b);
  }
  glyphs.appendChild(pick);

  let current: Rating = { average: 0, count: 0, mine: null };
  /**
   * Signing in fires one event that both refetches the rating and replays a
   * click that was waiting for an account, and the fetch can land second with
   * what the round looked like before the vote. The later request wins.
   */
  let seq = 0;
  /** A rating clicked while signed out, waiting on an account. */
  let queued: number | null = null;

  function render() {
    paint(stars, current.average, current.count);
    note.textContent = current.mine === null
      ? 'rate this round'
      : `your rating: ${current.mine} · clear`;
  }

  function preview(n: number | null) {
    if (n === null) {
      stars.dataset.previewing = 'false';
      fill.style.width = `${((current.average / 5) * 100).toFixed(1)}%`;
      return;
    }
    stars.dataset.previewing = 'true';
    fill.style.width = `${(n / 5) * 100}%`;
  }

  async function submit(n: number) {
    const my = ++seq;
    try {
      const r = await setRating(slug, n);
      if (my !== seq) return;
      current = r;
      preview(null);
      render();
    } catch (e) {
      if (e instanceof NotSignedIn) {
        preview(null);
        // The click is the intent; it is held and replayed once there is an
        // account to attach it to, so signing in does not cost the rating.
        queued = n;
        document.dispatchEvent(new CustomEvent('gt:open-signin'));
      }
    }
  }

  pick.addEventListener('click', e => {
    const btn = (e.target as Element).closest('[data-stars]') as HTMLElement | null;
    if (!btn) return;
    void submit(Number(btn.dataset.stars));
  });
  pick.addEventListener('pointerover', e => {
    const btn = (e.target as Element).closest('[data-stars]') as HTMLElement | null;
    if (btn) preview(Number(btn.dataset.stars));
  });
  pick.addEventListener('pointerleave', () => preview(null));
  note.addEventListener('click', () => {
    if (current.mine === null) {
      (pick.firstElementChild as HTMLElement | null)?.focus();
      return;
    }
    void submit(0);
  });

  async function load() {
    const my = ++seq;
    const r = await getRating(slug).catch(() => null);
    if (r && my === seq) { current = r; render(); }
  }

  void load();
  // One listener, so a replayed click and a refetch can never race each other
  // for which answer lands last.
  document.addEventListener('gt:signed-in', () => {
    if (queued !== null) {
      const n = queued;
      queued = null;
      void submit(n);
    } else {
      void load();
    }
  });

  render();
}
