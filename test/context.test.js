import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "love2d-context-test-"));
const project = path.join(testRoot, "Project");
fs.mkdirSync(path.join(project, "src", "ui"), { recursive: true });
fs.mkdirSync(path.join(project, ".love2d-studio"), { recursive: true });
fs.mkdirSync(path.join(project, "build"), { recursive: true });

fs.writeFileSync(path.join(project, "main.lua"), [
  "-- Entry point",
  'local Player = require("src.player")',
  "local Menu = require(\"src.ui.menu\")",
  "function love.load()",
  "  Player.new(10, 20)",
  "  Menu.open()",
  "end"
].join("\n"));
fs.writeFileSync(path.join(project, "src", "player.lua"), [
  "local Stats = require(\"src.stats\")",
  "",
  "-- Create a player.",
  "local Player = {}",
  "function Player.new(x, y)",
  "  return setmetatable({ x = x, y = y }, { __index = Player })",
  "end",
  "",
  "-- Move the player each frame.",
  "function Player:update(dt, speed)",
  "  self.x = self.x + speed * dt",
  "end",
  "",
  "local function clamp(value, low, high)",
  "  return math.max(low, math.min(high, value))",
  "end",
  "",
  "return Player"
].join("\n"));
fs.writeFileSync(path.join(project, "src", "ui", "menu.lua"), [
  "local Menu = {}",
  "function Menu.open()",
  "  return true",
  "end",
  "return Menu"
].join("\n"));
fs.writeFileSync(path.join(project, "build", "ignored.lua"), "function ignored() end\n");

const {
  appendProjectMemory,
  findIndexSymbols,
  loadProjectIndex,
  projectIndexPath,
  projectMemoryPath,
  readIndexedSymbol,
  readProjectMemory,
  renderIndexOutline
} = await import("../src/shared/project-context.js");
const { ToolRuntime } = await import("../src/agent/tools.js");

test.after(() => {
  fs.rmSync(testRoot, { recursive: true, force: true });
});

test("Lua index extracts modules, functions, methods, docs, and requires", () => {
  const index = loadProjectIndex(project, { force: true });
  assert.equal(index.totals.files, 3);
  assert.equal(index.totals.symbols, 5);
  assert.equal(fs.existsSync(projectIndexPath(project)), true);

  const player = index.files.find((file) => file.path === "src/player.lua");
  assert.ok(player);
  assert.equal(player.module, "src.player");
  assert.deepEqual(player.requires, ["src.stats"]);
  const update = player.symbols.find((symbol) => symbol.name === "Player:update");
  assert.equal(update.kind, "method");
  assert.equal(update.line, 10);
  assert.match(update.doc, /Move the player/i);
  assert.ok(player.symbols.some((symbol) => symbol.name === "clamp" && symbol.kind === "local"));
  assert.equal(index.files.some((file) => file.path.startsWith("build/")), false);

  const outline = renderIndexOutline(index);
  assert.match(outline, /src\/player\.lua/);
  assert.match(outline, /Player:update/);
  assert.match(outline, /src\/ui\/menu\.lua/);
});

test("symbol lookup reads one function instead of the whole file", () => {
  const index = loadProjectIndex(project);
  const matches = findIndexSymbols(index, "update");
  assert.ok(matches.some((match) => match.name === "Player:update"));
  assert.equal(findIndexSymbols(index, "", { file: "src/ui/menu.lua" }).length, 1);

  const symbol = readIndexedSymbol(project, index, "Player:update");
  assert.match(symbol, /function Player:update\(dt, speed\)/);
  assert.match(symbol, /self\.x = self\.x \+ speed \* dt/);
  assert.doesNotMatch(symbol, /function love\.load/);

  assert.throws(
    () => readIndexedSymbol(project, index, "does_not_exist"),
    /No indexed Lua symbol/
  );
});

test("project memory persists notes outside the game build", () => {
  const result = appendProjectMemory(project, "Player movement lives in src/player.lua.");
  assert.equal(result.path, projectMemoryPath(project));
  const memory = readProjectMemory(project);
  assert.match(memory, /Player movement lives in src\/player\.lua/);
  assert.match(result.path, /\.love2d-studio/);
});

test("write_files creates a modular scaffold and refreshes the index", async () => {
  const runtime = new ToolRuntime({
    sessionId: "context-test",
    cwd: project,
    additionalDirectories: [],
    client: null,
    clientCapabilities: {},
    signal: null
  });
  const files = [
    {
      path: "src/enemies/slime.lua",
      content: [
        "local Slime = {}",
        "function Slime.new(x, y)",
        "  return { x = x, y = y }",
        "end",
        "return Slime"
      ].join("\n")
    },
    {
      path: "src/systems/audio.lua",
      content: [
        "local Audio = {}",
        "function Audio.play(name)",
        "  return name",
        "end",
        "return Audio"
      ].join("\n")
    }
  ];
  const preview = await runtime.preview("write_files", { files });
  assert.equal(preview.locations.length, 2);
  assert.match(preview.title, /Write 2 files/);

  const result = await runtime.execute("write_files", { files });
  assert.equal(result.locations.length, 2);
  assert.match(result.text, /Wrote 2 files/);
  assert.equal(fs.existsSync(path.join(project, "src", "enemies", "slime.lua")), true);
  assert.equal(fs.existsSync(path.join(project, "src", "systems", "audio.lua")), true);

  const indexResult = await runtime.execute("code_index", { query: "Slime.new" });
  assert.match(indexResult.text, /src\/enemies\/slime\.lua/);
  const symbolResult = await runtime.execute("read_symbol", { name: "Slime.new" });
  assert.match(symbolResult.text, /function Slime\.new/);

  await runtime.execute("remember", { note: "Enemies live in src/enemies." });
  assert.match(readProjectMemory(project), /Enemies live in src\/enemies/);
});
