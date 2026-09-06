'use client';

import { useState } from 'react';

const TABS = ['HOME', 'DISCOGRAPHY', 'ABOUT'] as const;

type Tab = (typeof TABS)[number];

export type DeckProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function Deck({ open, onOpenChange }: DeckProps) {
  const [active, setActive] = useState<Tab>('HOME');

  const press = (tab: Tab) => {
    if (open && tab === active) {
      onOpenChange(false);
      return;
    }
    setActive(tab);
    onOpenChange(true);
  };

  return (
    <section className="deck">
      <nav className="deck__tabs" aria-label="Sections">
        {TABS.map((tab) => (
          <button
            key={tab}
            type="button"
            className={`deck__tab${tab === active ? ' is-active' : ''}`}
            aria-current={tab === active ? 'page' : undefined}
            onClick={() => press(tab)}
          >
            {tab}
          </button>
        ))}
      </nav>

      <div className="deck__sheet">
        <article className="deck__page">
          <h1 className="deck__title">{active}</h1>
        </article>
      </div>
    </section>
  );
}
