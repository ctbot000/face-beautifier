import { projectOnAxis, sub, mul, norm, len } from './face.js';

/** How far each handle down the jaw pulls, from the temple to just above the chin. */
const JAW_PROFILE = [0.45, 0.85, 1.0, 0.95, 0.72];
/** Which entries of JAW_L / JAW_R those weights belong to. */
const JAW_PICK = [1, 3, 4, 6, 7];

/**
 * Builds the list of local warp handles for one frame.
 *
 * mode 0 — local translation: the pixel at `c + d` takes what was at `c`.
 * mode 1 — radial scale about `c`: `k > 0` magnifies.
 *
 * Each handle's displacement is capped well below its own radius; past roughly
 * half the radius Gustafsson's falloff folds the map over itself and the image
 * tears.
 */
export function buildWarps(face, p) {
  const out = [];
  if (!face) return out;

  const { width, height, axis, chin, brow } = face;

  if (p.slim > 0.001) {
    const radius = width * 0.30;
    for (const points of [face.jawL, face.jawR]) {
      for (let i = 0; i < JAW_PICK.length; i++) {
        const q = points[JAW_PICK[i]];
        if (!q) continue;
        const target = projectOnAxis(q, brow, axis);
        const dir = sub(target, q);
        const d = mul(norm(dir), Math.min(len(dir) * 0.9, width * 0.16 * p.slim * JAW_PROFILE[i]));
        push(out, { cx: q[0], cy: q[1], r: radius, mode: 0, dx: d[0], dy: d[1] });
      }
    }
  }

  if (Math.abs(p.chin) > 0.001) {
    // Positive shortens: the chin travels back up the face axis.
    const d = mul(axis, -p.chin * height * 0.085);
    push(out, { cx: chin[0], cy: chin[1], r: width * 0.34, mode: 0, dx: d[0], dy: d[1] });
  }

  if (p.eyes > 0.001) {
    for (const eye of [face.eyeL, face.eyeR]) {
      push(out, {
        cx: eye.center[0],
        cy: eye.center[1],
        r: Math.max(eye.width * 1.35, width * 0.10),
        mode: 1,
        k: p.eyes * 0.20,
      });
    }
  }

  if (p.nose > 0.001) {
    const pull = p.nose * 0.30;
    for (const wing of [face.noseL, face.noseR]) {
      const dir = sub(face.noseCenter, wing);
      const d = mul(dir, pull);
      push(out, {
        cx: wing[0],
        cy: wing[1],
        r: Math.max(face.noseWidth * 1.0, width * 0.07),
        mode: 0,
        dx: d[0],
        dy: d[1],
      });
    }
  }

  if (Math.abs(p.lips) > 0.001) {
    push(out, {
      cx: face.lipCenter[0],
      cy: face.lipCenter[1],
      r: Math.max(face.lipWidth * 0.85, width * 0.12),
      mode: 1,
      k: p.lips * 0.13,
    });
  }

  return out;
}

function push(out, h) {
  if (!(h.r > 1e-5)) return;
  if (h.mode === 0) {
    const d = Math.hypot(h.dx, h.dy);
    if (d < 1e-6) return;
    const cap = h.r * 0.45;
    if (d > cap) {
      h.dx *= cap / d;
      h.dy *= cap / d;
    }
  } else if (Math.abs(h.k) < 1e-5) {
    return;
  }
  out.push(h);
}

/**
 * Per-face uniforms for the effects that are analytic rather than masked:
 * eye blobs (under-eye lift) and cheek blobs (blush).
 */
export function faceUniforms(face, confidence) {
  if (!face || confidence <= 0) {
    return {
      confidence: 0,
      eyeL: [0, 0, 0.001, 0],
      eyeR: [0, 0, 0.001, 0],
      cheekL: [0, 0, 0.001, 0],
      cheekR: [0, 0, 0.001, 0],
    };
  }
  const lidL = Math.max(face.eyeL.width, 1e-4) * 0.62;
  const lidR = Math.max(face.eyeR.width, 1e-4) * 0.62;
  const cheekRadius = face.width * 0.19;
  return {
    confidence,
    eyeL: [face.eyeL.center[0], face.eyeL.center[1], lidL, 1],
    eyeR: [face.eyeR.center[0], face.eyeR.center[1], lidR, 1],
    cheekL: [face.cheekL[0], face.cheekL[1], cheekRadius, 1],
    cheekR: [face.cheekR[0], face.cheekR[1], cheekRadius, 1],
  };
}

/**
 * Smoothing radius in half-resolution texels. Scaling it with the measured
 * face keeps the effect identical whether the subject is close or far; a fixed
 * radius smooths a distant face into paste and barely touches a near one.
 */
export function blurScaleFor(face, heightPx, radiusSlider) {
  const base = face
    ? face.width * heightPx * 0.0125
    : heightPx * 0.0034;
  return clamp(base, 1.1, 10) * radiusSlider;
}

export const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
