import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { readConfig } from "./paths.js";

function existingFile(candidate) {
  try {
    return candidate && fs.statSync(candidate).isFile() ? candidate : "";
  } catch {
    return "";
  }
}

function which(command) {
  try {
    const tool = process.platform === "win32" ? "where.exe" : "which";
    const output = execFileSync(tool, [command], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 3000,
      stdio: ["ignore", "pipe", "ignore"]
    });
    return output.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
  } catch {
    return "";
  }
}

function loveCandidates() {
  const candidates = [];
  const fromEnv = process.env.LOVE2D_PATH || process.env.LOVE_PATH || "";
  if (fromEnv) candidates.push(fromEnv);
  const config = readConfig();
  if (config.lovePath) candidates.push(config.lovePath);

  if (process.platform === "win32") {
    const programFiles = process.env.ProgramFiles || "C:\\Program Files";
    const programFilesX86 = process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)";
    const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
    for (const base of [programFiles, programFilesX86, local]) {
      candidates.push(path.join(base, "LOVE", "lovec.exe"));
      candidates.push(path.join(base, "LOVE", "love.exe"));
      candidates.push(path.join(base, "Programs", "LOVE", "lovec.exe"));
      candidates.push(path.join(base, "Programs", "LOVE", "love.exe"));
    }
    for (const name of ["lovec.exe", "love.exe"]) {
      const found = which(name);
      if (found) candidates.push(found);
    }
  } else if (process.platform === "darwin") {
    candidates.push("/Applications/love.app/Contents/MacOS/love");
    const found = which("love");
    if (found) candidates.push(found);
  } else {
    for (const name of ["love", "lovec"]) {
      const found = which(name);
      if (found) candidates.push(found);
    }
  }
  return candidates;
}

/**
 * Finds the LÖVE runtime. Prefers the console binary (lovec.exe) so game
 * output can be captured for the Studio console and the AI agent.
 */
export function findLove({ console = true } = {}) {
  const candidates = loveCandidates();
  const expanded = [];
  for (const candidate of candidates) {
    if (!candidate) continue;
    expanded.push(candidate);
    if (console && process.platform === "win32" && /love\.exe$/i.test(candidate)) {
      expanded.push(path.join(path.dirname(candidate), "lovec.exe"));
    }
  }
  for (const candidate of expanded) {
    const found = existingFile(candidate);
    if (!found) continue;
    if (!console && /lovec\.exe$/i.test(found)) {
      const gui = path.join(path.dirname(found), "love.exe");
      if (existingFile(gui)) return gui;
    }
    return found;
  }
  return "";
}

export function loveVersion(lovePath) {
  if (!lovePath) return "";
  try {
    const output = execFileSync(lovePath, ["--version"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
      stdio: ["ignore", "pipe", "pipe"]
    });
    return output.trim().split(/\r?\n/).pop() || "";
  } catch (error) {
    const stdout = error.stdout?.toString().trim();
    return stdout || "";
  }
}

export function spawnLove(lovePath, args, options = {}) {
  const child = spawn(lovePath, args, {
    cwd: options.cwd,
    env: { ...process.env, ...(options.env || {}) },
    // Do not start the game with STARTF_USESHOWWINDOW/SW_HIDE. That also
    // hides LÖVE's SDL window, which prevents the in-editor preview from
    // rendering after the window is embedded.
    windowsHide: false,
    stdio: ["ignore", "pipe", "pipe"]
  });
  return child;
}

export function killProcessTree(child) {
  if (!child || child.exitCode !== null || child.killed) return;
  if (process.platform === "win32" && child.pid) {
    try {
      execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
        timeout: 5000
      });
      return;
    } catch {
      // Fall through to child.kill.
    }
  }
  try {
    child.kill("SIGTERM");
  } catch {
    // Ignore.
  }
}
