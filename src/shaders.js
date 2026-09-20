/**
 * All GLSL for the pipeline. WebGL2 / GLSL ES 3.00.
 *
 * Colour space note: every pass reads sRGB-encoded texels and writes
 * sRGB-encoded texels. Nothing here linearises, so nothing has to re-encode —
 * the gamma-space blur is exactly the "surface blur" a retouching tool applies
 * and the pipeline never mixes the two conventions.
 */

export const MAX_WARP = 20;

export const VERT = `#version 300 es
precision highp float;

in vec2 aPos;

out vec2 vUv;      // texture space: v = 0 is the top row of the source
out vec2 vScreen;  // display space: 0,0 is the top-left of the viewport

uniform float uMirror;  // 1.0 flips horizontally for a selfie view
uniform float uFlipY;   // 1.0 when drawing to the screen, 0.0 between FBOs

void main() {
  vec2 t = aPos * 0.5 + 0.5;
  vScreen = vec2(t.x, 1.0 - t.y);
  vUv = vec2(mix(t.x, 1.0 - t.x, uMirror), mix(t.y, 1.0 - t.y, uFlipY));
  gl_Position = vec4(aPos, 0.0, 1.0);
}
`;

/** Separable Gaussian, 9 taps folded into 5 bilinear fetches. */
export const BLUR_FRAG = `#version 300 es
precision highp float;

in vec2 vUv;
in vec2 vScreen;
out vec4 fragColor;

uniform sampler2D uTex;
uniform vec2 uStep;   // one tap of travel, in uv units, along one axis

const float W0 = 0.2270270270;
const float W1 = 0.3162162162;
const float W2 = 0.0702702703;
const float O1 = 1.3846153846;
const float O2 = 3.2307692308;

void main() {
  vec3 c = texture(uTex, vUv).rgb * W0;
  c += (texture(uTex, vUv + uStep * O1).rgb + texture(uTex, vUv - uStep * O1).rgb) * W1;
  c += (texture(uTex, vUv + uStep * O2).rgb + texture(uTex, vUv - uStep * O2).rgb) * W2;
  fragColor = vec4(c, 1.0);
}
`;

export const COMPOSITE_FRAG = `#version 300 es
precision highp float;

in vec2 vUv;
in vec2 vScreen;
out vec4 fragColor;

uniform sampler2D uSrc;   // camera frame
uniform sampler2D uFine;  // moderate blur  -> texture smoothing
uniform sampler2D uWide;  // wide blur      -> tone evening, glow, sharpen base
uniform sampler2D uMask;  // r = skin, g = lips, b = eyes + teeth

uniform float uAspect;    // width / height
uniform float uFace;      // 0..1 confidence that landmark data is usable
uniform float uTime;

// --- geometry -------------------------------------------------------------
const int MAX_WARP = ${MAX_WARP};
uniform int  uWarpCount;
uniform vec4 uWarpP[MAX_WARP];  // xy centre (aspect space), z radius, w mode
uniform vec4 uWarpQ[MAX_WARP];  // xy delta (mode 0), z scale k (mode 1)

// --- skin -----------------------------------------------------------------
uniform float uSmooth;
uniform float uTexture;
uniform float uEven;
uniform float uSharpen;

// --- light & colour -------------------------------------------------------
uniform float uBright;
uniform float uWarmth;
uniform float uVibrance;
uniform float uContrast;
uniform float uGlow;
uniform float uVignette;
uniform float uGrain;

// --- features -------------------------------------------------------------
uniform float uEyeBright;
uniform float uUnderEye;
uniform vec3  uLipColor;
uniform float uLipAmount;
uniform vec3  uBlushColor;
uniform float uBlushAmount;

uniform vec4 uEyeL;    // xy centre (aspect space), z radius, w in use
uniform vec4 uEyeR;
uniform vec4 uCheekL;  // xy centre (aspect space), z radius, w in use
uniform vec4 uCheekR;

// --- compare --------------------------------------------------------------
uniform float uCompare;  // split x in display space; < 0 disables

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

float luma(vec3 c) { return dot(c, LUMA); }

vec2 toAspect(vec2 uv) { return vec2(uv.x * uAspect, uv.y); }
vec2 fromAspect(vec2 p) { return vec2(p.x / uAspect, p.y); }

vec3 rgb2ycc(vec3 c) {
  float y = dot(c, vec3(0.299, 0.587, 0.114));
  return vec3(y, (c.b - y) * 0.564 + 0.5, (c.r - y) * 0.713 + 0.5);
}

vec3 ycc2rgb(vec3 v) {
  float cb = v.y - 0.5;
  float cr = v.z - 0.5;
  return vec3(v.x + 1.403 * cr, v.x - 0.344 * cb - 0.714 * cr, v.x + 1.773 * cb);
}

/** Soft-light blend, the W3C/Photoshop form. Keeps the subject's own shading. */
vec3 softLight(vec3 b, vec3 s) {
  vec3 lo = 2.0 * b * s + b * b * (1.0 - 2.0 * s);
  vec3 hi = sqrt(max(b, 0.0)) * (2.0 * s - 1.0) + 2.0 * b * (1.0 - s);
  return mix(lo, hi, step(vec3(0.5), s));
}

/** Loose YCbCr skin-chroma test. Carries the whole mask when no face is found. */
float skinTone(vec3 c) {
  vec3 v = rgb2ycc(c);
  float w = smoothstep(0.30, 0.36, v.y) * (1.0 - smoothstep(0.48, 0.54, v.y));
  w *= smoothstep(0.51, 0.545, v.z) * (1.0 - smoothstep(0.65, 0.70, v.z));
  w *= smoothstep(0.05, 0.16, v.x) * (1.0 - smoothstep(0.93, 1.0, v.x));
  return w;
}

float blob(vec2 p, vec2 c, vec2 r) {
  vec2 d = (p - c) / max(r, vec2(1e-4));
  return 1.0 - smoothstep(0.45, 1.0, length(d));
}

float hash21(vec2 p) {
  p = fract(p * vec2(443.8975, 397.2973));
  p += dot(p, p + 19.19);
  return fract(p.x * p.y);
}

/**
 * Falloff for every warp handle: 1 at the centre, 0 on the circle of radius r,
 * and — the part that matters — zero slope at both ends.
 *
 * The textbook local warp (Gustafsson) uses (r^2-d^2)/(r^2-d^2+|m|^2) squared
 * instead, which is steep at the rim: measured against the axial backward map,
 * it is non-monotonic for every displacement below about 0.55r, folding by as
 * much as 0.05r and leaving a faint ring inside each handle. A falloff that is
 * flat at the rim cannot do that, and stays injective out to |m| = 2r/3.
 */
float warpFalloff(float t) {
  return 1.0 - t * t * (3.0 - 2.0 * t);
}

/**
 * Backward map for the displayed pixel.
 *
 * mode 0 — translation: the pixel at the handle centre takes exactly what was
 * at centre - d, so a handle placed at a feature's destination moves it there.
 * mode 1 — radial scale about the centre; k > 0 magnifies.
 *
 * Handles compose by running the coordinate through each in turn.
 */
vec2 applyWarp(vec2 uv) {
  vec2 p = toAspect(uv);
  for (int i = 0; i < MAX_WARP; i++) {
    if (i >= uWarpCount) break;
    vec4 hp = uWarpP[i];
    vec4 hq = uWarpQ[i];
    vec2 d = p - hp.xy;
    float dd = dot(d, d);
    float rr = hp.z * hp.z;
    if (dd >= rr) continue;
    float fall = warpFalloff(sqrt(dd) / hp.z);
    if (hp.w < 0.5) p -= hq.xy * fall;
    else p = hp.xy + d * (1.0 - hq.z * fall);
  }
  return fromAspect(p);
}

void main() {
  vec3 original = texture(uSrc, vUv).rgb;

  vec2 uv = clamp(applyWarp(vUv), 0.0, 1.0);
  vec2 p = toAspect(uv);

  vec3 src  = texture(uSrc, uv).rgb;
  vec3 fine = texture(uFine, uv).rgb;
  vec3 wide = texture(uWide, uv).rgb;
  vec3 mk   = texture(uMask, uv).rgb;

  float tone = skinTone(src);
  // With landmarks the face polygon decides; the chroma test only vetoes
  // things inside it that are plainly not skin (frames, beards, shadow).
  float skin = mix(tone * 0.9, mk.r * mix(0.45, 1.0, tone), uFace);

  // ---- texture smoothing: keep the big edges, flatten the small stuff ----
  vec3 detail = src - fine;
  float edge = smoothstep(0.030, 0.115, abs(dot(detail, LUMA)));
  float amount = uSmooth * skin;
  float keep = mix(mix(1.0 - amount, 1.0, uTexture * 0.85), 1.0, edge);
  vec3 col = fine + detail * keep;

  // ---- even tone: lift dark spots, borrow the surrounding chroma ----------
  if (uEven > 0.001) {
    vec3 cv = rgb2ycc(col);
    vec3 wv = rgb2ycc(wide);
    float spot = smoothstep(0.0, -0.055, cv.x - wv.x);
    float lifted = mix(cv.x, wv.x, spot * 0.85);
    float k = uEven * skin;
    vec3 out_ycc = vec3(
      mix(cv.x, lifted, k),
      mix(cv.y, wv.y, k * 0.7),
      mix(cv.z, wv.z, k * 0.7));
    col = ycc2rgb(out_ycc);
  }

  // ---- sharpen what we did not smooth ------------------------------------
  if (uSharpen > 0.001) {
    col += (src - wide) * uSharpen * (1.0 - amount * 0.85);
  }

  // ---- under-eye lift -----------------------------------------------------
  if (uUnderEye > 0.001 && uFace > 0.01) {
    float ue =
      blob(p, uEyeL.xy + vec2(0.0, uEyeL.z * 0.95), vec2(uEyeL.z * 1.15, uEyeL.z * 0.85)) * uEyeL.w +
      blob(p, uEyeR.xy + vec2(0.0, uEyeR.z * 0.95), vec2(uEyeR.z * 1.15, uEyeR.z * 0.85)) * uEyeR.w;
    ue = clamp(ue, 0.0, 1.0) * uUnderEye * uFace;
    vec3 cv = rgb2ycc(col);
    vec3 lift = ycc2rgb(vec3(cv.x + (1.0 - cv.x) * 0.22, mix(cv.y, 0.5, 0.25), mix(cv.z, 0.5, 0.3)));
    col = mix(col, lift, ue * (1.0 - smoothstep(0.55, 0.85, cv.x)));
  }

  // ---- eyes and teeth ------------------------------------------------------
  float eyeM = mk.b * uEyeBright * uFace;
  if (eyeM > 0.001) {
    vec3 cv = rgb2ycc(col);
    float whites = smoothstep(0.26, 0.62, cv.x);
    float iris = 1.0 - smoothstep(0.14, 0.42, cv.x);
    vec3 whiter = ycc2rgb(vec3(
      min(1.0, cv.x + 0.20 * eyeM),
      mix(cv.y, 0.5, 0.8),
      mix(cv.z, 0.5, 0.8)));
    col = mix(col, whiter, eyeM * whites);
    vec3 deeper = ycc2rgb(vec3(clamp((cv.x - 0.42) * 1.35 + 0.42, 0.0, 1.0), cv.y, cv.z));
    col = mix(col, deeper, eyeM * iris * 0.7);
  }

  // ---- lips ----------------------------------------------------------------
  float lipM = mk.g * uLipAmount * uFace;
  if (lipM > 0.001) {
    vec3 cv = rgb2ycc(col);
    vec3 tv = rgb2ycc(uLipColor);
    vec3 tinted = ycc2rgb(vec3(
      cv.x * mix(1.0, 0.93, lipM),
      mix(cv.y, tv.y, 0.92),
      mix(cv.z, tv.z, 0.92)));
    col = mix(col, tinted, lipM);
    float gloss = smoothstep(0.62, 0.95, luma(src));
    col += vec3(gloss * lipM * 0.22);
  }

  // ---- blush ---------------------------------------------------------------
  if (uBlushAmount > 0.001 && uFace > 0.01) {
    float b =
      blob(p, uCheekL.xy, vec2(uCheekL.z, uCheekL.z * 0.78)) * uCheekL.w +
      blob(p, uCheekR.xy, vec2(uCheekR.z, uCheekR.z * 0.78)) * uCheekR.w;
    b = clamp(b, 0.0, 1.0) * uBlushAmount * uFace * max(skin, 0.35);
    col = mix(col, softLight(clamp(col, 0.0, 1.0), uBlushColor), b);
  }

  // ---- global light and colour --------------------------------------------
  if (uGlow > 0.001) {
    vec3 screenBlend = 1.0 - (1.0 - col) * (1.0 - wide * 0.75);
    col = mix(col, screenBlend, uGlow * 0.55);
  }

  col = uBright >= 0.0 ? col + uBright * (1.0 - col) * 0.9 : col * (1.0 + uBright);
  col *= vec3(1.0 + uWarmth * 0.085, 1.0 + uWarmth * 0.012, 1.0 - uWarmth * 0.085);

  if (abs(uVibrance) > 0.001) {
    float mx = max(col.r, max(col.g, col.b));
    float mn = min(col.r, min(col.g, col.b));
    col = mix(vec3(luma(col)), col, 1.0 + uVibrance * (1.0 - (mx - mn)));
  }
  if (abs(uContrast) > 0.001) {
    col = (col - 0.5) * (1.0 + uContrast) + 0.5;
  }

  if (uVignette > 0.001) {
    float r = length(vScreen - 0.5) * 1.4142;
    col *= 1.0 - uVignette * smoothstep(0.45, 1.05, r);
  }
  if (uGrain > 0.001) {
    col += (hash21(vScreen * 1024.0 + fract(uTime) * 91.7) - 0.5) * uGrain * 0.11;
  }

  col = clamp(col, 0.0, 1.0);

  // ---- before / after split ------------------------------------------------
  if (uCompare >= 0.0) {
    float t = smoothstep(uCompare - 0.0009, uCompare + 0.0009, vScreen.x);
    col = mix(original, col, t);
  }

  fragColor = vec4(col, 1.0);
}
`;

/** Debug view: draws the landmark mask straight to the screen. */
export const MASK_FRAG = `#version 300 es
precision highp float;
in vec2 vUv;
in vec2 vScreen;
out vec4 fragColor;
uniform sampler2D uSrc;
uniform sampler2D uMask;
void main() {
  vec3 src = texture(uSrc, vUv).rgb;
  vec3 mk = texture(uMask, vUv).rgb;
  fragColor = vec4(mix(src * 0.45, src * 0.45 + mk * 0.85, min(1.0, mk.r + mk.g + mk.b)), 1.0);
}
`;
