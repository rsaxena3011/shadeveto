import { studyFixtureCatalog } from "../../decision/fixtures.ts";
import type { CaptureMeasurement } from "../../decision/capture.ts";
import type { BalanceProvider } from "../../ledger/ledger.ts";
import {
  createYouCamClient,
  type YouCamClient,
} from "../../youcam/client.ts";
import {
  runLiveCheck,
  type LiveDeps,
  type LivePhoto,
} from "../runner.ts";
import { IN_FLIGHT_TTL_MS, LiveStore } from "../store.ts";
import { awaitBounded } from "../wait.ts";

/**
 * The 2026-10-30 hang fix, against scripted fakes (no real API
 * call happens here). The filmed failure had three layers, and
 * each gets its load-bearing assertions:
 *
 * - The client's wait is bounded (lib/live/wait.ts): a response
 *   that never settles ends as "timeout" at the bound, not as an
 *   endless "Running...".
 * - A run is resumable WITHOUT its response: the collect
 *   carries the run id and arrives under a brand-new session
 *   (the cookie rode on the lost response), and still collects
 *   the SAME run, created exactly once.
 * - A repeated POST with the same run id can never create a
 *   second task: while the run is active it resumes or waits,
 *   and once the run has finished it replays the recorded
 *   outcome, from any session, with zero new API calls. A NEW
 *   run id is a genuinely new run and does create a task (the
 *   provider-error retry depends on that distinction).
 * - Replay never bypasses the passcode gate.
 */

let pass = 0;
let fail = 0;
function check(ok: boolean, label: string) {
  if (ok) {
    pass++;
    console.log(`PASS  ${label}`);
  } else {
    fail++;
    console.log(`FAIL  ${label}`);
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** The study's real tone2 payload shape, values verbatim (same
 * fixture as lib/live/test/live.test.ts). */
const TONE2_SUCCESS = {
  data: {
    task_status: "success",
    results: {
      color: {
        eye_color: "#362724",
        eye_color_name: "Brown",
        lip_color: "#b66c5f",
        eyebrow_color: "#3e3834",
        skin_color: "#a77d60",
        hair_color: "#FAF0BE",
        hair_color_name: "Blonde",
      },
      face_quality: {
        has_face: true,
        area: "good",
        frontal: "good",
        lighting: "good",
        faceangle: "good",
      },
    },
  },
};

const VTO_SUCCESS = {
  data: {
    task_status: "success",
    results: { image_url: "https://img.example/vto-preview.jpg" },
  },
};

interface ApiScript {
  skinCreatePosts: number;
  vtoCreatePosts: number;
  total: number;
}

function scriptedApi(
  statusHandler: (script: ApiScript, url: string) => Response,
): { client: YouCamClient; script: ApiScript } {
  const script: ApiScript = { skinCreatePosts: 0, vtoCreatePosts: 0, total: 0 };
  const fetchFn = (async (input: unknown, init?: { method?: string }) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    script.total += 1;
    if (url.includes("/file/") && method === "POST") {
      return jsonResponse({
        data: {
          files: [
            {
              file_id: "file-1",
              requests: [{ url: "https://up.example/put", headers: {} }],
            },
          ],
        },
      });
    }
    if (method === "PUT") {
      return new Response(null, { status: 200 });
    }
    if (url.includes("/task/") && method === "POST") {
      if (url.includes("/task/makeup-vto")) script.vtoCreatePosts += 1;
      if (url.includes("/task/skin-tone")) script.skinCreatePosts += 1;
      return jsonResponse({
        data: {
          task_id: url.includes("/task/makeup-vto") ? "task-vto" : "task-1",
        },
      });
    }
    return statusHandler(script, url);
  }) as unknown as typeof fetch;
  const client = createYouCamClient({
    apiKey: "hsurr:test-surrogate",
    baseUrl: "https://api.example",
    fetchFn,
    pollIntervalMs: 5,
    pollTimeoutMs: 60,
  });
  return { client, script };
}

class QueueBalance implements BalanceProvider {
  private readonly values: (number | null)[];
  constructor(values: (number | null)[]) {
    this.values = [...values];
  }
  async getBalanceUnits(): Promise<number | null> {
    return this.values.length > 0 ? this.values.shift()! : null;
  }
}

const GOOD_CAPTURE: CaptureMeasurement = {
  faceDetected: true,
  faceWidthPx: 680,
  imageWidthPx: 1000,
};
const PHOTO: LivePhoto = {
  bytes: new Uint8Array([1, 2, 3]),
  contentType: "image/jpeg",
  fileName: "capture.jpg",
};

function makeDeps(
  client: YouCamClient,
  balance: BalanceProvider,
): { deps: LiveDeps; store: LiveStore } {
  const store = new LiveStore();
  return {
    store,
    deps: {
      client,
      balance,
      store,
      catalog: studyFixtureCatalog(),
      caps: { sessionCapUnits: 60, globalCapUnits: 300 },
      expectedPasscode: "test-pass",
    },
  };
}

function req(overrides: Partial<Parameters<typeof runLiveCheck>[1]> = {}) {
  return {
    sessionId: "session-1",
    passcode: "test-pass",
    capture: GOOD_CAPTURE,
    photo: PHOTO,
    ownedShades: [],
    ...overrides,
  };
}

async function main() {
  // 1. The bounded wait: a response that never settles ends as
  // a timeout at the bound (and aborts the operation's signal),
  // a settled answer comes through, a failed one is unreachable.
  {
    let seenSignal: AbortSignal | null = null;
    const timedOut = await awaitBounded((signal) => {
      seenSignal = signal;
      return new Promise<number>(() => {});
    }, 25);
    check(timedOut.kind === "timeout", "a response that never settles ends as a timeout at the bound, not an endless wait");
    check(
      seenSignal !== null && (seenSignal as AbortSignal).aborted,
      "the timeout aborts the operation's signal",
    );
    const done = await awaitBounded(async () => 42, 1000);
    check(
      done.kind === "done" && done.value === 42,
      "a settled answer comes through as done",
    );
    const unreachable = await awaitBounded(async () => {
      throw new TypeError("network down");
    }, 1000);
    check(
      unreachable.kind === "unreachable",
      "a failed request is reported unreachable, distinct from a timeout",
    );
  }

  // 2. Resume without the response: the first POST's answer is
  // "lost" (the task is still running, the poll times out). The
  // collect arrives under a DIFFERENT session, as it would when
  // the session cookie rode on the lost response, carrying only
  // the run id. It collects the same run; one task ever created.
  {
    let done = false;
    const { client, script } = scriptedApi((_script, url) =>
      done
        ? jsonResponse(url.includes("makeup-vto") ? VTO_SUCCESS : TONE2_SUCCESS)
        : jsonResponse({ data: { task_status: "running" } }),
    );
    const { deps, store } = makeDeps(
      client,
      new QueueBalance([500, 480, 479]),
    );
    const first = await runLiveCheck(
      deps,
      req({ sessionId: "browser-a", runId: "run-lost-1" }),
    );
    check(first.kind === "pending", "slow first run reports pending (its response is the one that gets lost)");
    check(script.skinCreatePosts === 1, "the lost run created exactly one task");
    done = true;
    const collected = await runLiveCheck(
      deps,
      req({ sessionId: "browser-b", runId: "run-lost-1", photo: null }),
    );
    check(
      collected.kind === "receipt" &&
        collected.receipt.measuredToneHex === "#a77d60",
      "collect under a new session with the run id resumes the same run to its receipt",
    );
    check(
      script.skinCreatePosts === 1,
      "the collect created no second task",
    );
    check(
      collected.kind === "receipt" &&
        collected.balanceBefore === 500 &&
        collected.balanceAfter === 479,
      "the collected run settles on its own balance reads (500 before, 479 after reading + preview)",
    );
    check(
      store.globalCommitted() === 21,
      "one run, one charge: 20 reading + 1 preview committed in total",
    );
  }

  // 3. Duplicate POST while the run is active (same session,
  // same id): it waits on the same run, never re-creates.
  {
    let done = false;
    const { client, script } = scriptedApi((_script, url) =>
      done
        ? jsonResponse(url.includes("makeup-vto") ? VTO_SUCCESS : TONE2_SUCCESS)
        : jsonResponse({ data: { task_status: "running" } }),
    );
    const { deps } = makeDeps(client, new QueueBalance([500, 480, 479]));
    const first = await runLiveCheck(deps, req({ runId: "run-dup-active" }));
    const duplicate = await runLiveCheck(deps, req({ runId: "run-dup-active" }));
    check(
      first.kind === "pending" && duplicate.kind === "pending",
      "a duplicate POST during an active run reports pending, like the original",
    );
    check(
      script.skinCreatePosts === 1,
      "duplicate POST during an active run creates no second task",
    );
    done = true;
    const collected = await runLiveCheck(
      deps,
      req({ runId: "run-dup-active", photo: null }),
    );
    check(
      collected.kind === "receipt" && script.skinCreatePosts === 1,
      "the run still collects exactly once after the duplicates",
    );
  }

  // 4. Duplicate POST after the run finished: the recorded
  // outcome replays verbatim, from the same session AND from a
  // different one, with zero new API calls and zero new spend.
  // A replay attempt without the passcode gets fixture mode and
  // learns nothing.
  {
    const { client, script } = scriptedApi((_script, url) =>
      jsonResponse(url.includes("makeup-vto") ? VTO_SUCCESS : TONE2_SUCCESS),
    );
    const { deps, store } = makeDeps(
      client,
      new QueueBalance([900, 880, 879]),
    );
    const first = await runLiveCheck(deps, req({ runId: "run-done-1" }));
    check(first.kind === "receipt", "the original run completes");
    const callsAfterRun = script.total;
    const replaySame = await runLiveCheck(deps, req({ runId: "run-done-1" }));
    check(
      first.kind === "receipt" &&
        replaySame.kind === "receipt" &&
        replaySame.receipt === first.receipt,
      "a duplicate POST after completion replays the same receipt",
    );
    const replayOtherSession = await runLiveCheck(
      deps,
      req({ sessionId: "browser-elsewhere", runId: "run-done-1", photo: null }),
    );
    check(
      replayOtherSession.kind === "receipt",
      "the replay works from a different session too (the lost-cookie case, after the fact)",
    );
    check(
      script.total === callsAfterRun && script.skinCreatePosts === 1,
      "replays make zero API calls and create no second task",
    );
    check(
      store.globalCommitted() === 21,
      "replays charge nothing: the run's 21 units stand alone",
    );
    const noPasscode = await runLiveCheck(
      deps,
      req({ runId: "run-done-1", passcode: "wrong" }),
    );
    check(
      noPasscode.kind === "fixture" && script.total === callsAfterRun,
      "a replay attempt with a wrong passcode gets fixture mode, never the recorded outcome",
    );

    // 5. A NEW run id is a new run: it goes through the whole
    // flow and creates its own task. Dedupe is keyed on the
    // run's identity, not a blanket one-run lock.
    const second = await runLiveCheck(deps, req({ runId: "run-done-2" }));
    check(
      second.kind === "receipt" && script.skinCreatePosts === 2,
      "a new run id starts a genuinely new run with its own task",
    );
  }

  // 6. Provider-error: the recorded error replays for the same
  // id (no silent second charge), and the deliberate retry the
  // panel offers works because it carries a NEW id.
  {
    let failing = true;
    const { client, script } = scriptedApi((_script, url) =>
      failing && !url.includes("makeup-vto")
        ? jsonResponse({
            data: { task_status: "error", error_message: "no face found" },
          })
        : jsonResponse(url.includes("makeup-vto") ? VTO_SUCCESS : TONE2_SUCCESS),
    );
    const { deps, store } = makeDeps(
      client,
      new QueueBalance([900, 900, 880, 879]),
    );
    const first = await runLiveCheck(deps, req({ runId: "run-err-1" }));
    check(first.kind === "provider-error", "the failed run ends in provider-error");
    const duplicate = await runLiveCheck(deps, req({ runId: "run-err-1" }));
    check(
      duplicate.kind === "provider-error" && script.skinCreatePosts === 1,
      "a duplicate of the failed run replays the error, creating nothing",
    );
    check(
      store.globalCommitted() === 0,
      "the failed run and its replay commit nothing (failed tasks are refunded)",
    );
    failing = false;
    const retry = await runLiveCheck(deps, req({ runId: "run-err-2" }));
    check(
      retry.kind === "receipt" && script.skinCreatePosts === 2,
      "the deliberate retry under a new run id creates its own task and completes",
    );
  }

  // 7. Finished records expire on the in-flight horizon: after
  // it, the id names nothing and a repeat is a fresh run, the
  // pre-run-id behaviour.
  {
    const { client, script } = scriptedApi((_script, url) =>
      jsonResponse(url.includes("makeup-vto") ? VTO_SUCCESS : TONE2_SUCCESS),
    );
    const { deps, store } = makeDeps(
      client,
      new QueueBalance([900, 880, 879, 879, 859, 858]),
    );
    await runLiveCheck(deps, req({ runId: "run-old-1" }));
    check(
      store.runRecord("run-old-1")?.outcome?.kind === "receipt",
      "a finished run's outcome is on record",
    );
    store.sweepExpired(Date.now() + IN_FLIGHT_TTL_MS + 1000);
    check(
      store.runRecord("run-old-1") === undefined,
      "the finished record expires on the in-flight TTL",
    );
    const fresh = await runLiveCheck(deps, req({ runId: "run-old-1" }));
    check(
      fresh.kind === "receipt" && script.skinCreatePosts === 2,
      "after expiry the same id is a fresh run again, with its own task",
    );
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
