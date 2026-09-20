/**
 * MediaPipe Face Landmarker index sets.
 *
 * Every loop below was extracted from `FaceLandmarker.FACE_LANDMARKS_*` (the
 * task bundle ships them as unordered {start,end} edge lists) and chained into
 * a closed polygon, so the order here is walk order around the contour and can
 * be filled directly as a path.
 */

export const FACE_OVAL = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379,
  378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127,
  162, 21, 54, 103, 67, 109,
];

export const LIPS_OUTER = [
  61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0,
  37, 39, 40, 185,
];

export const LIPS_INNER = [
  78, 95, 88, 178, 87, 14, 317, 402, 318, 324, 308, 415, 310, 311, 312, 13,
  82, 81, 80, 191,
];

/** Subject's left eye — appears on the right-hand side of an unmirrored frame. */
export const EYE_L = [
  263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466,
];

export const EYE_R = [
  33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246,
];

/** Brows arrive as two open chains (lower edge, upper edge); joining the lower
 *  chain to the reversed upper chain closes the shape. */
export const BROW_L = [276, 283, 282, 295, 285, 336, 296, 334, 293, 300];
export const BROW_R = [46, 53, 52, 65, 55, 107, 66, 105, 63, 70];

export const IRIS_L = [474, 475, 476, 477];
export const IRIS_R = [469, 470, 471, 472];

export const IRIS_CENTER_L = 473;
export const IRIS_CENTER_R = 468;

/** Single points used for framing and for placing warp handles. */
export const P = {
  chin: 152,
  foreheadTop: 10,
  noseTip: 1,
  noseBridge: 168,
  noseBase: 2,
  noseWingL: 278,
  noseWingR: 48,
  nostrilL: 327,
  nostrilR: 98,
  mouthCornerL: 291,
  mouthCornerR: 61,
  mouthTop: 13,
  mouthBottom: 14,
  eyeOuterL: 263,
  eyeInnerL: 362,
  eyeOuterR: 33,
  eyeInnerR: 133,
  eyeLidTopL: 386,
  eyeLidBottomL: 374,
  eyeLidTopR: 159,
  eyeLidBottomR: 145,
  cheekBoneL: 425,
  cheekBoneR: 205,
  faceLeft: 454,
  faceRight: 234,
  browCenter: 9,
};

/** Oval vertices from the temples down to the chin, i.e. the slimmable jaw. */
export const JAW_L = [356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377];
export const JAW_R = [127, 234, 93, 132, 58, 172, 136, 150, 149, 176, 148];

export const NUM_LANDMARKS = 478;
