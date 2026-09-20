import { VERT, BLUR_FRAG, COMPOSITE_FRAG, MASK_FRAG, MAX_WARP } from './shaders.js';

export class ShaderError extends Error {}

/**
 * Five-pass GPU pipeline.
 *
 *   src ──► blur H ──► blur V ──► fine   (half resolution)
 *                       └──────► blur H ──► blur V ──► wide  (quarter resolution)
 *   src + fine + wide + mask ──► composite ──► canvas
 *
 * `fine` carries the frequency split that does the smoothing; `wide` is the
 * low-frequency reference that tone evening, the unsharp mask and the glow all
 * read from. Both are cheap because they are computed below full resolution.
 */
export class Renderer {
  constructor(canvas) {
    const gl = canvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      desynchronized: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: false,
    });
    if (!gl) throw new ShaderError('WebGL2 is not available in this browser.');

    this.gl = gl;
    this.canvas = canvas;
    this.width = 0;
    this.height = 0;

    this.programs = {
      blur: buildProgram(gl, VERT, BLUR_FRAG),
      composite: buildProgram(gl, VERT, COMPOSITE_FRAG),
      mask: buildProgram(gl, VERT, MASK_FRAG),
    };

    this.quad = gl.createVertexArray();
    gl.bindVertexArray(this.quad);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    this.srcTex = createTexture(gl);
    this.maskTex = createTexture(gl);
    this.srcSize = [0, 0];
    this.maskSize = [0, 0];

    this.targets = { halfA: null, halfB: null, quarterA: null, quarterB: null };

    this.warpP = new Float32Array(MAX_WARP * 4);
    this.warpQ = new Float32Array(MAX_WARP * 4);
  }

  /** Sizes the drawing buffer and the intermediate targets. */
  resize(width, height) {
    // A hidden or collapsed stage measures zero; a zero-sized buffer makes the
    // whole pipeline silently produce nothing, so floor it.
    const w = Math.max(16, Math.round(width));
    const h = Math.max(16, Math.round(height));
    if (w === this.width && h === this.height) return;
    this.width = w;
    this.height = h;
    this.canvas.width = w;
    this.canvas.height = h;

    const gl = this.gl;
    for (const key of Object.keys(this.targets)) {
      if (this.targets[key]) {
        gl.deleteTexture(this.targets[key].tex);
        gl.deleteFramebuffer(this.targets[key].fbo);
      }
    }
    const hw = Math.max(8, w >> 1);
    const hh = Math.max(8, h >> 1);
    const qw = Math.max(8, w >> 2);
    const qh = Math.max(8, h >> 2);
    this.targets.halfA = createTarget(gl, hw, hh);
    this.targets.halfB = createTarget(gl, hw, hh);
    this.targets.quarterA = createTarget(gl, qw, qh);
    this.targets.quarterB = createTarget(gl, qw, qh);
  }

  /** Uploads a video frame, an image or a canvas into the source texture. */
  uploadSource(source, width, height) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    if (width !== this.srcSize[0] || height !== this.srcSize[1]) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
      this.srcSize = [width, height];
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, source);
    }
  }

  uploadMask(canvas) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    if (canvas.width !== this.maskSize[0] || canvas.height !== this.maskSize[1]) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
      this.maskSize = [canvas.width, canvas.height];
    } else {
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, canvas);
    }
  }

  _pass(program, target, setup, { mirror = 0, flipY = 0 } = {}) {
    const gl = this.gl;
    gl.useProgram(program.id);
    gl.bindVertexArray(this.quad);
    if (target) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, target.fbo);
      gl.viewport(0, 0, target.w, target.h);
    } else {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, this.width, this.height);
    }
    program.set1f('uMirror', mirror);
    program.set1f('uFlipY', flipY);
    setup(program);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  }

  _blur(from, to, dx, dy) {
    const blur = this.programs.blur;
    this._pass(blur, to, (p) => {
      this.gl.activeTexture(this.gl.TEXTURE0);
      this.gl.bindTexture(this.gl.TEXTURE_2D, from.tex ?? from);
      p.set1i('uTex', 0);
      p.set2f('uStep', dx, dy);
    });
  }

  /**
   * @param {object} o
   * @param {object} o.params   slider values, already in shader units
   * @param {Array}  o.warps    warp handles from buildWarps()
   * @param {object} o.face     per-face uniforms (eye/cheek blobs, confidence)
   * @param {number} o.blurScale radius multiplier tracking the face size
   * @param {number} o.mirror
   * @param {number} o.compare  split position, or -1
   * @param {boolean} o.showMask
   */
  render(o) {
    const gl = this.gl;
    const { halfA, halfB, quarterA, quarterB } = this.targets;
    const p = o.params;

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.srcTex);

    // Radius is in source-uv units so it tracks the frame, and blurScale keeps
    // the smoothing the same size relative to the face as the subject moves.
    const rx = (o.blurScale * 1.15) / Math.max(1, halfA.w);
    const ry = (o.blurScale * 1.15) / Math.max(1, halfA.h);

    this._blur({ tex: this.srcTex }, halfA, rx, 0);
    this._blur(halfA, halfB, 0, ry);
    this._blur(halfB, quarterA, (o.blurScale * 2.6) / quarterA.w, 0);
    this._blur(quarterA, quarterB, 0, (o.blurScale * 2.6) / quarterB.h);

    if (o.showMask) {
      this._pass(this.programs.mask, null, (prog) => {
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
        prog.set1i('uSrc', 0);
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
        prog.set1i('uMask', 1);
      }, { mirror: o.mirror, flipY: 1 });
      return;
    }

    this.warpP.fill(0);
    this.warpQ.fill(0);
    const n = Math.min(o.warps.length, MAX_WARP);
    for (let i = 0; i < n; i++) {
      const w = o.warps[i];
      this.warpP[i * 4] = w.cx;
      this.warpP[i * 4 + 1] = w.cy;
      this.warpP[i * 4 + 2] = w.r;
      this.warpP[i * 4 + 3] = w.mode;
      this.warpQ[i * 4] = w.dx || 0;
      this.warpQ[i * 4 + 1] = w.dy || 0;
      this.warpQ[i * 4 + 2] = w.k || 0;
    }

    this._pass(this.programs.composite, null, (prog) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.srcTex);
      prog.set1i('uSrc', 0);
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, halfB.tex);
      prog.set1i('uFine', 1);
      gl.activeTexture(gl.TEXTURE2);
      gl.bindTexture(gl.TEXTURE_2D, quarterB.tex);
      prog.set1i('uWide', 2);
      gl.activeTexture(gl.TEXTURE3);
      gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
      prog.set1i('uMask', 3);

      prog.set1f('uAspect', this.width / Math.max(1, this.height));
      prog.set1f('uFace', o.face.confidence);
      prog.set1f('uTime', o.time);
      prog.set1i('uWarpCount', n);
      prog.set4fv('uWarpP[0]', this.warpP);
      prog.set4fv('uWarpQ[0]', this.warpQ);

      prog.set1f('uSmooth', p.smooth);
      prog.set1f('uTexture', p.texture);
      prog.set1f('uEven', p.even);
      prog.set1f('uSharpen', p.sharpen);
      prog.set1f('uBright', p.bright);
      prog.set1f('uWarmth', p.warmth);
      prog.set1f('uVibrance', p.vibrance);
      prog.set1f('uContrast', p.contrast);
      prog.set1f('uGlow', p.glow);
      prog.set1f('uVignette', p.vignette);
      prog.set1f('uGrain', p.grain);
      prog.set1f('uEyeBright', p.eyeBright);
      prog.set1f('uUnderEye', p.underEye);
      prog.set3f('uLipColor', p.lipColor[0], p.lipColor[1], p.lipColor[2]);
      prog.set1f('uLipAmount', p.lipAmount);
      prog.set3f('uBlushColor', p.blushColor[0], p.blushColor[1], p.blushColor[2]);
      prog.set1f('uBlushAmount', p.blushAmount);

      prog.set4f('uEyeL', ...o.face.eyeL);
      prog.set4f('uEyeR', ...o.face.eyeR);
      prog.set4f('uCheekL', ...o.face.cheekL);
      prog.set4f('uCheekR', ...o.face.cheekR);
      prog.set1f('uCompare', o.compare);
    }, { mirror: o.mirror, flipY: 1 });
  }

  /** Reads the drawing buffer back. Only valid in the same task as a draw. */
  readPixels(x, y, w, h) {
    const gl = this.gl;
    const out = new Uint8Array(w * h * 4);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.readPixels(x, y, w, h, gl.RGBA, gl.UNSIGNED_BYTE, out);
    return out;
  }

  glError() {
    const e = this.gl.getError();
    return e === this.gl.NO_ERROR ? null : e;
  }
}

function createTexture(gl) {
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return tex;
}

function createTarget(gl, w, h) {
  const tex = createTexture(gl);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  const status = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  if (status !== gl.FRAMEBUFFER_COMPLETE) {
    throw new ShaderError(`Render target ${w}x${h} is incomplete (0x${status.toString(16)}).`);
  }
  return { tex, fbo, w, h };
}

function compile(gl, type, source) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, source);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    // Shader failures are reported through the API, never thrown: without this
    // the pipeline would just draw nothing and the log would sit unread.
    const log = gl.getShaderInfoLog(sh) || 'unknown error';
    const kind = type === gl.VERTEX_SHADER ? 'vertex' : 'fragment';
    gl.deleteShader(sh);
    throw new ShaderError(`${kind} shader failed to compile:\n${log}`);
  }
  return sh;
}

function buildProgram(gl, vertSrc, fragSrc) {
  const vs = compile(gl, gl.VERTEX_SHADER, vertSrc);
  const fs = compile(gl, gl.FRAGMENT_SHADER, fragSrc);
  const id = gl.createProgram();
  gl.attachShader(id, vs);
  gl.attachShader(id, fs);
  gl.bindAttribLocation(id, 0, 'aPos');
  gl.linkProgram(id);
  gl.deleteShader(vs);
  gl.deleteShader(fs);
  if (!gl.getProgramParameter(id, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(id) || 'unknown error';
    throw new ShaderError(`program failed to link:\n${log}`);
  }

  const cache = new Map();
  const loc = (name) => {
    if (!cache.has(name)) cache.set(name, gl.getUniformLocation(id, name));
    return cache.get(name);
  };
  return {
    id,
    loc,
    set1i: (n, v) => gl.uniform1i(loc(n), v),
    set1f: (n, v) => gl.uniform1f(loc(n), v),
    set2f: (n, a, b) => gl.uniform2f(loc(n), a, b),
    set3f: (n, a, b, c) => gl.uniform3f(loc(n), a, b, c),
    set4f: (n, a, b, c, d) => gl.uniform4f(loc(n), a, b, c, d),
    set4fv: (n, v) => gl.uniform4fv(loc(n), v),
  };
}
