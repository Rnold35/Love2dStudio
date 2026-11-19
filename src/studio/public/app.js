import { initDesktopChat } from "/chat.js";

const token = document.querySelector('meta[name="studio-token"]').content;
const version = document.querySelector('meta[name="studio-version"]').content;
const desktop = window.love2dDesktop?.isDesktop ? window.love2dDesktop : null;
let chatUi = null;

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
const el = (id) => document.getElementById(id);

const SNAP = 8;
const MAX_HISTORY = 60;

const state = {
  server: null,
  project: null,
  setup: {},
  templates: [],
  recent: [],
  mode: "scenes",
  scene: null,
  sceneName: "",
  scenes: [],
  selectedId: null,
  assets: [],
  assetFilter: "",
  selectedAsset: null,
  scripts: [],
  scriptsLoaded: false,
  scriptFilter: "",
  selectedScript: "",
  scriptData: null,
  scriptLoading: false,
  tool: "select",
  selectedTemplate: "starter",
  zoom: 1,
  fitZoom: 1,
  panX: 0,
  panY: 0,
  viewScene: "",
  canvasW: 0,
  canvasH: 0,
  showGrid: true,
  snap: SNAP,
  dirty: false,
  saving: false,
  saveTimer: null,
  saveInFlight: null,
  saveAgain: false,
  undo: [],
  redo: [],
  fieldSnapshot: null,
  drag: null,
  draft: null,
  running: false,
  run: {},
  logs: [],
  consoleCollapsed: false,
  sse: null,
  images: new Map(),
  audio: null,
  audioPath: "",
  booted: false,
  loadingProject: false,
  loadedProjectPath: "",
  lastNotice: "",
  queryHandled: false,
  lastHealthState: null,
  buildFormat: "windows-zip",
  buildOutputDir: "",
  buildInfo: null,
  lastBuild: null,
  preview: {
    active: false,
    attaching: false,
    embedded: false,
    hiddenForOverlay: false,
    pid: 0,
    aspect: 0,
    designWidth: 0,
    designHeight: 0
  },
  previewObserver: null,
  previewBoundsTimer: 0
};

let canvas;
let ctx;
let renderQueued = false;
let rafHandle = 0;
let resizeObserver;
let saveTimer = 0;
let attachmentTimer = 0;
let scriptLoadId = 0;
let lastPointerWorld = null;

/* -------------------------------------------------------------------------
   Utilities
   ------------------------------------------------------------------------- */

function icon(name, className = "icon") {
  return `<svg class="${className}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeAttr(value) {
  return escapeHtml(value);
}

function browseButton(action, label = "Browse") {
  if (!desktop) return "";
  return `<button class="btn btn-small btn-secondary browse-btn" type="button" data-action="${escapeAttr(action)}">${icon("folder", "icon small")} ${escapeHtml(label)}</button>`;
}

async function chooseDirectoryFor(inputId, title) {
  if (!desktop) return;
  const input = el(inputId);
  const chosen = await desktop.selectDirectory({
    title,
    defaultPath: input?.value || undefined
  });
  if (chosen && input) {
    input.value = chosen;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

async function chooseLoveExecutable() {
  if (!desktop) return;
  const input = el("setup-love-path");
  const chosen = await desktop.selectFile({
    title: "Select love.exe or lovec.exe",
    defaultPath: input?.value || undefined,
    filters: [
      { name: "LÖVE executable", extensions: ["exe"] },
      { name: "All files", extensions: ["*"] }
    ]
  });
  if (chosen && input) {
    input.value = chosen;
    input.dispatchEvent(new Event("change", { bubbles: true }));
  }
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function deepClone(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function rgba(color, extraAlpha = 1) {
  const c = Array.isArray(color) ? color : [1, 1, 1, 1];
  const convert = (value) => Math.round(clamp(Number(value) || 0, 0, 1) * 255);
  const alpha = clamp((c[3] === undefined ? 1 : Number(c[3])) * extraAlpha, 0, 1);
  return `rgba(${convert(c[0])}, ${convert(c[1])}, ${convert(c[2])}, ${alpha})`;
}

function rgbToHex(color) {
  const convert = (value) => Math.round(clamp(Number(value) || 0, 0, 1) * 255)
    .toString(16)
    .padStart(2, "0");
  return `#${convert(color?.[0])}${convert(color?.[1])}${convert(color?.[2])}`;
}

function hexToRgb(hex) {
  const value = String(hex || "").replace("#", "");
  if (!/^[0-9a-f]{6}$/i.test(value)) return null;
  return [
    parseInt(value.slice(0, 2), 16) / 255,
    parseInt(value.slice(2, 4), 16) / 255,
    parseInt(value.slice(4, 6), 16) / 255
  ];
}

function formNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function timeLabel(iso) {
  try {
    return new Date(iso).toLocaleTimeString([], { hour12: false });
  } catch {
    return "";
  }
}

function newEntityId() {
  return `ent_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
}

function sceneEntities() {
  return Array.isArray(state.scene?.entities) ? state.scene.entities : [];
}

function selectedEntity() {
  return sceneEntities().find((entity) => entity.id === state.selectedId) || null;
}

function sortedEntities() {
  return [...sceneEntities()].sort((a, b) => {
    const layer = (a.layer || 0) - (b.layer || 0);
    if (layer !== 0) return layer;
    return String(a.id).localeCompare(String(b.id));
  });
}

function sceneDisplayName(name) {
  return String(name || "scene").replace(/\.json$/i, "");
}

function sceneById(name) {
  return state.scenes.find((scene) => scene.name === sceneDisplayName(name)) || null;
}

function setButtonBusy(button, busy, label) {
  if (!button) return;
  if (busy) {
    if (!button.dataset.originalLabel) {
      button.dataset.originalLabel = button.innerHTML;
    }
    button.disabled = true;
    button.textContent = label || "Working…";
  } else {
    button.disabled = false;
    if (button.dataset.originalLabel) {
      button.innerHTML = button.dataset.originalLabel;
      delete button.dataset.originalLabel;
    }
  }
}

function toast(message, type = "success", timeout = 3600) {
  const stack = el("toast-stack");
  if (!stack) return;
  const node = document.createElement("div");
  node.className = `toast ${type}`;
  const iconName = type === "error" ? "alert" : type === "warn" ? "alert" : "check";
  node.innerHTML = `${icon(iconName)}<div>${escapeHtml(message)}</div>`;
  stack.append(node);
  setTimeout(() => {
    node.style.opacity = "0";
    node.style.transform = "translateY(4px)";
    node.style.transition = "opacity 160ms, transform 160ms";
    setTimeout(() => node.remove(), 180);
  }, timeout);
}

/* -------------------------------------------------------------------------
   API + SSE
   ------------------------------------------------------------------------- */

async function api(path, options = {}) {
  const headers = {
    "x-studio-token": token,
    ...(options.headers || {})
  };
  let body = options.body;
  if (body && typeof body === "object" && !(body instanceof Blob) && !(body instanceof ArrayBuffer)
    && !(body instanceof Uint8Array)) {
    body = JSON.stringify(body);
    headers["content-type"] = "application/json";
  }
  const response = await fetch(path, { ...options, headers, body });
  const text = await response.text();
  let data = {};
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = {};
    }
  }
  if (!response.ok) {
    throw new Error(data.error || `Request failed (${response.status}).`);
  }
  return data;
}

function connectSSE() {
  if (state.sse) state.sse.close();
  const source = new EventSource(`/api/logs?token=${encodeURIComponent(token)}`);
  state.sse = source;

  source.addEventListener("snapshot", (event) => {
    try {
      const snapshot = JSON.parse(event.data);
      state.logs = Array.isArray(snapshot.logs) ? snapshot.logs : [];
      state.running = Boolean(snapshot.running);
      state.run = snapshot;
      if (!state.running) leaveGamePreview();
      renderLogs();
      renderRunUI();
    } catch {
      // Ignore a malformed snapshot.
    }
  });

  source.addEventListener("log", (event) => {
    try {
      const payload = JSON.parse(event.data);
      if (payload.entry) appendLog(payload.entry);
    } catch {
      // Ignore.
    }
  });

  source.addEventListener("status", (event) => {
    try {
      const payload = JSON.parse(event.data);
      const wasRunning = state.running;
      state.run = payload.status || {};
      state.running = Boolean(state.run.running);
      if (!state.running) leaveGamePreview();
      renderRunUI();
      if (wasRunning && !state.running) {
        const code = state.run.exitCode;
        if (code !== 0 && code !== null) {
          toast(`The game exited with code ${code}. See the console for details.`, "error", 5200);
        }
      }
    } catch {
      // Ignore.
    }
  });

  source.addEventListener("clear", () => {
    state.logs = [];
    renderLogs();
  });

  source.onerror = () => {
    renderRunUI();
  };
}

/* -------------------------------------------------------------------------
   State loading
   ------------------------------------------------------------------------- */

function applyTopState(data) {
  state.server = data.server || state.server;
  state.setup = data.setup || state.setup;
  state.templates = data.templates || state.templates;
  state.recent = data.recentProjects || state.recent;
  state.run = data.run || state.run;
  state.running = Boolean(state.run?.running);
  state.project = data.project || null;
  if (state.project) {
    state.scenes = Array.isArray(state.project.scenes) ? state.project.scenes : [];
  } else {
    state.scenes = [];
  }
}

async function loadInitial() {
  try {
    const data = await api("/api/state");
    applyTopState(data);
    state.booted = true;
    if (data.server?.notice) {
      state.lastNotice = data.server.notice;
      toast(data.server.notice, "warn", 6000);
    }
    if (state.project) {
      await hydrateProject(state.project, { fit: true });
    } else {
      renderAll();
    }
    handleInitialQuery();
  } catch (error) {
    state.booted = true;
    renderAll();
    toast(error.message, "error", 8000);
  }
}

function handleInitialQuery() {
  if (state.queryHandled) return;
  state.queryHandled = true;
  const params = new URLSearchParams(window.location.search);
  if (params.get("new") === "1" || params.get("new") === "true") {
    openNewProjectModal();
  }
}

async function hydrateProject(project, { fit = false } = {}) {
  state.loadingProject = true;
  const changedProject = state.loadedProjectPath !== project.path;
  if (changedProject) {
    if (state.preview.active) leaveGamePreview();
    state.images.clear();
    state.selectedAsset = null;
    state.tool = "select";
    state.mode = "scenes";
    state.scripts = [];
    state.scriptsLoaded = false;
    state.scriptFilter = "";
    state.selectedScript = "";
    state.scriptData = null;
    state.fieldSnapshot = null;
    state.buildOutputDir = "";
    state.buildInfo = null;
    state.lastBuild = null;
    if (state.audio) {
      state.audio.pause();
      state.audio = null;
      state.audioPath = "";
    }
  }
  state.loadedProjectPath = project.path;
  state.project = project;
  state.scenes = Array.isArray(project.scenes) ? project.scenes : [];
  try {
    const assets = await api("/api/assets");
    state.assets = assets.assets || [];
  } catch {
    state.assets = [];
  }

  const names = state.scenes.map((scene) => scene.name);
  let lastName = "";
  try {
    lastName = localStorage.getItem(`love2d-studio:scene:${project.path}`) || "";
  } catch {
    lastName = "";
  }
  const target = names.includes(state.sceneName)
    ? state.sceneName
    : names.includes(lastName)
      ? lastName
      : names[0] || "";

  if (target) {
    await loadScene(target, { fit: fit || true, silent: true });
  } else {
    state.scene = null;
    state.sceneName = "";
  }
  state.loadingProject = false;
  renderAll();
  if (changedProject) chatUi?.onProjectChanged();
  if (fit) requestAnimationFrame(() => fitScene());
}

async function refreshAll({ fit = false, resetLogs = false } = {}) {
  const data = await api("/api/state");
  const previousProject = state.project?.path;
  applyTopState(data);
  if (resetLogs || previousProject !== state.project?.path) {
    state.logs = [];
    state.sceneName = "";
    renderLogs();
  }
  if (state.project) {
    await hydrateProject(state.project, { fit });
  } else {
    state.scene = null;
    state.sceneName = "";
    state.assets = [];
    renderAll();
  }
}

async function refreshSetup() {
  try {
    const data = await api("/api/setup");
    state.setup = data.setup;
    renderAll();
    return state.setup;
  } catch (error) {
    toast(error.message, "error");
    return state.setup;
  }
}

/* -------------------------------------------------------------------------
   Rendering — shell, welcome, sidebar
   ------------------------------------------------------------------------- */

function renderAll() {
  el("app").classList.toggle("is-welcome", !state.project);
  document.title = state.project ? `${state.project.name} — Love2D Studio` : "Love2D Studio";

  const switcherText = el("project-switcher-text");
  const orderButton = el("project-switcher");
  if (state.project) {
    switcherText.textContent = state.project.name;
    orderButton.title = `${state.project.path} — click to switch project`;
  } else {
    switcherText.textContent = "No project open";
    orderButton.title = "Open a project";
  }
  el("project-dot").classList.toggle("is-live", state.running);

  renderSaveStatus();
  renderSidebar();
  renderSceneToolbar();
  renderInspector();
  renderRunUI();
  renderConsoleFrame();

  if (state.project) {
    el("welcome").hidden = true;
    el("sidebar").hidden = false;
    el("rail").hidden = false;
    el("rail-console").disabled = false;
    renderCanvas();
  } else {
    el("welcome").hidden = false;
    el("sidebar").hidden = true;
    el("rail").hidden = true;
    renderWelcome();
  }
  renderGamePreview();
  renderScriptView();
  renderStageFrame();

  $$(".rail-btn[data-mode]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.mode === state.mode);
  });

  const zedButton = el("btn-zed");
  zedButton.disabled = !state.project;
  zedButton.title = state.setup?.zed?.installed
    ? "Open this project in Zed"
    : "Zed is not installed — open Setup";

  const buildButton = el("btn-build");
  buildButton.disabled = !state.project;
  buildButton.title = state.project
    ? "Build and export this game"
    : "Open a project to build";

  if (state.project && state.scene && state.viewScene !== state.sceneName) {
    requestAnimationFrame(() => fitScene());
  }
}

function renderSaveStatus() {
  const wrapper = el("save-status");
  const label = el("save-status-text");
  if (!state.project) {
    wrapper.dataset.state = "saved";
    label.textContent = "Ready";
    return;
  }
  if (state.saving) {
    wrapper.dataset.state = "saving";
    label.textContent = "Saving…";
  } else if (state.dirty) {
    wrapper.dataset.state = "dirty";
    label.textContent = "Unsaved";
  } else {
    wrapper.dataset.state = "saved";
    label.textContent = "Saved";
  }
}

function renderWelcome() {
  const welcome = el("welcome");
  const setup = state.setup || {};
  const loveReady = Boolean(setup.love?.found);
  const zedReady = Boolean(setup.zed?.installed);
  const keyReady = Boolean(setup.deepseek?.configured);
  const agentReady = Boolean(setup.zed?.configured);

  const health = [
    {
      label: "LÖVE runtime",
      ok: loveReady,
      detail: loveReady ? setup.love.version || "Ready" : "Not found"
    },
    {
      label: "Zed editor",
      ok: zedReady,
      detail: zedReady ? "Installed" : "Not found"
    },
    {
      label: "DeepSeek API key",
      ok: keyReady,
      detail: keyReady ? setup.deepseek.model || "Configured" : "Add a key in Setup"
    },
    {
      label: "Love2D Assistant",
      ok: agentReady,
      detail: agentReady ? "Registered with Zed" : "Install in Setup"
    }
  ];

  const recentRows = state.recent.length
    ? state.recent.slice(0, 5).map((project) => `
        <button class="recent-row" type="button" data-action="open-recent" data-path="${escapeAttr(project.path)}">
          <span class="recent-icon">${icon("folder")}</span>
          <span class="recent-body">
            <span class="recent-name">${escapeHtml(project.name || project.path)}</span>
            <span class="recent-path">${escapeHtml(project.path)}</span>
          </span>
          ${icon("chevron", "icon small")}
        </button>
      `).join("")
    : `<div class="recent-empty">No projects yet. Your recent projects will appear here.</div>`;

  const notice = state.lastNotice
    ? `<div class="setup-warning">${icon("alert")}<span>${escapeHtml(state.lastNotice)}</span></div>`
    : "";

  welcome.innerHTML = `
    <div class="welcome-inner">
      <div class="welcome-hero">
        <div>
          <div class="eyebrow">${icon("heart")} LÖVE 11.5 + Zed</div>
          <h1>Make something<br><em>lovely.</em></h1>
          <p class="welcome-lede">
            A visual level editor, asset browser, and live console for Love2D —
            with a built-in <strong>DeepSeek assistant</strong> and a
            <strong>Love2D Assistant</strong> in Zed.
          </p>
          <div class="welcome-actions">
            <button class="btn btn-primary" type="button" data-action="new-project">
              ${icon("plus")} New project
            </button>
            <button class="btn btn-secondary" type="button" data-action="open-project">
              ${icon("folder")} Open a project
            </button>
            <button class="btn btn-ghost" type="button" data-action="open-setup">
              ${icon("settings")} Setup
            </button>
          </div>
          <div class="quick-steps">
            <span><span class="step-num">1</span> Create a project</span>
            <span><span class="step-num">2</span> Design the scene</span>
            <span><span class="step-num">3</span> Code in Zed</span>
          </div>
          ${notice}
        </div>
        <div class="welcome-side">
          <div class="health-card">
            <div class="health-card-head">
              <h2>Environment</h2>
              <button type="button" data-action="open-setup">Configure</button>
            </div>
            <div class="health-list">
              ${health.map((item) => `
                <button class="health-row" type="button" data-action="open-setup">
                  <span class="health-readiness ${item.ok ? "ok" : "bad"}">
                    ${icon(item.ok ? "check" : "alert")}
                  </span>
                  <span class="health-label">
                    <span>${escapeHtml(item.label)}</span>
                    <span class="health-detail">${escapeHtml(item.detail)}</span>
                  </span>
                </button>
              `).join("")}
            </div>
          </div>
          <div class="recent-card">
            <h2>Recent projects</h2>
            <div class="recent-list">${recentRows}</div>
          </div>
        </div>
      </div>

      <div class="feature-strip">
        <div class="feature">
          <div>${icon("layers")}</div>
          <h3>Visual scene editor</h3>
          <p>Place sprites, shapes, and text. Snap, zoom, and save scenes as plain JSON.</p>
        </div>
        <div class="feature">
          <div>${icon("image")}</div>
          <h3>Asset browser</h3>
          <p>Import images, audio, and fonts. Drag assets straight onto the canvas.</p>
        </div>
        <div class="feature">
          <div>${icon("terminal")}</div>
          <h3>Live console</h3>
          <p>Run and stop the game without leaving the editor, with stdout and errors streaming in.</p>
        </div>
        <div class="feature">
          <div>${icon("sparkle")}</div>
          <h3>DeepSeek assistant</h3>
          <p>Chat in the desktop Studio or in Zed. Inspect scenes, edit Lua, and run the game with approval.</p>
        </div>
      </div>
    </div>
  `;
}

function integrationRow({ label, ok, detail, iconName }) {
  return `
    <div class="integration-row">
      <span class="integration-icon ${ok ? "ok" : "bad"}">${icon(ok ? "check" : "alert")}</span>
      <span class="integration-body">
        <span class="integration-name">${escapeHtml(label)}</span>
        <span class="integration-detail">${escapeHtml(detail)}</span>
      </span>
    </div>
  `;
}

function renderSidebar() {
  const sidebar = el("sidebar");
  if (!sidebar) return;
  if (!state.project) {
    sidebar.innerHTML = "";
    return;
  }

  if (state.mode === "assets") {
    renderAssetsSidebar();
    return;
  }
  if (state.mode === "scripts") {
    renderScriptsSidebar();
    return;
  }
  if (state.mode === "project") {
    renderProjectSidebar();
    return;
  }

  const sceneRows = state.scenes.length
    ? state.scenes.map((scene) => {
        const active = scene.name === state.sceneName;
        const count = active && state.scene ? sceneEntities().length : null;
        return `
          <button class="scene-row ${active ? "is-active" : ""}" type="button"
            data-action="select-scene" data-name="${escapeAttr(scene.name)}">
            <span class="scene-row-icon">${icon("layers")}</span>
            <span class="scene-row-body">
              <span class="scene-row-name">${escapeHtml(scene.name)}</span>
              <span class="scene-row-meta">${count === null ? "scene" : `${count} ${count === 1 ? "entity" : "entities"}`}</span>
            </span>
            ${active ? icon("check", "icon small") : ""}
          </button>
        `;
      }).join("")
    : `<div class="sidebar-empty">No scenes yet.<br>Create your first scene to begin.</div>`;

  sidebar.innerHTML = `
    <div class="sidebar-inner">
      <div class="sidebar-head">
        <h2>Scenes</h2>
        <div class="sidebar-head-actions">
          <button class="icon-btn" type="button" data-action="new-scene" title="New scene" aria-label="New scene">
            ${icon("plus")}
          </button>
          <button class="icon-btn" type="button" data-action="refresh-scenes" title="Refresh" aria-label="Refresh scenes">
            ${icon("refresh")}
          </button>
        </div>
      </div>
      <div class="sidebar-project">
        <div class="sidebar-project-name">${escapeHtml(state.project.name)}</div>
        <div class="sidebar-project-path" title="${escapeAttr(state.project.path)}">${escapeHtml(state.project.path)}</div>
      </div>
      <div class="scene-list">${sceneRows}</div>
      <div class="sidebar-section">
        <h3>Assets</h3>
        <button class="btn btn-small btn-ghost" type="button" data-action="open-assets">Browse</button>
      </div>
      <div class="sidebar-note">
        Scenes are stored in <code>scenes/</code>. Press <kbd>R</kbd> while the game
        runs to reload the active scene.
      </div>
    </div>
  `;
}

function renderAssetsSidebar() {
  const sidebar = el("sidebar");
  sidebar.innerHTML = `
    <div class="sidebar-inner">
      <div class="sidebar-head">
        <h2>Assets</h2>
        <div class="sidebar-head-actions">
          <button class="icon-btn" type="button" data-action="import-assets" title="Import assets" aria-label="Import assets">
            ${icon("upload")}
          </button>
          <button class="icon-btn" type="button" data-action="refresh-assets" title="Refresh" aria-label="Refresh assets">
            ${icon("refresh")}
          </button>
        </div>
      </div>
      <div class="search-field">
        ${icon("search")}
        <input id="asset-search" type="search" placeholder="Search assets…" value="${escapeAttr(state.assetFilter)}" autocomplete="off">
      </div>
      <div id="asset-grid" class="asset-grid">${assetGridHtml()}</div>
      <div class="sidebar-note">
        Drag files here from Explorer to import them. Drag an image asset onto the
        canvas to place it, or click an image to use it as a placement brush.
        Supported: PNG, JPG, BMP, TGA, WAV, OGG, MP3, FLAC, TTF, OTF.
      </div>
    </div>
  `;
}

function filteredAssets() {
  const query = state.assetFilter.trim().toLowerCase();
  if (!query) return state.assets;
  return state.assets.filter((asset) =>
    asset.path.toLowerCase().includes(query) || asset.name.toLowerCase().includes(query)
  );
}

function assetGridHtml() {
  const assets = filteredAssets();
  if (!assets.length) {
    return `<div class="sidebar-empty" style="grid-column:1/-1">
      ${state.assets.length ? "No assets match that search." : "No assets yet.<br>Drop files here from Explorer, or import images, audio, or fonts."}
      <div style="margin-top:10px"><button class="btn btn-small btn-ghost" type="button" data-action="import-assets">${icon("upload")} Import</button></div>
    </div>`;
  }
  return assets.map((asset) => {
    const selected = state.selectedAsset?.path === asset.path;
    let preview;
    if (asset.kind === "image") {
      preview = `<img src="${escapeAttr(asset.url)}" alt="" draggable="false" loading="lazy">`;
    } else if (asset.kind === "audio") {
      preview = icon("play", "icon");
    } else {
      preview = `<span class="asset-font-glyph">Aa</span>`;
    }
    const playButton = asset.kind === "audio"
      ? `<button class="btn btn-small btn-ghost asset-audio-pill" type="button"
           data-action="play-asset" data-path="${escapeAttr(asset.path)}"
           title="Preview audio">${icon("play", "icon small")} Play</button>`
      : "";
    return `
      <div class="asset-card ${selected ? "is-selected" : ""}" role="button" tabindex="0"
        draggable="true" data-asset-card data-action="select-asset"
        data-path="${escapeAttr(asset.path)}" title="${escapeAttr(asset.path)}">
        <div class="asset-thumb">${preview}</div>
        <div class="asset-name">${escapeHtml(asset.name)}</div>
        ${playButton}
        <div class="asset-actions">
          <button type="button" data-action="delete-asset" data-path="${escapeAttr(asset.path)}" title="Delete asset" aria-label="Delete asset">
            ${icon("trash", "icon tiny")}
          </button>
        </div>
      </div>
    `;
  }).join("");
}

function filteredScripts() {
  const query = state.scriptFilter.trim().toLowerCase();
  if (!query) return state.scripts;
  return state.scripts.filter((script) =>
    script.path.toLowerCase().includes(query)
    || script.module.toLowerCase().includes(query)
  );
}

function scriptRowsHtml(scripts) {
  const rows = scripts.map((script) => {
    const parts = script.path.split("/");
    const name = parts.pop() || script.path;
    const folder = parts.length ? parts.join("/") : "project root";
    return `
      <button class="script-row ${script.path === state.selectedScript ? "is-active" : ""}"
        type="button" data-action="select-script" data-path="${escapeAttr(script.path)}"
        title="${escapeAttr(script.path)}">
        <span class="script-row-icon">${icon("code")}</span>
        <span class="script-row-body">
          <span class="script-row-name">${escapeHtml(name)}</span>
          <span class="script-row-path">${escapeHtml(folder)}</span>
        </span>
        <span class="script-row-meta">${script.lines}L</span>
      </button>
    `;
  }).join("");
  if (rows) return rows;
  const empty = state.scriptsLoaded
    ? (state.scripts.length
      ? "No scripts match that search."
      : "No Lua scripts found.<br>The AI can create them in the Scripts folder.")
    : "Loading scripts…";
  return `<div class="sidebar-empty">${empty}</div>`;
}

function renderScriptsSidebar() {
  const sidebar = el("sidebar");
  sidebar.innerHTML = `
    <div class="sidebar-inner">
      <div class="sidebar-head">
        <h2>Scripts</h2>
        <div class="sidebar-head-actions">
          <button class="icon-btn" type="button" data-action="refresh-scripts" title="Refresh scripts" aria-label="Refresh scripts">
            ${icon("refresh")}
          </button>
        </div>
      </div>
      <div class="search-field">
        ${icon("search")}
        <input id="script-search" type="search" placeholder="Search scripts…" value="${escapeAttr(state.scriptFilter)}" autocomplete="off">
      </div>
      <div class="script-list" id="script-list">
        ${scriptRowsHtml(filteredScripts())}
      </div>
      <div class="sidebar-note">
        Scripts are read-only here so the scene editor stays visual. Use
        <strong>Open in Zed</strong> to edit. AI-generated modules appear here
        after they are written.
      </div>
    </div>
  `;
}

async function refreshScripts({ silent = false } = {}) {
  if (!state.project) return;
  const requestId = ++scriptLoadId;
  state.scriptsLoaded = false;
  if (!silent) renderSidebar();
  try {
    const data = await api("/api/scripts");
    if (requestId !== scriptLoadId) return;
    state.scripts = Array.isArray(data.scripts) ? data.scripts : [];
    state.scriptsLoaded = true;
    if (!state.scripts.some((script) => script.path === state.selectedScript)) {
      const preferred = state.scripts.find((script) => script.path === "main.lua")
        || state.scripts[0];
      state.selectedScript = preferred?.path || "";
      state.scriptData = null;
    }
    renderSidebar();
    if (state.mode === "scripts" && state.selectedScript) {
      await loadScript(state.selectedScript, { silent: true });
    } else {
      renderScriptView();
    }
  } catch (error) {
    if (requestId !== scriptLoadId) return;
    state.scriptsLoaded = true;
    if (!silent) toast(error.message, "error", 5000);
    renderSidebar();
    renderScriptView();
  }
}

async function loadScript(path, { silent = false } = {}) {
  if (!state.project || !path) return;
  const requestId = ++scriptLoadId;
  state.selectedScript = path;
  state.scriptLoading = true;
  state.scriptData = null;
  renderSidebar();
  renderScriptView();
  try {
    const data = await api(`/api/script?path=${encodeURIComponent(path)}`);
    if (requestId !== scriptLoadId) return;
    state.scriptLoading = false;
    state.scriptData = data.script;
    renderSidebar();
    renderScriptView();
  } catch (error) {
    if (requestId !== scriptLoadId) return;
    state.scriptLoading = false;
    state.scriptData = null;
    if (!silent) toast(error.message, "error", 5000);
    renderScriptView();
  }
}

function renderScriptView() {
  const view = el("script-view");
  if (!view) return;
  const empty = el("script-empty");
  const code = el("script-code");
  const name = el("script-view-name");
  const pathLabel = el("script-view-path");
  const meta = el("script-view-meta");
  const copy = el("btn-script-copy");
  const zed = el("btn-script-zed");
  const script = state.scriptData;
  if (copy) copy.disabled = !script;
  if (zed) zed.disabled = !script;
  if (name) name.textContent = script ? script.path.split("/").pop() : "No script selected";
  if (pathLabel) pathLabel.textContent = script
    ? script.path
    : (state.scriptLoading ? "Loading…" : "Choose a Lua file from the Scripts sidebar.");
  if (meta) {
    meta.textContent = script
      ? `${script.lines} lines · ${script.symbols?.length || 0} symbols`
      : "";
  }
  if (!script) {
    if (code) {
      code.hidden = true;
      code.innerHTML = "";
    }
    if (empty) {
      empty.hidden = false;
      const message = state.scriptLoading
        ? "Loading script…"
        : "Scripts created by the AI, or any Lua file in the project, appear here.";
      empty.innerHTML = `
        <svg class="icon"><use href="#i-code"/></svg>
        <strong>${state.scriptLoading ? "Loading script…" : "Select a Lua script"}</strong>
        <span>${message}</span>
      `;
    }
    renderStageFrame();
    return;
  }

  if (empty) empty.hidden = true;
  if (code) {
    code.hidden = false;
    code.innerHTML = "";
    const lines = script.content.split(/\r?\n/);
    const limit = 5000;
    const fragment = document.createDocumentFragment();
    lines.slice(0, limit).forEach((line, index) => {
      const row = document.createElement("div");
      row.className = "script-line";
      const trimmed = line.trimStart();
      if (trimmed.startsWith("--")) row.classList.add("is-comment");
      else if (/^\s*(local\s+)?function\b/.test(line) || /=\s*function\b/.test(line)) {
        row.classList.add("is-header");
      }
      const number = document.createElement("span");
      number.className = "script-line-no";
      number.textContent = String(index + 1);
      const text = document.createElement("span");
      text.className = "script-line-text";
      text.textContent = line || " ";
      row.append(number, text);
      fragment.append(row);
    });
    if (lines.length > limit) {
      const row = document.createElement("div");
      row.className = "script-line";
      row.innerHTML = `<span class="script-line-no">…</span><span class="script-line-text">[preview truncated at ${limit} lines]</span>`;
      fragment.append(row);
    }
    code.append(fragment);
  }
  renderStageFrame();
}

async function copyScriptCode() {
  const content = state.scriptData?.content;
  if (!content) return;
  try {
    await navigator.clipboard.writeText(content);
    toast("Script copied to the clipboard.", "success", 2200);
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = content;
    textarea.style.position = "fixed";
    textarea.style.opacity = "0";
    document.body.append(textarea);
    textarea.select();
    try {
      document.execCommand("copy");
      toast("Script copied to the clipboard.", "success", 2200);
    } catch {
      toast("Could not copy the script.", "error", 3000);
    } finally {
      textarea.remove();
    }
  }
}

async function openScriptInZed() {
  if (!state.scriptData) return;
  if (!state.setup?.zed?.installed) {
    openSetupModal();
    toast("Zed was not found. Install it, then add the assistant in Setup.", "warn", 5200);
    return;
  }
  try {
    await api("/api/open-zed", {
      method: "POST",
      body: { path: state.scriptData.path }
    });
    toast(`Opening ${state.scriptData.path} in Zed…`, "success", 2200);
  } catch (error) {
    toast(error.message, "error", 5000);
  }
}

function renderStageFrame() {
  const hasProject = Boolean(state.project);
  const preview = hasProject && state.preview.active;
  const scripts = hasProject && state.mode === "scripts";
  el("welcome").hidden = hasProject;
  el("game-preview").hidden = !preview;
  el("editor").hidden = !hasProject || preview || scripts;
  el("script-view").hidden = !hasProject || preview || !scripts;
  if (el("inspector")) el("inspector").hidden = !hasProject || scripts;
}

function renderProjectSidebar() {
  const sidebar = el("sidebar");
  const setup = state.setup || {};
  const path = state.project.path;
  const love = setup.love || {};
  const zed = setup.zed || {};
  const deepseek = setup.deepseek || {};
  sidebar.innerHTML = `
    <div class="sidebar-inner">
      <div class="sidebar-head">
        <h2>Project</h2>
        <div class="sidebar-head-actions">
          <button class="icon-btn" type="button" data-action="open-setup" title="Setup" aria-label="Setup">
            ${icon("settings")}
          </button>
        </div>
      </div>
      <div class="sidebar-project">
        <div class="sidebar-project-name">${escapeHtml(state.project.name)}</div>
        <div class="sidebar-project-path" title="${escapeAttr(path)}">${escapeHtml(path)}</div>
      </div>
      <div class="project-panel">
        <div class="project-detail-row"><span>Template</span><span>${escapeHtml(state.project.template || "existing project")}</span></div>
        <div class="project-detail-row"><span>Scenes</span><span>${state.scenes.length}</span></div>
        <div class="project-detail-row"><span>Assets</span><span>${state.assets.length}</span></div>
        <div class="project-detail-row"><span>LÖVE</span><span>${escapeHtml(love.version || (love.found ? "found" : "not found"))}</span></div>
      </div>
      <div class="sidebar-section"><h3>Integrations</h3></div>
      <div style="padding:0 12px">
        ${integrationRow({ label: "LÖVE runtime", ok: Boolean(love.found), detail: love.found ? "Run and console ready" : "Set the executable in Setup" })}
        ${integrationRow({ label: "Zed editor", ok: Boolean(zed.installed), detail: zed.installed ? "Ready for tasks and AI" : "Install Zed to use AI" })}
        ${integrationRow({ label: "DeepSeek key", ok: Boolean(deepseek.configured), detail: deepseek.configured ? deepseek.model || "Configured" : "Add a key in Setup" })}
        ${integrationRow({ label: "Love2D Assistant", ok: Boolean(zed.configured), detail: zed.configured ? "In Zed's agent panel" : "Install in Setup" })}
      </div>
      <div class="project-actions" style="padding:14px 12px">
        <button class="btn btn-small btn-secondary" type="button" data-action="open-zed">${icon("zed")} Open in Zed</button>
        <button class="btn btn-small btn-ghost" type="button" data-action="reveal-project">${icon("folder")} Open project folder</button>
        <button class="btn btn-small btn-ghost" type="button" data-action="open-setup">${icon("settings")} Setup & AI</button>
      </div>
      <div class="sidebar-section"><h3>Shortcuts</h3></div>
      <div class="sidebar-note">
        <kbd>Alt</kbd> + <kbd>R</kbd> run game in Zed<br>
        <kbd>Alt</kbd> + <kbd>Shift</kbd> + <kbd>S</kbd> open Studio<br>
        <kbd>Ctrl</kbd> + <kbd>S</kbd> save scene here
      </div>
    </div>
  `;
}

/* -------------------------------------------------------------------------
   Scene toolbar + inspector
   ------------------------------------------------------------------------- */

function renderSceneToolbar() {
  if (!state.project) return;
  const select = el("scene-select");
  select.innerHTML = state.scenes.map((scene) =>
    `<option value="${escapeAttr(scene.name)}" ${scene.name === state.sceneName ? "selected" : ""}>${escapeHtml(scene.name)}</option>`
  ).join("");
  select.disabled = !state.scenes.length;

  $$(".tool-btn").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.tool === state.tool);
  });
  el("btn-undo").disabled = state.undo.length === 0;
  el("btn-redo").disabled = state.redo.length === 0;
  el("btn-grid").classList.toggle("is-active", state.showGrid);
  el("btn-grid").setAttribute("aria-pressed", String(state.showGrid));
  updateCanvasHint();
}

function updateCanvasHint() {
  const hint = el("canvas-hint");
  if (!hint) return;
  if (state.tool === "sprite") {
    if (state.selectedAsset?.kind === "image") {
      hint.textContent = `Click the canvas to place ${state.selectedAsset.name} · Esc to cancel`;
      hint.hidden = false;
      return;
    }
    hint.textContent = "Pick an image in Assets, then click the canvas to place it.";
    hint.hidden = false;
    return;
  }
  hint.hidden = true;
}

function numberField(label, field, value, options = {}) {
  const { min = "", max = "", step = 1, scope = "entity", extra = "" } = options;
  return `
    <div class="field">
      <label for="field-${field}">${escapeHtml(label)}</label>
      <input id="field-${field}" type="number" data-field="${escapeAttr(field)}" data-scope="${scope}"
        value="${escapeAttr(value)}" min="${min}" max="${max}" step="${step}" ${extra}>
    </div>
  `;
}

function colorControls(color, scope = "entity") {
  return `
    <div class="field">
      <label>Color</label>
      <div class="color-field">
        <input type="color" value="${rgbToHex(color)}" data-field="color" data-scope="${scope}" aria-label="Color">
        <input type="number" min="0" max="1" step="0.01" title="Alpha" aria-label="Alpha"
          data-field="alpha" data-scope="${scope}" value="${(color?.[3] ?? 1).toFixed(2)}">
      </div>
    </div>
  `;
}

function propertyTypeOf(value) {
  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";
  return "text";
}

function propertyRowHtml(key, value) {
  const type = propertyTypeOf(value);
  let valueControl;
  if (type === "boolean") {
    valueControl = `<label class="check-row property-check">
      <input type="checkbox" data-property-value data-property-key="${escapeAttr(key)}" ${value ? "checked" : ""}> On
    </label>`;
  } else if (type === "number") {
    valueControl = `<input type="number" step="any" data-property-value data-property-key="${escapeAttr(key)}"
      value="${escapeAttr(String(value))}" aria-label="${escapeAttr(key)} value">`;
  } else {
    valueControl = `<input type="text" data-property-value data-property-key="${escapeAttr(key)}"
      value="${escapeAttr(String(value))}" aria-label="${escapeAttr(key)} value">`;
  }
  return `
    <div class="property-row">
      <div class="property-row-head">
        <input type="text" class="property-key-input" data-property-key-input
          data-old-key="${escapeAttr(key)}" value="${escapeAttr(key)}" spellcheck="false"
          aria-label="Property name">
        <select data-property-type data-property-key="${escapeAttr(key)}" aria-label="Property type">
          <option value="number" ${type === "number" ? "selected" : ""}>Number</option>
          <option value="text" ${type === "text" ? "selected" : ""}>Text</option>
          <option value="boolean" ${type === "boolean" ? "selected" : ""}>On/off</option>
        </select>
        <button class="icon-btn property-remove" type="button" data-action="delete-property"
          data-key="${escapeAttr(key)}" title="Remove property" aria-label="Remove property">
          ${icon("trash", "icon tiny")}
        </button>
      </div>
      <div class="property-row-value">${valueControl}</div>
    </div>
  `;
}

function renderInspector() {
  const inspector = el("inspector");
  if (!state.project) {
    inspector.innerHTML = "";
    return;
  }
  if (!state.scene) {
    inspector.innerHTML = `
      <div class="inspector-empty">
        ${icon("layers")}
        <strong>No scene loaded</strong>
        <p>Create or select a scene to start editing.</p>
      </div>
    `;
    return;
  }

  const entity = selectedEntity();
  if (!entity) {
    const scene = state.scene;
    inspector.innerHTML = `
      <div class="inspector-inner">
        <div class="inspector-head">
          <div class="inspector-title">
            <h2>Scene settings</h2>
            <p>${sceneEntities().length} ${sceneEntities().length === 1 ? "entity" : "entities"}</p>
          </div>
          <span class="type-chip">scene</span>
        </div>
        <div class="inspector-section">
          <h3>Canvas</h3>
          <div class="field-grid">
            <div class="field full">
              <label>Scene file</label>
              <input type="text" value="${escapeAttr(state.sceneName)}" readonly>
            </div>
            ${numberField("Width", "width", scene.width || 960, { scope: "scene", min: 1 })}
            ${numberField("Height", "height", scene.height || 600, { scope: "scene", min: 1 })}
          </div>
        </div>
        <div class="inspector-section">
          <h3>Background</h3>
          <div class="field-grid">
            ${colorControls(scene.background || [0.055, 0.065, 0.085, 1], "scene")}
          </div>
        </div>
        <div class="inspector-section">
          <h3>Scene tips</h3>
          <div class="inline-hint">
            Select an entity to inspect it. Drag entities to move them. Use the
            corner handles to resize, and drag on empty space to pan while holding
            <kbd>Space</kbd>.
          </div>
        </div>
        <div class="inspector-actions">
          <button class="btn btn-small btn-secondary" type="button" data-action="new-scene">${icon("plus")} New scene</button>
          <button class="btn btn-small btn-ghost" type="button" data-action="import-assets">${icon("upload")} Import asset</button>
        </div>
      </div>
    `;
    return;
  }

  const color = entity.color || [1, 1, 1, 1];
  const solid = Boolean(entity.properties?.solid);
  let typeFields = "";
  if (entity.type === "sprite") {
    typeFields = `
      <div class="inspector-section">
        <h3>Sprite</h3>
        <div class="field full">
          <label>Asset path</label>
          <input type="text" class="asset-path-drop" data-asset-path
            value="${escapeAttr(entity.path || "")}" readonly
            title="Drag an image asset here to replace this sprite's image">
        </div>
        <div class="inline-hint">Drag an image asset into this field to replace it, or drag one onto the canvas to add a new sprite.</div>
      </div>
    `;
  } else if (entity.type === "text") {
    typeFields = `
      <div class="inspector-section">
        <h3>Text</h3>
        <div class="field full" style="margin-bottom:8px">
          <label>Content</label>
          <textarea data-field="text" data-scope="entity">${escapeHtml(entity.text || "")}</textarea>
        </div>
        <div class="field-grid">
          ${numberField("Font size", "fontSize", entity.fontSize || 16, { min: 4, max: 512 })}
          <div class="field">
            <label>Align</label>
            <select data-field="align" data-scope="entity">
              ${["left", "center", "right", "justify"].map((value) =>
                `<option value="${value}" ${entity.align === value ? "selected" : ""}>${value}</option>`
              ).join("")}
            </select>
          </div>
        </div>
      </div>
    `;
  } else if (entity.type === "rectangle") {
    typeFields = `
      <div class="inspector-section">
        <h3>Rectangle</h3>
        <div class="field-grid">
          <label class="check-row"><input type="checkbox" data-field="fill" data-scope="entity" ${entity.fill !== false ? "checked" : ""}> Filled</label>
          ${numberField("Corner radius", "radius", entity.radius || 0, { min: 0 })}
        </div>
        <div class="inline-hint">Use the solid property for collision platforms in the starter template.</div>
      </div>
    `;
  } else if (entity.type === "circle") {
    typeFields = `
      <div class="inspector-section">
        <h3>Circle</h3>
        <label class="check-row"><input type="checkbox" data-field="fill" data-scope="entity" ${entity.fill !== false ? "checked" : ""}> Filled</label>
      </div>
    `;
  }

  const solidRow = entity.type === "rectangle"
    ? `<label class="check-row"><input type="checkbox" data-field="properties.solid" data-scope="entity" ${solid ? "checked" : ""}> Solid (collision)</label>`
    : "";
  const propertyRows = Object.entries(entity.properties || {})
    .filter(([key]) => key !== "solid")
    .map(([key, value]) => propertyRowHtml(key, value))
    .join("");

  inspector.innerHTML = `
    <div class="inspector-inner">
      <div class="inspector-head">
        <div class="inspector-title">
          <h2>${escapeHtml(entity.name || "Untitled")}</h2>
          <p title="${escapeAttr(entity.id)}">${escapeHtml(entity.id)}</p>
        </div>
        <span class="type-chip">${escapeHtml(entity.type)}</span>
      </div>
      <div class="inspector-actions" style="padding-top:0;padding-bottom:10px">
        <button class="btn btn-small btn-ghost" type="button" data-action="duplicate-entity" title="Duplicate (Ctrl+D)">${icon("copy")} Duplicate</button>
        <button class="btn btn-small btn-ghost" type="button" data-action="delete-entity" title="Delete (Del)">${icon("trash")} Delete</button>
      </div>

      <div class="inspector-section">
        <h3>Identity</h3>
        <div class="field-grid">
          <div class="field full">
            <label>Name</label>
            <input type="text" data-field="name" data-scope="entity" value="${escapeAttr(entity.name || "")}">
          </div>
        </div>
      </div>

      <div class="inspector-section">
        <h3>Transform</h3>
        <div class="field-grid">
          ${numberField("X", "x", Math.round(entity.x || 0))}
          ${numberField("Y", "y", Math.round(entity.y || 0))}
          ${numberField("Width", "w", Math.round(entity.w || 1), { min: 1 })}
          ${numberField("Height", "h", Math.round(entity.h || 1), { min: 1 })}
          ${numberField("Rotation", "rotation", Math.round(entity.rotation || 0), { step: 1 })}
          ${numberField("Layer", "layer", Math.round(entity.layer || 0))}
        </div>
      </div>

      <div class="inspector-section">
        <h3>Appearance</h3>
        <div class="field">
          <label>Opacity <span id="opacity-value">${Math.round((entity.opacity ?? 1) * 100)}%</span></label>
          <input type="range" min="0" max="1" step="0.01" value="${entity.opacity ?? 1}"
            data-field="opacity" data-scope="entity">
        </div>
        <div class="field-grid">
          ${colorControls(color, "entity")}
          <label class="check-row"><input type="checkbox" data-field="visible" data-scope="entity" ${entity.visible !== false ? "checked" : ""}> Visible</label>
        </div>
      </div>

      ${typeFields}

      <div class="inspector-section">
        <h3>Gameplay</h3>
        ${solidRow}
        <div class="property-list">
          ${propertyRows || `<div class="inline-hint">No custom properties. Add one for values like speed, health, or damage.</div>`}
        </div>
        <button class="btn btn-small btn-ghost property-add" type="button" data-action="add-property">
          ${icon("plus", "icon small")} Add property
        </button>
        <div class="inline-hint">
          Available in Lua as <code>entity.properties.key</code>. Numbers, text, and on/off values are supported.
        </div>
      </div>
    </div>
  `;

  bindAssetPathDrop(inspector.querySelector("[data-asset-path]"));

  const opacityInput = inspector.querySelector('[data-field="opacity"]');
  if (opacityInput) {
    opacityInput.addEventListener("input", () => {
      const value = Math.round(Number(opacityInput.value) * 100);
      const label = el("opacity-value");
      if (label) label.textContent = `${value}%`;
    });
  }
}

function propertyKeyIsValid(key) {
  return /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(key);
}

function commitPropertyChange() {
  if (state.fieldSnapshot) {
    pushFieldUndo(state.fieldSnapshot);
    state.fieldSnapshot = null;
  }
  markDirty();
  scheduleSave();
  renderCanvas();
}

function addCustomProperty() {
  const entity = selectedEntity();
  if (!entity) return;
  const properties = entity.properties || {};
  let key = "property";
  let counter = 2;
  while (Object.prototype.hasOwnProperty.call(properties, key) || key === "solid") {
    key = `property${counter}`;
    counter += 1;
  }
  pushUndo();
  entity.properties = { ...properties, [key]: 0 };
  markDirty();
  renderInspector();
  scheduleSave();
  const nameField = el("inspector")?.querySelector(
    `[data-property-key-input][data-old-key="${key}"]`
  );
  nameField?.focus();
  nameField?.select();
}

function deleteCustomProperty(key) {
  const entity = selectedEntity();
  if (!entity?.properties || !Object.prototype.hasOwnProperty.call(entity.properties, key)) {
    return;
  }
  pushUndo();
  delete entity.properties[key];
  markDirty();
  renderInspector();
  renderCanvas();
  scheduleSave();
}

function renameCustomProperty(input) {
  const entity = selectedEntity();
  if (!entity) return;
  const oldKey = input.dataset.oldKey || "";
  const newKey = input.value.trim();
  if (newKey === oldKey) return;
  if (!propertyKeyIsValid(newKey)) {
    toast(
      "Property names must start with a letter or underscore and use only letters, numbers, _ or -.",
      "warn",
      4500
    );
    renderInspector();
    return;
  }
  if (newKey === "solid") {
    toast("Use the built-in Solid checkbox for that property.", "warn", 3200);
    renderInspector();
    return;
  }
  const properties = entity.properties || {};
  if (Object.prototype.hasOwnProperty.call(properties, newKey)) {
    toast(`A property named "${newKey}" already exists.`, "warn", 3200);
    renderInspector();
    return;
  }
  pushUndo();
  const value = properties[oldKey];
  delete properties[oldKey];
  properties[newKey] = value;
  entity.properties = properties;
  markDirty();
  renderInspector();
  scheduleSave();
}

function updateCustomProperty(input) {
  const entity = selectedEntity();
  if (!entity) return;
  const key = input.dataset.propertyKey || "";
  if (!Object.prototype.hasOwnProperty.call(entity.properties || {}, key)) return;
  const row = input.closest(".property-row");
  const type = row?.querySelector("[data-property-type]")?.value || propertyTypeOf(entity.properties[key]);
  let value;
  if (type === "boolean") {
    value = Boolean(input.checked);
  } else if (type === "number") {
    value = Number(input.value);
    if (!Number.isFinite(value)) {
      value = 0;
      input.value = "0";
    }
  } else {
    value = input.value;
  }
  entity.properties[key] = value;
  commitPropertyChange();
}

function changeCustomPropertyType(select) {
  const entity = selectedEntity();
  if (!entity) return;
  const key = select.dataset.propertyKey || "";
  if (!Object.prototype.hasOwnProperty.call(entity.properties || {}, key)) return;
  const current = entity.properties[key];
  let value;
  if (select.value === "number") {
    value = typeof current === "number" ? current : Number(current) || 0;
  } else if (select.value === "boolean") {
    value = typeof current === "boolean" ? current : Boolean(current);
  } else {
    value = typeof current === "string" ? current : String(current ?? "");
  }
  pushUndo();
  entity.properties[key] = value;
  markDirty();
  renderInspector();
  scheduleSave();
}

function bindAssetPathDrop(input) {
  if (!input) return;
  const hasAssetDrag = (event) => {
    const types = Array.from(event.dataTransfer?.types || []);
    return types.includes("application/x-love2d-asset") || types.includes("Files");
  };
  const setActive = (active) => input.classList.toggle("is-drop-target", active);

  input.addEventListener("dragenter", (event) => {
    if (!hasAssetDrag(event)) return;
    event.preventDefault();
    setActive(true);
  });
  input.addEventListener("dragover", (event) => {
    if (!hasAssetDrag(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
    setActive(true);
  });
  input.addEventListener("dragleave", () => setActive(false));
  input.addEventListener("drop", async (event) => {
    if (!hasAssetDrag(event)) return;
    event.preventDefault();
    setActive(false);

    let asset = null;
    const path = event.dataTransfer.getData("application/x-love2d-asset");
    if (path) {
      asset = state.assets.find((item) => item.path === path) || null;
    } else {
      const files = Array.from(event.dataTransfer.files || []);
      if (files.length) {
        const result = await uploadAssets(files, { notify: false });
        asset = (result.assets || [])
          .map((item) => state.assets.find((candidate) => candidate.path === item.path) || item)
          .find((item) => item.kind === "image") || null;
        if (!asset && result.imported) {
          toast("Imported. Only image assets can be used as a sprite path.", "warn", 3500);
        }
      }
    }
    if (!asset) return;
    if (asset.kind !== "image") {
      toast(`${asset.name} is not an image. Use PNG, JPG, BMP, or TGA.`, "warn", 3500);
      return;
    }
    const entity = selectedEntity();
    if (!entity || entity.type !== "sprite") return;
    pushUndo();
    entity.path = asset.path;
    markDirty();
    renderInspector();
    renderCanvas();
    scheduleSave();
    toast(`Sprite image set to ${asset.name}.`, "success", 2200);
  });
}

/* -------------------------------------------------------------------------
   Run UI / console
   ------------------------------------------------------------------------- */

function renderRunUI() {
  if (!state.project) {
    el("btn-run").disabled = true;
    el("btn-stop").disabled = true;
    el("btn-console-run").disabled = true;
    el("btn-console-stop").disabled = true;
    updateConsoleState();
    return;
  }
  const loveReady = Boolean(state.setup?.love?.found);
  el("btn-run").disabled = state.running || !loveReady;
  el("btn-stop").disabled = !state.running;
  el("btn-console-run").disabled = state.running || !loveReady;
  el("btn-console-stop").disabled = !state.running;
  const runTitle = canEmbedGame() ? "Run game inside the editor" : "Run game";
  el("btn-run").title = loveReady ? runTitle : "LÖVE not found — configure it in Setup";
  el("btn-console-run").title = loveReady ? runTitle : "LÖVE not found — configure it in Setup";
  el("project-dot").classList.toggle("is-live", state.running);
  updateConsoleState();
}

function updateConsoleState() {
  const indicator = el("console-run-state");
  if (!indicator) return;
  indicator.classList.remove("is-running", "is-error");
  if (state.running) {
    indicator.classList.add("is-running");
    indicator.innerHTML = `<span class="dot"></span> running${state.run?.pid ? ` · pid ${state.run.pid}` : ""}`;
  } else if (state.run?.error) {
    indicator.classList.add("is-error");
    indicator.innerHTML = `<span class="dot"></span> stopped`;
  } else {
    indicator.innerHTML = `<span class="dot"></span> stopped`;
  }
}

function renderConsoleFrame() {
  const consolePanel = el("console");
  consolePanel.classList.toggle("is-closed", state.consoleCollapsed);
  renderLogs();
}

function renderLogs() {
  const output = el("console-output");
  if (!output) return;
  output.innerHTML = "";
  if (!state.logs.length) {
    const empty = document.createElement("div");
    empty.className = "console-empty";
    empty.textContent = "Run the game to stream stdout and stderr here.";
    output.append(empty);
    return;
  }
  const fragment = document.createDocumentFragment();
  for (const entry of state.logs.slice(-2500)) {
    fragment.append(logLine(entry));
  }
  output.append(fragment);
  output.scrollTop = output.scrollHeight;
}

function logLine(entry) {
  const line = document.createElement("div");
  line.className = "log-line";
  line.dataset.stream = entry.stream || "stdout";
  const time = document.createElement("span");
  time.className = "log-time";
  time.textContent = timeLabel(entry.ts);
  const text = document.createElement("span");
  text.className = "log-text";
  text.textContent = entry.text ?? "";
  line.append(time, text);
  return line;
}

function appendLog(entry) {
  if (!entry) return;
  if (state.logs.some((existing) => existing.seq === entry.seq)) return;
  state.logs.push(entry);
  if (state.logs.length > 5000) state.logs.splice(0, state.logs.length - 5000);
  const output = el("console-output");
  if (!output) return;
  if (output.querySelector(".console-empty")) output.innerHTML = "";
  const shouldStick = output.scrollHeight - output.scrollTop - output.clientHeight < 80;
  output.append(logLine(entry));
  while (output.children.length > 2500) output.firstElementChild?.remove();
  if (shouldStick) output.scrollTop = output.scrollHeight;
}

function canEmbedGame() {
  return Boolean(desktop?.gamePreview?.attach && desktop.platform === "win32");
}

function rectsOverlap(a, b) {
  if (!a || !b || a.width < 1 || a.height < 1 || b.width < 1 || b.height < 1) {
    return false;
  }
  return a.left < b.right && a.right > b.left
    && a.top < b.bottom && a.bottom > b.top;
}

function previewCoveredByOverlay() {
  const modal = el("modal-dialog");
  if (modal?.open) return true;
  const drawer = el("ai-drawer");
  if (!drawer || drawer.hidden) return false;
  // The AI assistant is a side panel, not a modal. Hide the native game
  // window only when the panel actually overlaps it; otherwise a normal
  // chat-open layout would show an unexplained black preview.
  const screen = el("game-preview-screen");
  if (!screen) return true;
  return rectsOverlap(
    drawer.getBoundingClientRect(),
    screen.getBoundingClientRect()
  );
}

function renderPreviewOverlay() {
  const overlay = el("game-preview-overlay");
  if (!overlay) return;
  const paused = Boolean(state.preview.active && state.preview.hiddenForOverlay);
  const starting = Boolean(state.preview.active && !state.preview.embedded);
  overlay.hidden = !(paused || starting);
  const title = overlay.querySelector("strong");
  const detail = overlay.querySelector("span:last-child");
  const spinner = overlay.querySelector(".game-preview-spinner");
  if (paused) {
    if (spinner) spinner.hidden = true;
    if (title) title.textContent = "Game hidden while the assistant panel covers it";
    if (detail) detail.textContent = "Close the assistant or widen the Studio window.";
  } else if (starting) {
    if (spinner) spinner.hidden = false;
    if (title) title.textContent = "Starting game…";
    if (detail) detail.textContent = "Embedding the LÖVE window in the Studio.";
  }
}

function previewDesignSize() {
  const previewWidth = Number(state.preview.designWidth);
  const previewHeight = Number(state.preview.designHeight);
  if (previewWidth > 0 && previewHeight > 0) {
    return { width: previewWidth, height: previewHeight };
  }
  const windowSize = state.project?.window;
  const windowWidth = Number(windowSize?.width);
  const windowHeight = Number(windowSize?.height);
  if (windowWidth > 0 && windowHeight > 0) {
    return { width: windowWidth, height: windowHeight };
  }
  const sceneWidth = Number(state.scene?.width);
  const sceneHeight = Number(state.scene?.height);
  if (sceneWidth > 0 && sceneHeight > 0) {
    return { width: sceneWidth, height: sceneHeight };
  }
  return null;
}

function previewAspect() {
  const design = previewDesignSize();
  if (design) return design.width / design.height;
  const preset = Number(state.preview.aspect);
  return Number.isFinite(preset) && preset > 0 ? preset : 4 / 3;
}

function layoutGamePreviewScreen() {
  const viewport = el("game-preview-viewport");
  const screen = el("game-preview-screen");
  if (!viewport || !screen) return null;
  const style = getComputedStyle(viewport);
  const paddingX = (Number.parseFloat(style.paddingLeft) || 0)
    + (Number.parseFloat(style.paddingRight) || 0);
  const paddingY = (Number.parseFloat(style.paddingTop) || 0)
    + (Number.parseFloat(style.paddingBottom) || 0);
  const availableWidth = viewport.clientWidth - paddingX;
  const availableHeight = viewport.clientHeight - paddingY;
  if (availableWidth < 2 || availableHeight < 2) return null;
  const design = previewDesignSize();
  let width;
  let height;
  if (design) {
    // Do not enlarge the game window beyond its configured resolution.
    // LÖVE draws in window pixels, so upscaling the window would expose
    // extra empty space and entities outside the designed playfield.
    const scale = Math.min(
      1,
      availableWidth / design.width,
      availableHeight / design.height
    );
    width = design.width * scale;
    height = design.height * scale;
  } else {
    const aspect = previewAspect();
    width = availableWidth;
    height = width / aspect;
    if (height > availableHeight) {
      height = availableHeight;
      width = height * aspect;
    }
  }
  const roundedWidth = Math.max(1, Math.round(width));
  const roundedHeight = Math.max(1, Math.round(height));
  screen.style.width = `${roundedWidth}px`;
  screen.style.height = `${roundedHeight}px`;
  return { width: roundedWidth, height: roundedHeight };
}

function previewBoundsNow() {
  const screen = el("game-preview-screen");
  const viewport = el("game-preview-viewport");
  if (!screen || !viewport) return null;
  if (!screen.style.width || !screen.style.height) layoutGamePreviewScreen();
  const rect = screen.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) return null;
  return {
    x: rect.left,
    y: rect.top,
    width: rect.width,
    height: rect.height
  };
}

function renderGamePreview() {
  const preview = el("game-preview");
  const editor = el("editor");
  if (!preview || !editor) return;
  const active = Boolean(state.project && state.preview.active);
  if (!active) {
    renderStageFrame();
    return;
  }

  layoutGamePreviewScreen();
  renderPreviewOverlay();
  const meta = el("game-preview-meta");
  if (meta) {
    meta.textContent = state.preview.embedded
      ? "Runs inside Studio · click the game to focus"
      : "Starting LÖVE…";
  }
  const stop = el("btn-preview-stop");
  if (stop) stop.disabled = !state.running;
  renderStageFrame();
}

function startPreviewObserver() {
  stopPreviewObserver();
  const viewport = el("game-preview-viewport");
  if (!viewport) return;
  layoutGamePreviewScreen();
  if (typeof ResizeObserver !== "function") return;
  state.previewObserver = new ResizeObserver(() => {
    layoutGamePreviewScreen();
    schedulePreviewBounds();
  });
  state.previewObserver.observe(viewport);
}

function stopPreviewObserver() {
  if (state.previewObserver) {
    state.previewObserver.disconnect();
    state.previewObserver = null;
  }
  if (state.previewBoundsTimer) {
    clearTimeout(state.previewBoundsTimer);
    state.previewBoundsTimer = 0;
  }
}

function schedulePreviewBounds(delay = 70) {
  if (!state.preview.active || !state.preview.embedded) return;
  if (state.previewBoundsTimer) clearTimeout(state.previewBoundsTimer);
  state.previewBoundsTimer = setTimeout(() => {
    state.previewBoundsTimer = 0;
    updatePreviewBoundsNow().catch(() => {});
  }, delay);
}

async function updatePreviewBoundsNow({ show = false } = {}) {
  if (!canEmbedGame() || !state.preview.active || !state.preview.embedded) return;
  if (state.preview.hiddenForOverlay || previewCoveredByOverlay()) return;
  const bounds = previewBoundsNow();
  if (!bounds) return;
  try {
    const result = await desktop.gamePreview.setBounds({
      bounds,
      scale: window.devicePixelRatio || 1
    });
    if (result && result.ok === false) throw new Error(result.error || "Could not position the game.");
    if (show) {
      await desktop.gamePreview.setVisible(true);
    }
  } catch {
    // The game may have exited while the window was moving. The console and
    // runner state remain authoritative.
  }
}

function syncPreviewOverlay() {
  if (!state.preview.embedded || !canEmbedGame()) {
    renderPreviewOverlay();
    return;
  }
  if (previewCoveredByOverlay()) {
    if (!state.preview.hiddenForOverlay) {
      state.preview.hiddenForOverlay = true;
      renderPreviewOverlay();
      desktop.gamePreview.setVisible(false).catch(() => {});
    }
    return;
  }
  if (!state.preview.hiddenForOverlay) return;
  state.preview.hiddenForOverlay = false;
  renderPreviewOverlay();
  updatePreviewBoundsNow({ show: true }).catch(() => {});
}

function leaveGamePreview() {
  const wasActive = state.preview.active;
  const wasEmbedded = state.preview.embedded;
  if (attachmentTimer) {
    clearTimeout(attachmentTimer);
    attachmentTimer = 0;
  }
  if (wasEmbedded && canEmbedGame()) {
    desktop.gamePreview.setVisible(false).catch(() => {});
  }
  stopPreviewObserver();
  state.preview = {
    active: false,
    attaching: false,
    embedded: false,
    hiddenForOverlay: false,
    pid: 0,
    aspect: 0,
    designWidth: 0,
    designHeight: 0
  };
  renderGamePreview();
  if (wasActive) {
    requestAnimationFrame(() => {
      if (state.project && state.scene) resizeCanvas();
    });
  }
}

async function attachGamePreview(pid) {
  if (!state.preview.active || state.preview.pid !== pid) return;
  const bounds = previewBoundsNow();
  if (!bounds) {
    leaveGamePreview();
    toast("The game preview area was not ready.", "error");
    return;
  }
  try {
    const result = await desktop.gamePreview.attach({
      pid,
      bounds,
      scale: window.devicePixelRatio || 1
    });
    if (!state.preview.active || state.preview.pid !== pid) {
      if (result?.ok) desktop.gamePreview.setVisible(false).catch(() => {});
      return;
    }
    if (!result?.ok) throw new Error(result?.error || "Could not embed the game window.");
    state.preview.attaching = false;
    state.preview.embedded = true;
    renderGamePreview();
    await updatePreviewBoundsNow();
    syncPreviewOverlay();
  } catch (error) {
    if (state.preview.active && state.preview.pid === pid) {
      leaveGamePreview();
      toast(
        `The game is running in its own window. ${error.message}`,
        "warn",
        8000
      );
    }
  }
}

function enterGamePreview(pid, windowSize = null) {
  if (!canEmbedGame() || !pid) return;
  stopPreviewObserver();
  const fallbackWindow = state.project?.window;
  const gameWidth = Number(windowSize?.width || fallbackWindow?.width);
  const gameHeight = Number(windowSize?.height || fallbackWindow?.height);
  const aspect = gameWidth > 0 && gameHeight > 0 ? gameWidth / gameHeight : 0;
  state.preview = {
    active: true,
    attaching: true,
    embedded: false,
    hiddenForOverlay: false,
    pid,
    aspect,
    designWidth: gameWidth > 0 ? gameWidth : 0,
    designHeight: gameHeight > 0 ? gameHeight : 0
  };
  renderGamePreview();
  startPreviewObserver();
  // Measure and attach without waiting on requestAnimationFrame. Animation
  // frames can be paused while the window is unfocused/occluded, which would
  // leave the preview hanging.
  attachmentTimer = setTimeout(() => {
    attachmentTimer = 0;
    attachGamePreview(pid);
  }, 30);
}

async function runGame() {
  if (!state.project) {
    openNewProjectModal();
    return;
  }
  if (!state.setup?.love?.found) {
    toast("LÖVE was not found. Open Setup to select its executable.", "warn", 5000);
    openSetupModal();
    return;
  }
  if (state.scene && state.dirty) {
    const saved = await saveScene(true);
    if (!saved) return;
  }
  if (state.preview.active) leaveGamePreview();
  const button = el("btn-run");
  setButtonBusy(button, true, "Starting…");
  try {
    const data = await api("/api/run", { method: "POST", body: {} });
    state.consoleCollapsed = false;
    el("console").classList.remove("is-closed");
    state.running = true;
    renderRunUI();
    const pid = Number(data.run?.pid || 0);
    if (canEmbedGame() && pid > 0) {
      enterGamePreview(pid, data.window || state.project?.window || null);
    }
  } catch (error) {
    toast(error.message, "error", 6500);
  } finally {
    setButtonBusy(button, false);
  }
}

async function stopGame() {
  try {
    await api("/api/stop", { method: "POST", body: {} });
    if (state.preview.active) leaveGamePreview();
  } catch (error) {
    toast(error.message, "error");
  }
}

/* -------------------------------------------------------------------------
   Canvas
   ------------------------------------------------------------------------- */

function setupCanvas() {
  canvas = el("scene-canvas");
  ctx = canvas.getContext("2d");
  if (!canvas || !ctx) return;
  resizeObserver = new ResizeObserver(() => resizeCanvas());
  resizeObserver.observe(el("canvas-shell"));

  canvas.addEventListener("pointerdown", onPointerDown);
  canvas.addEventListener("pointermove", onPointerMove);
  canvas.addEventListener("pointerup", onPointerUp);
  canvas.addEventListener("pointercancel", onPointerUp);
  canvas.addEventListener("wheel", onWheel, { passive: false });
  canvas.addEventListener("contextmenu", (event) => event.preventDefault());
  canvas.addEventListener("dragover", (event) => {
    if (dragHasFiles(event)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
      el("canvas-shell")?.classList.add("is-file-drop");
      return;
    }
    if (event.dataTransfer?.types.includes("application/x-love2d-asset")) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "copy";
    }
  });
  canvas.addEventListener("dragleave", () => {
    el("canvas-shell")?.classList.remove("is-file-drop");
  });
  canvas.addEventListener("drop", onCanvasDrop);
  canvas.addEventListener("pointerleave", () => {
    lastPointerWorld = null;
  });
}

function resizeCanvas() {
  if (!canvas || !state.scene) return;
  const shell = el("canvas-shell");
  const rect = shell.getBoundingClientRect();
  const width = Math.max(1, Math.round(rect.width));
  const height = Math.max(1, Math.round(rect.height));
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const pixelWidth = Math.round(width * dpr);
  const pixelHeight = Math.round(height * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    const previousW = state.canvasW;
    const previousH = state.canvasH;
    let worldCenter = null;
    if (previousW && previousH) {
      worldCenter = {
        x: (previousW / 2 - state.panX) / state.zoom,
        y: (previousH / 2 - state.panY) / state.zoom
      };
    }
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
    state.canvasW = width;
    state.canvasH = height;
    if (worldCenter) {
      state.panX = width / 2 - worldCenter.x * state.zoom;
      state.panY = height / 2 - worldCenter.y * state.zoom;
    } else if (state.viewScene !== state.sceneName) {
      fitScene();
    }
  }
  renderCanvas();
}

function computeFit() {
  if (!state.scene || !state.canvasW || !state.canvasH) return { zoom: 1, panX: 0, panY: 0 };
  const margin = 74;
  const availableW = Math.max(80, state.canvasW - margin);
  const availableH = Math.max(80, state.canvasH - margin);
  const zoom = clamp(Math.min(availableW / state.scene.width, availableH / state.scene.height), 0.05, 2);
  return {
    zoom,
    panX: (state.canvasW - state.scene.width * zoom) / 2,
    panY: (state.canvasH - state.scene.height * zoom) / 2
  };
}

function fitScene() {
  if (!state.scene || !canvas) return;
  const shell = el("canvas-shell");
  const rect = shell.getBoundingClientRect();
  state.canvasW = Math.max(1, Math.round(rect.width));
  state.canvasH = Math.max(1, Math.round(rect.height));
  const fit = computeFit();
  state.zoom = fit.zoom;
  state.fitZoom = fit.zoom;
  state.panX = fit.panX;
  state.panY = fit.panY;
  state.viewScene = state.sceneName;
  renderCanvas();
}

function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  rafHandle = requestAnimationFrame(() => {
    renderQueued = false;
    renderCanvas();
  });
}

function renderCanvas() {
  if (!ctx || !canvas) return;
  if (!state.scene) {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, canvas.width / dpr, canvas.height / dpr);
    return;
  }

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const width = canvas.width / dpr;
  const height = canvas.height / dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const scene = state.scene;
  const zoom = state.zoom;
  const panX = state.panX;
  const panY = state.panY;
  const sceneW = Math.max(1, scene.width || 960);
  const sceneH = Math.max(1, scene.height || 600);

  ctx.save();
  ctx.translate(panX, panY);
  ctx.scale(zoom, zoom);

  ctx.shadowColor = "rgba(0, 0, 0, 0.55)";
  ctx.shadowBlur = 34 / zoom;
  ctx.fillStyle = rgba(scene.background || [0.055, 0.065, 0.085, 1]);
  ctx.fillRect(0, 0, sceneW, sceneH);
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;

  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, sceneW, sceneH);
  ctx.clip();

  if (state.showGrid) drawGrid(sceneW, sceneH);

  for (const entity of sortedEntities()) {
    if (entity.visible === false) continue;
    drawEntity(entity);
  }

  if (state.draft) drawDraft(state.draft);
  ctx.restore();

  ctx.lineWidth = 1 / zoom;
  ctx.strokeStyle = "rgba(255, 255, 255, 0.13)";
  ctx.strokeRect(0, 0, sceneW, sceneH);
  ctx.restore();

  drawSelection();

  const empty = el("canvas-empty");
  if (empty) empty.hidden = sceneEntities().length > 0 || Boolean(state.draft);
  el("canvas-zoom").textContent = `${Math.round(zoom * 100)}%`;
  el("canvas-count").textContent = `${sceneEntities().length} ${sceneEntities().length === 1 ? "entity" : "entities"}`;
}

function drawGrid(width, height) {
  const step = 32;
  const zoom = state.zoom;
  const minor = "rgba(255, 255, 255, 0.035)";
  const major = "rgba(255, 255, 255, 0.065)";
  ctx.lineWidth = 1 / zoom;
  for (let x = 0; x <= width; x += step) {
    ctx.beginPath();
    ctx.strokeStyle = x % (step * 5) === 0 ? major : minor;
    ctx.moveTo(x, 0);
    ctx.lineTo(x, height);
    ctx.stroke();
  }
  for (let y = 0; y <= height; y += step) {
    ctx.beginPath();
    ctx.strokeStyle = y % (step * 5) === 0 ? major : minor;
    ctx.moveTo(0, y);
    ctx.lineTo(width, y);
    ctx.stroke();
  }
}

function drawEntity(entity) {
  const width = Math.max(1, entity.w || 1);
  const height = Math.max(1, entity.h || 1);
  const cx = (entity.x || 0) + width / 2;
  const cy = (entity.y || 0) + height / 2;
  const rotation = ((entity.rotation || 0) * Math.PI) / 180;
  const alpha = clamp(entity.opacity ?? 1, 0, 1) * clamp(entity.color?.[3] ?? 1, 0, 1);

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(rotation);

  if (entity.type === "rectangle") {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = rgba(entity.color);
    ctx.strokeStyle = rgba(entity.color);
    ctx.lineWidth = 1;
    const radius = Math.max(0, Math.min(Number(entity.radius) || 0, width / 2, height / 2));
    roundedRectPath(-width / 2, -height / 2, width, height, radius);
    if (entity.fill !== false) ctx.fill();
    else ctx.stroke();
  } else if (entity.type === "circle") {
    ctx.globalAlpha = alpha;
    ctx.fillStyle = rgba(entity.color);
    ctx.strokeStyle = rgba(entity.color);
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.ellipse(0, 0, width / 2, height / 2, 0, 0, Math.PI * 2);
    if (entity.fill !== false) ctx.fill();
    else ctx.stroke();
  } else if (entity.type === "text") {
    const fontSize = Math.max(4, Number(entity.fontSize) || 16);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = rgba(entity.color);
    ctx.font = `500 ${fontSize}px "Segoe UI", "Helvetica Neue", Arial, sans-serif`;
    ctx.textBaseline = "top";
    const align = entity.align || "left";
    ctx.textAlign = align === "center" ? "center" : align === "right" ? "right" : "left";
    const x = align === "center" ? 0 : align === "right" ? width / 2 : -width / 2;
    const lines = wrapText(ctx, entity.text || "", width);
    const lineHeight = fontSize * 1.24;
    let y = -((lines.length * lineHeight) / 2);
    for (const line of lines) {
      ctx.fillText(line, x, y);
      y += lineHeight;
    }
  } else if (entity.type === "sprite") {
    const image = entity.path ? getImage(entity.path) : null;
    ctx.globalAlpha = alpha;
    if (image) {
      ctx.drawImage(image, -width / 2, -height / 2, width, height);
    } else {
      ctx.fillStyle = "rgba(255, 92, 138, 0.08)";
      ctx.strokeStyle = "rgba(255, 92, 138, 0.45)";
      ctx.lineWidth = 1;
      ctx.setLineDash([6, 4]);
      ctx.fillRect(-width / 2, -height / 2, width, height);
      ctx.strokeRect(-width / 2, -height / 2, width, height);
      ctx.setLineDash([]);
    }
  }
  ctx.restore();
}

function drawDraft(draft) {
  ctx.save();
  ctx.globalAlpha = 0.8;
  const width = Math.abs(draft.w);
  const height = Math.abs(draft.h);
  ctx.strokeStyle = "#ff5c8a";
  ctx.fillStyle = "rgba(255, 92, 138, 0.1)";
  ctx.lineWidth = 1 / state.zoom;
  ctx.setLineDash([6 / state.zoom, 4 / state.zoom]);
  if (draft.type === "circle") {
    ctx.beginPath();
    ctx.ellipse(draft.x + width / 2, draft.y + height / 2, width / 2, height / 2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
  } else {
    ctx.fillRect(draft.x, draft.y, width, height);
    ctx.strokeRect(draft.x, draft.y, width, height);
  }
  ctx.setLineDash([]);
  ctx.restore();
}

function roundedRectPath(x, y, width, height, radius) {
  ctx.beginPath();
  if (radius <= 0) {
    ctx.rect(x, y, width, height);
    return;
  }
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function wrapText(context, text, maxWidth) {
  const paragraphs = String(text ?? "").split(/\r?\n/);
  const lines = [];
  for (const paragraph of paragraphs) {
    if (paragraph === "") {
      lines.push("");
      continue;
    }
    const words = paragraph.split(/\s+/);
    let current = "";
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (context.measureText(candidate).width <= maxWidth || !current) {
        current = candidate;
      } else {
        lines.push(current);
        current = word;
      }
    }
    if (current) lines.push(current);
  }
  return lines.length ? lines : [""];
}

function getImage(assetPath) {
  if (state.images.has(assetPath)) {
    const entry = state.images.get(assetPath);
    return entry.status === "ready" ? entry.image : null;
  }
  const asset = state.assets.find((item) => item.path === assetPath);
  const entry = { status: "loading", image: new Image() };
  state.images.set(assetPath, entry);
  entry.image.onload = () => {
    entry.status = "ready";
    scheduleRender();
  };
  entry.image.onerror = () => {
    entry.status = "error";
    scheduleRender();
  };
  entry.image.src = asset?.url || `/asset?path=${encodeURIComponent(assetPath)}&token=${encodeURIComponent(token)}`;
  return null;
}

function worldToScreen(x, y) {
  return { x: state.panX + x * state.zoom, y: state.panY + y * state.zoom };
}

function screenToWorld(clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: (clientX - rect.left - state.panX) / state.zoom,
    y: (clientY - rect.top - state.panY) / state.zoom
  };
}

function entityCorners(entity) {
  const width = entity.w || 1;
  const height = entity.h || 1;
  const cx = (entity.x || 0) + width / 2;
  const cy = (entity.y || 0) + height / 2;
  const rotation = ((entity.rotation || 0) * Math.PI) / 180;
  const points = [
    [-width / 2, -height / 2, "nw"],
    [width / 2, -height / 2, "ne"],
    [width / 2, height / 2, "se"],
    [-width / 2, height / 2, "sw"]
  ];
  return points.map(([x, y, name]) => {
    const rx = x * Math.cos(rotation) - y * Math.sin(rotation);
    const ry = x * Math.sin(rotation) + y * Math.cos(rotation);
    return { ...worldToScreen(cx + rx, cy + ry), name };
  });
}

function drawSelection() {
  if (!state.selectedId) return;
  const entity = selectedEntity();
  if (!entity) return;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const corners = entityCorners(entity);
  ctx.beginPath();
  corners.forEach((point, index) => {
    if (index === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  });
  ctx.closePath();
  ctx.strokeStyle = "#ff5c8a";
  ctx.lineWidth = 1.5;
  ctx.stroke();

  for (const point of corners) {
    ctx.beginPath();
    ctx.rect(point.x - 4, point.y - 4, 8, 8);
    ctx.fillStyle = "#14161b";
    ctx.fill();
    ctx.strokeStyle = "#ff5c8a";
    ctx.lineWidth = 1.4;
    ctx.stroke();
  }
}

function getResizeHandle(screenX, screenY) {
  const entity = selectedEntity();
  if (!entity) return null;
  for (const point of entityCorners(entity)) {
    if (Math.abs(screenX - point.x) <= 7 && Math.abs(screenY - point.y) <= 7) {
      return point.name;
    }
  }
  return null;
}

function pointInEntity(entity, worldX, worldY) {
  const width = entity.w || 1;
  const height = entity.h || 1;
  const cx = (entity.x || 0) + width / 2;
  const cy = (entity.y || 0) + height / 2;
  const rotation = -(((entity.rotation || 0) * Math.PI) / 180);
  const dx = worldX - cx;
  const dy = worldY - cy;
  const x = dx * Math.cos(rotation) - dy * Math.sin(rotation);
  const y = dx * Math.sin(rotation) + dy * Math.cos(rotation);
  return Math.abs(x) <= width / 2 && Math.abs(y) <= height / 2;
}

function entityAt(worldX, worldY) {
  const entities = sortedEntities();
  for (let index = entities.length - 1; index >= 0; index -= 1) {
    const entity = entities[index];
    if (entity.visible === false) continue;
    if (pointInEntity(entity, worldX, worldY)) return entity;
  }
  return null;
}

function snap(value, disabled = false) {
  if (disabled || !state.snap) return Math.round(value * 10) / 10;
  return Math.round(value / state.snap) * state.snap;
}

function onPointerDown(event) {
  if (!state.scene || !canvas) return;
  if (event.button !== 0 && event.button !== 1) return;
  canvas.focus({ preventScroll: true });
  canvas.setPointerCapture(event.pointerId);
  const world = screenToWorld(event.clientX, event.clientY);
  const rect = canvas.getBoundingClientRect();
  const screenX = event.clientX - rect.left;
  const screenY = event.clientY - rect.top;

  if (event.button === 1 || (event.button === 0 && state.spaceDown)) {
    state.drag = {
      type: "pan",
      startX: event.clientX,
      startY: event.clientY,
      panX: state.panX,
      panY: state.panY
    };
    el("canvas-shell").classList.add("is-panning");
    event.preventDefault();
    return;
  }

  if (state.tool === "select") {
    const handle = getResizeHandle(screenX, screenY);
    const entity = handle ? selectedEntity() : entityAt(world.x, world.y);
    if (handle && entity) {
      pushUndo();
      state.drag = {
        type: "resize",
        handle,
        entityId: entity.id,
        startWorld: world,
        initial: deepClone(entity),
        changed: false
      };
      return;
    }
    if (entity) {
      state.selectedId = entity.id;
      renderInspector();
      renderCanvas();
      pushUndo();
      state.drag = {
        type: "move",
        entityId: entity.id,
        startWorld: world,
        initial: deepClone(entity),
        changed: false
      };
      renderSidebar();
      return;
    }
    state.selectedId = null;
    renderInspector();
    renderSidebar();
    renderCanvas();
    return;
  }

  if (state.tool === "text") {
    pushUndo();
    addEntity({
      type: "text",
      x: snap(world.x, event.altKey),
      y: snap(world.y, event.altKey),
      w: 280,
      h: 48,
      text: "New text",
      fontSize: 24,
      align: "left",
      color: [1, 1, 1, 1],
      layer: 20
    });
    setTool("select");
    return;
  }

  if (state.tool === "sprite") {
    if (!state.selectedAsset || state.selectedAsset.kind !== "image") {
      setMode("assets");
      toast("Pick an image asset first.", "warn");
      return;
    }
    pushUndo();
    placeAsset(state.selectedAsset, world.x, world.y);
    setTool("select");
    return;
  }

  state.draft = {
    type: state.tool === "circle" ? "circle" : "rectangle",
    x: snap(world.x, event.altKey),
    y: snap(world.y, event.altKey),
    w: 0,
    h: 0,
    start: world,
    color: [0.33, 0.42, 0.55, 1],
    fill: true,
    radius: state.tool === "rectangle" ? 4 : 0,
    layer: 5
  };
  scheduleRender();
}

function onPointerMove(event) {
  if (!state.scene) return;
  const world = screenToWorld(event.clientX, event.clientY);
  lastPointerWorld = world;
  el("canvas-coords").textContent = `${Math.round(world.x)}, ${Math.round(world.y)}`;

  const drag = state.drag;
  if (!drag) {
    if (!state.draft) {
      const rect = canvas.getBoundingClientRect();
      const hoverHandle = getResizeHandle(event.clientX - rect.left, event.clientY - rect.top);
      canvas.style.cursor = hoverHandle ? "nwse-resize" : "";
    }
    return;
  }

  if (drag.type === "pan") {
    state.panX = drag.panX + (event.clientX - drag.startX);
    state.panY = drag.panY + (event.clientY - drag.startY);
    scheduleRender();
    return;
  }

  if (drag.type === "move") {
    const entity = sceneEntities().find((item) => item.id === drag.entityId);
    if (!entity) return;
    const dx = world.x - drag.startWorld.x;
    const dy = world.y - drag.startWorld.y;
    if (Math.abs(dx) > 0.2 || Math.abs(dy) > 0.2) drag.changed = true;
    entity.x = snap(drag.initial.x + dx, event.altKey);
    entity.y = snap(drag.initial.y + dy, event.altKey);
    markDirty();
    scheduleRender();
    return;
  }

  if (drag.type === "resize") {
    const entity = sceneEntities().find((item) => item.id === drag.entityId);
    if (!entity) return;
    const dx = world.x - drag.startWorld.x;
    const dy = world.y - drag.startWorld.y;
    const initial = drag.initial;
    let x = initial.x;
    let y = initial.y;
    let w = initial.w;
    let h = initial.h;
    if (drag.handle.includes("e")) w = initial.w + dx;
    if (drag.handle.includes("s")) h = initial.h + dy;
    if (drag.handle.includes("w")) {
      x = initial.x + dx;
      w = initial.w - dx;
    }
    if (drag.handle.includes("n")) {
      y = initial.y + dy;
      h = initial.h - dy;
    }
    entity.x = Math.round(x);
    entity.y = Math.round(y);
    entity.w = Math.max(4, Math.round(w));
    entity.h = Math.max(4, Math.round(h));
    drag.changed = true;
    markDirty();
    scheduleRender();
    return;
  }
}

function onPointerUp(event) {
  if (!canvas) return;
  try {
    canvas.releasePointerCapture(event.pointerId);
  } catch {
    // Pointer may already be released.
  }
  el("canvas-shell").classList.remove("is-panning");

  if (state.draft) {
    const draft = state.draft;
    state.draft = null;
    const x = Math.min(draft.x, draft.x + draft.w);
    const y = Math.min(draft.y, draft.y + draft.h);
    const w = Math.abs(draft.w);
    const h = Math.abs(draft.h);
    pushUndo();
    addEntity({
      type: draft.type,
      x: Math.round(x),
      y: Math.round(y),
      w: Math.round(w || 100),
      h: Math.round(h || 100),
      fill: true,
      radius: draft.radius || 0,
      color: draft.color,
      layer: 5
    });
    state.draft = null;
    scheduleRender();
  }

  const drag = state.drag;
  state.drag = null;
  if (drag && (drag.type === "move" || drag.type === "resize") && drag.changed) {
    markDirty();
    scheduleSave();
    renderInspector();
    renderSidebar();
  }
  scheduleRender();
}

function onWheel(event) {
  if (!state.scene) return;
  event.preventDefault();
  const rect = canvas.getBoundingClientRect();
  const sx = event.clientX - rect.left;
  const sy = event.clientY - rect.top;
  const worldX = (sx - state.panX) / state.zoom;
  const worldY = (sy - state.panY) / state.zoom;
  const factor = Math.exp(-event.deltaY * 0.0014);
  const nextZoom = clamp(state.zoom * factor, 0.05, 8);
  state.zoom = nextZoom;
  state.panX = sx - worldX * nextZoom;
  state.panY = sy - worldY * nextZoom;
  state.viewScene = state.sceneName;
  renderCanvas();
}

function dragHasFiles(event) {
  return Array.from(event.dataTransfer?.types || []).includes("Files");
}

async function onCanvasDrop(event) {
  event.preventDefault();
  el("canvas-shell")?.classList.remove("is-file-drop");
  if (!state.scene) return;

  const files = Array.from(event.dataTransfer?.files || []);
  if (files.length) {
    const world = screenToWorld(event.clientX, event.clientY);
    const result = await uploadAssets(files, { notify: false });
    const images = (result.assets || [])
      .map((asset) => state.assets.find((item) => item.path === asset.path) || asset)
      .filter((asset) => asset.kind === "image");
    if (images.length) {
      pushUndo();
      images.forEach((asset, index) => {
        placeAsset(asset, world.x + index * 32, world.y + index * 32);
      });
      toast(
        `Imported and placed ${images.length} image${images.length === 1 ? "" : "s"}.`,
        "success",
        2600
      );
    } else if (result.imported) {
      toast("Assets imported. Drop an image to place it in the scene.", "success", 3200);
    }
    return;
  }

  const path = event.dataTransfer?.getData("application/x-love2d-asset");
  if (!path) return;
  const asset = state.assets.find((item) => item.path === path);
  if (!asset || asset.kind !== "image") return;
  const world = screenToWorld(event.clientX, event.clientY);
  pushUndo();
  placeAsset(asset, world.x, world.y);
}

function updateCanvasDraft(event) {
  if (!state.draft) return;
  const world = screenToWorld(event.clientX, event.clientY);
  const x = snap(state.draft.start.x, event.altKey);
  const y = snap(state.draft.start.y, event.altKey);
  let width = world.x - state.draft.start.x;
  let height = world.y - state.draft.start.y;
  if (event.shiftKey && state.draft.type !== "text") {
    const size = Math.max(Math.abs(width), Math.abs(height));
    width = Math.sign(width || 1) * size;
    height = Math.sign(height || 1) * size;
  }
  state.draft.x = width < 0 ? snap(world.x, event.altKey) : x;
  state.draft.y = height < 0 ? snap(world.y, event.altKey) : y;
  state.draft.w = width;
  state.draft.h = height;
  scheduleRender();
}

function placeAsset(asset, worldX, worldY) {
  let width = Number(asset.width) || 96;
  let height = Number(asset.height) || 96;
  const maxSide = 320;
  if (width > maxSide || height > maxSide) {
    const scale = maxSide / Math.max(width, height);
    width *= scale;
    height *= scale;
  }
  addEntity({
    type: "sprite",
    x: snap(worldX - width / 2),
    y: snap(worldY - height / 2),
    w: Math.round(width),
    h: Math.round(height),
    path: asset.path,
    color: [1, 1, 1, 1],
    layer: 10
  });
}

function addEntity(partial) {
  if (!state.scene) return null;
  const entity = {
    id: newEntityId(),
    name: partial.name || (partial.type === "text" ? "Text" : partial.type === "sprite" ? "Sprite" : "Entity"),
    type: partial.type || "rectangle",
    x: Math.round(partial.x || 0),
    y: Math.round(partial.y || 0),
    w: Math.max(1, Math.round(partial.w || 64)),
    h: Math.max(1, Math.round(partial.h || 64)),
    rotation: partial.rotation || 0,
    opacity: partial.opacity ?? 1,
    layer: partial.layer ?? 0,
    visible: true,
    color: partial.color || [1, 1, 1, 1],
    ...partial
  };
  state.scene.entities.push(entity);
  state.selectedId = entity.id;
  state.scene.name = state.scene.name || state.sceneName;
  markDirty();
  renderInspector();
  renderSidebar();
  scheduleRender();
  scheduleSave();
  return entity;
}

function duplicateSelected() {
  const entity = selectedEntity();
  if (!entity) return;
  pushUndo();
  const copy = deepClone(entity);
  copy.id = newEntityId();
  copy.name = `${entity.name || entity.type} copy`;
  copy.x += 16;
  copy.y += 16;
  state.scene.entities.push(copy);
  state.selectedId = copy.id;
  markDirty();
  renderInspector();
  renderSidebar();
  scheduleRender();
  scheduleSave();
}

function deleteSelected() {
  if (!state.selectedId) return;
  const index = sceneEntities().findIndex((entity) => entity.id === state.selectedId);
  if (index < 0) return;
  pushUndo();
  state.scene.entities.splice(index, 1);
  state.selectedId = null;
  markDirty();
  renderInspector();
  renderSidebar();
  scheduleRender();
  scheduleSave();
}

function nudgeSelected(dx, dy) {
  const entity = selectedEntity();
  if (!entity) return;
  pushUndo();
  entity.x = Math.round((entity.x || 0) + dx);
  entity.y = Math.round((entity.y || 0) + dy);
  markDirty();
  renderInspector();
  scheduleRender();
  scheduleSave();
}

function setTool(tool) {
  state.tool = tool;
  $$(".tool-btn").forEach((button) => button.classList.toggle("is-active", button.dataset.tool === tool));
  const shell = el("canvas-shell");
  if (shell) shell.className = `canvas-shell tool-${tool}`;
  updateCanvasHint();
  if (tool === "sprite" && !state.selectedAsset) setMode("assets");
}

/* -------------------------------------------------------------------------
   Undo / save
   ------------------------------------------------------------------------- */

function pushUndo(snapshot = null) {
  if (!state.scene) return;
  state.undo.push(deepClone(snapshot || state.scene));
  if (state.undo.length > MAX_HISTORY) state.undo.shift();
  state.redo = [];
  renderSceneToolbar();
}

function pushFieldUndo(snapshot) {
  if (!snapshot || !state.scene) return;
  if (JSON.stringify(snapshot) === JSON.stringify(state.scene)) return;
  state.undo.push(deepClone(snapshot));
  if (state.undo.length > MAX_HISTORY) state.undo.shift();
  state.redo = [];
  renderSceneToolbar();
}

function undo() {
  if (!state.scene || !state.undo.length) return;
  const snapshot = state.undo.pop();
  state.redo.push(deepClone(state.scene));
  state.scene = snapshot;
  if (!selectedEntity()) state.selectedId = null;
  markDirty();
  renderAll();
  scheduleRender();
  scheduleSave();
}

function redo() {
  if (!state.scene || !state.redo.length) return;
  const snapshot = state.redo.pop();
  state.undo.push(deepClone(state.scene));
  state.scene = snapshot;
  if (!selectedEntity()) state.selectedId = null;
  markDirty();
  renderAll();
  scheduleRender();
  scheduleSave();
}

function markDirty() {
  state.dirty = true;
  renderSaveStatus();
}

function scheduleSave() {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => {
    if (state.dirty) saveScene(true);
  }, 1100);
}

async function saveScene(silent = false) {
  if (!state.scene || !state.project) return true;
  if (state.saveInFlight) {
    state.saveAgain = true;
    return state.saveInFlight;
  }
  const payload = deepClone(state.scene);
  delete payload.file;
  state.saveInFlight = (async () => {
    state.saving = true;
    renderSaveStatus();
    try {
      const result = await api(`/api/scene?name=${encodeURIComponent(state.sceneName)}`, {
        method: "PUT",
        body: { scene: payload }
      });
      state.scene = result.scene;
      state.dirty = false;
      if (!state.sceneName && result.scene.name) state.sceneName = result.scene.name;
      renderSaveStatus();
      if (!silent) toast("Scene saved.", "success", 1800);
      return true;
    } catch (error) {
      state.dirty = true;
      renderSaveStatus();
      toast(error.message, "error", 6500);
      return false;
    } finally {
      state.saving = false;
      state.saveInFlight = null;
      renderSaveStatus();
      if (state.saveAgain) {
        state.saveAgain = false;
        if (state.dirty) saveScene(true);
      }
    }
  })();
  return state.saveInFlight;
}

/* -------------------------------------------------------------------------
   Scene loading / switching
   ------------------------------------------------------------------------- */

async function loadScene(name, { fit = false, silent = false } = {}) {
  if (!state.project) return;
  const clean = sceneDisplayName(name);
  if (!clean) return;
  if (state.scene && state.dirty) {
    const saved = await saveScene(true);
    if (!saved) return;
  }
  try {
    const result = await api(`/api/scene?name=${encodeURIComponent(clean)}`);
    state.scene = result.scene;
    state.sceneName = result.scene.name || clean;
    state.selectedId = null;
    state.undo = [];
    state.redo = [];
    state.viewScene = "";
    state.draft = null;
    state.drag = null;
    state.fieldSnapshot = null;
    state.dirty = false;
    renderSaveStatus();
    try {
      localStorage.setItem(`love2d-studio:scene:${state.project.path}`, state.sceneName);
    } catch {
      // Storage may be unavailable.
    }
    renderAll();
    if (fit) {
      requestAnimationFrame(() => {
        resizeCanvas();
        fitScene();
      });
    }
  } catch (error) {
    if (!silent) toast(error.message, "error");
    state.scene = null;
    state.sceneName = clean;
    renderAll();
  }
}

async function switchScene(name) {
  if (!name || name === state.sceneName) return;
  await loadScene(name, { fit: true });
}

async function refreshScenes() {
  if (!state.project) return;
  try {
    const data = await api("/api/scenes");
    state.scenes = data.scenes || [];
    if (!state.sceneName && state.scenes.length) {
      await loadScene(state.scenes[0].name, { fit: true });
    } else {
      renderAll();
    }
  } catch (error) {
    toast(error.message, "error");
  }
}

async function refreshAssets() {
  if (!state.project) return;
  try {
    const data = await api("/api/assets");
    state.assets = data.assets || [];
    renderSidebar();
    renderCanvas();
  } catch (error) {
    toast(error.message, "error");
  }
}

function updateField(target, { final = false } = {}) {
  if (!state.scene) return;
  const scope = target.dataset.scope || (state.selectedId ? "entity" : "scene");
  const object = scope === "scene" ? state.scene : selectedEntity();
  if (!object) return;
  const field = target.dataset.field;
  if (!field) return;
  let value;
  if (target.type === "checkbox") value = target.checked;
  else if (target.type === "number" || target.type === "range") value = Number(target.value);
  else value = target.value;

  const colorKey = scope === "scene" ? "background" : "color";
  const currentColor = object[colorKey] || [1, 1, 1, 1];
  if (field === "color") {
    const rgb = hexToRgb(value);
    if (!rgb) return;
    object[colorKey] = [rgb[0], rgb[1], rgb[2], currentColor[3] ?? 1];
  } else if (field === "alpha") {
    const alpha = clamp(Number(value) || 0, 0, 1);
    object[colorKey] = [currentColor[0] ?? 1, currentColor[1] ?? 1, currentColor[2] ?? 1, alpha];
  } else if (field === "properties.solid") {
    object.properties = object.properties || {};
    object.properties.solid = Boolean(value);
  } else if (field === "width" || field === "height") {
    object[field] = Math.max(1, Math.round(Number(value) || 1));
  } else if (field === "w" || field === "h" || field === "x" || field === "y" || field === "layer" || field === "fontSize") {
    object[field] = field === "w" || field === "h"
      ? Math.max(1, Math.round(Number(value) || 1))
      : field === "fontSize"
        ? Math.max(4, Math.min(512, Math.round(Number(value) || 16)))
        : Math.round(Number(value) || 0);
  } else if (field === "opacity") {
    object.opacity = clamp(Number(value) || 0, 0, 1);
  } else if (field === "rotation") {
    object.rotation = Number(value) || 0;
  } else if (field === "name") {
    object.name = String(value).slice(0, 120);
  } else {
    object[field] = value;
  }

  markDirty();
  if (final) {
    if (state.fieldSnapshot) {
      pushFieldUndo(state.fieldSnapshot);
      state.fieldSnapshot = document.activeElement === target ? deepClone(state.scene) : null;
    }
    if (field === "width" || field === "height") {
      state.viewScene = "";
      requestAnimationFrame(() => fitScene());
    }
    scheduleSave();
    renderCanvas();
    renderSidebar();
    if (field === "name") renderInspector();
  } else {
    if (field === "opacity") {
      const label = el("opacity-value");
      if (label) label.textContent = `${Math.round((object.opacity ?? 1) * 100)}%`;
    }
    scheduleRender();
    scheduleSave();
  }
}

/* -------------------------------------------------------------------------
   Modals
   ------------------------------------------------------------------------- */

function closeModal() {
  const dialog = el("modal-dialog");
  if (dialog?.open) dialog.close();
}

function openModal(contentHtml, { wide = false } = {}) {
  const dialog = el("modal-dialog");
  dialog.classList.toggle("modal-wide", Boolean(wide));
  dialog.innerHTML = contentHtml;
  if (!dialog.open) dialog.showModal();
  syncPreviewOverlay();
  const autofocus = dialog.querySelector("[autofocus]");
  if (autofocus) setTimeout(() => autofocus.focus(), 20);
  return dialog;
}

function modalError(message) {
  const slot = $("#modal-error");
  if (!slot) {
    toast(message, "error");
    return;
  }
  slot.textContent = message;
  slot.hidden = false;
}

function modalHead(iconName, title, subtitle) {
  return `
    <div class="modal-head">
      <span class="modal-head-icon">${icon(iconName)}</span>
      <div>
        <h2>${escapeHtml(title)}</h2>
        ${subtitle ? `<p>${escapeHtml(subtitle)}</p>` : ""}
      </div>
      <button class="modal-close" type="button" data-action="close-modal" aria-label="Close">
        ${icon("x")}
      </button>
    </div>
  `;
}

function openNewProjectModal() {
  const parent = state.setup?.projectsDir || "";
  const templates = state.templates.length ? state.templates : [
    { id: "starter", name: "Starter platformer", description: "A playable scene and collision." }
  ];
  if (!templates.some((item) => item.id === state.selectedTemplate)) {
    state.selectedTemplate = templates[0].id;
  }
  const templateHtml = templates.map((template) => `
    <button class="template-option ${template.id === state.selectedTemplate ? "is-selected" : ""}"
      type="button" data-template="${escapeAttr(template.id)}">
      <span class="template-icon">${icon(template.id === "starter" ? "layers" : "code")}</span>
      <strong>${escapeHtml(template.name)}</strong>
      <span>${escapeHtml(template.description)}</span>
    </button>
  `).join("");
  openModal(`
    <form class="modal-shell" data-form="new-project">
      ${modalHead("plus", "New Love2D project", "Scaffold a project with the Studio runtime and Zed tasks.")}
      <div class="modal-body">
        <div id="modal-error" class="modal-error" hidden></div>
        <div class="form-stack">
          <div class="form-row">
            <div class="form-field">
              <label for="new-project-name">Project name</label>
              <input id="new-project-name" name="name" required maxlength="80" value="My Love2D Game" autofocus>
            </div>
            <div class="form-field">
              <label for="new-project-parent">Location</label>
              <div class="input-row">
                <input id="new-project-parent" name="parentDir" required value="${escapeAttr(parent)}" spellcheck="false">
                ${browseButton("browse-project-parent")}
              </div>
            </div>
          </div>
          <div>
            <div class="field-label" style="color:var(--text-dim);font-size:11px;font-weight:600;margin-bottom:5px">Template</div>
            <div class="template-grid">${templateHtml}</div>
          </div>
          <div class="form-row">
            <div class="form-field">
              <label for="new-project-width">Window width</label>
              <input id="new-project-width" name="width" type="number" min="320" max="3840" value="960">
            </div>
            <div class="form-field">
              <label for="new-project-height">Window height</label>
              <input id="new-project-height" name="height" type="number" min="240" max="2160" value="600">
            </div>
          </div>
          <div class="form-help">
            The project is created in a new folder. The starter template includes a
            playable platformer scene; the empty template gives you only the basics.
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <span class="footer-note">The Studio writes Zed tasks and LÖVE type definitions automatically.</span>
        <button class="btn btn-ghost" type="button" data-action="close-modal">Cancel</button>
        <button class="btn btn-primary" type="submit" data-submit>Create project</button>
      </div>
    </form>
  `, { wide: true });
}

function openOpenProjectModal() {
  const recentRows = state.recent.length
    ? state.recent.map((project) => `
        <button class="recent-modal-row" type="button" data-action="open-recent" data-path="${escapeAttr(project.path)}">
          <span class="recent-icon">${icon("folder")}</span>
          <span class="recent-body">
            <span class="recent-name">${escapeHtml(project.name || project.path)}</span>
            <span class="recent-path">${escapeHtml(project.path)}</span>
          </span>
          ${icon("chevron", "icon small")}
        </button>
      `).join("")
    : `<div class="recent-empty">No recent projects yet.</div>`;
  openModal(`
    <form class="modal-shell" data-form="open-project">
      ${modalHead("folder", "Open a project", "Choose an existing Love2D folder or resume a recent project.")}
      <div class="modal-body">
        <div id="modal-error" class="modal-error" hidden></div>
        <div class="form-field">
          <label for="open-project-path">Project folder</label>
          <div class="input-row">
            <input id="open-project-path" name="path" required placeholder="C:\\Users\\you\\Documents\\My Game"
              value="${escapeAttr(state.project?.path || "")}" spellcheck="false" autofocus>
            ${browseButton("browse-open-project")}
          </div>
          <div class="form-help">
            Opening a folder adds Love2D Studio metadata, scenes, and Zed tasks if they
            are missing. Existing files are not overwritten.
          </div>
        </div>
        <div class="recent-modal-list">
          <h3>Recent projects</h3>
          ${recentRows}
        </div>
      </div>
      <div class="modal-footer">
        <span class="footer-note">Ctrl+click a recent project to open its folder in Explorer.</span>
        <button class="btn btn-ghost" type="button" data-action="close-modal">Cancel</button>
        <button class="btn btn-primary" type="submit" data-submit>Open project</button>
      </div>
    </form>
  `);
}

function openNewSceneModal() {
  if (!state.project) return;
  const width = state.scene?.width || 960;
  const height = state.scene?.height || 600;
  openModal(`
    <form class="modal-shell" data-form="new-scene">
      ${modalHead("layers", "New scene", "Scenes are plain JSON files stored in scenes/.")}
      <div class="modal-body">
        <div id="modal-error" class="modal-error" hidden></div>
        <div class="form-stack">
          <div class="form-field">
            <label for="new-scene-name">Scene name</label>
            <input id="new-scene-name" name="name" required pattern="[A-Za-z0-9 _-]+" maxlength="60"
              placeholder="level-2" autofocus>
            <div class="form-help">Letters, numbers, spaces, dashes, and underscores.</div>
          </div>
          <div class="form-row">
            <div class="form-field">
              <label for="new-scene-width">Width</label>
              <input id="new-scene-width" name="width" type="number" min="1" max="16384" value="${width}">
            </div>
            <div class="form-field">
              <label for="new-scene-height">Height</label>
              <input id="new-scene-height" name="height" type="number" min="1" max="16384" value="${height}">
            </div>
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" type="button" data-action="close-modal">Cancel</button>
        <button class="btn btn-primary" type="submit" data-submit>Create scene</button>
      </div>
    </form>
  `);
}

function openConfirmModal({ title, body, confirmLabel = "Delete", action, data = {} }) {
  const attrs = Object.entries(data).map(([key, value]) =>
    `data-${escapeAttr(key)}="${escapeAttr(value)}"`).join(" ");
  openModal(`
    <div class="modal-shell">
      ${modalHead("alert", title, "")}
      <div class="modal-body">
        <p class="confirm-copy">${body}</p>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" type="button" data-action="close-modal">Cancel</button>
        <button class="btn btn-danger" type="button" data-action="${escapeAttr(action)}" ${attrs}>${escapeHtml(confirmLabel)}</button>
      </div>
    </div>
  `);
}

function openSetupModal() {
  const setup = state.setup || {};
  const deepseek = setup.deepseek || {};
  const love = setup.love || {};
  const zed = setup.zed || {};
  const keyStatus = deepseek.configured
    ? `<span class="setup-badge ok">${icon("check", "icon tiny")} configured</span>`
    : `<span class="setup-badge bad">${icon("alert", "icon tiny")} missing</span>`;
  const zedStatus = zed.installed
    ? `<span class="setup-badge ok">${icon("check", "icon tiny")} installed</span>`
    : `<span class="setup-badge bad">not found</span>`;
  const agentStatus = zed.configured
    ? `<span class="setup-badge ok">${icon("check", "icon tiny")} ready</span>`
    : `<span class="setup-badge neutral">not installed</span>`;
  const loveStatus = love.found
    ? `<span class="setup-badge ok">${icon("check", "icon tiny")} ready</span>`
    : `<span class="setup-badge bad">not found</span>`;

  openModal(`
    <form class="modal-shell" data-form="setup">
      ${modalHead("settings", "Setup", "Connect LÖVE, Zed, and DeepSeek. Settings stay on this machine.")}
      <div class="modal-body">
        <div id="modal-error" class="modal-error" hidden></div>

        <div class="setup-section">
          <div class="setup-section-head">
            <span class="setup-section-icon">${icon("sparkle")}</span>
            <div><h3>DeepSeek assistant</h3><p>Used by the built-in desktop chat and the Love2D Assistant in Zed.</p></div>
            ${keyStatus}
          </div>
          <div class="setup-section-body">
            <div class="form-stack">
              <div class="form-field">
                <label for="setup-api-key">API key</label>
                <input id="setup-api-key" name="apiKey" type="password" autocomplete="off"
                  placeholder="${deepseek.configured ? "Key saved — leave blank to keep it" : "sk-…"}">
                <div class="form-help">
                  Get a key at <a href="https://platform.deepseek.com/api_keys" target="_blank" rel="noreferrer">platform.deepseek.com</a>.
                  The key is stored in the Studio's local config, never in a project. You can also
                  set <code>DEEPSEEK_API_KEY</code> in the environment instead.
                </div>
              </div>
              <div class="form-row">
                <div class="form-field">
                  <label for="setup-model">Model</label>
                  <input id="setup-model" name="model" list="deepseek-models" value="${escapeAttr(deepseek.model || "deepseek-flash")}">
                  <datalist id="deepseek-models">
                    <option value="deepseek-flash">
                    <option value="deepseek-v4-pro">
                  </datalist>
                </div>
                <div class="form-field">
                  <label for="setup-base-url">API base URL</label>
                  <input id="setup-base-url" name="baseUrl" value="${escapeAttr(deepseek.baseUrl || "https://api.deepseek.com")}" spellcheck="false">
                </div>
              </div>
            </div>
            ${deepseek.configured ? `<div class="setup-actions"><button class="btn btn-small btn-ghost" type="button" data-action="clear-api-key">Remove saved key</button></div>` : ""}
          </div>
        </div>

        <div class="setup-section">
          <div class="setup-section-head">
            <span class="setup-section-icon">${icon("zed")}</span>
            <div><h3>Zed integration</h3><p>Agent server and LÖVE snippets.</p></div>
            ${agentStatus}
          </div>
          <div class="setup-section-body">
            <div class="setup-status-line">
              <span>Zed</span>${zedStatus}
            </div>
            <div class="setup-status-line">
              <span>Settings</span><code title="${escapeAttr(zed.settingsPath || "")}">${escapeHtml(zed.settingsPath || "not detected")}</code>
            </div>
            <div class="setup-status-line">
              <span>Agent</span>
              <span>${zed.configured ? "Love2D Assistant registered" : "Not registered yet"}</span>
            </div>
            <div class="setup-actions">
              <button class="btn btn-small btn-secondary" type="button" data-action="install-zed">
                ${icon("sparkle")} ${zed.configured ? "Reinstall agent + snippets" : "Install agent + snippets"}
              </button>
              <button class="btn btn-small btn-ghost" type="button" data-action="open-zed">
                ${icon("zed")} Open Zed
              </button>
            </div>
            <div class="form-help" style="margin-top:10px">
              The desktop AI button works without Zed. For Zed, restart it, open the
              Agent panel, and choose <strong>Love2D Assistant</strong>. The key is
              read locally by the assistant processes; it is not sent to Zed or saved
              in Zed settings.
            </div>
            <details style="margin-top:9px">
              <summary style="cursor:pointer;color:var(--muted);font-size:10.5px">Preview generated settings</summary>
              <pre class="setup-code">${escapeHtml(zed.preview || "")}</pre>
            </details>
          </div>
        </div>

        <div class="setup-section">
          <div class="setup-section-head">
            <span class="setup-section-icon">${icon("play")}</span>
            <div><h3>LÖVE runtime</h3><p>Run and capture the game console.</p></div>
            ${loveStatus}
          </div>
          <div class="setup-section-body">
            <div class="form-field">
              <label for="setup-love-path">Executable</label>
              <div class="input-row">
                <input id="setup-love-path" name="lovePath" value="${escapeAttr(love.path || love.configPath || "")}" spellcheck="false">
                ${desktop ? browseButton("browse-love-path", "Choose") : ""}
              </div>
              <div class="form-help">
                ${escapeHtml(love.version || (love.found ? "LÖVE is ready." : "Install LÖVE or point to love.exe / lovec.exe."))}
                The console build <code>lovec.exe</code> is preferred.
              </div>
            </div>
          </div>
        </div>

        <div class="setup-section">
          <div class="setup-section-head">
            <span class="setup-section-icon">${icon("folder")}</span>
            <div><h3>Projects</h3><p>Where the project wizard creates new games.</p></div>
          </div>
          <div class="setup-section-body">
            <div class="form-field">
              <label for="setup-projects-dir">Projects folder</label>
              <div class="input-row">
                <input id="setup-projects-dir" name="projectsDir" value="${escapeAttr(setup.projectsDir || "")}" spellcheck="false">
                ${browseButton("browse-projects-dir")}
              </div>
            </div>
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <span class="footer-note">Config: <code>${escapeHtml(setup.configFile || "")}</code></span>
        <button class="btn btn-ghost" type="button" data-action="close-modal">Close</button>
        <button class="btn btn-primary" type="submit" data-submit>Save settings</button>
      </div>
    </form>
  `, { wide: true });
}

/* -------------------------------------------------------------------------
   Build & export
   ------------------------------------------------------------------------- */

function buildFormatIcon(format) {
  if (format === "love") return "code";
  if (format === "windows") return "folder";
  return "package";
}

function buildFormatLabel(info) {
  return info?.formats?.find((format) => format.id === state.buildFormat)?.name || "Windows ZIP";
}

function buildFormatFooter(info) {
  const love = info?.love?.version ? `LÖVE ${info.love.version}` : "LÖVE runtime";
  return `${buildFormatLabel(info)} · ${love}`;
}

async function openBuildModal() {
  if (!state.project) return;
  let info;
  try {
    const data = await api("/api/build/info");
    info = data.build;
  } catch (error) {
    toast(error.message, "error", 6000);
    return;
  }
  state.buildInfo = info;
  const formats = Array.isArray(info.formats) ? info.formats : [];
  const selected = formats.find((format) => format.id === state.buildFormat);
  const selectedAvailable = selected && (!selected.requiresLove || info.love?.windowsReady);
  if (!selectedAvailable) {
    state.buildFormat = info.love?.windowsReady ? "windows-zip" : "love";
  }
  if (!formats.some((format) => format.id === state.buildFormat)) {
    state.buildFormat = formats[0]?.id || "love";
  }
  if (!state.buildOutputDir) {
    state.buildOutputDir = info.defaultOutputDir || `${state.project.path}\\build`;
  }
  renderBuildModal(info);
}

function renderBuildModal(info) {
  const formats = Array.isArray(info.formats) ? info.formats : [];
  const windowsReady = Boolean(info.love?.windowsReady);
  const hasMain = Boolean(info.project?.hasMain);
  const formatCards = formats.map((format) => {
    const disabled = format.requiresLove && !windowsReady;
    const selected = format.id === state.buildFormat;
    return `
      <button class="build-format-card ${selected ? "is-selected" : ""} ${disabled ? "is-disabled" : ""}"
        type="button" data-build-format="${escapeAttr(format.id)}"
        aria-pressed="${selected ? "true" : "false"}" ${disabled ? "disabled" : ""}>
        <span class="build-format-head">
          <span class="build-format-icon">${icon(buildFormatIcon(format.id))}</span>
          ${format.recommended ? `<span class="build-format-badge">Recommended</span>` : ""}
        </span>
        <strong>${escapeHtml(format.name)}</strong>
        <span class="build-format-desc">${escapeHtml(format.description)}</span>
      </button>
    `;
  }).join("");

  const missingLove = windowsReady
    ? ""
    : `<div class="setup-warning build-warning">${icon("alert")}<span>
        ${info.love?.found
          ? "LÖVE's Windows runtime DLLs were not found, so Windows builds are unavailable. Portable .love still works."
          : "LÖVE for Windows was not found. Install LÖVE 11.5 or set love.exe in Setup to create playable Windows builds. Portable .love still works."}
      </span></div>`;
  const missingMain = hasMain
    ? ""
    : `<div class="setup-warning build-warning">${icon("alert")}<span>
        This project has no <code>main.lua</code>. Ask the AI or add one before building.
      </span></div>`;

  openModal(`
    <form class="modal-shell" data-form="build">
      ${modalHead("package", "Build & export", `Package ${info.project?.name || state.project.name} for players.`)}
      <div class="modal-body">
        <div id="modal-error" class="modal-error" hidden></div>
        <div class="build-summary">
          <span class="build-summary-icon">${icon("package")}</span>
          <div>
            <strong>${escapeHtml(info.project?.name || state.project.name)}</strong>
            <span>${escapeHtml(state.project.path)}</span>
          </div>
          <span class="setup-badge ${windowsReady ? "ok" : "bad"}">${windowsReady ? "Windows ready" : "LÖVE not ready"}</span>
        </div>
        ${missingMain}
        ${missingLove}
        <div class="build-field-label">Format</div>
        <div class="build-format-grid">${formatCards}</div>
        <div class="form-field build-output-field">
          <label for="build-output">Output folder</label>
          <div class="input-row">
            <input id="build-output" name="outputDir" required spellcheck="false"
              value="${escapeAttr(state.buildOutputDir)}">
            ${browseButton("browse-build-output", "Choose")}
          </div>
          <div class="form-help">
            Builds are written to this folder. Existing builds are kept with a numbered suffix.
          </div>
        </div>
        <div class="build-note">
          ${icon("check", "icon small")}
          <span>Editor metadata, runtime logs, <code>.zed</code>, <code>.git</code>, and <code>node_modules</code> are left out. Your Lua source, scenes, and assets are included.</span>
        </div>
      </div>
      <div class="modal-footer">
        <span class="footer-note" id="build-format-note">${escapeHtml(buildFormatFooter(info))}</span>
        <button class="btn btn-ghost" type="button" data-action="close-modal">Cancel</button>
        <button class="btn btn-primary" type="submit" data-submit ${hasMain ? "" : "disabled"}>
          ${icon("package")} Build game
        </button>
      </div>
    </form>
  `, { wide: true });
}

function buildShareHint(format) {
  if (format === "love") {
    return "Share the .love file. Players need LÖVE 11.5 installed to open it.";
  }
  if (format === "windows") {
    return "Share the whole folder. Keep the .exe, DLLs, and license.txt together.";
  }
  return "Share the ZIP. Players can unzip it and run the .exe; keep the DLLs beside it.";
}

function showBuildResult(build) {
  state.lastBuild = build;
  const artifacts = Array.isArray(build.artifacts) ? build.artifacts : [];
  const rows = artifacts.map((artifact) => {
    const iconName = artifact.kind === "zip" ? "package" : artifact.kind === "folder" ? "folder" : "code";
    return `
      <div class="build-artifact">
        <span class="build-artifact-icon">${icon(iconName)}</span>
        <span class="build-artifact-body">
          <strong>${escapeHtml(artifact.label)}</strong>
          <span class="build-artifact-path" title="${escapeAttr(artifact.path)}">${escapeHtml(artifact.path)}</span>
        </span>
        <span class="build-artifact-size">${escapeHtml(formatBytes(artifact.bytes))}</span>
      </div>
    `;
  }).join("");
  const warnings = Array.isArray(build.warnings) && build.warnings.length
    ? `<div class="setup-warning build-warning">${icon("alert")}<span>${build.warnings.map(escapeHtml).join("<br>")}</span></div>`
    : "";
  openModal(`
    <div class="modal-shell">
      ${modalHead("check", "Build complete", `${build.formatLabel} · ${build.source?.files || 0} source files`)}
      <div class="modal-body">
        <div class="build-success-banner">
          <span class="build-success-icon">${icon("check")}</span>
          <div>
            <strong>${escapeHtml(build.name)}</strong>
            <span>Ready in ${escapeHtml(build.outputDir)}</span>
          </div>
        </div>
        <div class="build-artifacts">${rows}</div>
        ${warnings}
        <div class="build-result-note">
          ${icon("package", "icon small")}
          <span>${escapeHtml(buildShareHint(build.format))}</span>
        </div>
        <div class="build-meta">
          <span>Source: ${escapeHtml(formatBytes(build.source?.bytes || 0))}</span>
          <span>Built ${escapeHtml(timeLabel(build.builtAt))}</span>
        </div>
      </div>
      <div class="modal-footer build-result-footer">
        <span class="footer-note">You can keep building while the Studio is open.</span>
        <button class="btn btn-ghost" type="button" data-action="build-again">Build again</button>
        <button class="btn btn-secondary" type="button" data-action="reveal-build" data-path="${escapeAttr(build.outputDir)}">
          ${icon("folder")} Open output folder
        </button>
        <button class="btn btn-primary" type="button" data-action="close-modal">Done</button>
      </div>
    </div>
  `, { wide: true });
}

async function revealBuildOutput(buildPath) {
  try {
    await api("/api/build/reveal", { method: "POST", body: { path: buildPath } });
  } catch (error) {
    toast(error.message, "error", 5000);
  }
}

async function submitBuild(form) {
  const submit = form.querySelector("[data-submit]");
  const errorSlot = form.querySelector("#modal-error");
  const formData = new FormData(form);
  const outputDir = String(formData.get("outputDir") || "").trim();
  if (!outputDir) {
    modalError("Choose an output folder for the build.");
    return;
  }
  if (state.scene && state.dirty) {
    const saved = await saveScene(true);
    if (!saved) {
      modalError("Save the current scene before building so the exported game includes it.");
      return;
    }
  }
  if (errorSlot) errorSlot.hidden = true;
  setButtonBusy(submit, true, "Building…");
  try {
    const data = await api("/api/build", {
      method: "POST",
      body: { format: state.buildFormat, outputDir }
    });
    state.buildOutputDir = data.build.outputDir;
    showBuildResult(data.build);
    toast("Build complete.", "success", 2600);
  } catch (error) {
    if (errorSlot) {
      errorSlot.textContent = error.message;
      errorSlot.hidden = false;
    } else {
      toast(error.message, "error", 6500);
    }
    setButtonBusy(submit, false);
  }
}

/* -------------------------------------------------------------------------
   Actions
   ------------------------------------------------------------------------- */

async function openProjectPath(projectPath) {
  if (!projectPath) return;
  if (state.scene && state.dirty) {
    const saved = await saveScene(true);
    if (!saved) return;
  }
  try {
    await api("/api/project/open", { method: "POST", body: { path: projectPath } });
    closeModal();
    state.mode = "scenes";
    await refreshAll({ fit: true, resetLogs: true });
    toast(`Opened ${projectPath}`, "success", 2400);
  } catch (error) {
    modalError(error.message);
    toast(error.message, "error", 6000);
  }
}

function setMode(mode) {
  state.mode = mode;
  $$(".rail-btn[data-mode]").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.mode === mode);
  });
  renderSidebar();
  renderScriptView();
  renderStageFrame();
  if (mode === "scripts" && state.project && !state.scriptsLoaded) {
    refreshScripts({ silent: true });
  }
  if (mode !== "scripts") {
    requestAnimationFrame(() => {
      if (state.project && state.scene) resizeCanvas();
    });
  }
}

function setupPayloadFromForm(form) {
  const formData = new FormData(form);
  const payload = {
    model: String(formData.get("model") || "").trim(),
    baseUrl: String(formData.get("baseUrl") || "").trim(),
    lovePath: String(formData.get("lovePath") || "").trim(),
    projectsDir: String(formData.get("projectsDir") || "").trim()
  };
  const key = String(formData.get("apiKey") || "").trim();
  if (key) payload.apiKey = key;
  if (!payload.model) delete payload.model;
  return { payload, key };
}

async function installZed() {
  const button = $('[data-action="install-zed"]');
  const form = $('form[data-form="setup"]');
  setButtonBusy(button, true, "Installing…");
  try {
    if (form) {
      const { payload, key } = setupPayloadFromForm(form);
      const saved = await api("/api/setup", { method: "POST", body: payload });
      state.setup = saved.setup;
      if (key) toast("DeepSeek key saved locally.", "success", 3000);
    }
    const data = await api("/api/setup/zed", { method: "POST", body: {} });
    state.setup = data.setup;
    toast("Zed integration installed. Restart Zed, then open the Agent panel and pick Love2D Assistant.", "success", 7000);
    renderAll();
    closeModal();
  } catch (error) {
    modalError(error.message);
    toast(error.message, "error", 7000);
  } finally {
    setButtonBusy(button, false);
  }
}

async function saveSetupForm(form) {
  const button = form.querySelector('[data-submit]');
  const { payload, key } = setupPayloadFromForm(form);
  setButtonBusy(button, true, "Saving…");
  try {
    const data = await api("/api/setup", { method: "POST", body: payload });
    state.setup = data.setup;
    renderAll();
    closeModal();
    chatUi?.refresh();
    toast("Settings saved.", "success", 2600);
    if (key) {
      toast("DeepSeek key saved locally.", "success", 3000);
    }
  } catch (error) {
    modalError(error.message);
    setButtonBusy(button, false);
  }
}

async function handleFormSubmit(form) {
  const kind = form.dataset.form;
  if (kind === "new-project") {
    const submit = form.querySelector('[data-submit]');
    const formData = new FormData(form);
    setButtonBusy(submit, true, "Creating…");
    const errorSlot = form.querySelector("#modal-error");
    if (errorSlot) errorSlot.hidden = true;
    try {
      await api("/api/project/create", {
        method: "POST",
        body: {
          name: String(formData.get("name") || "").trim(),
          parentDir: String(formData.get("parentDir") || "").trim(),
          template: state.selectedTemplate,
          width: Number(formData.get("width")),
          height: Number(formData.get("height"))
        }
      });
      closeModal();
      state.sceneName = "";
      state.mode = "scenes";
      await refreshAll({ fit: true, resetLogs: true });
      toast("Project created. Design a scene, then open Zed and ask the assistant for help.", "success", 5200);
    } catch (error) {
      modalError(error.message);
      setButtonBusy(submit, false);
    }
    return;
  }

  if (kind === "open-project") {
    const formData = new FormData(form);
    await openProjectPath(String(formData.get("path") || "").trim());
    return;
  }

  if (kind === "new-scene") {
    const submit = form.querySelector('[data-submit]');
    const formData = new FormData(form);
    setButtonBusy(submit, true, "Creating…");
    try {
      const result = await api("/api/scenes", {
        method: "POST",
        body: {
          name: String(formData.get("name") || "").trim(),
          width: Number(formData.get("width")),
          height: Number(formData.get("height"))
        }
      });
      closeModal();
      await refreshScenes();
      await switchScene(result.scene.name);
      toast(`Created scene ${result.scene.name}.`, "success", 2400);
    } catch (error) {
      modalError(error.message);
      setButtonBusy(submit, false);
    }
    return;
  }

  if (kind === "setup") {
    await saveSetupForm(form);
    return;
  }

  if (kind === "build") {
    await submitBuild(form);
  }
}

/* -------------------------------------------------------------------------
   Event wiring
   ------------------------------------------------------------------------- */

function bindEvents() {
  el("project-switcher").addEventListener("click", openOpenProjectModal);
  el("btn-new-scene").addEventListener("click", openNewSceneModal);
  el("btn-save-scene").addEventListener("click", () => saveScene(false));
  el("btn-delete-scene").addEventListener("click", () => {
    if (!state.sceneName) return;
    openConfirmModal({
      title: "Delete scene?",
      body: `Delete <strong>${escapeHtml(state.sceneName)}</strong> from this project? This removes the JSON file and cannot be undone.`,
      confirmLabel: "Delete scene",
      action: "confirm-delete-scene"
    });
  });
  el("btn-undo").addEventListener("click", undo);
  el("btn-redo").addEventListener("click", redo);
  el("btn-grid").addEventListener("click", () => {
    state.showGrid = !state.showGrid;
    renderSceneToolbar();
    renderCanvas();
  });
  el("btn-fit").addEventListener("click", fitScene);
  el("btn-zoom-out").addEventListener("click", () => zoomBy(0.8));
  el("btn-zoom-in").addEventListener("click", () => zoomBy(1.25));
  el("scene-select").addEventListener("change", (event) => switchScene(event.target.value));
  el("btn-run").addEventListener("click", runGame);
  el("btn-stop").addEventListener("click", stopGame);
  el("btn-console-run").addEventListener("click", runGame);
  el("btn-console-stop").addEventListener("click", stopGame);
  el("btn-setup").addEventListener("click", openSetupModal);
  el("rail-setup").addEventListener("click", openSetupModal);
  el("btn-zed").addEventListener("click", openZedAction);
  el("btn-build").addEventListener("click", openBuildModal);
  el("btn-console-clear").addEventListener("click", async () => {
    try {
      await api("/api/run/clear", { method: "POST", body: {} });
      state.logs = [];
      renderLogs();
    } catch (error) {
      toast(error.message, "error");
    }
  });
  el("btn-console-toggle").addEventListener("click", () => {
    state.consoleCollapsed = !state.consoleCollapsed;
    renderConsoleFrame();
  });
  el("rail-console").addEventListener("click", () => {
    state.consoleCollapsed = !state.consoleCollapsed;
    renderConsoleFrame();
  });

  $$(".rail-btn[data-mode]").forEach((button) => {
    button.addEventListener("click", () => setMode(button.dataset.mode));
  });
  $$(".tool-btn").forEach((button) => {
    button.addEventListener("click", () => setTool(button.dataset.tool));
  });

  document.addEventListener("submit", (event) => {
    const form = event.target.closest("form[data-form]");
    if (!form) return;
    event.preventDefault();
    handleFormSubmit(form);
  });

  document.addEventListener("click", (event) => {
    const template = event.target.closest("[data-template]");
    if (template) {
      state.selectedTemplate = template.dataset.template;
      $$("[data-template]").forEach((button) =>
        button.classList.toggle("is-selected", button === template));
      return;
    }

    const buildFormat = event.target.closest("[data-build-format]");
    if (buildFormat) {
      if (buildFormat.disabled) return;
      state.buildFormat = buildFormat.dataset.buildFormat;
      $$("[data-build-format]").forEach((button) => {
        const selected = button === buildFormat;
        button.classList.toggle("is-selected", selected);
        button.setAttribute("aria-pressed", selected ? "true" : "false");
      });
      const note = el("build-format-note");
      if (note) note.textContent = buildFormatFooter(state.buildInfo);
      return;
    }

    const actionTarget = event.target.closest("[data-action]");
    if (!actionTarget) return;
    const action = actionTarget.dataset.action;
    handleAction(action, actionTarget, event);
  });

  document.addEventListener("input", (event) => {
    if (event.target.id === "asset-search") {
      state.assetFilter = event.target.value;
      const grid = el("asset-grid");
      if (grid) grid.innerHTML = assetGridHtml();
      return;
    }
    if (event.target.id === "script-search") {
      state.scriptFilter = event.target.value;
      const list = el("script-list");
      if (list) list.innerHTML = scriptRowsHtml(filteredScripts());
      return;
    }
    if (event.target.matches("[data-field]")) {
      updateField(event.target);
    }
  });

  document.addEventListener("change", (event) => {
    if (event.target.matches("[data-field]")) {
      updateField(event.target, { final: true });
    } else if (event.target.matches("[data-property-key-input]")) {
      renameCustomProperty(event.target);
    } else if (event.target.matches("[data-property-value]")) {
      updateCustomProperty(event.target);
    } else if (event.target.matches("[data-property-type]")) {
      changeCustomPropertyType(event.target);
    }
  });

  document.addEventListener("focusin", (event) => {
    if (event.target.matches("[data-field], [data-property-value], [data-property-key-input]") && state.scene) {
      state.fieldSnapshot = deepClone(state.scene);
    }
  });

  document.addEventListener("dragstart", (event) => {
    const card = event.target.closest("[data-asset-card]");
    if (!card) return;
    event.dataTransfer.effectAllowed = "copy";
    event.dataTransfer.setData("application/x-love2d-asset", card.dataset.path);
    event.dataTransfer.setData("text/plain", card.dataset.path);
  });

  // Keep the Electron window from navigating when files are dropped outside a
  // drop zone; the sidebar and scene canvas handle the actual import.
  window.addEventListener("dragover", (event) => {
    if (dragHasFiles(event)) event.preventDefault();
  });
  window.addEventListener("drop", (event) => {
    if (dragHasFiles(event)) event.preventDefault();
  });

  const sidebarEl = el("sidebar");
  let sidebarFileDepth = 0;
  const clearSidebarFileDrop = () => {
    sidebarFileDepth = 0;
    sidebarEl?.classList.remove("is-file-drop");
  };
  sidebarEl?.addEventListener("dragenter", (event) => {
    if (!dragHasFiles(event) || !state.project) return;
    event.preventDefault();
    sidebarFileDepth += 1;
    sidebarEl.classList.add("is-file-drop");
  });
  sidebarEl?.addEventListener("dragover", (event) => {
    if (!dragHasFiles(event) || !state.project) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  });
  sidebarEl?.addEventListener("dragleave", () => {
    if (!sidebarFileDepth) return;
    sidebarFileDepth = Math.max(0, sidebarFileDepth - 1);
    if (sidebarFileDepth === 0) sidebarEl.classList.remove("is-file-drop");
  });
  sidebarEl?.addEventListener("drop", async (event) => {
    if (!dragHasFiles(event) || !state.project) return;
    event.preventDefault();
    clearSidebarFileDrop();
    const result = await uploadAssets(event.dataTransfer.files);
    if (result.imported && state.mode !== "assets") {
      setMode("assets");
    }
  });

  document.addEventListener("keydown", (event) => {
    const assetCard = event.target.closest?.("[data-asset-card]");
    if (assetCard && (event.key === "Enter" || event.key === " ")) {
      event.preventDefault();
      assetCard.click();
      return;
    }
    if (event.target.matches("input, textarea, select") || event.target.isContentEditable) return;
    const dialog = el("modal-dialog");
    if (dialog?.open) return;

    const mod = event.ctrlKey || event.metaKey;
    if (mod && event.key.toLowerCase() === "s") {
      event.preventDefault();
      saveScene(false);
      return;
    }
    if (mod && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
      return;
    }
    if (mod && event.key.toLowerCase() === "y") {
      event.preventDefault();
      redo();
      return;
    }
    if (mod && event.key.toLowerCase() === "d") {
      event.preventDefault();
      duplicateSelected();
      return;
    }
    if (event.key === "Delete" || event.key === "Backspace") {
      if (state.selectedId) {
        event.preventDefault();
        deleteSelected();
      }
      return;
    }
    if (event.key === "Escape") {
      if (state.draft) {
        state.draft = null;
        scheduleRender();
      } else if (state.tool !== "select") {
        setTool("select");
      } else {
        state.selectedId = null;
        renderInspector();
        renderSidebar();
        renderCanvas();
      }
      return;
    }
    if (event.key === " ") {
      state.spaceDown = true;
      if (state.scene) event.preventDefault();
      return;
    }
    if (state.selectedId && ["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) {
      event.preventDefault();
      const amount = event.shiftKey ? 10 : 1;
      if (event.key === "ArrowLeft") nudgeSelected(-amount, 0);
      if (event.key === "ArrowRight") nudgeSelected(amount, 0);
      if (event.key === "ArrowUp") nudgeSelected(0, -amount);
      if (event.key === "ArrowDown") nudgeSelected(0, amount);
      return;
    }

    if (event.key.toLowerCase() === "v") setTool("select");
    else if (event.key.toLowerCase() === "r") setTool("rectangle");
    else if (event.key.toLowerCase() === "o") setTool("circle");
    else if (event.key.toLowerCase() === "t") setTool("text");
    else if (event.key.toLowerCase() === "s" && !mod) setTool("sprite");
  });

  document.addEventListener("keyup", (event) => {
    if (event.key === " ") state.spaceDown = false;
  });

  const dialog = el("modal-dialog");
  dialog.addEventListener("click", (event) => {
    if (event.target === dialog) closeModal();
  });
  dialog.addEventListener("close", () => {
    dialog.innerHTML = "";
    syncPreviewOverlay();
  });

  const fileInput = document.createElement("input");
  fileInput.type = "file";
  fileInput.multiple = true;
  fileInput.accept = ".png,.jpg,.jpeg,.bmp,.tga,.wav,.ogg,.mp3,.flac,.ttf,.otf";
  fileInput.style.display = "none";
  fileInput.id = "asset-file-input";
  document.body.append(fileInput);
  fileInput.addEventListener("change", () => uploadAssets(fileInput.files));
  fileInput.addEventListener("click", () => {
    fileInput.value = "";
  });

  // Draft updates happen alongside the main pointermove handler.
  el("scene-canvas").addEventListener("pointermove", updateCanvasDraft);

  window.addEventListener("beforeunload", (event) => {
    if (state.dirty) {
      event.preventDefault();
      event.returnValue = "";
    }
  });

  window.addEventListener("resize", () => {
    if (state.scene) resizeCanvas();
    layoutGamePreviewScreen();
    syncPreviewOverlay();
    schedulePreviewBounds(120);
  });

  const aiDrawer = el("ai-drawer");
  if (aiDrawer) {
    new MutationObserver(() => syncPreviewOverlay()).observe(aiDrawer, {
      attributes: true,
      attributeFilter: ["hidden"]
    });
  }
}

function zoomBy(factor) {
  if (!state.scene || !canvas) return;
  const rect = canvas.getBoundingClientRect();
  const sx = rect.width / 2;
  const sy = rect.height / 2;
  const worldX = (sx - state.panX) / state.zoom;
  const worldY = (sy - state.panY) / state.zoom;
  state.zoom = clamp(state.zoom * factor, 0.05, 8);
  state.panX = sx - worldX * state.zoom;
  state.panY = sy - worldY * state.zoom;
  state.viewScene = state.sceneName;
  renderCanvas();
}

function handleAction(action, target, event) {
  switch (action) {
    case "close-modal":
      closeModal();
      break;
    case "new-project":
      if (state.scene && state.dirty) saveScene(true);
      openNewProjectModal();
      break;
    case "open-project":
      openOpenProjectModal();
      break;
    case "open-recent":
      openProjectPath(target.dataset.path);
      break;
    case "open-setup":
      openSetupModal();
      break;
    case "stop-game-preview":
      stopGame();
      break;
    case "build-again":
      openBuildModal();
      break;
    case "reveal-build":
      revealBuildOutput(target.dataset.path);
      break;
    case "browse-build-output":
      chooseDirectoryFor("build-output", "Choose a folder for the build");
      break;
    case "new-scene":
      openNewSceneModal();
      break;
    case "select-scene":
      switchScene(target.dataset.name);
      break;
    case "refresh-scenes":
      refreshScenes();
      break;
    case "refresh-assets":
      refreshAssets();
      break;
    case "select-script":
      loadScript(target.dataset.path);
      break;
    case "refresh-scripts":
      refreshScripts();
      break;
    case "copy-script":
      copyScriptCode();
      break;
    case "open-script-zed":
      openScriptInZed();
      break;
    case "import-assets":
      el("asset-file-input")?.click();
      break;
    case "open-assets":
      setMode("assets");
      break;
    case "select-asset": {
      const asset = state.assets.find((item) => item.path === target.dataset.path);
      if (!asset) return;
      state.selectedAsset = asset;
      if (asset.kind === "image") {
        setTool("sprite");
        setMode("assets");
      } else {
        toast(`${asset.name} selected. Only images can be placed on the canvas.`, "warn", 2600);
      }
      renderSidebar();
      break;
    }
    case "play-asset":
      event.stopPropagation();
      playAsset(target.dataset.path);
      break;
    case "delete-asset": {
      event.stopPropagation();
      const path = target.dataset.path;
      openConfirmModal({
        title: "Delete asset?",
        body: `Delete <strong>${escapeHtml(path)}</strong>? Scenes that reference it will show a placeholder.`,
        confirmLabel: "Delete asset",
        action: "confirm-delete-asset",
        data: { path }
      });
      break;
    }
    case "confirm-delete-asset":
      deleteAsset(target.dataset.path);
      break;
    case "add-property":
      addCustomProperty();
      break;
    case "delete-property":
      deleteCustomProperty(target.dataset.key || "");
      break;
    case "duplicate-entity":
      duplicateSelected();
      break;
    case "delete-entity":
      deleteSelected();
      break;
    case "confirm-delete-scene":
      deleteCurrentScene();
      break;
    case "undo":
      undo();
      break;
    case "redo":
      redo();
      break;
    case "open-zed":
      openZedAction();
      break;
    case "reveal-project":
      revealProject();
      break;
    case "install-zed":
      installZed();
      break;
    case "clear-api-key":
      clearApiKey();
      break;
    case "browse-project-parent":
      chooseDirectoryFor("new-project-parent", "Choose a location for the new project");
      break;
    case "browse-open-project":
      chooseDirectoryFor("open-project-path", "Choose a Love2D project folder");
      break;
    case "browse-projects-dir":
      chooseDirectoryFor("setup-projects-dir", "Choose the default projects folder");
      break;
    case "browse-love-path":
      chooseLoveExecutable();
      break;
    default:
      break;
  }
}

async function deleteAsset(path) {
  try {
    await api(`/api/asset?path=${encodeURIComponent(path)}`, { method: "DELETE" });
    closeModal();
    await refreshAssets();
    if (state.selectedAsset?.path === path) {
      state.selectedAsset = null;
      setTool("select");
    }
    toast("Asset deleted.", "success", 2200);
  } catch (error) {
    toast(error.message, "error");
  }
}

async function deleteCurrentScene() {
  if (!state.sceneName) return;
  try {
    await api(`/api/scene?name=${encodeURIComponent(state.sceneName)}`, { method: "DELETE" });
    closeModal();
    state.scene = null;
    state.sceneName = "";
    const data = await api("/api/scenes");
    state.scenes = data.scenes || [];
    if (state.scenes.length) await loadScene(state.scenes[0].name, { fit: true });
    else renderAll();
    toast("Scene deleted.", "success", 2200);
  } catch (error) {
    toast(error.message, "error");
  }
}

async function clearApiKey() {
  try {
    const data = await api("/api/setup", { method: "POST", body: { apiKey: "" } });
    state.setup = data.setup;
    closeModal();
    toast("Saved DeepSeek key removed.", "success", 2400);
    renderAll();
    chatUi?.refresh();
  } catch (error) {
    toast(error.message, "error");
  }
}

async function revealProject() {
  try {
    await api("/api/project/reveal", { method: "POST", body: {} });
  } catch (error) {
    toast(error.message, "error");
  }
}

async function openZedAction() {
  if (!state.setup?.zed?.installed) {
    openSetupModal();
    toast("Zed was not found. Install it, then add the assistant in Setup.", "warn", 5200);
    return;
  }
  try {
    await api("/api/open-zed", { method: "POST", body: {} });
    toast("Opening Zed…", "success", 1800);
  } catch (error) {
    toast(error.message, "error");
  }
}

function playAsset(path) {
  const asset = state.assets.find((item) => item.path === path);
  if (!asset) return;
  if (state.audio && state.audioPath === path) {
    if (!state.audio.paused) {
      state.audio.pause();
      state.audio.currentTime = 0;
    } else {
      state.audio.play().catch((error) => toast(error.message, "error"));
    }
    return;
  }
  if (state.audio) {
    state.audio.pause();
    state.audio = null;
  }
  state.audio = new Audio(asset.url);
  state.audioPath = path;
  state.audio.addEventListener("ended", () => {
    if (state.audioPath === path) {
      state.audioPath = "";
    }
  });
  state.audio.play().catch((error) => toast(`Could not play audio: ${error.message}`, "error"));
}

async function uploadAssets(fileList, { notify = true } = {}) {
  const files = Array.from(fileList || []);
  if (!files.length) return { imported: 0, assets: [], failures: [] };
  const importedAssets = [];
  const failures = [];
  for (const file of files) {
    try {
      const buffer = await file.arrayBuffer();
      const response = await fetch(`/api/assets/import?name=${encodeURIComponent(file.name)}`, {
        method: "POST",
        headers: {
          "x-studio-token": token,
          "content-type": "application/octet-stream"
        },
        body: buffer
      });
      const text = await response.text();
      const data = text ? JSON.parse(text) : {};
      if (!response.ok) throw new Error(data.error || `Upload failed (${response.status}).`);
      if (data.asset) importedAssets.push(data.asset);
    } catch (error) {
      failures.push(`${file.name}: ${error.message}`);
    }
  }
  await refreshAssets();
  const imported = importedAssets.length;
  if (notify && imported) {
    toast(`Imported ${imported} asset${imported === 1 ? "" : "s"}.`, "success", 2600);
  }
  if (failures.length) toast(failures[0], "error", 6500);
  return { imported, assets: importedAssets, failures };
}

/* -------------------------------------------------------------------------
   Boot
   ------------------------------------------------------------------------- */

// Keyboard shortcut for direct canvas draft updates is handled in bindEvents.
// Keep a reference to the canvas before events are bound.
function initializeDesktopChat() {
  if (!desktop) return;
  chatUi = initDesktopChat({
    onOpenSetup: openSetupModal,
    onBeforeSend: async () => {
      if (!state.scene || !state.dirty) return true;
      return saveScene(true);
    },
    onWorkspaceChanged: handleAiWorkspaceChanged,
    toast
  });
}

async function handleAiWorkspaceChanged(paths) {
  if (!state.project || !paths?.length) return;
  const scenePaths = paths.filter((item) => item.startsWith("scenes/"));
  const assetPaths = paths.filter((item) => item.startsWith("assets/"));
  const scriptPaths = paths.filter((item) => item.toLowerCase().endsWith(".lua"));
  if (scriptPaths.length) {
    state.scriptsLoaded = false;
    if (state.mode === "scripts") {
      await refreshScripts({ silent: true });
    }
  }
  try {
    if (assetPaths.length) {
      for (const assetPath of assetPaths) state.images.delete(assetPath);
      await refreshAssets();
    }
    const scenes = await api("/api/scenes");
    state.scenes = scenes.scenes || [];
    if (scenePaths.length) {
      renderSceneToolbar();
      renderSidebar();
      const currentFile = `scenes/${state.sceneName}.json`;
      if (scenePaths.includes(currentFile) && state.sceneName) {
        if (state.dirty) {
          toast(
            "The assistant updated the current scene file. Your unsaved canvas edits are still here — save or reload when ready.",
            "warn",
            7000
          );
        } else {
          await loadScene(state.sceneName, { fit: false, silent: true });
          toast("Reloaded the scene after the assistant changed it.", "success", 2800);
        }
      }
    } else {
      renderSidebar();
    }
  } catch (error) {
    toast(error.message, "error", 5000);
  }
}

function start() {
  setupCanvas();
  bindEvents();
  initializeDesktopChat();
  connectSSE();
  loadInitial().catch((error) => {
    toast(error.message, "error", 8000);
    renderAll();
  });
}

start();
