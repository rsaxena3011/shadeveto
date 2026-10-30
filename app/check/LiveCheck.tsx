"use client";

/**
 * The live check panel: judge passcode, real photo, one real Skin
 * Tone call. All spend discipline lives on the server
 * (lib/live/runner.ts); this component prepares the photo and
 * carries the server's answer.
 *
 * The run is identified end to end and every wait is bounded.
 * This panel mints a run id before the first request and sends
 * it with the start and with every collect; the server records
 * the run under that id, so a collect resumes or replays the
 * SAME run. And the wait for each answer has a limit
 * (lib/live/wait.ts): a response lost between the platform and
 * this browser used to leave the panel on "Running..." forever,
 * because a fetch that never settles never reaches a catch
 * block. At the bound the panel hands over to the collect
 * action instead, with the run's id already attached.
 *
 * Photo preparation happens here, before upload, per the plan:
 * JPG and PNG only, shrunk in the browser to at most 1024 px on
 * the long side and re-encoded as JPEG, then uploaded once. The
 * face measurement comes from the browser's built-in face
 * detector (Shape Detection API) when it exists, and otherwise
 * from MediaPipe Tasks Vision running on this site's own WASM
 * and model files; if measurement itself fails, the panel
 * refuses on screen with the reason, because the capture gate
 * needs a measurement it can check, and an unchecked photo must
 * never reach a paid call. The server re-runs the gate on the
 * raw measurements regardless, so nothing here is trusted.
 */

import { useEffect, useRef, useState } from "react";
import {
  checkCapture,
  type CaptureMeasurement,
} from "../../lib/decision/capture.ts";
import { faceShareText } from "../../lib/ui/fixture-session.ts";
import {
  awaitBounded,
  LIVE_RUN_WAIT_MS,
} from "../../lib/live/wait.ts";
import type { Receipt } from "../../lib/decision/decision.ts";
import { buildReceiptView } from "../../lib/ui/receipt-view.ts";
import ReceiptSection, { type ReceiptPreview } from "./ReceiptSection";

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
// from WASM + model files served by this site itself (public/
// mediapipe), no install on the device and no third-party CDN.
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
    // Self-hosted wasm bundle (copied from the installed tasks-vision
    // 1.2.0 package into public/mediapipe/wasm). Loading from the
    // jsDelivr CDN failed on slow/mobile connections, which killed the
    // measurement before any paid call; same-origin files cannot be
    // blocked by a third-party CDN hiccup.
    "/mediapipe/wasm",
  );
  // Self-hosted model file for the same reason: no Google Storage
  // fetch at run time.
  const modelAssetPath = "/mediapipe/blaze_face_short_range.tflite";
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
      preview: ReceiptPreview | null;
    }
  | {
      mode: "live";
      outcome: "cap" | "refused" | "pending" | "lost" | "provider-error";
      message: string;
    };

type BalanceReply =
  | { mode: "fixture" }
  | { mode: "live"; balance: number | null };

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

const LIVE_USED_STORAGE_KEY = "shadeveto-live-used";

/** A fresh identity for one run (see the header). The id names
 * the run for the server's records; it is not a credential, and
 * the passcode still gates every replay. */
function newRunId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `run-${Date.now()}-${Math.floor(Math.random() * 1_000_000_000)}`;
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
  // The BUY preview render rides next to the receipt (it is not
  // engine output, so it never goes inside the Receipt itself).
  const [preview, setPreview] = useState<ReceiptPreview | null>(null);
  // Photo measurement is asynchronous (the detector loads WASM and
  // a model file), so it gets its own visible state: without it the
  // panel sat silent for seconds after an upload and a detector
  // failure looked exactly like a dead button.
  const [measuring, setMeasuring] = useState(false);
  const [photoName, setPhotoName] = useState<string | null>(null);
  const [photoPreviewUrl, setPhotoPreviewUrl] = useState<string | null>(
    null,
  );
  const [detectError, setDetectError] = useState<string | null>(null);
  // A provider task error is a service failure, not a CAN'T TELL
  // verdict: it gets its own panel and exactly one retry with the
  // photo and passcode already entered, so a provider hiccup can
  // never turn into a spend loop.
  const [providerError, setProviderError] = useState<string | null>(null);
  const [retryUsed, setRetryUsed] = useState(false);
  // The panel copy promises ONE real reading; the server cap (60
  // units per session) is looser than that promise, so the panel
  // itself retires the button after one paid reading and says so.
  const [liveUsed, setLiveUsed] = useState(false);
  // Pre-run balance: read once per passcode when the panel first
  // reaches its "live mode is ready" state, so the cost context
  // is on screen before anything is spent. Keyed to the passcode
  // it was read for; a read is never shown for a different one.
  const [balanceRead, setBalanceRead] = useState<{
    forPasscode: string;
    balance: number | null;
  } | null>(null);
  const balanceFetchedFor = useRef<string | null>(null);
  const receiptRef = useRef<HTMLDivElement>(null);
  // The current run's id: minted at the first Run press, sent
  // with the start and every collect, and retired only when the
  // run reaches a terminal answer. While it is set, pressing Run
  // again names the same run (the server resumes it); it can
  // never name a second one by accident.
  const runIdRef = useRef<string | null>(null);

  useEffect(() => {
    try {
      if (window.sessionStorage.getItem(LIVE_USED_STORAGE_KEY) === "1") {
        setLiveUsed(true);
      }
    } catch {
      // Storage can be unavailable (private modes); the in-page
      // state still covers the common case.
    }
    // Judge deep link: /check?passcode=... pre-fills the passcode
    // so the testing instructions can send judges straight into
    // live mode. The value is only ever sent to this site's own
    // live-check endpoint, exactly like a typed passcode.
    const fromLink = new URLSearchParams(window.location.search).get(
      "passcode",
    );
    if (fromLink !== null && fromLink.trim() !== "") {
      setPasscode(fromLink.trim());
    }
  }, []);

  useEffect(() => {
    if (receipt !== null) {
      receiptRef.current?.scrollIntoView({
        behavior: "smooth",
        block: "start",
      });
    }
  }, [receipt]);

  // Fetch the balance on the transition into the ready state:
  // passcode present, no reading used yet, no receipt on screen.
  // Debounced, so typing the passcode does not fire a read per
  // keystroke, and each distinct passcode is read at most once.
  // The server answers a wrong passcode with the same opaque
  // fixture marker as a run attempt, and the panel then shows
  // nothing extra; the read never runs a check and spends
  // nothing.
  useEffect(() => {
    const trimmed = passcode.trim();
    if (trimmed === "" || liveUsed || receipt !== null) return;
    if (balanceFetchedFor.current === trimmed) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      balanceFetchedFor.current = trimmed;
      const form = new FormData();
      form.set("passcode", trimmed);
      void (async () => {
        try {
          const res = await fetch("/api/balance", {
            method: "POST",
            body: form,
          });
          const reply = (await res.json()) as BalanceReply;
          if (cancelled || reply.mode !== "live") return;
          setBalanceRead({ forPasscode: trimmed, balance: reply.balance });
        } catch {
          // A failed fetch shows nothing invented; the receipt
          // still reports the real before/after after a run.
        }
      })();
    }, 700);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [passcode, liveUsed, receipt]);

  const gate =
    prepared !== null ? checkCapture(prepared.measurement) : null;

  async function onPhoto(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0] ?? null;
    setReceipt(null);
    setPreview(null);
    setMessage(null);
    setPending(false);
    setPrepared(null);
    setDetectError(null);
    setProviderError(null);
    setRetryUsed(false);
    setMeasuring(false);
    if (photoPreviewUrl !== null) {
      URL.revokeObjectURL(photoPreviewUrl);
      setPhotoPreviewUrl(null);
    }
    setPhotoName(null);
    if (!file) return;
    if (file.type !== "image/jpeg" && file.type !== "image/png") {
      setMessage("Live checks accept JPG or PNG photos only.");
      return;
    }
    // Show the chosen photo straight away, before measurement, so
    // the panel acknowledges the upload even if detection fails.
    setPhotoName(file.name);
    setPhotoPreviewUrl(URL.createObjectURL(file));
    setMeasuring(true);
    try {
      setPrepared(await preparePhoto(file));
    } catch (error) {
      // Keep the real error reachable in the console: swallowing it
      // here is what made the Oct 28-29 measurement failures
      // undiagnosable for four attempts.
      console.error("LiveCheck photo measurement failed:", error);
      setDetectError(
        "Face detection could not run in this browser, so this photo was not measured and no live check can start from it. Nothing was spent. Check your connection and try the same photo again, or use fixture mode above.",
      );
    } finally {
      setMeasuring(false);
    }
  }

  async function post(form: FormData) {
    setBusy(true);
    setMessage(null);
    setProviderError(null);
    // Bounded wait (see the header): when the bound passes with
    // no answer, or the request fails outright, the panel moves
    // to the collect state instead of spinning. The run id in
    // the form is what makes collecting safe: the server resumes
    // or replays that run, never a new one.
    const result = await awaitBounded(async (signal) => {
      const res = await fetch("/api/live-check", {
        method: "POST",
        body: form,
        signal,
      });
      return (await res.json()) as LiveReply;
    }, LIVE_RUN_WAIT_MS);
    try {
      if (result.kind === "timeout") {
        setPending(true);
        setReceipt(null);
        setPreview(null);
        setMessage(
          "The check is taking longer than this panel waits for. The reading may still complete on the server, and waiting charged nothing new. Use the button below to collect it: collecting resumes the same reading, it never starts a second one.",
        );
        return;
      }
      if (result.kind === "unreachable") {
        setMessage(
          "The live check could not be reached. If a reading was started, it is held safely on the server; trying again will collect it, never restart it.",
        );
        setPending(true);
        return;
      }
      const reply = result.value;
      if (reply.mode === "fixture") {
        runIdRef.current = null;
        // The server answers a missing OR a wrong passcode with the
        // same fixture marker, on purpose. The panel still knows
        // what was typed, so it can say which case this is instead
        // of leaving the click unexplained.
        setPending(false);
        setReceipt(null);
        setPreview(null);
        setMessage(
          passcode.trim() === ""
            ? "Live mode needs the judge passcode. Enter it above and try again. Nothing was spent."
            : "That passcode was not accepted, so live mode did not start. Check the passcode and try again. Nothing was spent.",
        );
        return;
      }
      if (reply.outcome === "receipt") {
        runIdRef.current = null;
        setPending(false);
        setReceipt(reply.receipt);
        setPreview(reply.preview);
        if (reply.receipt.unitsSpent > 0) {
          setLiveUsed(true);
          try {
            window.sessionStorage.setItem(LIVE_USED_STORAGE_KEY, "1");
          } catch {
            // See the mount effect: storage is best-effort only.
          }
        }
        return;
      }
      if (reply.outcome === "provider-error") {
        // The failed task was refunded and the run is over; its
        // id is retired, so the one deliberate retry below mints
        // a fresh id for what is genuinely a new run.
        runIdRef.current = null;
        setPending(false);
        setReceipt(null);
        setPreview(null);
        setProviderError(reply.message);
        return;
      }
      // The remaining answers are cap, refused, lost and
      // pending. All but pending end the run, so the id is
      // retired the same way; pending keeps it, because the
      // collect below is still this run.
      if (reply.outcome !== "pending") runIdRef.current = null;
      setPending(reply.outcome === "pending");
      setReceipt(null);
      setPreview(null);
      setMessage(reply.message);
    } finally {
      setBusy(false);
    }
  }

  function run() {
    if (!prepared || liveUsed) return;
    // One id per run, minted before the first request: while a
    // run is open (started, not yet answered with a terminal
    // outcome) its id is reused, so this button can never name
    // a second run by accident.
    if (runIdRef.current === null) runIdRef.current = newRunId();
    const form = new FormData();
    // Trimmed before sending: a pasted passcode with stray
    // whitespace or a trailing newline is the common near-miss,
    // and it should never silently land in fixture mode.
    form.set("passcode", passcode.trim());
    form.set("runId", runIdRef.current);
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
    form.set("passcode", passcode.trim());
    // The collect names the run it is collecting. Without the
    // id it would depend on the session cookie, which is
    // exactly what a lost response takes with it.
    if (runIdRef.current !== null) form.set("runId", runIdRef.current);
    void post(form);
  }

  function retry() {
    if (providerError === null || retryUsed || prepared === null) return;
    setRetryUsed(true);
    run();
  }

  const view = receipt !== null ? buildReceiptView(receipt) : null;

  return (
    <div className="check-flow live-check">
      <fieldset className="step">
        <legend>Live check, for judges</legend>
        <p className="step-note">
          With the event passcode, this panel runs ONE real Skin Tone
          reading on a photo you upload, through the same engine as
          fixture mode, and spends real API units. On a BUY it also
          renders a labelled try-on preview of the winning shade for
          1 extra unit; the preview is a picture only and never
          affects the verdict. Spend is capped
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
        <p className="passcode-status" aria-live="polite">
          {passcode.trim() === ""
            ? "Live mode is locked until the judge passcode is entered. It unlocks as you type, there is no separate unlock step."
            : liveUsed
              ? "Passcode entered, but this session has already used its one live reading."
              : "Passcode entered: live mode is ready. It runs when you press the button below."}
        </p>
        {balanceRead !== null &&
        balanceRead.forPasscode === passcode.trim() &&
        !liveUsed &&
        receipt === null ? (
          <p className="balance-line" aria-live="polite">
            {balanceRead.balance !== null
              ? `Balance before this check: ${balanceRead.balance} units.`
              : "The balance could not be read. Nothing was spent."}
          </p>
        ) : null}
        {measuring ? (
          <p className="face-share" aria-live="polite">
            Detecting face...
          </p>
        ) : detectError !== null ? (
          <p className="form-error" role="alert">
            {detectError}
          </p>
        ) : prepared !== null ? (
          <p className="face-share">
            {faceShareText(prepared.measurement)}
          </p>
        ) : null}
        {photoPreviewUrl !== null ? (
          <p className="photo-chosen">
            <img
              className="photo-preview"
              src={photoPreviewUrl}
              alt="Preview of the photo you chose"
            />
            <span>{photoName}</span>
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
              placeholder="Example: #A77D60"
            />
          </label>
          <label>
            Bottle name (optional)
            <input
              type="text"
              value={ownedName}
              onChange={(event) => setOwnedName(event.target.value)}
              placeholder="Example: My current foundation"
            />
          </label>
        </div>
      </fieldset>

      <button
        type="button"
        className="run-button"
        onClick={run}
        disabled={busy || measuring || prepared === null || liveUsed}
        aria-busy={busy}
      >
        {busy ? (
          <>
            Running...
            <span className="spinner" aria-hidden="true" />
          </>
        ) : (
          "Run the live check (spends 20 units, plus 1 for the preview on a BUY)"
        )}
      </button>
      {liveUsed ? (
        <p className="live-used-note">
          One live reading used for this session. Fixture mode above
          still works and spends nothing.
        </p>
      ) : null}
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
      {providerError !== null ? (
        <div className="provider-error" role="alert">
          <h3>The reading service hit an error</h3>
          <p>{providerError}</p>
          <button
            type="button"
            className="run-button"
            onClick={retry}
            disabled={busy || retryUsed || prepared === null}
          >
            {busy ? (
              <>
                Running...
                <span className="spinner" aria-hidden="true" />
              </>
            ) : (
              "Try again with the same photo"
            )}
          </button>
          {retryUsed ? (
            <p>
              One retry already used for this photo. If the service
              keeps failing, fixture mode above still works, and a
              later session can try live again.
            </p>
          ) : null}
        </div>
      ) : null}

      {view !== null ? (
        <div ref={receiptRef} className="live-receipt">
          <ReceiptSection
            view={view}
            rankingHeading="Ranking, closest first"
            preview={preview}
          />
        </div>
      ) : null}
    </div>
  );
}
