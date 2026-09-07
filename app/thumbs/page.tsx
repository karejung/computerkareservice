'use client';

/**
 * Dev-only tool: renders each inventory prop on its own and posts the result to
 * the writer in `tools/2_thumbs.mjs`, which drops the PNGs in
 * `public/image/thumbs/`.
 *
 *   node tools/2_thumbs.mjs        # terminal 1, the writer
 *   npm run dev                    # terminal 2
 *   open http://localhost:3000/thumbs
 *
 * The point of doing this in the browser rather than offline is that the props
 * only look the way they look because of `lib/twoTone.ts` — a real GL context
 * has to compile those shaders. So this reuses the inventory's own pieces
 * (`usePropItem`, `Shadow`, `FloatingItem`, `Fit`) instead of restating them,
 * and the thumbnails cannot drift from what the slot shows.
 *
 * Two things make the shot reproducible:
 *
 *   * `frameloop="never"` plus `advance(0)`. R3F pins `clock.elapsedTime` to
 *     the timestamp it is handed, so every frame here is t=0: no bob, no sway,
 *     no tilt, and the shadow always at the same point in its breath. Left to
 *     run, each capture would land on a different frame of the float.
 *   * `Fit` converges on its distance over frames rather than solving in one,
 *     so it needs a run-up — hence WARMUP frames before the shot is read.
 *
 * `preserveDrawingBuffer` is what makes `toDataURL` return pixels instead of a
 * blank; the default buffer is cleared as soon as the frame is presented.
 */

import { Suspense, useEffect, useRef, useState } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import * as THREE from 'three';

import { Fit, FloatingItem, ITEM_FOV, Shadow, usePropItem } from '@/components/PropRender';
import { setScreenOn } from '@/lib/twoTone';
import type { PropKind } from '@/lib/twoTone';

const WRITER = 'http://localhost:4321/save';
const SIZE = 512;
const WARMUP = 240;

/** Same values Scene.tsx hands the inventory through LOOK. */
const SHADE_COLOR = '#dedede';
const SHADE_SPLIT = 0.05;
const SHADE_ANGLE = 44;
const SHADE_HEIGHT = 30;

const ITEMS: { kind: PropKind; name: string }[] = [
  { kind: 'ds', name: 'ds' },
  { kind: 'pc', name: 'laptop' },
  { kind: 'phone', name: 'phone' },
];

type Status = 'rendering' | 'saved' | 'failed';

function Capture({
  kind,
  onShot,
}: {
  kind: PropKind;
  onShot: (dataUrl: string) => void;
}) {
  const item = usePropItem(kind);
  const gl = useThree((state) => state.gl);
  const advance = useThree((state) => state.advance);

  /*
   * Blank white screens. The screen shader ends on `mix(white, uColor, mask)`,
   * so painting uColor white collapses the star field without touching the
   * shader — the mask still runs, it just has nothing to mix towards. Off
   * would render black instead, which reads as a dead device on a thumbnail.
   */
  useEffect(() => {
    for (const screen of item?.screens ?? []) {
      setScreenOn(screen, true);
      screen.uniforms.uColor.value.set('#ffffff');
    }
  }, [item]);

  useEffect(() => {
    if (!item) return;
    const azimuth = SHADE_ANGLE * THREE.MathUtils.DEG2RAD;
    const elevation = SHADE_HEIGHT * THREE.MathUtils.DEG2RAD;
    const dir = new THREE.Vector3(
      Math.sin(azimuth) * Math.cos(elevation),
      Math.sin(elevation),
      Math.cos(azimuth) * Math.cos(elevation),
    );
    for (const { userData } of item.materials) {
      userData.uniforms.uShade.value.set(SHADE_COLOR);
      userData.uniforms.uSplit.value = SHADE_SPLIT;
      userData.uniforms.uShadeDir.value.copy(dir);
    }
  }, [item]);

  const shot = useRef(false);
  useEffect(() => {
    if (!item || shot.current) return;
    shot.current = true;
    // Straight loop rather than one frame per rAF: `advance` draws
    // synchronously, and rAF is throttled to a crawl whenever the tab is not
    // the foreground one — which it is not while this is being driven.
    for (let i = 0; i < WARMUP; i++) advance(0);
    onShot(gl.domElement.toDataURL('image/png'));
  }, [item, advance, gl, onShot]);

  if (!item) return null;

  return (
    <>
      <ambientLight intensity={1} />
      <Shadow extent={item.extent} />
      <FloatingItem object={item.object} />
      <Fit object={item.object} />
    </>
  );
}

function Shot({
  kind,
  name,
  onStatus,
}: {
  kind: PropKind;
  name: string;
  onStatus: (name: string, status: Status, detail?: string) => void;
}) {
  const save = (dataUrl: string) => {
    fetch(WRITER, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name, dataUrl }),
    })
      .then((res) => res.json())
      .then((body) => onStatus(name, 'saved', body.path))
      .catch((err) => onStatus(name, 'failed', String(err)));
  };

  return (
    <figure style={{ margin: 0 }}>
      <div style={{ width: SIZE, height: SIZE }}>
        <Canvas
          flat
          frameloop="never"
          dpr={1}
          gl={{ antialias: true, alpha: true, preserveDrawingBuffer: true }}
          camera={{ position: [0, 4, 7], fov: ITEM_FOV, near: 0.1, far: 60 }}
        >
          <Suspense fallback={null}>
            <Capture kind={kind} onShot={save} />
          </Suspense>
        </Canvas>
      </div>
      <figcaption style={{ font: '13px ui-monospace, monospace', paddingTop: 8 }}>
        {name}.png
      </figcaption>
    </figure>
  );
}

export default function Thumbs() {
  const [status, setStatus] = useState<Record<string, [Status, string?]>>({});

  const onStatus = (name: string, next: Status, detail?: string) =>
    setStatus((all) => ({ ...all, [name]: [next, detail] }));

  const done = ITEMS.filter((i) => status[i.name]?.[0] === 'saved').length;

  return (
    <main
      style={{
        padding: 24,
        font: '14px ui-monospace, monospace',
        color: '#1b1b20',
        background:
          'repeating-conic-gradient(#e9e9ee 0% 25%, #fafafc 0% 50%) 50% / 24px 24px',
        minHeight: '100vh',
      }}
    >
      <p>
        <strong>
          {done}/{ITEMS.length} saved
        </strong>{' '}
        &rarr; public/image/thumbs/
      </p>
      <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap' }}>
        {ITEMS.map((item) => (
          <Shot
            key={item.name}
            kind={item.kind}
            name={item.name}
            onStatus={onStatus}
          />
        ))}
      </div>
      <pre>
        {ITEMS.map((i) => `${i.name}: ${(status[i.name] ?? ['rendering']).join(' ')}`).join(
          '\n',
        )}
      </pre>
    </main>
  );
}
