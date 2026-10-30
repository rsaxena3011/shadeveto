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
 * 8. Preview last, and only on a BUY. When (and only when) the
 *    finished receipt says BUY, one Makeup VTO render of the
 *    winning shade is attempted under the same discipline as the
 *    reading: its own ledger reservation, the same caps, a fresh
 *    upload of the same photo under the makeup-vto feature
 *    (uploads are feature-scoped), creation never retried, and
 *    settlement from the measured balance delta. The render is a
 *    labelled preview: it is produced AFTER the verdict exists
 *    and can never change it. Any preview failure degrades to the
 *    receipt the engine produced, with the planner step logged
 *    skipped and the reason stated; the receipt's totals always
 *    carry whatever the preview actually cost.
 *
 * Run identity (2026-10-30 hang fix): the client generates a
 * run id before its first request for a run and sends it with
 * every request for that run. The store records the id against
 * the owning session at reservation time and against the run's
 * terminal outcome when it finishes. A repeat request carrying
 * the same id therefore replays a finished run or resumes an
 * active one THROUGH THE RECORD, never through the session
 * cookie alone: the cookie is set on the run's own response, so
 * when that response was lost (the filmed hang) the browser held
 * no session for its run, and any duplicate execution of the
 * same POST arrived as a brand-new session and created a second
 * task at a second charge. A request carrying a NEW id is a new
 * run, deliberately, and goes through every check below.
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
  runMakeupVto,
  uploadFile,
  YouCamError,
  YouCamTaskError,
  YouCamTaskTimeoutError,
  type YouCamClient,
} from "../youcam/client.ts";
import { foundationVtoParams } from "../youcam/types.ts";
import { youcamBearerForLiveRun } from "../youcam/credential.ts";
import { UnitInfoBalanceProvider } from "./balance.ts";
import type { LiveSpendCaps } from "./limits.ts";
import { liveSpendCaps } from "./limits.ts";
import {
  getLiveStore,
  type InFlightPhoto,
  type LiveSession,
  type LiveStore,
} from "./store.ts";

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
  /**
   * The client-chosen identity of this run, generated before
   * the first request and repeated on every collect (see the
   * header). Absent on requests from clients that predate run
   * ids; those keep the cookie-session behaviour exactly.
   */
  runId?: string | null;
}

/**
 * A finished Makeup VTO preview render, carried next to the
 * receipt rather than inside it: the Receipt is the decision
 * engine's output and the engine never renders, so the preview
 * travels on the live outcome the same way the balance reads do.
 * The URL is the provider's render link; per the client docs it
 * expires, so it is shown at receipt time, not archived.
 */
export interface LivePreview {
  imageUrl: string;
  /** "Brand ShadeName" of the winning shade that was rendered. */
  shadeLabel: string;
  colorHex: string;
}

export type LiveRunOutcome =
  | { kind: "fixture" }
  | {
      kind: "receipt";
      receipt: Receipt;
      balanceBefore: number | null;
      balanceAfter: number | null;
      /** The BUY preview render, when one was produced. */
      preview: LivePreview | null;
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
  let session = store.session(req.sessionId);

  // Run identity, checked only now that the passcode has passed:
  // a recorded outcome must never be replayed to a request that
  // did not clear the gate. A finished record replays verbatim.
  // An active record resumes through its OWNING session, which
  // is the whole point: the request's cookie session may be a
  // fresh one minted because the original response (the one
  // carrying the cookie) never arrived. An active record whose
  // owning session holds nothing anymore (its unknown-charge
  // hold expired in the sweep above) is rebound to this session
  // and the request proceeds as the run's fresh start.
  const runId = req.runId ?? null;
  const runRecord = runId ? store.runRecord(runId) : undefined;
  if (runRecord?.outcome) return runRecord.outcome;
  if (runRecord && runId) {
    const owner = store.session(runRecord.sessionId);
    if (
      owner.inFlight ||
      owner.startingEntryId ||
      owner.unknownChargeEntryId
    ) {
      session = owner;
    } else {
      store.beginRun(runId, session.id);
    }
  }

  // Terminal outcomes of an identified run are recorded against
  // its id, so a repeat of this same request replays them
  // instead of re-executing. Pending is not terminal: the run is
  // still active and the record stays open for its collect.
  const finish = (outcome: LiveRunOutcome): LiveRunOutcome => {
    if (runId && outcome.kind !== "pending") {
      store.finishRun(runId, outcome);
    }
    return outcome;
  };

  // 2. Recovery before novelty.
  if (session.inFlight) {
    return finish(await pollAndFinish(deps, session, true));
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
      preview: null,
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
  // The run exists from here on: bind its id (when it carries
  // one) to this session before any await, so even a request
  // that dies mid-flight leaves a record a repeat can resume or
  // replay instead of a second charge.
  if (runId) store.beginRun(runId, session.id);

  if (store.sessionCommitted(session.id) > deps.caps.sessionCapUnits) {
    store.ledger.release(entry.id);
    session.startingEntryId = null;
    return finish({
      kind: "cap",
      message: `Live mode is paused for this session: it has reached its spend cap of ${deps.caps.sessionCapUnits} units. Fixture mode above still works and spends nothing.`,
    });
  }
  if (store.globalCommitted() > deps.caps.globalCapUnits) {
    store.ledger.release(entry.id);
    session.startingEntryId = null;
    return finish({
      kind: "cap",
      message: `Live mode is paused: the shared live spend cap of ${deps.caps.globalCapUnits} units has been reached. Fixture mode above still works and spends nothing.`,
    });
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
    return finish({
      kind: "refused",
      message:
        "The photo upload failed before any task was created, so no units were spent. Check the connection and try again.",
    });
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
      return finish({
        kind: "refused",
        message:
          "The provider refused to start the reading, so no task exists and no units were spent. Task creation is never retried automatically, because a duplicate would charge twice; you can start again deliberately.",
      });
    }
    session.unknownChargeEntryId = entry.id;
    session.unknownChargeAt = Date.now();
    return finish({
      kind: "pending",
      message:
        "The start request was interrupted, so the reading may or may not exist. This session is holding its reservation rather than risking a second charge; the hold clears on its own.",
    });
  }

  // Record the run BEFORE polling: from here on, any timeout or
  // abandonment resumes this task id instead of creating anew.
  session.inFlight = {
    taskId,
    fileId,
    ledgerEntryId: entry.id,
    capture: req.capture,
    ownedShades: req.ownedShades,
    photo: req.photo,
    balanceBefore,
    startedAt: Date.now(),
  };
  session.startingEntryId = null;

  return finish(await pollAndFinish(deps, session, false));
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

  const receipt = runDecision({
    capture: inFlight.capture,
    skinTone,
    catalog: deps.catalog,
    ownedShades: inFlight.ownedShades,
    readingSource: { kind: "live", unitsSpent: actualUnits, note },
  });

  // The verdict exists now and nothing below can change it. Only
  // a BUY earns the try-on preview; every other verdict returns
  // the receipt exactly as the engine produced it.
  if (receipt.verdict !== "BUY") {
    return {
      kind: "receipt",
      receipt,
      balanceBefore: inFlight.balanceBefore,
      balanceAfter,
      preview: null,
    };
  }
  const finished = await attachBuyPreview(
    deps,
    session,
    inFlight.photo,
    receipt,
    balanceAfter,
  );
  return {
    kind: "receipt",
    receipt: finished.receipt,
    balanceBefore: inFlight.balanceBefore,
    balanceAfter: finished.balanceAfter,
    preview: finished.preview,
  };
}

/**
 * Return a copy of the receipt whose makeup-vto-preview planner
 * step (and, when the preview cost anything, the run total) tells
 * the truth about the render attempt. This is the runner's own
 * accounting, applied to the receipt it hands back: the engine
 * emits the step as skipped because the ENGINE never renders, and
 * the runner, which owns live spend, records what the live run
 * actually did. Verdict, headline, ranking, cluster and every
 * other step are copied untouched.
 */
function withVtoStep(
  receipt: Receipt,
  patch: { outcome: "done" | "skipped"; unitsSpent: number; why: string },
): Receipt {
  return {
    ...receipt,
    unitsSpent: receipt.unitsSpent + patch.unitsSpent,
    plannerLog: receipt.plannerLog.map((step) =>
      step.step === "makeup-vto-preview"
        ? {
            ...step,
            outcome: patch.outcome,
            unitsSpent: patch.unitsSpent,
            why: patch.why,
          }
        : step,
    ),
  };
}

/**
 * The BUY-only Makeup VTO preview (header step 8). Renders the
 * winning shade (the cluster winner, ranking position 1) on the
 * uploaded photo at the study's fixed settings and settles from
 * the balance delta, exactly like the reading. Every failure
 * lands as a skipped planner step with the honest reason and the
 * receipt otherwise intact; nothing here retries, and nothing
 * here can touch the verdict, which was final before this ran.
 */
async function attachBuyPreview(
  deps: LiveDeps,
  session: LiveSession,
  photo: InFlightPhoto | null,
  receipt: Receipt,
  balanceAfterReading: number | null,
): Promise<{
  receipt: Receipt;
  balanceAfter: number | null;
  preview: LivePreview | null;
}> {
  const { store } = deps;
  const winner = receipt.ranking[0]?.shade;
  const vtoCost = TASK_COSTS["makeup-vto"];
  if (!winner) {
    // A BUY always carries a ranking; if that ever stopped being
    // true, the receipt stands as produced rather than guessing.
    return { receipt, balanceAfter: balanceAfterReading, preview: null };
  }
  if (!photo) {
    return {
      receipt: withVtoStep(receipt, {
        outcome: "skipped",
        unitsSpent: 0,
        why: "Not run: the uploaded photo is no longer available to render against, so no preview was attempted and nothing was spent.",
      }),
      balanceAfter: balanceAfterReading,
      preview: null,
    };
  }

  // Reserve, then caps, same as the reading: the reservation is
  // what the caps are checked against, so a session whose
  // readings already fill its cap skips the preview instead of
  // slipping past it.
  const entry = store.ledger.reserve(
    "makeup-vto",
    "judge",
    "Live Makeup VTO preview on a BUY receipt (judge session)",
  );
  session.entryIds.push(entry.id);
  if (
    store.sessionCommitted(session.id) > deps.caps.sessionCapUnits ||
    store.globalCommitted() > deps.caps.globalCapUnits
  ) {
    store.ledger.release(entry.id);
    return {
      receipt: withVtoStep(receipt, {
        outcome: "skipped",
        unitsSpent: 0,
        why: "Not run: the live spend caps leave no room for the preview, so no render was attempted and nothing was spent.",
      }),
      balanceAfter: balanceAfterReading,
      preview: null,
    };
  }

  const balanceDelta = (after: number | null): number | null =>
    balanceAfterReading !== null && after !== null
      ? balanceAfterReading - after
      : null;

  try {
    // Uploads are scoped per feature: the skin-tone file id
    // cannot serve a makeup-vto task, so the same photo goes up
    // once more under the makeup-vto feature.
    const vtoFileId = await uploadFile(
      deps.client,
      "makeup-vto",
      photo.bytes,
      photo.contentType,
      photo.fileName ?? "capture.jpg",
    );
    const result = await runMakeupVto(
      deps.client,
      vtoFileId,
      foundationVtoParams(winner.hex),
    );
    const balanceFinal = await deps.balance.getBalanceUnits();
    const settled = balanceDelta(balanceFinal) ?? vtoCost;
    store.ledger.settle(entry.id, settled);
    return {
      receipt: withVtoStep(receipt, {
        outcome: "done",
        unitsSpent: settled,
        why: `Rendered a labelled preview of the winning shade, ${winner.brand} ${winner.shadeName} (${winner.hex}), on the uploaded photo at the study's fixed settings. The render is a preview only: it was produced after the verdict and did not feed it; the verdict rests on the colour distances above.`,
      }),
      balanceAfter: balanceFinal ?? balanceAfterReading,
      preview: {
        imageUrl: result.imageUrl,
        shadeLabel: `${winner.brand} ${winner.shadeName}`,
        colorHex: winner.hex,
      },
    };
  } catch (err) {
    const balanceFinal = await deps.balance.getBalanceUnits();
    const delta = balanceDelta(balanceFinal);
    const balanceAfter = balanceFinal ?? balanceAfterReading;
    if (err instanceof YouCamTaskTimeoutError) {
      // The render may still finish and charge, so its cost is
      // counted: the measured delta when one is already visible,
      // otherwise the verified per-call cost, per the same
      // finished-but-unchecked rule the reading follows.
      const settled = delta !== null && delta > 0 ? delta : vtoCost;
      store.ledger.settle(entry.id, settled);
      return {
        receipt: withVtoStep(receipt, {
          outcome: "skipped",
          unitsSpent: settled,
          why: `The preview render did not finish in time, so no preview is shown. The provider charges for tasks that finish, so its ${settled} unit${settled === 1 ? "" : "s"} are counted as spent.`,
        }),
        balanceAfter,
        preview: null,
      };
    }
    if (err instanceof YouCamTaskError) {
      // Failed tasks are charged and then refunded in full
      // (proven in the study ledger), so the preview spent the
      // measured delta, normally zero.
      const settled = delta ?? 0;
      if (settled > 0) {
        store.ledger.settle(entry.id, settled);
      } else {
        store.ledger.release(entry.id);
      }
      return {
        receipt: withVtoStep(receipt, {
          outcome: "skipped",
          unitsSpent: settled,
          why:
            settled > 0
              ? `The preview render failed at the provider, so no preview is shown. It was charged ${settled} unit${settled === 1 ? "" : "s"} before failing.`
              : "The preview render failed at the provider, so no preview is shown. Failed tasks are refunded in full, so the preview spent nothing.",
        }),
        balanceAfter,
        preview: null,
      };
    }
    if (err instanceof YouCamError && err.status !== null) {
      // An answered refusal (the upload ticket, the upload, or
      // the create): no task exists, nothing was charged.
      store.ledger.release(entry.id);
      return {
        receipt: withVtoStep(receipt, {
          outcome: "skipped",
          unitsSpent: 0,
          why: "The preview could not be started: the provider refused the upload or the render request, so no preview is shown and nothing was spent.",
        }),
        balanceAfter,
        preview: null,
      };
    }
    // What remains: the render finished but returned no usable
    // image, or the attempt's outcome is genuinely unknown. A
    // finished task consumes its units, so settle at the measured
    // delta, else the verified cost, and say so on the receipt.
    const settled = delta ?? vtoCost;
    store.ledger.settle(entry.id, settled);
    return {
      receipt: withVtoStep(receipt, {
        outcome: "skipped",
        unitsSpent: settled,
        why: `The preview render produced no usable image, so no preview is shown. Its ${settled} unit${settled === 1 ? "" : "s"} are counted as spent.`,
      }),
      balanceAfter,
      preview: null,
    };
  }
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
