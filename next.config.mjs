/**
 * GitHub Pages serves this repo from `/computerkareservice/`, and only as static
 * files — there is no Node process behind it. Both facts are switched on by
 * `NEXT_PUBLIC_BASE_PATH`, which CI sets and local dev leaves unset, so `npm run
 * dev` still runs the normal server at the root.
 *
 * `basePath` covers Next's own output (the `_next/` chunks, router links).
 * Anything addressed as a plain string — the GLB, the button images, the cursor
 * — goes through `lib/asset.ts`, which reads the same variable.
 */
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ['three'],
  ...(basePath
    ? {
        output: 'export',
        basePath,
        assetPrefix: basePath,
        // The export has no image optimiser to call at runtime.
        images: { unoptimized: true },
        // Pages resolves `/foo` to `/foo/index.html`.
        trailingSlash: true,
      }
    : {}),
};

export default nextConfig;
