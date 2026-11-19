import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const previousConfigDir = process.env.LOVE2D_STUDIO_CONFIG_DIR;
const previousKey = process.env.DEEPSEEK_API_KEY;
const previousBase = process.env.DEEPSEEK_BASE_URL;
const previousModel = process.env.DEEPSEEK_MODEL;
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "love2d-chat-retry-test-"));
process.env.LOVE2D_STUDIO_CONFIG_DIR = path.join(testRoot, "config");
process.env.DEEPSEEK_API_KEY = "test-key";
process.env.DEEPSEEK_MODEL = "mock-model";

const projectPath = path.join(testRoot, "project");
fs.mkdirSync(projectPath, { recursive: true });
fs.writeFileSync(path.join(projectPath, "main.lua"), "function love.draw() end\n");

const { StudioChat } = await import("../src/studio/chat.js");

const requests = [];
const mockServer = http.createServer((req, res) => {
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    let payload = {};
    try { payload = JSON.parse(body); } catch { /* ignore */ }
    requests.push(payload);
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "close"
    });
    if (requests.length === 1) {
      res.write(`data: ${JSON.stringify({
        choices: [{
          delta: { reasoning_content: "Let me plan every possible detail of the menu..." },
          finish_reason: "length"
        }]
      })}\n\n`);
    } else {
      res.write(`data: ${JSON.stringify({
        choices: [{
          delta: { content: "Implemented the files after the retry." },
          finish_reason: "stop"
        }]
      })}\n\n`);
    }
    res.write("data: [DONE]\n\n");
    res.end();
  });
});

await new Promise((resolve) => mockServer.listen(0, "127.0.0.1", resolve));
process.env.DEEPSEEK_BASE_URL = `http://127.0.0.1:${mockServer.address().port}`;

test.after(async () => {
  mockServer.closeAllConnections?.();
  await new Promise((resolve) => mockServer.close(resolve));
  if (previousConfigDir === undefined) delete process.env.LOVE2D_STUDIO_CONFIG_DIR;
  else process.env.LOVE2D_STUDIO_CONFIG_DIR = previousConfigDir;
  if (previousKey === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = previousKey;
  if (previousBase === undefined) delete process.env.DEEPSEEK_BASE_URL;
  else process.env.DEEPSEEK_BASE_URL = previousBase;
  if (previousModel === undefined) delete process.env.DEEPSEEK_MODEL;
  else process.env.DEEPSEEK_MODEL = previousModel;
  fs.rmSync(testRoot, { recursive: true, force: true });
});

test("reasoning-only responses are retried once with an action prompt", async () => {
  const chat = new StudioChat({ getProjectPath: () => projectPath });
  const events = [];
  const res = {
    writableEnded: false,
    destroyed: false,
    writeHead() {},
    flushHeaders() {},
    write(chunk) {
      for (const line of String(chunk).split("\n")) {
        if (!line.trim()) continue;
        events.push(JSON.parse(line));
      }
      return true;
    },
    end() {
      this.writableEnded = true;
    },
    on() {}
  };

  await Promise.race([
    chat.send("Build a menu", {}, res),
    new Promise((_, reject) => setTimeout(() => reject(new Error("chat turn timed out")), 5000))
  ]);

  assert.ok(events.some((event) => event.type === "status" && /Retrying/.test(event.message)));
  assert.equal(events.some((event) => event.type === "error"), false);
  assert.equal(requests.length, 2);
  const retryMessages = requests[1].messages || [];
  assert.ok(retryMessages.some(
    (message) => message.role === "user" && /Do not restate/i.test(message.content)
  ));
  const transcript = chat.state().messages;
  assert.ok(transcript.some(
    (entry) => entry.role === "assistant" && entry.text === "Implemented the files after the retry."
  ));
  assert.equal(events.some((event) => event.type === "done"), true);
});
