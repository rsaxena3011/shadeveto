import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "ShadeVeto: check the foundation before you buy it",
  description:
    "Check foundation against your face and the bottles you already own before you buy. It tells you when it can't tell.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>
        <header className="site-header">
          <Link href="/" className="brand">
            ShadeVeto
          </Link>
          <nav className="site-nav">
            <Link href="/#how">How it works</Link>
            <Link href="/check">Check a shade</Link>
            <Link href="/brands">Brand coverage</Link>
          </nav>
        </header>
        <main>{children}</main>
        <footer className="site-footer">
          <p>
            ShadeVeto. A purchase check, not a shade finder: it tells you
            when it can&apos;t tell.{" "}
            <Link href="/api/health">Health</Link>
          </p>
        </footer>
      </body>
    </html>
  );
}
