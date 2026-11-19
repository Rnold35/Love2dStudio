import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { readConfig } from "./paths.js";

function existsDir(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
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

export function zedConfigDir() {
  if (process.env.ZED_CONFIG_DIR) return path.resolve(process.env.ZED_CONFIG_DIR);
  if (process.platform === "win32") {
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Zed");
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), ".config", "zed");
  }
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "zed");
}

export function zedSettingsPath() {
  return path.join(zedConfigDir(), "settings.json");
}

export function zedSnippetsDir() {
  return path.join(zedConfigDir(), "snippets");
}

export function findZed() {
  const config = readConfig();
  const candidates = [];
  if (process.env.ZED_PATH) candidates.push(process.env.ZED_PATH);
  if (config.zedPath) candidates.push(config.zedPath);
  const found = which(process.platform === "win32" ? "zed.exe" : "zed");
  if (found) candidates.push(found);

  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";
  if (process.platform === "win32") {
    candidates.push(path.join(local, "Programs", "Zed", "zed.exe"));
    candidates.push(path.join(local, "Zed", "zed.exe"));
    candidates.push(path.join(programFiles, "Zed", "zed.exe"));
    candidates.push(path.join(process.env.LOCALAPPDATA || "", "Microsoft", "WinGet", "Links", "zed.exe"));
  } else if (process.platform === "darwin") {
    candidates.push("/Applications/Zed.app/Contents/MacOS/zed");
  }

  for (const candidate of candidates) {
    try {
      if (candidate && fs.statSync(candidate).isFile()) return candidate;
    } catch {
      // Continue.
    }
  }
  return "";
}

export function zedSettingsExist() {
  return existsDir(zedConfigDir());
}

export function summariseZed() {
  const executable = findZed();
  return {
    installed: Boolean(executable),
    executable,
    configDir: zedConfigDir(),
    settingsPath: zedSettingsPath(),
    configExists: fs.existsSync(zedSettingsPath())
  };
}

/** Launch Zed at a project path without waiting for it to exit. */
export function launchZed(projectPath) {
  const executable = findZed();
  if (!executable) {
    throw new Error("Zed is not installed or could not be found.");
  }
  const args = projectPath ? [projectPath] : [];
  const child = spawn(executable, args, {
    windowsHide: false,
    stdio: "ignore",
    detached: true
  });
  child.unref();
  return child.pid || 0;
}
