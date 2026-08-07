/**
 * Keeps a YouTube embed and the round's own audio on the same clock.
 *
 * Both come from the same recording -- the audio in R2 was pulled from the
 * video being embedded -- so they share a timeline exactly, and the only
 * question is which one is in charge. It is the audio element, for two
 * reasons. Everything else in the player already reads and writes it, from the
 * waveform to the loop to the press-and-hold, so nothing else has to change.
 * And an embed can be removed by the source at any time, while a file in R2
 * cannot, so the part that must not break is the part that is authoritative.
 *
 * The video is muted and follows. Muting is not only to avoid hearing the
 * round twice: a muted player is allowed to start without a gesture, so the
 * video can follow the audio into playing rather than sitting there needing to
 * be pressed. Drift is corrected continuously rather than trusted, because two
 * players left alone for two hours do not stay together.
 *
 * Driving it the other way is the same idea in reverse: a time in the video
 * that this did not ask for is somebody scrubbing the video, so the audio goes
 * there instead.
 */

export interface VideoSync {
  /** Whether the video is currently following the audio. */
  readonly active: boolean;
  /** Stops following, and stops the video. Used when the video is hidden. */
  detach(): void;
  reattach(): void;
}

/** How far apart the two may drift before the video is pulled back into line. */
const DRIFT = 0.4;

/** A jump larger than this in the video, unprompted, is a person scrubbing it. */
const SCRUB = 1.2;

/** How long after our own seek to disregard what the video reports. */
const SETTLE_MS = 900;

/**
 * The same arrangement for a video file we can address directly, which is the
 * Dropbox mp4s and movs a third of the parli rounds were recorded as. Far less
 * work than an embed: a media element has a clock that can simply be read and
 * written, so there is nothing to poll and nothing to guess about.
 */
export function syncVideoElement(video: HTMLVideoElement, audio: HTMLAudioElement): VideoSync {
  let attached = true;
  let settleUntil = 0;
  const now = () => performance.now();
  const ours = () => { settleUntil = now() + 250; };

  // Silent, so the round is not heard twice, and so it may follow the audio
  // into playing without a gesture of its own.
  video.muted = true;

  const place = () => {
    if (!attached) return;
    ours();
    if (Math.abs(video.currentTime - audio.currentTime) > DRIFT) {
      video.currentTime = audio.currentTime;
    }
  };

  audio.addEventListener('play', () => { if (attached) { place(); void video.play().catch(() => {}); } });
  audio.addEventListener('pause', () => { if (attached) video.pause(); });
  audio.addEventListener('seeking', () => { if (attached) { ours(); video.currentTime = audio.currentTime; } });
  audio.addEventListener('timeupdate', place);
  audio.addEventListener('ratechange', () => { video.playbackRate = audio.playbackRate; });

  // Someone using the video's own controls moves the audio instead.
  video.addEventListener('seeked', () => {
    if (!attached || now() < settleUntil) return;
    if (Math.abs(video.currentTime - audio.currentTime) > SCRUB) audio.currentTime = video.currentTime;
  });
  video.addEventListener('play', () => {
    if (attached && audio.paused && now() >= settleUntil) void audio.play().catch(() => {});
  });
  video.addEventListener('pause', () => {
    if (attached && !audio.paused && now() >= settleUntil) audio.pause();
  });

  return {
    get active() { return attached; },
    detach() { attached = false; video.pause(); },
    reattach() { attached = true; place(); if (!audio.paused) void video.play().catch(() => {}); },
  };
}

interface YouTubePlayer {
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  getCurrentTime(): number;
  getPlayerState(): number;
  setPlaybackRate(rate: number): void;
  mute(): void;
  destroy(): void;
}

declare global {
  interface Window {
    YT?: any;
    onYouTubeIframeAPIReady?: () => void;
  }
}

let apiReady: Promise<void> | null = null;

/** Loads YouTube's player API once per page, however many players want it. */
function loadApi(): Promise<void> {
  if (apiReady) return apiReady;
  apiReady = new Promise<void>(resolve => {
    if (window.YT?.Player) { resolve(); return; }
    const prior = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { prior?.(); resolve(); };
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
  });
  return apiReady;
}

/**
 * @param iframe  the embed, which must already carry enablejsapi=1
 * @param audio   the element that owns the timeline
 * @param rate    what playback rate the audio is meant to be at right now
 */
export function syncYouTube(
  iframe: HTMLIFrameElement,
  audio: HTMLAudioElement,
  rate: () => number,
): VideoSync {
  let player: YouTubePlayer | null = null;
  let attached = true;
  let settleUntil = 0;
  let lastSeen = 0;
  let timer: ReturnType<typeof setInterval> | null = null;

  const now = () => performance.now();
  const ours = () => { settleUntil = now() + SETTLE_MS; };

  function place(seconds: number) {
    if (!player || !attached) return;
    ours();
    player.seekTo(seconds, true);
  }

  void loadApi().then(() => {
    player = new window.YT.Player(iframe, {
      events: {
        onReady() {
          // Silent, so the round is not heard twice and so the embed may start
          // without its own gesture.
          player!.mute();
          player!.setPlaybackRate(rate());
          place(audio.currentTime);
          if (!audio.paused) player!.playVideo();
        },
        onStateChange(e: { data: number }) {
          if (!attached || now() < settleUntil) return;
          // 1 is playing, 2 is paused. Somebody pressed the video itself, so
          // the audio does the same rather than the two coming apart.
          if (e.data === 1 && audio.paused) void audio.play().catch(() => {});
          if (e.data === 2 && !audio.paused) audio.pause();
        },
      },
    }) as YouTubePlayer;
  });

  audio.addEventListener('play', () => { if (attached) { ours(); player?.playVideo(); } });
  audio.addEventListener('pause', () => { if (attached) { ours(); player?.pauseVideo(); } });
  audio.addEventListener('seeking', () => place(audio.currentTime));
  audio.addEventListener('ratechange', () => {
    // YouTube accepts only the rates it lists, and rejects the rest silently.
    try { player?.setPlaybackRate(audio.playbackRate); } catch { /* rate not offered */ }
  });

  timer = setInterval(() => {
    if (!player || !attached) return;
    let at: number;
    try { at = player.getCurrentTime(); } catch { return; }
    if (!Number.isFinite(at)) return;

    if (now() < settleUntil) { lastSeen = at; return; }

    // A jump the audio did not ask for is somebody scrubbing the video.
    const jumped = Math.abs(at - lastSeen) > SCRUB && Math.abs(at - audio.currentTime) > SCRUB;
    lastSeen = at;
    if (jumped) {
      ours();
      audio.currentTime = at;
      return;
    }

    if (Math.abs(at - audio.currentTime) > DRIFT) place(audio.currentTime);
  }, 400);

  return {
    get active() { return attached; },
    detach() {
      attached = false;
      try { player?.pauseVideo(); } catch { /* gone */ }
    },
    reattach() {
      attached = true;
      place(audio.currentTime);
      if (!audio.paused) player?.playVideo();
    },
  };
}
