/**
 * In-browser test suite. Open the page with ?selftest=1.
 *
 * It exercises the real pipeline — the same shaders, the same mask painter,
 * the same warp maths — against synthetic sources, so it verifies everything
 * that does not need a camera. Results land in `window.__selftest` and in a
 * panel on the page.
 */
import { Renderer } from './renderer.js';
import { MaskPainter } from './mask.js';
import { computeFace } from './face.js';
import { buildWarps, faceUniforms, blurScaleFor } from './warp.js';
import { OneEuroArray } from './onefilter.js';
import { PRESETS, toShader, defaults, DEFAULT_COLORS, allControls } from './controls.js';
import { MAX_WARP } from './shaders.js';
import {
  FACE_OVAL, LIPS_OUTER, LIPS_INNER, EYE_L, EYE_R, BROW_L, BROW_R,
  IRIS_L, IRIS_R, IRIS_CENTER_L, IRIS_CENTER_R, P, NUM_LANDMARKS,
} from './landmarks.js';

const results = [];
let current = null;

function test(name, fn) {
  current = { name, ok: true, notes: [] };
  try {
    fn();
  } catch (err) {
    current.ok = false;
    current.notes.push(String(err && err.message ? err.message : err));
  }
  results.push(current);
  current = null;
}

function check(cond, message) {
  if (!cond) throw new Error(message);
}

function note(message) {
  if (current) current.notes.push(message);
}

function near(a, b, tol, label) {
  check(Math.abs(a - b) <= tol, `${label}: ${a.toFixed(4)} vs ${b.toFixed(4)} (tol ${tol})`);
}

/* ------------------------------------------------------------- fixtures */

const SIZE = 256;

/** Neutral parameters: every effect off, so the pipeline must be an identity. */
function neutralParams() {
  const v = {};
  for (const c of allControls()) v[c.key] = 0;
  v.texture = 100;
  v.radius = 50;
  return toShader(v, DEFAULT_COLORS);
}

function emptyFace() {
  return faceUniforms(null, 0);
}

function sourceCanvas(paint) {
  const c = document.createElement('canvas');
  c.width = SIZE;
  c.height = SIZE;
  paint(c.getContext('2d', { willReadFrequently: true }), c);
  return c;
}

/** Noisy skin-toned field: the chroma test must accept it as skin. */
function skinNoise() {
  return sourceCanvas((ctx) => {
    const img = ctx.createImageData(SIZE, SIZE);
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < SIZE * SIZE; i++) {
      const n = (rnd() - 0.5) * 44;
      img.data[i * 4] = clamp255(214 + n);
      img.data[i * 4 + 1] = clamp255(172 + n * 0.8);
      img.data[i * 4 + 2] = clamp255(150 + n * 0.7);
      img.data[i * 4 + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
  });
}

/** Red ramps left to right; the exact value at a column is known. */
function xRamp() {
  return sourceCanvas((ctx) => {
    const img = ctx.createImageData(SIZE, SIZE);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        const i = (y * SIZE + x) * 4;
        const v = Math.round((x / (SIZE - 1)) * 255);
        img.data[i] = v;
        img.data[i + 1] = v;
        img.data[i + 2] = v;
        img.data[i + 3] = 255;
      }
    }
    ctx.putImageData(img, 0, 0);
  });
}

function clamp255(v) {
  return v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
}

/** A mask with skin (red) in the left half only. */
function halfMask() {
  const c = document.createElement('canvas');
  c.width = SIZE;
  c.height = SIZE;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, SIZE, SIZE);
  ctx.fillStyle = '#f00';
  ctx.fillRect(0, 0, SIZE * 0.45, SIZE);
  return c;
}

function blackMask() {
  const c = document.createElement('canvas');
  c.width = SIZE;
  c.height = SIZE;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, SIZE, SIZE);
  return c;
}

/** Plausible 478-point landmark set, laid out from the real index loops. */
export function syntheticLandmarks() {
  const pts = new Float32Array(NUM_LANDMARKS * 2);
  for (let i = 0; i < NUM_LANDMARKS; i++) {
    pts[i * 2] = 0.5;
    pts[i * 2 + 1] = 0.5;
  }
  const set = (i, x, y) => { pts[i * 2] = x; pts[i * 2 + 1] = y; };
  const ring = (idx, cx, cy, rx, ry, startDeg = -90) => {
    for (let i = 0; i < idx.length; i++) {
      const a = ((startDeg + (360 * i) / idx.length) * Math.PI) / 180;
      set(idx[i], cx + Math.cos(a) * rx, cy + Math.sin(a) * ry);
    }
  };

  ring(FACE_OVAL, 0.5, 0.5, 0.22, 0.30, -90);
  ring(EYE_L, 0.585, 0.44, 0.048, 0.024, 0);
  ring(EYE_R, 0.415, 0.44, 0.048, 0.024, 180);
  ring(IRIS_L, 0.585, 0.44, 0.017, 0.017, 0);
  ring(IRIS_R, 0.415, 0.44, 0.017, 0.017, 0);
  set(IRIS_CENTER_L, 0.585, 0.44);
  set(IRIS_CENTER_R, 0.415, 0.44);
  ring(BROW_L, 0.585, 0.395, 0.055, 0.016, 0);
  ring(BROW_R, 0.415, 0.395, 0.055, 0.016, 180);
  ring(LIPS_OUTER, 0.5, 0.655, 0.062, 0.034, 180);
  ring(LIPS_INNER, 0.5, 0.655, 0.046, 0.015, 180);

  set(P.noseTip, 0.5, 0.555);
  set(P.noseBridge, 0.5, 0.41);
  set(P.noseBase, 0.5, 0.585);
  set(P.noseWingL, 0.533, 0.575);
  set(P.noseWingR, 0.467, 0.575);
  set(P.nostrilL, 0.520, 0.585);
  set(P.nostrilR, 0.480, 0.585);
  set(P.cheekBoneL, 0.60, 0.56);
  set(P.cheekBoneR, 0.40, 0.56);
  set(P.browCenter, 0.5, 0.40);
  return pts;
}

/* ---------------------------------------------------------------- tests */

function renderOnce(rend, source, mask, opts = {}) {
  rend.resize(SIZE, SIZE);
  rend.uploadSource(source, source.width, source.height);
  rend.uploadMask(mask);
  rend.render({
    params: opts.params || neutralParams(),
    warps: opts.warps || [],
    face: opts.face || emptyFace(),
    blurScale: opts.blurScale ?? 3,
    mirror: 0,
    compare: -1,
    showMask: false,
    time: 0,
  });
  return rend.readPixels(0, 0, SIZE, SIZE);
}

function meanAbsDiff(a, b, x0, x1) {
  let sum = 0;
  let n = 0;
  for (let y = 0; y < SIZE; y += 2) {
    for (let x = x0; x < x1; x += 2) {
      const i = (y * SIZE + x) * 4;
      sum += Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]);
      n += 3;
    }
  }
  return sum / Math.max(1, n);
}

function readCanvas(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
}

export function run(host = {}) {
  results.length = 0;
  const glCanvas = document.createElement('canvas');
  let rend = null;

  test('WebGL2 context and shader compilation', () => {
    rend = new Renderer(glCanvas);
    check(rend.programs.blur && rend.programs.composite && rend.programs.mask,
      'a program is missing');
    check(rend.glError() === null, 'GL reported an error after building programs');
    note('blur, composite and mask programs linked');
  });

  if (!rend) return report(host);

  const noise = skinNoise();
  const ramp = xRamp();
  const black = blackMask();

  test('Neutral settings are an exact identity', () => {
    const out = renderOnce(rend, noise, black);
    const src = readCanvas(noise);
    // readPixels is bottom-up; the composite pass flips, so row r of the
    // readback is row r of the source only after undoing both.
    let worst = 0;
    for (let y = 0; y < SIZE; y += 3) {
      for (let x = 0; x < SIZE; x += 3) {
        const o = ((SIZE - 1 - y) * SIZE + x) * 4;
        const s = (y * SIZE + x) * 4;
        for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(out[o + k] - src[s + k]));
      }
    }
    check(worst <= 2, `identity drifted by ${worst}/255`);
    note(`max channel drift ${worst}/255`);
  });

  test('Smoothing acts only where the mask allows it', () => {
    // The reference is the identity render, not another smoothed one: with no
    // face the shader falls back to its skin-tone mask and would smooth the
    // whole frame, which would hide exactly the difference under test.
    const plain = renderOnce(rend, noise, black, { params: neutralParams() });
    const masked = renderOnce(rend, noise, halfMask(), {
      params: { ...neutralParams(), smooth: 1, texture: 0 },
      face: { ...emptyFace(), confidence: 1 },
      blurScale: 4,
    });
    const left = meanAbsDiff(plain, masked, 4, Math.round(SIZE * 0.4));
    const right = meanAbsDiff(plain, masked, Math.round(SIZE * 0.6), SIZE - 4);
    check(left > 3, `masked half barely changed (${left.toFixed(2)}/255)`);
    check(right < 0.6, `unmasked half changed (${right.toFixed(2)}/255)`);
    note(`masked ${left.toFixed(2)}/255, unmasked ${right.toFixed(2)}/255`);
  });

  test('Without landmarks the skin-tone fallback still finds skin', () => {
    // Left half skin-toned, right half a colour no skin test should accept.
    const split = sourceCanvas((ctx) => {
      const img = ctx.createImageData(SIZE, SIZE);
      let seed = 99;
      const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
      for (let y = 0; y < SIZE; y++) {
        for (let x = 0; x < SIZE; x++) {
          const i = (y * SIZE + x) * 4;
          const n = (rnd() - 0.5) * 44;
          const skinSide = x < SIZE / 2;
          img.data[i] = clamp255((skinSide ? 214 : 60) + n);
          img.data[i + 1] = clamp255((skinSide ? 172 : 120) + n * 0.8);
          img.data[i + 2] = clamp255((skinSide ? 150 : 190) + n * 0.7);
          img.data[i + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
    });
    const plain = renderOnce(rend, split, black, { params: neutralParams() });
    const smoothed = renderOnce(rend, split, black, {
      params: { ...neutralParams(), smooth: 1, texture: 0 },
      face: emptyFace(),            // confidence 0 -> fallback path
      blurScale: 4,
    });
    const skinSide = meanAbsDiff(plain, smoothed, 4, Math.round(SIZE * 0.42));
    const otherSide = meanAbsDiff(plain, smoothed, Math.round(SIZE * 0.58), SIZE - 4);
    check(skinSide > 3, `skin-toned half was not smoothed (${skinSide.toFixed(2)}/255)`);
    check(otherSide < skinSide * 0.35, `non-skin half was smoothed too (${otherSide.toFixed(2)}/255)`);
    note(`skin ${skinSide.toFixed(2)}/255, non-skin ${otherSide.toFixed(2)}/255`);
  });

  test('Smoothing keeps large edges', () => {
    const edged = sourceCanvas((ctx) => {
      ctx.fillStyle = 'rgb(214,172,150)';
      ctx.fillRect(0, 0, SIZE, SIZE);
      ctx.fillStyle = 'rgb(40,28,26)';
      ctx.fillRect(0, 0, SIZE, SIZE * 0.5);
    });
    const params = { ...neutralParams(), smooth: 1, texture: 0 };
    const out = renderOnce(rend, edged, halfMask(), {
      params,
      face: { ...emptyFace(), confidence: 1 },
      blurScale: 4,
    });
    // Sample well clear of the boundary on both sides, in the masked half.
    const at = (x, y) => out[((SIZE - 1 - y) * SIZE + x) * 4];
    const dark = at(40, 40);
    const light = at(40, SIZE - 40);
    check(dark < 70, `dark side bled to ${dark}`);
    check(light > 180, `light side bled to ${light}`);
    note(`edge contrast preserved: ${dark} vs ${light}`);
  });

  test('Warp handle displaces by the amount the maths predicts', () => {
    const r = 0.22;
    const d = 0.06;
    const cx = 0.5;
    const cy = 0.5;
    const warps = [{ cx, cy, r, mode: 0, dx: d, dy: 0 }];
    const out = renderOnce(rend, ramp, black, { warps });
    const y = Math.round(SIZE * 0.5);
    const sampleAt = (u) => out[((SIZE - 1 - y) * SIZE + Math.round(u * SIZE)) * 4] / 255;

    // The falloff is 1 at the centre, so the handle's fixed point is exact.
    near(sampleAt(cx), cx - d, 0.02, 'sample at the handle centre');
    // ...and 1 - t^2(3 - 2t) = 0.5 at half the radius, exactly.
    near(sampleAt(cx + r * 0.5), cx + r * 0.5 - d * 0.5, 0.02, 'sample at half radius');
    // Outside the radius nothing may move.
    const farU = cx + r + 0.12;
    near(sampleAt(farU), farU, 0.02, 'pixel outside the warp radius');
    note(`centre ${sampleAt(cx).toFixed(3)}, half-radius ${sampleAt(cx + r * 0.5).toFixed(3)}, outside ${sampleAt(farU).toFixed(3)}`);
  });

  test('The warp falloff cannot fold the backward map', () => {
    // Axial backward map for one handle, r = 1. Every displacement the builder
    // can emit must leave it strictly increasing, or the image creases.
    const falloff = (t) => 1 - t * t * (3 - 2 * t);
    const worstSlope = (m) => {
      let worst = Infinity;
      for (let i = -9999; i <= 9999; i++) {
        const t = (i / 10000) * 0.99999;
        const h = 1e-6;
        const f = (x) => x - m * falloff(Math.abs(x));
        worst = Math.min(worst, (f(t + h) - f(t - h)) / (2 * h));
      }
      return worst;
    };
    check(worstSlope(0.45) > 0.3, 'the 0.45r cap is not comfortably injective');
    check(worstSlope(0.66) > 0, 'the falloff should hold to 2r/3');
    check(worstSlope(0.8) < 0, 'the fold limit is higher than assumed — recheck the cap');
    note(`min slope: 0.45r -> ${worstSlope(0.45).toFixed(3)}, 0.66r -> ${worstSlope(0.66).toFixed(3)}`);
  });

  test('Mask painter fills the right channel per region', () => {
    const painter = host.painter instanceof MaskPainter ? new MaskPainter(320) : new MaskPainter(320);
    painter.setAspect(1);
    const pts = syntheticLandmarks();
    const canvas = painter.paint(pts);
    const data = readCanvas(canvas);
    const W = canvas.width;
    const H = canvas.height;
    const at = (u, v) => {
      const i = (Math.round(v * (H - 1)) * W + Math.round(u * (W - 1))) * 4;
      return [data[i], data[i + 1], data[i + 2]];
    };

    const cheek = at(0.40, 0.56);
    const lips = at(0.5, 0.655);
    const eye = at(0.585, 0.44);
    const outside = at(0.04, 0.05);

    check(cheek[0] > 150, `cheek should be skin, got R=${cheek[0]}`);
    check(lips[1] > 120, `lips should be green, got G=${lips[1]}`);
    check(lips[0] < 70, `lips must be punched out of skin, got R=${lips[0]}`);
    check(eye[2] > 110, `eye should be blue, got B=${eye[2]}`);
    check(eye[0] < 70, `eye must be punched out of skin, got R=${eye[0]}`);
    check(outside[0] + outside[1] + outside[2] < 30, 'mask leaked outside the face');
    note(`cheek R=${cheek[0]} lips G=${lips[1]}/R=${lips[0]} eye B=${eye[2]}/R=${eye[0]}`);

    const cleared = readCanvas(painter.clear());
    let sum = 0;
    for (let i = 0; i < cleared.length; i += 4) sum += cleared[i] + cleared[i + 1] + cleared[i + 2];
    check(sum === 0, 'clear() left a non-zero mask');
  });

  test('Face metrics are sane on synthetic landmarks', () => {
    const face = computeFace(syntheticLandmarks(), 1);
    check(face, 'computeFace returned null');
    check(face.width > 0.3 && face.width < 0.7, `face width ${face.width.toFixed(3)}`);
    check(face.height > 0.4 && face.height < 0.8, `face height ${face.height.toFixed(3)}`);
    check(Math.abs(face.axis[0]) < 0.05 && face.axis[1] > 0.9, 'face axis is not pointing down');
    check(face.eyeL.center[0] > face.eyeR.center[0], 'eye centres are swapped');
    check(face.eyeL.width > 0.05, `eye width ${face.eyeL.width.toFixed(3)}`);
    for (const [k, v] of Object.entries({ width: face.width, height: face.height })) {
      check(Number.isFinite(v), `${k} is not finite`);
    }
    note(`width ${face.width.toFixed(3)}, height ${face.height.toFixed(3)}`);
  });

  test('Warp handles stay inside their own falloff', () => {
    const face = computeFace(syntheticLandmarks(), 1);
    const params = toShader(
      { ...defaults(), slim: 100, chin: 100, eyes: 100, nose: 100, lips: 100 },
      DEFAULT_COLORS,
    );
    const warps = buildWarps(face, params);
    check(warps.length > 0, 'no handles built at full strength');
    check(warps.length <= MAX_WARP, `${warps.length} handles exceeds the shader's ${MAX_WARP}`);
    for (const w of warps) {
      check(Number.isFinite(w.cx) && Number.isFinite(w.cy) && w.r > 0, 'handle has bad geometry');
      if (w.mode === 0) {
        const d = Math.hypot(w.dx, w.dy);
        check(d <= w.r * 0.451, `displacement ${d.toFixed(4)} exceeds 0.45r (${w.r.toFixed(4)})`);
      } else {
        check(Math.abs(w.k) < 0.5, `scale factor ${w.k} would fold the image`);
      }
    }
    note(`${warps.length} handles, all within their falloff`);
  });

  test('Slimming pulls the jaw inward, not outward', () => {
    const pts = syntheticLandmarks();
    const face = computeFace(pts, 1);
    const params = toShader({ ...defaults(), slim: 100 }, DEFAULT_COLORS);
    const warps = buildWarps(face, params);
    const midX = (face.chin[0] + face.brow[0]) / 2;
    let checked = 0;
    for (const w of warps) {
      if (w.mode !== 0) continue;
      // cx is the destination; cx - dx is where the jaw point started.
      const before = Math.abs(w.cx - w.dx - midX);
      const after = Math.abs(w.cx - midX);
      check(after <= before + 1e-6, `handle at ${w.cx.toFixed(3)} moved away from the midline`);
      checked++;
    }
    check(checked >= 8, `only ${checked} jaw handles were produced`);
    note(`${checked} handles all move toward the midline`);
  });

  test('Blur radius tracks the face size', () => {
    const small = blurScaleFor({ width: 0.2 }, 720, 1);
    const big = blurScaleFor({ width: 0.5 }, 720, 1);
    check(big > small * 2, `radius did not scale (${small.toFixed(2)} -> ${big.toFixed(2)})`);
    check(blurScaleFor(null, 720, 1) > 1, 'no-face fallback radius is too small');
    check(blurScaleFor({ width: 5 }, 4000, 1) <= 10, 'radius is not clamped');
    note(`0.2 wide -> ${small.toFixed(2)} texels, 0.5 wide -> ${big.toFixed(2)} texels`);
  });

  test('One Euro filter removes jitter without freezing', () => {
    const jitterOf = (beta) => {
      const f = new OneEuroArray(1, { minCutoff: 1.0, beta });
      let seed = 7;
      const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5);
      let rawVar = 0;
      let outVar = 0;
      let t = 0;
      for (let i = 0; i < 200; i++) {
        t += 1 / 60;
        const raw = 0.5 + rnd() * 0.01;
        const out = f.filter([raw], t)[0];
        if (i > 60) {
          rawVar += (raw - 0.5) ** 2;
          outVar += (out - 0.5) ** 2;
        }
      }
      return outVar / rawVar;
    };
    const kept = jitterOf(0.01);
    check(kept < 0.35, `jitter only fell to ${(kept * 100).toFixed(0)}% of the input`);

    // Lag on a ramp of 2 units/s. The point of One Euro is that beta buys the
    // lag back, so the useful assertion is that a larger beta tracks closer.
    const lagOf = (beta) => {
      const f = new OneEuroArray(1, { minCutoff: 1.0, beta });
      let t = 0;
      let out = 0;
      for (let i = 0; i <= 60; i++) {
        t += 1 / 60;
        out = f.filter([(i / 60) * 2], t)[0];
      }
      return 2 - out;
    };
    const slow = lagOf(0);
    const fast = lagOf(0.8);
    check(slow > 0, 'a zero-beta filter should lag a ramp');
    check(fast < slow * 0.7, `beta did not reduce lag (${slow.toFixed(3)} -> ${fast.toFixed(3)})`);
    check(fast < 0.25, `even at high beta the filter lagged ${fast.toFixed(3)}`);
    note(`jitter -> ${(kept * 100).toFixed(0)}%, ramp lag ${slow.toFixed(3)} -> ${fast.toFixed(3)} with beta`);
  });

  test('Every preset maps to finite uniforms', () => {
    for (const preset of PRESETS) {
      const values = { ...defaults(), ...preset.values };
      const p = toShader(values, DEFAULT_COLORS);
      for (const [k, v] of Object.entries(p)) {
        if (Array.isArray(v)) {
          check(v.every(Number.isFinite), `${preset.id}.${k} has a non-finite component`);
        } else {
          check(Number.isFinite(v), `${preset.id}.${k} is ${v}`);
        }
      }
      check(p.smooth >= 0 && p.smooth <= 1, `${preset.id} smooth out of range`);
    }
    note(`${PRESETS.length} presets checked`);
  });

  test('Compare split shows the original on one side', () => {
    const params = { ...neutralParams(), bright: 0.4, smooth: 0 };
    rend.resize(SIZE, SIZE);
    rend.uploadSource(noise, noise.width, noise.height);
    rend.uploadMask(black);
    rend.render({
      params, warps: [], face: emptyFace(), blurScale: 3,
      mirror: 0, compare: 0.5, showMask: false, time: 0,
    });
    const out = rend.readPixels(0, 0, SIZE, SIZE);
    const src = readCanvas(noise);
    const y = 100;
    const leftOut = out[((SIZE - 1 - y) * SIZE + 30) * 4];
    const leftSrc = src[(y * SIZE + 30) * 4];
    const rightOut = out[((SIZE - 1 - y) * SIZE + SIZE - 30) * 4];
    const rightSrc = src[(y * SIZE + SIZE - 30) * 4];
    check(Math.abs(leftOut - leftSrc) <= 2, `left of the split was processed (${leftOut} vs ${leftSrc})`);
    check(rightOut > rightSrc + 4, `right of the split was not processed (${rightOut} vs ${rightSrc})`);
    note(`left ${leftOut}=${leftSrc}, right ${rightOut}>${rightSrc}`);
  });

  test('No GL errors after the whole run', () => {
    const err = rend.glError();
    check(err === null, `gl.getError() reported 0x${(err || 0).toString(16)}`);
  });

  return report(host);
}

function report(host) {
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  const summary = { passed, failed, total: results.length, results };
  window.__selftest = summary;

  const lines = results.map((r) => `${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.notes.length ? `\n        ${r.notes.join('\n        ')}` : ''}`);
  const text = `${lines.join('\n')}\n\n${failed ? `${failed} FAILED` : 'ALL PASSED'} (${passed}/${results.length})`;
  console.log(`[face-beautifier selftest]\n${text}`);

  const box = document.createElement('pre');
  box.id = 'selftest-output';
  box.dataset.failed = String(failed);
  box.style.cssText = [
    'position:fixed', 'inset:12px', 'z-index:9999', 'overflow:auto',
    'background:#0b0a10ee', 'color:#ece9f5', 'border:1px solid #2a2736',
    'border-radius:12px', 'padding:16px', 'font:12.5px/1.5 ui-monospace,monospace',
    'white-space:pre-wrap', 'margin:0',
  ].join(';');
  box.textContent = `Face Beautifier self-test\n\n${text}`;
  document.body.appendChild(box);

  if (host && host.state) host.state.selftest = summary;
  return summary;
}
