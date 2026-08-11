import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'KARE — realtime cloth in the browser',
  description:
    'A Blender scene played back in WebGL: skeletal animation for the body, a vertex animation texture for the baked cloth simulation.',
};

export const viewport: Viewport = {
  themeColor: '#0b0c0e',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
