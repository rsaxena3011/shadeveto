/**
 * Capture gate: the zero-unit check that runs before any API spend.
 *
 * The rule comes straight from the study (study/STUDY_LOG.md, Skin
 * Analysis verification, 2026-10-22): the face must exceed 60% of
 * the image width or Skin Analysis refuses the photo with
 * error_src_face_too_small. Head-and-shoulders portraits failed; a
 * tight crop at 68% of frame width succeeded. So the gate demands
 * the close framing up front, before a single unit is spent, and
 * says exactly what to fix when the framing is wrong.
 *
 * This slice takes the face measurement as input (face width in
 * pixels, image width in pixels, whether a face was found). Where
 * the measurement comes from (Camera Kit, landmarks) is a later
 * slice; the gate's job is the rule, not the ruler.
 */

/** The study's hard framing rule: face width must exceed this share. */
export const SKIN_ANALYSIS_MIN_FACE_RATIO = 0.6;

export interface CaptureMeasurement {
  /** True when a face was detected in the photo at all. */
  faceDetected: boolean;
  /** Width of the detected face, in pixels. */
  faceWidthPx: number;
  /** Width of the whole photo, in pixels. */
  imageWidthPx: number;
}

export interface CaptureGateResult {
  /** True when the photo may proceed to measurement and verdicts. */
  ok: boolean;
  /** Face width as a share of image width (0 when unmeasurable). */
  faceWidthRatio: number;
  /** Plain-language reasons, one per problem found. Empty when ok. */
  reasons: string[];
}

export function checkCapture(input: CaptureMeasurement): CaptureGateResult {
  const reasons: string[] = [];

  if (
    !Number.isFinite(input.imageWidthPx) ||
    input.imageWidthPx <= 0 ||
    !Number.isFinite(input.faceWidthPx) ||
    input.faceWidthPx < 0
  ) {
    return {
      ok: false,
      faceWidthRatio: 0,
      reasons: [
        "The photo dimensions could not be measured, so the framing cannot be checked.",
      ],
    };
  }

  if (!input.faceDetected || input.faceWidthPx === 0) {
    return {
      ok: false,
      faceWidthRatio: 0,
      reasons: [
        "No face was found in the photo. Take a front-facing photo with your face uncovered.",
      ],
    };
  }

  const ratio = input.faceWidthPx / input.imageWidthPx;
  if (ratio <= SKIN_ANALYSIS_MIN_FACE_RATIO) {
    const pct = Math.round(ratio * 100);
    reasons.push(
      `Your face fills ${pct}% of the photo width. This check needs it to fill more than 60%, so move closer or crop tighter and try again.`,
    );
  }

  return { ok: reasons.length === 0, faceWidthRatio: ratio, reasons };
}
