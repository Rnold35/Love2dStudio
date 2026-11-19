import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import {
  APP_NAME,
  readConfig,
  rememberProject,
  writeConfig
} from "../shared/paths.js";
import { findLove } from "../shared/love.js";
import { installLuaCatsIntoProject } from "../shared/luacats.js";
import { desktopLaunchInfo } from "../shared/desktop.js";
import { findNodeExecutable } from "../shared/node.js";
import { sanitizeName, sanitizeSlug, writeJsonAtomic } from "../shared/fsx.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, "..", "..");
const TEMPLATES_DIR = path.join(APP_ROOT, "templates");
const SERVER_ENTRY = path.join(HERE, "server.js");

export const TEMPLATES = [
  {
    id: "starter",
    name: "Starter platformer",
    description: "A playable platformer scene, collision, and scene-reload workflow.",
    width: 960,
    height: 600
  },
  {
    id: "empty",
    name: "Empty project",
    description: "A minimal LÖVE project with the Studio runtime and scene folder ready.",
    width: 960,
    height: 600
  }
];

function copyTemplateDir(source, target) {
  fs.cpSync(source, target, { recursive: true, force: true });
}

function replaceTokensInTree(root, tokens) {
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
      } else if (/\.(lua|json|md|txt|toml)$/i.test(entry.name)) {
        let text = fs.readFileSync(full, "utf8");
        let changed = false;
        for (const [token, value] of Object.entries(tokens)) {
          if (text.includes(token)) {
            text = text.replaceAll(token, value);
            changed = true;
          }
        }
        if (changed) fs.writeFileSync(full, text, "utf8");
      }
    }
  };
  visit(root);
}

function blankScene(width, height, name = "main") {
  return {
    version: 1,
    name,
    width,
    height,
    background: [0.055, 0.065, 0.085, 1],
    entities: []
  };
}

function starterScenePath(projectPath) {
  return path.join(projectPath, "scenes", "main.json");
}

function normaliseStarterScene(projectPath, width, height) {
  const file = starterScenePath(projectPath);
  const scene = JSON.parse(fs.readFileSync(file, "utf8"));
  scene.width = width;
  scene.height = height;
  for (const entity of scene.entities || []) {
    if (entity.id === "ground") {
      entity.y = Math.max(320, height - 80);
      entity.w = width;
    }
  }
  writeJsonAtomic(file, scene);
}

export function writeProjectIntegration(projectPath, { overwrite = false } = {}) {
  const written = [];
  const zedDir = path.join(projectPath, ".zed");
  fs.mkdirSync(zedDir, { recursive: true });

  const node = findNodeExecutable();
  const love = findLove({ console: true }) || "love";
  const desktop = desktopLaunchInfo();
  const tasks = [
    {
      label: "Love2D: Run Game",
      command: love,
      args: ["."],
      cwd: "$ZED_WORKTREE_ROOT",
      use_new_terminal: true,
      allow_concurrent_runs: false,
      reveal: "always"
    }
  ];

  if (desktop) {
    tasks.push({
      label: "Love2D: Open Studio",
      command: desktop.command,
      args: [...desktop.prefixArgs, "--project", "$ZED_WORKTREE_ROOT"],
      cwd: "$ZED_WORKTREE_ROOT",
      use_new_terminal: true,
      allow_concurrent_runs: true,
      reveal: "no_focus"
    });
    tasks.push({
      label: "Love2D: New Project",
      command: desktop.command,
      args: [...desktop.prefixArgs, "--new"],
      cwd: "$ZED_WORKTREE_ROOT",
      use_new_terminal: true,
      allow_concurrent_runs: true,
      reveal: "no_focus"
    });
  }

  tasks.push({
    label: "Love2D: Open Studio in Browser",
    command: node,
    args: [
      SERVER_ENTRY,
      "open",
      "--project",
      "$ZED_WORKTREE_ROOT",
      "--open-browser"
    ],
    cwd: "$ZED_WORKTREE_ROOT",
    use_new_terminal: true,
    allow_concurrent_runs: true,
    reveal: "no_focus"
  });

  if (!desktop) {
    tasks.push({
      label: "Love2D: New Project",
      command: node,
      args: [SERVER_ENTRY, "open", "--new", "--open-browser"],
      cwd: "$ZED_WORKTREE_ROOT",
      use_new_terminal: true,
      allow_concurrent_runs: true,
      reveal: "no_focus"
    });
  }

  const keymap = [
    {
      context: "Workspace",
      bindings: {
        "alt-r": ["task::Spawn", { task_name: "Love2D: Run Game" }],
        "alt-shift-s": ["task::Spawn", { task_name: "Love2D: Open Studio" }]
      }
    }
  ];

  const settings = {
    ensure_final_newline_on_save: true,
    show_whitespaces: "selection",
    languages: {
      Lua: {
        tab_size: 2,
        hard_tabs: false,
        soft_wrap: "none"
      }
    }
  };

  const entries = [
    ["tasks.json", tasks],
    ["settings.json", settings],
    ["keymap.json", keymap]
  ];
  for (const [name, value] of entries) {
    const file = path.join(zedDir, name);
    if (!overwrite && fs.existsSync(file)) continue;
    writeJsonAtomic(file, value);
    written.push(path.relative(projectPath, file));
  }

  const luarcFile = path.join(projectPath, ".luarc.json");
  if (overwrite || !fs.existsSync(luarcFile)) {
    writeJsonAtomic(luarcFile, {
      "$schema": "https://raw.githubusercontent.com/LuaLS/vscode-lua/master/setting/schema.json",
      "runtime.version": "LuaJIT",
      "runtime.special": {
        "love.filesystem.load": "loadfile"
      },
      "workspace.library": [".love2d-studio/luacats/love2d/library"],
      "workspace.checkThirdParty": false,
      "diagnostics.disable": ["duplicate-set-field"],
      "telemetry.enable": false
    });
    written.push(".luarc.json");
  }

  const gitignoreFile = path.join(projectPath, ".gitignore");
  if (overwrite || !fs.existsSync(gitignoreFile)) {
    fs.writeFileSync(
      gitignoreFile,
      ".love2d-studio/cache/\n.love2d-studio/runtime/\n.love2d-studio/runtime.json\n.love2d-studio/ai/\nbuild/\ndist/\n*.log\n.DS_Store\nThumbs.db\n",
      "utf8"
    );
    written.push(".gitignore");
  }

  const rulesFile = path.join(projectPath, ".rules");
  if (overwrite || !fs.existsSync(rulesFile)) {
    fs.writeFileSync(rulesFile, projectRules(), "utf8");
    written.push(".rules");
  }

  return { written, tasks, settings, keymap };
}

function projectRules() {
  return `# Love2D project rules

This is a LÖVE 11.5 (LuaJIT) project edited in Zed.

## Conventions
- Target Lua 5.1 / LuaJIT. Do not use Lua 5.2+ syntax such as \`goto\` or bitwise operators.
- Use two-space indentation and \`local\` by default.
- Only the LÖVE callbacks (\`love.load\`, \`love.update\`, \`love.draw\`, etc.) live as globals.
- Keep update logic in \`love.update(dt)\`; use delta time for movement.
- Reset graphics color/font/transform state after custom drawing.
- Prefer small modules under \`src/\` with explicit \`require\` paths.
- Assets live under \`assets/images\`, \`assets/audio\`, and \`assets/fonts\`.

## Studio scenes
- Scenes are JSON files in \`scenes/\` and are edited visually in Love2D Studio.
- Load them with \`local Scene = require("studio.scene")\` and \`Scene.load("main")\`.
- Supported entity types: \`sprite\`, \`rectangle\`, \`circle\`, \`text\`.
- Sprite paths are project-relative (for example \`assets/images/player.png\`).
- Rectangle properties under \`properties\` are available to game code; the starter
  template uses \`properties.solid = true\` for collision blocks.
- Do not hand-edit scene JSON unless the visual editor cannot express the change;
  preserve the schema and entity IDs.
- Scene JSON is the single source of truth for visible layout. Menus, HUD panels,
  buttons, titles, and labels must exist as scene entities so they appear in the
  Studio canvas. Lua should animate and handle them, not define static UI only
  through \`love.graphics\` calls.
- A UI button is a rectangle tagged \`button\` with \`properties.action\` plus a
  \`button-label\` text entity inside it. Add both together.
- Put designer-tunable gameplay values in the entity's \`properties\` object as
  numbers, strings, or booleans (for example \`properties.playerSpeed = 260\`).
  The Studio Gameplay inspector edits them; Lua should read them with defaults
  and clamping instead of hardcoding the value.

## Working style
- Inspect the existing files before editing. Never invent APIs; use LÖVE 11.5 APIs.
- For code changes, explain the intended change briefly, then use the editing tools.
- After meaningful changes, run the game with the run tool when it is safe to do so.
- Keep answers focused and include exact file paths.
`;
}

function readmeFor(name, templateId) {
  const isStarter = templateId === "starter";
  return `# ${name}

A LÖVE 11.5 project created with **${APP_NAME}**.

## Run it

- In Zed: open the tasks menu and choose **Love2D: Run Game** (or press \`Alt+R\`).
- From a terminal: \`love .\`

## Open the Studio

In Zed choose **Love2D: Open Studio** (or press \`Alt+Shift+S\`). The native
desktop Studio opens with this project and includes:

- a visual level/scene editor
- an asset browser with drag-and-drop import
- a live game console with run/stop controls
- the project wizard for additional games

If the desktop app is not available, **Love2D: Open Studio in Browser** runs the
same Studio in your browser.

Click **Run** in the Studio toolbar to play the game inside the editor stage.
Click the game once to give it keyboard focus; **Stop** returns to the scene.

Click the **AI** button to chat with the built-in assistant. It can inspect code
and scenes, generate modular Lua files, run a smoke test after you approve each
action, and ask you to pick from clickable options when a decision is needed. It
keeps a local Lua index and project memory under \`.love2d-studio/ai/\` so larger
projects can be navigated without rereading every script.

Use the **Scripts** tab in the Studio to browse and read every Lua module,
including files created by the AI. Scripts are read-only there; use **Open in
Zed** to edit.

Click **Build** in the Studio toolbar to export a Windows ZIP, a playable Windows
folder, or a portable \`.love\` file. Builds go to \`build/\` by default.

## Ask the AI assistant

Configuration lives in **Setup** inside the Studio. After adding a DeepSeek API
key and registering the agent in Zed, open Zed's Agent panel and choose
**Love2D Assistant**. The assistant can read and edit this project, inspect
scenes, and run the game to check for errors.

## Controls

${isStarter
    ? "- A/D or arrow keys to move\n- Space/W/Up to jump\n- R reloads the current scene while the game runs\n- F11 toggles fullscreen"
    : "- Escape quits\n- Edit main.lua to add your game loop"}

## Project layout

\`\`\`
main.lua                 Game entry point
conf.lua                 LÖVE window and module config
src/                     Your Lua modules
scenes/                  Visual scene files (JSON)
assets/                  Images, audio, fonts
studio/scene.lua         Scene runtime for LÖVE
studio/json.lua          JSON decoder used by the scene runtime
build/                   Generated game exports (gitignored)
.zed/tasks.json          Run and Studio tasks
.love2d-studio/          Editor metadata and LuaCATS definitions
.rules                   Project instructions for AI assistants
\`\`\`

Scenes are loaded in code with:

\`\`\`lua
local Scene = require("studio.scene")
local scene = Scene.load("main")
scene:draw()
\`\`\`
`;
}

function writeProjectDocs(projectPath, name, templateId, { overwrite = false } = {}) {
  const readme = path.join(projectPath, "README.md");
  if (overwrite || !fs.existsSync(readme)) {
    fs.writeFileSync(readme, readmeFor(name, templateId), "utf8");
  }
}

export function listScenes(projectPath) {
  const dir = path.join(projectPath, "scenes");
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
      .map((entry) => ({
        file: entry.name,
        name: entry.name.replace(/\.json$/i, "")
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }
}

export function ensureScenes(projectPath, width = 960, height = 600) {
  const dir = path.join(projectPath, "scenes");
  fs.mkdirSync(dir, { recursive: true });
  if (!listScenes(projectPath).length) {
    writeJsonAtomic(path.join(dir, "main.json"), blankScene(width, height));
  }
}

export function ensureCommonRuntime(projectPath) {
  const source = path.join(TEMPLATES_DIR, "common", "studio");
  const target = path.join(projectPath, "studio");
  fs.mkdirSync(target, { recursive: true });
  let copied = false;
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const destination = path.join(target, entry.name);
    if (fs.existsSync(destination)) continue;
    fs.copyFileSync(path.join(source, entry.name), destination);
    copied = true;
  }
  return copied;
}

export async function createProject({
  name,
  parentDir,
  template = "starter",
  width = 960,
  height = 600
}) {
  const templateDef = TEMPLATES.find((item) => item.id === template);
  if (!templateDef) throw new Error(`Unknown template: ${template}`);
  const safeName = sanitizeName(name, "My Love2D Game");
  const parent = path.resolve(parentDir || readConfig().projectsDir);
  const projectPath = path.join(parent, safeName);
  if (fs.existsSync(projectPath)) {
    const contents = fs.readdirSync(projectPath).filter((item) => item !== ".DS_Store");
    if (contents.length) {
      throw new Error(`A folder already exists at ${projectPath} and is not empty.`);
    }
  }
  const windowWidth = Math.max(320, Math.min(3840, Math.trunc(Number(width) || 960)));
  const windowHeight = Math.max(240, Math.min(2160, Math.trunc(Number(height) || 600)));
  const slug = sanitizeSlug(safeName, "love2d-game");

  fs.mkdirSync(projectPath, { recursive: true });
  fs.mkdirSync(parent, { recursive: true });

  // Template files (main.lua, conf.lua, optional scenes).
  copyTemplateDir(path.join(TEMPLATES_DIR, template), projectPath);
  ensureCommonRuntime(projectPath);
  replaceTokensInTree(projectPath, {
    __PROJECT_NAME__: safeName,
    __PROJECT_SLUG__: slug,
    __WINDOW_WIDTH__: String(windowWidth),
    __WINDOW_HEIGHT__: String(windowHeight)
  });

  for (const dir of [
    "src",
    "assets/images",
    "assets/audio",
    "assets/fonts",
    "scenes",
    ".love2d-studio/runtime"
  ]) {
    fs.mkdirSync(path.join(projectPath, dir), { recursive: true });
  }

  if (template === "starter") {
    normaliseStarterScene(projectPath, windowWidth, windowHeight);
  } else {
    ensureScenes(projectPath, windowWidth, windowHeight);
  }

  const meta = {
    version: 1,
    editor: "love2d-studio",
    name: safeName,
    template,
    window: { width: windowWidth, height: windowHeight },
    createdAt: new Date().toISOString()
  };
  writeJsonAtomic(path.join(projectPath, ".love2d-studio", "project.json"), meta);

  writeProjectIntegration(projectPath);
  writeProjectDocs(projectPath, safeName, template);
  const catResult = await installLuaCatsIntoProject(projectPath);
  rememberProject(projectPath);

  return {
    ...projectInfo(projectPath),
    luaCatsSource: catResult.source
  };
}

function gameWindowSize(projectPath) {
  let width = 0;
  let height = 0;
  try {
    const conf = fs.readFileSync(path.join(projectPath, "conf.lua"), "utf8").slice(0, 80_000);
    const widthMatch = /(?:^|\n)\s*t\.window\.width\s*=\s*(\d+)/.exec(conf);
    const heightMatch = /(?:^|\n)\s*t\.window\.height\s*=\s*(\d+)/.exec(conf);
    if (widthMatch) width = Number(widthMatch[1]);
    if (heightMatch) height = Number(heightMatch[1]);
  } catch {
    // Use the main scene as a fallback below.
  }
  if (!(width > 0 && height > 0)) {
    try {
      const scene = JSON.parse(fs.readFileSync(
        path.join(projectPath, "scenes", "main.json"),
        "utf8"
      ));
      width = Number(scene.width);
      height = Number(scene.height);
    } catch {
      // LÖVE's default window size.
    }
  }
  return {
    width: Number.isFinite(width) && width > 0 ? Math.round(width) : 800,
    height: Number.isFinite(height) && height > 0 ? Math.round(height) : 600
  };
}

export function projectInfo(projectPath) {
  let meta = null;
  try {
    meta = JSON.parse(fs.readFileSync(
      path.join(projectPath, ".love2d-studio", "project.json"),
      "utf8"
    ));
  } catch {
    // Missing metadata is fine for projects created elsewhere.
  }
  return {
    path: projectPath,
    name: meta?.name || path.basename(projectPath),
    template: meta?.template || null,
    createdAt: meta?.createdAt || null,
    scenes: listScenes(projectPath),
    window: gameWindowSize(projectPath),
    hasMain: fs.existsSync(path.join(projectPath, "main.lua")),
    lovePath: findLove({ console: true }) || ""
  };
}

export async function openProject(projectPath, { repair = false } = {}) {
  const resolved = path.resolve(projectPath);
  let stat;
  try {
    stat = fs.statSync(resolved);
  } catch {
    throw new Error(`Project folder does not exist: ${resolved}`);
  }
  if (!stat.isDirectory()) throw new Error(`Not a folder: ${resolved}`);

  fs.mkdirSync(path.join(resolved, ".love2d-studio", "runtime"), { recursive: true });
  ensureScenes(resolved);
  ensureCommonRuntime(resolved);
  const metaPath = path.join(resolved, ".love2d-studio", "project.json");
  if (!fs.existsSync(metaPath)) {
    writeJsonAtomic(metaPath, {
      version: 1,
      editor: "love2d-studio",
      name: path.basename(resolved),
      template: null,
      createdAt: new Date().toISOString()
    });
  }
  writeProjectIntegration(resolved, { overwrite: repair });
  writeProjectDocs(resolved, path.basename(resolved), "existing");
  await installLuaCatsIntoProject(resolved);
  rememberProject(resolved);
  return projectInfo(resolved);
}

export function saveConfigProjectsDir(dir) {
  const config = readConfig();
  config.projectsDir = path.resolve(dir);
  writeConfig(config);
}

export function revealInExplorer(projectPath) {
  if (process.platform === "win32") {
    const child = spawn("explorer.exe", [projectPath], {
      windowsHide: true,
      detached: true,
      stdio: "ignore"
    });
    child.unref();
  } else if (process.platform === "darwin") {
    const child = spawn("open", [projectPath], { detached: true, stdio: "ignore" });
    child.unref();
  } else {
    const child = spawn("xdg-open", [projectPath], { detached: true, stdio: "ignore" });
    child.unref();
  }
}
