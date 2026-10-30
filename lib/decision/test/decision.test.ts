import { parseCatalog, type Catalog, type ShadeEntry } from "../../catalog/types.ts";
import { checkCapture } from "../capture.ts";
import { hexToLab } from "../color.ts";
import {
  MARGIN_NOISE_PALE,
  MARGIN_NOISE_STANDARD,
  runDecision,
  type DecisionInput,
} from "../decision.ts";
import { STUDY_TONES, studyTone } from "../fixtures.ts";

/**
 * Decision engine, fixture mode end to end. Covers the capture
 * gate, the owned-bottle short-circuit, ranking order on the
 * study's six tones, and the cluster rule for BUY (boss ruling
 * 2026-10-23, defect #10): a dense cluster whose members all sit
 * inside the match range returns BUY with the cluster named, a
 * cluster straddling the range edge returns SHADE-RISK, and the
 * pale band widens the cluster to its 5.0 floor. Everything runs
 * on recorded study data; no API call exists here.
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

function fixtureShade(id: string, shadeName: string, hex: string): ShadeEntry {
  const lab = hexToLab(hex);
  return {
    id,
    brand: "FIXTURE Brand",
    product: "Fixture Foundation (placeholder)",
    shadeId: id.toUpperCase(),
    shadeName,
    hex,
    lab: { l: round3(lab.l), a: round3(lab.a), b: round3(lab.b) },
    finish: "satin",
    source: "C088 study fixture: shade placed at a recorded API reading, not a real product",
    sourceDate: "2026-10-22",
    reliability: "FIXTURE ONLY: invented to exercise ranking and verdicts. Never a real product.",
    license: "CC0 (project-authored placeholder)",
    fixture: true,
  };
}
const round3 = (n: number) => Math.round(n * 1000) / 1000;

function catalogOf(shades: ShadeEntry[]): Catalog {
  return parseCatalog({ version: 1, shades });
}

/** One exact-match shade per study tone, plus two far decoys. */
function sharedCatalog(): Catalog {
  const matches = STUDY_TONES.map((t) =>
    fixtureShade(`match-${t.id}`, `Study Match ${t.id}`, t.result.skinColorHex),
  );
  return catalogOf([
    ...matches,
    fixtureShade("decoy-plum", "Decoy Deep Plum", "#5B2333"),
    fixtureShade("decoy-pink", "Decoy Pale Pink", "#EFD3C5"),
  ]);
}

const GOOD_CAPTURE = { faceDetected: true, faceWidthPx: 680, imageWidthPx: 1000 };

function input(
  toneId: string,
  overrides: Partial<DecisionInput> = {},
): DecisionInput {
  return {
    capture: GOOD_CAPTURE,
    skinTone: studyTone(toneId).result,
    catalog: sharedCatalog(),
    ownedShades: [],
    ...overrides,
  };
}

function plannerStep(receipt: ReturnType<typeof runDecision>, step: string) {
  return receipt.plannerLog.find((s) => s.step === step);
}

function main() {
  // ---- Capture gate (study framing rule: face must exceed 60%) ----
  check(
    checkCapture({ faceDetected: true, faceWidthPx: 680, imageWidthPx: 1000 }).ok,
    "gate passes at 68% face width (the study's successful crop)",
  );
  const at60 = checkCapture({ faceDetected: true, faceWidthPx: 600, imageWidthPx: 1000 });
  check(!at60.ok, "gate rejects at exactly 60% (the rule is exceed, not reach)");
  const small = checkCapture({ faceDetected: true, faceWidthPx: 450, imageWidthPx: 1000 });
  check(
    !small.ok && small.reasons[0].includes("45%") && small.reasons[0].includes("60%"),
    "gate rejection names the measured share and the required share",
  );
  check(
    !small.ok &&
      small.reasons[0].includes("This check needs") &&
      !small.reasons[0].includes("Skin analysis needs"),
    "gate rejection attributes the 60% rule to this check (ShadeVeto's own study gate), not to the provider",
  );
  const noFace = checkCapture({ faceDetected: false, faceWidthPx: 0, imageWidthPx: 1000 });
  check(!noFace.ok && noFace.reasons[0].includes("No face"), "gate rejects when no face is found");

  // Gate failure flows to CAN'T TELL with nothing spent or read.
  const gated = runDecision(input("tone2", {
    capture: { faceDetected: true, faceWidthPx: 450, imageWidthPx: 1000 },
  }));
  check(
    gated.verdict === "CAN'T TELL" && gated.reasonTag === "capture-rejected",
    "a rejected photo ends in CAN'T TELL, never a guessed verdict",
  );
  check(
    gated.unitsSpent === 0 && plannerStep(gated, "skin-tone")?.outcome === "skipped",
    "gate rejection spends 0 units and never touches the reading",
  );

  // ---- Ranking order on the study's six tones ----
  for (const tone of STUDY_TONES) {
    const receipt = runDecision(input(tone.id));
    check(
      receipt.ranking[0]?.shade.id === `match-${tone.id}` &&
        receipt.ranking[0].distance < 0.01,
      `${tone.id}: its own study match ranks first at distance ~0`,
    );
  }
  const tone1 = runDecision(input("tone1"));
  check(
    (tone1.margin ?? 0) > MARGIN_NOISE_STANDARD,
    "tone1 (deep, isolated) clears the standard noise floor by a wide margin",
  );
  for (const id of ["tone5", "tone6"]) {
    const receipt = runDecision(input(id));
    check(
      receipt.paleBand && (receipt.margin ?? 99) < MARGIN_NOISE_PALE,
      `${id}: pale band, and the sibling shade sits inside the pale noise floor`,
    );
  }

  // ---- Verdicts on the shared (dense) catalog: cluster rule ----
  // Under the cluster rule (boss ruling 2026-10-23), every study
  // tone's own match sits at distance ~0 and every shade within
  // noise of it is itself inside the match range, so all six
  // tones return BUY, the pale ones as cluster picks.
  for (const id of ["tone5", "tone6"]) {
    const receipt = runDecision(input(id));
    check(
      receipt.verdict === "BUY" &&
        receipt.reasonTag === "cluster-match" &&
        receipt.cluster.length === 4 &&
        receipt.cluster.every((row) => row.inMatchRange),
      `${id}: pale cluster of 4, all inside the match range: BUY as a cluster pick`,
    );
  }
  const dense2 = runDecision(input("tone2"));
  check(
    dense2.verdict === "BUY" && dense2.reasonTag === "cluster-match",
    "tone2 on the dense catalog: BUY (tone3's shade sits 2.85 behind, inside the cluster and inside the range)",
  );

  // (a) A dense cluster, all members inside range: BUY, cluster
  // named on the receipt, top pick first.
  check(
    dense2.cluster.length === 2 &&
      dense2.cluster[0].shade.id === "match-tone2" &&
      dense2.cluster[1].shade.id === "match-tone3" &&
      dense2.cluster.every((row) => row.inMatchRange) &&
      dense2.headline.includes("2 shades sit within measurement noise") &&
      dense2.headline.includes("cluster pick, not a unique winner"),
    "dense cluster all inside range: BUY names the cluster and never claims a unique winner",
  );
  check(
    plannerStep(dense2, "cluster-evaluation")?.outcome === "done" &&
      (plannerStep(dense2, "cluster-evaluation")?.why.includes("Cluster check: 2 shades") ??
        false),
    "the planner log records the cluster evaluation and its size",
  );

  // ---- BUY cluster rule on scenario catalogs ----
  const sparse = catalogOf([
    fixtureShade("match-tone2", "Study Match tone2", studyTone("tone2").result.skinColorHex),
    fixtureShade("decoy-plum", "Decoy Deep Plum", "#5B2333"),
    fixtureShade("decoy-pink", "Decoy Pale Pink", "#EFD3C5"),
  ]);
  const buy = runDecision(input("tone2", { catalog: sparse }));
  check(
    buy.verdict === "BUY" && buy.reasonTag === "clear-match",
    "a lone clear match with far decoys returns BUY",
  );
  // (c) A cluster of one keeps the plain BUY wording.
  check(
    buy.cluster.length === 1 &&
      buy.cluster[0].shade.id === "match-tone2" &&
      buy.headline.includes("no other shade in this catalog sits within measurement noise"),
    "single-member cluster: plain BUY wording, no cluster claim",
  );
  const pairCatalog = catalogOf([
    fixtureShade("match-tone2", "Study Match tone2", studyTone("tone2").result.skinColorHex),
    fixtureShade("match-tone4", "Study Match tone4", studyTone("tone4").result.skinColorHex),
  ]);
  const pairRun = runDecision(input("tone2", { catalog: pairCatalog }));
  check(
    pairRun.verdict === "BUY" && pairRun.cluster.length === 1,
    "runner-up 5.90 away, outside the 3.0 cluster width: BUY with a cluster of one",
  );
  const closePair = catalogOf([
    fixtureShade("match-tone2", "Study Match tone2", studyTone("tone2").result.skinColorHex),
    fixtureShade("match-tone3", "Study Match tone3", studyTone("tone3").result.skinColorHex),
  ]);
  check(
    runDecision(input("tone2", { catalog: closePair })).verdict === "BUY",
    "runner-up 2.85 away joins the cluster and is itself a match: BUY, where the old margin rule said SHADE-RISK",
  );

  // (b) A cluster member outside the match range: SHADE-RISK.
  // Winner #a06e4e sits ~5.40 from tone2's reading (inside the
  // range, near its edge); #9c6b4a sits ~6.56 away, within the
  // winner's cluster width (5.40 + 3.0) but outside the range.
  const straddle = catalogOf([
    fixtureShade("straddle-winner", "Straddle Winner", "#a06e4e"),
    fixtureShade("straddle-outsider", "Straddle Outsider", "#9c6b4a"),
  ]);
  const straddleRun = runDecision(input("tone2", { catalog: straddle }));
  const straddleWinner = straddleRun.ranking[0];
  const straddleOutsider = straddleRun.ranking[1];
  check(
    straddleWinner.distance > 3 &&
      straddleWinner.distance <= 6.0 &&
      straddleOutsider.distance > 6.0 &&
      straddleOutsider.distance <= straddleWinner.distance + MARGIN_NOISE_STANDARD,
    "straddle fixture sits where the test needs it: winner in range near the edge, second shade in the cluster width but out of range",
  );
  check(
    straddleRun.verdict === "SHADE-RISK" &&
      straddleRun.reasonTag === "candidates-within-noise" &&
      straddleRun.cluster.length === 2 &&
      straddleRun.cluster[0].inMatchRange &&
      !straddleRun.cluster[1].inMatchRange &&
      straddleRun.headline.includes("outside the match range"),
    "cluster member outside the match range: SHADE-RISK, with the outsider marked on the receipt",
  );

  // (d) The pale band widens the cluster to its 5.0 floor.
  // tone3's shade hex sits 4.87 from tone6's reading: outside a
  // 3.0-wide cluster, inside the pale 5.0 width.
  const palePair = catalogOf([
    fixtureShade("match-tone6", "Study Match tone6", studyTone("tone6").result.skinColorHex),
    fixtureShade("match-tone3", "Study Match tone3", studyTone("tone3").result.skinColorHex),
  ]);
  const paleRun = runDecision(input("tone6", { catalog: palePair }));
  check(
    paleRun.noiseFloor === MARGIN_NOISE_PALE &&
      paleRun.ranking[1].distance > MARGIN_NOISE_STANDARD &&
      paleRun.ranking[1].distance <= MARGIN_NOISE_PALE &&
      paleRun.cluster.length === 2 &&
      paleRun.cluster[1].shade.id === "match-tone3" &&
      paleRun.verdict === "BUY" &&
      paleRun.reasonTag === "cluster-match",
    "pale band: a shade 4.87 away joins the cluster only because the pale floor is 5.0, not 3.0",
  );

  // ---- NO when nothing in the catalog is in range ----
  const lightOnly = catalogOf([
    fixtureShade("match-tone5", "Study Match tone5", studyTone("tone5").result.skinColorHex),
    fixtureShade("match-tone6", "Study Match tone6", studyTone("tone6").result.skinColorHex),
  ]);
  const noMatch = runDecision(input("tone1", { catalog: lightOnly }));
  check(
    noMatch.verdict === "NO" && noMatch.reasonTag === "no-shade-in-range",
    "tone1 against a light-only catalog: NO, no shade in range",
  );

  // ---- Owned-bottle check runs FIRST and short-circuits ----
  const ownedBottle = fixtureShade(
    "owned-1",
    "My Bottle",
    studyTone("tone2").result.skinColorHex,
  );
  ownedBottle.brand = "Owned Brand";
  const owned = runDecision(input("tone2", { ownedShades: [ownedBottle] }));
  check(
    owned.verdict === "NO" && owned.reasonTag === "already-own-it",
    "an owned bottle at the measured tone returns NO, already own it",
  );
  check(
    owned.ranking.length === 0 &&
      plannerStep(owned, "catalog-ranking")?.outcome === "skipped",
    "the owned-bottle verdict short-circuits before any ranking",
  );
  check(
    owned.cluster.length === 0 &&
      plannerStep(owned, "cluster-evaluation") === undefined,
    "the owned-bottle verdict short-circuits before any cluster logic runs",
  );
  const farOwned = fixtureShade("owned-far", "Old Bottle", "#5B2333");
  const notOwned = runDecision(input("tone2", {
    catalog: sparse,
    ownedShades: [farOwned],
  }));
  check(
    notOwned.verdict === "BUY",
    "an owned bottle far from the measured tone does not block a BUY",
  );

  // ---- Only skin_color is load-bearing ----
  const tone2 = studyTone("tone2");
  const tampered = {
    skinColorHex: tone2.result.skinColorHex,
    facialColors: { hair: "#000000", eye: "#FF0000", lip: "#00FF00", brow: "#0000FF" },
  };
  const honest = runDecision(input("tone2", { catalog: sparse }));
  const tamperedRun = runDecision(input("tone2", { catalog: sparse, skinTone: tampered }));
  check(
    tamperedRun.verdict === honest.verdict &&
      tamperedRun.ranking[0].distance === honest.ranking[0].distance,
    "changing hair, eye, lip and brow colours changes nothing (study: hair_color wrong on 6 of 6)",
  );

  // ---- Receipt and planner honesty ----
  check(
    buy.unitsSpent === 0 &&
      plannerStep(buy, "skin-tone")?.outcome === "replayed" &&
      plannerStep(buy, "skin-tone")?.liveUnits === 20,
    "fixture mode spends 0 and prices the replayed reading at its live cost of 20",
  );
  check(
    plannerStep(buy, "makeup-vto-preview")?.outcome === "skipped" &&
      (plannerStep(buy, "makeup-vto-preview")?.why.includes("preview only") ?? false),
    "makeup VTO is logged as a skipped preview, never a verdict input",
  );
  check(
    buy.measuredToneHex === "#a77d60" && buy.fixtureMode === true,
    "the receipt states the exact tone it rests on and that it is a fixture replay",
  );
  const unusable = runDecision(input("tone2", { skinTone: { skinColorHex: "not-a-hex", facialColors: {} } }));
  check(
    unusable.verdict === "CAN'T TELL" && unusable.reasonTag === "reading-unusable",
    "an unreadable skin_color ends in CAN'T TELL, not a crash or a guess",
  );

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main();
