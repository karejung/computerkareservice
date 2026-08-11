/**
 * Prefix for everything served out of `public/`.
 *
 * On GitHub Pages the site lives under `/<repo>/`, not at the domain root, so a
 * bare `/models/kare7.glb` resolves to `karejung.github.io/models/...` and 404s.
 * Next's `basePath` rewrites its own router links, but it cannot touch a string
 * handed to `<img src>`, `useGLTF()` or `new Image()` — those are just URLs as
 * far as it is concerned, so they go through here instead.
 *
 * Empty in dev and on any host that serves from the root, which is why the value
 * comes from the environment rather than being written down twice.
 */
const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

/** Resolve a `public/` path against wherever the site is mounted. */
export const asset = (path: string) => `${BASE}${path}`;
