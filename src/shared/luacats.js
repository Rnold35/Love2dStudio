import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { luacatsDir } from "./paths.js";

const MODULES = [
  "audio", "data", "event", "filesystem", "font", "graphics", "image",
  "joystick", "keyboard", "math", "mouse", "physics", "sound", "system",
  "thread", "timer", "touch", "video", "window"
];

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FALLBACK_DIR = path.resolve(HERE, "..", "..", "vendor", "love2d-fallback", "library");

function countLuaFiles(dir) {
  let count = 0;
  try {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) count += countLuaFiles(path.join(dir, entry.name));
      else if (entry.name.endsWith(".lua")) count += 1;
    }
  } catch {
    return 0;
  }
  return count;
}

function copyDir(source, target) {
  fs.mkdirSync(target, { recursive: true });
  fs.cpSync(source, target, { recursive: true, force: true });
}

async function fetchText(url, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { "user-agent": "love2d-studio/0.1 (+https://github.com/LuaCATS/love2d)" }
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Downloads the LuaCATS LÖVE definitions into the app cache.
 * Returns { path, source: "cache" | "downloaded" | "fallback" }.
 */
export async function ensureLuaCats() {
  const target = path.join(luacatsDir(), "library");
  if (countLuaFiles(target) > 10) {
    return { path: target, source: "cache" };
  }

  const temp = `${luacatsDir()}.${Date.now()}.tmp`;
  try {
    fs.mkdirSync(path.join(temp, "library", "love"), { recursive: true });
    const base = "https://raw.githubusercontent.com/LuaCATS/love2d/main/library";
    const files = [
      ["love.lua", `${base}/love.lua`],
      ...MODULES.map((name) => [path.join("love", `${name}.lua`), `${base}/love/${name}.lua`])
    ];
    const contents = await Promise.all(files.map(async ([relative, url]) => [
      relative,
      await fetchText(url)
    ]));
    for (const [relative, content] of contents) {
      const file = path.join(temp, "library", relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content, "utf8");
    }
    if (countLuaFiles(path.join(temp, "library")) < 10) {
      throw new Error("LuaCATS download was incomplete.");
    }
    fs.cpSync(path.join(temp, "library"), target, { recursive: true, force: true });
    fs.rmSync(temp, { recursive: true, force: true });
    return { path: target, source: "downloaded" };
  } catch (error) {
    console.warn(`[luacats] Download failed (${error.message}); using built-in definitions.`);
    fs.rmSync(temp, { recursive: true, force: true });
    fs.mkdirSync(target, { recursive: true });
    if (countLuaFiles(FALLBACK_DIR) > 0) {
      copyDir(FALLBACK_DIR, target);
    }
    return { path: target, source: "fallback" };
  }
}

/**
 * Copies the cached (or fallback) definitions into a project so .luarc.json
 * can use a portable, relative path.
 */
export async function installLuaCatsIntoProject(projectPath) {
  const { path: source, source: origin } = await ensureLuaCats();
  const target = path.join(projectPath, ".love2d-studio", "luacats", "love2d", "library");
  if (countLuaFiles(target) < 10) {
    copyDir(source, target);
  }
  return { path: target, source: origin };
}
