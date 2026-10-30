/**
 * The live run: one real Skin Tone call behind the judge passcode,
 * feeding the SAME runDecision path the fixture replay uses, so the
 * tested logic is the shipped logic.
 *
 * Order of operations is the spend discipline (MERGED_PLAN_V2 and
 * defect #9), and it is not negotiable inside this module:
 * 1. Passcode first. Anything but a judge session gets fixture
 *    mode, with no error and no detail about the mechanism.
 * 2. Recovery before novelty. A session with a run in flight, a
 *    run starting, or a run whose creation outcome is unknown
 *    never starts another one; it resumes or waits.
 * 3. Capture gate before money. The gate runs on the raw
 *    measurements first; a rejected photo costs 0 units and never
 *    reaches the API, exactly like fixture mode.
 * 4. Reserve, then caps. The ledger reservation is taken before
 *    any network call and is what the per-session and global caps
 *    are checked against, so overlapping runs cannot slip past a
 *    cap between a check and a charge.
 * 5. Balance before, balance after. The real balance is read from
 *    the provider's unit endpoint before the call and again after;
 *    the run settles at the measured delta. When a read is
 *    unavailable the run settles at the verified per-call cost and
 *    the receipt says the balance was not read.
 * 6. Create exactly once. Task creation is never retried here or
 *    in the client. The task id is recorded in the session store
 *    BEFORE polling starts, so a timeout or an abandoned browser
 *    leaves a resumable record, not a lost charge.
 * 7. Poll server-side every 2.5 seconds (the client's default),
 *    inside the provider's 250 requests per 300 seconds per key.
 *
 * Outcomes are explicit so the route can answer honestly: a
 * receipt (including CAN'T TELL receipts for gate rejections and
 * failed tasks), a cap refusal, a photo refusal, a pending note
 * for a run still in flight, or a lost note for a run the provider
 * can no longer return.
 */

import type { Catalog, ShadeEntry } from "../catalog/types.ts";
import { TASK_COSTS } from "../config.ts";
import {
  checkCapture,
  type CaptureMeasurement,
} from "../decision/capture.ts";
import {
  runDecision,
  type Receipt,
} from "../decision/decision.ts";
import { licensedCatalog } from "../catalog/licensed.ts";
import { resolveAccessMode } from "../ledger/access.ts";
import type { BalanceProvider } from "../ledger/ledger.ts";
import {
  createTask,
  createYouCamClient,
  parseSkinToneResult,
  pollTask,
  uploadFile,
  YouCamError,
  YouCamTaskError,
  YouCamTaskTimeoutError,
  type YouCamClient,
} from "../youcam/client.ts";
import { youcamBearerForLiveRun } from "../youcam/credential.ts";
import { UnitInfoBalanceProvider } from "./balance.ts";
import type { LiveSpendCaps } from "./limits.ts";
import { liveSpendCaps } from "./limits.ts";
import { getLiveStore, type LiveSession, type LiveStore } from "./store.ts";

export interface LivePhoto {
  bytes: Uint8Array;
  contentType: string;
  fileName?: string;
}

export interface LiveRunRequest {
  sessionId: string;
  passcode: string | null | undefined;
  capture: CaptureMeasurement;
  photo: LivePhoto | null;
  ownedShades: ShadeEntry[];
}

export type LiveRunOutcome =
  | { kind: "fixture" }
  | {
      kind: "receipt";
      receipt: Receipt;
      balanceBefore: number | null;
      balanceAfter: number | null;
    }
  | { kind: "cap"; message: string }
  | { kind: "refused"; message: string }
  | { kind: "pending"; message: string }
  | { kind: "provider-error"; message: string }
  | { kind: "lost"; message: string };

export interface LiveDeps {
  client: YouCamClient;
  balance: BalanceProvider;
  store: LiveStore;
  catalog: Catalog;
  caps: LiveSpendCaps;
  /** Defaults to the JUDGE_PASSCODE env value at call time. */
  expectedPasscode?: string;
}

const ACCEPTED_CONTENT_TYPES = ["image/jpeg", "image/png"];

/** Server-side backstop for the platform body limit. The browser
 * shrinks the photo first; anything still this large is refused
 * before spend rather than truncated mid-upload. */
export const MAX_PHOTO_BYTES = 5_000_000;

const PENDING_MESSAGE =
  "Your reading is still being processed. No second task was created and nothing new was charged. Check again in a few seconds to collect it.";

export async function runLiveCheck(
  deps: LiveDeps,
  req: LiveRunRequest,
): Promise<LiveRunOutcome> {
  // 1. Passcode first. Wrong or missing means fixture mode, full
  // stop: no spend, no API call, no explanatory error.
  const mode = resolveAccessMode(
    req.passcode,
    deps.expectedPasscode ?? process.env.JUDGE_PASSCODE,
  );
  if (mode !== "judge") return { kind: "fixture" };

  const { store } = deps;
  store.sweepExpired();
  const session = store.session(req.sessionId);

  // 2. Recovery before novelty.
  if (session.inFlight) {
    return pollAndFinish(deps, session, true);
  }
  if (session.startingEntryId) {
    return { kind: "pending", message: PENDING_MESSAGE };
  }
  if (session.unknownChargeEntryId) {
    return {
      kind: "pending",
      message:
        "An earlier live start was interrupted before its outcome was known, so this session is holding its place rather than risking a second charge. The hold clears on its own; fixture mode above keeps working and spends nothing.",
    };
  }

  // 3. Capture gate before money. runDecision would reject too,
  // but only after we had spent; here the rejection is produced
  // with zero network calls.
  const gate = checkCapture(req.capture);
  if (!gate.ok) {
    return {
      kind: "receipt",
      receipt: runDecision({
        capture: req.capture,
        skinTone: null,
        catalog: deps.catalog,
        ownedShades: req.ownedShades,
        readingSource: { kind: "live", unitsSpent: 0 },
      }),
      balanceBefore: null,
      balanceAfter: null,
    };
  }

  // Photo shape checks, still before any spend.
  if (!req.photo) {
    return {
      kind: "refused",
      message: "Attach a photo to start a live check.",
    };
  }
  if (!ACCEPTED_CONTENT_TYPES.includes(req.photo.contentType)) {
    return {
      kind: "refused",
      message: "Live checks accept JPG or PNG photos only.",
    };
  }
  if (
    req.photo.bytes.byteLength === 0 ||
    req.photo.bytes.byteLength > MAX_PHOTO_BYTES
  ) {
    return {
      kind: "refused",
      message:
        "That photo is empty or too large to send. The browser shrinks photos before upload; try a smaller copy.",
    };
  }

  // 4. Reserve, then caps. The reservation is synchronous, so the
  // cap arithmetic below already includes this run before any
  // await can let a second run interleave.
  const entry = store.ledger.reserve(
    "skin-tone",
    "judge",
    "Live Skin Tone check (judge session)",
  );
  session.entryIds.push(entry.id);
  session.startingEntryId = entry.id;

  if (store.sessionCommitted(req.sessionId) > deps.caps.sessionCapUnits) {
    store.ledger.release(entry.id);
    session.startingEntryId = null;
    return {
      kind: "cap",
      message: `Live mode is paused for this session: it has reached its spend cap of ${deps.caps.sessionCapUnits} units. Fixture mode above still works and spends nothing.`,
    };
  }
  if (store.globalCommitted() > deps.caps.globalCapUnits) {
    store.ledger.release(entry.id);
    session.startingEntryId = null;
    return {
      kind: "cap",
      message: `Live mode is paused: the shared live spend cap of ${deps.caps.globalCapUnits} units has been reached. Fixture mode above still works and spends nothing.`,
    };
  }

  // 5. Balance before the call.
  const balanceBefore = await deps.balance.getBalanceUnits();

  // Upload once; the file id is reused for the task and recorded
  // for recovery. An upload failure created no task and no charge.
  let fileId: string;
  try {
    fileId = await uploadFile(
      deps.client,
      "skin-tone",
      req.photo.bytes,
      req.photo.contentType,
      req.photo.fileName ?? "capture.jpg",
    );
  } catch {
    store.ledger.release(entry.id);
    session.startingEntryId = null;
    return {
      kind: "refused",
      message:
        "The photo upload failed before any task was created, so no units were spent. Check the connection and try again.",
    };
  }

  // 6. Create exactly once. A answered refusal (HTTP status) means
  // no task exists, so the reservation is released. An interrupted
  // request (no status) may have landed: the reservation is held
  // and the session is blocked from creating another, because a
  // second create could double-charge.
  let taskId: string;
  try {
    taskId = await createTask(deps.client, "skin-tone", {
      src_file_id: fileId,
    });
  } catch (err) {
    session.startingEntryId = null;
    if (err instanceof YouCamError && err.status !== null) {
      store.ledger.release(entry.id);
      return {
        kind: "refused",
        message:
          "The provider refused to start the reading, so no task exists and no units were spent. Task creation is never retried automatically, because a duplicate would charge twice; you can start again deliberately.",
      };
    }
    session.unknownChargeEntryId = entry.id;
    session.unknownChargeAt = Date.now();
    return {
      kind: "pending",
      message:
        "The start request was interrupted, so the reading may or may not exist. This session is holding its reservation rather than risking a second charge; the hold clears on its own.",
    };
  }

  // Record the run BEFORE polling: from here on, any timeout or
  // abandonment resumes this task id instead of creating anew.
  session.inFlight = {
    taskId,
    fileId,
    ledgerEntryId: entry.id,
    capture: req.capture,
    ownedShades: req.ownedShades,
    balanceBefore,
    startedAt: Date.now(),
  };
  session.startingEntryId = null;

  return pollAndFinish(deps, session, false);
}

/**
 * Poll the session's recorded task to its end and finish the run:
 * settle the ledger from the balance delta and hand the reading
 * to runDecision in the same shape a fixture arrives in.
 */
async function pollAndFinish(
  deps: LiveDeps,
  session: LiveSession,
  resumed: boolean,
): Promise<LiveRunOutcome> {
  const inFlight = session.inFlight;
  if (!inFlight) {
    return { kind: "pending", message: PENDING_MESSAGE };
  }
  const { store } = deps;

  let raw: Record<string, unknown>;
  try {
    raw = await pollTask(deps.client, "skin-tone", inFlight.taskId);
  } catch (err) {
    if (err instanceof YouCamTaskTimeoutError) {
      // Still running. The record and the reservation stay exactly
      // as they are; the next request from this session resumes.
      return { kind: "pending", message: PENDING_MESSAGE };
    }
    if (err instanceof YouCamTaskError) {
      // The task itself ended in an error at the provider. That
      // is a service failure, not a reading the engine cannot
      // judge, so it gets its own outcome and never reaches
      // runDecision: CAN'T TELL is reserved for an actual reading
      // that cannot be judged (for example a completed call whose
      // result carried no readable skin_color). Failed tasks are
      // charged and then refunded in full (proven in the study
      // ledger), so this run spent 0; the reservation is released
      // and the panel may offer ONE deliberate retry. A timeout is
      // deliberately NOT this outcome: a timed-out task may still
      // finish and charge, so it stays on the pending path above
      // and is collected, never restarted.
      store.ledger.release(inFlight.ledgerEntryId);
      session.inFlight = null;
      return {
        kind: "provider-error",
        message:
          "The reading service returned an error before any reading was taken. Failed tasks are refunded in full, so no units were spent. You can try again.",
      };
    }
    if (
      resumed &&
      err instanceof YouCamError &&
      (err.status === 400 || err.status === 404)
    ) {
      // The provider no longer knows this task. Its docs warn that
      // a finished-but-unchecked task still consumes its units, so
      // the reservation settles at the estimated cost rather than
      // being released on a hopeful guess.
      store.ledger.settle(
        inFlight.ledgerEntryId,
        TASK_COSTS["skin-tone"],
      );
      session.inFlight = null;
      return {
        kind: "lost",
        message: `The earlier reading can no longer be collected from the provider. Because the provider charges for tasks that finish, its ${TASK_COSTS["skin-tone"]} units are counted as spent. No new task was created.`,
      };
    }
    // A network failure while polling: the task state is unknown,
    // the record stays, and the next request resumes. Nothing is
    // released on an unknown.
    return { kind: "pending", message: PENDING_MESSAGE };
  }

  // The task succeeded and was charged. Settle from the measured
  // balance delta when both reads exist; otherwise the verified
  // per-call cost stands in, and the receipt note says so.
  const balanceAfter = await deps.balance.getBalanceUnits();
  const delta =
    inFlight.balanceBefore !== null && balanceAfter !== null
      ? inFlight.balanceBefore - balanceAfter
      : null;
  const actualUnits = delta ?? TASK_COSTS["skin-tone"];
  store.ledger.settle(inFlight.ledgerEntryId, actualUnits);
  session.inFlight = null;

  let skinTone = null;
  let note: string | undefined;
  try {
    skinTone = parseSkinToneResult(raw);
    note =
      delta !== null
        ? `Live mode: one Skin Tone call on the uploaded photo. Balance before the call: ${inFlight.balanceBefore} units; after: ${balanceAfter} units; charged ${actualUnits}. Only its skin_color is used; the same payload's hair colour was wrong on 6 of 6 study faces and is ignored.`
        : undefined;
  } catch {
    note = `Live mode: the Skin Tone call completed and was charged ${actualUnits} units, but its result carried no readable skin_color, so there is no reading to judge.`;
  }

  return {
    kind: "receipt",
    receipt: runDecision({
      capture: inFlight.capture,
      skinTone,
      catalog: deps.catalog,
      ownedShades: inFlight.ownedShades,
      readingSource: { kind: "live", unitsSpent: actualUnits, note },
    }),
    balanceBefore: inFlight.balanceBefore,
    balanceAfter,
  };
}

/**
 * Build the production dependencies: the client carries the
 * bearer from lib/youcam/credential.ts (the server-only env key on
 * hosted deployments, the connector surrogate on the VM; it is
 * never logged or sent to a browser), the balance provider reads the
 * provider's own unit endpoint, and the store is the process-wide
 * singleton. Called per request so env changes apply without a
 * restart; the store is the only shared state.
 */
export async function createConnectorLiveDeps(): Promise<LiveDeps> {
  const bearer = await youcamBearerForLiveRun();
  const baseUrl = (
    process.env.YOUCAM_API_BASE_URL ?? "https://yce-api-01.makeupar.com"
  ).replace(/\/+$/, "");
  const client = createYouCamClient({ apiKey: bearer, baseUrl });
  return {
    client,
    balance: new UnitInfoBalanceProvider(client),
    store: getLiveStore(),
    catalog: licensedCatalog(),
    caps: liveSpendCaps(),
  };
}
