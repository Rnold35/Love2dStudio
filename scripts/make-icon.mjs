import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(HERE, "..", "desktop");
const size = 256;
const supersample = 3;

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const typeBuffer = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, crc]);
}

function pngFromPixels(width, height, pixels) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const scanlines = Buffer.alloc((width * 4 + 1) * height);
  let offset = 0;
  for (let y = 0; y < height; y += 1) {
    scanlines[offset++] = 0;
    for (let x = 0; x < width; x += 1) {
      const pixel = (y * width + x) * 4;
      scanlines[offset++] = pixels[pixel];
      scanlines[offset++] = pixels[pixel + 1];
      scanlines[offset++] = pixels[pixel + 2];
      scanlines[offset++] = pixels[pixel + 3];
    }
  }
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(scanlines, { level: 9 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function inRoundedSquare(x, y, half, radius) {
  const cornerX = Math.max(Math.abs(x) - (half - radius), 0);
  const cornerY = Math.max(Math.abs(y) - (half - radius), 0);
  return Math.abs(x) <= half && Math.abs(y) <= half
    && Math.hypot(cornerX, cornerY) <= radius;
}

function inHeart(x, y) {
  const hx = x / 0.78;
  const hy = -y / 0.78 + 0.05;
  const equation = (hx * hx + hy * hy - 1) ** 3 - hx * hx * hy ** 3;
  return equation <= 0;
}

function mix(a, b, t) {
  return Math.round(a + (b - a) * t);
}

const pixels = Buffer.alloc(size * size * 4);
const half = size / 2;
const samples = supersample * supersample;

for (let y = 0; y < size; y += 1) {
  for (let x = 0; x < size; x += 1) {
    let bg = 0;
    let heart = 0;
    for (let sy = 0; sy < supersample; sy += 1) {
      for (let sx = 0; sx < supersample; sx += 1) {
        const px = x + (sx + 0.5) / supersample;
        const py = y + (sy + 0.5) / supersample;
        const nx = (px - half) / half;
        const ny = (py - half) / half;
        if (inRoundedSquare(px - half, py - half, half * 0.94, half * 0.23)) {
          bg += 1;
          if (inHeart(nx, ny)) heart += 1;
        }
      }
    }
    const index = (y * size + x) * 4;
    const bgAlpha = bg / samples;
    const heartAlpha = heart / samples;
    // Dark rounded-square background with a soft accent glow.
    const glow = Math.max(0, 1 - Math.hypot(x - size * 0.76, y - size * 0.18) / (size * 0.58));
    const bgR = mix(16, 44, glow * 0.22);
    const bgG = mix(18, 18, glow * 0.22);
    const bgB = mix(23, 35, glow * 0.22);
    // Pink heart.
    const r = mix(bgR, 255, heartAlpha);
    const g = mix(bgG, 92, heartAlpha);
    const b = mix(bgB, 138, heartAlpha);
    pixels[index] = r;
    pixels[index + 1] = g;
    pixels[index + 2] = b;
    pixels[index + 3] = Math.round(bgAlpha * 255);
  }
}

const png = pngFromPixels(size, size, pixels);
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "icon.png"), png);

// Windows ICO with a single 256x256 PNG-compressed image.
const iconDir = Buffer.alloc(6);
iconDir.writeUInt16LE(0, 0);
iconDir.writeUInt16LE(1, 2);
iconDir.writeUInt16LE(1, 4);
const entry = Buffer.alloc(16);
entry[0] = 0; // 256
entry[1] = 0; // 256
entry[2] = 0;
entry[3] = 0;
entry.writeUInt16LE(1, 4);
entry.writeUInt16LE(32, 6);
entry.writeUInt32LE(png.length, 8);
entry.writeUInt32LE(22, 12);
fs.writeFileSync(path.join(OUT, "icon.ico"), Buffer.concat([iconDir, entry, png]));
console.log(`Wrote ${path.join(OUT, "icon.png")} and icon.ico`);
