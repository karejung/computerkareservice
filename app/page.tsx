'use client';

import dynamic from 'next/dynamic';

import { asset } from '@/lib/asset';

// three.js touches window/WebGL on import, so keep it off the server render.
const Scene = dynamic(() => import('@/components/Scene'), { ssr: false });

export default function Page() {
  return (
    <>
      <Scene />
      {/*
        Above the canvas so mix-blend-mode: difference samples the WebGL frame
        (character + clear colour). The canvas clears to the same #ccc as the
        page, so empty areas invert correctly instead of against black.
      */}
      <img
        className="brand-logo"
        src={asset('/image/logo.svg')}
        alt="kare"
        width={1146}
        height={92}
        draggable={false}
      />
    </>
  );
}
