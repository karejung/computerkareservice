'use client';

import dynamic from 'next/dynamic';
import { useState } from 'react';

import { Deck } from '@/components/Deck';

const Scene = dynamic(() => import('@/components/Scene'), { ssr: false });

export default function Page() {
  const [deckOpen, setDeckOpen] = useState(false);

  return (
    <main className={`split${deckOpen ? ' is-open' : ''}`}>
      <section className="split__stage">
        <Scene />
      </section>

      <Deck open={deckOpen} onOpenChange={setDeckOpen} />
    </main>
  );
}
