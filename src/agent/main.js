#!/usr/bin/env node

import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { Love2DAssistant, createAgentApp } from "./agent.js";

const VERSION = "0.1.0";

if (process.argv.includes("--version") || process.argv.includes("-v")) {
  process.stdout.write(`love2d-assistant ${VERSION}\n`);
  process.exit(0);
}

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  process.stdout.write(
    "Love2D Assistant — an ACP (Agent Client Protocol) agent for Zed.\n" +
    "Configure it through Zed's agent_servers setting. Configure the DeepSeek key in Love2D Studio's Setup panel.\n"
  );
  process.exit(0);
}

process.on("uncaughtException", (error) => {
  console.error(`[love2d-assistant] Uncaught error: ${error.stack || error.message}`);
});
process.on("unhandledRejection", (reason) => {
  console.error(`[love2d-assistant] Unhandled rejection: ${reason?.stack || reason}`);
});

process.stdout.on("error", (error) => {
  if (error.code === "EPIPE") process.exit(0);
});

console.error(`[love2d-assistant] starting v${VERSION}`);

const input = Writable.toWeb(process.stdout);
const output = Readable.toWeb(process.stdin);
const stream = acp.ndJsonStream(input, output);

const assistant = new Love2DAssistant();
const app = createAgentApp(assistant);
app.connect(stream);
