import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { buildOwnedShade } from "../../../lib/ui/fixture-session.ts";
import {
  createConnectorLiveDeps,
  runLiveCheck,
  type LivePhoto,
} from "../../../lib/live/runner.ts";
import type { ShadeEntry } from "../../../lib/catalog/types.ts";

// Live mode is server work: credential socket, provider calls,
// ledger state. It must never run on the edge runtime.
export const runtime = "nodejs";

// One request does the whole run server-side: upload, create,
// then polling the reading for up to 120s and a BUY preview for
// up to 120s more (lib/config.ts), plus balance reads. That is
// longer than the platform's default function duration, and a
// function killed at the default while polling leaves a charged
// task behind a response that never arrives (the filmed hang of
// 2026-10-30). The duration is declared to cover the run's own
// budgets; the pending/collect path covers anything slower.
export const maxDuration = 300;

const SESSION_COOKIE = "shadeveto-live-session";

/** Shape of a client-chosen run id: a UUID, or the panel's
 * fallback form. Anything else is ignored, never trusted. */
const RUN_ID_PATTERN = /^[A-Za-z0-9-]{8,80}$/;

/**
 * Live check endpoint. Public visitors get fixture mode and
 * nothing else: without the judge passcode the response is a
 * plain fixture marker, with no error and no detail about the
 * gate. With it, one live Skin Tone run goes through
 * lib/live/runner.ts, which owns the spend discipline.
 *
 * Two identities tie a run to its resume. The session cookie
 * covers the ordinary timed-out run: the task id lives
 * server-side against this session, so leaving and returning
 * never creates a second, double-charged task. The run id the
 * client generates before its first request covers the harder
 * case the cookie cannot: a response lost in transit takes the
 * cookie with it, so the run is ALSO recorded under the run id,
 * and a collect carrying that id resumes or replays the same
 * run from any session (see lib/live/runner.ts).
 */
export async function POST(req: Request) {
  const jar = await cookies();
  let sessionId = jar.get(SESSION_COOKIE)?.value;
  const freshSession = !sessionId;
  if (!sessionId) sessionId = randomUUID();

  const respond = (body: Record<string, unknown>, status = 200) => {
    const res = NextResponse.json(body, { status });
    if (freshSession) {
      res.cookies.set(SESSION_COOKIE, sessionId!, {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: 60 * 60 * 24,
      });
    }
    return res;
  };

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return respond({ mode: "live", outcome: "refused", message: "The request could not be read. Nothing was spent." });
  }

  const passcode = form.get("passcode");
  const runIdRaw = form.get("runId");
  const runId =
    typeof runIdRaw === "string" && RUN_ID_PATTERN.test(runIdRaw)
      ? runIdRaw
      : null;
  const faceDetected = form.get("faceDetected") === "true";
  const faceWidthPx = Number(form.get("faceWidthPx") ?? 0);
  const imageWidthPx = Number(form.get("imageWidthPx") ?? 0);

  let ownedShades: ShadeEntry[] = [];
  const ownedHex = String(form.get("ownedHex") ?? "").trim();
  if (ownedHex.length > 0) {
    const owned = buildOwnedShade(ownedHex, String(form.get("ownedName") ?? ""));
    if ("error" in owned) {
      return respond({ mode: "live", outcome: "refused", message: owned.error });
    }
    ownedShades = [owned.shade];
  }

  let photo: LivePhoto | null = null;
  const file = form.get("photo");
  if (file instanceof File && file.size > 0) {
    photo = {
      bytes: new Uint8Array(await file.arrayBuffer()),
      contentType: file.type,
      fileName: file.name || "capture.jpg",
    };
  }

  let deps;
  try {
    deps = await createConnectorLiveDeps();
  } catch {
    // The credential service or passcode is not available in this
    // environment: live mode fails closed to fixture, silently.
    return respond({ mode: "fixture" });
  }

  const outcome = await runLiveCheck(deps, {
    sessionId,
    runId,
    passcode: typeof passcode === "string" ? passcode : null,
    capture: {
      faceDetected,
      faceWidthPx: Number.isFinite(faceWidthPx) ? faceWidthPx : 0,
      imageWidthPx: Number.isFinite(imageWidthPx) ? imageWidthPx : 0,
    },
    photo,
    ownedShades,
  });

  switch (outcome.kind) {
    case "fixture":
      return respond({ mode: "fixture" });
    case "receipt":
      return respond({
        mode: "live",
        outcome: "receipt",
        receipt: outcome.receipt,
        balanceBefore: outcome.balanceBefore,
        balanceAfter: outcome.balanceAfter,
        preview: outcome.preview,
      });
    case "cap":
      return respond({ mode: "live", outcome: "cap", message: outcome.message });
    case "refused":
      return respond({ mode: "live", outcome: "refused", message: outcome.message });
    case "pending":
      return respond({ mode: "live", outcome: "pending", message: outcome.message });
    case "provider-error":
      return respond({ mode: "live", outcome: "provider-error", message: outcome.message });
    case "lost":
      return respond({ mode: "live", outcome: "lost", message: outcome.message });
  }
}
