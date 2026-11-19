const DEFAULT_BASE_URL = "https://api.deepseek.com";
const DEFAULT_MODEL = "deepseek-flash";

function joinEndpoint(baseUrl) {
  const base = String(baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, "");
  if (base.endsWith("/chat/completions")) return base;
  return `${base}/chat/completions`;
}

export class DeepSeekError extends Error {
  constructor(message, status = 0, detail = "") {
    super(message);
    this.name = "DeepSeekError";
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Minimal OpenAI-compatible streaming client for DeepSeek chat completions,
 * including reasoning content and streamed function/tool calls.
 */
export class DeepSeekClient {
  constructor(config, { fetchImpl = globalThis.fetch } = {}) {
    this.config = config;
    this.fetch = fetchImpl;
  }

  async streamChat({ messages, tools = null, signal, onText, onReasoning, onToolCallDelta }) {
    const apiKey = this.config.apiKey;
    if (!apiKey) {
      throw new DeepSeekError("No DeepSeek API key is configured.");
    }
    const endpoint = joinEndpoint(this.config.baseUrl);
    const body = {
      model: this.config.model || DEFAULT_MODEL,
      messages,
      stream: true,
      temperature: this.config.temperature ?? 0.2,
      max_tokens: this.config.maxTokens || 8192
    };
    if (tools?.length) {
      body.tools = tools;
      body.tool_choice = "auto";
    }

    let response;
    let attempt = 0;
    while (true) {
      attempt += 1;
      try {
        response = await this.fetch(endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
            accept: "text/event-stream"
          },
          body: JSON.stringify(body),
          signal
        });
      } catch (error) {
        if (signal?.aborted) throw error;
        if (attempt <= 1) {
          await delay(900, signal);
          continue;
        }
        throw new DeepSeekError(`Could not reach DeepSeek: ${error.message}`);
      }
      if (response.ok) break;
      if ((response.status === 429 || response.status >= 500) && attempt <= 1) {
        await response.text().catch(() => "");
        await delay(1400, signal);
        continue;
      }
      const detail = await response.text().catch(() => "");
      let message = `DeepSeek returned HTTP ${response.status}.`;
      try {
        const parsed = JSON.parse(detail);
        message = parsed?.error?.message || parsed?.message || message;
      } catch {
        if (detail) message = `${message} ${detail.slice(0, 500)}`;
      }
      throw new DeepSeekError(message, response.status, detail);
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/event-stream")) {
      // Some gateways ignore stream:true and return a single JSON response.
      const payload = await response.json();
      const choice = payload?.choices?.[0];
      const message = choice?.message || {};
      if (message.content && onText) onText(message.content);
      if (message.reasoning_content && onReasoning) onReasoning(message.reasoning_content);
      const toolCalls = Array.isArray(message.tool_calls)
        ? message.tool_calls.map(normalizeToolCall)
        : [];
      return {
        content: message.content || "",
        reasoningContent: message.reasoning_content || "",
        toolCalls,
        finishReason: choice?.finish_reason || "stop",
        usage: payload?.usage || null
      };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let content = "";
    let reasoningContent = "";
    let finishReason = "";
    let usage = null;
    const toolCalls = new Map();

    const consumeLine = (rawLine) => {
      const line = rawLine.replace(/\r$/, "");
      if (!line || line.startsWith(":")) return;
      if (!line.startsWith("data:")) return;
      const payload = line.slice(5).trim();
      if (!payload) return;
      if (payload === "[DONE]") return;
      let event;
      try {
        event = JSON.parse(payload);
      } catch {
        return;
      }
      if (event.error) {
        throw new DeepSeekError(event.error.message || "DeepSeek returned an error.");
      }
      if (event.usage) usage = event.usage;
      const choice = event.choices?.[0];
      if (!choice) return;
      if (choice.finish_reason) finishReason = choice.finish_reason;
      const delta = choice.delta || {};
      if (delta.reasoning_content) {
        reasoningContent += delta.reasoning_content;
        onReasoning?.(delta.reasoning_content);
      }
      if (typeof delta.content === "string" && delta.content) {
        content += delta.content;
        onText?.(delta.content);
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const partial of delta.tool_calls) {
          const index = Number.isInteger(partial.index) ? partial.index : toolCalls.size;
          let entry = toolCalls.get(index);
          if (!entry) {
            entry = { id: "", type: "function", function: { name: "", arguments: "" } };
            toolCalls.set(index, entry);
          }
          if (partial.id) entry.id = partial.id;
          if (partial.type) entry.type = partial.type;
          if (partial.function?.name) entry.function.name += partial.function.name;
          if (partial.function?.arguments) {
            entry.function.arguments += partial.function.arguments;
            onToolCallDelta?.(index, entry.function.arguments);
          }
        }
      }
    };

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          consumeLine(line);
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) consumeLine(buffer);
    } finally {
      reader.releaseLock();
    }

    const normalized = [...toolCalls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => normalizeToolCall(call));
    return {
      content,
      reasoningContent,
      toolCalls: normalized,
      finishReason: finishReason || (normalized.length ? "tool_calls" : "stop"),
      usage
    };
  }
}

function normalizeToolCall(call) {
  return {
    id: call.id || `call_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    type: "function",
    function: {
      name: call.function?.name || "",
      arguments: typeof call.function?.arguments === "string"
        ? call.function.arguments
        : JSON.stringify(call.function?.arguments || {})
    }
  };
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason || new Error("Aborted"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(signal.reason || new Error("Aborted"));
    }, { once: true });
  });
}
