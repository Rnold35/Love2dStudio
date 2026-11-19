import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const APP_ROOT = path.resolve(HERE, "..", "..");

function existing(file) {
  try {
    return file && fs.statSync(file).isFile() ? file : "";
  } catch {
    return "";
  }
}

export function electronBinary() {
  if (process.platform === "win32") {
    return existing(path.join(APP_ROOT, "node_modules", "electron", "dist", "electron.exe"));
  }
  if (process.platform === "darwin") {
    return existing(path.join(
      APP_ROOT, "node_modules", "electron", "dist", "Electron.app",
      "Contents", "MacOS", "Electron"
    ));
  }
  return existing(path.join(APP_ROOT, "node_modules", "electron", "dist", "electron"));
}

/**
 * Information for generated Zed tasks. Returns the desktop executable and the
 * arguments that must precede --project/--new.
 */
export function desktopLaunchInfo() {
  const fromEnv = existing(process.env.LOVE2D_STUDIO_DESKTOP_EXE || "");
  if (fromEnv) {
    const packaged = process.env.LOVE2D_STUDIO_DESKTOP_PACKAGED === "1";
    return {
      command: fromEnv,
      prefixArgs: packaged ? [] : [APP_ROOT],
      packaged
    };
  }
  const electron = electronBinary();
  if (electron) {
    return {
      command: electron,
      prefixArgs: [APP_ROOT],
      packaged: false
    };
  }
  return null;
}
