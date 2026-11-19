import fs from "node:fs";
import path from "node:path";
import { readJson, walkFiles, writeJsonAtomic } from "./fsx.js";

const INDEX_VERSION = 1;
const AI_DIR = path.join(".love2d-studio", "ai");
const INDEX_NAME = "index.json";
const MEMORY_NAME = "memory.md";
const MAX_LUA_BYTES = 1_000_000;
const MAX_INDEX_CHARS = 18_000;
const MAX_MEMORY_CHARS = 16_000;

export function projectAiDir(projectPath) {
  return path.join(path.resolve(projectPath), AI_DIR);
}

export function projectIndexPath(projectPath) {
  return path.join(projectAiDir(projectPath), INDEX_NAME);
}

export function projectMemoryPath(projectPath) {
  return path.join(projectAiDir(projectPath), MEMORY_NAME);
}

function relativePath(root, file) {
  return path.relative(root, file).split(path.sep).join("/");
}

function moduleName(relative) {
  return relative.replace(/\.lua$/i, "").replaceAll("/", ".");
}

function luaFiles(projectPath) {
  try {
    return walkFiles(projectPath, { maxFiles: 8000, maxDepth: 24 })
      .filter((file) => file.toLowerCase().endsWith(".lua"))
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function leadingDoc(lines, index) {
  const parts = [];
  let cursor = index - 1;
  while (cursor >= 0 && parts.length < 3) {
    const line = lines[cursor].trim();
    if (!line) break;
    if (!line.startsWith("--") || line.startsWith("--[[")) break;
    parts.unshift(line.replace(/^--+\s?/, "").trim());
    cursor -= 1;
  }
  const doc = parts.filter(Boolean).join(" ");
  return doc.slice(0, 300);
}

function parseLuaFile(root, file, content, stat) {
  const relative = relativePath(root, file);
  const lines = content.split(/\r?\n/);
  const symbols = [];
  const requires = new Set();
  const seen = new Set();

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const code = line.replace(/--.*$/, "");
    let match = /^\s*(local\s+)?function\s+([A-Za-z_][A-Za-z0-9_.:]*)\s*\(([^)]*)\)/.exec(code);
    let local = false;
    let name = "";
    let args = "";
    if (match) {
      local = Boolean(match[1]);
      name = match[2];
      args = match[3].trim();
    } else {
      match = /^\s*(local\s+)?([A-Za-z_][A-Za-z0-9_.:]*)\s*=\s*function\s*\(([^)]*)\)/.exec(code);
      if (match) {
        local = Boolean(match[1]);
        name = match[2];
        args = match[3].trim();
      }
    }
    if (name && !seen.has(`${index}:${name}`)) {
      seen.add(`${index}:${name}`);
      const kind = local ? "local" : name.includes(":") ? "method" : "function";
      symbols.push({
        name,
        kind,
        line: index + 1,
        signature: `${name}(${args})`.slice(0, 220),
        doc: leadingDoc(lines, index)
      });
    }

    const requirePattern = /\brequire\s*(?:\(\s*)?["']([^"']+)["']/g;
    let required;
    while ((required = requirePattern.exec(code)) !== null) {
      if (required[1]) requires.add(required[1]);
    }
  }

  symbols.sort((a, b) => a.line - b.line);
  for (let index = 0; index < symbols.length; index += 1) {
    symbols[index].endLine = index + 1 < symbols.length
      ? Math.max(symbols[index].line, symbols[index + 1].line - 1)
      : lines.length;
  }

  return {
    path: relative,
    module: moduleName(relative),
    lines: lines.length,
    size: stat.size,
    mtimeMs: Math.floor(stat.mtimeMs),
    requires: [...requires].sort(),
    symbols
  };
}

function buildIndex(projectPath) {
  const root = path.resolve(projectPath);
  const files = [];
  for (const file of luaFiles(root)) {
    let stat;
    try {
      stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > MAX_LUA_BYTES) continue;
      const content = fs.readFileSync(file, "utf8");
      files.push(parseLuaFile(root, file, content, stat));
    } catch {
      // Skip unreadable or non-text files.
    }
  }
  const totals = {
    files: files.length,
    lines: files.reduce((sum, file) => sum + file.lines, 0),
    symbols: files.reduce((sum, file) => sum + file.symbols.length, 0)
  };
  const index = {
    version: INDEX_VERSION,
    root,
    generatedAt: new Date().toISOString(),
    files,
    totals
  };
  try {
    writeJsonAtomic(projectIndexPath(root), index);
  } catch {
    // The index still works for this turn if the project is read-only.
  }
  return index;
}

function indexMatchesFiles(index, currentFiles, root) {
  if (!index || index.version !== INDEX_VERSION || !Array.isArray(index.files)) return false;
  if (index.root !== root) return false;
  if (index.files.length !== currentFiles.length) return false;
  const cached = new Map(index.files.map((entry) => [entry.path, entry]));
  for (const file of currentFiles) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      return false;
    }
    const entry = cached.get(relativePath(root, file));
    if (!entry) return false;
    if (entry.size !== stat.size || entry.mtimeMs !== Math.floor(stat.mtimeMs)) return false;
  }
  return true;
}

export function loadProjectIndex(projectPath, { force = false } = {}) {
  const root = path.resolve(projectPath);
  const files = luaFiles(root);
  if (!force) {
    try {
      const cached = readJson(projectIndexPath(root));
      if (cached && indexMatchesFiles(cached, files, root)) return cached;
    } catch {
      // Rebuild below.
    }
  }
  return buildIndex(root);
}

export function renderIndexOutline(index, {
  maxChars = MAX_INDEX_CHARS,
  maxSymbolsPerFile = 28
} = {}) {
  const files = Array.isArray(index?.files) ? index.files : [];
  if (!files.length) return "(no Lua files found)";
  const output = [];
  let size = 0;
  const push = (line) => {
    if (size + line.length + 1 > maxChars) return false;
    output.push(line);
    size += line.length + 1;
    return true;
  };

  push(`Lua modules (${files.length} files, ${index?.totals?.symbols || 0} functions):`);
  for (const file of files) {
    const requires = file.requires?.length ? ` · requires ${file.requires.join(", ")}` : "";
    push(`- ${file.path} (${file.lines} lines)${requires}`);
  }
  for (const file of files) {
    if (!file.symbols?.length) continue;
    push(`\n${file.path}`);
    for (const symbol of file.symbols.slice(0, maxSymbolsPerFile)) {
      const doc = symbol.doc ? ` — ${symbol.doc}` : "";
      const line = `  L${symbol.line} ${symbol.signature} [${symbol.kind}]${doc}`;
      if (!push(line)) {
        output.push("[Lua index truncated; use the code_index tool for more.]");
        return output.join("\n");
      }
    }
    if (file.symbols.length > maxSymbolsPerFile) {
      if (!push(`  … ${file.symbols.length - maxSymbolsPerFile} more symbols (use code_index)`)) break;
    }
  }
  return output.join("\n");
}

export function findIndexSymbols(index, query = "", { file = "", max = 60 } = {}) {
  const needle = String(query || "").trim().toLowerCase();
  const fileNeedle = String(file || "").trim().replaceAll("\\", "/").toLowerCase();
  const results = [];
  for (const entry of index?.files || []) {
    if (fileNeedle && !entry.path.toLowerCase().includes(fileNeedle)) continue;
    const fileMatches = !needle
      || entry.path.toLowerCase().includes(needle)
      || entry.module.toLowerCase().includes(needle)
      || entry.requires.some((item) => item.toLowerCase().includes(needle));
    for (const symbol of entry.symbols || []) {
      const haystack = `${symbol.name} ${symbol.signature} ${symbol.doc}`.toLowerCase();
      if (!needle || haystack.includes(needle) || fileMatches) {
        results.push({
          ...symbol,
          file: entry.path,
          module: entry.module,
          fileLineCount: entry.lines
        });
        if (results.length >= max) return results;
      }
    }
    if (!entry.symbols?.length && fileMatches) {
      results.push({
        name: "(module)",
        kind: "module",
        signature: entry.module,
        line: 1,
        endLine: 1,
        doc: entry.requires?.length ? `requires ${entry.requires.join(", ")}` : "",
        file: entry.path,
        module: entry.module,
        fileLineCount: entry.lines
      });
      if (results.length >= max) return results;
    }
  }
  return results;
}

export function readIndexedSymbol(projectPath, index, name, file = "") {
  const query = String(name || "").trim();
  if (!query) throw new Error("A function or method name is required.");
  const wantedFile = String(file || "").trim().replaceAll("\\", "/").toLowerCase();
  let matches = [];
  for (const entry of index?.files || []) {
    if (wantedFile && !entry.path.toLowerCase().includes(wantedFile)) continue;
    for (const symbol of entry.symbols || []) {
      if (symbol.name.toLowerCase() === query.toLowerCase()) {
        matches.push({ ...symbol, file: entry.path });
      }
    }
  }
  if (!matches.length) {
    const partial = [];
    for (const entry of index?.files || []) {
      if (wantedFile && !entry.path.toLowerCase().includes(wantedFile)) continue;
      for (const symbol of entry.symbols || []) {
        if (symbol.name.toLowerCase().includes(query.toLowerCase())) {
          partial.push({ ...symbol, file: entry.path });
        }
      }
    }
    matches = partial;
  }
  if (!matches.length) throw new Error(`No indexed Lua symbol matches "${query}".`);
  if (matches.length > 1) {
    const uniqueFiles = new Set(matches.map((item) => item.file));
    if (uniqueFiles.size > 1) {
      throw new Error(
        `Multiple symbols match "${query}". Specify a file: ${matches
          .slice(0, 12)
          .map((item) => `${item.name} (${item.file}:${item.line})`)
          .join(", ")}`
      );
    }
  }
  const symbol = matches[0];
  const root = path.resolve(projectPath);
  const absolute = path.resolve(root, symbol.file);
  if (!absolute.startsWith(root + path.sep) && absolute !== root) {
    throw new Error("The indexed file is outside the project.");
  }
  const content = fs.readFileSync(absolute, "utf8");
  const lines = content.split(/\r?\n/);
  const start = Math.max(1, symbol.line);
  const end = Math.max(start, Math.min(lines.length, symbol.endLine || lines.length));
  const selected = lines.slice(start - 1, end).join("\n");
  return `File: ${symbol.file} (lines ${start}-${end})\nSymbol: ${symbol.signature} [${symbol.kind}]\n\n${selected}`;
}

export function readProjectMemory(projectPath, { maxChars = MAX_MEMORY_CHARS } = {}) {
  try {
    const content = fs.readFileSync(projectMemoryPath(projectPath), "utf8").trim();
    return content.length > maxChars ? `${content.slice(-maxChars)}\n[memory truncated]` : content;
  } catch {
    return "";
  }
}

export function appendProjectMemory(projectPath, note) {
  const value = String(note || "").trim().slice(0, 4000);
  if (!value) throw new Error("A memory note is required.");
  const file = projectMemoryPath(projectPath);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (!fs.existsSync(file)) {
    fs.writeFileSync(
      file,
      "# Project memory\n\nDurable notes for the Love2D Assistant. This file is local editor state.\n",
      "utf8"
    );
  }
  fs.appendFileSync(file, `\n- ${new Date().toISOString().slice(0, 10)} — ${value}\n`, "utf8");
  return { path: file, note: value };
}
