/**
 * The recording card, shared by the recordings list and by search results.
 *
 * A round should look and behave the same wherever it turns up: the title and
 * the arrow open its page, the row expands to a player in place, decisions
 * stay blurred until asked for, and tags lead back to the filtered list.
 * Keeping one renderer and one set of handlers is what makes that true rather
 * than merely intended.
 */

import { recordingHref, recordingSlug } from './recordings';
import { Waveform, formatTime, type PeaksFile } from './waveform';

const MEDIA = 'https://media.goldenturn.org';

export type Hit = Record<string, unknown>;

export function escapeHtml(str: string): string {
  return (str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function text(hit: Hit, key: string): string {
  const v = hit[key];
  return typeof v === 'string' ? v : '';
}

export function renderRecordingCard(hit: Hit, activeTags: string[] = []): string {
  const objectID = escapeHtml(text(hit, 'objectID'));
  const title = escapeHtml(text(hit, 'title'));
  const link = escapeHtml(text(hit, 'link') || '#');
  const resolution = escapeHtml(text(hit, 'resolution'));
  const aff = escapeHtml(text(hit, 'aff'));
  const neg = escapeHtml(text(hit, 'neg'));
  const decision = escapeHtml(text(hit, 'decision'));
  const year = escapeHtml(text(hit, 'year'));
  const tournament = escapeHtml(text(hit, 'tournament'));
  const tags: string[] = Array.isArray(hit['_tags'])
    ? (hit['_tags'] as string[]).filter(t => typeof t === 'string' && t.startsWith('#'))
    : [];

  const href = escapeHtml(recordingHref({
    title: text(hit, 'title'),
    objectID: text(hit, 'objectID'),
  }));

  const tagPills = tags
    .map(t => `<button class="rec-card__tag" data-tag="${escapeHtml(t)}" data-active="${activeTags.includes(t)}">${escapeHtml(t)}</button>`)
    .join('');

  const meta = [year, tournament].filter(Boolean).join(', ');

  return `
    <article class="rec-card" data-objectid="${objectID}" data-link="${link}">
      <div class="rec-card__header" role="button" tabindex="0" aria-expanded="false">
        <div class="rec-card__main">
          <h2 class="rec-card__title"><a class="rec-card__link" href="${href}">${title}</a><a class="rec-card__open" href="${href}" tabindex="-1" aria-hidden="true">&#8599;</a></h2>
          <p class="rec-card__resolution">${resolution}</p>
          <div class="rec-card__strategies">
            <p class="rec-card__strategy"><span class="rec-card__label">Aff</span><span class="rec-card__strategy-text">${aff}</span></p>
            <p class="rec-card__strategy"><span class="rec-card__label">Neg</span><span class="rec-card__strategy-text">${neg}</span></p>
          </div>
          <div class="rec-card__tags">${tagPills}</div>
        </div>
        <div class="rec-card__aside">
          <span class="rec-card__decision" role="button" tabindex="0" aria-label="Reveal decision">${decision}</span>
          <span class="rec-card__meta">${meta}</span>
        </div>
      </div>
      <div class="rec-card__body" hidden>
        <div class="rec-card__body-inner">
          <div class="rec-card__player"></div>
          <div class="rec-card__footer">
            <!--
              The round's own page carries the transcript, the notes and the
              speech markers. Clicking the title gets there, but a title is a
              pair of team codes and does not read as a way in, so the way in
              says so once the card is open.
            -->
            <a class="rec-card__action rec-card__action--open" href="${href}">
              open round<span aria-hidden="true"> &#8599;</span>
            </a>
            <span class="rec-card__footer-rest">
              <button class="rec-card__action" data-action="copy">copy link</button>
              <a class="rec-card__action" href="${link}" target="_blank" rel="noopener noreferrer">open original</a>
              <button class="rec-card__action" data-action="close">close</button>
            </span>
          </div>
        </div>
      </div>
    </article>
  `;
}

/**
 * The card gets the same waveform as the round page, minus the parts that
 * belong to a dedicated page: no loop, notes, tags or transcript.
 */
function buildWaveformPlayer(host: HTMLElement, slug: string) {
  host.innerHTML = `
    <div class="cardplayer">
      <div class="cardplayer-wave"><canvas></canvas></div>
      <div class="cardplayer-transport">
        <button class="cardplayer-play" aria-label="Play">play</button>
        <span class="cardplayer-time">0:00</span>
        <span class="cardplayer-sep">/</span>
        <span class="cardplayer-total">0:00</span>
        <select class="field cardplayer-speed" aria-label="Playback speed">
          <option value="0.25">0.25x</option>
          <option value="0.5">0.5x</option>
          <option value="0.75">0.75x</option>
          <option value="1" selected>1x</option>
          <option value="1.25">1.25x</option>
          <option value="1.5">1.5x</option>
          <option value="1.75">1.75x</option>
          <option value="2">2x</option>
        </select>
      </div>
      <audio preload="metadata" src="${MEDIA}/audio/${slug}.m4a"></audio>
    </div>`;

  const canvas = host.querySelector('canvas') as HTMLCanvasElement;
  const audio = host.querySelector('audio') as HTMLAudioElement;
  const playBtn = host.querySelector('.cardplayer-play') as HTMLButtonElement;
  const timeEl = host.querySelector('.cardplayer-time') as HTMLElement;
  const totalEl = host.querySelector('.cardplayer-total') as HTMLElement;
  const speed = host.querySelector('.cardplayer-speed') as HTMLSelectElement;
  const wave = new Waveform(canvas);

  fetch(`${MEDIA}/peaks/${slug}.json`)
    .then(r => r.json())
    .then((file: PeaksFile) => {
      wave.setData(file);
      totalEl.textContent = formatTime(file.duration);
    })
    .catch(() => { host.querySelector('.cardplayer-wave')!.textContent = ''; });

  playBtn.addEventListener('click', () => { if (audio.paused) audio.play(); else audio.pause(); });
  audio.addEventListener('play', () => { playBtn.textContent = 'pause'; });
  audio.addEventListener('pause', () => { playBtn.textContent = 'play'; });
  audio.addEventListener('timeupdate', () => {
    wave.position = audio.currentTime;
    timeEl.textContent = formatTime(audio.currentTime);
    wave.draw();
  });
  speed.addEventListener('change', () => { audio.playbackRate = Number(speed.value); });

  canvas.addEventListener('pointerdown', e => {
    const rect = canvas.getBoundingClientRect();
    audio.currentTime = wave.xToTime(e.clientX - rect.left);
  });
  canvas.addEventListener('pointermove', e => {
    const rect = canvas.getBoundingClientRect();
    wave.hover = wave.xToTime(e.clientX - rect.left);
    wave.draw();
  });
  canvas.addEventListener('pointerleave', () => { wave.hover = null; wave.draw(); });

  new ResizeObserver(() => wave.resize()).observe(canvas);
}

function standardizeDropbox(url: string): string {
  if (url.includes('/scl/fi/')) {
    // New shape: rlkey param is required, so only flip dl=0 to dl=1
    return url.replace(/\bdl=0\b/, 'dl=1');
  }
  // Old /s/ shape: rewrite host, strip entire query string
  url = url.replace('www.dropbox.com', 'dl.dropboxusercontent.com');
  url = url.replace('dl.dropbox.com', 'dl.dropboxusercontent.com');
  return url.split('?')[0];
}

function ytVidId(url: string): string | false {
  const m = url.match(/(?:youtu\.be\/|youtube\.com\/(?:embed\/|v\/|watch\?v=|watch\?.+&v=))([\w-]{11})/);
  return m ? m[1] : false;
}

function vimeoVidId(url: string): string | false {
  const m = url.match(/vimeo\.com\/(?:video\/|showcase\/\d+\/video\/)?(\d{6,11})/);
  return m ? m[1] : false;
}

function showFallback(playerEl: HTMLElement, originalLink: string) {
  playerEl.innerHTML = `<p class="player-fallback">
    playback unavailable.
    <a href="${escapeHtml(originalLink)}" target="_blank" rel="noopener noreferrer">open original</a>
  </p>`;
}

export interface CardListOptions {
  /**
   * A tag was clicked. The recordings list toggles it as a filter; elsewhere it
   * leads back to the list already filtered.
   */
  onTag?: (tag: string) => void;
  /** A card opened or closed, so the caller can record it in the URL. */
  onExpandChange?: (objectID: string) => void;
  /** Where "copy link" should point. */
  copyHref?: (objectID: string) => string;
}

/**
 * Wires a container of cards: expand and collapse, the inline player, blurred
 * decisions, tags, and the copy and close actions. One card is open at a time.
 */
export function createCardList(container: HTMLElement, opts: CardListOptions = {}) {
  // Which rounds have audio in R2; anything else falls back to its source embed.
  let playable = new Set<string>();
  fetch(`${MEDIA}/index.json`)
    .then(r => r.json())
    .then(j => { playable = new Set<string>(j.playable ?? []); })
    .catch(() => {});

  let expandedObjectID = '';
  let decisionsBlurred = true;
  container.classList.add('decisions-blurred');

  function injectPlayer(card: HTMLElement) {
    const link = card.dataset.link || '';
    const playerEl = card.querySelector('.rec-card__player') as HTMLElement;

    const slug = recordingSlug({
      title: card.querySelector('.rec-card__link')?.textContent ?? '',
      objectID: card.dataset.objectid ?? '',
    });
    if (playable.has(slug)) {
      buildWaveformPlayer(playerEl, slug);
      return;
    }

    const ytId = ytVidId(link);
    if (ytId) {
      const iframe = document.createElement('iframe');
      iframe.src = `https://www.youtube.com/embed/${ytId}`;
      iframe.allow = 'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture';
      iframe.allowFullscreen = true;
      playerEl.appendChild(iframe);
      return;
    }

    const vimeoId = vimeoVidId(link);
    if (vimeoId) {
      const iframe = document.createElement('iframe');
      iframe.src = `https://player.vimeo.com/video/${vimeoId}`;
      iframe.allow = 'autoplay; fullscreen; picture-in-picture';
      iframe.allowFullscreen = true;
      playerEl.appendChild(iframe);
      return;
    }

    let mediaUrl = link;
    if (link.includes('dropbox.com')) mediaUrl = standardizeDropbox(link);
    const ext = mediaUrl.split('?')[0].split('.').pop()?.toLowerCase() || '';

    if (['mp4', 'mov', 'webm'].includes(ext)) {
      const video = document.createElement('video');
      video.src = mediaUrl;
      video.controls = true;
      video.preload = 'metadata';
      video.addEventListener('error', () => showFallback(playerEl, link));
      playerEl.appendChild(video);
      return;
    }

    if (['mp3', 'm4a', 'wav', 'ogg', 'aac'].includes(ext) || link.includes('dropbox.com')) {
      const audio = document.createElement('audio');
      audio.src = mediaUrl;
      audio.controls = true;
      audio.preload = 'metadata';
      audio.style.width = '100%';
      audio.addEventListener('error', () => showFallback(playerEl, link));
      playerEl.appendChild(audio);
      return;
    }

    showFallback(playerEl, link);
  }

  function expandCard(card: HTMLElement) {
    const body = card.querySelector('.rec-card__body') as HTMLElement;
    const header = card.querySelector('.rec-card__header') as HTMLElement;
    body.removeAttribute('hidden');
    requestAnimationFrame(() => {
      card.setAttribute('data-expanded', 'true');
      header.setAttribute('aria-expanded', 'true');
    });
    if (!card.dataset.playerInjected) {
      injectPlayer(card);
      card.dataset.playerInjected = 'true';
    }
    requestAnimationFrame(() => {
      if (card.getBoundingClientRect().top < 80) card.scrollIntoView({ block: 'start' });
    });
  }

  function collapseCard(card: HTMLElement) {
    const body = card.querySelector('.rec-card__body') as HTMLElement;
    const header = card.querySelector('.rec-card__header') as HTMLElement;
    card.setAttribute('data-expanded', 'false');
    header.setAttribute('aria-expanded', 'false');
    setTimeout(() => {
      if (card.getAttribute('data-expanded') === 'false') body.setAttribute('hidden', '');
    }, 100);
  }

  container.addEventListener('click', e => {
    const target = e.target as Element;

    // A blurred decision reveals itself on click instead of expanding the card.
    const decision = target.closest('.rec-card__decision') as HTMLElement | null;
    if (decision && decisionsBlurred) {
      e.stopPropagation();
      decision.dataset.revealed = decision.dataset.revealed === 'true' ? 'false' : 'true';
      return;
    }

    const tagBtn = target.closest('[data-tag]') as HTMLElement | null;
    if (tagBtn && tagBtn.closest('.rec-card')) {
      opts.onTag?.(tagBtn.getAttribute('data-tag')!);
      return;
    }

    const actionTarget = target as HTMLElement;
    if (actionTarget.dataset?.action === 'close') {
      collapseCard(target.closest('.rec-card') as HTMLElement);
      expandedObjectID = '';
      opts.onExpandChange?.('');
      return;
    }

    if (actionTarget.dataset?.action === 'copy') {
      const card = target.closest('.rec-card') as HTMLElement;
      const oid = card.dataset.objectid!;
      const url = opts.copyHref
        ? opts.copyHref(oid)
        : `${window.location.origin}/recordings?expand=${encodeURIComponent(oid)}`;
      navigator.clipboard.writeText(url).then(() => {
        const btn = target as HTMLButtonElement;
        const orig = btn.textContent;
        btn.textContent = 'copied';
        setTimeout(() => { btn.textContent = orig; }, 1500);
      });
      return;
    }

    const header = target.closest('.rec-card__header') as HTMLElement | null;
    if (!header) return;
    if (target.closest('a')) return;
    const card = header.closest('.rec-card') as HTMLElement;
    const oid = card.dataset.objectid!;

    if (expandedObjectID === oid) {
      collapseCard(card);
      expandedObjectID = '';
    } else {
      if (expandedObjectID) {
        const prev = container.querySelector(`[data-objectid="${CSS.escape(expandedObjectID)}"]`) as HTMLElement | null;
        if (prev) collapseCard(prev);
      }
      expandCard(card);
      expandedObjectID = oid;
    }
    opts.onExpandChange?.(expandedObjectID);
  });

  // Cards and decisions are div/span buttons, so Enter and Space need wiring.
  container.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const target = e.target as Element;
    if (target.closest('.rec-card__decision') || target.closest('.rec-card__header')) {
      e.preventDefault();
      (target as HTMLElement).click();
    }
  });

  return {
    expandCard,
    collapseCard,
    get expandedObjectID() { return expandedObjectID; },
    set expandedObjectID(id: string) { expandedObjectID = id; },
    setDecisionsBlurred(on: boolean) {
      decisionsBlurred = on;
      container.classList.toggle('decisions-blurred', on);
    },
  };
}
