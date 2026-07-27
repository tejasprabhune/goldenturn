/**
 * Small canvas charts drawn in the same idiom as the audio density plot:
 * smoothed filled areas and flat bars, no gridlines, no chrome.
 */

const INK = '#17150f';
const GOLD = 'rgba(253, 216, 93, 0.85)';
const SKY = 'rgba(162, 214, 249, 0.85)';
const MUTED = 'rgba(23, 21, 15, 0.4)';

function prepare(canvas: HTMLCanvasElement): { ctx: CanvasRenderingContext2D; w: number; h: number } | null {
  const rect = canvas.getBoundingClientRect();
  if (!rect.width) return null;
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(rect.width * dpr);
  canvas.height = Math.round(rect.height * dpr);
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, rect.width, rect.height);
  return { ctx, w: rect.width, h: rect.height };
}

/**
 * Activity over time, drawn as a smoothed area so it reads like the waveform
 * rather than a business chart.
 */
export function areaChart(canvas: HTMLCanvasElement, values: number[], labels: string[] = []) {
  const set = prepare(canvas);
  if (!set || values.length === 0) return;
  const { ctx, w, h } = set;
  const pad = 18;
  const max = Math.max(...values, 1);
  const stepX = values.length > 1 ? (w - 2) / (values.length - 1) : 0;
  const y = (v: number) => h - pad - (v / max) * (h - pad * 1.6);

  ctx.beginPath();
  ctx.moveTo(1, y(values[0]));
  for (let i = 1; i < values.length; i++) {
    const x = 1 + i * stepX;
    const px = 1 + (i - 1) * stepX;
    ctx.quadraticCurveTo(px + stepX / 2, y(values[i - 1]), (px + x) / 2, (y(values[i - 1]) + y(values[i])) / 2);
  }
  if (values.length > 1) ctx.lineTo(1 + (values.length - 1) * stepX, y(values[values.length - 1]));
  ctx.lineTo(w, h - pad);
  ctx.lineTo(1, h - pad);
  ctx.closePath();
  ctx.fillStyle = GOLD;
  ctx.fill();

  ctx.strokeStyle = 'rgba(23, 21, 15, 0.15)';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, h - pad + 0.5);
  ctx.lineTo(w, h - pad + 0.5);
  ctx.stroke();

  ctx.fillStyle = MUTED;
  ctx.font = '500 10px "Neue Montreal", system-ui, sans-serif';
  ctx.textBaseline = 'top';
  if (labels.length) {
    ctx.textAlign = 'left';
    ctx.fillText(labels[0], 1, h - pad + 5);
    ctx.textAlign = 'right';
    ctx.fillText(labels[labels.length - 1], w - 1, h - pad + 5);
  }
  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = INK;
  ctx.fillText(String(max), 1, 11);
}

/** Ranked counts as horizontal bars, label inside, value at the end. */
export function barChart(
  canvas: HTMLCanvasElement,
  rows: Array<{ label: string; value: number }>,
  accent: 'gold' | 'sky' = 'sky',
) {
  const set = prepare(canvas);
  if (!set || rows.length === 0) return;
  const { ctx, w, h } = set;
  const max = Math.max(...rows.map(r => r.value), 1);
  const rowH = Math.min(22, h / rows.length);
  const gap = Math.max(2, rowH * 0.22);

  ctx.font = '400 11px "Neue Montreal", system-ui, sans-serif';
  ctx.textBaseline = 'middle';

  rows.forEach((row, i) => {
    const y = i * rowH;
    const barW = Math.max(2, (row.value / max) * (w - 34));
    ctx.fillStyle = accent === 'gold' ? GOLD : SKY;
    ctx.fillRect(0, y, barW, rowH - gap);

    ctx.fillStyle = INK;
    ctx.textAlign = 'left';
    const label = row.label.length > 34 ? row.label.slice(0, 33) + '…' : row.label;
    ctx.fillText(label, 5, y + (rowH - gap) / 2);

    ctx.fillStyle = MUTED;
    ctx.textAlign = 'right';
    ctx.fillText(String(row.value), w - 1, y + (rowH - gap) / 2);
  });
}
