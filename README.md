# Face Beautifier

Real-time face retouching on your webcam, in a browser tab. Skin smoothing,
tone evening, makeup and face-shape reshaping, all driven by live face
landmarks and all running on the GPU.

**[Open the live demo →](https://ctbot000.github.io/face-beautifier/)**

No build step, no server, no upload: it is static HTML and ES modules, and
video frames never leave the tab.

---

## What it does

| | |
|---|---|
| **Skin** | Edge-aware smoothing, texture retention, blemish and redness evening, detail recovery |
| **Face shape** | Jaw slimming, chin length, eye size, nose width, lip size |
| **Eyes & lips** | Eye and teeth whitening, under-eye lift, lip tint, blush |
| **Light & colour** | Brightness, warmth, vibrance, contrast, soft glow, vignette, grain |
| **Compare** | Hold-to-compare, or a draggable before/after split |
| **Export** | PNG snapshot and WebM/MP4 recording of the processed canvas |

Six presets — Off, Natural, Glow, Porcelain, Glam, Doll — plus every slider
individually. A **Mask** view shows exactly which regions the shader is acting
on, which is the fastest way to understand what a slider is doing.

You can also drop in a still photo instead of using the camera.

---

## How it works

```
camera frame ─┬─────────────────────────────────────────────┐
              │                                             │
              ├─► blur H ─► blur V ──► fine  (½ res) ────────┤
              │                └─► blur H ─► blur V ─► wide ─┤ (¼ res)
              │                                             │
landmarks ────┼─► region mask (R skin · G lips · B eyes) ────┤
              └─► warp handles ─────────────────────────────┤
                                                            ▼
                                                      composite ─► canvas
```

**Landmarks.** [MediaPipe Face Landmarker] returns 478 points per frame. They
are smoothed with a [One Euro filter] before anything reads them: raw points
jitter by a pixel or two on a perfectly still face, and that jitter is very
visible once it drives a geometric warp. One Euro widens its own cutoff with
speed, so it is calm at rest without adding lag when you turn your head.

**Smoothing.** Not a blur. The frame is split into a low-frequency base and the
detail on top of it, and only *small* detail is suppressed:

```glsl
vec3 detail = src - fine;
float edge  = smoothstep(0.030, 0.115, abs(dot(detail, LUMA)));
float keep  = mix(1.0 - smooth * skin, 1.0, edge);
vec3 col    = fine + detail * keep;
```

Pores and blemishes are small, so they go; eyelashes, nostrils and the lip line
are large, so they stay exactly as they were. That is what keeps a heavily
smoothed face from reading as plastic. The smoothing radius scales with the
measured face width, so the result is the same whether you are close to the
camera or across the room.

**Regions.** A 320px mask canvas is repainted each frame from the landmark
polygons and uploaded as one RGBA texture: red is skin that may be smoothed,
green is lips, blue is the eye openings and the inner mouth. Canvas
compositing does the set arithmetic — `lighter` adds a region to its channel,
then a `multiply` by `rgb(0,255,255)` punches eyes, brows and lips back out of
the skin channel. Blush and the under-eye lift are analytic blobs in the
shader instead, because a soft radial falloff is what they want anyway.

Without landmarks — model still loading, or offline — the shader falls back to a
YCbCr skin-chroma test and keeps working on whatever is skin-coloured.

**Reshaping.** Each handle is one step of Gustafsson's local image warp: the
pixel at `c + d` takes the value that was at `c`, with a squared falloff that
reaches zero on a circle of radius `r`.

```glsl
float ratio = (rr - dd) / (rr - dd + dot(m, m));
p -= ratio * ratio * m;
```

Handles compose by running the map through all of them in sequence, so a
slimmed jaw and an enlarged eye do not fight. Displacement is capped at
`0.45 * r`; past roughly half the radius the map folds over itself and the image
tears.

**Colour space.** Every pass reads sRGB-encoded texels and writes sRGB-encoded
texels. Nothing linearises, so nothing has to re-encode, and the gamma-space
blur is exactly the surface blur a retouching tool applies.

[MediaPipe Face Landmarker]: https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker
[One Euro filter]: https://gery.casiez.net/1euro/

---

## Privacy

Camera frames are read into a `<video>` element, uploaded to a WebGL texture and
drawn to a canvas. They are never sent anywhere, and nothing is stored.

The only network requests the page makes are for the MediaPipe runtime and the
face-landmark model, both from a pinned jsDelivr / Google Storage URL, both
fetched once and cached by the browser. Snapshots and recordings are produced
locally and handed to the browser's own download.

---

## Running it locally

Any static server works — `getUserMedia` needs `https://` or `localhost`, so
opening `index.html` as a `file://` URL will not get you a camera.

```bash
python3 -m http.server 8000
```

Then open <http://localhost:8000>.

---

## Tests

The suite runs in the browser against the real pipeline — the same shaders, the
same mask painter, the same warp maths — using synthetic sources, so everything
that does not need a camera is covered:

```
http://localhost:8000/?selftest=1
```

It checks that neutral settings are a bit-exact identity, that smoothing acts
only inside the mask and only on small detail, that the skin-tone fallback finds
skin without landmarks, that a warp handle displaces by the amount the maths
predicts and leaves everything outside its radius alone, that the mask painter
fills the channel each region belongs in, that no handle exceeds its own
falloff, that slimming always pulls toward the face midline, that the One Euro
filter cuts jitter and that beta buys the lag back, and that the compare split
shows the original on one side. Results land in `window.__selftest` as well as
on the page.

---

## Browser support

Needs **WebGL2** and `getUserMedia` — Chrome, Edge, Firefox and Safari 15+, on
desktop and mobile. Recording additionally needs `MediaRecorder` and
`canvas.captureStream`, which Safari supports from 14.1.

Landmark detection asks for the GPU delegate and falls back to CPU by itself. If
it cannot run at all, the app says so and carries on with skin-tone detection.

---

## Layout

```
index.html          markup and the control panel shell
styles.css          all styling
src/main.js         camera, UI wiring, the frame loop
src/renderer.js     WebGL2 passes, programs, render targets
src/shaders.js      every line of GLSL
src/facemesh.js     MediaPipe loading, detection, presence ramp
src/landmarks.js    landmark index loops, extracted from the task bundle
src/face.js         landmarks -> face measurements
src/warp.js         warp handles, analytic blobs, blur scale
src/mask.js         the per-region mask canvas
src/controls.js     sliders, swatches, presets, uniform mapping
src/onefilter.js    One Euro filter
src/selftest.js     the in-browser test suite
```

---

## Licence

[MIT](LICENSE).

The MediaPipe face-landmark model is fetched at runtime from Google and is
covered by its own [Apache 2.0 licence and model card][model-card].

[model-card]: https://ai.google.dev/edge/mediapipe/solutions/vision/face_landmarker#models
