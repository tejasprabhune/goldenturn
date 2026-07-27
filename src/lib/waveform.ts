/**
 * Continuous density plot for a round's audio.
 *
 * Peaks are precomputed at ingest (3000 buckets per round) and drawn as a
 * smoothed filled area mirrored around the centre line, rather than discrete
 * bars, so the shape reads as one continuous envelope.
 */

export interface PeaksFile {
  slug: string;
  duration: number;
  buckets: number;
  peaks: number[];
}

export interface Segment {
  label: string;
  start: number;
  end: number;
  confidence?: number;
  /** Aff and neg tint differently, matching the transcript. */
  side?: 'aff' | 'neg';
}

interface Theme {
  fill: string;
  fillMuted: string;
  playhead: string;
  segmentAff: string;
  segmentNeg: string;
  segmentRule: string;
  text: string;
}

const THEME: Theme = {
  fill: 'rgba(23, 21, 15, 0.55)',
  fillMuted: 'rgba(23, 21, 15, 0.18)',
  playhead: '#17150f',
  segmentAff: 'rgba(253, 216, 93, 0.34)',
  segmentNeg: 'rgba(162, 214, 249, 0.34)',
  segmentRule: 'rgba(23, 21, 15, 0.25)',
  text: 'rgba(23, 21, 15, 0.75)',
};

/**
 * Resamples the peak buckets to one value per output pixel. Taking the max of
 * each window preserves transients that averaging would flatten away.
 */
function resample(peaks: number[], width: number): number[] {
  if (width <= 0) return [];
  const out = new Array<number>(width);
  const per = peaks.length / width;
  for (let x = 0; x < width; x++) {
    const start = Math.floor(x * per);
    const end = Math.max(start + 1, Math.floor((x + 1) * per));
    let max = 0;
    for (let i = start; i < end && i < peaks.length; i++) {
      if (peaks[i] > max) max = peaks[i];
    }
    out[x] = max;
  }
  return out;
}

/** A short moving average takes the jitter off without losing speech structure. */
function smooth(values: number[], radius: number): number[] {
  if (radius <= 0) return values;
  const out = new Array<number>(values.length);
  let sum = 0;
  const window = radius * 2 + 1;
  for (let i = -radius; i <= radius; i++) sum += values[Math.min(Math.max(i, 0), values.length - 1)];
  for (let i = 0; i < values.length; i++) {
    out[i] = sum / window;
    const drop = values[Math.min(Math.max(i - radius, 0), values.length - 1)];
    const add = values[Math.min(Math.max(i + radius + 1, 0), values.length - 1)];
    sum += add - drop;
  }
  return out;
}

export class Waveform {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private peaks: number[] = [];
  private duration = 0;
  private segments: Segment[] = [];
  private cached: number[] = [];
  private cachedWidth = 0;
  private cssWidth = 0;
  private cssHeight = 0;

  position = 0;
  hover: number | null = null;
  selection: { start: number; end: number } | null = null;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('canvas 2d context unavailable');
    this.ctx = ctx;
  }

  setData(file: PeaksFile) {
    this.peaks = file.peaks;
    this.duration = file.duration;
    this.cachedWidth = 0;
    this.resize();
  }

  setSegments(segments: Segment[]) {
    this.segments = segments;
    this.draw();
  }

  /** Backing store follows devicePixelRatio so the curve stays crisp. */
  resize() {
    const rect = this.canvas.getBoundingClientRect();
    if (rect.width === 0) return;
    const dpr = window.devicePixelRatio || 1;
    this.cssWidth = rect.width;
    this.cssHeight = rect.height;
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.draw();
  }

  timeToX(t: number): number {
    return this.duration ? (t / this.duration) * this.cssWidth : 0;
  }

  xToTime(x: number): number {
    return this.cssWidth ? Math.max(0, Math.min(this.duration, (x / this.cssWidth) * this.duration)) : 0;
  }

  private envelope(): number[] {
    const w = Math.round(this.cssWidth);
    if (w !== this.cachedWidth) {
      const smoothing = w > 900 ? 1 : 2;
      this.cached = smooth(resample(this.peaks, w), smoothing);
      this.cachedWidth = w;
    }
    return this.cached;
  }

  /**
   * Speech peaks cluster low, so a gamma lift gives the quiet stretches visible
   * shape without letting the loud ones clip.
   */
  private amplitude(v: number, scale: number): number {
    return Math.pow(v / 255, 0.62) * scale;
  }

  /**
   * One closed path: forward along the top edge, back along the bottom. The
   * return leg walks indices in reverse so the two edges stay mirrored.
   */
  private fillEnvelope(values: number[], mid: number, scale: number, style: string) {
    const ctx = this.ctx;
    const n = values.length;
    if (n < 2) return;
    const top = (i: number) => mid - this.amplitude(values[i], scale);
    const bottom = (i: number) => mid + this.amplitude(values[i], scale);

    ctx.beginPath();
    ctx.moveTo(0, top(0));
    for (let i = 1; i < n - 1; i++) {
      ctx.quadraticCurveTo(i, top(i), (i + i + 1) / 2, (top(i) + top(i + 1)) / 2);
    }
    ctx.lineTo(n - 1, top(n - 1));
    ctx.lineTo(n - 1, bottom(n - 1));
    for (let i = n - 2; i > 0; i--) {
      ctx.quadraticCurveTo(i, bottom(i), (i + i - 1) / 2, (bottom(i) + bottom(i - 1)) / 2);
    }
    ctx.lineTo(0, bottom(0));
    ctx.closePath();
    ctx.fillStyle = style;
    ctx.fill();
  }

  draw() {
    const ctx = this.ctx;
    const w = this.cssWidth;
    const h = this.cssHeight;
    if (!w || !h || !this.peaks.length) return;

    ctx.clearRect(0, 0, w, h);
    const mid = h / 2;
    const scale = h / 2 - 14;
    const values = this.envelope();

    for (const seg of this.segments) {
      const x0 = this.timeToX(seg.start);
      const x1 = this.timeToX(seg.end);
      ctx.fillStyle = seg.side === 'neg' ? THEME.segmentNeg : THEME.segmentAff;
      ctx.fillRect(x0, 0, x1 - x0, h);
      ctx.strokeStyle = THEME.segmentRule;
      ctx.setLineDash(seg.confidence !== undefined && seg.confidence < 0.6 ? [3, 3] : []);
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(x0) + 0.5, 0);
      ctx.lineTo(Math.round(x0) + 0.5, h);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    if (this.selection) {
      const x0 = this.timeToX(this.selection.start);
      const x1 = this.timeToX(this.selection.end);
      ctx.fillStyle = 'rgba(253, 216, 93, 0.35)';
      ctx.fillRect(Math.min(x0, x1), 0, Math.abs(x1 - x0), h);
    }

    this.fillEnvelope(values, mid, scale, THEME.fillMuted);

    // The played portion is drawn again, clipped, so it reads darker.
    const px = this.timeToX(this.position);
    if (px > 0) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(0, 0, px, h);
      ctx.clip();
      this.fillEnvelope(values, mid, scale, THEME.fill);
      ctx.restore();
    }

    for (const seg of this.segments) {
      const x0 = this.timeToX(seg.start);
      const x1 = this.timeToX(seg.end);
      if (x1 - x0 < 34) continue;
      ctx.fillStyle = THEME.text;
      ctx.font = '500 10px "Neue Montreal", system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const label = seg.label.toUpperCase();
      const cx = (x0 + x1) / 2;
      const metrics = ctx.measureText(label);
      ctx.save();
      ctx.globalAlpha = 0.9;
      ctx.fillStyle = 'rgba(242, 239, 230, 0.85)';
      ctx.fillRect(cx - metrics.width / 2 - 4, mid - 8, metrics.width + 8, 16);
      ctx.restore();
      ctx.fillStyle = THEME.text;
      ctx.fillText(label, cx, mid);
    }

    if (this.hover !== null) {
      const hx = this.timeToX(this.hover);
      ctx.strokeStyle = 'rgba(23, 21, 15, 0.3)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(Math.round(hx) + 0.5, 0);
      ctx.lineTo(Math.round(hx) + 0.5, h);
      ctx.stroke();
    }

    ctx.strokeStyle = THEME.playhead;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(Math.round(px) + 0.5, 0);
    ctx.lineTo(Math.round(px) + 0.5, h);
    ctx.stroke();
  }
}

export function formatTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`;
}
