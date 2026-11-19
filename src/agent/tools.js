import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import * as acp from "@agentclientprotocol/sdk";
import {
  isInside,
  isProbablyText,
  readJson,
  walkFiles
} from "../shared/fsx.js";
import { findLove, killProcessTree, loveVersion } from "../shared/love.js";
import { readConfig } from "../shared/paths.js";
import { validateScene, sceneFile } from "../studio/scenes.js";
import { listAssets } from "../studio/assets.js";
import {
  appendProjectMemory,
  findIndexSymbols,
  loadProjectIndex,
  readIndexedSymbol,
  renderIndexOutline
} from "../shared/project-context.js";

const IGNORED = new Set([".git", "node_modules", ".svn", ".hg", "build", "dist", ".cache", "__pycache__"]);
const MAX_READ_CHARS = 140_000;
const MAX_WRITE_CHARS = 2_000_000;
const MAX_TOOL_OUTPUT = 28_000;

export const TOOL_DEFINITIONS = [
  {
    type: "function",
    function: {
      name: "project_info",
      description: "Get a summary of the current Love2D project: metadata, scenes, assets, LÖVE installation, and file tree.",
      parameters: {
        type: "object",
        properties: {},
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "code_index",
      description: "Search the persistent Lua code index for modules, functions, methods, and require dependencies without reading whole files. Omit query to return the project outline.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Function, method, module, file, or text to find. Optional." },
          file: { type: "string", description: "Optional Lua file path filter." },
          max_results: { type: "integer", minimum: 1, maximum: 100, description: "Maximum matches. Defaults to 50." }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_symbol",
      description: "Read a single indexed Lua function or method by name. Prefer this over reading an entire file when you only need one function. Optionally provide a file to disambiguate.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Function or method name, such as Player:update or requirePlayer." },
          file: { type: "string", description: "Optional Lua file path to disambiguate." }
        },
        required: ["name"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description: "List files under a project folder. Use before opening unfamiliar parts of the project.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Project-relative folder, or absolute path inside the project. Defaults to the project root." },
          recursive: { type: "boolean", description: "Walk subfolders. Defaults to true." },
          max_depth: { type: "integer", minimum: 1, maximum: 12, description: "Maximum folder depth. Defaults to 4." }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description: "Read a UTF-8 text file. Returns line-numbered context in the result header. Read files before editing them.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the project root." },
          start_line: { type: "integer", minimum: 1, description: "First line to return (1-based)." },
          end_line: { type: "integer", minimum: 1, description: "Last line to return (inclusive)." }
        },
        required: ["path"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "search_files",
      description: "Search project text files for a substring or regular expression. Use this to find callbacks, references, or symbols.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Text or regex to find." },
          regex: { type: "boolean", description: "Treat query as a JavaScript regular expression. Defaults to false." },
          path: { type: "string", description: "Optional subfolder to search." },
          max_results: { type: "integer", minimum: 1, maximum: 200, description: "Maximum matches, default 60." }
        },
        required: ["query"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description: "Replace an entire text file. Prefer edit_file for small changes. Requires user approval.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the project root." },
          content: { type: "string", description: "The complete new file content." }
        },
        required: ["path", "content"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "write_files",
      description: "Create or replace multiple project files in one operation. Use this to scaffold modular Lua code (main.lua plus src/ modules) in one approval. Paths must stay inside the project.",
      parameters: {
        type: "object",
        properties: {
          files: {
            type: "array",
            minItems: 1,
            maxItems: 20,
            items: {
              type: "object",
              properties: {
                path: { type: "string", description: "Project-relative file path, such as src/player.lua." },
                content: { type: "string", description: "Complete file content." }
              },
              required: ["path", "content"],
              additionalProperties: false
            }
          }
        },
        required: ["files"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description: "Make a precise text replacement in one file. old_text must match exactly and be unique unless replace_all is true. Requires user approval.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path relative to the project root." },
          old_text: { type: "string", description: "Exact existing text to replace." },
          new_text: { type: "string", description: "Replacement text." },
          replace_all: { type: "boolean", description: "Replace every exact occurrence. Defaults to false." }
        },
        required: ["path", "old_text", "new_text"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_scenes",
      description: "List the Studio scenes in this project with dimensions and entity counts.",
      parameters: { type: "object", properties: {}, additionalProperties: false }
    }
  },
  {
    type: "function",
    function: {
      name: "read_scene",
      description: "Read a Studio scene JSON file by name.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Scene name such as 'main' (without .json)." }
        },
        required: ["name"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "write_scene",
      description: "Create or replace a Studio scene from a scene object. Follow the scene schema in the system prompt. Requires user approval.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string", description: "Scene file name without .json." },
          scene: {
            type: "object",
            description: "Scene object with width, height, background [r,g,b,a], and entities array.",
            properties: {
              name: { type: "string" },
              width: { type: "integer" },
              height: { type: "integer" },
              background: { type: "array", items: { type: "number" } },
              entities: { type: "array", items: { type: "object" } }
            },
            required: ["width", "height", "entities"]
          }
        },
        required: ["name", "scene"],
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "list_assets",
      description: "List images, audio, and fonts in the project's assets folder.",
      parameters: { type: "object", properties: {}, additionalProperties: false }
    }
  },
  {
    type: "function",
    function: {
      name: "run_game",
      description: "Launch the LÖVE game for a short smoke test, capture console output, then stop it. Use this to catch startup and Lua errors after changes. Requires user approval.",
      parameters: {
        type: "object",
        properties: {
          timeout_seconds: { type: "integer", minimum: 2, maximum: 30, description: "How long to let the game run before stopping it. Defaults to 6 seconds." }
        },
        additionalProperties: false
      }
    }
  },
  {
    type: "function",
    function: {
      name: "remember",
      description: "Append a concise durable note to the project's persistent AI memory: architecture decisions, module responsibilities, conventions, or user preferences. Use after meaningful design decisions. Never store secrets.",
      parameters: {
        type: "object",
        properties: {
          note: { type: "string", description: "Short durable note, ideally under 500 characters." }
        },
        required: ["note"],
        additionalProperties: false
      }
    }
  }
];

export const ASK_USER_TOOL = {
  type: "function",
  function: {
    name: "ask_user",
    description: "Ask the user to choose between 2-4 options when a decision or preference is needed. The desktop chat renders the options as selectable buttons. Use this instead of listing choices in a normal chat message. After the tool returns, continue with the selected option.",
    parameters: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description: "A short, clear question. Do not include the option list in the question text."
        },
        options: {
          type: "array",
          description: "Two to four short answer labels, each ideally under 60 characters.",
          items: { type: "string" },
          minItems: 2,
          maxItems: 4
        }
      },
      required: ["question", "options"],
      additionalProperties: false
    }
  }
};

export const DESKTOP_TOOL_DEFINITIONS = [...TOOL_DEFINITIONS, ASK_USER_TOOL];

const WRITE_TOOLS = new Set(["write_file", "write_files", "edit_file", "write_scene"]);
const RUN_TOOLS = new Set(["run_game"]);

export function toolKind(name) {
  if (name === "run_game") return "execute";
  if (WRITE_TOOLS.has(name)) return "edit";
  if (name === "read_file" || name === "read_symbol" || name === "list_files" || name === "list_scenes" || name === "read_scene" || name === "list_assets" || name === "project_info") return "read";
  if (name === "search_files" || name === "code_index") return "search";
  return "other";
}

export function requiresPermission(name) {
  return WRITE_TOOLS.has(name) || RUN_TOOLS.has(name);
}

export function isRunTool(name) {
  return RUN_TOOLS.has(name);
}

export function isWriteTool(name) {
  return WRITE_TOOLS.has(name);
}

function normalizeFileWrites(args) {
  const files = Array.isArray(args?.files) ? args.files : [];
  if (!files.length) throw new Error("At least one file is required.");
  if (files.length > 20) throw new Error("write_files supports at most 20 files per call.");
  const seen = new Set();
  let total = 0;
  return files.map((item, index) => {
    const filePath = typeof item?.path === "string" ? item.path.trim() : "";
    const content = typeof item?.content === "string" ? item.content : "";
    if (!filePath) throw new Error(`File ${index + 1} is missing a path.`);
    if (seen.has(filePath)) throw new Error(`Duplicate path in write_files: ${filePath}`);
    seen.add(filePath);
    if (content.length > MAX_WRITE_CHARS) {
      throw new Error(`${filePath} is over the 2 MB write limit.`);
    }
    total += content.length;
    if (total > MAX_WRITE_CHARS * 4) {
      throw new Error("The combined write_files payload is too large.");
    }
    return { path: filePath, content };
  });
}

export class ToolRuntime {
  constructor({
    sessionId,
    cwd,
    additionalDirectories = [],
    client,
    clientCapabilities,
    signal,
    gameLogFile = ""
  }) {
    this.sessionId = sessionId;
    this.cwd = path.resolve(cwd);
    this.additionalDirectories = additionalDirectories.filter((dir) => typeof dir === "string");
    this.client = client;
    this.capabilities = clientCapabilities || {};
    this.signal = signal;
    this.gameLogFile = gameLogFile;
    this.activeTerminals = new Set();
    this.activeChildren = new Set();
    this.cancelled = false;
    this.signal?.addEventListener("abort", () => this.cancel(), { once: true });
  }

  get roots() {
    return [this.cwd, ...this.additionalDirectories];
  }

  cancel() {
    this.cancelled = true;
    for (const handle of this.activeTerminals) {
      handle.kill().catch(() => {});
      handle.release().catch(() => {});
    }
    this.activeTerminals.clear();
    for (const child of this.activeChildren) {
      killProcessTree(child);
    }
    this.activeChildren.clear();
  }

  resolve(input, { allowMissing = false } = {}) {
    const value = typeof input === "string" && input.trim() ? input.trim() : ".";
    const candidate = path.isAbsolute(value)
      ? path.normalize(value)
      : path.resolve(this.cwd, value);
    for (const root of this.roots) {
      let realRoot;
      try {
        realRoot = fs.realpathSync.native(root);
      } catch {
        continue;
      }
      let check = candidate;
      if (allowMissing) {
        while (!fs.existsSync(check) && path.dirname(check) !== check) {
          check = path.dirname(check);
        }
      }
      let realCheck;
      try {
        realCheck = fs.realpathSync.native(check);
      } catch {
        continue;
      }
      if (isInside(realRoot, realCheck)) {
        return candidate;
      }
    }
    throw new Error(`Path is outside the workspace: ${input}`);
  }

  display(file) {
    const relative = path.relative(this.cwd, file);
    return relative || path.basename(file);
  }

  async preview(name, args) {
    const kind = toolKind(name);
    const preview = {
      kind,
      title: name,
      locations: [],
      diff: null
    };
    if (name === "read_file") {
      const file = this.resolve(args.path);
      preview.title = `Read ${this.display(file)}`;
      preview.locations = [{ path: file }];
    } else if (name === "list_files") {
      preview.title = `List files in ${args.path || "."}`;
    } else if (name === "search_files") {
      preview.title = `Search for ${String(args.query || "").slice(0, 60)}`;
    } else if (name === "code_index") {
      preview.title = args.query
        ? `Search code index for ${String(args.query).slice(0, 60)}`
        : "Show Lua architecture";
    } else if (name === "read_symbol") {
      preview.title = `Read symbol ${String(args.name || "").slice(0, 80)}`;
    } else if (name === "remember") {
      preview.title = "Save project memory note";
    } else if (name === "project_info") {
      preview.title = "Inspect project";
    } else if (name === "list_scenes") {
      preview.title = "List scenes";
    } else if (name === "read_scene") {
      preview.title = `Read scene ${args.name || ""}`;
    } else if (name === "list_assets") {
      preview.title = "List assets";
    } else if (name === "write_file") {
      const file = this.resolve(args.path, { allowMissing: true });
      const oldText = await this.tryRead(file);
      const newText = String(args.content ?? "");
      preview.title = `Write ${this.display(file)}`;
      preview.locations = [{ path: file }];
      preview.diff = { path: file, oldText, newText };
    } else if (name === "write_files") {
      const writes = normalizeFileWrites(args);
      const oldSections = [];
      const newSections = [];
      for (const write of writes) {
        const file = this.resolve(write.path, { allowMissing: true });
        const oldText = await this.tryRead(file);
        preview.locations.push({ path: file });
        oldSections.push(`### ${this.display(file)}\n${oldText ?? "(new file)"}`);
        newSections.push(`### ${this.display(file)}\n${write.content}`);
      }
      preview.title = `Write ${writes.length} files`;
      preview.diff = {
        path: "Multiple files",
        oldText: oldSections.join("\n\n"),
        newText: newSections.join("\n\n")
      };
    } else if (name === "edit_file") {
      const file = this.resolve(args.path);
      const oldContent = await this.readText(file, { enforceLimit: true });
      if (!oldContent) throw new Error(`File not found: ${args.path}`);
      const oldText = String(args.old_text ?? "");
      const newText = String(args.new_text ?? "");
      if (!oldText) throw new Error("old_text must not be empty.");
      const count = countOccurrences(oldContent, oldText);
      if (count === 0) throw new Error("old_text was not found in the file.");
      if (count > 1 && !args.replace_all) {
        throw new Error(`old_text occurs ${count} times. Provide more context or set replace_all.`);
      }
      const updated = args.replace_all
        ? oldContent.split(oldText).join(newText)
        : oldContent.replace(oldText, newText);
      preview.title = `Edit ${this.display(file)}`;
      preview.locations = [{ path: file }];
      preview.diff = { path: file, oldText: oldContent, newText: updated };
    } else if (name === "write_scene") {
      const target = sceneFile(this.cwd, args.name || "main");
      const oldText = await this.tryRead(target.file);
      const scene = validateScene({ ...args.scene, name: args.name || args.scene?.name }, this.cwd);
      const newText = `${JSON.stringify(scene, null, 2)}\n`;
      preview.title = `Write scene ${target.slug}`;
      preview.locations = [{ path: target.file }];
      preview.diff = { path: target.file, oldText, newText };
    } else if (name === "run_game") {
      const love = findLove({ console: true });
      if (!love) throw new Error("LÖVE was not found. Ask the user to set it in Studio Setup.");
      preview.title = `Run game for ${args.timeout_seconds || 6}s`;
    }
    return preview;
  }

  async execute(name, args) {
    switch (name) {
      case "project_info":
        return { text: await this.projectInfo() };
      case "code_index":
        return { text: this.codeIndex(args) };
      case "read_symbol":
        return { text: this.readSymbol(args) };
      case "remember":
        return this.remember(args);
      case "list_files":
        return { text: this.listFiles(args) };
      case "read_file":
        return { text: await this.readFile(args) };
      case "search_files":
        return { text: this.searchFiles(args) };
      case "write_file":
        return this.writeFile(args);
      case "write_files":
        return this.writeFiles(args);
      case "edit_file":
        return this.editFile(args);
      case "list_scenes":
        return { text: this.listScenes() };
      case "read_scene":
        return { text: this.readScene(args) };
      case "write_scene":
        return this.writeScene(args);
      case "list_assets":
        return { text: this.assetsText() };
      case "run_game":
        return this.runGame(args);
      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  projectInfo() {
    let meta = null;
    try {
      meta = readJson(path.join(this.cwd, ".love2d-studio", "project.json"));
    } catch {
      meta = null;
    }
    const love = findLove({ console: true });
    const scenes = this.sceneSummaries();
    const assets = safeAssets(this.cwd);
    const tree = walkTree(this.cwd, { maxDepth: 3, maxEntries: 220 });
    let luaIndex = null;
    try {
      const index = loadProjectIndex(this.cwd);
      luaIndex = {
        files: index.totals?.files || 0,
        lines: index.totals?.lines || 0,
        symbols: index.totals?.symbols || 0,
        generatedAt: index.generatedAt,
        indexPath: this.display(path.join(this.cwd, ".love2d-studio", "ai", "index.json"))
      };
    } catch {
      luaIndex = null;
    }
    return JSON.stringify({
      name: meta?.name || path.basename(this.cwd),
      path: this.cwd,
      template: meta?.template || null,
      hasMainLua: fs.existsSync(path.join(this.cwd, "main.lua")),
      hasConfLua: fs.existsSync(path.join(this.cwd, "conf.lua")),
      love: {
        path: love || "",
        version: love ? loveVersion(love) : "",
        installed: Boolean(love)
      },
      scenes,
      assets: assets.map((asset) => ({ path: asset.path, kind: asset.kind, size: asset.size })),
      luaIndex,
      tree
    }, null, 2);
  }

  codeIndex(args) {
    const index = loadProjectIndex(this.cwd);
    const query = String(args.query || "").trim();
    const file = String(args.file || "").trim();
    if (!query && !file) return renderIndexOutline(index);
    const matches = findIndexSymbols(index, query, {
      file,
      max: clampInt(args.max_results, 1, 100, 50)
    });
    if (!matches.length) {
      return `No indexed Lua symbols match ${JSON.stringify(query || file)}. Use search_files if the text is not a function or module.`;
    }
    return matches.map((symbol) =>
      `${symbol.file}:${symbol.line} ${symbol.signature} [${symbol.kind}]${symbol.doc ? ` — ${symbol.doc}` : ""}`
    ).join("\n");
  }

  readSymbol(args) {
    const index = loadProjectIndex(this.cwd);
    return readIndexedSymbol(this.cwd, index, args.name, args.file);
  }

  remember(args) {
    const result = appendProjectMemory(this.cwd, args.note);
    return {
      text: `Saved to project AI memory.\n${result.note}`,
      locations: [{ path: result.path }]
    };
  }

  listFiles(args) {
    const root = this.resolve(args.path || ".");
    if (!fs.existsSync(root)) throw new Error("Folder not found.");
    const recursive = args.recursive !== false;
    const maxDepth = clampInt(args.max_depth, 1, 12, 4);
    const results = [];
    const visit = (dir, depth) => {
      if (results.length >= 500) return;
      let entries;
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      for (const entry of entries) {
        if (IGNORED.has(entry.name)) continue;
        if (entry.name === ".love2d-studio" && dir === this.cwd) continue;
        const full = path.join(dir, entry.name);
        results.push(this.display(full) + (entry.isDirectory() ? "/" : ""));
        if (entry.isDirectory() && recursive && depth < maxDepth) visit(full, depth + 1);
        if (results.length >= 500) return;
      }
    };
    visit(root, 1);
    return results.length ? results.join("\n") : "(empty folder)";
  }

  async readFile(args) {
    const file = this.resolve(args.path);
    const stat = fs.statSync(file);
    if (!stat.isFile()) throw new Error("Path is not a file.");
    if (stat.size > 2_000_000) throw new Error("File is too large to read (over 2 MB).");
    if (!isProbablyText(file)) throw new Error("File does not appear to be UTF-8 text.");
    let content = await this.readText(file, { enforceLimit: false });
    if (content === null) throw new Error("File not found.");
    const lines = content.split(/\r?\n/);
    const start = clampInt(args.start_line, 1, lines.length, 1);
    const end = clampInt(args.end_line, start, lines.length, lines.length);
    let selected = lines.slice(start - 1, end).join("\n");
    let truncated = false;
    if (selected.length > MAX_READ_CHARS) {
      selected = selected.slice(0, MAX_READ_CHARS);
      truncated = true;
    }
    return `File: ${this.display(file)} (lines ${start}-${end} of ${lines.length})\n\n${selected}${truncated ? "\n\n[truncated by the tool; read a smaller line range]" : ""}`;
  }

  searchFiles(args) {
    const query = String(args.query ?? "");
    if (!query) throw new Error("query is required.");
    let matcher;
    if (args.regex) {
      try {
        matcher = new RegExp(query, "i");
      } catch (error) {
        throw new Error(`Invalid regular expression: ${error.message}`);
      }
    }
    const base = this.resolve(args.path || ".");
    const maxResults = clampInt(args.max_results, 1, 200, 60);
    const files = walkFiles(base, { maxFiles: 2500, maxDepth: 12 });
    const results = [];
    for (const file of files) {
      if (results.length >= maxResults) break;
      if (!isProbablyText(file)) continue;
      let text;
      try {
        const stat = fs.statSync(file);
        if (stat.size > 1_000_000) continue;
        text = fs.readFileSync(file, "utf8");
      } catch {
        continue;
      }
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index];
        if (args.regex ? matcher.test(line) : line.toLowerCase().includes(query.toLowerCase())) {
          results.push(`${this.display(file)}:${index + 1}: ${line.trim().slice(0, 300)}`);
          if (results.length >= maxResults) break;
        }
      }
    }
    return results.length
      ? results.join("\n")
      : `No matches for ${JSON.stringify(query)}.`;
  }

  async tryRead(file) {
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size > MAX_WRITE_CHARS || !isProbablyText(file)) return null;
      return await this.readText(file, { enforceLimit: true });
    } catch {
      return null;
    }
  }

  async readText(file, { enforceLimit = true } = {}) {
    const absolute = path.resolve(file);
    const canUseClient = this.capabilities?.fs?.readTextFile === true;
    let content = null;
    if (canUseClient) {
      try {
        const response = await this.client.request(acp.methods.client.fs.readTextFile, {
          sessionId: this.sessionId,
          path: absolute
        });
        content = response.content;
      } catch {
        content = null;
      }
    }
    if (content === null) {
      if (!fs.existsSync(absolute)) return null;
      content = fs.readFileSync(absolute, "utf8");
    }
    if (enforceLimit && content.length > MAX_WRITE_CHARS) {
      throw new Error("File is too large for this tool.");
    }
    return content;
  }

  async writeFileContent(file, content) {
    if (content.length > MAX_WRITE_CHARS) {
      throw new Error("Refusing to write a file over 2 MB.");
    }
    const absolute = path.resolve(file);
    const canUseClient = this.capabilities?.fs?.writeTextFile === true;
    if (canUseClient) {
      try {
        await this.client.request(acp.methods.client.fs.writeTextFile, {
          sessionId: this.sessionId,
          path: absolute,
          content
        });
        return;
      } catch (error) {
        if (!fs.existsSync(absolute)) {
          throw new Error(`Zed could not write ${this.display(absolute)}: ${error.message}`);
        }
      }
    }
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    fs.writeFileSync(absolute, content, "utf8");
  }

  async writeFile(args) {
    if (this.cancelled) throw new Error("Cancelled.");
    const file = this.resolve(args.path, { allowMissing: true });
    const content = String(args.content ?? "");
    await this.writeFileContent(file, content);
    return {
      text: `Wrote ${content.length} characters to ${this.display(file)}.`,
      diff: { path: file, newText: content },
      locations: [{ path: file }]
    };
  }

  async writeFiles(args) {
    if (this.cancelled) throw new Error("Cancelled.");
    const writes = normalizeFileWrites(args);
    const targets = writes.map((write) => ({
      ...write,
      file: this.resolve(write.path, { allowMissing: true })
    }));
    const oldSections = [];
    for (const target of targets) {
      const oldText = await this.tryRead(target.file);
      oldSections.push(`### ${this.display(target.file)}\n${oldText ?? "(new file)"}`);
    }
    for (const target of targets) {
      await this.writeFileContent(target.file, target.content);
    }
    const newSections = targets.map((target) =>
      `### ${this.display(target.file)}\n${target.content}`
    );
    return {
      text: `Wrote ${targets.length} files:\n${targets
        .map((target) => `- ${this.display(target.file)} (${target.content.length} chars)`)
        .join("\n")}`,
      diff: {
        path: "Multiple files",
        oldText: oldSections.join("\n\n"),
        newText: newSections.join("\n\n")
      },
      locations: targets.map((target) => ({ path: target.file }))
    };
  }

  async editFile(args) {
    if (this.cancelled) throw new Error("Cancelled.");
    const file = this.resolve(args.path);
    const original = await this.readText(file, { enforceLimit: true });
    if (original === null) throw new Error(`File not found: ${this.display(file)}`);
    const oldText = String(args.old_text ?? "");
    const newText = String(args.new_text ?? "");
    const count = countOccurrences(original, oldText);
    if (count === 0) throw new Error("old_text was not found in the file.");
    if (count > 1 && !args.replace_all) {
      throw new Error(`old_text occurs ${count} times. Provide more context or set replace_all.`);
    }
    const updated = args.replace_all
      ? original.split(oldText).join(newText)
      : original.replace(oldText, newText);
    await this.writeFileContent(file, updated);
    return {
      text: `Updated ${this.display(file)} (${count} replacement${count === 1 ? "" : "s"}).`,
      diff: { path: file, oldText: original, newText: updated },
      locations: [{ path: file }]
    };
  }

  sceneSummaries() {
    const dir = path.join(this.cwd, "scenes");
    try {
      return fs.readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".json"))
        .map((entry) => {
          try {
            const scene = readJson(path.join(dir, entry.name));
            return {
              name: entry.name.replace(/\.json$/i, ""),
              width: scene.width,
              height: scene.height,
              entities: Array.isArray(scene.entities) ? scene.entities.length : 0
            };
          } catch {
            return { name: entry.name.replace(/\.json$/i, ""), invalid: true };
          }
        })
        .sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return [];
    }
  }

  listScenes() {
    const scenes = this.sceneSummaries();
    if (!scenes.length) return "No scenes found. The scenes/ folder is empty.";
    return scenes.map((scene) => scene.invalid
      ? `${scene.name}: invalid JSON`
      : `${scene.name}: ${scene.width}x${scene.height}, ${scene.entities} entities`).join("\n");
  }

  readScene(args) {
    const name = String(args.name || "").replace(/\.json$/i, "");
    if (!/^[A-Za-z0-9 _-]+$/.test(name)) throw new Error("Invalid scene name.");
    const file = path.join(this.cwd, "scenes", `${name}.json`);
    if (!fs.existsSync(file)) throw new Error(`Scene not found: ${name}`);
    const scene = readJson(file);
    return `${JSON.stringify(scene, null, 2)}`;
  }

  async writeScene(args) {
    if (this.cancelled) throw new Error("Cancelled.");
    const name = String(args.name || "").replace(/\.json$/i, "");
    if (!/^[A-Za-z0-9 _-]+$/.test(name)) throw new Error("Invalid scene name.");
    const target = sceneFile(this.cwd, name);
    const previous = await this.tryRead(target.file);
    const scene = validateScene({ ...args.scene, name }, this.cwd);
    const content = `${JSON.stringify(scene, null, 2)}\n`;
    await this.writeFileContent(target.file, content);
    return {
      text: `Wrote scene ${name} (${scene.entities.length} entities, ${scene.width}x${scene.height}).`,
      diff: { path: target.file, oldText: previous, newText: content },
      locations: [{ path: target.file }]
    };
  }

  assetsText() {
    const assets = safeAssets(this.cwd);
    if (!assets.length) return "No managed assets in assets/images, assets/audio, or assets/fonts.";
    return assets.map((asset) => {
      const dims = asset.width && asset.height ? ` ${asset.width}x${asset.height}` : "";
      return `${asset.path} (${asset.kind}${dims}, ${asset.size} bytes)`;
    }).join("\n");
  }

  gameLogPath() {
    return this.gameLogFile || path.join(this.cwd, ".love2d-studio", "runtime", "game.log");
  }

  prepareGameLog() {
    const logFile = this.gameLogPath();
    try {
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.writeFileSync(logFile, "", "utf8");
      return logFile;
    } catch {
      return "";
    }
  }

  readGameLog() {
    const logFile = this.gameLogPath();
    try {
      const text = fs.readFileSync(logFile, "utf8");
      return text.replace(/^\d{2}:\d{2}:\d{2}\s/gm, "").trim();
    } catch {
      return "";
    }
  }

  async runGame(args) {
    if (this.cancelled) throw new Error("Cancelled.");
    const love = findLove({ console: true });
    if (!love) throw new Error("LÖVE was not found. Ask the user to set it in Studio Setup.");
    const timeoutSeconds = clampInt(args.timeout_seconds, 2, 30, 6);
    const logFile = this.prepareGameLog();
    if (this.capabilities?.terminal === true) {
      return this.runInClientTerminal(love, timeoutSeconds, logFile);
    }
    return this.runChild(love, timeoutSeconds, logFile);
  }

  async runInClientTerminal(love, timeoutSeconds, logFile) {
    let handle;
    const env = logFile ? [{ name: "LOVE2D_STUDIO_LOG", value: logFile }] : [];
    try {
      handle = await this.client.createTerminal({
        sessionId: this.sessionId,
        command: love,
        args: ["."],
        cwd: this.cwd,
        env,
        outputByteLimit: 200_000
      });
    } catch (error) {
      throw new Error(`Could not start LÖVE in a Zed terminal: ${error.message}`);
    }
    this.activeTerminals.add(handle);
    let timedOut = false;
    let exit = null;
    try {
      const timeout = new Promise((resolve) => setTimeout(() => resolve("timeout"), timeoutSeconds * 1000));
      const result = await Promise.race([handle.waitForExit(), timeout]);
      if (result === "timeout") {
        timedOut = true;
        await handle.kill().catch(() => {});
      } else {
        exit = result;
      }
      await new Promise((resolve) => setTimeout(resolve, 180));
      const output = await handle.currentOutput().catch(() => ({ output: "", truncated: false }));
      const fileOutput = this.readGameLog();
      const consoleOutput = output.output?.trim() || "";
      const text = truncate(
        [fileOutput, consoleOutput].filter(Boolean).join("\n"),
        24_000
      );
      const summary = timedOut
        ? `Game ran for ${timeoutSeconds}s without exiting, then was stopped. This usually means startup succeeded.`
        : exit?.exitCode === 0
          ? "Game exited with code 0."
          : `Game exited unexpectedly with code ${exit?.exitCode ?? "unknown"}.`;
      const resultText = `${summary}\n\n${text || "(no console output)"}`;
      return {
        text: resultText,
        terminalId: handle.id,
        locations: [],
        failed: !timedOut && exit?.exitCode !== 0
      };
    } finally {
      this.activeTerminals.delete(handle);
      await handle.release().catch(() => {});
    }
  }

  runChild(love, timeoutSeconds, logFile) {
    return new Promise((resolve, reject) => {
      const child = spawn(love, ["."], {
        cwd: this.cwd,
        windowsHide: true,
        env: {
          ...process.env,
          ...(logFile ? { LOVE2D_STUDIO_LOG: logFile } : {})
        },
        stdio: ["ignore", "pipe", "pipe"]
      });
      this.activeChildren.add(child);
      let stdout = "";
      let stderr = "";
      let timedOut = false;
      let settled = false;
      const finish = (code, signal) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.activeChildren.delete(child);
        const streamText = [stdout, stderr].filter(Boolean).join("\n").trim();
        const fileText = this.readGameLog();
        const text = truncate(
          [fileText, streamText].filter(Boolean).join("\n") || "(no console output)",
          24_000
        );
        const summary = timedOut
          ? `Game ran for ${timeoutSeconds}s without exiting, then was stopped. This usually means startup succeeded.`
          : code === 0
            ? "Game exited with code 0."
            : `Game exited unexpectedly with code ${code ?? signal ?? "unknown"}.`;
        resolve({
          text: `${summary}\n\n${text}`,
          failed: !timedOut && code !== 0
        });
      };
      const timer = setTimeout(() => {
        timedOut = true;
        killProcessTree(child);
        setTimeout(() => finish(null, "timeout"), 600);
      }, timeoutSeconds * 1000);
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk) => {
        stdout = truncate(stdout + chunk, 80_000);
      });
      child.stderr?.on("data", (chunk) => {
        stderr = truncate(stderr + chunk, 80_000);
      });
      child.on("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.activeChildren.delete(child);
        reject(new Error(`Could not start LÖVE: ${error.message}`));
      });
      child.on("exit", (code, signal) => finish(code, signal));
      this.signal?.addEventListener("abort", () => {
        if (settled) return;
        killProcessTree(child);
      }, { once: true });
    });
  }
}

function countOccurrences(haystack, needle) {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while ((index = haystack.indexOf(needle, index)) !== -1) {
    count += 1;
    index += needle.length;
  }
  return count;
}

function clampInt(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(number)));
}

function truncate(text, limit) {
  const value = String(text ?? "");
  return value.length > limit ? `${value.slice(0, limit)}\n\n[output truncated]` : value;
}

function walkTree(root, { maxDepth = 3, maxEntries = 200 } = {}) {
  const lines = [];
  const visit = (dir, prefix, depth) => {
    if (depth > maxDepth || lines.length >= maxEntries) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries = entries
      .filter((entry) => !IGNORED.has(entry.name))
      .filter((entry) => !(dir === root && entry.name === ".love2d-studio"))
      .sort((a, b) => {
        if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
        return a.name.localeCompare(b.name);
      });
    entries.forEach((entry, index) => {
      if (lines.length >= maxEntries) return;
      const last = index === entries.length - 1;
      lines.push(`${prefix}${last ? "└─ " : "├─ "}${entry.name}${entry.isDirectory() ? "/" : ""}`);
      if (entry.isDirectory()) {
        visit(path.join(dir, entry.name), `${prefix}${last ? "   " : "│  "}`, depth + 1);
      }
    });
  };
  visit(root, "", 1);
  return lines.join("\n");
}

function safeAssets(projectPath) {
  try {
    return listAssets(projectPath);
  } catch {
    return [];
  }
}
