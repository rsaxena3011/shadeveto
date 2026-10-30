"use client";

/**
 * The receipt screen, shared by fixture mode and live mode. It
 * renders only the receipt view model (lib/ui/receipt-view.ts),
 * which itself only copies engine output: no verdict, distance,
 * margin or threshold is computed in this component or below it.
 *
 * The ranking can run to the full licensed catalog (617 rows in
 * live mode), so it renders the top 10 by default with a toggle
 * for the full list. Slicing for display is the only thing the
 * toggle does; every row still comes from the view model.
 */

import { useState } from "react";
import type { ReceiptView } from "../../lib/ui/receipt-view.ts";

const RANKING_PREVIEW_COUNT = 10;

/**
 * A live BUY preview render, passed only by the live panel. It is
 * deliberately NOT part of the receipt view model: the view model
 * carries engine output only, and the render is a post-verdict
 * artifact of the live run. Fixture mode never passes one.
 */
export interface ReceiptPreview {
  imageUrl: string;
  shadeLabel: string;
  colorHex: string;
}

export default function ReceiptSection({
  view,
  rankingHeading,
  preview,
}: {
  view: ReceiptView;
  rankingHeading: string;
  preview?: ReceiptPreview | null;
}) {
  const [showAllRanking, setShowAllRanking] = useState(false);
  const rankingRows = showAllRanking
    ? view.rankingRows
    : view.rankingRows.slice(0, RANKING_PREVIEW_COUNT);
  return (
    <section className="receipt" aria-label="Decision receipt">
      <p className="fixture-banner">{view.fixtureLabel}</p>
      <p className="verdict-line">
        <span className="verdict-chip">{view.verdict}</span>
      </p>
      <h2 className="receipt-headline">{view.headline}</h2>
      <p className="reason-tag">Reason: {view.reasonTag}</p>
      <p>{view.measuredToneText}</p>

      {preview ? (
        <figure className="vto-preview">
          <img
            src={preview.imageUrl}
            alt={`Makeup try-on preview of ${preview.shadeLabel} on your photo`}
          />
          <figcaption>
            Preview only: this render of {preview.shadeLabel} (
            {preview.colorHex}) did not decide the verdict.
          </figcaption>
        </figure>
      ) : null}

      <h3>Thresholds the engine applied</h3>
      <dl className="thresholds">
        {view.thresholdRows.map((row) => (
          <div key={row.label} className="threshold-row">
            <dt>{row.label}</dt>
            <dd>{row.value}</dd>
          </div>
        ))}
      </dl>

      {view.rankingRows.length > 0 ? (
        <>
          <h3>{rankingHeading}</h3>
          <table className="ranking">
            <thead>
              <tr>
                <th scope="col">#</th>
                <th scope="col">Shade</th>
                <th scope="col">Hex</th>
                <th scope="col">Distance (CIEDE2000)</th>
              </tr>
            </thead>
            <tbody>
              {rankingRows.map((row) => (
                <tr key={row.position}>
                  <td>{row.position}</td>
                  <td>{row.shadeLabel}</td>
                  <td>
                    <span
                      className="swatch swatch-small"
                      style={{ backgroundColor: row.hex }}
                      aria-hidden="true"
                    />{" "}
                    {row.hex}
                  </td>
                  <td>{row.distanceText}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {view.rankingRows.length > RANKING_PREVIEW_COUNT ? (
            <button
              type="button"
              className="ranking-toggle"
              onClick={() => setShowAllRanking((value) => !value)}
            >
              {showAllRanking
                ? `Show top ${RANKING_PREVIEW_COUNT} only`
                : `Show all ${view.rankingRows.length}`}
            </button>
          ) : null}
        </>
      ) : null}

      {view.clusterText !== null ? <p>{view.clusterText}</p> : null}

      {view.ownedText !== null ? <p>{view.ownedText}</p> : null}

      <h3>Planner log</h3>
      <ol className="planner">
        {view.plannerRows.map((row) => (
          <li key={row.step}>
            <strong>{row.step}</strong> [{row.outcome}] {row.unitsText}
            <br />
            {row.why}
          </li>
        ))}
      </ol>
      <p className="units-total">{view.unitsSpentText}</p>
    </section>
  );
}
