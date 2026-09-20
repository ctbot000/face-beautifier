import {
  FACE_OVAL, LIPS_OUTER, LIPS_INNER, EYE_L, EYE_R, BROW_L, BROW_R,
} from './landmarks.js';

/**
 * Paints the per-region mask the composite shader samples.
 *
 *   R — skin that may be smoothed (the face oval, minus eyes, brows and lips)
 *   G — lips, for the tint
 *   B — eye openings and the inner mouth, for whitening
 *
 * The three channels are built with canvas compositing rather than three
 * passes: `lighter` adds a region into one channel, and a `multiply` by
 * `rgb(0,255,255)` punches the non-skin regions back out of red while leaving
 * green and blue alone. A blur filter on every fill is what makes the edges
 * feather instead of banding.
 */
export class MaskPainter {
  constructor(width = 320) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = width;
    this.canvas.height = width;
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: false });
    this.blank = true;
  }

  /** Keeps the mask at the source's aspect so a pixel blur stays isotropic. */
  setAspect(aspect) {
    const w = this.canvas.width;
    const h = Math.max(32, Math.round(w / Math.max(0.2, aspect)));
    if (h !== this.canvas.height) this.canvas.height = h;
  }

  clear() {
    if (this.blank) return this.canvas;
    const { ctx, canvas } = this;
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    this.blank = true;
    return this.canvas;
  }

  /**
   * @param {Float32Array|null} pts normalised x,y pairs
   * @returns {HTMLCanvasElement}
   */
  paint(pts) {
    const { ctx, canvas } = this;
    const W = canvas.width;
    const H = canvas.height;

    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, W, H);

    if (!pts) {
      this.blank = true;
      return canvas;
    }
    this.blank = false;

    const soft = Math.max(2, W * 0.024);
    const path = (idx, scale) => {
      ctx.beginPath();
      const c = centroid(pts, idx);
      for (let i = 0; i < idx.length; i++) {
        const j = idx[i] * 2;
        const px = (c[0] + (pts[j] - c[0]) * scale) * W;
        const py = (c[1] + (pts[j + 1] - c[1]) * scale) * H;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.fill();
    };

    // R: the whole face oval, pulled in slightly so hair and jaw edges stay out.
    ctx.filter = `blur(${soft * 1.35}px)`;
    ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = '#ff0000';
    path(FACE_OVAL, 0.965);

    // G and B: the feature regions, added into their own channels.
    ctx.filter = `blur(${soft * 0.6}px)`;
    ctx.fillStyle = '#00ff00';
    path(LIPS_OUTER, 1.0);
    ctx.fillStyle = '#0000ff';
    path(EYE_L, 1.08);
    path(EYE_R, 1.08);
    path(LIPS_INNER, 0.9);

    // Punch the features back out of R so none of them get smoothed flat.
    ctx.globalCompositeOperation = 'multiply';
    ctx.filter = `blur(${soft * 0.8}px)`;
    ctx.fillStyle = '#00ffff';
    path(LIPS_OUTER, 1.18);
    path(EYE_L, 1.45);
    path(EYE_R, 1.45);
    path(BROW_L, 1.3);
    path(BROW_R, 1.3);

    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    return canvas;
  }
}

function centroid(pts, idx) {
  let sx = 0;
  let sy = 0;
  for (const i of idx) {
    sx += pts[i * 2];
    sy += pts[i * 2 + 1];
  }
  return [sx / idx.length, sy / idx.length];
}
