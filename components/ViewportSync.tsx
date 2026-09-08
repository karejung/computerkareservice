'use client';

import { useEffect } from 'react';

/**
 * Keeps `--app-h` on <html> equal to the height actually on screen.
 *
 * The page is one `position: fixed` layer over an `overflow: hidden` document,
 * so its entire geometry is a single number, and that number was the browser's
 * to pick. On iOS — Chrome there is WebKit too — the layout viewport and the
 * visual viewport come apart while the toolbars slide in, most often when the
 * page is opened cold from another app or restored from bfcache. The layer
 * keeps a sensible height but stays anchored at screen y=0: its top hides
 * behind the URL bar and a band of the page ground exactly one toolbar tall
 * shows above the bottom one.
 *
 * Nothing recovered from that. There is no scrollable content, so the browser
 * never got a scroll to settle against and the reader could not nudge it back
 * either — which is why a reload was the only thing that cleared it.
 *
 * So the height stops being the browser's decision, and every event that could
 * have moved it re-measures. globals.css falls back to 100dvh, which is right
 * before this mounts and right on anything that never drifts.
 */
export function ViewportSync() {
  useEffect(() => {
    const vv = window.visualViewport;

    const measure = () => {
      const h = vv?.height ?? window.innerHeight;
      if (h > 0) document.documentElement.style.setProperty('--app-h', `${h}px`);
    };

    /*
     * The scrollTo is what unsticks an offset that is already wrong; on a page
     * with nothing to scroll it is otherwise a no-op, which is why it can be
     * unconditional. Reading offsetHeight straight after is what makes WebKit
     * act on it in this frame rather than at some later paint of its own
     * choosing.
     */
    const settle = () => {
      measure();
      window.scrollTo(0, 0);
      void document.documentElement.offsetHeight;
    };

    /*
     * The toolbars slide rather than snap, and the height that matters is the
     * one at the end of the slide. A single pass on load samples a number that
     * is still moving, so the rest is caught a beat later.
     */
    let timer = 0;
    const resettle = () => {
      settle();
      clearTimeout(timer);
      timer = window.setTimeout(settle, 400);
    };

    resettle();

    // Pinch-zoom pans the visual viewport without resizing anything, and the
    // page must not fight that — so this path measures and leaves scroll alone.
    vv?.addEventListener('scroll', measure);
    vv?.addEventListener('resize', settle);
    window.addEventListener('resize', settle);
    window.addEventListener('orientationchange', resettle);
    // Covers bfcache restores, which come back with no resize of their own.
    window.addEventListener('pageshow', resettle);

    return () => {
      clearTimeout(timer);
      vv?.removeEventListener('scroll', measure);
      vv?.removeEventListener('resize', settle);
      window.removeEventListener('resize', settle);
      window.removeEventListener('orientationchange', resettle);
      window.removeEventListener('pageshow', resettle);
    };
  }, []);

  return null;
}
