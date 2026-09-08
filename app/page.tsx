'use client';

import { useCallback, useEffect, useState } from 'react';
import dynamic from 'next/dynamic';

import { Loader } from '@/components/Loader';
import { armGyro } from '@/lib/gyro';

const Scene = dynamic(() => import('@/components/Scene'), { ssr: false });

/*
 * `is-solo` collapses the two-column grid to one, so the canvas spans the whole
 * width. It leaves `.split`'s padding alone, which is what keeps the gutter
 * between the canvas and the browser edge. Drop the class to put the stage back
 * in the left half.
 *
 * The deck — the HOME / DISCOGRAPHY / ABOUT panel — is still parked, not
 * deleted: components/Deck.tsx and its styles are untouched. To bring it back,
 * restore the `deckOpen` state and render
 * `<Deck open={deckOpen} onOpenChange={setDeckOpen} />` after the stage; it
 * lands in the empty column.
 */
export default function Page() {
  const [ready, setReady] = useState(false);
  const [gone, setGone] = useState(false);
  const onReady = useCallback(() => setReady(true), []);
  const onFaded = useCallback(() => setGone(true), []);

  /*
   * Here rather than in <Stickers>, which is where it used to live: iOS only
   * asks for orientation from a user gesture, and the sticker layer does not
   * exist until the model is live — so the loader ate the first tap and the
   * prompt waited on a second one that plenty of readers never gave. This
   * mounts with the page, before there is anything to load. See lib/gyro.ts.
   */
  useEffect(armGyro, []);

  return (
    <main className="split is-solo">
      <section className="split__stage">
        <Scene onReady={onReady} />
        {!gone && <Loader done={ready} onFaded={onFaded} />}
      </section>
    </main>
  );
}
