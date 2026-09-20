import { Renderer, ShaderError } from './renderer.js';
import { FaceMesh } from './facemesh.js';
import { MaskPainter } from './mask.js';
import { computeFace } from './face.js';
import { buildWarps, faceUniforms, blurScaleFor } from './warp.js';
import {
  GROUPS, SWATCHES, PRESETS, DEFAULT_COLORS, defaults, allControls, toShader,
} from './controls.js';

const el = (id) => document.getElementById(id);

const state = {
  values: defaults(),
  colors: { ...DEFAULT_COLORS },
  preset: 'natural',
  mirror: true,
  mode: 'idle',          // idle | camera | photo
  showMask: false,
  splitOn: false,
  split: 0.5,
  holdCompare: false,
  detectEvery: 1,
  frame: 0,
  fps: 0,
  recording: null,
};

let renderer = null;
let mesh = null;
let painter = null;
let video = null;
let photo = null;
let stream = null;
let rafId = 0;
let lastFrameTime = 0;

boot();

/* ------------------------------------------------------------------ boot */

function boot() {
  buildPanel();
  applyPreset('natural');

  try {
    renderer = new Renderer(el('view'));
  } catch (err) {
    fatal(err instanceof ShaderError ? err.message : String(err));
    return;
  }

  painter = new MaskPainter(320);
  mesh = new FaceMesh();

  video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.setAttribute('playsinline', '');
  video.autoplay = true;
  video.style.display = 'none';
  document.body.appendChild(video);

  wireButtons();
  wireCompare();
  layout();
  window.addEventListener('resize', layout);
  document.addEventListener('visibilitychange', () => {
    // Discrete state has to reach the DOM from the handler: a hidden page
    // stops delivering frames, so the render loop cannot paint this.
    if (document.hidden && state.mode !== 'idle') setStatus('Paused (tab hidden)', 'busy');
    else if (state.mode === 'camera') setStatus('Live', 'live');
    else if (state.mode === 'photo') setStatus('Photo', 'live');
  });

  loop(performance.now());

  if (new URLSearchParams(location.search).has('selftest')) {
    import('./selftest.js').then((m) => m.run({ renderer, painter, state }));
  }
}

function fatal(message) {
  el('overlay').hidden = false;
  el('overlay-title').textContent = 'This browser cannot run the filter';
  el('overlay-text').textContent = message;
  el('btn-start').disabled = true;
  el('btn-photo').disabled = true;
  setStatus('Unsupported', 'error');
}

/* ------------------------------------------------------------------- UI */

function buildPanel() {
  const groups = el('groups');
  for (const group of GROUPS) {
    const box = document.createElement('section');
    box.className = 'group';
    box.innerHTML = `<h3>${group.title}</h3>`;
    for (const c of group.controls) {
      box.appendChild(makeSlider(c));
      if (c.swatch) box.appendChild(makeSwatches(c.swatch));
    }
    groups.appendChild(box);
  }

  const row = el('preset-row');
  for (const p of PRESETS) {
    const b = document.createElement('button');
    b.className = 'preset';
    b.type = 'button';
    b.textContent = p.name;
    b.dataset.preset = p.id;
    b.setAttribute('aria-pressed', 'false');
    b.addEventListener('click', () => applyPreset(p.id));
    row.appendChild(b);
  }
}

function makeSlider(c) {
  const wrap = document.createElement('div');
  wrap.className = 'ctl';
  wrap.innerHTML = `
    <div class="ctl-head">
      <label for="s-${c.key}">${c.label}</label>
      <span class="val" id="v-${c.key}">0</span>
    </div>
    <input id="s-${c.key}" type="range" min="${c.min}" max="${c.max}" step="1" value="${c.def}">`;
  const input = wrap.querySelector('input');
  input.addEventListener('input', () => {
    state.values[c.key] = Number(input.value);
    markCustomPreset();
    syncSlider(c);
  });
  return wrap;
}

function makeSwatches(kind) {
  const box = document.createElement('div');
  box.className = 'swatches';
  box.dataset.swatch = kind;
  for (const sw of SWATCHES[kind]) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch';
    b.style.background = sw.hex;
    b.title = sw.name;
    b.setAttribute('aria-label', `${kind} colour: ${sw.name}`);
    b.dataset.hex = sw.hex;
    b.addEventListener('click', () => {
      state.colors[kind] = sw.hex;
      syncSwatches();
    });
    box.appendChild(b);
  }
  return box;
}

function syncSlider(c) {
  const v = state.values[c.key];
  const input = el(`s-${c.key}`);
  if (input && Number(input.value) !== v) input.value = String(v);
  const out = el(`v-${c.key}`);
  if (out) out.textContent = c.min < 0 && v > 0 ? `+${v}` : String(v);
  if (input) {
    const pct = ((v - c.min) / (c.max - c.min)) * 100;
    input.style.setProperty('--fill', `${pct}%`);
  }
}

function syncSwatches() {
  for (const box of document.querySelectorAll('.swatches')) {
    const kind = box.dataset.swatch;
    for (const b of box.children) {
      b.setAttribute('aria-pressed', String(b.dataset.hex === state.colors[kind]));
    }
  }
}

function syncPresetButtons() {
  for (const b of el('preset-row').children) {
    b.setAttribute('aria-pressed', String(b.dataset.preset === state.preset));
  }
}

function applyPreset(id) {
  const preset = PRESETS.find((p) => p.id === id);
  if (!preset) return;
  const base = {};
  for (const c of allControls()) base[c.key] = 0;
  base.texture = 100;
  base.radius = 50;
  state.values = { ...base, ...preset.values };
  state.preset = id;
  for (const c of allControls()) syncSlider(c);
  syncPresetButtons();
  syncSwatches();
}

function markCustomPreset() {
  if (state.preset !== 'custom') {
    state.preset = 'custom';
    syncPresetButtons();
  }
}

function setStatus(text, kind = 'idle') {
  const s = el('status');
  s.textContent = text;
  s.dataset.state = kind;
}

let toastTimer = 0;
function toast(message) {
  const t = el('toast');
  t.textContent = message;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

function setLoader(text) {
  const l = el('loader');
  if (!text) { l.hidden = true; return; }
  el('loader-text').textContent = text;
  l.hidden = false;
}

/* -------------------------------------------------------------- buttons */

function wireButtons() {
  el('btn-start').addEventListener('click', () => startCamera());
  el('btn-photo').addEventListener('click', () => el('file-input').click());
  el('file-input').addEventListener('change', (e) => {
    const file = e.target.files && e.target.files[0];
    if (file) loadPhoto(file);
    e.target.value = '';
  });

  const mirror = el('btn-mirror');
  mirror.addEventListener('click', () => {
    state.mirror = !state.mirror;
    mirror.setAttribute('aria-pressed', String(state.mirror));
  });

  const maskBtn = el('btn-mesh');
  maskBtn.addEventListener('click', () => {
    state.showMask = !state.showMask;
    maskBtn.setAttribute('aria-pressed', String(state.showMask));
  });

  const split = el('btn-split');
  split.addEventListener('click', () => {
    state.splitOn = !state.splitOn;
    split.setAttribute('aria-pressed', String(state.splitOn));
    el('compare-handle').hidden = !state.splitOn;
    layout();
  });

  const cmp = el('btn-compare');
  const down = () => { state.holdCompare = true; };
  const up = () => { state.holdCompare = false; };
  cmp.addEventListener('pointerdown', down);
  cmp.addEventListener('pointerup', up);
  cmp.addEventListener('pointerleave', up);
  cmp.addEventListener('pointercancel', up);
  window.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 'c' && !e.repeat && !isTyping(e)) down();
  });
  window.addEventListener('keyup', (e) => {
    if (e.key.toLowerCase() === 'c') up();
  });

  el('btn-shot').addEventListener('click', () => { pendingShot = true; });
  el('btn-rec').addEventListener('click', toggleRecording);
  el('btn-reset').addEventListener('click', () => {
    state.values = defaults();
    state.colors = { ...DEFAULT_COLORS };
    state.preset = 'custom';
    for (const c of allControls()) syncSlider(c);
    syncPresetButtons();
    syncSwatches();
    toast('Sliders reset');
  });

  el('quality-select').addEventListener('change', () => {
    if (state.mode === 'camera') startCamera();
  });
  el('camera-select').addEventListener('change', () => {
    if (state.mode === 'camera') startCamera();
  });

  const panelBtn = el('btn-panel');
  panelBtn.addEventListener('click', () => {
    const panel = el('panel');
    panel.hidden = !panel.hidden;
    panelBtn.setAttribute('aria-expanded', String(!panel.hidden));
  });
}

function isTyping(e) {
  const t = e.target;
  return t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA');
}

function wireCompare() {
  const handle = el('compare-handle');
  const grip = handle.querySelector('.compare-grip');
  let dragging = false;

  const move = (clientX) => {
    const rect = handle.getBoundingClientRect();
    if (rect.width <= 0) return;
    state.split = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    handle.style.setProperty('--split', `${state.split * 100}%`);
    grip.setAttribute('aria-valuenow', String(Math.round(state.split * 100)));
  };

  grip.addEventListener('pointerdown', (e) => {
    dragging = true;
    grip.setPointerCapture(e.pointerId);
  });
  grip.addEventListener('pointermove', (e) => { if (dragging) move(e.clientX); });
  grip.addEventListener('pointerup', (e) => {
    dragging = false;
    grip.releasePointerCapture(e.pointerId);
  });
  grip.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 0.1 : 0.02;
    if (e.key === 'ArrowLeft') state.split = Math.max(0, state.split - step);
    else if (e.key === 'ArrowRight') state.split = Math.min(1, state.split + step);
    else return;
    e.preventDefault();
    handle.style.setProperty('--split', `${state.split * 100}%`);
    grip.setAttribute('aria-valuenow', String(Math.round(state.split * 100)));
  });
  handle.style.setProperty('--split', '50%');
}

/* --------------------------------------------------------------- camera */

async function startCamera() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    el('overlay-note').textContent = window.isSecureContext
      ? 'This browser has no camera API.'
      : 'Camera access needs https:// or localhost. Open the page from a local server.';
    return;
  }

  stopStream();
  setStatus('Starting camera…', 'busy');
  el('overlay-note').textContent = '';

  const width = Number(el('quality-select').value) || 1280;
  const deviceId = el('camera-select').value;
  const constraints = {
    audio: false,
    video: {
      width: { ideal: width },
      height: { ideal: Math.round((width * 9) / 16) },
      frameRate: { ideal: 30 },
      ...(deviceId ? { deviceId: { exact: deviceId } } : { facingMode: 'user' }),
    },
  };

  try {
    stream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    setStatus('Camera blocked', 'error');
    el('overlay').hidden = false;
    el('overlay-note').textContent = cameraErrorText(err);
    return;
  }

  photo = null;
  video.srcObject = stream;
  await video.play().catch(() => {});
  await waitForVideo(video);

  state.mode = 'camera';
  state.mirror = true;
  el('btn-mirror').setAttribute('aria-pressed', 'true');
  el('overlay').hidden = true;
  el('fps').hidden = false;
  setStatus('Live', 'live');
  await listCameras();
  layout();
  ensureMesh();
}

function cameraErrorText(err) {
  switch (err && err.name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return 'Camera permission was denied. Allow it in the browser’s site settings and press Start again.';
    case 'NotFoundError':
    case 'OverconstrainedError':
      return 'No camera matched that request. Try a different camera or a lower quality.';
    case 'NotReadableError':
      return 'The camera is already in use by another app.';
    default:
      return `Could not start the camera: ${err && err.message ? err.message : err}`;
  }
}

function waitForVideo(v) {
  if (v.videoWidth > 0) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => { v.removeEventListener('loadeddata', done); resolve(); };
    v.addEventListener('loadeddata', done);
    setTimeout(resolve, 4000);
  });
}

async function listCameras() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter((d) => d.kind === 'videoinput');
    if (cams.length < 2) return;
    const sel = el('camera-select');
    const current = sel.value;
    sel.innerHTML = '';
    cams.forEach((c, i) => {
      const o = document.createElement('option');
      o.value = c.deviceId;
      o.textContent = c.label || `Camera ${i + 1}`;
      sel.appendChild(o);
    });
    const active = stream?.getVideoTracks()[0]?.getSettings?.().deviceId;
    sel.value = current || active || cams[0].deviceId;
  } catch { /* labels need permission; not worth reporting */ }
}

function stopStream() {
  if (stream) {
    for (const t of stream.getTracks()) t.stop();
    stream = null;
  }
}

async function loadPhoto(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    stopStream();
    video.srcObject = null;
    photo = img;
    state.mode = 'photo';
    state.mirror = false;
    el('btn-mirror').setAttribute('aria-pressed', 'false');
    el('overlay').hidden = true;
    el('fps').hidden = true;
    setStatus('Photo', 'live');
    layout();
    await ensureMesh();
    if (mesh.ready) await mesh.detectStill(img);
  } catch {
    toast('Could not read that image');
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function ensureMesh() {
  if (mesh.status === 'ready' || mesh.status === 'loading') return;
  setLoader('Loading face model…');
  const result = await mesh.load((text) => setLoader(text));
  setLoader(null);
  if (result === 'failed') {
    toast('Face model unavailable — using skin-tone detection only');
  }
}

/* --------------------------------------------------------------- layout */

function layout() {
  const source = currentSource();
  if (!renderer || !source) return;
  renderer.resize(source.width, source.height);
  painter.setAspect(source.width / Math.max(1, source.height));

  // Keep the split overlay exactly on the canvas, which is letterboxed inside
  // its wrapper whenever the stage and the frame have different shapes.
  const canvas = el('view');
  const handle = el('compare-handle');
  const parent = canvas.parentElement;
  const cr = canvas.getBoundingClientRect();
  const pr = parent.getBoundingClientRect();
  if (cr.width > 0 && pr.width > 0) {
    handle.style.left = `${cr.left - pr.left}px`;
    handle.style.top = `${cr.top - pr.top}px`;
    handle.style.width = `${cr.width}px`;
    handle.style.height = `${cr.height}px`;
    handle.style.right = 'auto';
    handle.style.bottom = 'auto';
  }
}

function currentSource() {
  if (state.mode === 'photo' && photo) {
    return { el: photo, width: photo.naturalWidth, height: photo.naturalHeight };
  }
  if (state.mode === 'camera' && video.videoWidth > 0) {
    return { el: video, width: video.videoWidth, height: video.videoHeight };
  }
  return null;
}

/* ----------------------------------------------------------- main  loop */

let pendingShot = false;
let lastLayoutSize = '';

function loop(now) {
  rafId = requestAnimationFrame(loop);

  const source = currentSource();
  if (!renderer || !source) return;

  const sizeKey = `${source.width}x${source.height}`;
  if (sizeKey !== lastLayoutSize) {
    lastLayoutSize = sizeKey;
    layout();
  }

  const dt = now - lastFrameTime;
  lastFrameTime = now;
  if (dt > 0 && dt < 500) {
    state.fps = state.fps ? state.fps * 0.9 + (1000 / dt) * 0.1 : 1000 / dt;
    if (state.frame % 10 === 0 && state.mode === 'camera') {
      el('fps').textContent = `${Math.round(state.fps)} fps`;
      // Landmark detection is the only thing here we can afford to run less
      // often, so it is what gives way when the GPU cannot keep up.
      state.detectEvery = state.fps < 22 ? 3 : state.fps < 30 ? 2 : 1;
    }
  }
  state.frame++;

  renderer.uploadSource(source.el, source.width, source.height);

  if (state.mode === 'camera' && mesh.ready && state.frame % state.detectEvery === 0) {
    mesh.detect(video, now);
  }

  const aspect = source.width / Math.max(1, source.height);
  const points = mesh.presence > 0 ? mesh.points : null;
  const face = computeFace(points, aspect);

  renderer.uploadMask(points ? painter.paint(points) : painter.clear());

  const params = toShader(state.values, state.colors);
  const warps = buildWarps(face, params);
  const uniforms = faceUniforms(face, points ? mesh.presence : 0);

  const compare = state.holdCompare ? 1.2 : state.splitOn ? state.split : -1;

  renderer.render({
    params,
    warps,
    face: uniforms,
    blurScale: blurScaleFor(face, source.height, params.radius),
    mirror: state.mirror ? 1 : 0,
    compare,
    showMask: state.showMask,
    time: now / 1000,
  });

  if (pendingShot) {
    pendingShot = false;
    saveSnapshot();
  }
}

/* ------------------------------------------------------ export & record */

function saveSnapshot() {
  el('view').toBlob((blob) => {
    if (!blob) { toast('Snapshot failed'); return; }
    const a = el('dl');
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = `face-beautifier-${stamp()}.png`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
    toast('Snapshot saved');
  }, 'image/png');
}

function toggleRecording() {
  const btn = el('btn-rec');
  if (state.recording) {
    state.recording.stop();
    return;
  }
  if (typeof MediaRecorder === 'undefined' || !el('view').captureStream) {
    toast('Recording is not supported in this browser');
    return;
  }
  const mime = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm', 'video/mp4']
    .find((m) => MediaRecorder.isTypeSupported(m));
  if (!mime) { toast('No supported recording format'); return; }

  const chunks = [];
  const rec = new MediaRecorder(el('view').captureStream(30), {
    mimeType: mime,
    videoBitsPerSecond: 6_000_000,
  });
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  rec.onstop = () => {
    state.recording = null;
    btn.textContent = 'Record';
    btn.classList.remove('recording');
    const blob = new Blob(chunks, { type: mime });
    const a = el('dl');
    const url = URL.createObjectURL(blob);
    a.href = url;
    a.download = `face-beautifier-${stamp()}.${mime.includes('mp4') ? 'mp4' : 'webm'}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
    toast('Recording saved');
  };
  rec.start(250);
  state.recording = rec;
  btn.textContent = 'Stop';
  btn.classList.add('recording');
}

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

window.addEventListener('pagehide', () => {
  cancelAnimationFrame(rafId);
  stopStream();
});

// Exposed for the self-test page and for poking at the pipeline in a console.
window.__faceBeautifier = {
  get renderer() { return renderer; },
  get mesh() { return mesh; },
  get painter() { return painter; },
  state,
};
