import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

function existing(candidate) {
  try {
    return candidate && fs.statSync(candidate).isFile() ? candidate : "";
  } catch {
    return "";
  }
}

function whereNode() {
  try {
    const output = execFileSync(
      process.platform === "win32" ? "where.exe" : "which",
      ["node"],
      { encoding: "utf8", windowsHide: true, timeout: 3000, stdio: ["ignore", "pipe", "ignore"] }
    );
    return output.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
  } catch {
    return "";
  }
}

/**
 * Returns a standalone Node executable suitable for Zed's agent_servers.
 * Inside Electron, process.execPath is Electron, which is not a Node CLI, so
 * prefer an installed node.exe.
 */
export function findNodeExecutable() {
  const fromEnv = process.env.LOVE2D_STUDIO_NODE || process.env.NODE_EXEC_PATH || "";
  if (fromEnv) {
    const found = existing(fromEnv);
    if (found) return found;
  }
  if (!process.versions.electron) {
    return process.execPath;
  }
  const fromPath = whereNode();
  if (fromPath) return fromPath;
  const candidates = [];
  if (process.platform === "win32") {
    const programFiles = process.env.ProgramFiles || "C:\\Program Files";
    const local = process.env.LOCALAPPDATA || "";
    candidates.push(path.join(programFiles, "nodejs", "node.exe"));
    candidates.push(path.join(local, "Programs", "nodejs", "node.exe"));
  }
  for (const candidate of candidates) {
    const found = existing(candidate);
    if (found) return found;
  }
  return "node";
}
