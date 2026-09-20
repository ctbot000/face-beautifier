import { OneEuroArray } from './onefilter.js';
import { NUM_LANDMARKS } from './landmarks.js';

const VERSION = '1.0.1';
const CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}`;
const MODEL =
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';

/**
 * Wraps MediaPipe's FaceLandmarker: loads it lazily from a CDN, keeps the
 * per-frame call cheap, and hands back temporally smoothed 2D landmarks.
 *
 * Failure here is never fatal — `points` simply stays null and the renderer
 * falls back to its skin-tone mask, so the app still beautifies without a
 * network.
 */
export class FaceMesh {
  constructor() {
    this.landmarker = null;
    this.status = 'idle'; // idle | loading | ready | failed
    this.error = null;
    /** @type {Float32Array|null} x,y pairs in 0..1 image space */
    this.points = null;
    this.presence = 0; // 0..1, ramps so effects fade instead of popping
    this.lastDetectMs = 0;
    this._filter = new OneEuroArray(NUM_LANDMARKS * 2, {
      minCutoff: 1.2,
      beta: 0.012,
    });
    this._raw = new Float32Array(NUM_LANDMARKS * 2);
    this._lastTimestamp = -1;
  }

  get ready() {
    return this.status === 'ready';
  }

  async load(onProgress = () => {}) {
    if (this.status === 'loading' || this.status === 'ready') return this.status;
    this.status = 'loading';
    try {
      onProgress('Fetching face-landmark runtime…');
      const vision = await import(/* @vite-ignore */ `${CDN}/vision_bundle.mjs`);
      onProgress('Starting WebAssembly runtime…');
      const fileset = await vision.FilesetResolver.forVisionTasks(`${CDN}/wasm`);
      onProgress('Loading face model (3.7 MB)…');
      this.landmarker = await vision.FaceLandmarker.createFromOptions(fileset, {
        baseOptions: { modelAssetPath: MODEL, delegate: 'GPU' },
        runningMode: 'VIDEO',
        numFaces: 1,
        minFaceDetectionConfidence: 0.4,
        minFacePresenceConfidence: 0.4,
        minTrackingConfidence: 0.4,
        outputFaceBlendshapes: false,
      });
      this.status = 'ready';
    } catch (err) {
      this.status = 'failed';
      this.error = err;
      console.warn('[face-beautifier] face landmarker unavailable:', err);
    }
    return this.status;
  }

  /** Detection on a still image needs its own running mode. */
  async detectStill(source) {
    if (!this.ready) return null;
    try {
      this.landmarker.setOptions({ runningMode: 'IMAGE' });
      const res = this.landmarker.detect(source);
      this._ingest(res, performance.now() / 1000, true);
    } catch (err) {
      console.warn('[face-beautifier] still detection failed:', err);
    } finally {
      try {
        this.landmarker.setOptions({ runningMode: 'VIDEO' });
      } catch { /* the instance is unusable either way */ }
    }
    return this.points;
  }

  /**
   * @param {HTMLVideoElement} video
   * @param {number} nowMs performance.now()
   */
  detect(video, nowMs) {
    if (!this.ready) return null;
    // detectForVideo rejects a timestamp that does not advance, which happens
    // whenever we render faster than the camera produces frames.
    const ts = Math.max(Math.round(nowMs), this._lastTimestamp + 1);
    this._lastTimestamp = ts;
    let res;
    try {
      res = this.landmarker.detectForVideo(video, ts);
    } catch (err) {
      console.warn('[face-beautifier] detection failed:', err);
      return this.points;
    }
    this._ingest(res, nowMs / 1000, false);
    return this.points;
  }

  _ingest(res, timeSec, instant) {
    const face = res && res.faceLandmarks && res.faceLandmarks[0];
    if (!face || face.length < NUM_LANDMARKS) {
      this.presence = Math.max(0, this.presence - 0.08);
      if (this.presence <= 0) {
        this.points = null;
        this._filter.reset();
      }
      return;
    }
    const raw = this._raw;
    for (let i = 0; i < NUM_LANDMARKS; i++) {
      raw[i * 2] = face[i].x;
      raw[i * 2 + 1] = face[i].y;
    }
    if (instant) this._filter.reset();
    this.points = this._filter.filter(raw, timeSec);
    // A still gets one detection and no chance to ramp, so it starts at full
    // confidence; live video fades in so effects never pop on the first hit.
    this.presence = instant ? 1 : Math.min(1, this.presence + 0.16);
  }

  close() {
    try {
      this.landmarker?.close();
    } catch { /* already gone */ }
    this.landmarker = null;
    this.status = 'idle';
  }
}
