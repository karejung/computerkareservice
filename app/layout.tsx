import type { Metadata, Viewport } from 'next';
import { Analytics } from '@vercel/analytics/next';
import { SpeedInsights } from '@vercel/speed-insights/next';

import './globals.css';

/*
 * Both beacons post to `/_vercel/...` on whatever host is serving the page, and
 * only Vercel answers there. The same commit is also built for GitHub Pages —
 * see next.config.mjs, where NEXT_PUBLIC_BASE_PATH is what switches that build
 * on — and on that copy the requests would 404 in every visitor's console
 * while collecting nothing. So the export leaves them out. The variable is
 * inlined at build time, so this is a decision the bundle is built with rather
 * than one the browser makes.
 */
const ON_VERCEL = !process.env.NEXT_PUBLIC_BASE_PATH;

export const metadata: Metadata = {
  title: 'computer.kare.service',
  description:
    'A Blender scene played back in WebGL: KARE, animated from named glTF clips, with a Nintendo DS, a laptop and a phone to pick between.',
};

export const viewport: Viewport = {
  themeColor: '#e7e7e7',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <head>
        {/* preconnect to both: Google serves the CSS and the font files from
            two different hosts, and the second is only discovered by parsing
            the first. */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>
        {children}
        {ON_VERCEL && (
          <>
            <Analytics />
            <SpeedInsights />
          </>
        )}
      </body>
    </html>
  );
}
