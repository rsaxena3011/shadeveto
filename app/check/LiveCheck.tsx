"use client";

/**
 * The live check panel: judge passcode, real photo, one real Skin
 * Tone call. All spend discipline lives on the server
 * (lib/live/runner.ts); this component prepares the photo and
 * carries the server's answer.
 *
 * Photo preparation happens here, before upload, per the plan:
 * JPG and PNG only, shrunk in the browser to at most 1024 px on
 * the long side and re-encoded as JPEG, then uploaded once. The
 * face measurement comes from the browser's built-in face
 * detector when it exists; without one the panel refuses to
 * start, because the capture gate needs a measurement it can
 * check, and an unchecked photo must never reach a paid call.
 * The server re-runs the gate on the raw measurements regardless,
 * so nothing here is trusted.
 */

import { useState } from "react";
import {
  checkCapture,
  type CaptureMeasurement,
} from "../../lib/decision/capture.ts";
import type { Receipt } from "../../lib/decision/decision.ts";
import { buildReceiptView } from "../../lib/ui/receipt-view.ts";
import ReceiptSection from "./ReceiptSection";

interface FaceBox {
  width: number;
  height: number;
}

interface FaceDetectorLike {
  detect: (source: ImageBitmap) => Promise<Array<{ boundingBox: FaceBox }>>;
}

function faceDetectorCtor():
  | (new (opts?: { fastMode?: boolean }) => FaceDetectorLike)
  | null {
  const ctor = (
    window as unknown as {
      FaceDetector?: new (opts?: { fastMode?: boolean }) => FaceDetectorLike;
    }
  ).FaceDetector;
  return typeof ctor === "function" ? ctor : null;
}

// Portable fallback: the built-in FaceDetector exists only on a few
// browsers (not desktop Chrome), so a missing one must not block a
// live check. MediaPipe runs in normal Chrome, desktop and mobile,
// from WASM + model files served by CDN, no install on the device.
let mediaPipeDetector: {
  detect: (source: ImageBitmap) => Promise<{
    detections: Array<{ boundingBox?: { width?: number } }>;
  }>;
} | null = null;
let mediaPipeLoading: Promise<{
  detect: (source: ImageBitmap) => Promise<{
    detections: Array<{ boundingBox?: { width?: number } }>;
  }>;
}> | null = null;

async function loadMediaPipeDetector(): Promise<{
  detect: (source: ImageBitmap) => Promise<{
    detections: Array<{ boundingBox?: { width?: number } }>;
  }>;
}> {
  const vision = await import("@mediapipe/tasks-vision");
  const fileset = await vision.FilesetResolver.forVisionTasks(
    // Must match the installed tasks-vision major version (1.x, see
    // package.json). A 0.10 wasm bundle against 1.x JS fails to load,
    // which is why the first MediaPipe attempt died on desktop Chrome.
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.2.0/wasm",
  );
  const modelAssetPath =
    "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";
  try {
    return (await vision.FaceDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetPath, delegate: "GPU" },
      runningMode: "IMAGE",
      minDetectionConfidence: 0.5,
    })) as unknown as {
      detect: (source: ImageBitmap) => Promise<{
        detections: Array<{ boundingBox?: { width?: number } }>;
      }>;
    };
  } catch {
    // GPU delegate fails on some Windows Chrome setups: CPU works
    // everywhere, just slower, and this is one photo, not video.
    return (await vision.FaceDetector.createFromOptions(fileset, {
      baseOptions: { modelAssetPath, delegate: "CPU" },
      runningMode: "IMAGE",
      minDetectionConfidence: 0.5,
    })) as unknown as {
      detect: (source: ImageBitmap) => Promise<{
        detections: Array<{ boundingBox?: { width?: number } }>;
      }>;
    };
  }
}

async function mediaPipeDetect(bitmap: ImageBitmap): Promise<{
  faceDetected: boolean;
  faceWidthPx: number;
}> {
  if (!mediaPipeDetector) {
    if (!mediaPipeLoading) {
      mediaPipeLoading = loadMediaPipeDetector().catch((error) => {
        // Do not cache a failed load: a retry after a network
        // hiccup must actually retry instead of replaying the error.
        mediaPipeLoading = null;
        throw error;
      });
    }
    mediaPipeDetector = await mediaPipeLoading;
  }
  if (!mediaPipeDetector) throw new Error("MediaPipe detector did not load.");
  const result = await mediaPipeDetector.detect(bitmap);
  const box = result.detections[0]?.boundingBox;
  if (!box || typeof box.width !== "number") {
    return { faceDetected: false, faceWidthPx: 0 };
  }
  return { faceDetected: true, faceWidthPx: Math.round(box.width) };
}

interface PreparedPhoto {
  blob: Blob;
  measurement: CaptureMeasurement;
}

type LiveReply =
  | { mode: "fixture" }
  | {
      mode: "live";
      outcome: "receipt";
      receipt: Receipt;
    }
  | {
      mode: "live";
      outcome: "cap" | "refused" | "pending" | "lost";
      message: string;
    };

async function preparePhoto(file: File): Promise<PreparedPhoto> {
  const bitmap = await createImageBitmap(file);
  let measurement: CaptureMeasurement = {
    faceDetected: false,
    faceWidthPx: 0,
    imageWidthPx: bitmap.width,
  };
  const Ctor = faceDetectorCtor();
  if (Ctor) {
    const faces = await new Ctor({ fastMode: true }).detect(bitmap);
    if (faces.length > 0) {
      measurement = {
        faceDetected: true,
        faceWidthPx: Math.round(faces[0].boundingBox.width),
        imageWidthPx: bitmap.width,
      };
    }
  } else {
    // Normal browsers have no built-in FaceDetector: use MediaPipe.
    const detected = await mediaPipeDetect(bitmap);
    measurement = { ...detected, imageWidthPx: bitmap.width };
  }
  const scale = Math.min(1, 1024 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser cannot prepare photos (no canvas).");
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/jpeg", 0.9),
  );
  if (!blob) throw new Error("This browser could not prepare the photo.");
  return { blob, measurement };
}

export default function LiveCheck() {
  const [passcode, setPasscode] = useState("");
  const [ownedHex, setOwnedHex] = useState("");
  const [ownedName, setOwnedName] = useState("");
  const [prepared, setPrepared] = useState<PreparedPhoto | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [receipt, setReceipt] = useState<Receipt | null>(null);

  const gate =
    prepared !== null ? checkCapture(prepared.measurement) : null;

  async function onPhoto(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    setReceipt(null);
    setMessage(null);
    setPending(false);
    setPrepared(null);
    if (!file) return;
    if (file.type !== "image/jpeg" && file.type !== "image/png") {
      setMessage("Live checks accept JPG or PNG photos only.");
      return;
    }
    try {
      setPrepared(await preparePhoto(file));
    } catch {
      setMessage(
        "That photo could not be measured in this browser. Check your connection and try again with the same photo.",
      );
    }
  }

  async function post(form: FormData) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/live-check", {
        method: "POST",
        body: form,
      });
      const reply = (await res.json()) as LiveReply;
      if (reply.mode === "fixture") {
        setPending(false);
        setReceipt(null);
        setMessage(
          "Live mode did not start for this session. Fixture mode above is unaffected and spends nothing.",
        );
        return;
      }
      if (reply.outcome === "receipt") {
        setPending(false);
        setReceipt(reply.receipt);
        return;
      }
      setPending(reply.outcome === "pending");
      setReceipt(null);
      setMessage(reply.message);
    } catch {
      setMessage(
        "The live check could not be reached. If a reading was started, it is held safely on the server; trying again will collect it, never restart it.",
      );
      setPending(true);
    } finally {
      setBusy(false);
    }
  }

  function run() {
    if (!prepared) return;
    const form = new FormData();
    form.set("passcode", passcode);
    form.set("faceDetected", String(prepared.measurement.faceDetected));
    form.set("faceWidthPx", String(prepared.measurement.faceWidthPx));
    form.set("imageWidthPx", String(prepared.measurement.imageWidthPx));
    form.set("ownedHex", ownedHex);
    form.set("ownedName", ownedName);
    form.set("photo", prepared.blob, "capture.jpg");
    void post(form);
  }

  function resume() {
    const form = new FormData();
    form.set("passcode", passcode);
    void post(form);
  }

  const view = receipt !== null ? buildReceiptView(receipt) : null;

  return (
    <div className="check-flow live-check">
      <fieldset className="step">
        <legend>Live check, for judges</legend>
        <p className="step-note">
          With the event passcode, this panel runs ONE real Skin Tone
          reading on a photo you upload, through the same engine as
          fixture mode, and spends real API units. Spend is capped
          on the server per session and in total; a reading that
          times out is collected later, never restarted, so it can
          never charge twice. Without the passcode, this panel does
          not start and fixture mode above is the whole demo.
        </p>
        <div className="owned-fields">
          <label>
            Judge passcode
            <input
              type="password"
              value={passcode}
              onChange={(event) => setPasscode(event.target.value)}
              autoComplete="off"
            />
          </label>
          <label>
            Your photo (JPG or PNG)
            <input
              type="file"
              accept="image/jpeg,image/png"
              onChange={(event) => void onPhoto(event)}
            />
          </label>
        </div>
        {prepared !== null ? (
          <p className="face-share">
            Face fills{" "}
            {prepared.measurement.faceDetected
              ? `${Math.round(
                  (prepared.measurement.faceWidthPx /
                    prepared.measurement.imageWidthPx) *
                    100,
                )}% of the photo width.`
              : "no face in this photo."}
          </p>
        ) : null}
        {gate !== null && !gate.ok ? (
          <div className="gate-alert" role="alert">
            <p>
              <strong>Capture gate: this photo would be rejected.</strong>
            </p>
            <ul>
              {gate.reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
            <p>
              You can still run the check: the engine will answer
              CAN&apos;T TELL and spend nothing.
            </p>
          </div>
        ) : null}
        <div className="owned-fields">
          <label>
            Owned bottle shade hex (optional)
            <input
              type="text"
              value={ownedHex}
              onChange={(event) => setOwnedHex(event.target.value)}
              placeholder="#A77D60"
            />
          </label>
          <label>
            Bottle name (optional)
            <input
              type="text"
              value={ownedName}
              onChange={(event) => setOwnedName(event.target.value)}
              placeholder="My current foundation"
            />
          </label>
        </div>
      </fieldset>

      <button
        type="button"
        className="run-button"
        onClick={run}
        disabled={busy || prepared === null}
      >
        Run the live check (spends 20 units)
      </button>
      {pending ? (
        <button type="button" className="run-button" onClick={resume} disabled={busy}>
          Check for the pending reading
        </button>
      ) : null}
      {message !== null ? (
        <p className="form-error" role="alert">
          {message}
        </p>
      ) : null}

      {view !== null ? (
        <ReceiptSection
          view={view}
          rankingHeading="Full ranking, closest first"
        />
      ) : null}
    </div>
  );
}
