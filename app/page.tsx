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
          reason shown. A try-on render is available as a labelled
          preview only: it is not run in the shipped check flow and
          never feeds a verdict. Built on the YouCam API.
        </p>
      </section>

      <section id="how" className="how">
        <h2>How it works</h2>
        <ol>
          <li>
            <strong>Capture.</strong> In fixture mode, pick a study
            face and a framing scenario; in live mode, upload a photo
            file and let the browser&apos;s built-in face detector
            measure it, with a plain refusal where no detector exists.
            There is no colour-cast warning in the shipped flow.
          </li>
          <li>
            <strong>Colour.</strong> One skin-tone reading, ranked
            against a small, dated, licensed shade catalog by colour
            distance.
          </li>
          <li>
            <strong>Preview.</strong> Makeup VTO rendering is available
            as a client function, but it is not run in the shipped
            check flow: every receipt logs makeup-vto-preview as
            skipped, and the preview never feeds a verdict. Colour
            distance and the cluster rule decide.
          </li>
          <li>
            <strong>Receipt.</strong> BUY, SHADE-RISK, or NO, with
            every number in the reason traced to a measurement, and a
            DON&apos;T BUY when you already own the match.
          </li>
        </ol>
      </section>

      <section className="status">
        <h2>Status</h2>
        <p>
          Build in progress: the decision engine and its fixture-mode
          check page are in, and live mode now runs behind the judge
          passcode on the same page: one real Skin Tone call through
          the same engine, under server-side spend caps, with a
          receipt labelled LIVE. Public visitors get the fixture
          replay only. A brand coverage screen now counts the same
          engine&apos;s verdicts across all six study tones, so a
          catalog&apos;s gaps show as plain counts, one bucket per
          verdict, never merged. The live check and the brand screen
          now rank a real licensed catalog: 617 foundation shades
          from The Pudding foundation shades dataset, swatches
          recorded in 2018, used under the MIT License. The public
          replay keeps its labelled fixture shades.
        </p>
      </section>
    </div>
  );
}
