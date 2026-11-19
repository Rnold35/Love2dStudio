const token = document.querySelector('meta[name="studio-token"]').content;

const $ = (selector, root = document) => root.querySelector(selector);

function icon(name, className = "icon") {
  return `<svg class="${className}" aria-hidden="true"><use href="#i-${name}"></use></svg>`;
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function projectName(projectPath) {
  if (!projectPath) return "";
  return projectPath.split(/[\\/]/).filter(Boolean).pop() || projectPath;
}

function inlineMarkdown(text) {
  let value = text;
  value = value.replace(/`([^`\n]+)`/g, "<code>$1</code>");
  value = value.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  value = value.replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?]|$)/g, "$1<em>$2</em>");
  value = value.replace(
    /\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g,
    '<a href="$2" target="_blank" rel="noreferrer">$1</a>'
  );
  return value;
}

function markdownTextBlock(raw) {
  const lines = raw.split("\n");
  const output = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(4, heading[1].length + 2);
      output.push(`<h${level}>${inlineMarkdown(heading[2])}</h${level}>`);
      index += 1;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*[-*]\s+/.test(lines[index])) {
        items.push(`<li>${inlineMarkdown(lines[index].replace(/^\s*[-*]\s+/, ""))}</li>`);
        index += 1;
      }
      output.push(`<ul>${items.join("")}</ul>`);
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (index < lines.length && /^\s*\d+\.\s+/.test(lines[index])) {
        items.push(`<li>${inlineMarkdown(lines[index].replace(/^\s*\d+\.\s+/, ""))}</li>`);
        index += 1;
      }
      output.push(`<ol>${items.join("")}</ol>`);
      continue;
    }
    const paragraph = [];
    while (
      index < lines.length
      && lines[index].trim()
      && !/^\s*[-*]\s+/.test(lines[index])
      && !/^\s*\d+\.\s+/.test(lines[index])
      && !/^(#{1,4})\s+/.test(lines[index])
    ) {
      paragraph.push(inlineMarkdown(lines[index]));
      index += 1;
    }
    output.push(`<p>${paragraph.join("<br>")}</p>`);
  }
  return output.join("");
}

function renderMarkdown(markdown) {
  const raw = String(markdown ?? "");
  const parts = raw.split("```");
  let html = "";
  parts.forEach((part, index) => {
    if (index % 2 === 1) {
      const newline = part.indexOf("\n");
      const language = newline >= 0 ? part.slice(0, newline).trim() : "";
      const code = newline >= 0 ? part.slice(newline + 1) : part;
      html += `<pre><code${language ? ` data-language="${escapeHtml(language)}"` : ""}>${escapeHtml(code)}</code></pre>`;
    } else {
      html += markdownTextBlock(escapeHtml(part));
    }
  });
  return html;
}

function formatTime(value) {
  try {
    return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function toolIcon(kind) {
  switch (kind) {
    case "read": return "code";
    case "search": return "search";
    case "edit":
    case "move": return "save";
    case "delete": return "trash";
    case "execute": return "terminal";
    case "fetch": return "external";
    default: return "sparkle";
  }
}

function statusLabel(status) {
  if (status === "in_progress") return "working";
  if (status === "completed") return "done";
  if (status === "failed") return "failed";
  return "pending";
}

/**
 * Create the desktop-only AI assistant drawer.
 * Returns null in browser mode (window.love2dDesktop is absent).
 */
export function initDesktopChat({
  onOpenSetup,
  onBeforeSend,
  onWorkspaceChanged,
  toast
}) {
  const desktop = window.love2dDesktop;
  if (!desktop?.isDesktop) return null;

  const root = document.getElementById("ai-drawer");
  const messagesEl = document.getElementById("ai-messages");
  const inputEl = document.getElementById("ai-input");
  const sendButton = document.getElementById("ai-send");
  const stopButton = document.getElementById("ai-stop");
  const newButton = document.getElementById("ai-new");
  const setupButton = document.getElementById("ai-setup");
  const closeButton = document.getElementById("ai-close");
  const topButton = document.getElementById("btn-ai");
  const railButton = document.getElementById("rail-ai");
  const modelEl = document.getElementById("ai-model");
  const contextEl = document.getElementById("ai-context");
  if (!root || !messagesEl || !inputEl || !sendButton) return null;

  const ui = {
    open: false,
    loaded: false,
    loading: false,
    chat: null,
    busy: false,
    streaming: false,
    streamReader: null,
    liveTurn: null,
    assistantEls: new Map(),
    toolEls: new Map(),
    permissionEls: new Map(),
    questionEls: new Map(),
    questionPending: false,
    followLatest: true,
    pollTimer: null
  };

  topButton.hidden = false;
  railButton.hidden = false;
  bindEvents();
  updateComposer();

  function bindEvents() {
    topButton.addEventListener("click", () => toggle());
    railButton.addEventListener("click", () => toggle());
    closeButton.addEventListener("click", () => close());
    newButton.addEventListener("click", () => newChat());
    setupButton.addEventListener("click", () => onOpenSetup?.());
    sendButton.addEventListener("click", () => send());
    stopButton.addEventListener("click", () => stop());
    inputEl.addEventListener("input", () => {
      autoSizeInput();
      updateComposer();
    });
    inputEl.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        send();
      }
    });
    messagesEl.addEventListener("scroll", () => {
      const distance = messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight;
      ui.followLatest = distance < 80;
    }, { passive: true });
    messagesEl.addEventListener("click", (event) => {
      const suggestion = event.target.closest("[data-chat-suggestion]");
      if (suggestion) {
        inputEl.value = suggestion.dataset.chatSuggestion || "";
        autoSizeInput();
        inputEl.focus();
        return;
      }
      const action = event.target.closest("[data-chat-action]");
      if (action?.dataset.chatAction === "setup") {
        onOpenSetup?.();
        return;
      }
      const answer = event.target.closest("[data-chat-answer]");
      if (answer) {
        const card = answer.closest("[data-question-id]");
        if (card) answerQuestion(card, Number(answer.dataset.chatAnswer));
        return;
      }
      const decision = event.target.closest("[data-chat-decision]");
      if (decision) {
        const card = decision.closest("[data-request-id]");
        if (card) {
          decidePermission(
            card.dataset.requestId,
            decision.dataset.chatDecision,
            card
          );
        }
      }
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && ui.open && event.target !== inputEl) {
        const dialog = document.getElementById("modal-dialog");
        if (!dialog?.open) close();
      }
    });
  }

  function setOpen(open) {
    ui.open = open;
    root.hidden = !open;
    topButton.classList.toggle("is-active", open);
    railButton.classList.toggle("is-active", open);
    if (open) {
      ui.followLatest = true;
      setOpenButtonState();
      loadState();
      setTimeout(() => inputEl.focus(), 30);
    } else {
      clearPoll();
    }
  }

  function setOpenButtonState() {
    topButton.classList.toggle("is-active", ui.open);
    railButton.classList.toggle("is-active", ui.open);
  }

  function toggle() {
    setOpen(!ui.open);
  }

  function close() {
    setOpen(false);
  }

  async function chatFetch(url, options = {}) {
    const headers = {
      "x-studio-token": token,
      ...(options.headers || {})
    };
    let body = options.body;
    if (body && typeof body === "object" && !(body instanceof Blob)) {
      body = JSON.stringify(body);
      headers["content-type"] = "application/json";
    }
    const response = await fetch(url, { ...options, headers, body });
    const text = await response.text();
    let data = {};
    if (text) {
      try { data = JSON.parse(text); } catch { data = {}; }
    }
    if (!response.ok) throw new Error(data.error || `Request failed (${response.status}).`);
    return data;
  }

  async function loadState({ silent = false } = {}) {
    if (!ui.open && !silent) return;
    if (ui.streaming) return;
    if (!silent) {
      ui.loading = true;
      renderChat();
    }
    try {
      const data = await chatFetch("/api/chat/state");
      ui.chat = data.chat;
      ui.loaded = true;
      ui.loading = false;
      renderChat();
      if (ui.chat.busy && !ui.streaming) schedulePoll();
      else clearPoll();
    } catch (error) {
      ui.loading = false;
      if (!silent) {
        toast?.(error.message, "error", 6000);
        renderFatal(error.message);
      }
    }
  }

  function schedulePoll() {
    clearPoll();
    if (!ui.open || ui.streaming || !ui.chat?.busy) return;
    ui.pollTimer = setTimeout(async () => {
      ui.pollTimer = null;
      await loadState({ silent: true });
      if (ui.open && ui.chat?.busy && !ui.streaming) schedulePoll();
    }, 1800);
  }

  function clearPoll() {
    if (ui.pollTimer) {
      clearTimeout(ui.pollTimer);
      ui.pollTimer = null;
    }
  }

  function renderFatal(message) {
    messagesEl.innerHTML = `<div class="ai-message error">${escapeHtml(message)}</div>`;
    updateComposer();
  }

  function renderChat() {
    const chat = ui.chat;
    const wasFollowing = ui.followLatest;
    const previousScrollTop = messagesEl.scrollTop;
    messagesEl.innerHTML = "";
    ui.permissionEls.clear();
    ui.questionEls.clear();
    ui.questionPending = Boolean(
      chat?.busy
      && (chat.messages || []).some((entry) =>
        entry.role === "question" && entry.status === "pending")
    );
    modelEl.textContent = chat?.model || "DeepSeek";
    contextEl.textContent = chat?.available
      ? `${projectName(chat.projectPath)} · tools need approval`
      : "Open a project to use the assistant";

    if (ui.loading) {
      messagesEl.innerHTML = `<div class="ai-typing"><i></i><i></i><i></i> Loading assistant…</div>`;
      updateComposer();
      return;
    }
    if (!chat?.available) {
      messagesEl.innerHTML = `
        <div class="ai-empty">
          <div class="ai-empty-icon">${icon("layers")}</div>
          <h3>No project open</h3>
          <p>Create or open a Love2D project first. The assistant works inside the current project and can inspect its scenes, assets, and code.</p>
        </div>
      `;
      updateComposer();
      return;
    }
    if (!chat.configured) {
      messagesEl.innerHTML = `
        <div class="ai-config-notice">
          ${icon("sparkle")}
          <h3>DeepSeek is not configured</h3>
          <p>Add your DeepSeek API key in Setup, then reopen this panel. The key stays on this machine and is never written into your game project.</p>
          <button class="btn btn-small btn-primary" type="button" data-chat-action="setup">Open Setup</button>
        </div>
      `;
      updateComposer();
      return;
    }

    if (!chat.messages?.length && !chat.busy) {
      messagesEl.append(buildEmptyState());
    } else {
      for (const entry of chat.messages || []) {
        messagesEl.append(buildTranscriptEntry(entry));
      }
    }

    if (chat.busy) {
      const note = document.createElement("div");
      note.className = "ai-typing";
      note.innerHTML = "<i></i><i></i><i></i> Assistant is working…";
      messagesEl.append(note);
      for (const permission of chat.permissions || []) {
        messagesEl.append(buildPermissionCard(permission));
      }
    }

    updateComposer();
    if (wasFollowing) {
      scrollToBottom(true);
    } else {
      messagesEl.scrollTop = Math.min(previousScrollTop, messagesEl.scrollHeight);
      ui.followLatest = false;
    }
  }

  function buildEmptyState() {
    const wrapper = document.createElement("div");
    wrapper.className = "ai-empty";
    wrapper.innerHTML = `
      <div class="ai-empty-icon">${icon("sparkle")}</div>
      <h3>Build something lovely</h3>
      <p>Ask about the code, generate a level, add a mechanic, or let the assistant run a smoke test. It can read the project first and will ask before changing files.</p>
      <div class="ai-suggestions">
        <button class="ai-suggestion" type="button" data-chat-suggestion="Explain how the scene runtime works and how main.lua uses it.">Explain the scene runtime</button>
        <button class="ai-suggestion" type="button" data-chat-suggestion="Create a new scene with a simple platform layout and update main.lua to load it.">Create a platform level</button>
        <button class="ai-suggestion" type="button" data-chat-suggestion="Run the game, inspect the console output, and fix any startup errors.">Run and diagnose the game</button>
      </div>
    `;
    return wrapper;
  }

  function buildTranscriptEntry(entry) {
    if (entry.role === "user") return buildUserMessage(entry.text);
    if (entry.role === "assistant") return buildAssistantMessage(entry.text, entry.reasoning);
    if (entry.role === "tool") return buildToolCard(entry);
    if (entry.role === "question") return buildQuestionCard(entry);
    if (entry.role === "error") {
      const node = document.createElement("div");
      node.className = "ai-message error";
      node.textContent = entry.text;
      return node;
    }
    const node = document.createElement("div");
    node.className = "ai-message assistant";
    node.textContent = entry.text || "";
    return node;
  }

  function buildUserMessage(text) {
    const node = document.createElement("div");
    node.className = "ai-message user";
    node.textContent = String(text || "");
    return node;
  }

  function buildAssistantMessage(text, reasoning = "") {
    const node = document.createElement("div");
    node.className = "ai-message assistant";
    if (reasoning) node.append(buildReasoning(reasoning));
    const markdown = document.createElement("div");
    markdown.className = "ai-markdown";
    markdown.innerHTML = renderMarkdown(text || "");
    node.append(markdown);
    return node;
  }

  function buildReasoning(reasoning) {
    const details = document.createElement("details");
    details.className = "ai-reasoning";
    const summary = document.createElement("summary");
    summary.textContent = "Thinking";
    const pre = document.createElement("pre");
    pre.textContent = reasoning;
    details.append(summary, pre);
    return details;
  }

  function buildToolCard(entry) {
    const tool = document.createElement("div");
    tool.className = `ai-tool is-${entry.status || "pending"}`;
    tool.dataset.toolId = entry.toolCallId || entry.id || "";
    tool.innerHTML = `
      <div class="ai-tool-head">
        <span class="ai-tool-icon">${icon(toolIcon(entry.kind))}</span>
        <span class="ai-tool-name"></span>
        <span class="ai-tool-state">${escapeHtml(statusLabel(entry.status))}</span>
      </div>
    `;
    tool.querySelector(".ai-tool-name").textContent = entry.title || entry.name || "Tool";
    for (const location of entry.locations || []) {
      const path = document.createElement("span");
      path.className = "ai-tool-path";
      path.textContent = location;
      path.title = location;
      tool.append(path);
    }
    if (entry.text) {
      const output = document.createElement("pre");
      output.className = "ai-tool-output";
      output.textContent = entry.text;
      tool.append(output);
    }
    return tool;
  }

  function updateToolCard(tool, event) {
    if (!tool) return;
    if (event.title) {
      tool.querySelector(".ai-tool-name").textContent = event.title;
    }
    if (event.kind) {
      tool.querySelector(".ai-tool-icon").innerHTML = icon(toolIcon(event.kind));
    }
    if (event.status) {
      tool.className = `ai-tool is-${event.status}`;
      tool.querySelector(".ai-tool-state").textContent = statusLabel(event.status);
    }
    for (const location of event.locations || []) {
      if (tool.querySelector(`.ai-tool-path[data-path="${CSS.escape(location)}"]`)) continue;
      const path = document.createElement("span");
      path.className = "ai-tool-path";
      path.dataset.path = location;
      path.textContent = location;
      path.title = location;
      tool.append(path);
    }
    if (event.text) {
      let output = tool.querySelector(".ai-tool-output");
      if (!output) {
        output = document.createElement("pre");
        output.className = "ai-tool-output";
        tool.append(output);
      }
      output.textContent = event.text;
    }
  }

  function questionStatusText(data) {
    if (data.cancelled || data.status === "cancelled") return "Question cancelled.";
    if (data.timedOut || data.status === "timed_out") {
      return "No answer — the assistant can continue or ask again.";
    }
    if (data.answerIndex !== null && data.answerIndex !== undefined) {
      return `Selected: ${data.answer || "option chosen"}`;
    }
    return "Waiting for your choice…";
  }

  function buildQuestionCard(event) {
    const existing = event.requestId ? ui.questionEls.get(event.requestId) : null;
    if (existing) return existing;
    const card = document.createElement("div");
    card.className = "ai-question";
    card.dataset.questionId = event.requestId || "";
    card.setAttribute("role", "group");
    card.setAttribute("aria-label", "Assistant question");
    card.innerHTML = `
      <div class="ai-question-head">${icon("help")}<span>Quick question</span></div>
      <p class="ai-question-text"></p>
      <div class="ai-question-options"></div>
      <div class="ai-question-status" hidden></div>
    `;
    card.querySelector(".ai-question-text").textContent = event.question || "";
    const optionsEl = card.querySelector(".ai-question-options");
    const resolved = Boolean(event.status && event.status !== "pending")
      || (event.answerIndex !== null && event.answerIndex !== undefined);
    for (const [index, option] of (event.options || []).entries()) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "ai-question-option";
      button.dataset.chatAnswer = String(index);
      button.disabled = resolved;
      const key = document.createElement("span");
      key.className = "ai-question-option-key";
      key.textContent = String(index + 1);
      const label = document.createElement("span");
      label.textContent = option;
      button.append(key, label);
      if (event.answerIndex === index) button.classList.add("is-selected");
      optionsEl.append(button);
    }
    if (resolved) {
      card.classList.add("is-resolved");
      const status = card.querySelector(".ai-question-status");
      status.hidden = false;
      status.textContent = questionStatusText(event);
    }
    if (event.requestId) ui.questionEls.set(event.requestId, card);
    return card;
  }

  function updateQuestionCard(card, data) {
    if (!card) return;
    const optionIndex = Number.isInteger(Number(data.optionIndex))
      ? Number(data.optionIndex)
      : Number.isInteger(data.answerIndex)
        ? data.answerIndex
        : null;
    card.classList.add("is-resolved");
    for (const [index, button] of [...card.querySelectorAll("[data-chat-answer]")].entries()) {
      button.disabled = true;
      button.classList.toggle("is-selected", index === optionIndex);
    }
    const status = card.querySelector(".ai-question-status");
    if (status) {
      status.hidden = false;
      status.textContent = questionStatusText({ ...data, answerIndex: optionIndex });
    }
    ui.questionPending = false;
    updateComposer();
  }

  function resolveQuestionCard(requestId, event) {
    const card = ui.questionEls.get(requestId);
    if (card) updateQuestionCard(card, event);
    else {
      ui.questionPending = false;
      updateComposer();
    }
  }

  async function answerQuestion(card, optionIndex) {
    if (!card || !Number.isInteger(optionIndex) || card.classList.contains("is-resolved")) return;
    if (!ui.busy && !ui.streaming && !ui.chat?.busy) {
      toast?.("This question is no longer active.", "warn", 4000);
      return;
    }
    const buttons = [...card.querySelectorAll("[data-chat-answer]")];
    const status = card.querySelector(".ai-question-status");
    for (const button of buttons) button.disabled = true;
    buttons[optionIndex]?.classList.add("is-selected");
    if (status) {
      status.hidden = false;
      status.textContent = "Sending…";
    }
    try {
      const data = await chatFetch("/api/chat/answer", {
        method: "POST",
        body: {
          requestId: card.dataset.questionId,
          optionIndex
        }
      });
      updateQuestionCard(card, {
        answer: data.answer,
        optionIndex: data.optionIndex,
        status: "answered"
      });
    } catch (error) {
      toast?.(error.message, "error", 5000);
      if (!card.classList.contains("is-resolved")) {
        for (const button of buttons) button.disabled = false;
        if (status) status.textContent = "Not sent — try again.";
      }
    }
  }

  function buildPermissionCard(event) {
    const existing = ui.permissionEls.get(event.requestId);
    if (existing) return existing;
    const card = document.createElement("div");
    card.className = "ai-permission";
    card.dataset.requestId = event.requestId;
    const run = event.kind === "run";
    card.innerHTML = `
      <div class="ai-permission-title">
        ${icon("alert")}
        <span>${run ? "Run the game?" : "Approve a project change?"}</span>
      </div>
      <p>${run
        ? "The assistant wants to launch LÖVE for a short smoke test, capture the output, then stop it."
        : "The assistant wants to modify files in this project. Review the paths below before allowing the action."}</p>
    `;
    const paths = document.createElement("div");
    paths.className = "ai-permission-paths";
    for (const location of event.locations || []) {
      const item = document.createElement("span");
      item.textContent = location;
      paths.append(item);
    }
    card.append(paths);
    if (event.diff) {
      const details = document.createElement("details");
      details.className = "ai-permission-diff";
      const summary = document.createElement("summary");
      summary.textContent = "Review proposed content";
      const pre = document.createElement("pre");
      pre.textContent = event.diff.oldText == null
        ? `Proposed contents:\n${event.diff.newText || ""}`
        : `Current content:\n${event.diff.oldText}\n\nProposed content:\n${event.diff.newText}`;
      details.append(summary, pre);
      card.append(details);
    }
    const actions = document.createElement("div");
    actions.className = "ai-permission-actions";
    actions.innerHTML = `
      <button class="btn btn-small btn-primary" type="button" data-chat-decision="allow-once">${run ? "Run once" : "Allow once"}</button>
      <button class="btn btn-small btn-ghost" type="button" data-chat-decision="allow-always">${run ? "Always allow runs" : "Always allow edits"}</button>
      <button class="btn btn-small btn-ghost" type="button" data-chat-decision="deny">Deny</button>
    `;
    const status = document.createElement("div");
    status.className = "ai-permission-status";
    status.hidden = true;
    card.append(actions, status);
    ui.permissionEls.set(event.requestId, card);
    return card;
  }

  async function decidePermission(requestId, decision, card) {
    if (!ui.busy && !ui.streaming && !ui.chat?.busy) {
      toast?.("This permission request is no longer active.", "warn", 4000);
      return;
    }
    for (const button of card.querySelectorAll("[data-chat-decision]")) {
      button.disabled = true;
    }
    const status = card.querySelector(".ai-permission-status");
    if (status) {
      status.hidden = false;
      status.textContent = "Sending…";
    }
    try {
      await chatFetch("/api/chat/permission", {
        method: "POST",
        body: { requestId, decision }
      });
      card.classList.add("is-resolved");
      if (status) {
        status.textContent = decision === "deny"
          ? "Denied"
          : decision === "allow-always"
            ? "Allowed for this chat"
            : "Allowed once";
      }
    } catch (error) {
      toast?.(error.message, "error", 5000);
      for (const button of card.querySelectorAll("[data-chat-decision]")) {
        button.disabled = false;
      }
      if (status) status.textContent = "Not sent";
    }
  }

  function resolvePermissionCard(requestId, decision, reason = "") {
    const card = ui.permissionEls.get(requestId);
    if (!card) return;
    card.classList.add("is-resolved");
    for (const button of card.querySelectorAll("[data-chat-decision]")) {
      button.disabled = true;
    }
    const status = card.querySelector(".ai-permission-status");
    if (status) {
      status.hidden = false;
      status.textContent = decision === "deny"
        ? `Denied${reason ? ` · ${reason}` : ""}`
        : decision === "allow-always"
          ? "Allowed for this chat"
          : "Allowed once";
    }
  }

  function updateComposer() {
    const chat = ui.chat;
    const ready = Boolean(chat?.available && chat?.configured);
    const busy = ui.busy || Boolean(chat?.busy);
    sendButton.disabled = !ready || busy;
    stopButton.hidden = !busy;
    stopButton.disabled = false;
    inputEl.disabled = !ready;
    inputEl.placeholder = !chat?.available
      ? "Open a project to chat…"
      : !chat?.configured
        ? "Add a DeepSeek key in Setup…"
        : busy
          ? ui.questionPending
            ? "Choose an option above…"
            : "Assistant is working…"
          : "Ask about your game…";
    setOpenButtonState();
  }

  function setBusy(busy) {
    ui.busy = busy;
    if (busy) clearPoll();
    updateComposer();
  }

  function autoSizeInput() {
    inputEl.style.height = "auto";
    inputEl.style.height = `${Math.min(150, inputEl.scrollHeight)}px`;
  }

  function scrollToBottom(force = false) {
    if (force) ui.followLatest = true;
    if (!ui.followLatest) return;
    messagesEl.scrollTop = messagesEl.scrollHeight;
  }

  function appendTyping(container) {
    const node = document.createElement("div");
    node.className = "ai-typing";
    node.dataset.typing = "1";
    node.innerHTML = "<i></i><i></i><i></i>";
    container.append(node);
    return node;
  }

  async function send() {
    const text = inputEl.value.trim();
    if (!text || ui.busy || ui.chat?.busy) return;
    if (!ui.chat?.available) {
      toast?.("Open a project first.", "warn", 4000);
      return;
    }
    if (!ui.chat?.configured) {
      onOpenSetup?.();
      return;
    }
    if (onBeforeSend) {
      const allowed = await onBeforeSend();
      if (allowed === false) return;
    }

    messagesEl.querySelector(".ai-empty")?.remove();
    const userMessage = buildUserMessage(text);
    messagesEl.append(userMessage);
    inputEl.value = "";
    autoSizeInput();
    setBusy(true);
    ui.streaming = true;
    ui.assistantEls.clear();
    ui.toolEls.clear();
    ui.permissionEls.clear();
    ui.questionEls.clear();
    ui.questionPending = false;

    const turn = document.createElement("div");
    turn.className = "ai-turn";
    messagesEl.append(turn);
    ui.liveTurn = turn;
    let typing = appendTyping(turn);
    scrollToBottom(true);

    let sawDone = false;
    try {
      const response = await fetch("/api/chat/send", {
        method: "POST",
        headers: {
          "x-studio-token": token,
          "content-type": "application/json"
        },
        body: JSON.stringify({ message: text })
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => ({}));
        throw new Error(payload.error || `Assistant request failed (${response.status}).`);
      }
      if (!response.body) throw new Error("The assistant returned no stream.");

      const reader = response.body.getReader();
      ui.streamReader = reader;
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          if (!line.trim()) continue;
          let event;
          try { event = JSON.parse(line); } catch { continue; }
          if (event.type === "done") {
            sawDone = true;
          }
          handleStreamEvent(event, turn, () => {
            if (typing?.isConnected) typing.remove();
            typing = null;
          });
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) {
        try { handleStreamEvent(JSON.parse(buffer), turn); } catch { /* ignore */ }
      }
      if (!sawDone) {
        appendEphemeralError(turn, "The assistant stream ended unexpectedly.");
      }
    } catch (error) {
      appendEphemeralError(turn, error.message);
      toast?.(error.message, "error", 6000);
      try { await chatFetch("/api/chat/cancel", { method: "POST", body: {} }); } catch { /* ignore */ }
    } finally {
      ui.streaming = false;
      ui.streamReader = null;
      setBusy(false);
      typing?.remove();
      if (ui.open) {
        await loadState({ silent: true });
        scrollToBottom(true);
      }
    }
  }

  function handleStreamEvent(event, turn, removeTyping) {
    if (!ui.liveTurn) return;
    switch (event.type) {
      case "assistant_start": {
        removeTyping();
        let node = ui.assistantEls.get(event.id);
        if (!node) {
          node = buildAssistantMessage("", "");
          node.dataset.assistantId = event.id;
          const markdown = node.querySelector(".ai-markdown");
          markdown.innerHTML = `<div class="ai-stream-text"></div>`;
          node.append(appendTyping(node));
          ui.assistantEls.set(event.id, node);
          turn.append(node);
        }
        break;
      }
      case "assistant_delta": {
        removeTyping();
        const node = ui.assistantEls.get(event.id) || ensureAssistantNode(event.id, turn);
        const stream = node.querySelector(".ai-stream-text");
        if (stream) stream.textContent += event.text;
        scrollToBottom();
        break;
      }
      case "assistant_reasoning_delta": {
        removeTyping();
        const node = ui.assistantEls.get(event.id) || ensureAssistantNode(event.id, turn);
        let reasoning = node.querySelector(".ai-reasoning");
        if (!reasoning) {
          reasoning = buildReasoning("");
          node.prepend(reasoning);
        }
        reasoning.querySelector("pre").textContent += event.text;
        scrollToBottom();
        break;
      }
      case "assistant_end": {
        removeTyping();
        const node = ui.assistantEls.get(event.id) || ensureAssistantNode(event.id, turn);
        const markdown = node.querySelector(".ai-markdown");
        if (markdown) markdown.innerHTML = renderMarkdown(event.text || "");
        if (event.reasoning) {
          let reasoning = node.querySelector(".ai-reasoning");
          if (!reasoning) {
            reasoning = buildReasoning(event.reasoning);
            node.prepend(reasoning);
          } else {
            reasoning.querySelector("pre").textContent = event.reasoning;
          }
        }
        node.querySelector("[data-typing]")?.remove();
        scrollToBottom();
        break;
      }
      case "tool_call":
      case "tool_update": {
        removeTyping();
        let tool = ui.toolEls.get(event.id);
        if (!tool) {
          tool = buildToolCard({
            toolCallId: event.id,
            name: event.name,
            title: event.title,
            kind: event.kind,
            status: event.status
          });
          ui.toolEls.set(event.id, tool);
          turn.append(tool);
        }
        updateToolCard(tool, event);
        scrollToBottom();
        break;
      }
      case "tool_result": {
        removeTyping();
        let tool = ui.toolEls.get(event.id);
        if (!tool) {
          tool = buildToolCard(event);
          ui.toolEls.set(event.id, tool);
          turn.append(tool);
        }
        updateToolCard(tool, event);
        scrollToBottom();
        break;
      }
      case "permission_request": {
        removeTyping();
        const card = buildPermissionCard(event);
        if (!card.isConnected) turn.append(card);
        scrollToBottom(true);
        break;
      }
      case "permission_resolved": {
        resolvePermissionCard(event.requestId, event.decision, event.reason);
        break;
      }
      case "question_request": {
        removeTyping();
        const card = buildQuestionCard(event);
        if (!card.isConnected) turn.append(card);
        else if (turn.lastElementChild !== card) turn.append(card);
        ui.questionPending = true;
        updateComposer();
        scrollToBottom(true);
        setTimeout(() => {
          const first = card.querySelector("[data-chat-answer]:not([disabled])");
          first?.focus({ preventScroll: true });
        }, 30);
        break;
      }
      case "question_resolved": {
        resolveQuestionCard(event.requestId, event);
        scrollToBottom();
        break;
      }
      case "status": {
        removeTyping();
        const note = document.createElement("div");
        note.className = "ai-turn-status";
        note.textContent = event.message || "";
        turn.append(note);
        scrollToBottom();
        break;
      }
      case "workspace_changed": {
        onWorkspaceChanged?.(event.paths || []).catch((error) => {
          toast?.(error.message, "error", 5000);
        });
        break;
      }
      case "error": {
        appendEphemeralError(turn, event.message || "Assistant error.");
        removeTyping();
        break;
      }
      case "done": {
        removeTyping();
        if (event.stopReason === "cancelled") {
          const note = document.createElement("div");
          note.className = "ai-tool-state";
          note.style.padding = "2px 2px 0";
          note.textContent = "Stopped";
          turn.append(note);
        } else if (event.stopReason === "max_tokens") {
          const note = document.createElement("div");
          note.className = "ai-turn-status";
          note.textContent = "The model reached its output limit before finishing. Ask it to continue.";
          turn.append(note);
        }
        break;
      }
      default:
        break;
    }
  }

  function ensureAssistantNode(id, turn) {
    let node = buildAssistantMessage("", "");
    node.dataset.assistantId = id;
    node.querySelector(".ai-markdown").innerHTML = `<div class="ai-stream-text"></div>`;
    node.append(appendTyping(node));
    ui.assistantEls.set(id, node);
    turn.append(node);
    return node;
  }

  function appendEphemeralError(container, message) {
    const node = document.createElement("div");
    node.className = "ai-message error";
    node.textContent = message;
    container.append(node);
    scrollToBottom(true);
  }

  async function stop() {
    if (!ui.chat?.busy && !ui.streaming) return;
    stopButton.disabled = true;
    try {
      await chatFetch("/api/chat/cancel", { method: "POST", body: {} });
    } catch (error) {
      toast?.(error.message, "error", 5000);
    } finally {
      stopButton.disabled = false;
    }
  }

  async function newChat() {
    try {
      const data = await chatFetch("/api/chat/reset", { method: "POST", body: {} });
      ui.chat = data.chat;
      ui.loaded = true;
      setBusy(false);
      ui.streaming = false;
      ui.questionPending = false;
      renderChat();
      scrollToBottom(true);
      toast?.("Started a new AI chat.", "success", 2000);
    } catch (error) {
      toast?.(error.message, "error", 5000);
    }
  }

  async function refresh() {
    ui.loaded = false;
    if (ui.open) await loadState();
  }

  function onProjectChanged() {
    ui.loaded = false;
    ui.chat = null;
    ui.permissionEls.clear();
    ui.questionEls.clear();
    ui.questionPending = false;
    clearPoll();
    if (ui.open) loadState();
    else updateComposer();
  }

  return {
    open: () => setOpen(true),
    close,
    toggle,
    refresh,
    onProjectChanged,
    isOpen: () => ui.open
  };
}
