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
      <body>{children}</body>
    </html>
  );
}
