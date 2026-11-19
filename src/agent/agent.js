import path from "node:path";
import crypto from "node:crypto";
import * as acp from "@agentclientprotocol/sdk";
import { DeepSeekClient, DeepSeekError } from "./deepseek.js";
import {
  TOOL_DEFINITIONS,
  ToolRuntime,
  isRunTool,
  isWriteTool,
  requiresPermission,
  toolKind
} from "./tools.js";
import { buildSystemPrompt } from "./prompt.js";
import { readConfig } from "../shared/paths.js";

const VERSION = "0.1.0";
const MAX_TOOL_ROUNDS = 16;
const MAX_HISTORY_CHARS = 650_000;

export function loadDeepSeekConfig() {
  const config = readConfig();
  const env = process.env;
  const configuredMax = Number(env.DEEPSEEK_MAX_TOKENS) || config.deepseek.maxTokens || 8192;
  return {
    apiKey: (env.DEEPSEEK_API_KEY || config.deepseek.apiKey || "").trim(),
    baseUrl: (env.DEEPSEEK_BASE_URL || config.deepseek.baseUrl || "https://api.deepseek.com").trim(),
    model: (env.DEEPSEEK_MODEL || config.deepseek.model || "deepseek-flash").trim(),
    // Reasoning tokens count toward the completion budget.
    maxTokens: Math.max(16_384, configuredMax),
    temperature: 0.2
  };
}

function newSessionId() {
  return `love2d_${crypto.randomBytes(12).toString("hex")}`;
}

function chunkText(text) {
  return { type: "text", text };
}

function toolContentText(text) {
  return { type: "content", content: chunkText(text) };
}

function truncate(text, limit = 14_000) {
  const value = String(text ?? "");
  return value.length > limit ? `${value.slice(0, limit)}\n\n[truncated]` : value;
}

function diffContent(diff) {
  if (!diff || typeof diff.newText !== "string") return null;
  if ((diff.oldText?.length || 0) + diff.newText.length > 1_000_000) return null;
  return {
    type: "diff",
    path: diff.path,
    oldText: diff.oldText ?? null,
    newText: diff.newText
  };
}

function initialToolTitle(name, args) {
  if (args?.path) return `${name}: ${args.path}`;
  if (args?.name) return `${name}: ${args.name}`;
  if (name === "search_files") return `Search for ${String(args?.query || "").slice(0, 60)}`;
  return name.replaceAll("_", " ");
}

function promptToText(blocks) {
  const parts = [];
  for (const block of blocks || []) {
    if (block.type === "text" && block.text) {
      parts.push(block.text);
    } else if (block.type === "resource") {
      const resource = block.resource || {};
      if (typeof resource.text === "string") {
        parts.push(`[Context: ${resource.uri || "resource"}]\n${resource.text}`);
      } else if (resource.uri) {
        parts.push(`[Context resource: ${resource.uri}]`);
      }
    } else if (block.type === "resource_link") {
      parts.push(`[Context link: ${block.uri || block.name || "resource"}]`);
    } else if (block.type === "image") {
      parts.push("[An image was attached, but this agent does not accept image input.]");
    } else if (block.type === "audio") {
      parts.push("[Audio was attached, but this agent does not accept audio input.]");
    }
  }
  return parts.join("\n\n").trim();
}

function trimMessages(messages) {
  if (messages.length <= 2) return messages;
  let total = messages.reduce((sum, message) => sum + stringSize(message), 0);
  let start = 0;
  while (total > MAX_HISTORY_CHARS && messages.length - start > 8) {
    total -= stringSize(messages[start]);
    start += 1;
    // Keep tool result groups valid: don't start with a tool message.
    while (start < messages.length && messages[start].role === "tool") {
      total -= stringSize(messages[start]);
      start += 1;
    }
  }
  return messages.slice(start);
}

function stringSize(message) {
  try {
    return JSON.stringify(message).length;
  } catch {
    return 0;
  }
}

export class Love2DAssistant {
  constructor({ fetchImpl } = {}) {
    this.sessions = new Map();
    this.clientCapabilities = {};
    this.fetchImpl = fetchImpl;
  }

  async initialize(params) {
    this.clientCapabilities = params.clientCapabilities || {};
    return {
      protocolVersion: acp.PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: {
          embeddedContext: true
        },
        sessionCapabilities: {
          additionalDirectories: {}
        }
      },
      agentInfo: {
        name: "Love2D Assistant",
        version: VERSION
      }
    };
  }

  async newSession(params) {
    if (!params.cwd || !path.isAbsolute(params.cwd)) {
      throw acp.RequestError.invalidParams({ cwd: params.cwd }, "cwd must be an absolute path.");
    }
    for (const dir of params.additionalDirectories || []) {
      if (!path.isAbsolute(dir)) {
        throw acp.RequestError.invalidParams(
          { additionalDirectories: params.additionalDirectories },
          "additionalDirectories must contain absolute paths."
        );
      }
    }
    const sessionId = newSessionId();
    this.sessions.set(sessionId, {
      id: sessionId,
      cwd: path.resolve(params.cwd),
      additionalDirectories: (params.additionalDirectories || []).map((dir) => path.resolve(dir)),
      messages: [],
      pending: null,
      alwaysWrite: false,
      alwaysRun: false,
      createdAt: new Date().toISOString(),
      runtime: null
    });
    console.error(`[agent] session ${sessionId} opened in ${params.cwd}`);
    return { sessionId };
  }

  async prompt(params, cx) {
    const session = this.sessions.get(params.sessionId);
    if (!session) throw acp.RequestError.sessionNotFound(params.sessionId);

    if (session.pending) session.pending.abort();
    session.runtime?.cancel();
    const controller = new AbortController();
    session.pending = controller;
    const openToolCalls = new Set();
    const openCallIds = new Set();
    const messageId = `msg_${crypto.randomBytes(8).toString("hex")}`;
    let runtime = null;

    const userText = promptToText(params.prompt) || "(empty prompt)";
    session.messages.push({ role: "user", content: userText });

    const deepseekConfig = loadDeepSeekConfig();
    if (!deepseekConfig.apiKey) {
      await this.notifyText(
        cx,
        session.id,
        "**DeepSeek is not configured yet.**\n\nOpen **Studio → Setup** and add your DeepSeek API key, or set the `DEEPSEEK_API_KEY` environment variable, then try again.",
        messageId
      );
      session.pending = null;
      return { stopReason: "end_turn" };
    }

    runtime = new ToolRuntime({
      sessionId: session.id,
      cwd: session.cwd,
      additionalDirectories: session.additionalDirectories,
      client: cx,
      clientCapabilities: this.clientCapabilities,
      signal: controller.signal
    });
    session.runtime = runtime;

    try {
      const systemPrompt = buildSystemPrompt({
        cwd: session.cwd,
        additionalDirectories: session.additionalDirectories
      });
      const deepseek = new DeepSeekClient(deepseekConfig, { fetchImpl: this.fetchImpl });

      for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
        if (controller.signal.aborted) break;

        const history = [
          { role: "system", content: systemPrompt },
          ...trimMessages(session.messages)
        ];
        const assistantMessageId = round === 0 ? messageId : `${messageId}_${round}`;
        let result;
        try {
          result = await deepseek.streamChat({
            messages: history,
            tools: TOOL_DEFINITIONS,
            signal: controller.signal,
            onText: async (text) => {
              await this.notifyText(cx, session.id, text, assistantMessageId);
            },
            onReasoning: async (text) => {
              await this.notifyReasoning(cx, session.id, text, assistantMessageId);
            }
          });
        } catch (error) {
          if (controller.signal.aborted) {
            return { stopReason: "cancelled" };
          }
          const message = error instanceof DeepSeekError
            ? error.message
            : error?.message || String(error);
          await this.notifyText(
            cx,
            session.id,
            `\n\n**The DeepSeek request failed.**\n\n${message}\n\nCheck the model, API URL, and key in **Studio → Setup**.`,
            assistantMessageId
          );
          console.error(`[agent] DeepSeek error: ${message}`);
          return { stopReason: "end_turn" };
        }

        if (controller.signal.aborted) break;

        const toolCalls = result.toolCalls || [];
        if (!toolCalls.length) {
          if (result.content) {
            session.messages.push({ role: "assistant", content: result.content });
          }
          session.pending = null;
          return {
            stopReason: result.finishReason === "length"
              ? "max_tokens"
              : result.finishReason === "content_filter"
                ? "refusal"
                : "end_turn"
          };
        }

        const assistantHistory = {
          role: "assistant",
          content: result.content || null,
          tool_calls: toolCalls.map((call) => ({
            id: call.id,
            type: "function",
            function: call.function
          }))
        };
        if (result.reasoningContent) {
          assistantHistory.reasoning_content = result.reasoningContent;
        }
        session.messages.push(assistantHistory);

        for (const call of toolCalls) {
          if (controller.signal.aborted) break;
          await this.processToolCall({
            session,
            cx,
            runtime,
            call,
            openToolCalls,
            openCallIds,
            signal: controller.signal
          });
        }

        if (controller.signal.aborted) break;
      }

      if (controller.signal.aborted) return { stopReason: "cancelled" };
      await this.notifyText(
        cx,
        session.id,
        `\n\nI reached the ${MAX_TOOL_ROUNDS}-round tool limit. Ask me to continue if the task is unfinished.`,
        `${messageId}_limit`
      );
      return { stopReason: "max_turn_requests" };
    } finally {
      for (const toolCallId of openToolCalls) {
        await this.notifyToolUpdate(cx, session.id, {
          toolCallId,
          status: "failed",
          content: [toolContentText("Tool call cancelled.")]
        });
        if (openCallIds.has(toolCallId)) {
          session.messages.push({
            role: "tool",
            tool_call_id: toolCallId,
            content: "Tool call cancelled."
          });
        }
      }
      openToolCalls.clear();
      openCallIds.clear();
      runtime?.cancel();
      if (session.runtime === runtime) session.runtime = null;
      if (session.pending === controller) session.pending = null;
    }
  }

  async processToolCall({ session, cx, runtime, call, openToolCalls, openCallIds, signal }) {
    const id = call.id;
    const name = call.function?.name || "";
    let args = {};
    let parseError = "";
    try {
      args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
    } catch (error) {
      parseError = `The model produced invalid JSON arguments: ${error.message}`;
    }

    openToolCalls.add(id);
    await this.notify(cx, acp.methods.client.session.update, {
      sessionId: session.id,
      update: {
        sessionUpdate: "tool_call",
        toolCallId: id,
        title: initialToolTitle(name, args),
        name,
        kind: toolKind(name),
        status: "pending",
        rawInput: args
      }
    });

    if (parseError) {
      await this.failTool(cx, session, id, parseError, openToolCalls, openCallIds);
      return;
    }
    if (!TOOL_DEFINITIONS.some((tool) => tool.function.name === name)) {
      await this.failTool(cx, session, id, `Unknown tool: ${name}`, openToolCalls, openCallIds);
      return;
    }
    if (signal.aborted) return;

    let preview;
    try {
      preview = await runtime.preview(name, args);
    } catch (error) {
      await this.failTool(cx, session, id, error.message, openToolCalls, openCallIds);
      return;
    }

    const diff = diffContent(preview.diff);
    const toolCallUpdate = {
      toolCallId: id,
      title: preview.title,
      kind: preview.kind,
      status: "pending",
      locations: preview.locations || [],
      rawInput: args
    };
    if (diff) toolCallUpdate.content = [diff];
    await this.notify(cx, acp.methods.client.session.update, {
      sessionId: session.id,
      update: { sessionUpdate: "tool_call_update", ...toolCallUpdate }
    });

    if (requiresPermission(name)) {
      const allowed = await this.requestPermission({
        cx,
        session,
        toolCallId: id,
        name,
        title: preview.title,
        kind: preview.kind,
        locations: preview.locations,
        rawInput: args,
        diff
      });
      if (!allowed) {
        await this.failTool(
          cx,
          session,
          id,
          "The user denied permission for this operation.",
          openToolCalls,
          openCallIds
        );
        return;
      }
    }

    await this.notify(cx, acp.methods.client.session.update, {
      sessionId: session.id,
      update: {
        sessionUpdate: "tool_call_update",
        toolCallId: id,
        status: "in_progress"
      }
    });

    try {
      const result = await runtime.execute(name, args);
      const content = [];
      const summary = truncate(result.text || "Done.", 16_000);
      content.push(toolContentText(summary));
      const resultDiff = diffContent(result.diff);
      if (resultDiff) content.push(resultDiff);
      if (result.terminalId) {
        content.push({ type: "terminal", terminalId: result.terminalId });
      }
      await this.notify(cx, acp.methods.client.session.update, {
        sessionId: session.id,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: id,
          status: result.failed ? "failed" : "completed",
          content,
          rawOutput: { summary }
        }
      });
      session.messages.push({
        role: "tool",
        tool_call_id: id,
        content: summary
      });
      openToolCalls.delete(id);
      openCallIds.delete(id);
    } catch (error) {
      if (signal.aborted) return;
      await this.failTool(cx, session, id, error.message, openToolCalls, openCallIds);
    }
  }

  async failTool(cx, session, id, message, openToolCalls, openCallIds) {
    const text = `Error: ${message}`;
    await this.notifyToolUpdate(cx, session.id, {
      toolCallId: id,
      status: "failed",
      content: [toolContentText(text)],
      rawOutput: { error: message }
    });
    session.messages.push({ role: "tool", tool_call_id: id, content: text });
    openToolCalls.delete(id);
    openCallIds.delete(id);
  }

  async requestPermission({ cx, session, toolCallId, name, title, kind, locations, rawInput, diff }) {
    if (isWriteTool(name) && session.alwaysWrite) return true;
    if (isRunTool(name) && session.alwaysRun) return true;

    const options = [
      { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
      {
        optionId: "allow-always",
        name: isWriteTool(name) ? "Allow edits for this session" : "Allow game runs for this session",
        kind: "allow_always"
      },
      { optionId: "reject-once", name: "Deny", kind: "reject_once" }
    ];
    const toolCall = {
      toolCallId,
      title,
      kind,
      status: "pending",
      locations: locations || [],
      rawInput
    };
    if (diff) toolCall.content = [diff];

    let response;
    try {
      response = await cx.request(acp.methods.client.session.requestPermission, {
        sessionId: session.id,
        toolCall,
        options
      });
    } catch (error) {
      console.error(`[agent] permission request failed: ${error.message}`);
      return false;
    }
    const outcome = response?.outcome;
    if (!outcome || outcome.outcome !== "selected") return false;
    if (outcome.optionId === "allow-always") {
      if (isWriteTool(name)) session.alwaysWrite = true;
      if (isRunTool(name)) session.alwaysRun = true;
      return true;
    }
    return outcome.optionId === "allow-once";
  }

  cancel(params) {
    const session = this.sessions.get(params.sessionId);
    if (!session) return;
    session.pending?.abort();
    session.runtime?.cancel();
  }

  async notifyText(cx, sessionId, text, messageId) {
    if (!text) return;
    await this.notify(cx, acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        messageId,
        content: chunkText(text)
      }
    });
  }

  async notifyReasoning(cx, sessionId, text, messageId) {
    if (!text) return;
    await this.notify(cx, acp.methods.client.session.update, {
      sessionId,
      update: {
        sessionUpdate: "agent_thought_chunk",
        messageId: `${messageId}_thought`,
        content: chunkText(text)
      }
    });
  }

  async notifyToolUpdate(cx, sessionId, update) {
    await this.notify(cx, acp.methods.client.session.update, {
      sessionId,
      update: { sessionUpdate: "tool_call_update", ...update }
    });
  }

  async notify(cx, method, params) {
    try {
      await cx.notify(method, params);
    } catch (error) {
      console.error(`[agent] Notification failed: ${error.message}`);
    }
  }
}

export function createAgentApp(assistant = new Love2DAssistant()) {
  return acp
    .agent({ name: "love2d-assistant" })
    .onRequest(acp.methods.agent.initialize, (ctx) => assistant.initialize(ctx.params))
    .onRequest(acp.methods.agent.session.new, (ctx) => assistant.newSession(ctx.params))
    .onRequest(acp.methods.agent.session.prompt, (ctx) => assistant.prompt(ctx.params, ctx.client))
    .onNotification(acp.methods.agent.session.cancel, (ctx) => assistant.cancel(ctx.params));
}
