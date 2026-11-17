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

/**
 * How far apart the two may drift before the video is pulled back into line.
 *
 * Generous on purpose. A seek is not instant, so a threshold tight enough to
 * be woken by ordinary jitter is a threshold that spends its life correcting
 * the drift its last correction caused.
 */
const DRIFT = 1.2;

/**
 * A jump larger than this in the video, unprompted, is a person scrubbing it.
 * Comfortably above the drift threshold, so ordinary slippage is never
 * mistaken for somebody dragging the video somewhere else.
 */
const SCRUB = 2.5;

/** How long after our own seek to disregard what the video reports. */
const SETTLE_MS = 900;

/** What the picture is doing, for the page to show the right thing over it. */
export type VideoFileState = 'idle' | 'loading' | 'playing';

export interface VideoFileOptions {
  video: HTMLVideoElement;
  audio: HTMLAudioElement;
  /** The file itself. Not on the element: it is attached only while wanted. */
  src: string;
  /** The box the picture sits in, watched to know whether anyone can see it. */
  wrap: HTMLElement;
  /** Where the last frame is kept while the file is let go of. */
  still?: HTMLCanvasElement | null;
  onState?: (state: VideoFileState) => void;
  onError?: () => void;
}

/** How long after the audio stops before the file is let go of. */
const IDLE_MS = 45_000;
/** How long the picture may be out of sight before the file is let go of. */
const UNSEEN_MS = 4_000;

/**
 * The same arrangement for a video file we can address directly, which is the
 * Dropbox mp4s and movs a third of the parli rounds were recorded as.
 *
 * These files are several hundred megabytes and sit on somebody's Dropbox, so
 * the picture is fetched only while it is being watched: the audio is playing,
 * the box is on screen and the tab is in front. A browser given a plain file
 * decides for itself how far ahead to read and cannot be told to read less,
 * but it cannot read a file it has been told to forget. So when the audio has
 * been stopped for a while, or the picture is scrolled away, or the tab is
 * behind another (which is how most of a round is listened to), the source is
 * taken off the element and the connection goes with it. The last frame is
 * kept in a canvas so the box does not go blank, and the file is asked for
 * again, from the place the audio has reached, when it is next wanted.
 */
export function syncVideoFile(opts: VideoFileOptions): VideoSync {
  const { video, audio, src, wrap, still = null } = opts;
  let attached = true;
  let loaded = false;
  let inView = true;
  let settleUntil = 0;
  let idle: ReturnType<typeof setTimeout> | undefined;
  let unseen: ReturnType<typeof setTimeout> | undefined;
  const now = () => performance.now();
  const ours = () => { settleUntil = now() + 400; };
  const state = (s: VideoFileState) => opts.onState?.(s);

  // Silent, so the round is not heard twice, and so it may follow the audio
  // into playing without a gesture of its own.
  video.muted = true;
  video.preload = 'none';

  const wanted = () => attached && inView && !document.hidden;

  function keepFrame() {
    if (!still || !video.videoWidth || video.readyState < 2) return;
    try {
      still.width = video.videoWidth;
      still.height = video.videoHeight;
      still.getContext('2d')?.drawImage(video, 0, 0);
      still.hidden = false;
    } catch {
      // A frame that cannot be drawn is a box that goes dark, nothing worse.
    }
  }

  function release() {
    clearTimeout(idle);
    clearTimeout(unseen);
    if (!loaded) return;
    keepFrame();
    ours();
    video.pause();
    video.removeAttribute('src');
    video.load();
    loaded = false;
    state('idle');
  }

  function load() {
    if (loaded) return;
    loaded = true;
    ours();
    video.src = src;
    video.load();
    state('loading');
  }

  function place() {
    if (!loaded || video.readyState < 1) return;
    if (Math.abs(video.currentTime - audio.currentTime) > DRIFT) {
      ours();
      video.currentTime = audio.currentTime;
    }
  }

  /** Brings the picture to where the audio is and sets it going, if wanted. */
  function follow() {
    clearTimeout(idle);
    if (!wanted() || audio.paused) return;
    load();
    place();
    ours();
    void video.play().catch(() => {});
  }

  video.addEventListener('loadedmetadata', () => {
    ours();
    video.playbackRate = audio.playbackRate;
    if (audio.currentTime > 0.5) video.currentTime = audio.currentTime;
  });
  video.addEventListener('playing', () => {
    if (still) still.hidden = true;
    state('playing');
  });
  video.addEventListener('waiting', () => { if (loaded) state('loading'); });
  video.addEventListener('error', () => {
    if (!loaded) return; // taking the source off reports an error of its own
    loaded = false;
    opts.onError?.();
  });

  audio.addEventListener('play', follow);
  audio.addEventListener('pause', () => {
    if (!loaded) return;
    ours();
    video.pause();
    clearTimeout(idle);
    idle = setTimeout(release, IDLE_MS);
  });
  audio.addEventListener('seeking', () => {
    if (loaded && video.readyState >= 1) { ours(); video.currentTime = audio.currentTime; }
  });
  audio.addEventListener('timeupdate', () => { if (loaded) place(); else follow(); });
  audio.addEventListener('ratechange', () => { video.playbackRate = audio.playbackRate; });

  // Only reached where the picture has controls of its own, which is a phone
  // showing it full screen: someone using those moves the audio instead.
  video.addEventListener('seeked', () => {
    if (!attached || now() < settleUntil) return;
    if (Math.abs(video.currentTime - audio.currentTime) > SCRUB) audio.currentTime = video.currentTime;
  });
  video.addEventListener('play', () => {
    if (attached && audio.paused && now() >= settleUntil) void audio.play().catch(() => {});
  });
  video.addEventListener('pause', () => {
    if (attached && loaded && !audio.paused && now() >= settleUntil) audio.pause();
  });

  function seen() {
    clearTimeout(unseen);
    if (wanted()) follow();
    else if (loaded) unseen = setTimeout(() => { if (!wanted()) release(); }, UNSEEN_MS);
  }
  document.addEventListener('visibilitychange', seen);
  if ('IntersectionObserver' in window) {
    new IntersectionObserver(entries => {
      inView = entries[entries.length - 1].isIntersecting || document.fullscreenElement === wrap;
      seen();
    }, { threshold: 0.1 }).observe(wrap);
  }

  return {
    get active() { return attached; },
    detach() { attached = false; release(); },
    reattach() { attached = true; follow(); },
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
  unMute(): void;
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
  let nextFix = 0;
  let lastSeen = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  /**
   * Set when the video is playing and the audio could not be started to go
   * with it.
   *
   * A click inside a cross-origin iframe is a gesture the parent page never
   * sees, so pressing YouTube's own play button can leave the browser
   * refusing to start our audio. Rather than a muted video playing in silence,
   * the video is unmuted and becomes the sound for as long as that lasts, and
   * the audio element is walked along behind it so the waveform, the
   * transcript and everything else still know where the round is.
   */
  let videoLeads = false;

  const now = () => performance.now();
  const ours = () => { settleUntil = now() + SETTLE_MS; };

  function place(seconds: number) {
    if (!player || !attached) return;
    ours();
    player.seekTo(seconds, true);
  }

  /** The audio takes the round back, and the video goes quiet and follows. */
  function audioLeads() {
    if (!videoLeads) return;
    videoLeads = false;
    try { player?.mute(); } catch { /* gone */ }
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
          if (e.data === 1 && audio.paused) {
            audio.play().then(audioLeads).catch(() => {
              // Refused, because the click was inside the iframe and this page
              // never saw a gesture. Let the video be heard instead of leaving
              // it playing to nobody.
              videoLeads = true;
              try { player!.unMute(); } catch { /* gone */ }
            });
          }
          if (e.data === 2 && !audio.paused) audio.pause();
        },
      },
    }) as YouTubePlayer;
  });

  audio.addEventListener('play', () => {
    if (!attached) return;
    audioLeads();
    ours();
    player?.playVideo();
  });
  audio.addEventListener('pause', () => {
    if (attached && !videoLeads) { ours(); player?.pauseVideo(); }
  });
  audio.addEventListener('seeking', () => { if (!videoLeads) place(audio.currentTime); });
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

    // While the video is the one being heard, it is the clock, and the audio
    // element is walked along behind it.
    if (videoLeads) {
      if (Math.abs(at - audio.currentTime) > DRIFT) audio.currentTime = at;
      return;
    }

    /*
     * Only ever correct against a running audio, and never faster than a seek
     * can finish.
     *
     * Both of those were the same bug, and it made the video play the same
     * second over and over. A paused audio is not a clock, so correcting
     * against one drags the video back to where it started every time round.
     * And a seek takes a moment to settle during which the video is not
     * advancing while the audio is, so a tight threshold checked often finds
     * drift it has just caused and seeks again, forever.
     */
    if (audio.paused || now() < nextFix) return;
    if (Math.abs(at - audio.currentTime) > DRIFT) {
      nextFix = now() + 3000;
      place(audio.currentTime);
    }
  }, 500);

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
