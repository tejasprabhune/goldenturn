/**
 * Plays the stretch of a round a correction refers to.
 *
 * Reviewing a transcript edit means hearing the words; reviewing a timing means
 * hearing where the speech starts. Both are a few seconds of audio, so one
 * shared element streams the range and stops on its own rather than leaving a
 * round playing under the reviewer.
 */

const MEDIA = 'https://media.goldenturn.org';

let audio: HTMLAudioElement | null = null;
let stopAt = 0;
let onChange: ((playingId: string | null) => void) | null = null;
let playingId: string | null = null;

function element(): HTMLAudioElement {
  if (audio) return audio;
  audio = new Audio();
  audio.preload = 'none';
  audio.addEventListener('timeupdate', () => {
    if (stopAt && audio!.currentTime >= stopAt) stop();
  });
  audio.addEventListener('ended', stop);
  return audio;
}

export function onClipChange(fn: (playingId: string | null) => void) {
  onChange = fn;
}

export function stop() {
  if (audio) {
    audio.pause();
  }
  stopAt = 0;
  if (playingId !== null) {
    playingId = null;
    onChange?.(null);
  }
}

/**
 * Plays `seconds` from `start`, or up to `end` when the caller knows it.
 * Calling again with the id that is already playing stops it, so one button
 * can start and stop.
 */
export function playClip(
  id: string,
  slug: string,
  start: number,
  opts: { end?: number; seconds?: number } = {},
) {
  if (playingId === id) { stop(); return; }

  const el = element();
  const src = `${MEDIA}/audio/${slug}.m4a`;
  if (!el.src.endsWith(`${slug}.m4a`)) {
    el.src = src;
    el.load();
  }

  const from = Math.max(0, start);
  const seconds = opts.seconds ?? 12;
  stopAt = opts.end && opts.end > from ? Math.min(opts.end, from + 45) : from + seconds;

  const begin = () => {
    el.currentTime = from;
    void el.play().catch(() => stop());
  };

  if (el.readyState >= 1) begin();
  else el.addEventListener('loadedmetadata', begin, { once: true });

  playingId = id;
  onChange?.(id);
}

export function isPlaying(id: string): boolean {
  return playingId === id;
}
