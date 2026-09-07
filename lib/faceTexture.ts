import * as THREE from 'three';

/*
 * ART is the space every path, eye centre and socket below is authored in —
 * it is fixed, and nothing here is in pixels. SIZE is what the canvas actually
 * costs, and the two are only incidentally related.
 *
 * That distinction is the whole point: `update()` ends in
 * `texture.needsUpdate = true`, which re-uploads the entire canvas and
 * regenerates its mip chain. At the old SIZE of 2048 that was 16.8 MB a pop,
 * and the dirty test below clears on roughly 35 consecutive frames per glance
 * (LOOK_SMOOTHING against a 0.05 threshold), so a single eye movement pushed
 * something like 590 MB across the bus. On a phone that is the frame budget,
 * gone. At 512 the same glance costs about 37 MB.
 *
 * 512 rather than 256 because of the eyebrows: they are the thinnest stroke on
 * the face, ~40 units of ART, so 256 renders them 5 texels wide and they go
 * mushy once the face-zoom camera fills the screen with the head. 10 texels
 * holds. The pupils survive either way, and the difference costs 0.8 MB an
 * upload against the 16 MB already saved.
 */
const ART = 2048;
const SIZE = 512;
const SCALE = SIZE / ART;

const PATH_D = {
  face: 'M1444.47 1818.51L1031.96 1925.74L613.5 1816.94C609.3 1815.85 605.75 1811.57 603.18 1808.91L581.04 1785.95L559.92 1764.07L529.84 1733.13L503.64 1706.35L481.05 1682.95L459.92 1661.07L429.84 1630.13L402.68 1602.35L383.06 1581.83C380.89 1579.56 376.73 1576.19 375.86 1573.07L362 1522.91C360.8 1518.59 359 1515.01 355.84 1511.06L298.14 1565.4C291.1 1567.51 283.45 1567 276.03 1567.47L261.02 1568.42C256.29 1568.72 251.84 1568.08 248.38 1564.41L181.12 1492.99C176.06 1487.62 170.96 1482.88 167.39 1476.37L126.52 1297.03L109.94 1138.08C109.46 1133.45 109.2 1129.86 112.58 1126.54L139.89 1099.76L200.55 1039.66C216.33 1024.03 217.12 1027.71 233.95 1026.43C241.16 1025.88 248.77 1024.38 256.06 1026.16C262.73 1027.78 267.87 1034.48 274.02 1038C278.65 1035.42 278.74 1029.95 278.46 1024.93L277.21 1001.99L276.26 981.92L275.22 959.99L274.27 939.92L273.23 917.99L272.27 897.92L271.22 875.99L270.26 855.93L269.38 833.9C269.12 827.34 266.92 819.88 269.06 812.91L414.73 338.04C417.09 333.8 420.31 332.16 424.79 330.47L1031.95 101.53L1638.45 330.21C1642.98 331.92 1646.25 333.28 1649 337.43L1794.91 812.92C1796.96 819.61 1794.88 826.61 1794.62 832.91L1793.73 854.93L1792.77 874.99L1791.72 896.92L1790.76 916.99L1789.72 938.92L1788.76 958.99L1787.75 979.99L1786.74 1000.95L1786.04 1016.07L1785.31 1029.88C1785.23 1031.45 1786.9 1035.01 1787.57 1036.46C1789.89 1041.49 1798.78 1028.97 1807.21 1026.38C1814.47 1024.14 1822.5 1025.84 1830.05 1026.49C1836.19 1027.02 1844.81 1025.32 1850.19 1028.83C1856.9 1033.2 1862.57 1038.98 1868.36 1044.71L1928.55 1104.28L1951.87 1127.1C1954.96 1130.13 1954.41 1133.71 1953.97 1137.93L1937.38 1296.98L1896.36 1477.09L1876.05 1500.12L1816.06 1563.88C1812.38 1567.79 1808.15 1568.77 1802.91 1568.42L1787.93 1567.41C1780.91 1566.94 1773.18 1568.03 1766.72 1565.27C1762.78 1563.58 1759.7 1559.25 1756.35 1556.59L1710.13 1512.9C1709.68 1512.51 1707.82 1511.16 1707.49 1511.65L1705.86 1514.01C1703.93 1516.8 1702.73 1520.18 1701.78 1523.6L1688.11 1573.04C1687.18 1576.39 1682.77 1579.87 1680.43 1582.31L1658.83 1604.83L1632.15 1632.11L1602.07 1663.05L1580.95 1684.93L1558.84 1707.82L1533.15 1734.11L1502.08 1766.04L1480.96 1787.93L1458.97 1810.85C1454.94 1815.05 1450.98 1816.79 1444.47 1818.48V1818.51Z',
  irisR: 'M1489.96 1150.51C1492.79 1243.77 1442.52 1320.03 1361.8 1321.04C1281.07 1322.05 1226.21 1247.1 1223.38 1153.83C1220.54 1060.57 1277.92 984.222 1351.54 983.303C1425.15 982.384 1487.13 1057.24 1489.96 1150.51Z',
  pupilR: 'M1400.26 1091.08C1401.3 1125.29 1384.88 1153.23 1358.36 1153.56C1331.84 1153.89 1313.73 1126.38 1312.69 1092.17C1311.65 1057.97 1330.41 1029.99 1354.59 1029.69C1378.78 1029.39 1399.22 1056.87 1400.26 1091.08Z',

  winkR: 'M170 67.1905L49 91L162.5 110L154.903 156.519L0 101.054V80.5277L184 0L170 67.1905Z',
  eyelidR: 'M1255.31 1041.92C1281.56 999.293 1328.23 958.397 1410.18 965.129C1468.25 969.898 1510.71 993.965 1538.66 1016.84C1552.64 1028.28 1562.99 1039.42 1569.83 1047.7C1573.26 1051.83 1575.81 1055.25 1577.5 1057.64C1578.34 1058.83 1578.97 1059.76 1579.39 1060.39C1579.6 1060.7 1579.76 1060.95 1579.86 1061.11C1579.91 1061.19 1579.95 1061.25 1579.97 1061.29C1579.99 1061.31 1580 1061.32 1580 1061.33C1580 1061.34 1580.01 1061.34 1580.01 1061.34C1580.01 1061.34 1580.01 1061.34 1580.01 1061.34L1580.01 1061.34L1580.38 1061.95L1581.08 1061.83L1676.39 1045.36L1538.37 1218.55C1538.41 1217.28 1538.45 1215.64 1538.46 1213.69C1538.5 1208.53 1538.39 1201.13 1537.78 1192.15C1536.58 1174.2 1533.42 1149.95 1525.57 1124.76C1509.88 1074.37 1475.41 1020.07 1400.37 1005.15C1362.92 997.703 1332.95 1001.67 1309.06 1011.87C1285.19 1022.07 1267.46 1038.46 1254.45 1055.75C1242.49 1071.65 1234.5 1088.32 1229.36 1101.69C1229.38 1101.61 1229.4 1101.54 1229.42 1101.46C1234.16 1085.02 1242.17 1063.25 1255.31 1041.92Z',
  eyebrowR: 'M1331.47 772.437C1398.46 729.537 1489.9 707.768 1605.35 743.228L1593.61 781.435C1489.55 749.473 1410.26 769.439 1353.03 806.096C1294.98 843.274 1258.54 898.371 1243.07 937.088L1205.95 922.254C1224 877.099 1265.3 814.817 1331.47 772.437Z',
  irisL: 'M574.275 1150.51C571.442 1243.77 621.711 1320.03 702.437 1321.04C783.163 1322.04 838.026 1247.1 840.859 1153.83C843.692 1060.57 786.312 984.221 712.697 983.302C639.081 982.383 577.108 1057.24 574.275 1150.51Z',
  pupilL: 'M663.973 1091.08C662.934 1125.29 679.36 1153.23 705.88 1153.56C732.399 1153.89 750.51 1126.38 751.549 1092.17C752.588 1057.97 733.826 1029.99 709.643 1029.69C685.459 1029.39 665.012 1056.87 663.973 1091.08Z',
  eyelidL: 'M808.923 1041.92C782.673 999.292 736 958.397 654.053 965.128C595.985 969.898 553.521 993.964 525.569 1016.84C511.592 1028.28 501.246 1039.42 494.398 1047.7C490.974 1051.83 488.425 1055.25 486.735 1057.64C485.89 1058.83 485.26 1059.76 484.842 1060.39C484.633 1060.7 484.477 1060.94 484.374 1061.11C484.323 1061.19 484.284 1061.25 484.259 1061.29C484.247 1061.31 484.238 1061.32 484.232 1061.33C484.229 1061.33 484.227 1061.34 484.226 1061.34C484.225 1061.34 484.224 1061.34 484.224 1061.34L484.224 1061.34L483.85 1061.95L483.151 1061.83L387.842 1045.36L525.861 1218.55C525.822 1217.28 525.785 1215.64 525.771 1213.69C525.733 1208.53 525.846 1201.12 526.448 1192.15C527.653 1174.2 530.817 1149.95 538.66 1124.76C554.349 1074.37 588.821 1020.07 663.866 1005.15C701.314 997.702 731.285 1001.67 755.17 1011.87C779.047 1022.07 796.769 1038.46 809.78 1055.75C821.74 1071.65 829.73 1088.32 834.874 1101.69C834.852 1101.61 834.831 1101.54 834.808 1101.46C830.077 1085.02 822.06 1063.25 808.923 1041.92Z',
  eyebrowL: 'M732.761 772.437C665.774 729.536 574.335 707.768 458.885 743.227L470.621 781.434C574.686 749.472 653.969 769.438 711.206 806.095C769.257 843.273 805.688 898.37 821.164 937.088L858.278 922.254C840.229 877.099 798.934 814.816 732.761 772.437Z',
} as const;

type PartName = keyof typeof PATH_D;

const FACE_FILL = '#ffffff';
const INK = '#000000';

const EYE_R = { cx: 1356.7, cy: 1152.2 };
const EYE_L = { cx: 707.6, cy: 1152.2 };
const LOOK_RANGE = { x: 33, y: 24 };
const PUPIL_EXTRA = 0.35;
const LID_PIVOT_Y = 1060;

const SOCKET_R = { cx: 1389, cy: 1169.5, rx: 171, ry: 202.5 };
const SOCKET_L = { cx: 675, cy: 1169.5, rx: 171, ry: 202.5 };

const BLINK_DUR = 240;
const LOOK_SMOOTHING = 0.12;
const LID_DROP = 95;

const WINK_W = 184;
const WINK_H = 157;
const WINK_SPREAD = 32;
const WINK_SCALE = 1.859;

const smooth = (x: number) => x * x * (3 - 2 * x);
const clamp1 = (v: number) => Math.max(-1, Math.min(1, v));

export interface FaceRig {
  texture: THREE.CanvasTexture;
  setLookTarget(nx: number, ny: number): void;
  setInk(color: string): void;
  resetLook(): void;
  triggerBlink(): void;
  setWink(on: boolean): void;
  update(): void;
  dispose(): void;
}

export function createFaceRig(): FaceRig {
  const canvas = document.createElement('canvas');
  canvas.width = SIZE;
  canvas.height = SIZE;
  const ctx = canvas.getContext('2d')!;

  const parts = {} as Record<PartName, Path2D>;
  for (const key of Object.keys(PATH_D) as PartName[]) {
    parts[key] = new Path2D(PATH_D[key]);
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.flipY = false;
  texture.colorSpace = THREE.SRGBColorSpace;

  const look = { x: 0, y: 0, tx: 0, ty: 0 };
  let blinkT0 = -1;
  let nextBlink = performance.now() + 1500;
  // A boolean, not a ramp. The wink used to cross-fade the eyelid out and the
  // >< mark in through globalAlpha, which on a face drawn in flat ink read as
  // a smear rather than a change of expression.
  let wink = false;
  let ink = INK;
  let dirty = true;

  function blinkValue(now: number): number {
    if (blinkT0 < 0 && now >= nextBlink) blinkT0 = now;
    if (blinkT0 < 0) return 1;
    const t = (now - blinkT0) / BLINK_DUR;
    if (t >= 1) {
      blinkT0 = -1;

      nextBlink = now + (Math.random() < 0.2 ? 300 : 1800 + Math.random() * 3500);
      return 1;
    }
    return t < 0.4 ? 1 - smooth(t / 0.4) : smooth((t - 0.4) / 0.6);
  }

  function drawFace(lookX: number, lookY: number, blink: number, winking: boolean) {
    // Everything below is in ART units, so the canvas is scaled once here
    // rather than each path being rewritten. Set before any save(), so the
    // restore() calls inside land back on it rather than on the identity.
    ctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
    ctx.clearRect(0, 0, ART, ART);

    ctx.fillStyle = FACE_FILL;
    ctx.fill(parts.face);

    for (const eye of [
      { c: EYE_R, socket: SOCKET_R, iris: 'irisR', pupil: 'pupilR', lid: 'eyelidR', brow: 'eyebrowR', mirror: false },
      { c: EYE_L, socket: SOCKET_L, iris: 'irisL', pupil: 'pupilL', lid: 'eyelidL', brow: 'eyebrowL', mirror: true },
    ] as const) {
      const { cx, cy } = eye.c;

      const open = winking ? 0 : blink;
      const b = Math.max(open, 0.02);

      if (open > 0.12) {
        ctx.save();

        ctx.beginPath();
        ctx.ellipse(eye.socket.cx, eye.socket.cy, eye.socket.rx, eye.socket.ry, 0, 0, Math.PI * 2);
        ctx.clip();
        ctx.translate(cx, cy + (1 - b) * 26);
        ctx.scale(1, b);
        ctx.translate(-cx, -cy);
        ctx.translate(lookX, lookY);
        ctx.fillStyle = ink;
        ctx.fill(parts[eye.iris]);

        ctx.translate(lookX * PUPIL_EXTRA, lookY * PUPIL_EXTRA);
        ctx.fillStyle = 'white';
        ctx.fill(parts[eye.pupil]);
        ctx.restore();
      }

      const flip = -0.85 + 1.85 * open;
      const lidS = Math.abs(flip) < 0.04 ? (flip < 0 ? -0.04 : 0.04) : flip;
      if (!winking) {
        ctx.save();
        ctx.translate(0, (1 - open) * LID_DROP);
        ctx.translate(0, LID_PIVOT_Y);
        ctx.scale(1, lidS);
        ctx.translate(0, -LID_PIVOT_Y);
        ctx.fillStyle = ink;
        ctx.fill(parts[eye.lid]);
        ctx.restore();
      }

      if (winking) {
        ctx.save();
        ctx.translate(cx + WINK_SPREAD * (eye.mirror ? -1 : 1), cy);
        ctx.scale(WINK_SCALE * (eye.mirror ? -1 : 1), WINK_SCALE);
        ctx.translate(-WINK_W / 2, -WINK_H / 2);
        ctx.fillStyle = ink;
        ctx.fill(parts.winkR);
        ctx.restore();
      }

      ctx.save();
      ctx.translate(lookX * 0.25, lookY * 0.35 + (1 - open) * 38);
      ctx.fillStyle = ink;
      ctx.fill(parts[eye.brow]);
      ctx.restore();
    }
  }

  const last = { x: NaN, y: NaN, blink: NaN, wink: null as boolean | null };

  return {
    texture,

    setLookTarget(nx: number, ny: number) {
      look.tx = clamp1(nx) * LOOK_RANGE.x;
      look.ty = clamp1(ny) * LOOK_RANGE.y;
    },

    setInk(color: string) {
      if (color === ink) return;
      ink = color;
      dirty = true;
    },

    resetLook() {
      look.tx = 0;
      look.ty = 0;
    },

    triggerBlink() {
      nextBlink = performance.now();
    },

    setWink(on: boolean) {
      if (on === wink) return;
      wink = on;
      dirty = true;
    },

    update() {
      look.x += (look.tx - look.x) * LOOK_SMOOTHING;
      look.y += (look.ty - look.y) * LOOK_SMOOTHING;
      // Keep the blink schedule ticking, but hold the value steady while the
      // wink is up: drawFace ignores blink entirely when winking, so letting it
      // vary only fails the dirty test below and repaints an identical face.
      const blinking = blinkValue(performance.now());
      const blink = wink ? 1 : blinking;

      if (
        !dirty &&
        Math.abs(look.x - last.x) < 0.05 &&
        Math.abs(look.y - last.y) < 0.05 &&
        blink === last.blink &&
        wink === last.wink
      ) {
        return;
      }
      dirty = false;
      last.x = look.x;
      last.y = look.y;
      last.blink = blink;
      last.wink = wink;

      drawFace(look.x, look.y, blink, wink);
      texture.needsUpdate = true;
    },

    dispose() {
      texture.dispose();
    },
  };
}
