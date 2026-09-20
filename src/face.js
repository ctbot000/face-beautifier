import { P, IRIS_CENTER_L, IRIS_CENTER_R, JAW_L, JAW_R } from './landmarks.js';

/**
 * Turns raw landmarks into the handful of measurements the shader and the warp
 * builder actually need.
 *
 * Everything is returned in "aspect space": x multiplied by width/height, y
 * left alone. Distances there are isotropic, so one radius means the same
 * thing horizontally and vertically — which is exactly what a circular falloff
 * in the shader assumes.
 */
export function computeFace(pts, aspect) {
  if (!pts) return null;
  const x = (i) => pts[i * 2] * aspect;
  const y = (i) => pts[i * 2 + 1];
  const pt = (i) => [x(i), y(i)];

  const chin = pt(P.chin);
  const brow = pt(P.foreheadTop);
  const faceLeft = pt(P.faceLeft);
  const faceRight = pt(P.faceRight);

  const width = dist(faceLeft, faceRight);
  const height = dist(chin, brow);
  if (!(width > 1e-4) || !(height > 1e-4)) return null;

  // Midline of the face, used as the target every slimming handle pulls toward.
  const axis = norm(sub(chin, brow));

  const eyeL = eyeOf(pt, IRIS_CENTER_L, P.eyeOuterL, P.eyeInnerL, P.eyeLidTopL, P.eyeLidBottomL);
  const eyeR = eyeOf(pt, IRIS_CENTER_R, P.eyeOuterR, P.eyeInnerR, P.eyeLidTopR, P.eyeLidBottomR);

  // The cheek apple sits between the outer eye corner and the mouth corner.
  const cheekL = mid(pt(P.eyeOuterL), pt(P.mouthCornerL));
  const cheekR = mid(pt(P.eyeOuterR), pt(P.mouthCornerR));

  const noseL = pt(P.noseWingL);
  const noseR = pt(P.noseWingR);
  const noseCenter = mid(noseL, noseR);
  const noseWidth = dist(noseL, noseR);

  const lipL = pt(P.mouthCornerL);
  const lipR = pt(P.mouthCornerR);
  const lipCenter = mid(mid(lipL, lipR), mid(pt(P.mouthTop), pt(P.mouthBottom)));
  const lipWidth = dist(lipL, lipR);

  return {
    aspect,
    width,
    height,
    chin,
    brow,
    axis,
    eyeL,
    eyeR,
    cheekL,
    cheekR,
    noseL,
    noseR,
    noseCenter,
    noseWidth,
    lipCenter,
    lipWidth,
    jawL: JAW_L.map(pt),
    jawR: JAW_R.map(pt),
    jawIdxL: JAW_L,
    jawIdxR: JAW_R,
    pt,
  };
}

function eyeOf(pt, irisIdx, outerIdx, innerIdx, topIdx, bottomIdx) {
  const outer = pt(outerIdx);
  const inner = pt(innerIdx);
  const center = pt(irisIdx);
  const w = dist(outer, inner);
  const h = dist(pt(topIdx), pt(bottomIdx));
  return { center, width: w, height: h, outer, inner };
}

/** Distance from a point to the infinite line through a, along unit dir u. */
export function projectOnAxis(p, a, u) {
  const t = (p[0] - a[0]) * u[0] + (p[1] - a[1]) * u[1];
  return [a[0] + u[0] * t, a[1] + u[1] * t];
}

export const sub = (a, b) => [a[0] - b[0], a[1] - b[1]];
export const add = (a, b) => [a[0] + b[0], a[1] + b[1]];
export const mul = (a, s) => [a[0] * s, a[1] * s];
export const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
export const len = (a) => Math.hypot(a[0], a[1]);
export const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export function norm(a) {
  const l = Math.hypot(a[0], a[1]) || 1;
  return [a[0] / l, a[1] / l];
}
