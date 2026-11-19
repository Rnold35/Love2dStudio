import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import AdmZip from "adm-zip";

const previousConfigDir = process.env.LOVE2D_STUDIO_CONFIG_DIR;
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "love2d-studio-build-test-"));
process.env.LOVE2D_STUDIO_CONFIG_DIR = path.join(testRoot, "config");

const { buildGame, buildInfo } = await import("../src/studio/build.js");

const projectPath = path.join(testRoot, "My Game");

function write(relative, content = "") {
  const file = path.join(projectPath, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

fs.mkdirSync(projectPath, { recursive: true });
write("main.lua", "function love.draw() end\n");
write("conf.lua", "function love.conf(t) t.window.width = 640 end\n");
write("scenes/main.json", JSON.stringify({
  version: 1,
  name: "main",
  width: 640,
  height: 360,
  entities: []
}, null, 2));
write("studio/log.lua", "return {}\n");
write("assets/hello.txt", "asset\n");
write(".love2d-studio/project.json", JSON.stringify({ version: 1, name: "My Game" }));
write(".love2d-studio/runtime/game.log", "runtime log\n");
write(".zed/tasks.json", "{}\n");
write(".git/config", "[core]\n");
write("node_modules/package/index.js", "module.exports = 1;\n");
write("build/stale.txt", "stale\n");
write("dist/stale.txt", "stale\n");
write("README.md", "# My Game\n");

test.after(() => {
  if (previousConfigDir === undefined) delete process.env.LOVE2D_STUDIO_CONFIG_DIR;
  else process.env.LOVE2D_STUDIO_CONFIG_DIR = previousConfigDir;
  fs.rmSync(testRoot, { recursive: true, force: true });
});

test("build info reports formats and Windows runtime readiness", () => {
  const info = buildInfo(projectPath);
  assert.equal(info.project.name, "My Game");
  assert.equal(info.project.hasMain, true);
  assert.equal(info.formats.some((format) => format.id === "windows-zip"), true);
  assert.equal(info.formats.some((format) => format.id === "love"), true);
  assert.equal(info.formats.some((format) => format.id === "windows"), true);
  assert.equal(typeof info.love.windowsReady, "boolean");
});

test("portable .love includes game files but excludes editor and build data", () => {
  const result = buildGame(projectPath, { format: "love" });
  assert.equal(result.format, "love");
  assert.equal(result.artifacts.length, 1);
  const artifact = result.artifacts[0];
  assert.equal(artifact.kind, "love");
  assert.equal(artifact.path.endsWith("My Game.love"), true);
  assert.equal(fs.existsSync(artifact.path), true);
  assert.ok(artifact.bytes > 0);

  const entries = new AdmZip(artifact.path).getEntries().map((entry) => entry.entryName);
  assert.ok(entries.includes("main.lua"));
  assert.ok(entries.includes("conf.lua"));
  assert.ok(entries.includes("scenes/main.json"));
  assert.ok(entries.includes("studio/log.lua"));
  assert.ok(entries.includes("assets/hello.txt"));
  assert.equal(entries.some((entry) => entry.startsWith(".zed/")), false);
  assert.equal(entries.some((entry) => entry.startsWith(".love2d-studio/")), false);
  assert.equal(entries.some((entry) => entry.startsWith(".git/")), false);
  assert.equal(entries.some((entry) => entry.startsWith("node_modules/")), false);
  assert.equal(entries.some((entry) => entry.startsWith("build/")), false);
  assert.equal(entries.some((entry) => entry.startsWith("dist/")), false);
});

test("Windows ZIP contains a fused executable, runtime DLLs, and game source", (t) => {
  const info = buildInfo(projectPath);
  if (!info.love.windowsReady) {
    t.skip("LÖVE for Windows is not installed on this machine.");
    return;
  }

  const result = buildGame(projectPath, {
    format: "windows-zip",
    outputDir: path.join(testRoot, "windows-output")
  });
  assert.equal(result.format, "windows-zip");
  assert.equal(result.artifacts.length, 2);

  const folder = result.artifacts.find((artifact) => artifact.kind === "folder");
  const zipArtifact = result.artifacts.find((artifact) => artifact.kind === "zip");
  assert.ok(folder);
  assert.ok(zipArtifact);
  assert.equal(fs.existsSync(zipArtifact.path), true);

  const exePath = path.join(folder.path, "My Game.exe");
  assert.equal(fs.existsSync(exePath), true);
  const exe = fs.readFileSync(exePath);
  assert.deepEqual([...exe.subarray(0, 2)], [0x4d, 0x5a], "fused exe keeps the PE header");
  assert.ok(exe.length > fs.statSync(info.love.executable).size, "game archive is appended to love.exe");

  const dlls = fs.readdirSync(folder.path).filter((name) => name.toLowerCase().endsWith(".dll"));
  assert.ok(dlls.length > 0);
  const runtimeLicense = fs.readdirSync(path.dirname(info.love.executable))
    .some((name) => name.toLowerCase() === "license.txt");
  if (runtimeLicense) {
    assert.equal(fs.existsSync(path.join(folder.path, "license.txt")), true);
  }
  assert.equal(fs.existsSync(path.join(folder.path, "README.txt")), true);

  const packageEntries = new AdmZip(zipArtifact.path).getEntries().map((entry) => entry.entryName);
  const folderName = path.basename(folder.path);
  assert.ok(packageEntries.some((entry) => entry === `${folderName}/My Game.exe`));
  if (runtimeLicense) {
    assert.ok(packageEntries.some((entry) => entry === `${folderName}/license.txt`));
  }
  assert.ok(packageEntries.some((entry) => entry.startsWith(`${folderName}/`) && entry.endsWith(".dll")));
  assert.equal(packageEntries.some((entry) => entry.includes(".zed/")), false);
});

test("build requires main.lua", () => {
  const emptyProject = path.join(testRoot, "No Entry");
  fs.mkdirSync(emptyProject, { recursive: true });
  assert.throws(
    () => buildGame(emptyProject, { format: "love" }),
    /no main\.lua/i
  );
});
