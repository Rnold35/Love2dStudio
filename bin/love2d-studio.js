#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SERVER = path.join(ROOT, "src", "studio", "server.js");
const AGENT = path.join(ROOT, "src", "agent", "main.js");
const DESKTOP = path.join(ROOT, "desktop", "main.js");

const argv = process.argv.slice(2);
const command = argv[0] && !argv[0].startsWith("-") ? argv.shift() : "studio";

function wireChild(child, forwardSignals = true) {
  child.on("exit", (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else process.exit(code ?? 0);
  });
  if (!forwardSignals) return;
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      try {
        child.kill(signal);
      } catch {
        // Child may already be gone.
      }
    });
  }
}

function runNode(script, args) {
  const child = spawn(process.execPath, [script, ...args], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env
  });
  wireChild(child);
}

async function runDesktop(args) {
  let electron;
  try {
    electron = (await import("electron")).default;
  } catch {
    console.error("Electron is not installed. Run: npm install");
    process.exit(1);
  }
  if (typeof electron !== "string") {
    console.error("Could not locate the Electron binary. Run: npm install");
    process.exit(1);
  }
  const child = spawn(electron, [DESKTOP, ...args], {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env
  });
  wireChild(child, false);
}

async function setup(args) {
  const { findLove, loveVersion } = await import("../src/shared/love.js");
  const { findZed, zedSettingsPath } = await import("../src/shared/zed.js");
  const { inspectZedSetup, installZedIntegration } = await import("../src/shared/zed-setup.js");
  const { ensureLuaCats } = await import("../src/shared/luacats.js");
  const { publicConfig } = await import("../src/shared/paths.js");

  const love = findLove({ console: true });
  const zed = findZed();
  const status = inspectZedSetup();
  const config = publicConfig();
  console.log("");
  console.log("  Love2D Studio setup");
  console.log("  ───────────────────");
  console.log(`  Node:     ${process.execPath}`);
  console.log(`  LÖVE:     ${love ? `${loveVersion(love) || "found"} — ${love}` : "NOT FOUND"}`);
  console.log(`  Zed:      ${zed || "NOT FOUND"}`);
  console.log(`  Zed cfg:  ${zedSettingsPath()}${status.configured ? " (agent installed)" : ""}`);
  console.log(`  DeepSeek: ${config.deepseek.configured ? `key configured (${config.deepseek.model})` : "NO API KEY"}`);
  console.log("");

  if (args.includes("--install-zed") || args.includes("--all")) {
    try {
      const result = installZedIntegration();
      console.log(`  Installed Zed agent + snippets.`);
      console.log(`  Settings: ${result.settingsPath}`);
      console.log(`  Restart Zed, then open the Agent panel and choose "Love2D Assistant".`);
    } catch (error) {
      console.error(`  Could not install Zed integration: ${error.message}`);
      process.exitCode = 1;
    }
  } else {
    console.log("  To register the DeepSeek agent and snippets in Zed:");
    console.log("    node bin/love2d-studio.js setup --install-zed");
    console.log("  Or use the Setup panel in the Studio UI.");
    console.log("");
  }

  if (args.includes("--install-luacats") || args.includes("--all")) {
    const result = await ensureLuaCats();
    console.log(`  LuaCATS LÖVE definitions: ${result.source} — ${result.path}`);
    console.log("");
  }

  console.log("  Desktop app:");
  console.log("    npm start        (or: npm run desktop)");
  console.log("    npm run package  builds dist/Love2D Studio-win32-x64/");
  console.log("");
  console.log("  Browser fallback:");
  console.log("    npm run studio");
  console.log("");
  console.log("  In Zed, project tasks are available after creating/opening a project in the Studio.");
  console.log("");
}

async function create(args) {
  const { createProject } = await import("../src/studio/projects.js");
  const { readConfig } = await import("../src/shared/paths.js");
  let name = "";
  let parentDir = readConfig().projectsDir;
  let template = "starter";
  let width = 960;
  let height = 600;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--dir" || arg === "--parent") parentDir = args[++index] || parentDir;
    else if (arg === "--template") template = args[++index] || template;
    else if (arg === "--width") width = Number(args[++index]) || width;
    else if (arg === "--height") height = Number(args[++index]) || height;
    else if (!name && !arg.startsWith("-")) name = arg;
  }
  if (!name) {
    console.error("Usage: love2d-studio new \"My Game\" [--dir DIR] [--template starter|empty] [--width 960 --height 600]");
    process.exit(1);
  }
  try {
    const project = await createProject({ name, parentDir, template, width, height });
    console.log(`Created ${project.path}`);
    console.log(`LuaCATS definitions: ${project.luaCatsSource}`);
    console.log("Open the Studio or run it from Zed to edit the scene.");
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

function help() {
  console.log(`
Love2D Studio ${JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version}

Usage:
  love2d-studio [studio|open] [--project DIR] [--new] [--no-browser] [--port N]
  love2d-studio setup [--install-zed] [--install-luacats] [--all]
  love2d-studio new "Name" [--dir DIR] [--template starter|empty] [--width N --height N]
  love2d-studio desktop [--project DIR] [--new]   Open the desktop app
  love2d-studio agent              Run the ACP agent on stdio (normally Zed does this)
  love2d-studio --version

Studio:
  Starts the local visual editor. In Zed, the generated tasks start it with the
  current project and open a browser.

Zed:
  Register the DeepSeek agent and Love2D snippets via the Studio Setup panel or
  "setup --install-zed", then restart Zed and pick "Love2D Assistant" in the
  Agent panel.

Environment:
  DEEPSEEK_API_KEY          API key override (otherwise Studio config is used)
  DEEPSEEK_BASE_URL         API endpoint override
  DEEPSEEK_MODEL            Model override (default: deepseek-flash)
  LOVE2D_PATH               Path to love.exe or lovec.exe
  ZED_PATH                  Path to zed.exe
`);
}

switch (command) {
  case "desktop":
    runDesktop(argv).catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
    break;
  case "studio":
  case "open":
    runNode(SERVER, ["open", ...argv]);
    break;
  case "setup":
    setup(argv).catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
    break;
  case "new":
    create(argv).catch((error) => {
      console.error(error.message);
      process.exit(1);
    });
    break;
  case "agent":
    runNode(AGENT, argv);
    break;
  case "version":
  case "--version":
    console.log(JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version);
    break;
  case "help":
  case "--help":
  case "-h":
    help();
    break;
  default:
    console.error(`Unknown command: ${command}`);
    help();
    process.exit(1);
}
