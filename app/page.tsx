'use client';

import dynamic from 'next/dynamic';

import { Stickers } from '@/components/Stickers';

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
  return (
    <main className="split is-solo">
      <section className="split__stage">
        <Scene />
      </section>

      <Stickers />
    </main>
  );
}
