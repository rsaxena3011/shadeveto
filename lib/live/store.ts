/**
 * Server-side live-run state: sessions, in-flight tasks, and the
 * recovery records defect #9 demands.
 *
 * The failure this exists for: a Skin Tone task is created, the
 * provider charges for it when it finishes, and the caller times
 * out or walks away before collecting the result. Without a record,
 * the next attempt would create a SECOND task and charge twice.
 * So the moment a task id exists, it is recorded here against the
 * session, together with everything needed to finish the run
 * (capture measurement, owned shades, balance read, ledger entry,
 * and the photo itself: provider uploads are scoped per feature,
 * so finishing a BUY run with its try-on preview means uploading
 * the same photo again under the makeup-vto feature, and a resumed
 * run must still be able to do that). Any later request from the
 * same session resumes that task by id; creation is never repeated
 * for a run already in flight.
 *
 * State is in-memory, one process. That is a real limit, stated
 * plainly: a server restart loses the in-flight pointer and the
 * session accounting with it. Two backstops bound the damage: the
 * provider balance is the ground truth the ledger is reconciled
 * against on every completed run, and stale records expire below.
 *
 * Expiry: an in-flight record older than IN_FLIGHT_TTL_MS is
 * settled at its estimated cost on the next touch. The provider's
 * docs warn that a task which finishes but is never checked still
 * consumes its units, so assuming the charge is the honest side
 * to err on; releasing it would understate spend.
 *
 * Run records (the map below) are the second half of the same
 * discipline, added after the filmed hang of 2026-10-30: a run
 * whose response never reached the browser was unrecoverable
 * because the session identity lived only in a cookie set on
 * that lost response. So a run now also carries a client-chosen
 * run id, generated before the first request and sent with every
 * request for that run. The record binds the id to the session
 * that owns the run and, once the run finishes, to its terminal
 * outcome, so any repeated request carrying the same id (a lost
 * response being collected, a retry layer re-sending the same
 * POST) resumes or replays the SAME run and can never create a
 * second task. Records expire on the same TTL as in-flight runs;
 * a repeat after that is a new run, exactly like the pre-run-id
 * behaviour.
 */

import { TASK_COSTS } from "../config.ts";
import type { ShadeEntry } from "../catalog/types.ts";
import type { CaptureMeasurement } from "../decision/capture.ts";
import { UnitLedger, type LedgerEntry } from "../ledger/ledger.ts";
import type { LiveRunOutcome } from "./runner.ts";

/** Two hours: long past any honest poll window, well inside the
 * provider's 24-hour file retention. */
export const IN_FLIGHT_TTL_MS = 2 * 60 * 60 * 1000;

/** The uploaded photo, kept with the run so a resumed run can
 * finish exactly like a fresh one. Bounded by the runner's photo
 * size cap and by the in-flight TTL below. */
export interface InFlightPhoto {
  bytes: Uint8Array;
  contentType: string;
  fileName?: string;
}

export interface InFlightRun {
  taskId: string;
  fileId: string;
  ledgerEntryId: string;
  capture: CaptureMeasurement;
  ownedShades: ShadeEntry[];
  /** The photo the reading was taken from. Null only on records
   * written before the preview step existed; such a run finishes
   * without a preview rather than failing. */
  photo: InFlightPhoto | null;
  /** Provider balance read before the task was created, if known. */
  balanceBefore: number | null;
  startedAt: number;
}

export interface LiveSession {
  id: string;
  /** Ledger entry ids this session has opened, in order. */
  entryIds: string[];
  /** The run currently in flight for this session, if any. */
  inFlight: InFlightRun | null;
  /**
   * A run whose creation outcome is unknown (the create request
   * was interrupted after it may have landed). Holds the ledger
   * entry id; while set, the session starts no new runs, because a
   * second create could double-charge. Cleared by TTL settlement.
   */
  unknownChargeEntryId: string | null;
  unknownChargeAt: number | null;
  /**
   * Ledger entry id of a run between reservation and task
   * creation. Set synchronously when a run starts so a concurrent
   * request from the same session (a double click, a retrying
   * browser) sees a run already starting and never reserves or
   * creates a second one.
   */
  startingEntryId: string | null;
}

/**
 * One client-identified run: the session that owns it and, once
 * the run has finished in a way that must replay identically,
 * its terminal outcome. A null outcome means the run is still
 * active (starting, in flight, or holding an unknown charge) and
 * is recovered through the owning session's state, never through
 * a second creation.
 */
export interface LiveRunRecord {
  sessionId: string;
  outcome: LiveRunOutcome | null;
  createdAt: number;
}

export class LiveStore {
  readonly ledger = new UnitLedger();
  private readonly sessions = new Map<string, LiveSession>();
  private readonly runs = new Map<string, LiveRunRecord>();

  /** The record for a client-supplied run id, if one was begun. */
  runRecord(runId: string): LiveRunRecord | undefined {
    return this.runs.get(runId);
  }

  /**
   * Begin (or rebind) the record for a run id. Called at the
   * moment a run reserves its spend: before that point nothing
   * exists worth replaying, and the free deterministic outcomes
   * (the capture-gate receipt) recompute identically.
   */
  beginRun(runId: string, sessionId: string): LiveRunRecord {
    const existing = this.runs.get(runId);
    if (existing) {
      existing.sessionId = sessionId;
      return existing;
    }
    const record: LiveRunRecord = {
      sessionId,
      outcome: null,
      createdAt: Date.now(),
    };
    this.runs.set(runId, record);
    return record;
  }

  /** Mark a run finished with the outcome repeats must replay. */
  finishRun(runId: string, outcome: LiveRunOutcome): void {
    const record = this.runs.get(runId);
    if (record) record.outcome = outcome;
  }

  session(id: string): LiveSession {
    let found = this.sessions.get(id);
    if (!found) {
      found = {
        id,
        entryIds: [],
        inFlight: null,
        unknownChargeEntryId: null,
        unknownChargeAt: null,
        startingEntryId: null,
      };
      this.sessions.set(id, found);
    }
    return found;
  }

  /** Units one ledger entry currently commits (spent or held). */
  private committedOf(entry: LedgerEntry): number {
    if (entry.status === "settled") return entry.actualUnits ?? 0;
    if (entry.status === "reserved") return entry.estimatedUnits;
    return 0;
  }

  private entryById(id: string): LedgerEntry | undefined {
    return this.ledger.list().find((e) => e.id === id);
  }

  /** Units this session has committed across all its runs. */
  sessionCommitted(sessionId: string): number {
    const session = this.session(sessionId);
    let total = 0;
    for (const id of session.entryIds) {
      const entry = this.entryById(id);
      if (entry) total += this.committedOf(entry);
    }
    return total;
  }

  /** Units all sessions together have committed. */
  globalCommitted(): number {
    return this.ledger.committedUnits();
  }

  /**
   * Settle stale recovery records at their estimated cost (see the
   * header for why settling, not releasing, is the honest side).
   * Returns how many records were settled, for logging.
   */
  sweepExpired(now: number = Date.now()): number {
    let settled = 0;
    for (const session of this.sessions.values()) {
      if (
        session.inFlight &&
        now - session.inFlight.startedAt > IN_FLIGHT_TTL_MS
      ) {
        const entry = this.entryById(session.inFlight.ledgerEntryId);
        if (entry && entry.status === "reserved") {
          this.ledger.settle(entry.id, entry.estimatedUnits);
          settled += 1;
        }
        session.inFlight = null;
      }
      if (
        session.unknownChargeEntryId &&
        session.unknownChargeAt !== null &&
        now - session.unknownChargeAt > IN_FLIGHT_TTL_MS
      ) {
        const entry = this.entryById(session.unknownChargeEntryId);
        if (entry && entry.status === "reserved") {
          this.ledger.settle(entry.id, entry.estimatedUnits);
          settled += 1;
        }
        session.unknownChargeEntryId = null;
        session.unknownChargeAt = null;
      }
    }
    // Finished run records expire on the same horizon: the
    // replay guarantee covers the window in which a lost
    // response can plausibly be retried or collected, and no
    // longer. Active records are never swept here; their owning
    // session's state above is what settles them.
    for (const [runId, record] of this.runs) {
      if (
        record.outcome !== null &&
        now - record.createdAt > IN_FLIGHT_TTL_MS
      ) {
        this.runs.delete(runId);
      }
    }
    return settled;
  }
}

/** The skin-tone estimate used when a stale record is settled. */
export const SKIN_TONE_ESTIMATE_UNITS = TASK_COSTS["skin-tone"];

/**
 * The process-wide store. Kept on globalThis so Next.js route
 * bundles and dev-mode reloads share one instance instead of
 * forking the accounting per module copy.
 */
export function getLiveStore(): LiveStore {
  const global = globalThis as unknown as {
    __shadevetoLiveStore?: LiveStore;
  };
  if (!global.__shadevetoLiveStore) {
    global.__shadevetoLiveStore = new LiveStore();
  }
  return global.__shadevetoLiveStore;
}
