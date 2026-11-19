import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as jsonc from "jsonc-parser";
import {
  findZed,
  zedConfigDir,
  zedSettingsPath,
  zedSnippetsDir
} from "./zed.js";
import { findNodeExecutable } from "./node.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP_ROOT = path.resolve(HERE, "..", "..");
const AGENT_ENTRY = path.join(APP_ROOT, "src", "agent", "main.js");
const SNIPPET_SOURCE = path.join(APP_ROOT, "zed", "snippets", "lua.json");

function readJsonc(file, fallback) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8").replace(/^﻿/, "");
  } catch (error) {
    if (error.code === "ENOENT") return { value: fallback, text: null };
    throw error;
  }
  const errors = [];
  const value = jsonc.parse(text, errors, { allowTrailingComma: true });
  if (errors.length) {
    throw new Error(`Could not parse ${file}. Fix the JSON/JSONC syntax first.`);
  }
  return { value: value ?? fallback, text };
}

function backup(file) {
  if (!fs.existsSync(file)) return "";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const target = `${file}.love2d-studio-backup-${stamp}`;
  fs.copyFileSync(file, target);
  return target;
}

export function agentEntry() {
  return {
    type: "custom",
    command: findNodeExecutable(),
    args: [AGENT_ENTRY],
    env: {}
  };
}

export function inspectZedSetup() {
  const settingsPath = zedSettingsPath();
  const snippetPath = path.join(zedSnippetsDir(), "lua.json");
  let configured = false;
  let snippetsInstalled = false;
  let error = "";
  try {
    const { value } = readJsonc(settingsPath, {});
    configured = Boolean(value?.agent_servers?.["Love2D Assistant"]);
  } catch (cause) {
    error = cause.message;
  }
  try {
    const raw = fs.readFileSync(snippetPath, "utf8");
    const parsed = JSON.parse(raw);
    snippetsInstalled = Object.keys(parsed).some((key) => key.startsWith("Love2D:"));
  } catch {
    snippetsInstalled = false;
  }
  return {
    installed: Boolean(findZed()),
    settingsPath,
    configDir: zedConfigDir(),
    configured,
    snippetsInstalled,
    snippetPath,
    error
  };
}

export function installZedIntegration() {
  const configDir = zedConfigDir();
  fs.mkdirSync(configDir, { recursive: true });
  fs.mkdirSync(zedSnippetsDir(), { recursive: true });

  const settingsPath = zedSettingsPath();
  const settingsBackup = backup(settingsPath);
  const { value, text } = readJsonc(settingsPath, {});
  const settings = value && typeof value === "object" ? value : {};
  const edits = jsonc.modify(
    text ?? "{}\n",
    ["agent_servers", "Love2D Assistant"],
    agentEntry(),
    { formattingOptions: { insertSpaces: true, tabSize: 2 } }
  );
  let newSettingsText = jsonc.applyEdits(text ?? "{}\n", edits);
  if (!newSettingsText.endsWith("\n")) newSettingsText += "\n";
  fs.writeFileSync(settingsPath, newSettingsText, "utf8");

  const snippetPath = path.join(zedSnippetsDir(), "lua.json");
  const snippetBackup = backup(snippetPath);
  let snippets = {};
  if (fs.existsSync(snippetPath)) {
    try {
      snippets = JSON.parse(fs.readFileSync(snippetPath, "utf8").replace(/^﻿/, ""));
    } catch {
      throw new Error(
        `${snippetPath} contains invalid JSON. Fix or move it, then run setup again.`
      );
    }
  }
  const loveSnippets = JSON.parse(fs.readFileSync(SNIPPET_SOURCE, "utf8"));
  snippets = { ...snippets, ...loveSnippets };
  fs.writeFileSync(snippetPath, `${JSON.stringify(snippets, null, 2)}\n`, "utf8");

  return {
    installed: Boolean(findZed()),
    settingsPath,
    snippetPath,
    settingsBackup,
    snippetBackup,
    agentEntry: agentEntry(),
    restartRequired: true
  };
}

export function zedIntegrationPreview() {
  const settings = {
    agent_servers: {
      "Love2D Assistant": agentEntry()
    }
  };
  return JSON.stringify(settings, null, 2);
}
