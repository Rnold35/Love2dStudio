import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from "electron";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";

const APP_NAME = "Love2D Studio";
const APP_ID = "com.love2dstudio.desktop";
const APP_ROOT = app.getAppPath();
const SERVER_ENTRY = path.join(APP_ROOT, "src", "studio", "server.js");
const PRELOAD_ENTRY = path.join(APP_ROOT, "desktop", "preload.cjs");
const ICON_ENTRY = path.join(APP_ROOT, "desktop", "icon.ico");
const GAME_PREVIEW_ENTRY = path.join(APP_ROOT, "desktop", "game-preview.ps1");

app.setName(APP_NAME);
app.setAppUserModelId(APP_ID);
app.setPath("userData", path.join(app.getPath("appData"), `${APP_NAME} Desktop`));

const cli = parseArgs(process.argv.slice(1));
console.log(`[desktop] argv=${JSON.stringify(process.argv.slice(1))}`);
let mainWindow = null;
let serverInfo = null;
let serverChild = null;
let ownsServer = false;
let quitting = false;
let startupNew = cli.newProject;
let previewHelper = null;
let previewHelperBuffer = "";
let previewPending = new Map();
let previewSequence = 0;
let previewMoveTimer = null;
let previewWindow = { hwnd: "", pid: 0, visible: false, bounds: null };

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", async (_event, argv) => {
    console.log(`[desktop] second-instance argv=${JSON.stringify(argv)}`);
    const next = parseArgs(argv.slice(1));
    if (next.project || next.newProject) {
      try {
        if (next.project) {
          await ensureServer();
          await openProject(next.project);
        }
        if (next.newProject) {
          await loadWindow(true);
        } else if (next.project) {
          await reloadWindow();
        }
      } catch (error) {
        dialog.showErrorBox(APP_NAME, error.message);
      }
    }
    focusWindow();
  });

  app.whenReady().then(start).catch((error) => {
    dialog.showErrorBox(APP_NAME, `Could not start Love2D Studio.\n\n${error.message}`);
    app.quit();
  });
}

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", () => {
  quitting = true;
  stopGamePreviewHelper();
  stopOwnedServer();
});

app.on("activate", () => {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

function parseArgs(argv) {
  let newProject = false;
  const candidates = [];

  const isExistingProjectDir = (candidate) => {
    if (!candidate || candidate.startsWith("-")) return false;
    try {
      const resolved = path.resolve(candidate);
      if (resolved === APP_ROOT) return false;
      return fs.statSync(resolved).isDirectory();
    } catch {
      return false;
    }
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--new") {
      newProject = true;
      continue;
    }
    if (arg === "--project" || arg === "-p") {
      const next = argv[index + 1];
      if (isExistingProjectDir(next)) {
        candidates.push(next);
        index += 1;
      }
      continue;
    }
    // Electron may reorder/add Chromium switches around custom arguments.
    // Accept an absolute existing directory as a project candidate as well.
    if (path.isAbsolute(arg) && isExistingProjectDir(arg)) {
      candidates.push(arg);
    }
  }

  return {
    project: candidates.length ? path.resolve(candidates[candidates.length - 1]) : "",
    newProject
  };
}

function runtimeFile() {
  const configDir = process.env.LOVE2D_STUDIO_CONFIG_DIR
    || path.join(app.getPath("appData"), APP_NAME);
  return path.join(configDir, "runtime.json");
}

function readRuntime() {
  try {
    return JSON.parse(fs.readFileSync(runtimeFile(), "utf8"));
  } catch {
    return null;
  }
}

async function healthCheck(info) {
  if (!info?.port || !info?.token) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1200);
  try {
    const response = await fetch(`http://127.0.0.1:${info.port}/api/health`, {
      headers: { "x-studio-token": info.token },
      signal: controller.signal
    });
    if (!response.ok) return null;
    const payload = await response.json();
    return payload?.app === "love2d-studio" ? payload : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function findHealthyServer() {
  const info = readRuntime();
  if (!info) return null;
  return (await healthCheck(info)) ? info : null;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function ensureServer() {
  if (serverInfo && (await healthCheck(serverInfo))) return serverInfo;

  const existing = await findHealthyServer();
  if (existing) {
    serverInfo = existing;
    ownsServer = false;
    if (cli.project) await openProject(cli.project);
    return serverInfo;
  }

  const args = [SERVER_ENTRY, "open", "--no-browser"];
  if (cli.project) args.push("--project", cli.project);
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
    LOVE2D_STUDIO_DESKTOP_EXE: process.execPath,
    LOVE2D_STUDIO_DESKTOP_PACKAGED: app.isPackaged ? "1" : "0",
    LOVE2D_STUDIO_DESKTOP_APP: APP_ROOT
  };
  const child = spawn(process.execPath, args, {
    cwd: APP_ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true
  });
  serverChild = child;
  ownsServer = true;
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", (chunk) => process.stdout.write(`[studio] ${chunk}`));
  child.stderr?.on("data", (chunk) => process.stderr.write(`[studio] ${chunk}`));
  child.on("error", (error) => {
    console.error(`[desktop] backend failed to start: ${error.message}`);
  });
  child.on("exit", (code, signal) => {
    if (quitting) return;
    if (ownsServer) {
      const message = `The Studio backend stopped unexpectedly (${signal || code}).`;
      console.error(`[desktop] ${message}`);
      dialog.showErrorBox(APP_NAME, message);
      app.quit();
    }
  });

  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const info = await findHealthyServer();
    if (info) {
      serverInfo = info;
      return info;
    }
    if (child.exitCode !== null) break;
    await delay(160);
  }
  throw new Error("The Studio backend did not start in time.");
}

function stopOwnedServer() {
  if (!ownsServer || !serverChild) return;
  try {
    const info = readRuntime();
    if (info && info.pid === serverChild.pid) fs.unlinkSync(runtimeFile());
  } catch {
    // A stale runtime file is harmless and will be replaced on next start.
  }
  try {
    if (process.platform === "win32" && serverChild.pid) {
      execFileSync("taskkill", ["/pid", String(serverChild.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
        timeout: 5000
      });
    } else {
      serverChild.kill("SIGTERM");
    }
  } catch {
    // The process may already be gone.
  }
  serverChild = null;
}

function windowStateFile() {
  return path.join(app.getPath("userData"), "window-state.json");
}

function readWindowBounds() {
  try {
    const parsed = JSON.parse(fs.readFileSync(windowStateFile(), "utf8"));
    if (Number.isFinite(parsed.width) && Number.isFinite(parsed.height)) {
      return parsed;
    }
  } catch {
    // First run.
  }
  return { width: 1440, height: 920 };
}

function saveWindowBounds() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const bounds = mainWindow.getBounds();
    fs.writeFileSync(windowStateFile(), JSON.stringify(bounds), "utf8");
  } catch {
    // Window state is convenient, not critical.
  }
}

function baseUrl() {
  return `http://127.0.0.1:${serverInfo.port}/`;
}

function createWindow() {
  const saved = readWindowBounds();
  mainWindow = new BrowserWindow({
    width: saved.width,
    height: saved.height,
    x: saved.x,
    y: saved.y,
    minWidth: 900,
    minHeight: 600,
    show: false,
    title: APP_NAME,
    backgroundColor: "#0b0c0f",
    icon: fs.existsSync(ICON_ENTRY) ? ICON_ENTRY : undefined,
    autoHideMenuBar: true,
    webPreferences: {
      preload: PRELOAD_ENTRY,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false
    }
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.on("close", () => saveWindowBounds());
  mainWindow.on("move", refreshEmbeddedPreviewPosition);
  mainWindow.on("restore", refreshEmbeddedPreviewPosition);
  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  const localOrigin = new URL(baseUrl()).origin;
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/i.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    try {
      if (new URL(url).origin !== localOrigin) {
        event.preventDefault();
        if (/^https?:/i.test(url)) shell.openExternal(url);
      }
    } catch {
      event.preventDefault();
    }
  });
  mainWindow.webContents.on("before-input-event", (event, input) => {
    if (!app.isPackaged && input.type === "keyDown" && input.key === "F12") {
      mainWindow.webContents.toggleDevTools();
    }
  });
  mainWindow.webContents.on("did-start-loading", hideEmbeddedPreview);
  mainWindow.webContents.on("did-fail-load", (_event, code, description) => {
    dialog.showErrorBox(APP_NAME, `Could not load the Studio UI (${code}: ${description}).`);
  });

  mainWindow.once("ready-to-show", () => {
    mainWindow.show();
    mainWindow.focus();
  });

  const query = startupNew ? "?new=1" : "";
  mainWindow.loadURL(`${baseUrl()}${query}`);
  startupNew = false;
  return mainWindow;
}

async function reloadWindow() {
  if (!mainWindow) return;
  await mainWindow.loadURL(baseUrl());
}

async function loadWindow(forceNew = false) {
  if (!mainWindow) return;
  const url = forceNew ? `${baseUrl()}?new=1` : baseUrl();
  await mainWindow.loadURL(url);
}

function focusWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

async function openProject(projectPath) {
  if (!serverInfo) return;
  const target = path.resolve(projectPath);
  const response = await fetch(`http://127.0.0.1:${serverInfo.port}/api/project/open`, {
    method: "POST",
    headers: {
      "x-studio-token": serverInfo.token,
      "content-type": "application/json"
    },
    body: JSON.stringify({ path: target })
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `Could not open project (${response.status}).`);
  }
}

function nativeWindowHandle() {
  if (!mainWindow || mainWindow.isDestroyed()) return "";
  try {
    const handle = mainWindow.getNativeWindowHandle();
    if (!handle || !handle.length) return "";
    return handle.length >= 8
      ? handle.readBigUInt64LE(0).toString()
      : String(handle.readUInt32LE(0));
  } catch {
    return "";
  }
}

function previewScale(value) {
  const scale = Number(value);
  return Number.isFinite(scale) && scale >= 0.5 && scale <= 4 ? scale : 1;
}

function previewBounds(value, scale) {
  const source = value && typeof value === "object" ? value : {};
  const numbers = ["x", "y", "width", "height"].map((key) => Number(source[key]));
  if (!numbers.every(Number.isFinite) || numbers[2] < 2 || numbers[3] < 2) {
    return null;
  }
  const factor = previewScale(scale);
  const box = {
    x: Math.round(numbers[0] * factor),
    y: Math.round(numbers[1] * factor),
    width: Math.max(1, Math.round(numbers[2] * factor)),
    height: Math.max(1, Math.round(numbers[3] * factor))
  };
  if (box.x < 0 || box.y < 0 || box.width > 20000 || box.height > 20000) return null;
  return box;
}

function rejectPreviewPending(message) {
  for (const pending of previewPending.values()) {
    clearTimeout(pending.timer);
    pending.reject(new Error(message));
  }
  previewPending.clear();
}

function handlePreviewOutput(chunk) {
  previewHelperBuffer += chunk;
  let newline;
  while ((newline = previewHelperBuffer.indexOf("\n")) >= 0) {
    const line = previewHelperBuffer.slice(0, newline).trim();
    previewHelperBuffer = previewHelperBuffer.slice(newline + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      console.log(`[preview] ${line}`);
      continue;
    }
    if (message.event === "ready") {
      console.log("[preview] native window helper ready");
      continue;
    }
    if (message.id && previewPending.has(message.id)) {
      const pending = previewPending.get(message.id);
      previewPending.delete(message.id);
      clearTimeout(pending.timer);
      pending.resolve(message);
      continue;
    }
    console.log(`[preview] ${line}`);
  }
}

function ensurePreviewHelper() {
  if (process.platform !== "win32") {
    throw new Error("Embedded game preview is only available on Windows.");
  }
  if (!fs.existsSync(GAME_PREVIEW_ENTRY)) {
    throw new Error("The game preview helper is missing.");
  }
  if (previewHelper && previewHelper.exitCode === null) return;
  const systemRoot = process.env.SystemRoot || "C:\\Windows";
  const powershell = path.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe"
  );
  const helper = spawn(
    fs.existsSync(powershell) ? powershell : "powershell.exe",
    ["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File", GAME_PREVIEW_ENTRY],
    {
      cwd: APP_ROOT,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"]
    }
  );
  previewHelper = helper;
  previewHelperBuffer = "";
  helper.stdout?.setEncoding("utf8");
  helper.stderr?.setEncoding("utf8");
  helper.stdout?.on("data", handlePreviewOutput);
  helper.stderr?.on("data", (chunk) => {
    const text = String(chunk).trim();
    if (text) console.error(`[preview] ${text}`);
  });
  helper.on("error", (cause) => {
    console.error(`[preview] helper failed: ${cause.message}`);
    rejectPreviewPending(cause.message);
  });
  helper.on("exit", (code, signal) => {
    if (!quitting) {
      console.error(`[preview] helper exited (${signal || code})`);
    }
    rejectPreviewPending("The embedded game preview stopped.");
    if (previewHelper === helper) previewHelper = null;
    previewWindow = { hwnd: "", pid: 0, visible: false };
  });
}

function sendPreviewCommand(command, timeoutMs = 15000) {
  ensurePreviewHelper();
  const id = String(++previewSequence);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      previewPending.delete(id);
      reject(new Error("The embedded game preview timed out."));
    }, timeoutMs);
    timer.unref?.();
    previewPending.set(id, { resolve, reject, timer });
    try {
      previewHelper.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
    } catch (cause) {
      clearTimeout(timer);
      previewPending.delete(id);
      reject(cause);
    }
  });
}

function stopGamePreviewHelper() {
  const helper = previewHelper;
  previewHelper = null;
  previewWindow = { hwnd: "", pid: 0, visible: false };
  rejectPreviewPending("The Studio is closing.");
  if (!helper) return;
  try {
    helper.stdin.write(`${JSON.stringify({ op: "quit" })}\n`);
  } catch {
    // The child may already be gone.
  }
  setTimeout(() => {
    try { helper.kill(); } catch {}
  }, 300).unref?.();
}

function hideEmbeddedPreview() {
  if (!previewWindow.hwnd || !previewHelper) return;
  sendPreviewCommand({ op: "visibility", visible: false }, 4000).catch(() => {});
  previewWindow.visible = false;
}

function refreshEmbeddedPreviewPosition() {
  if (!previewWindow.hwnd || !previewWindow.visible || !previewWindow.bounds || !previewHelper) return;
  if (previewMoveTimer) clearTimeout(previewMoveTimer);
  previewMoveTimer = setTimeout(() => {
    previewMoveTimer = null;
    sendPreviewCommand(
      { op: "bounds", ...previewWindow.bounds },
      5000
    ).catch(() => {});
  }, 40);
  previewMoveTimer.unref?.();
}

function registerIpc() {
  ipcMain.handle("desktop:select-directory", async (event, options = {}) => {
    if (!isTrustedSender(event)) return null;
    const parent = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(parent, {
      title: typeof options.title === "string" ? options.title : "Select a folder",
      defaultPath: typeof options.defaultPath === "string" && options.defaultPath
        ? options.defaultPath
        : undefined,
      properties: ["openDirectory", "createDirectory"]
    });
    return result.canceled ? null : result.filePaths[0] || null;
  });

  ipcMain.handle("desktop:select-file", async (event, options = {}) => {
    if (!isTrustedSender(event)) return null;
    const parent = BrowserWindow.fromWebContents(event.sender);
    const filters = Array.isArray(options.filters) ? options.filters : [];
    const result = await dialog.showOpenDialog(parent, {
      title: typeof options.title === "string" ? options.title : "Select a file",
      defaultPath: typeof options.defaultPath === "string" && options.defaultPath
        ? options.defaultPath
        : undefined,
      properties: ["openFile"],
      filters
    });
    return result.canceled ? null : result.filePaths[0] || null;
  });

  ipcMain.handle("desktop:info", (event) => {
    if (!isTrustedSender(event)) return null;
    return {
      version: app.getVersion(),
      platform: process.platform,
      packaged: app.isPackaged
    };
  });

  ipcMain.handle("desktop:game-preview-attach", async (event, options = {}) => {
    if (!isTrustedSender(event)) return { ok: false, error: "Untrusted Studio window." };
    if (process.platform !== "win32") {
      return { ok: false, error: "Embedded game preview is only available on Windows." };
    }
    if (!mainWindow || mainWindow.isDestroyed()) {
      return { ok: false, error: "The Studio window is not available." };
    }
    const pid = Math.trunc(Number(options.pid));
    const bounds = previewBounds(options.bounds, options.scale);
    const parentHwnd = nativeWindowHandle();
    if (!Number.isFinite(pid) || pid <= 0) {
      return { ok: false, error: "The game process is not available." };
    }
    if (!bounds) return { ok: false, error: "The game preview area is not ready." };
    if (!parentHwnd) return { ok: false, error: "Could not find the Studio window handle." };
    console.log(`[preview] attach request pid=${pid} bounds=${JSON.stringify(bounds)} parent=${parentHwnd}`);
    try {
      const result = await sendPreviewCommand({
        op: "attach",
        pid,
        parentHwnd,
        ...bounds
      }, 18000);
      if (!result.ok) {
        console.log(`[preview] attach failed: ${result.error || "unknown error"}`);
        return { ok: false, error: result.error || "Could not embed the game window." };
      }
      console.log(`[preview] attached pid=${pid} hwnd=${result.hwnd}`);
      previewWindow = {
        hwnd: String(result.hwnd || ""),
        pid,
        visible: true,
        bounds: { ...bounds }
      };
      return { ok: true, hwnd: previewWindow.hwnd, pid };
    } catch (cause) {
      return { ok: false, error: cause.message };
    }
  });

  ipcMain.handle("desktop:game-preview-bounds", async (event, options = {}) => {
    if (!isTrustedSender(event)) return { ok: false, error: "Untrusted Studio window." };
    if (!previewWindow.hwnd) return { ok: false, error: "No embedded game is active." };
    const bounds = previewBounds(options.bounds, options.scale);
    if (!bounds) return { ok: false, error: "Invalid game preview bounds." };
    previewWindow.bounds = { ...bounds };
    try {
      const result = await sendPreviewCommand({ op: "bounds", ...bounds }, 5000);
      return result.ok ? { ok: true } : { ok: false, error: result.error };
    } catch (cause) {
      return { ok: false, error: cause.message };
    }
  });

  ipcMain.handle("desktop:game-preview-visibility", async (event, options = {}) => {
    if (!isTrustedSender(event)) return { ok: false, error: "Untrusted Studio window." };
    if (!previewWindow.hwnd) return { ok: false, error: "No embedded game is active." };
    try {
      const result = await sendPreviewCommand({
        op: "visibility",
        visible: Boolean(options.visible)
      }, 5000);
      if (result.ok) previewWindow.visible = Boolean(options.visible);
      return result.ok ? { ok: true, visible: previewWindow.visible } : { ok: false, error: result.error };
    } catch (cause) {
      return { ok: false, error: cause.message };
    }
  });
}

function isTrustedSender(event) {
  try {
    const origin = new URL(event.senderFrame.url).origin;
    return serverInfo && origin === new URL(baseUrl()).origin;
  } catch {
    return false;
  }
}

function installMenu() {
  if (process.platform === "darwin") {
    Menu.setApplicationMenu(Menu.buildFromTemplate([
      { role: "appMenu" },
      { role: "editMenu" },
      { role: "viewMenu" },
      { role: "windowMenu" }
    ]));
  } else {
    Menu.setApplicationMenu(null);
  }
}

async function start() {
  registerIpc();
  installMenu();
  await ensureServer();
  createWindow();
}
