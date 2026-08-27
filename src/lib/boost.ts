/**
 * Playing a quiet round louder than the device will go.
 *
 * A lot of the archive was recorded on a phone at the back of a room, and on
 * laptop speakers those rounds are unlistenable at full volume. A media
 * element's own volume stops at 1, so anything past that has to go through
 * Web Audio: the element becomes a source, a gain node multiplies it, and a
 * limiter catches the peaks that would otherwise clip into a buzz.
 *
 * The chain is only built when someone actually asks for more than 1x, so
 * ordinary playback never depends on any of it.
 */

export const BOOST_LEVELS = [1, 1.5, 2, 3, 4];

const KEY = 'gt:volume-boost';

/**
 * How loud this reader plays things, remembered across rounds. The reason to
 * boost is the speakers, not the round, so asking once per round would be
 * asking the same question all evening.
 */
export function readBoost(): number {
  try {
    const level = Number(localStorage.getItem(KEY));
    return BOOST_LEVELS.includes(level) ? level : 1;
  } catch {
    return 1;
  }
}

export function saveBoost(level: number) {
  try { localStorage.setItem(KEY, String(level)); } catch {}
}

export function boostLabel(level: number): string {
  return level === 1 ? 'off' : `${level}x`;
}

let ctx: AudioContext | null = null;
const gains = new WeakMap<HTMLMediaElement, GainNode>();

/**
 * Whether routing this element through Web Audio would still make a sound.
 *
 * Cross-origin media becomes silence once it passes through a graph unless the
 * file is served with CORS and the element asked for it, and the asking has to
 * happen before the file loads. R2 sends the headers and the elements set the
 * attribute; a Dropbox or YouTube source does neither, so it is left alone.
 */
export function canBoost(media: HTMLMediaElement): boolean {
  const src = media.currentSrc || media.src;
  if (!src) return false;
  if (media.crossOrigin) return true;
  try {
    return new URL(src, location.href).origin === location.origin;
  } catch {
    return false;
  }
}

function gainFor(media: HTMLMediaElement): GainNode | null {
  const existing = gains.get(media);
  if (existing) return existing;

  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  ctx ??= new Ctor();

  let source: MediaElementAudioSourceNode;
  try {
    source = ctx.createMediaElementSource(media);
  } catch {
    // Already routed by something else, or a source the browser will not take.
    return null;
  }

  const gain = ctx.createGain();
  // Hard enough to stop 4x tearing, slow enough to release that it does not
  // pump audibly between sentences.
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -3;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.25;

  source.connect(gain);
  gain.connect(limiter);
  limiter.connect(ctx.destination);

  // Once an element is routed it is silent while the context is suspended, and
  // a context can be suspended by the browser between one play and the next.
  media.addEventListener('play', () => { void ctx?.resume(); });

  gains.set(media, gain);
  return gain;
}

/** Returns false when this element cannot be boosted, so the UI can say so. */
export function applyBoost(media: HTMLMediaElement, level: number): boolean {
  const existing = gains.get(media);
  if (level <= 1 && !existing) return true;
  if (level > 1 && !canBoost(media)) return false;

  const gain = existing ?? gainFor(media);
  if (!gain) return false;

  const now = ctx?.currentTime ?? 0;
  gain.gain.cancelScheduledValues(now);

  if (ctx?.state === 'running') {
    // A short ramp rather than a jump, so a change mid-sentence does not click.
    gain.gain.setValueAtTime(gain.gain.value, now);
    gain.gain.linearRampToValueAtTime(level, now + 0.06);
  } else {
    // A suspended context has a stopped clock, and a ramp against a stopped
    // clock hangs wherever it was when the clock stopped. Take the level now
    // and let the sound arrive with the context.
    gain.gain.value = level;
    void ctx?.resume();
  }
  return true;
}
