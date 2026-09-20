/**
 * One Euro filter, vectorised over a flat coordinate array.
 *
 * Raw landmarks jitter by a pixel or two even on a perfectly still face, and
 * that jitter is very visible once it drives a geometric warp. A plain
 * exponential average removes it but adds lag you can feel when you turn your
 * head; the One Euro filter widens its own cutoff with speed, so it is calm at
 * rest and responsive in motion.
 *
 * Casiez, Roussel & Vogel, CHI 2012.
 */
export class OneEuroArray {
  /**
   * @param {number} size    number of scalars in each sample
   * @param {object} [opts]
   * @param {number} [opts.minCutoff] Hz — lower is smoother at rest
   * @param {number} [opts.beta]      speed coefficient — higher cuts lag
   * @param {number} [opts.dCutoff]   Hz — cutoff of the derivative filter
   */
  constructor(size, { minCutoff = 1.1, beta = 0.02, dCutoff = 1.0 } = {}) {
    this.size = size;
    this.minCutoff = minCutoff;
    this.beta = beta;
    this.dCutoff = dCutoff;
    this.x = new Float32Array(size);
    this.dx = new Float32Array(size);
    this.ready = false;
    this.lastTime = 0;
  }

  reset() {
    this.ready = false;
  }

  /**
   * @param {Float32Array|number[]} sample raw values, length === size
   * @param {number} timeSec monotonic timestamp in seconds
   * @returns {Float32Array} the filtered array (owned by this filter, reused)
   */
  filter(sample, timeSec) {
    const { x, dx, size } = this;

    if (!this.ready) {
      for (let i = 0; i < size; i++) {
        x[i] = sample[i];
        dx[i] = 0;
      }
      this.ready = true;
      this.lastTime = timeSec;
      return x;
    }

    // A dropped frame or a tab wake-up can hand us a huge or zero dt; both
    // produce nonsense alphas, so clamp to a plausible frame interval.
    let dt = timeSec - this.lastTime;
    if (!(dt > 0) || dt > 0.2) dt = 1 / 60;
    this.lastTime = timeSec;

    const aD = alpha(this.dCutoff, dt);

    for (let i = 0; i < size; i++) {
      const raw = sample[i];
      const rate = (raw - x[i]) / dt;
      const dHat = dx[i] + aD * (rate - dx[i]);
      dx[i] = dHat;

      const cutoff = this.minCutoff + this.beta * Math.abs(dHat);
      const a = alpha(cutoff, dt);
      x[i] += a * (raw - x[i]);
    }
    return x;
  }
}

function alpha(cutoff, dt) {
  const tau = 1 / (2 * Math.PI * cutoff);
  return 1 / (1 + tau / dt);
}
