#!/usr/bin/env node

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  APP_NAME,
  configDir,
  publicConfig,
  readConfig,
  runtimePath,
  writeConfig
} from "../shared/paths.js";
import { findLove, loveVersion } from "../shared/love.js";
import { resolveInside } from "../shared/fsx.js";
import { loadProjectIndex } from "../shared/project-context.js";
import { findZed, launchZed, zedSettingsExist } from "../shared/zed.js";
import { inspectZedSetup, installZedIntegration, zedIntegrationPreview } from "../shared/zed-setup.js";
import {
  TEMPLATES,
  createProject,
  openProject,
  projectInfo,
  revealInExplorer,
  saveConfigProjectsDir
} from "./projects.js";
import { createScene, deleteScene, loadScene, saveScene } from "./scenes.js";
import { assetFile, deleteAsset, importAsset, listAssets } from "./assets.js";
import { GameRunner } from "./runner.js";
import { StudioChat } from "./chat.js";
import { buildGame, buildInfo } from "./build.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(HERE, "public");
const VERSION = "0.1.0";
const DEFAULT_PORT = 4317;
const MAX_JSON_BODY = 4 * 1024 * 1024;
const MAX_UPLOAD = 41 * 1024 * 1024;

const state = {
  projectPath: "",
  project: null,
  port: 0,
  token: crypto.randomBytes(24).toString("hex"),
  startedAt: new Date().toISOString(),
  startupNotice: ""
};
const runner = new GameRunner();
const chat = new StudioChat({ getProjectPath: () => state.projectPath });
const buildState = {
  running: false,
  lastBuild: null
};

function parseArgs(argv) {
  const args = [...argv];
  let command = "open";
  if (args[0] && !args[0].startsWith("-")) {
    command = args.shift();
  }
  const options = {
    command,
    project: "",
    newProject: false,
    openBrowser: true,
    port: DEFAULT_PORT
  };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--project" || arg === "-p") {
      options.project = args[++i] || "";
    } else if (arg === "--new") {
      options.newProject = true;
    } else if (arg === "--open-browser") {
      options.openBrowser = true;
    } else if (arg === "--no-browser") {
      options.openBrowser = false;
    } else if (arg === "--port") {
      options.port = Math.max(1024, Math.min(65535, Number(args[++i]) || DEFAULT_PORT));
    } else if (arg === "--help" || arg === "-h") {
      console.log("Usage: node src/studio/server.js open [--project DIR] [--new] [--open-browser] [--port N]");
      process.exit(0);
    }
  }
  return options;
}

function browserUrl(port, search = "") {
  return `http://127.0.0.1:${port}/${search}`;
}

function openBrowser(url) {
  try {
    let command;
    let args;
    if (process.platform === "win32") {
      command = "cmd.exe";
      args = ["/c", "start", "", url];
    } else if (process.platform === "darwin") {
      command = "open";
      args = [url];
    } else {
      command = "xdg-open";
      args = [url];
    }
    const child = spawn(command, args, {
      detached: true,
      stdio: "ignore",
      windowsHide: true
    });
    child.on("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

function readRuntimeInfo() {
  try {
    return JSON.parse(fs.readFileSync(runtimePath(), "utf8"));
  } catch {
    return null;
  }
}

function writeRuntimeInfo() {
  fs.mkdirSync(configDir(), { recursive: true, mode: 0o700 });
  const file = runtimePath();
  fs.writeFileSync(file, `${JSON.stringify({
    version: 1,
    pid: process.pid,
    port: state.port,
    token: state.token,
    startedAt: state.startedAt
  }, null, 2)}\n`, { mode: 0o600 });
}

async function existingServer(info) {
  if (!info || !info.port || !info.token) return false;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1200);
  try {
    const response = await fetch(`http://127.0.0.1:${info.port}/api/health`, {
      headers: { "x-studio-token": info.token },
      signal: controller.signal
    });
    if (!response.ok) return false;
    const body = await response.json();
    return body?.app === "love2d-studio" ? body : false;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function forwardToExisting(info, options) {
  const base = `http://127.0.0.1:${info.port}`;
  const headers = {
    "x-studio-token": info.token,
    "content-type": "application/json"
  };
  if (!options.newProject && options.project) {
    try {
      const response = await fetch(`${base}/api/project/open`, {
        method: "POST",
        headers,
        body: JSON.stringify({ path: path.resolve(options.project) })
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        console.error(`[studio] ${payload.error || `Could not open project (${response.status})`}`);
        process.exitCode = 1;
      }
    } catch (error) {
      console.error(`[studio] ${error.message}`);
      process.exitCode = 1;
    }
  }
  if (options.openBrowser) {
    openBrowser(browserUrl(info.port, options.newProject ? "?new=1" : ""));
  }
  return { port: info.port };
}

function json(res, status, payload) {
  const body = `${JSON.stringify(payload)}\n`;
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body),
    "cache-control": "no-store",
    "x-content-type-options": "nosniff"
  });
  res.end(body);
}

function error(res, status, message) {
  json(res, status, { error: message });
}

function readBody(req, limit = MAX_JSON_BODY) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error("Request body is too large."));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function readJson(req, limit = MAX_JSON_BODY) {
  const body = await readBody(req, limit);
  if (!body.length) return {};
  try {
    return JSON.parse(body.toString("utf8"));
  } catch {
    throw new Error("Request body is not valid JSON.");
  }
}

function sameToken(value) {
  if (typeof value !== "string") return false;
  const a = Buffer.from(value);
  const b = Buffer.from(state.token);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function tokenFrom(req, url) {
  return req.headers["x-studio-token"] || url.searchParams.get("token") || "";
}

function checkToken(req, res, url) {
  if (sameToken(tokenFrom(req, url))) return true;
  error(res, 401, "Invalid Studio session token. Reload the page.");
  return false;
}

function requireProject() {
  if (!state.projectPath) throw new Error("Open a project first.");
  return state.projectPath;
}

function setupSnapshot() {
  const config = readConfig();
  const love = findLove({ console: true });
  const zed = inspectZedSetup();
  const deepseek = publicConfig(config).deepseek;
  return {
    love: {
      found: Boolean(love),
      path: love,
      version: love ? loveVersion(love) : "",
      configPath: config.lovePath
    },
    zed: {
      ...zed,
      executable: findZed(),
      settingsDirExists: zedSettingsExist(),
      preview: zedIntegrationPreview()
    },
    deepseek,
    configDir: configDir(),
    configFile: path.join(configDir(), "config.json"),
    projectsDir: config.projectsDir
  };
}

function studioState() {
  const config = readConfig();
  return {
    app: APP_NAME,
    version: VERSION,
    server: {
      port: state.port,
      startedAt: state.startedAt,
      notice: state.startupNotice
    },
    project: state.project,
    templates: TEMPLATES,
    setup: setupSnapshot(),
    recentProjects: config.recentProjects,
    run: runner.snapshot().status
  };
}

function projectScripts(projectPath) {
  const index = loadProjectIndex(projectPath);
  return index.files.map((file) => ({
    path: file.path,
    module: file.module,
    lines: file.lines,
    bytes: file.size,
    symbols: file.symbols.length,
    requires: file.requires
  }));
}

function projectScript(projectPath, requested) {
  const file = resolveInside(projectPath, requested);
  if (!file.toLowerCase().endsWith(".lua")) {
    throw new Error("Only Lua scripts can be opened in the Scripts view.");
  }
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    throw new Error(`Script not found: ${requested}`);
  }
  if (!stat.isFile()) throw new Error("The selected script path is not a file.");
  if (stat.size > 2_000_000) throw new Error("The selected script is too large to preview.");
  const relative = path.relative(projectPath, file).split(path.sep).join("/");
  const content = fs.readFileSync(file, "utf8");
  const index = loadProjectIndex(projectPath);
  const indexed = index.files.find((entry) => entry.path === relative);
  return {
    path: relative,
    module: indexed?.module || relative.replace(/\.lua$/i, "").replaceAll("/", "."),
    lines: content.split(/\r?\n/).length,
    content,
    symbols: indexed?.symbols.map((symbol) => ({
      name: symbol.name,
      kind: symbol.kind,
      line: symbol.line,
      signature: symbol.signature
    })) || []
  };
}

function invalidateProject() {
  runner.stop();
  chat.setProject("");
  buildState.lastBuild = null;
  state.projectPath = "";
  state.project = null;
}

async function setProject(project) {
  // Open first; if the folder is invalid, keep the current project untouched.
  const info = await openProject(project);
  invalidateProject();
  state.projectPath = info.path;
  state.project = projectInfo(info.path);
  chat.setProject(info.path);
  return state.project;
}

function mimeForStatic(file) {
  const ext = path.extname(file).toLowerCase();
  return {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".json": "application/json; charset=utf-8"
  }[ext] || "application/octet-stream";
}

function commonHeaders(res) {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader(
    "content-security-policy",
    "default-src 'self'; img-src 'self' data: blob:; media-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
  );
}

function servePage(res, file, { injectToken = false } = {}) {
  let body;
  try {
    body = fs.readFileSync(file);
  } catch {
    error(res, 404, "Not found.");
    return;
  }
  if (injectToken) {
    body = Buffer.from(
      body.toString("utf8")
        .replaceAll("__STUDIO_TOKEN__", state.token)
        .replaceAll("__STUDIO_VERSION__", VERSION),
      "utf8"
    );
  }
  commonHeaders(res);
  res.writeHead(200, {
    "content-type": mimeForStatic(file),
    "content-length": body.length,
    "cache-control": injectToken ? "no-store" : "no-cache"
  });
  res.end(body);
}

function serveFile(req, res, file, mime) {
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    error(res, 404, "Asset not found.");
    return;
  }
  commonHeaders(res);
  const range = req.headers.range;
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (match) {
      let start = match[1] === "" ? null : Number(match[1]);
      let end = match[2] === "" ? null : Number(match[2]);
      if (start === null && end !== null) {
        start = Math.max(0, stat.size - end);
        end = stat.size - 1;
      }
      start = Math.max(0, Math.min(start ?? 0, stat.size - 1));
      end = Math.max(start, Math.min(end ?? stat.size - 1, stat.size - 1));
      res.writeHead(206, {
        "content-type": mime,
        "content-length": end - start + 1,
        "content-range": `bytes ${start}-${end}/${stat.size}`,
        "accept-ranges": "bytes",
        "cache-control": "no-cache"
      });
      fs.createReadStream(file, { start, end }).pipe(res);
      return;
    }
  }
  res.writeHead(200, {
    "content-type": mime,
    "content-length": stat.size,
    "accept-ranges": "bytes",
    "cache-control": "no-cache"
  });
  fs.createReadStream(file).pipe(res);
}

async function handleApi(req, res, url) {
  const method = req.method || "GET";
  const pathname = url.pathname;

  if (pathname === "/api/health") {
    if (!checkToken(req, res, url)) return;
    json(res, 200, { ok: true, app: "love2d-studio", version: VERSION, pid: process.pid });
    return;
  }

  if (!checkToken(req, res, url)) return;

  if (method === "GET" && pathname === "/api/state") {
    json(res, 200, studioState());
    return;
  }

  if (method === "GET" && pathname === "/api/logs") {
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-store",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });
    const send = (event, data) => {
      if (res.writableEnded) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    send("snapshot", runner.snapshot());
    const unsubscribe = runner.subscribe((event) => send(event.type, event));
    const heartbeat = setInterval(() => {
      if (!res.writableEnded) res.write(": keepalive\n\n");
    }, 15000);
    req.on("close", () => {
      clearInterval(heartbeat);
      unsubscribe();
    });
    return;
  }

  if (method === "POST" && pathname === "/api/project/create") {
    const body = await readJson(req);
    invalidateProject();
    const created = await createProject({
      name: body.name,
      parentDir: body.parentDir,
      template: body.template,
      width: body.width,
      height: body.height
    });
    state.projectPath = created.path;
    state.project = projectInfo(created.path);
    chat.setProject(created.path);
    if (body.parentDir) saveConfigProjectsDir(path.resolve(body.parentDir));
    json(res, 200, { project: state.project, luaCatsSource: created.luaCatsSource });
    return;
  }

  if (method === "POST" && pathname === "/api/project/open") {
    const body = await readJson(req);
    if (!body.path) throw new Error("A project path is required.");
    const info = await setProject(body.path);
    json(res, 200, { project: info });
    return;
  }

  if (method === "POST" && pathname === "/api/project/reveal") {
    const projectPath = requireProject();
    revealInExplorer(projectPath);
    json(res, 200, { ok: true });
    return;
  }

  if (method === "POST" && pathname === "/api/open-zed") {
    const body = await readJson(req);
    const projectPath = state.projectPath;
    let target = projectPath || undefined;
    if (body.path) {
      if (!projectPath) throw new Error("Open a project first.");
      target = resolveInside(projectPath, body.path);
    }
    const pid = launchZed(target);
    json(res, 200, { ok: true, pid });
    return;
  }

  if (method === "GET" && pathname === "/api/scripts") {
    const projectPath = requireProject();
    json(res, 200, { scripts: projectScripts(projectPath) });
    return;
  }

  if (method === "GET" && pathname === "/api/script") {
    const projectPath = requireProject();
    const requested = String(url.searchParams.get("path") || "").trim();
    if (!requested) throw new Error("A script path is required.");
    json(res, 200, { script: projectScript(projectPath, requested) });
    return;
  }

  if (method === "GET" && pathname === "/api/scenes") {
    const projectPath = requireProject();
    json(res, 200, { scenes: projectInfo(projectPath).scenes });
    return;
  }

  if (method === "GET" && pathname === "/api/scene") {
    const projectPath = requireProject();
    json(res, 200, { scene: loadScene(projectPath, url.searchParams.get("name") || "main") });
    return;
  }

  if (method === "PUT" && pathname === "/api/scene") {
    const projectPath = requireProject();
    const body = await readJson(req);
    const scene = saveScene(
      projectPath,
      url.searchParams.get("name") || body.scene?.name || "main",
      body.scene
    );
    state.project = projectInfo(projectPath);
    json(res, 200, { scene });
    return;
  }

  if (method === "POST" && pathname === "/api/scenes") {
    const projectPath = requireProject();
    const body = await readJson(req);
    const scene = createScene(projectPath, {
      name: body.name,
      width: body.width,
      height: body.height
    });
    state.project = projectInfo(projectPath);
    json(res, 200, { scene });
    return;
  }

  if (method === "DELETE" && pathname === "/api/scene") {
    const projectPath = requireProject();
    const deleted = deleteScene(projectPath, url.searchParams.get("name") || "");
    state.project = projectInfo(projectPath);
    json(res, 200, deleted);
    return;
  }

  if (method === "GET" && pathname === "/api/assets") {
    const projectPath = requireProject();
    const assets = listAssets(projectPath).map((asset) => ({
      ...asset,
      url: `/asset?path=${encodeURIComponent(asset.path)}&token=${state.token}`
    }));
    json(res, 200, { assets });
    return;
  }

  if (method === "POST" && pathname === "/api/assets/import") {
    const projectPath = requireProject();
    const name = url.searchParams.get("name") || "asset.png";
    const data = await readBody(req, MAX_UPLOAD);
    const asset = importAsset(projectPath, name, data);
    json(res, 200, {
      asset: {
        ...asset,
        url: `/asset?path=${encodeURIComponent(asset.path)}&token=${state.token}`
      }
    });
    return;
  }

  if (method === "DELETE" && pathname === "/api/asset") {
    const projectPath = requireProject();
    const deleted = deleteAsset(projectPath, url.searchParams.get("path") || "");
    json(res, 200, deleted);
    return;
  }

  if (method === "GET" && pathname === "/api/build/info") {
    const projectPath = requireProject();
    json(res, 200, { build: buildInfo(projectPath) });
    return;
  }

  if (method === "POST" && pathname === "/api/build") {
    const projectPath = requireProject();
    if (buildState.running) {
      const busy = new Error("A build is already running. Wait for it to finish.");
      busy.statusCode = 409;
      throw busy;
    }
    const body = await readJson(req);
    buildState.running = true;
    try {
      const build = buildGame(projectPath, {
        format: body.format,
        outputDir: body.outputDir
      });
      buildState.lastBuild = build;
      json(res, 200, { build });
    } finally {
      buildState.running = false;
    }
    return;
  }

  if (method === "POST" && pathname === "/api/build/reveal") {
    const body = await readJson(req);
    const requested = String(body.path || "").trim();
    if (!requested) throw new Error("A build output path is required.");
    const resolved = path.resolve(requested);
    const last = buildState.lastBuild;
    const allowed = last && (
      path.resolve(last.outputDir) === resolved
      || last.artifacts.some((artifact) => path.resolve(artifact.path) === resolved)
    );
    if (!allowed) throw new Error("That folder is not part of the latest build.");
    let stat;
    try {
      stat = fs.statSync(resolved);
    } catch {
      throw new Error("The build output folder no longer exists.");
    }
    if (!stat.isDirectory() && !stat.isFile()) throw new Error("The build output cannot be opened.");
    revealInExplorer(resolved);
    json(res, 200, { ok: true });
    return;
  }

  if (method === "POST" && pathname === "/api/run") {
    const projectPath = requireProject();
    const love = findLove({ console: true });
    runner.start(projectPath, love);
    json(res, 200, {
      run: runner.snapshot().status || runner.snapshot(),
      window: projectInfo(projectPath).window
    });
    return;
  }

  if (method === "POST" && pathname === "/api/stop") {
    json(res, 200, runner.stop());
    return;
  }

  if (method === "GET" && pathname === "/api/run/status") {
    const snapshot = runner.snapshot();
    json(res, 200, { status: snapshot, logs: snapshot.logs });
    return;
  }

  if (method === "POST" && pathname === "/api/run/clear") {
    runner.clear();
    json(res, 200, { ok: true });
    return;
  }

  if (method === "GET" && pathname === "/api/chat/state") {
    json(res, 200, { chat: chat.state() });
    return;
  }

  if (method === "POST" && pathname === "/api/chat/send") {
    const body = await readJson(req);
    await chat.send(body.message, req, res);
    return;
  }

  if (method === "POST" && pathname === "/api/chat/permission") {
    const body = await readJson(req);
    json(res, 200, chat.decidePermission(body.requestId, body.decision));
    return;
  }

  if (method === "POST" && pathname === "/api/chat/answer") {
    const body = await readJson(req);
    json(res, 200, chat.answerQuestion(body.requestId, body.optionIndex));
    return;
  }

  if (method === "POST" && pathname === "/api/chat/cancel") {
    chat.cancel("Cancelled by the user.");
    json(res, 200, { ok: true });
    return;
  }

  if (method === "POST" && pathname === "/api/chat/reset") {
    json(res, 200, { chat: chat.reset() });
    return;
  }

  if (method === "GET" && pathname === "/api/setup") {
    json(res, 200, { setup: setupSnapshot() });
    return;
  }

  if (method === "POST" && pathname === "/api/setup") {
    const body = await readJson(req);
    const config = readConfig();
    if (typeof body.apiKey === "string") {
      config.deepseek.apiKey = body.apiKey.trim();
    }
    if (typeof body.model === "string" && body.model.trim()) {
      config.deepseek.model = body.model.trim();
    }
    if (typeof body.baseUrl === "string" && body.baseUrl.trim()) {
      let endpoint;
      try {
        endpoint = new URL(body.baseUrl.trim());
      } catch {
        throw new Error("DeepSeek base URL is not a valid URL.");
      }
      if (!["http:", "https:"].includes(endpoint.protocol)) {
        throw new Error("DeepSeek base URL must use http or https.");
      }
      config.deepseek.baseUrl = endpoint.toString().replace(/\/+$/, "");
    }
    if (typeof body.lovePath === "string") {
      const lovePath = body.lovePath.trim();
      if (lovePath && !fs.existsSync(lovePath)) {
        throw new Error(`LÖVE executable not found at ${lovePath}`);
      }
      config.lovePath = lovePath;
    }
    if (typeof body.zedPath === "string") {
      const zedPath = body.zedPath.trim();
      if (zedPath && !fs.existsSync(zedPath)) {
        throw new Error(`Zed executable not found at ${zedPath}`);
      }
      config.zedPath = zedPath;
    }
    if (typeof body.projectsDir === "string" && body.projectsDir.trim()) {
      config.projectsDir = path.resolve(body.projectsDir.trim());
      fs.mkdirSync(config.projectsDir, { recursive: true });
    }
    writeConfig(config);
    json(res, 200, { setup: setupSnapshot() });
    return;
  }

  if (method === "POST" && pathname === "/api/setup/zed") {
    const result = installZedIntegration();
    json(res, 200, {
      result: {
        ...result,
        agentEntry: undefined
      },
      setup: setupSnapshot()
    });
    return;
  }

  error(res, 404, `Unknown API endpoint: ${method} ${pathname}`);
}

async function handleRequest(req, res) {
  const url = new URL(req.url || "/", "http://127.0.0.1");
  const pathname = decodeURIComponent(url.pathname);

  if (pathname.startsWith("/api/")) {
    try {
      await handleApi(req, res, url);
    } catch (cause) {
      console.error(`[studio] ${req.method} ${pathname}: ${cause.stack || cause.message}`);
      if (!res.headersSent) error(res, cause.statusCode || 400, cause.message || "Request failed.");
      else if (!res.writableEnded) res.end();
    }
    return;
  }

  if (req.method === "GET" && pathname === "/asset") {
    if (!sameToken(url.searchParams.get("token") || "")) {
      error(res, 401, "Invalid Studio session token.");
      return;
    }
    if (!state.projectPath) {
      error(res, 404, "No project is open.");
      return;
    }
    try {
      const { file, mime } = assetFile(state.projectPath, url.searchParams.get("path") || "");
      serveFile(req, res, file, mime);
    } catch (cause) {
      error(res, 404, cause.message);
    }
    return;
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    error(res, 405, "Method not allowed.");
    return;
  }

  if (pathname === "/" || pathname === "/index.html") {
    servePage(res, path.join(PUBLIC_DIR, "index.html"), { injectToken: true });
    return;
  }
  if (pathname === "/app.js") {
    servePage(res, path.join(PUBLIC_DIR, "app.js"));
    return;
  }
  if (pathname === "/chat.js") {
    servePage(res, path.join(PUBLIC_DIR, "chat.js"));
    return;
  }
  if (pathname === "/styles.css") {
    servePage(res, path.join(PUBLIC_DIR, "styles.css"));
    return;
  }
  if (pathname === "/favicon.svg") {
    servePage(res, path.join(PUBLIC_DIR, "favicon.svg"));
    return;
  }
  error(res, 404, "Not found.");
}

function listen(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      handleRequest(req, res).catch((cause) => {
        console.error(`[studio] Unhandled request error: ${cause.stack || cause.message}`);
        if (!res.headersSent) error(res, 500, "Internal server error.");
        else res.end();
      });
    });
    server.on("error", (cause) => {
      if (cause.code === "EADDRINUSE" && port < DEFAULT_PORT + 20) {
        resolve(listen(port + 1));
      } else {
        reject(cause);
      }
    });
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function cleanup() {
  chat.cancel("Server shutting down.");
  runner.shutdown();
  try {
    const info = readRuntimeInfo();
    if (info?.pid === process.pid) fs.unlinkSync(runtimePath());
  } catch {
    // Ignore cleanup races.
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const runtime = readRuntimeInfo();
  const existing = await existingServer(runtime);
  if (existing) {
    await forwardToExisting(runtime, options);
    return;
  }
  if (runtime) {
    try { fs.unlinkSync(runtimePath()); } catch {}
  }

  if (options.project) {
    try {
      await setProject(options.project);
    } catch (cause) {
      state.startupNotice = cause.message;
      console.error(`[studio] Could not open project: ${cause.message}`);
    }
  }

  const server = await listen(options.port);
  state.port = server.address().port;
  writeRuntimeInfo();
  console.log(`\n  ${APP_NAME} ${VERSION}`);
  console.log(`  Studio:  ${browserUrl(state.port)}`);
  if (state.project) console.log(`  Project: ${state.project.path}`);
  console.log("  Keep this terminal open. Ctrl+C stops the Studio.\n");
  if (state.startupNotice) console.log(`  Note: ${state.startupNotice}\n`);

  if (options.openBrowser) {
    openBrowser(browserUrl(state.port, options.newProject ? "?new=1" : ""));
  }

  process.on("SIGINT", () => {
    cleanup();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
  process.on("SIGTERM", () => {
    cleanup();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
  process.on("exit", cleanup);
}

main().catch((cause) => {
  console.error(`[studio] ${cause.stack || cause.message}`);
  process.exit(1);
});
