import fs from "node:fs";
import path from "node:path";
import { isInside, mimeFor, resolveInside, sanitizeName } from "../shared/fsx.js";

const IMAGE_EXT = new Set([".png", ".jpg", ".jpeg", ".bmp", ".tga"]);
const AUDIO_EXT = new Set([".wav", ".ogg", ".mp3", ".flac"]);
const FONT_EXT = new Set([".ttf", ".otf"]);
const ALLOWED_EXT = new Set([...IMAGE_EXT, ...AUDIO_EXT, ...FONT_EXT]);
const MAX_ASSET_SIZE = 40 * 1024 * 1024;

export function assetKind(ext) {
  if (IMAGE_EXT.has(ext)) return "image";
  if (AUDIO_EXT.has(ext)) return "audio";
  if (FONT_EXT.has(ext)) return "font";
  return "other";
}

function imageDimensions(file, ext) {
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const header = Buffer.alloc(32);
    const read = fs.readSync(fd, header, 0, 32, 0);
    if (read < 24) return null;
    if (ext === ".png" && header.slice(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
      return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
    }
    if (ext === ".bmp" && header.toString("ascii", 0, 2) === "BM") {
      return { width: header.readInt32LE(18), height: Math.abs(header.readInt32LE(22)) };
    }
    if ((ext === ".jpg" || ext === ".jpeg") && header[0] === 0xff && header[1] === 0xd8) {
      return jpegDimensions(fd);
    }
    if (ext === ".gif" && header.toString("ascii", 0, 3) === "GIF") {
      return { width: header.readUInt16LE(6), height: header.readUInt16LE(8) };
    }
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  return null;
}

function jpegDimensions(fd) {
  const buffer = Buffer.alloc(64 * 1024);
  const read = fs.readSync(fd, buffer, 0, buffer.length, 0);
  let offset = 2;
  while (offset + 9 < read) {
    if (buffer[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = buffer[offset + 1];
    if (marker === 0xd8 || marker === 0xd9) {
      offset += 2;
      continue;
    }
    const length = buffer.readUInt16BE(offset + 2);
    if (marker >= 0xc0 && marker <= 0xc3) {
      return {
        width: buffer.readUInt16BE(offset + 7),
        height: buffer.readUInt16BE(offset + 5)
      };
    }
    if (!length) break;
    offset += 2 + length;
  }
  return null;
}

function walkAssets(root) {
  const files = [];
  function visit(dir) {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) visit(full);
      else if (entry.isFile()) files.push(full);
    }
  }
  visit(root);
  return files;
}

export function listAssets(projectPath) {
  const root = path.join(projectPath, "assets");
  return walkAssets(root)
    .filter((file) => ALLOWED_EXT.has(path.extname(file).toLowerCase()))
    .slice(0, 4000)
    .map((file) => {
      const ext = path.extname(file).toLowerCase();
      const relative = path.relative(projectPath, file).replace(/\\/g, "/");
      const stat = fs.statSync(file);
      const dimensions = IMAGE_EXT.has(ext) ? imageDimensions(file, ext) : null;
      return {
        path: relative,
        name: path.basename(file),
        folder: path.dirname(relative).replace(/\\/g, "/"),
        kind: assetKind(ext),
        ext,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        width: dimensions?.width || null,
        height: dimensions?.height || null
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path));
}

export function importAsset(projectPath, suggestedName, data) {
  if (!Buffer.isBuffer(data) || data.length === 0) {
    throw new Error("The uploaded asset is empty.");
  }
  if (data.length > MAX_ASSET_SIZE) {
    throw new Error("Asset is larger than the 40 MB limit.");
  }
  const base = sanitizeName(path.basename(String(suggestedName || "asset")), "asset");
  const ext = path.extname(base).toLowerCase();
  if (!ALLOWED_EXT.has(ext)) {
    throw new Error(`Unsupported asset type: ${ext || "(none)"}`);
  }
  const kind = assetKind(ext);
  const subdir = kind === "image" ? "images" : kind === "audio" ? "audio" : "fonts";
  const dir = path.join(projectPath, "assets", subdir);
  fs.mkdirSync(dir, { recursive: true });
  let target = path.join(dir, base);
  let counter = 1;
  const stem = path.basename(base, ext);
  while (fs.existsSync(target)) {
    target = path.join(dir, `${stem}-${counter}${ext}`);
    counter += 1;
  }
  fs.writeFileSync(target, data);
  const relative = path.relative(projectPath, target).replace(/\\/g, "/");
  return {
    path: relative,
    name: path.basename(target),
    kind,
    ext
  };
}

function resolveAssetFile(projectPath, relativePath) {
  const assetsRoot = path.join(projectPath, "assets");
  let candidate = String(relativePath || "").replace(/\\/g, "/").replace(/^\/+/, "");
  if (!candidate.startsWith("assets/")) candidate = `assets/${candidate}`;
  const file = resolveInside(projectPath, candidate);
  if (!isInside(assetsRoot, file)) throw new Error("Asset is outside the assets folder.");
  return file;
}

export function deleteAsset(projectPath, relativePath) {
  const file = resolveAssetFile(projectPath, relativePath);
  const stat = fs.statSync(file);
  if (!stat.isFile()) throw new Error("Asset not found.");
  if (!ALLOWED_EXT.has(path.extname(file).toLowerCase())) {
    throw new Error("This file is not a managed asset.");
  }
  fs.unlinkSync(file);
  return { deleted: relativePath.replace(/\\/g, "/") };
}

export function assetFile(projectPath, relativePath) {
  const file = resolveAssetFile(projectPath, relativePath);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    throw new Error("Asset not found.");
  }
  return { file, mime: mimeFor(file) };
}

export function isManagedAssetPath(relativePath) {
  const ext = path.extname(relativePath).toLowerCase();
  return ALLOWED_EXT.has(ext);
}
