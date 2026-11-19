import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as acp from "@agentclientprotocol/sdk";
import { Love2DAssistant, createAgentApp } from "../src/agent/agent.js";

const previousConfigDir = process.env.LOVE2D_STUDIO_CONFIG_DIR;
const testConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), "love2d-agent-config-"));
process.env.LOVE2D_STUDIO_CONFIG_DIR = testConfigDir;
test.after(() => {
  if (previousConfigDir === undefined) delete process.env.LOVE2D_STUDIO_CONFIG_DIR;
  else process.env.LOVE2D_STUDIO_CONFIG_DIR = previousConfigDir;
  fs.rmSync(testConfigDir, { recursive: true, force: true });
});

function sse(events) {
  return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n";
}

function fakeResponse(events) {
  return new Response(sse(events), {
    status: 200,
    headers: { "content-type": "text/event-stream" }
  });
}

function projectWithFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "love2d-agent-"));
  fs.writeFileSync(path.join(dir, "main.lua"), "print('hello')\n", "utf8");
  fs.mkdirSync(path.join(dir, "scenes"), { recursive: true });
  fs.writeFileSync(path.join(dir, "scenes", "main.json"), JSON.stringify({
    version: 1,
    name: "main",
    width: 320,
    height: 240,
    background: [0, 0, 0, 1],
    entities: []
  }), "utf8");
  return dir;
}

async function withAgent(fakeFetch, callback) {
  const previous = process.env.DEEPSEEK_API_KEY;
  process.env.DEEPSEEK_API_KEY = "test-key";
  try {
    const assistant = new Love2DAssistant({ fetchImpl: fakeFetch });
    const app = createAgentApp(assistant);
    return await callback(app);
  } finally {
    if (previous === undefined) delete process.env.DEEPSEEK_API_KEY;
    else process.env.DEEPSEEK_API_KEY = previous;
  }
}

function makeClient({ onPermission } = {}) {
  return acp
    .client({ name: "test-client" })
    .onRequest(acp.methods.client.session.requestPermission, async (ctx) => {
      if (onPermission) return onPermission(ctx.params);
      return {
        outcome: { outcome: "selected", optionId: "allow-once" }
      };
    })
    .onRequest(acp.methods.client.fs.readTextFile, async (ctx) => {
      return { content: fs.readFileSync(ctx.params.path, "utf8") };
    })
    .onRequest(acp.methods.client.fs.writeTextFile, async (ctx) => {
      fs.mkdirSync(path.dirname(ctx.params.path), { recursive: true });
      fs.writeFileSync(ctx.params.path, ctx.params.content, "utf8");
      return {};
    });
}

test("agent reads a file through ACP and streams a final answer", async () => {
  const project = projectWithFile();
  const requests = [];
  const fakeFetch = async (url, options) => {
    requests.push(JSON.parse(options.body));
    if (requests.length === 1) {
      return fakeResponse([
        {
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: "call_read_1",
                type: "function",
                function: { name: "read_file", arguments: "{\"path\":\"main.lua\"}" }
              }]
            },
            finish_reason: null
          }]
        },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] }
      ]);
    }
    return fakeResponse([
      { choices: [{ delta: { content: "The Lua file is valid and prints hello." }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] }
    ]);
  };

  const result = await withAgent(fakeFetch, (app) => makeClient().connectWith(app, async (ctx) => {
    await ctx.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } }
    });
    const session = await ctx.buildSession(project).start();
    const updates = [];
    const promptResponse = session.prompt("Inspect main.lua and tell me if it looks valid.");
    for (;;) {
      const message = await session.nextUpdate();
      if (message.kind === "stop") {
        updates.push(...[]);
        assert.equal(message.stopReason, "end_turn");
        break;
      }
      updates.push(message.update);
    }
    session.dispose();
    return { updates, promptResponse, requests };
  }));

  const serialized = JSON.stringify(result.updates);
  assert.match(serialized, /tool_call/);
  assert.match(serialized, /tool_call_update/);
  assert.match(serialized, /The Lua file is valid/);
  assert.match(serialized, /print\('hello'\)/);
  assert.equal(result.requests.length, 2);
  assert.equal(result.requests[1].messages.some((message) => message.role === "tool"), true);
});

test("write_file asks for permission and writes through the client", async () => {
  const project = projectWithFile();
  let permissionRequest = null;
  let callCount = 0;
  const fakeFetch = async () => {
    callCount += 1;
    if (callCount === 1) {
      const args = JSON.stringify({
        path: "main.lua",
        content: "print('hello from the assistant')\n"
      });
      return fakeResponse([
        {
          choices: [{
            delta: {
              tool_calls: [{
                index: 0,
                id: "call_write_1",
                type: "function",
                function: { name: "write_file", arguments: args }
              }]
            },
            finish_reason: null
          }]
        },
        { choices: [{ delta: {}, finish_reason: "tool_calls" }] }
      ]);
    }
    return fakeResponse([
      { choices: [{ delta: { content: "Updated main.lua." }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] }
    ]);
  };

  const result = await withAgent(fakeFetch, (app) => makeClient({
    onPermission: async (params) => {
      permissionRequest = params;
      return {
        outcome: { outcome: "selected", optionId: "allow-once" }
      };
    }
  }).connectWith(app, async (ctx) => {
    await ctx.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } }
    });
    const session = await ctx.buildSession(project).start();
    const updates = [];
    const promptResponse = session.prompt("Update the greeting in main.lua.");
    for (;;) {
      const message = await session.nextUpdate();
      if (message.kind === "stop") {
        assert.equal(message.stopReason, "end_turn");
        break;
      }
      updates.push(message.update);
    }
    session.dispose();
    return { updates, promptResponse };
  }));

  assert.ok(permissionRequest, "permission should be requested");
  assert.equal(permissionRequest.toolCall.kind, "edit");
  assert.match(permissionRequest.toolCall.title, /main\.lua/);
  assert.equal(fs.readFileSync(path.join(project, "main.lua"), "utf8"), "print('hello from the assistant')\n");
  assert.match(JSON.stringify(result.updates), /tool_call_update/);
  assert.match(JSON.stringify(result.updates), /Updated main.lua/);
});

test("missing API key produces a setup message instead of an API call", async () => {
  const project = projectWithFile();
  const previous = process.env.DEEPSEEK_API_KEY;
  delete process.env.DEEPSEEK_API_KEY;
  try {
    const assistant = new Love2DAssistant({
      fetchImpl: async () => {
        throw new Error("fetch must not be called without a key");
      }
    });
    const app = createAgentApp(assistant);
    const updates = await makeClient().connectWith(app, async (ctx) => {
      await ctx.request(acp.methods.agent.initialize, {
        protocolVersion: acp.PROTOCOL_VERSION,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } }
      });
      const session = await ctx.buildSession(project).start();
      const collected = [];
      session.prompt("hello");
      for (;;) {
        const message = await session.nextUpdate();
        if (message.kind === "stop") {
          assert.equal(message.stopReason, "end_turn");
          break;
        }
        collected.push(message.update);
      }
      session.dispose();
      return collected;
    });
    assert.match(JSON.stringify(updates), /not configured/);
  } finally {
    if (previous !== undefined) process.env.DEEPSEEK_API_KEY = previous;
  }
});
