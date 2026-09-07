import type { Metadata, Viewport } from 'next';
import './globals.css';

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
      <body>{children}</body>
    </html>
  );
}
