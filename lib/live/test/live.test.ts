import { studyFixtureCatalog, studyTone } from "../../decision/fixtures.ts";
import { runDecision } from "../../decision/decision.ts";
import type { CaptureMeasurement } from "../../decision/capture.ts";
import type { BalanceProvider } from "../../ledger/ledger.ts";
import {
  createYouCamClient,
  getUnitBalance,
  type YouCamClient,
} from "../../youcam/client.ts";
import { parseSurrogateResponse } from "../../youcam/credential.ts";
import { liveSpendCaps } from "../limits.ts";
import {
  runLiveCheck,
  type LiveDeps,
  type LivePhoto,
} from "../runner.ts";
import { LiveStore } from "../store.ts";
import { buildReceiptView } from "../../ui/receipt-view.ts";
import { buildOwnedShade } from "../../ui/fixture-session.ts";

/**
 * Live mode behaviour, all against scripted fakes: no real API
 * call happens in this suite. The load-bearing assertions:
 * - no passcode (or a wrong one) means fixture mode and ZERO
 *   network calls: live is unreachable without the passcode.
 * - the capture gate rejects an exactly-60% face BEFORE any spend.
 * - a spend cap refuses before task creation, with the earlier
 *   run's charge intact.
 * - a failed task creation is attempted exactly once.
 * - a timed-out run is resumed by task id, never re-created, and
 *   its reservation is held (not released) while it is unknown.
 * - a live result shaped exactly like the study's real tone2
 *   payload flows through runDecision to the same verdict the
 *   fixture replay gives, labelled LIVE, with the balance delta
 *   settled as the spend.
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

/** The study's real tone2 payload shape (study/results/
 * tone2_warm_medium_skin_tone.json), values verbatim. */
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

interface ApiScript {
  ticketPosts: number;
  puts: number;
  createPosts: number;
  statusGets: number;
  total: number;
}

function scriptedApi(
  statusHandler: (script: ApiScript) => Response,
  opts?: { createStatus?: number; createThrows?: boolean },
): { client: YouCamClient; script: ApiScript } {
  const script: ApiScript = {
    ticketPosts: 0,
    puts: 0,
    createPosts: 0,
    statusGets: 0,
    total: 0,
  };
  const fetchFn = (async (input: unknown, init?: { method?: string }) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    script.total += 1;
    if (url.includes("/file/") && method === "POST") {
      script.ticketPosts += 1;
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
      script.puts += 1;
      return new Response(null, { status: 200 });
    }
    if (url.includes("/task/") && method === "POST") {
      script.createPosts += 1;
      if (opts?.createThrows) throw new TypeError("network down");
      if (opts?.createStatus && opts.createStatus !== 200) {
        return jsonResponse({ error: "refused" }, opts.createStatus);
      }
      return jsonResponse({ data: { task_id: "task-1" } });
    }
    script.statusGets += 1;
    return statusHandler(script);
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
  caps = { sessionCapUnits: 60, globalCapUnits: 300 },
): { deps: LiveDeps; store: LiveStore } {
  const store = new LiveStore();
  return {
    store,
    deps: {
      client,
      balance,
      store,
      catalog: studyFixtureCatalog(),
      caps,
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
  // 1. Passcode gate: wrong or missing passcode, fixture mode,
  // zero network calls, zero ledger activity.
  {
    const { client, script } = scriptedApi(() => jsonResponse(TONE2_SUCCESS));
    const { deps, store } = makeDeps(client, new QueueBalance([]));
    const wrong = await runLiveCheck(deps, req({ passcode: "nope" }));
    check(wrong.kind === "fixture", "wrong passcode returns fixture mode");
    const missing = await runLiveCheck(deps, req({ passcode: null }));
    check(missing.kind === "fixture", "missing passcode returns fixture mode");
    check(script.total === 0, "no passcode means zero API calls");
    check(
      store.globalCommitted() === 0,
      "no passcode means zero units committed",
    );
    const unconfigured = await runLiveCheck(
      { ...deps, expectedPasscode: undefined },
      req({ passcode: "test-pass" }),
    );
    check(
      unconfigured.kind === "fixture" && script.total === 0,
      "no passcode configured on the server means live stays closed",
    );
  }

  // 2. Live wiring: the study's real payload shape through the
  // same runDecision path as the fixture replay.
  {
    const { client, script } = scriptedApi(() => jsonResponse(TONE2_SUCCESS));
    const { deps, store } = makeDeps(client, new QueueBalance([900, 880]));
    const outcome = await runLiveCheck(deps, req());
    check(outcome.kind === "receipt", "live run produces a receipt");
    if (outcome.kind === "receipt") {
      const receipt = outcome.receipt;
      check(receipt.fixtureMode === false, "live receipt is labelled live");
      check(
        receipt.measuredToneHex === "#a77d60",
        "live receipt rests on the payload's skin_color",
      );
      const fixtureReceipt = runDecision({
        capture: GOOD_CAPTURE,
        skinTone: studyTone("tone2").result,
        catalog: studyFixtureCatalog(),
        ownedShades: [],
      });
      check(
        receipt.verdict === fixtureReceipt.verdict &&
          receipt.margin === fixtureReceipt.margin,
        "live verdict and margin equal the fixture replay of the same reading",
      );
      const toneStep = receipt.plannerLog.find((s) => s.step === "skin-tone");
      check(
        toneStep?.outcome === "done" && toneStep.unitsSpent === 20,
        "planner log records the live call as done with its real spend",
      );
      check(receipt.unitsSpent === 20, "receipt total is the settled spend");
      check(
        outcome.balanceBefore === 900 && outcome.balanceAfter === 880,
        "balance was read before and after the call",
      );
      const view = buildReceiptView(receipt);
      check(
        view.fixtureLabel.startsWith("Live mode"),
        "receipt screen labels the run LIVE",
      );
      check(
        view.allLines.some((l) => l.includes("Total units spent: 20")),
        "receipt screen shows the real units spent",
      );
    }
    check(
      script.ticketPosts === 1 && script.puts === 1 && script.createPosts === 1,
      "photo uploaded once, one task created",
    );
    check(store.globalCommitted() === 20, "ledger settled at the balance delta");
  }

  // 3. Attack: exactly-60% face on the live path is rejected by
  // the capture gate BEFORE any network call or spend.
  {
    const { client, script } = scriptedApi(() => jsonResponse(TONE2_SUCCESS));
    const { deps, store } = makeDeps(client, new QueueBalance([]));
    const outcome = await runLiveCheck(
      deps,
      req({
        capture: { faceDetected: true, faceWidthPx: 600, imageWidthPx: 1000 },
      }),
    );
    check(
      outcome.kind === "receipt" &&
        outcome.receipt.verdict === "CAN'T TELL" &&
        outcome.receipt.reasonTag === "capture-rejected",
      "exactly-60% face ends in CAN'T TELL, capture rejected",
    );
    check(script.total === 0, "gate rejection happens before any API call");
    check(store.globalCommitted() === 0, "gate rejection spends nothing");
  }

  // 4. Spend caps refuse before task creation.
  {
    const { client, script } = scriptedApi(() => jsonResponse(TONE2_SUCCESS));
    const { deps } = makeDeps(client, new QueueBalance([900, 880, 880]), {
      sessionCapUnits: 20,
      globalCapUnits: 300,
    });
    const first = await runLiveCheck(deps, req());
    check(first.kind === "receipt", "first run under the cap succeeds");
    const second = await runLiveCheck(deps, req());
    check(
      second.kind === "cap" && second.message.includes("spend cap of 20 units"),
      "second run hits the per-session cap with a clear refusal",
    );
    check(script.createPosts === 1, "cap refusal creates no second task");
  }
  {
    const { client, script } = scriptedApi(() => jsonResponse(TONE2_SUCCESS));
    const { deps } = makeDeps(client, new QueueBalance([900, 880]), {
      sessionCapUnits: 1000,
      globalCapUnits: 20,
    });
    await runLiveCheck(deps, req({ sessionId: "judge-a" }));
    const other = await runLiveCheck(deps, req({ sessionId: "judge-b" }));
    check(
      other.kind === "cap" && other.message.includes("shared live spend cap"),
      "a second session hits the global cap",
    );
    check(script.createPosts === 1, "global cap refusal creates no task");
  }

  // 5. Failed task creation: exactly one attempt, reservation
  // released, nothing charged.
  {
    const { client, script } = scriptedApi(() => jsonResponse(TONE2_SUCCESS), {
      createStatus: 500,
    });
    const { deps, store } = makeDeps(client, new QueueBalance([900]));
    const outcome = await runLiveCheck(deps, req());
    check(outcome.kind === "refused", "refused creation surfaces as a refusal");
    check(script.createPosts === 1, "task creation attempted exactly once");
    check(
      store.globalCommitted() === 0,
      "refused creation releases the reservation",
    );
  }

  // 6. Interrupted creation (network failure, outcome unknown):
  // the session holds its reservation and never creates again.
  {
    const { client, script } = scriptedApi(() => jsonResponse(TONE2_SUCCESS), {
      createThrows: true,
    });
    const { deps, store } = makeDeps(client, new QueueBalance([900]));
    const first = await runLiveCheck(deps, req());
    check(first.kind === "pending", "interrupted creation reports pending");
    check(
      store.globalCommitted() === 20,
      "interrupted creation holds the reservation (the task may exist)",
    );
    const second = await runLiveCheck(deps, req());
    check(second.kind === "pending", "held session stays pending");
    check(
      script.createPosts === 1 && script.ticketPosts === 1,
      "held session never uploads or creates again",
    );
  }

  // 7. Timeout recovery: the run is resumed by task id, created
  // exactly once across both attempts, reservation held between.
  {
    let done = false;
    const { client, script } = scriptedApi(() =>
      done
        ? jsonResponse(TONE2_SUCCESS)
        : jsonResponse({ data: { task_status: "running" } }),
    );
    const { deps, store } = makeDeps(client, new QueueBalance([500, 480]));
    const first = await runLiveCheck(deps, req());
    check(first.kind === "pending", "slow task reports pending, not failure");
    check(
      store.globalCommitted() === 20,
      "timed-out run keeps its reservation (a finished task still charges)",
    );
    done = true;
    const second = await runLiveCheck(deps, req({ photo: null }));
    check(
      second.kind === "receipt" && second.receipt.measuredToneHex === "#a77d60",
      "resume collects the reading from the same task",
    );
    check(script.createPosts === 1, "resume never creates a second task");
    check(store.globalCommitted() === 20, "resumed run settles once, at the delta");
  }

  // 8. Task-level failure: a provider error is a service failure,
  // not a verdict, so it gets its own outcome, never a receipt.
  // 0 committed, reservation released.
  {
    const { client } = scriptedApi(() =>
      jsonResponse({
        data: { task_status: "error", error_message: "no face found" },
      }),
    );
    const { deps, store } = makeDeps(client, new QueueBalance([900]));
    const outcome = await runLiveCheck(deps, req());
    check(
      outcome.kind === "provider-error",
      "failed task ends in the provider-error state, not a CAN'T TELL verdict",
    );
    check(
      outcome.kind === "provider-error" &&
        outcome.message.includes("no units were spent"),
      "failed task error says plainly that no units were spent",
    );
    check(store.globalCommitted() === 0, "failed task's reservation is released");
  }

  // 9. Live owned-bottle path: the full engine runs on a live
  // reading, owned check first, exactly as in fixture mode.
  {
    const { client } = scriptedApi(() => jsonResponse(TONE2_SUCCESS));
    const { deps } = makeDeps(client, new QueueBalance([900, 880]));
    const owned = buildOwnedShade("#a77d60", "My current foundation");
    check(!("error" in owned), "owned shade fixture builds");
    if (!("error" in owned)) {
      const outcome = await runLiveCheck(
        deps,
        req({ ownedShades: [owned.shade] }),
      );
      check(
        outcome.kind === "receipt" &&
          outcome.receipt.verdict === "NO" &&
          outcome.receipt.reasonTag === "already-own-it" &&
          outcome.receipt.fixtureMode === false,
        "live reading plus an owned match ends in NO, already own it",
      );
    }
  }

  // 10. Balance endpoint parsing: buckets summed, expired skipped,
  // failures read as unknown (null), never as zero.
  {
    const creditClient = createYouCamClient({
      apiKey: "hsurr:test-surrogate",
      baseUrl: "https://api.example",
      fetchFn: (async () =>
        jsonResponse({
          status: 200,
          results: [
            { id: 1, type: "ApiSubsToken", amount: 867, expiry: 9999999999999 },
            { id: 2, type: "ApiSubsToken", amount: 20, expiry: 9999999999999 },
            { id: 3, type: "ApiSubsToken", amount: 500, expiry: 1000 },
          ],
        })) as unknown as typeof fetch,
    });
    check(
      (await getUnitBalance(creditClient)) === 887,
      "unit balance sums unexpired buckets only",
    );
    const failingClient = createYouCamClient({
      apiKey: "hsurr:test-surrogate",
      baseUrl: "https://api.example",
      fetchFn: (async () =>
        jsonResponse({ error: "x" }, 500)) as unknown as typeof fetch,
    });
    check(
      (await getUnitBalance(failingClient)) === null,
      "unreadable balance is null (unknown), never zero",
    );
  }

  // 11. Surrogate parsing: only hsurr values are accepted, so a
  // real credential can never pass through this path.
  {
    const entry = parseSurrogateResponse(
      JSON.stringify({
        credentials: [
          {
            name: "access_token",
            surrogate: "hsurr:abc",
            placement: "bearer_header",
          },
        ],
      }),
    );
    check(entry.surrogate === "hsurr:abc", "surrogate entry parses");
    let refused = false;
    try {
      parseSurrogateResponse(
        JSON.stringify({
          credentials: [{ name: "access_token", surrogate: "a-real-key" }],
        }),
      );
    } catch {
      refused = true;
    }
    check(refused, "non-surrogate values are refused");
  }

  // 12. Cap defaults come from the plan numbers and env overrides
  // are honoured.
  {
    const defaults = liveSpendCaps({});
    check(
      defaults.sessionCapUnits === 60 && defaults.globalCapUnits === 300,
      "default caps: 60 per session, 300 global (the judge reserve)",
    );
    const overridden = liveSpendCaps({
      LIVE_SESSION_SPEND_CAP_UNITS: "40",
      LIVE_GLOBAL_SPEND_CAP_UNITS: "junk",
    });
    check(
      overridden.sessionCapUnits === 40 && overridden.globalCapUnits === 300,
      "env override applies per cap; junk falls back to the default",
    );
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
