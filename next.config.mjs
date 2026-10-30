/** @type {import('next').NextConfig} */

// Baseline hardening headers on every response, same posture as the
// sibling project. All YouCam traffic is server-side from our API
// routes, so connect-src stays same-origin.
// 'wasm-unsafe-eval' in script-src is REQUIRED, not a relaxation for
// its own sake: the /check live panel runs MediaPipe face detection
// as WebAssembly in the browser, and Chrome refuses to compile or
// instantiate any WASM module under a script-src without it. Without
// this token the measurement died before any paid call on every
// browser (the four failed live tests of Oct 28-29). It permits WASM
// compilation only; it does not allow JS eval.
const securityHeaders = [
  {
    key: "Content-Security-Policy",
    value: [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      // img-src hosts: blob:/data: cover the uploaded-photo thumbnail and
      // inline assets; plugins-media.makeupar.com is YouCam's media host;
      // yce-us.s3-accelerate.amazonaws.com is where the Makeup VTO result
      // image_url actually points (verified from the live receipt DOM,
      // 2026-10-30). Without the S3 host the browser blocks the rendered
      // preview in every receipt (complete=true, naturalWidth=0).
      "img-src 'self' data: blob: https://plugins-media.makeupar.com https://yce-us.s3-accelerate.amazonaws.com",
      "font-src 'self' data:",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join("; "),
  },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
];

const nextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
