import fs from "node:fs";
import path from "node:path";

const TEXT_EXTENSIONS = new Set([
  ".lua", ".json", ".jsonc", ".md", ".txt", ".toml", ".yaml", ".yml",
  ".ini", ".cfg", ".conf", ".glsl", ".vert", ".frag", ".vs", ".fs",
  ".c", ".h", ".cpp", ".hpp", ".js", ".mjs", ".cjs", ".ts", ".tsx",
  ".jsx", ".css", ".html", ".xml", ".csv", ".love"
]);

const IGNORED_DIRS = new Set([
  ".git", "node_modules", ".svn", ".hg", "build", "dist", ".cache",
  ".love2d-studio/cache", "__pycache__"
]);

export function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function resolveInside(roots, requested, { allowMissing = false } = {}) {
  if (typeof requested !== "string" || requested.includes("\0")) {
    throw new Error("Invalid path.");
  }
  const list = Array.isArray(roots) ? roots : [roots];
  const clean = requested.replace(/^[\\/]+/, "");
  for (const root of list) {
    if (!root) continue;
    const base = path.resolve(root);
    const candidate = path.resolve(base, clean || ".");
    if (!isInside(base, candidate)) continue;

    let checkPath = candidate;
    if (allowMissing) {
      checkPath = candidate;
      while (!fs.existsSync(checkPath) && checkPath !== base) {
        checkPath = path.dirname(checkPath);
      }
    }
    let realBase = base;
    let realCheck = checkPath;
    try {
      realBase = fs.realpathSync.native(base);
    } catch {
      // Root itself may be new.
    }
    try {
      realCheck = fs.realpathSync.native(checkPath);
    } catch {
      // Missing leaf is acceptable when allowMissing is set.
    }
    if (!isInside(realBase, realCheck)) continue;
    return candidate;
  }
  throw new Error(`Path is outside the project: ${requested}`);
}

export function readJson(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return fallback;
    throw error;
  }
}

export function writeFileAtomic(file, content, options = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = path.join(
    path.dirname(file),
    `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`
  );
  fs.writeFileSync(temp, content, { encoding: "utf8", ...options });
  fs.renameSync(temp, file);
}

export function writeJsonAtomic(file, value) {
  writeFileAtomic(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export function isProbablyText(file, sampleSize = 8192) {
  const ext = path.extname(file).toLowerCase();
  if (TEXT_EXTENSIONS.has(ext)) return true;
  let fd;
  try {
    fd = fs.openSync(file, "r");
    const buffer = Buffer.alloc(sampleSize);
    const read = fs.readSync(fd, buffer, 0, sampleSize, 0);
    if (read === 0) return true;
    for (let i = 0; i < read; i += 1) {
      if (buffer[i] === 0) return false;
    }
    return true;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function walkFiles(root, { maxFiles = 5000, maxDepth = 20 } = {}) {
  const output = [];
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length && output.length < maxFiles) {
    const { dir, depth } = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".") && entry.name !== ".zed") {
        if (entry.name === ".love2d-studio") continue;
        continue;
      }
      if (IGNORED_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (depth < maxDepth) stack.push({ dir: full, depth: depth + 1 });
      } else if (entry.isFile()) {
        output.push(full);
        if (output.length >= maxFiles) break;
      }
    }
  }
  return output;
}

export function treeLines(root, { maxDepth = 4, maxEntries = 300 } = {}) {
  const lines = [];
  function visit(dir, prefix, depth) {
    if (depth > maxDepth || lines.length >= maxEntries) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries = entries
      .filter((entry) => !inIgnored(entry.name))
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    entries.forEach((entry, index) => {
      if (lines.length >= maxEntries) return;
      const last = index === entries.length - 1;
      lines.push(`${prefix}${last ? "└─ " : "├─ "}${entry.name}${entry.isDirectory() ? "/" : ""}`);
      if (entry.isDirectory()) {
        visit(path.join(dir, entry.name), `${prefix}${last ? "   " : "│  "}`, depth + 1);
      }
    });
  }
  visit(root, "", 1);
  return lines.join("\n");
}

function inIgnored(name) {
  return name === ".git" || name === "node_modules" || name === ".love2d-studio"
    || name === "build" || name === "dist" || name === ".cache";
}

export function sanitizeName(name, fallback = "untitled") {
  const cleaned = String(name || "")
    .trim()
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .slice(0, 80);
  return cleaned || fallback;
}

export function sanitizeSlug(name, fallback = "scene") {
  const slug = String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || fallback;
}

export const MIME_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
  ".svg": "image/svg+xml",
  ".tga": "image/x-tga",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".flac": "audio/flac",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".json": "application/json",
  ".lua": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8"
};

export function mimeFor(file) {
  return MIME_TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
}
