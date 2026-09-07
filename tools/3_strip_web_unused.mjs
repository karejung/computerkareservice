/**
 * Drop the texture images the web app never reads, and everything that becomes
 * unreferenced with them.
 *
 *   node tools/3_strip_web_unused.mjs            # writes <name>.stripped.glb
 *   node tools/3_strip_web_unused.mjs --write    # replaces the GLB, keeps a .bak
 *
 * The GLB is authored for Blender's viewport, where the DS screens are a
 * scratched-plastic PBR surface and the face is a baked painting. The web app
 * keeps neither: `createScreenMaterial` in lib/twoTone.ts is a raw
 * ShaderMaterial with no sampler at all, and the face is drawn live to a canvas
 * by lib/faceTexture.ts. So those images are downloaded, decoded and held for
 * nothing — 1.35 MB of a 2.3 MB file, and ~16 MB once decoded.
 *
 * Only images reached *solely* through those two dead ends are listed. `blush`
 * stays: it goes through `createFlatMaterial`, which does read `map`.
 *
 * The right long-term home for this is tools/1_export_glb.py, which already
 * downscales images on the way out — but that needs Blender, and this does not.
 * Re-run it after any re-export.
 */
import { readFileSync, writeFileSync, copyFileSync } from 'node:fs';

const SRC = process.argv.find((a) => a.endsWith('.glb')) ?? 'public/models/kare9.glb';
const WRITE = process.argv.includes('--write');

/** Image names to drop, with the material that is the only thing referencing them. */
const DROP = new Set([
  'imperfection_0002_color_4k', // screen up/down .001 -> createScreenMaterial (no map)
  'imperfection_0002_roughness_4k', //   "
  'ScratchesLight001_NRM_3K', //   "
  'Nintendo_DS-title', //   "
  'face', // face.002 -> createTwoToneMaterial(face rig canvas), baked art unused
]);

const glb = readFileSync(SRC);
const jsonLen = glb.readUInt32LE(12);
const json = JSON.parse(glb.slice(20, 20 + jsonLen).toString());
const binLen = glb.readUInt32LE(20 + jsonLen);
const bin = glb.slice(20 + jsonLen + 8, 20 + jsonLen + 8 + binLen);

const before = { images: json.images.length, textures: json.textures.length, bytes: glb.length };

// --- 1. which textures point at a doomed image ------------------------------
const deadTexture = new Set(
  json.textures.map((t, i) => [i, t]).filter(([, t]) => DROP.has(json.images[t.source]?.name)).map(([i]) => i),
);

/*
 * A textureInfo is `{index, texCoord?, extensions?}` and appears under a dozen
 * different keys across core glTF and the material extensions
 * (KHR_materials_specular carries two of its own). Rather than enumerate them,
 * walk the material objects and delete any property that is a textureInfo
 * naming a dead texture — then collect the survivors the same way.
 */
const isTextureInfo = (v) =>
  v && typeof v === 'object' && !Array.isArray(v) && typeof v.index === 'number';

function walkTextureInfos(node, onFound) {
  if (!node || typeof node !== 'object') return;
  for (const key of Object.keys(node)) {
    const value = node[key];
    if (isTextureInfo(value)) {
      if (onFound(value, node, key)) continue;
    }
    if (value && typeof value === 'object') walkTextureInfos(value, onFound);
  }
}

let removedSlots = 0;
for (const material of json.materials) {
  walkTextureInfos(material, (info, parent, key) => {
    if (deadTexture.has(info.index)) {
      delete parent[key];
      removedSlots++;
      return true;
    }
    return false;
  });
}

// --- 2. textures / images / samplers still reachable -------------------------
const liveTexture = new Set();
for (const material of json.materials) {
  walkTextureInfos(material, (info) => void liveTexture.add(info.index));
}

const texMap = new Map();
const textures = [];
json.textures.forEach((t, i) => {
  if (!liveTexture.has(i)) return;
  texMap.set(i, textures.length);
  textures.push(t);
});

const imgMap = new Map();
const images = [];
const smpMap = new Map();
const samplers = [];
for (const t of textures) {
  if (t.source !== undefined && !imgMap.has(t.source)) {
    imgMap.set(t.source, images.length);
    images.push(json.images[t.source]);
  }
  if (t.sampler !== undefined && !smpMap.has(t.sampler)) {
    smpMap.set(t.sampler, samplers.length);
    samplers.push(json.samplers[t.sampler]);
  }
}
for (const t of textures) {
  if (t.source !== undefined) t.source = imgMap.get(t.source);
  if (t.sampler !== undefined) t.sampler = smpMap.get(t.sampler);
}
for (const material of json.materials) {
  walkTextureInfos(material, (info) => {
    info.index = texMap.get(info.index);
  });
}

// --- 3. compact the binary chunk --------------------------------------------
// Accessors and the surviving images are the only things pointing into it here
// (no Draco, no meshopt, no sparse accessors — checked before writing this).
const used = new Set();
for (const a of json.accessors) if (a.bufferView !== undefined) used.add(a.bufferView);
for (const im of images) if (im.bufferView !== undefined) used.add(im.bufferView);

const bvMap = new Map();
const bufferViews = [];
const parts = [];
let offset = 0;
json.bufferViews.forEach((view, i) => {
  if (!used.has(i)) return;
  const start = view.byteOffset ?? 0;
  const bytes = bin.slice(start, start + view.byteLength);
  const pad = (4 - (offset % 4)) % 4;
  if (pad) {
    parts.push(Buffer.alloc(pad));
    offset += pad;
  }
  bvMap.set(i, bufferViews.length);
  bufferViews.push({ ...view, byteOffset: offset });
  parts.push(bytes);
  offset += bytes.length;
});

for (const a of json.accessors) if (a.bufferView !== undefined) a.bufferView = bvMap.get(a.bufferView);
for (const im of images) if (im.bufferView !== undefined) im.bufferView = bvMap.get(im.bufferView);

json.textures = textures;
json.images = images;
json.samplers = samplers;
json.bufferViews = bufferViews;

const newBin = Buffer.concat(parts);
json.buffers = [{ byteLength: newBin.length }];

// KHR_texture_transform rode along on textureInfos that may all be gone now.
// It is in extensionsRequired, so a stale entry makes loaders refuse the file.
const stillUsed = new Set();
const scan = (node) => {
  if (!node || typeof node !== 'object') return;
  if (node.extensions) for (const k of Object.keys(node.extensions)) stillUsed.add(k);
  for (const v of Object.values(node)) if (v && typeof v === 'object') scan(v);
};
scan(json);
for (const key of ['extensionsUsed', 'extensionsRequired']) {
  if (!json[key]) continue;
  json[key] = json[key].filter((e) => stillUsed.has(e));
  if (!json[key].length) delete json[key];
}

// --- 4. emit ----------------------------------------------------------------
const jsonBuf = Buffer.from(JSON.stringify(json), 'utf8');
const jsonPad = Buffer.alloc((4 - (jsonBuf.length % 4)) % 4, 0x20); // spaces
const binPad = Buffer.alloc((4 - (newBin.length % 4)) % 4, 0);

const jsonChunk = Buffer.concat([jsonBuf, jsonPad]);
const binChunk = Buffer.concat([newBin, binPad]);
const header = Buffer.alloc(12);
header.write('glTF', 0, 'ascii');
header.writeUInt32LE(2, 4);
header.writeUInt32LE(12 + 8 + jsonChunk.length + 8 + binChunk.length, 8);

const chunk = (data, type) => {
  const head = Buffer.alloc(8);
  head.writeUInt32LE(data.length, 0);
  head.write(type, 4, 'ascii');
  return Buffer.concat([head, data]);
};

const out = Buffer.concat([header, chunk(jsonChunk, 'JSON'), chunk(binChunk, 'BIN\0')]);
const dest = WRITE ? SRC : SRC.replace(/\.glb$/, '.stripped.glb');
if (WRITE) copyFileSync(SRC, SRC + '.bak');
writeFileSync(dest, out);

const kb = (n) => (n / 1024).toFixed(0) + ' KB';
console.log(`images   ${before.images} -> ${images.length}   (dropped ${[...DROP].join(', ')})`);
console.log(`textures ${before.textures} -> ${textures.length}, material slots cleared: ${removedSlots}`);
console.log(`size     ${kb(before.bytes)} -> ${kb(out.length)}  (-${kb(before.bytes - out.length)})`);
console.log(`wrote    ${dest}${WRITE ? `  (backup at ${SRC}.bak)` : ''}`);
