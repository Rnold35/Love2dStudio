import crypto from "node:crypto";
import path from "node:path";
import { DeepSeekClient, DeepSeekError } from "../agent/deepseek.js";
import { buildSystemPrompt } from "../agent/prompt.js";
import {
  DESKTOP_TOOL_DEFINITIONS,
  ToolRuntime,
  isRunTool,
  isWriteTool,
  requiresPermission,
  toolKind
} from "../agent/tools.js";
import { readConfig } from "../shared/paths.js";

const MAX_TOOL_ROUNDS = 16;
const MAX_HISTORY_CHARS = 650_000;
const PERMISSION_TIMEOUT_MS = 5 * 60 * 1000;
const QUESTION_TIMEOUT_MS = 10 * 60 * 1000;

export class ChatHttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

function deepseekConfig() {
  const config = readConfig();
  const env = process.env;
  const configuredMax = Number(env.DEEPSEEK_MAX_TOKENS) || config.deepseek.maxTokens || 8192;
  return {
    apiKey: (env.DEEPSEEK_API_KEY || config.deepseek.apiKey || "").trim(),
    baseUrl: (env.DEEPSEEK_BASE_URL || config.deepseek.baseUrl || "https://api.deepseek.com").trim(),
    model: (env.DEEPSEEK_MODEL || config.deepseek.model || "deepseek-flash").trim(),
    // Reasoning tokens count toward the completion budget. Give the desktop
    // assistant enough room to finish a plan and still write code.
    maxTokens: Math.max(16_384, configuredMax),
    temperature: 0.2
  };
}

function sizeOf(message) {
  try {
    return JSON.stringify(message).length;
  } catch {
    return 0;
  }
}

function trimMessages(messages) {
  if (messages.length <= 2) return messages;
  let total = messages.reduce((sum, message) => sum + sizeOf(message), 0);
  let start = 0;
  while (total > MAX_HISTORY_CHARS && messages.length - start > 8) {
    total -= sizeOf(messages[start]);
    start += 1;
    while (start < messages.length && messages[start].role === "tool") {
      total -= sizeOf(messages[start]);
      start += 1;
    }
  }
  return messages.slice(start);
}

function projectRelative(cwd, file) {
  try {
    return path.relative(cwd, file).replace(/\\/g, "/");
  } catch {
    return file;
  }
}

function truncateText(text, limit = 16_000) {
  const value = String(text ?? "");
  return value.length > limit ? `${value.slice(0, limit)}\n\n[truncated]` : value;
}

function safeDiff(diff) {
  if (!diff) return null;
  const oldText = typeof diff.oldText === "string" ? diff.oldText : null;
  const newText = typeof diff.newText === "string" ? diff.newText : "";
  const limit = 12_000;
  return {
    path: diff.path,
    oldText: oldText === null ? null : truncateText(oldText, limit),
    newText: truncateText(newText, limit),
    truncated: (oldText?.length || 0) + newText.length > limit * 2
  };
}

export class StudioChat {
  constructor({ getProjectPath }) {
    this.getProjectPath = getProjectPath;
    this.projectPath = "";
    this.messages = [];
    this.transcript = [];
    this.active = null;
    this.alwaysWrite = false;
    this.alwaysRun = false;
    this.generation = 0;
    this.sequence = 0;
  }

  config() {
    return deepseekConfig();
  }

  setProject(projectPath) {
    const next = projectPath ? path.resolve(projectPath) : "";
    if (next === this.projectPath) return;
    this.generation += 1;
    this.cancel("Project changed");
    this.projectPath = next;
    this.messages = [];
    this.transcript = [];
    this.alwaysWrite = false;
    this.alwaysRun = false;
  }

  state() {
    this.setProject(this.getProjectPath());
    const config = this.config();
    return {
      available: Boolean(this.projectPath),
      configured: Boolean(config.apiKey),
      model: config.model,
      busy: Boolean(this.active),
      alwaysWrite: this.alwaysWrite,
      alwaysRun: this.alwaysRun,
      messages: this.transcript,
      permissions: this.active
        ? [...this.active.pending.values()].map((pending) => pending.event)
        : [],
      questions: this.active
        ? [...this.active.questions.values()].map((pending) => pending.event)
        : [],
      projectPath: this.projectPath
    };
  }

  reset() {
    this.generation += 1;
    this.cancel("Chat reset");
    this.messages = [];
    this.transcript = [];
    this.alwaysWrite = false;
    this.alwaysRun = false;
    return this.state();
  }

  cancel(reason = "Cancelled") {
    const active = this.active;
    if (!active) return false;
    active.controller.abort(reason);
    for (const pending of active.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ decision: "deny", reason });
    }
    active.pending.clear();
    for (const pending of active.questions.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ answer: "", cancelled: true, reason });
    }
    active.questions.clear();
    return true;
  }

  decidePermission(requestId, decision) {
    const active = this.active;
    if (!active) throw new ChatHttpError(409, "No AI turn is running.");
    const pending = active.pending.get(requestId);
    if (!pending) throw new ChatHttpError(404, "That permission request is no longer pending.");
    if (!["allow-once", "allow-always", "deny"].includes(decision)) {
      throw new ChatHttpError(400, "Invalid permission decision.");
    }
    if (decision === "allow-always") {
      if (pending.kind === "write") this.alwaysWrite = true;
      if (pending.kind === "run") this.alwaysRun = true;
    }
    // askPermission() owns deletion and timer cleanup when the decision settles.
    pending.resolve({ decision, reason: "" });
    return { ok: true, decision };
  }

  answerQuestion(requestId, optionIndex) {
    const active = this.active;
    if (!active) throw new ChatHttpError(409, "No AI turn is running.");
    const pending = active.questions.get(requestId);
    if (!pending) throw new ChatHttpError(404, "That question is no longer waiting for an answer.");
    const index = Number(optionIndex);
    if (!Number.isInteger(index) || index < 0 || index >= pending.event.options.length) {
      throw new ChatHttpError(400, "Choose one of the available options.");
    }
    const answer = pending.event.options[index];
    pending.resolve({ answer, optionIndex: index });
    return { ok: true, answer, optionIndex: index };
  }

  addTranscript(entry) {
    const item = {
      id: `chat_${++this.sequence}`,
      timestamp: new Date().toISOString(),
      ...entry
    };
    this.transcript.push(item);
    if (this.transcript.length > 400) this.transcript.shift();
    return item;
  }

  resolveQuestionTranscript(requestId, result) {
    for (const entry of this.transcript) {
      if (entry.role !== "question" || entry.requestId !== requestId) continue;
      entry.status = result.cancelled
        ? "cancelled"
        : result.timedOut
          ? "timed_out"
          : "answered";
      entry.answer = result.answer || "";
      entry.answerIndex = result.optionIndex ?? null;
      entry.answeredAt = new Date().toISOString();
      break;
    }
  }

  askQuestion({ question, options, toolCallId, writeEvent, signal, active }) {
    if (signal.aborted) {
      return Promise.resolve({
        answer: "",
        optionIndex: null,
        cancelled: true,
        timedOut: false,
        reason: "Cancelled."
      });
    }
    const requestId = crypto.randomUUID();
    this.addTranscript({
      role: "question",
      requestId,
      toolCallId,
      question,
      options: [...options],
      answer: "",
      answerIndex: null,
      status: "pending"
    });

    return new Promise((resolve) => {
      const finish = (payload = {}) => {
        const pending = active.questions.get(requestId);
        if (!pending) return;
        active.questions.delete(requestId);
        clearTimeout(pending.timer);
        const result = {
          answer: typeof payload.answer === "string" ? payload.answer : "",
          optionIndex: Number.isInteger(payload.optionIndex) ? payload.optionIndex : null,
          cancelled: Boolean(payload.cancelled),
          timedOut: Boolean(payload.timedOut),
          reason: payload.reason || ""
        };
        this.resolveQuestionTranscript(requestId, result);
        writeEvent({
          type: "question_resolved",
          requestId,
          answer: result.answer,
          optionIndex: result.optionIndex,
          cancelled: result.cancelled,
          timedOut: result.timedOut
        });
        resolve(result);
      };

      const timer = setTimeout(() => {
        finish({
          cancelled: false,
          timedOut: true,
          reason: "The user did not answer in time."
        });
      }, QUESTION_TIMEOUT_MS);
      timer.unref?.();

      const event = {
        type: "question_request",
        requestId,
        toolCallId,
        question,
        options: [...options]
      };
      active.questions.set(requestId, {
        event,
        timer,
        resolve: finish
      });
      writeEvent(event);

      if (signal.aborted) {
        finish({ cancelled: true, reason: "Cancelled." });
      }
    });
  }

  async send(message, req, res) {
    this.setProject(this.getProjectPath());
    if (!this.projectPath) {
      throw new ChatHttpError(400, "Open a project before chatting with the assistant.");
    }
    const config = this.config();
    if (!config.apiKey) {
      throw new ChatHttpError(400, "DeepSeek is not configured. Add an API key in Setup.");
    }
    const text = String(message || "").trim();
    if (!text) throw new ChatHttpError(400, "The message is empty.");
    if (this.active) throw new ChatHttpError(409, "The assistant is already working on a response.");

    const generation = this.generation;
    const controller = new AbortController();
    const active = {
      res,
      controller,
      pending: new Map(),
      questions: new Map(),
      generation
    };
    this.active = active;

    res.writeHead(200, {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no"
    });
    res.flushHeaders?.();

    const writeEvent = (event) => {
      if (res.writableEnded || res.destroyed) return false;
      try {
        res.write(`${JSON.stringify(event)}\n`);
        return true;
      } catch {
        return false;
      }
    };

    res.on("close", () => {
      if (!res.writableEnded && this.active === active) {
        this.cancel("Client disconnected");
      }
    });

    this.addTranscript({ role: "user", text });
    this.messages.push({ role: "user", content: text });

    const runtime = new ToolRuntime({
      sessionId: `studio_${crypto.randomBytes(8).toString("hex")}`,
      cwd: this.projectPath,
      additionalDirectories: [],
      client: null,
      clientCapabilities: {
        fs: { readTextFile: false, writeTextFile: false },
        terminal: false
      },
      signal: controller.signal,
      gameLogFile: path.join(this.projectPath, ".love2d-studio", "runtime", "ai-game.log")
    });

    let stopReason = "end_turn";
    let completed = false;
    try {
      const systemPrompt = `${buildSystemPrompt({
        cwd: this.projectPath,
        additionalDirectories: [],
        surface: "desktop"
      })}

# Desktop Studio chat
The user can see the scene editor and live game console. Use the available tools
to inspect and change the project. Writes and game runs require the user's
explicit approval in the chat panel. Scene files are shared with the visual
editor; after you change one, the editor may refresh it automatically. Keep
responses concise and practical.

# Asking the user to choose
When you need a decision or preference, call the ask_user tool with a short
question and 2-4 concise options. The desktop chat renders the options as
buttons; do not list the same options in normal prose. Wait for the tool result
before continuing. Use a plain-text question only when there are no meaningful
choices.

# Finish the job
For a feature request, the expected result is working files, not a plan. Inspect
only what you need, choose a small file structure, and start writing with
write_files/edit_file in this turn. Do not spend the whole response designing
the implementation in hidden reasoning. After writing, run a quick smoke test
and report the changed paths.`;

      const client = new DeepSeekClient(config);
      let emptyResponseRetries = 0;
      for (let round = 0; round < MAX_TOOL_ROUNDS; round += 1) {
        if (controller.signal.aborted || active.generation !== this.generation) {
          stopReason = "cancelled";
          break;
        }

        const assistantId = `assistant_${crypto.randomBytes(6).toString("hex")}`;
        let liveText = "";
        let liveReasoning = "";
        let started = false;
        const ensureStarted = () => {
          if (started) return;
          started = true;
          writeEvent({ type: "assistant_start", id: assistantId });
        };

        let result;
        try {
          result = await client.streamChat({
            messages: [
              { role: "system", content: systemPrompt },
              ...trimMessages(this.messages)
            ],
            tools: DESKTOP_TOOL_DEFINITIONS,
            signal: controller.signal,
            onText: (chunk) => {
              ensureStarted();
              liveText += chunk;
              writeEvent({ type: "assistant_delta", id: assistantId, text: chunk });
            },
            onReasoning: (chunk) => {
              ensureStarted();
              liveReasoning += chunk;
              writeEvent({
                type: "assistant_reasoning_delta",
                id: assistantId,
                text: chunk
              });
            }
          });
        } catch (error) {
          if (controller.signal.aborted || active.generation !== this.generation) {
            stopReason = "cancelled";
            break;
          }
          const detail = error instanceof DeepSeekError
            ? error.message
            : error?.message || String(error);
          const messageText = `The DeepSeek request failed.\n\n${detail}\n\nCheck the model, API URL, and key in Setup.`;
          this.addTranscript({ role: "error", text: messageText });
          writeEvent({ type: "error", message: messageText });
          stopReason = "error";
          break;
        }

        if (started) {
          writeEvent({
            type: "assistant_end",
            id: assistantId,
            text: liveText,
            reasoning: liveReasoning
          });
        }
        if (liveText || liveReasoning) {
          this.addTranscript({
            role: "assistant",
            text: liveText,
            reasoning: liveReasoning
          });
        }

        const toolCalls = (result.toolCalls || []).map((call, index) => ({
          ...call,
          id: call.id || `call_${Date.now().toString(36)}_${index}_${crypto.randomBytes(3).toString("hex")}`
        }));
        if (!toolCalls.length) {
          const finalContent = String(result.content || "").trim();
          if (finalContent) {
            const finalMessage = { role: "assistant", content: finalContent };
            if (result.reasoningContent) finalMessage.reasoning_content = result.reasoningContent;
            this.messages.push(finalMessage);
            stopReason = result.finishReason === "length"
              ? "max_tokens"
              : result.finishReason === "content_filter"
                ? "refusal"
                : "end_turn";
            completed = true;
            break;
          }

          // Some reasoning-heavy models can consume the whole response budget
          // thinking and return neither text nor a tool call. Retry once with
          // an explicit instruction to act, instead of silently ending.
          if (emptyResponseRetries < 1 && !controller.signal.aborted) {
            emptyResponseRetries += 1;
            const notice = "The assistant stopped after reasoning without making changes. Retrying with a shorter action-focused prompt…";
            writeEvent({ type: "status", message: notice });
            const planNotes = String(result.reasoningContent || "").trim().slice(-4000);
            this.messages.push({
              role: "user",
              content: [
                "Continue the current request now. Do not restate or extend the plan, and do not spend time on long reasoning. Make the requested code changes immediately with write_files or edit_file, then run a quick smoke test. Keep the final summary short.",
                planNotes ? `\nReference only — your previous plan notes:\n${planNotes}` : ""
              ].join("\n")
            });
            continue;
          }

          const message = result.finishReason === "length"
            ? "The assistant used its output budget on internal reasoning and stopped before creating any files. Try a more specific request, or ask it to continue with a shorter plan."
            : "The assistant stopped after reasoning without producing a final response or making code changes. Try asking it to continue and write the files now.";
          this.addTranscript({ role: "error", text: message });
          writeEvent({ type: "error", message });
          stopReason = result.finishReason === "length" ? "max_tokens" : "empty_response";
          break;
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
        if (result.reasoningContent) assistantHistory.reasoning_content = result.reasoningContent;
        this.messages.push(assistantHistory);

        const processed = new Set();
        for (const call of toolCalls) {
          if (controller.signal.aborted || active.generation !== this.generation) break;
          processed.add(call.id);
          await this.executeTool({
            call,
            runtime,
            writeEvent,
            signal: controller.signal,
            active
          });
        }

        if (controller.signal.aborted || active.generation !== this.generation) {
          if (active.generation === this.generation) {
            for (const call of toolCalls) {
              if (!processed.has(call.id)) {
                this.messages.push({
                  role: "tool",
                  tool_call_id: call.id,
                  content: "Cancelled by the user."
                });
              }
            }
          }
          stopReason = "cancelled";
          break;
        }
      }

      if (!completed && !controller.signal.aborted && stopReason === "end_turn") {
        stopReason = "max_turn_requests";
        const message = `The assistant reached the ${MAX_TOOL_ROUNDS}-round tool limit. Ask it to continue if needed.`;
        this.addTranscript({ role: "error", text: message });
        writeEvent({ type: "error", message });
      }
      if (controller.signal.aborted || active.generation !== this.generation) {
        stopReason = "cancelled";
      }
    } finally {
      runtime.cancel();
      if (this.active === active) this.active = null;
      writeEvent({ type: "done", stopReason });
      if (!res.writableEnded) res.end();
    }
  }

  async executeTool({ call, runtime, writeEvent, signal, active }) {
    const id = call.id || `tool_${crypto.randomBytes(6).toString("hex")}`;
    const name = call.function?.name || "";
    let args = {};
    let parseError = "";

    try {
      args = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
    } catch (error) {
      parseError = `Invalid tool arguments: ${error.message}`;
    }

    if (parseError) {
      this.finishToolFailure({ id, name, error: parseError, writeEvent });
      return;
    }
    if (!DESKTOP_TOOL_DEFINITIONS.some((tool) => tool.function.name === name)) {
      this.finishToolFailure({ id, name, error: `Unknown tool: ${name}`, writeEvent });
      return;
    }
    if (signal.aborted) {
      this.finishToolFailure({ id, name, error: "Cancelled by the user.", writeEvent });
      return;
    }

    if (name === "ask_user") {
      const question = typeof args.question === "string"
        ? args.question.trim().slice(0, 500)
        : "";
      const seen = new Set();
      const options = (Array.isArray(args.options) ? args.options : [])
        .filter((option) => typeof option === "string")
        .map((option) => option.trim().slice(0, 120))
        .filter((option) => option && !seen.has(option) && seen.add(option))
        .slice(0, 4);
      if (!question) {
        this.finishToolFailure({
          id,
          name,
          title: "Question",
          error: "ask_user requires a non-empty question.",
          writeEvent
        });
        return;
      }
      if (options.length < 2) {
        this.finishToolFailure({
          id,
          name,
          title: "Question",
          error: "ask_user requires at least two distinct options.",
          writeEvent
        });
        return;
      }

      const result = await this.askQuestion({
        question,
        options,
        toolCallId: id,
        writeEvent,
        signal,
        active
      });
      let toolResult;
      if (result.cancelled) {
        toolResult = "The user cancelled the question before choosing.";
      } else if (result.timedOut) {
        toolResult = "The user did not answer in time. Do not guess; ask again or wait for the user's next message.";
      } else {
        toolResult = `The user selected option ${result.optionIndex + 1}: "${result.answer}". Continue with that choice.`;
      }
      this.messages.push({
        role: "tool",
        tool_call_id: id,
        content: toolResult
      });
      return;
    }

    writeEvent({
      type: "tool_call",
      id,
      name,
      title: name.replaceAll("_", " "),
      kind: toolKind(name),
      status: "pending"
    });

    let preview;
    try {
      preview = await runtime.preview(name, args);
    } catch (error) {
      this.finishToolFailure({ id, name, error: error.message, writeEvent });
      return;
    }

    writeEvent({
      type: "tool_update",
      id,
      name,
      title: preview.title,
      kind: preview.kind,
      status: "pending",
      locations: (preview.locations || []).map((location) =>
        projectRelative(this.projectPath, location.path)),
      diffPath: preview.diff ? projectRelative(this.projectPath, preview.diff.path) : ""
    });

    if (requiresPermission(name)) {
      const kind = isWriteTool(name) ? "write" : "run";
      const allowed = await this.askPermission({
        name,
        preview,
        id,
        kind,
        writeEvent,
        signal,
        active
      });
      if (!allowed) {
        this.finishToolFailure({
          id,
          name,
          title: preview.title,
          error: "The user denied permission for this operation.",
          writeEvent
        });
        return;
      }
    }

    writeEvent({ type: "tool_update", id, status: "in_progress" });

    try {
      const result = await runtime.execute(name, args);
      const status = result.failed ? "failed" : "completed";
      const text = truncateText(result.text || "Done.");
      const locations = (result.locations || preview.locations || [])
        .map((location) => projectRelative(this.projectPath, location.path))
        .filter(Boolean);
      const diffPath = result.diff
        ? projectRelative(this.projectPath, result.diff.path)
        : preview.diff
          ? projectRelative(this.projectPath, preview.diff.path)
          : "";

      this.addTranscript({
        role: "tool",
        toolCallId: id,
        name,
        title: preview.title,
        status,
        text,
        locations,
        diffPath
      });
      this.messages.push({ role: "tool", tool_call_id: id, content: text });
      writeEvent({
        type: "tool_result",
        id,
        name,
        title: preview.title,
        status,
        text,
        locations,
        diffPath
      });

      if (isWriteTool(name) && status === "completed" && locations.length) {
        writeEvent({ type: "workspace_changed", paths: locations });
      }
    } catch (error) {
      this.finishToolFailure({
        id,
        name,
        title: preview.title,
        error: signal.aborted ? "Cancelled by the user." : error.message,
        writeEvent
      });
    }
  }

  finishToolFailure({ id, name, title = name, error, writeEvent }) {
    const text = `Error: ${error}`;
    this.addTranscript({
      role: "tool",
      toolCallId: id,
      name,
      title,
      status: "failed",
      text
    });
    this.messages.push({ role: "tool", tool_call_id: id, content: text });
    writeEvent({
      type: "tool_result",
      id,
      name,
      title,
      status: "failed",
      text,
      locations: [],
      diffPath: ""
    });
  }

  askPermission({ name, preview, id, kind, writeEvent, signal, active }) {
    if (kind === "write" && this.alwaysWrite) return Promise.resolve(true);
    if (kind === "run" && this.alwaysRun) return Promise.resolve(true);
    if (signal.aborted) return Promise.resolve(false);

    const requestId = crypto.randomUUID();
    return new Promise((resolve) => {
      const finish = (payload) => {
        const pending = active.pending.get(requestId);
        if (!pending) return;
        active.pending.delete(requestId);
        clearTimeout(pending.timer);
        resolve(payload.decision !== "deny");
        writeEvent({
          type: "permission_resolved",
          requestId,
          decision: payload.decision,
          reason: payload.reason || ""
        });
      };

      const timer = setTimeout(() => {
        finish({ decision: "deny", reason: "Permission request timed out." });
      }, PERMISSION_TIMEOUT_MS);
      timer.unref?.();

      const event = {
        type: "permission_request",
        requestId,
        toolCallId: id,
        name,
        title: preview.title,
        kind,
        locations: (preview.locations || []).map((location) =>
          projectRelative(this.projectPath, location.path)),
        diff: safeDiff(preview.diff),
        canAlways: true
      };

      active.pending.set(requestId, {
        kind,
        timer,
        event,
        resolve: (payload) => finish(payload),
        reject: () => finish({ decision: "deny", reason: "Cancelled." })
      });

      writeEvent(event);

      if (signal.aborted) {
        finish({ decision: "deny", reason: "Cancelled." });
      }
    });
  }
}

