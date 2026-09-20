/**
 * Slider definitions, colour swatches and presets.
 *
 * Slider values are the human numbers shown in the panel (0..100, or -100..100
 * for the ones that cut as well as add). `toShader` is the single place that
 * maps them into the units the fragment shader expects, so a range can be
 * retuned here without touching the GLSL.
 */

export const GROUPS = [
  {
    id: 'skin',
    title: 'Skin',
    controls: [
      { key: 'smooth', label: 'Smooth', min: 0, max: 100, def: 45 },
      { key: 'texture', label: 'Keep texture', min: 0, max: 100, def: 30 },
      { key: 'even', label: 'Even tone', min: 0, max: 100, def: 35 },
      { key: 'radius', label: 'Smoothing scale', min: 0, max: 100, def: 50 },
      { key: 'sharpen', label: 'Detail', min: 0, max: 100, def: 20 },
    ],
  },
  {
    id: 'shape',
    title: 'Face shape',
    controls: [
      { key: 'slim', label: 'Slim face', min: 0, max: 100, def: 0 },
      { key: 'chin', label: 'Chin', min: -100, max: 100, def: 0 },
      { key: 'eyes', label: 'Eye size', min: 0, max: 100, def: 0 },
      { key: 'nose', label: 'Nose', min: 0, max: 100, def: 0 },
      { key: 'lips', label: 'Lip size', min: -100, max: 100, def: 0 },
    ],
  },
  {
    id: 'makeup',
    title: 'Eyes & lips',
    controls: [
      { key: 'eyeBright', label: 'Eye & teeth whiten', min: 0, max: 100, def: 25 },
      { key: 'underEye', label: 'Under-eye lift', min: 0, max: 100, def: 25 },
      { key: 'lipAmount', label: 'Lip tint', min: 0, max: 100, def: 0, swatch: 'lip' },
      { key: 'blushAmount', label: 'Blush', min: 0, max: 100, def: 0, swatch: 'blush' },
    ],
  },
  {
    id: 'light',
    title: 'Light & colour',
    controls: [
      { key: 'bright', label: 'Brightness', min: -100, max: 100, def: 6 },
      { key: 'warmth', label: 'Warmth', min: -100, max: 100, def: 4 },
      { key: 'vibrance', label: 'Vibrance', min: -100, max: 100, def: 6 },
      { key: 'contrast', label: 'Contrast', min: -100, max: 100, def: 0 },
      { key: 'glow', label: 'Soft glow', min: 0, max: 100, def: 0 },
      { key: 'vignette', label: 'Vignette', min: 0, max: 100, def: 0 },
      { key: 'grain', label: 'Grain', min: 0, max: 100, def: 0 },
    ],
  },
];

export const SWATCHES = {
  lip: [
    { name: 'Rose', hex: '#c4485f' },
    { name: 'Coral', hex: '#e0624a' },
    { name: 'Red', hex: '#cf2233' },
    { name: 'Berry', hex: '#96305a' },
    { name: 'Nude', hex: '#b9736a' },
    { name: 'Plum', hex: '#7c3557' },
  ],
  blush: [
    { name: 'Peach', hex: '#ff9f80' },
    { name: 'Rose', hex: '#ff8098' },
    { name: 'Coral', hex: '#ff8a6b' },
    { name: 'Mauve', hex: '#d98fb0' },
  ],
};

export const DEFAULT_COLORS = { lip: '#c4485f', blush: '#ff9f80' };

export const PRESETS = [
  { id: 'off', name: 'Off', values: zeroed() },
  {
    id: 'natural',
    name: 'Natural',
    values: {
      smooth: 38, texture: 35, even: 30, radius: 50, sharpen: 18,
      eyeBright: 22, underEye: 25,
      bright: 8, warmth: 6, vibrance: 6,
    },
  },
  {
    id: 'glow',
    name: 'Glow',
    values: {
      smooth: 55, texture: 25, even: 45, radius: 55, sharpen: 14,
      eyeBright: 30, underEye: 35, lipAmount: 18, blushAmount: 22,
      bright: 16, warmth: 14, vibrance: 14, glow: 28,
    },
  },
  {
    id: 'porcelain',
    name: 'Porcelain',
    values: {
      smooth: 78, texture: 12, even: 62, radius: 62, sharpen: 10,
      eyeBright: 35, underEye: 45,
      bright: 20, warmth: -4, vibrance: -6, glow: 18, vignette: 18,
    },
  },
  {
    id: 'glam',
    name: 'Glam',
    values: {
      smooth: 60, texture: 22, even: 50, radius: 55, sharpen: 22,
      slim: 45, chin: 20, eyes: 35, nose: 25,
      eyeBright: 45, underEye: 45, lipAmount: 55, blushAmount: 35,
      bright: 10, warmth: 6, vibrance: 16, contrast: 12,
    },
  },
  {
    id: 'doll',
    name: 'Doll',
    values: {
      smooth: 72, texture: 16, even: 55, radius: 60, sharpen: 12,
      slim: 58, chin: 26, eyes: 46, nose: 32, lips: 12,
      eyeBright: 42, underEye: 50, lipAmount: 42, blushAmount: 32,
      bright: 18, warmth: 8, vibrance: 10, glow: 22,
    },
  },
];

function zeroed() {
  const v = {};
  for (const g of GROUPS) for (const c of g.controls) v[c.key] = 0;
  v.texture = 100; // "keep all texture" is the identity, not zero
  v.radius = 50;
  return v;
}

export function defaults() {
  const v = {};
  for (const g of GROUPS) for (const c of g.controls) v[c.key] = c.def;
  return v;
}

export function allControls() {
  return GROUPS.flatMap((g) => g.controls);
}

const u = (v) => v / 100;              // 0..100  -> 0..1
const s = (v) => v / 100;              // -100..100 -> -1..1

/** Maps panel values + colours into the uniform values the shader consumes. */
export function toShader(v, colors) {
  return {
    smooth: u(v.smooth),
    texture: u(v.texture),
    even: u(v.even),
    sharpen: u(v.sharpen) * 0.6,
    radius: 0.5 + u(v.radius) * 1.5,

    slim: u(v.slim),
    chin: s(v.chin),
    eyes: u(v.eyes),
    nose: u(v.nose),
    lips: s(v.lips),

    eyeBright: u(v.eyeBright),
    underEye: u(v.underEye),
    lipAmount: u(v.lipAmount) * 0.92,
    blushAmount: u(v.blushAmount) * 0.85,
    lipColor: hexToRgb(colors.lip),
    blushColor: hexToRgb(colors.blush),

    bright: s(v.bright) * 0.45,
    warmth: s(v.warmth),
    vibrance: s(v.vibrance) * 0.6,
    contrast: s(v.contrast) * 0.4,
    glow: u(v.glow),
    vignette: u(v.vignette) * 0.6,
    grain: u(v.grain),
  };
}

export function hexToRgb(hex) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((c) => c + c).join('') : h, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}
