import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const previousConfigDir = process.env.LOVE2D_STUDIO_CONFIG_DIR;
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "love2d-studio-test-"));
const configRoot = path.join(testRoot, "config");
process.env.LOVE2D_STUDIO_CONFIG_DIR = configRoot;
const realFetch = globalThis.fetch;
globalThis.fetch = async () => {
  throw new Error("offline test");
};

const { createProject } = await import("../src/studio/projects.js");
const {
  createScene,
  deleteScene,
  loadScene,
  saveScene,
  validateScene
} = await import("../src/studio/scenes.js");
const { deleteAsset, importAsset, listAssets } = await import("../src/studio/assets.js");

test.after(() => {
  globalThis.fetch = realFetch;
  if (previousConfigDir === undefined) delete process.env.LOVE2D_STUDIO_CONFIG_DIR;
  else process.env.LOVE2D_STUDIO_CONFIG_DIR = previousConfigDir;
  fs.rmSync(testRoot, { recursive: true, force: true });
});

test("project wizard scaffolds a playable project with Zed tasks", async () => {
  const project = await createProject({
    name: "Test Game",
    parentDir: path.join(testRoot, "projects"),
    template: "starter",
    width: 1024,
    height: 640
  });

  assert.equal(project.name, "Test Game");
  assert.equal(project.hasMain, true);
  assert.deepEqual(project.window, { width: 1024, height: 640 });
  for (const relative of [
    "main.lua",
    "conf.lua",
    "studio/scene.lua",
    "studio/json.lua",
    "scenes/main.json",
    ".luarc.json",
    ".rules",
    ".zed/tasks.json",
    ".zed/settings.json",
    ".zed/keymap.json",
    ".love2d-studio/project.json",
    ".love2d-studio/luacats/love2d/library/love.lua"
  ]) {
    assert.equal(fs.existsSync(path.join(project.path, relative)), true, relative);
  }

  const tasks = JSON.parse(fs.readFileSync(path.join(project.path, ".zed/tasks.json"), "utf8"));
  assert.equal(tasks.some((task) => task.label === "Love2D: Run Game"), true);
  assert.equal(tasks.some((task) => task.label === "Love2D: Open Studio"), true);

  const scene = JSON.parse(fs.readFileSync(path.join(project.path, "scenes", "main.json"), "utf8"));
  assert.equal(scene.width, 1024);
  assert.equal(scene.height, 640);
  assert.ok(scene.entities.some((entity) => entity.id === "ground"));

  const conf = fs.readFileSync(path.join(project.path, "conf.lua"), "utf8");
  assert.match(conf, /t\.window\.width = 1024/);
  assert.match(conf, /t\.window\.height = 640/);

  const luarc = JSON.parse(fs.readFileSync(path.join(project.path, ".luarc.json"), "utf8"));
  assert.deepEqual(luarc["workspace.library"], [".love2d-studio/luacats/love2d/library"]);
});

test("scene validation sanitises paths and preserves the Studio schema", () => {
  const project = path.resolve(testRoot, "projects", "Test Game");
  const scene = validateScene({
    name: "Level 1",
    width: 800,
    height: 450,
    background: [2, -1, 0.5],
    entities: [
      {
        id: "hero",
        type: "sprite",
        x: 10,
        y: 20,
        w: 32,
        h: 48,
        path: "../../outside.png",
        color: [1, 1, 1, 1]
      },
      {
        id: "hero",
        type: "text",
        x: 0,
        y: 0,
        w: 100,
        h: 20,
        text: "Hello",
        color: [1, 1, 1]
      }
    ]
  }, project);

  assert.equal(scene.background[0], 1);
  assert.equal(scene.background[1], 0);
  assert.equal(scene.entities.length, 2);
  assert.equal(scene.entities[0].path, "");
  assert.notEqual(scene.entities[0].id, scene.entities[1].id, "duplicate IDs are regenerated");
  assert.equal(scene.entities[1].type, "text");
  assert.equal(scene.entities[1].fontSize, 16);
});

test("scene files can be created, saved, loaded, and deleted", () => {
  const project = path.resolve(testRoot, "projects", "Test Game");
  const created = createScene(project, { name: "level-2", width: 480, height: 320 });
  assert.equal(created.name, "level-2");

  const saved = saveScene(project, "level-2", {
    ...created,
    entities: [
      {
        id: "box",
        name: "Box",
        type: "rectangle",
        x: 12,
        y: 24,
        w: 100,
        h: 50,
        color: [0.2, 0.4, 0.6, 1],
        properties: {
          solid: true,
          speed: 260,
          mode: "turbo",
          active: false,
          ignored: { nested: true }
        }
      }
    ]
  });
  assert.equal(saved.entities.length, 1);
  assert.deepEqual(saved.entities[0].properties, {
    solid: true,
    speed: 260,
    mode: "turbo",
    active: false
  });

  const loaded = loadScene(project, "level-2");
  assert.equal(loaded.entities[0].id, "box");
  assert.equal(loaded.width, 480);

  deleteScene(project, "level-2");
  assert.throws(() => loadScene(project, "level-2"), /not found/i);
  assert.throws(() => deleteScene(project, "main"), /at least one scene/i);
});

test("assets import, list, and delete", async () => {
  const project = path.resolve(testRoot, "projects", "Test Game");
  // 1x1 transparent PNG
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64"
  );
  const imported = importAsset(project, "hero.PNG", png);
  assert.equal(imported.kind, "image");
  assert.match(imported.path, /^assets\/images\/hero\.PNG$/);
  assert.equal(fs.existsSync(path.join(project, imported.path)), true);
  const listed = listAssets(project);
  assert.equal(listed.some((asset) => asset.path === imported.path && asset.width === 1), true);
  deleteAsset(project, imported.path);
  assert.equal(fs.existsSync(path.join(project, imported.path)), false);
  assert.throws(() => importAsset(project, "bad.exe", Buffer.from("nope")), /Unsupported/);
});
