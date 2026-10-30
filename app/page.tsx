import Link from "next/link";

export default function HomePage() {
  return (
    <div className="landing">
      <section className="hero">
        <h1>ShadeVeto</h1>
        <p className="one-liner">
          Check foundation against your face and the bottles you already
          own before you buy. It tells you when it can&apos;t tell.
        </p>
        <p className="hero-sub">
          One foundation, checked against your skin and your shelf,
          so the answer can be BUY, SHADE-RISK, or NO, with the
          reason shown. On a live BUY, a try-on render of the
          winning shade is shown as a labelled preview only, and
          never feeds a verdict. Built on the YouCam API.
        </p>
        <p>
          <Link href="/check" className="hero-cta">
            Start a check
          </Link>
        </p>
      </section>

      <section id="how" className="how">
        <h2>How it works</h2>
        <ol>
          <li>
            <strong>Capture.</strong> In fixture mode, pick a study
            face and a framing scenario. In live mode, upload a photo
            and the in-browser face detector measures it: MediaPipe
            running on this site&apos;s own files, or the
            browser&apos;s built-in detector where one exists. A
            photo that cannot be measured gets a plain refusal,
            never a guessed number.
          </li>
          <li>
            <strong>Colour.</strong> One skin-tone reading, ranked
            against a licensed catalog of 617 foundation shades by
            colour distance.
          </li>
          <li>
            <strong>Preview.</strong> On a live BUY receipt, a
            makeup try-on render of the winning shade runs as a
            labelled preview, for 1 extra unit. It is rendered
            after the verdict and never feeds it: colour distance
            and the cluster rule decide.
          </li>
          <li>
            <strong>Receipt.</strong> BUY, SHADE-RISK, NO, or
            CAN&apos;T TELL, with every number in the reason traced
            to a measurement, and a DON&apos;T BUY when a bottle you
            already own matches.
          </li>
        </ol>
      </section>

      <section className="status">
        <h2>The receipt</h2>
        <p>
          The receipt is the product. For one foundation it shows
          the verdict, the measured tone, the closest shades with
          their colour distances, and every threshold the engine
          applied. The cluster rule keeps it honest: in a dense
          catalog the top shades sit closer together than the
          measurement noise, so ShadeVeto names the whole cluster
          instead of crowning a single winner. BUY fires only when
          every shade in that cluster matches inside the range; if
          one member falls outside, the receipt says SHADE-RISK and
          names the cluster. Every step the engine did not run is
          logged as skipped, in the open, and live spend is capped
          per session and in total.
        </p>
        <p>
          The catalog is 617 foundation shades from The Pudding
          foundation shades dataset, swatches recorded in 2018,
          used under the MIT License. A brand coverage screen counts
          the same engine&apos;s verdicts across all six study
          tones, so a catalog&apos;s gaps show as plain counts, one
          bucket per verdict, never merged.
        </p>
      </section>
    </div>
  );
}
