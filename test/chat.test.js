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
const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), "love2d-chat-test-"));
process.env.LOVE2D_STUDIO_CONFIG_DIR = path.join(testRoot, "config");
process.env.DEEPSEEK_API_KEY = "test-key";
process.env.DEEPSEEK_MODEL = "mock-model";

const projectPath = path.join(testRoot, "project");
fs.mkdirSync(projectPath, { recursive: true });
fs.writeFileSync(path.join(projectPath, "main.lua"), "function love.draw() end\n");

const { StudioChat } = await import("../src/studio/chat.js");

const requests = [];
let requestCount = 0;
const mockServer = http.createServer((req, res) => {
  let body = "";
  req.setEncoding("utf8");
  req.on("data", (chunk) => { body += chunk; });
  req.on("end", () => {
    let payload = {};
    try { payload = JSON.parse(body); } catch { /* ignore */ }
    requests.push(payload);
    requestCount += 1;
    res.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache"
    });
    if (requestCount === 1) {
      const toolCall = {
        choices: [{
          delta: {
            tool_calls: [{
              index: 0,
              id: "call_choice",
              type: "function",
              function: {
                name: "ask_user",
                arguments: JSON.stringify({
                  question: "Which visual style should the menu use?",
                  options: ["Minimal", "Smooth", "Arcade"]
                })
              }
            }]
          },
          finish_reason: "tool_calls"
        }]
      };
      res.write(`data: ${JSON.stringify(toolCall)}\n\n`);
    } else {
      const final = {
        choices: [{
          delta: { content: "Using the selected option." },
          finish_reason: "stop"
        }]
      };
      res.write(`data: ${JSON.stringify(final)}\n\n`);
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

test("desktop chat asks a selectable question and continues with the answer", async () => {
  const chat = new StudioChat({ getProjectPath: () => projectPath });
  const events = [];
  let ended = false;
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
      ended = true;
      this.writableEnded = true;
    },
    on() {}
  };

  const sendPromise = chat.send("Make a menu", {}, res);
  let question = null;
  const deadline = Date.now() + 5000;
  while (!question && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    question = events.find((event) => event.type === "question_request") || null;
  }
  assert.ok(question, "the assistant should ask a structured question");
  assert.deepEqual(question.options, ["Minimal", "Smooth", "Arcade"]);
  assert.equal(chat.state().questions.length, 1);

  const answer = chat.answerQuestion(question.requestId, 1);
  assert.equal(answer.answer, "Smooth");
  await Promise.race([
    sendPromise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("chat turn timed out")), 5000))
  ]);

  assert.equal(ended, true);
  const resolved = events.find((event) => event.type === "question_resolved");
  assert.ok(resolved);
  assert.equal(resolved.answer, "Smooth");
  assert.equal(resolved.optionIndex, 1);

  const questionEntry = chat.state().messages.find((entry) => entry.role === "question");
  assert.equal(questionEntry.status, "answered");
  assert.equal(questionEntry.answer, "Smooth");
  assert.equal(questionEntry.answerIndex, 1);

  const final = chat.state().messages.find(
    (entry) => entry.role === "assistant" && entry.text === "Using the selected option."
  );
  assert.ok(final, "the assistant should continue after the answer");
  assert.equal(chat.state().questions.length, 0);

  assert.equal(requests.length, 2);
  const secondMessages = requests[1].messages || [];
  const toolMessage = [...secondMessages].reverse().find((message) => message.role === "tool");
  assert.match(toolMessage.content, /"Smooth"/);
  assert.equal(events.some((event) => event.type === "done"), true);
});
