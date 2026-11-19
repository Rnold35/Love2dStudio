import fs from "node:fs";
import path from "node:path";
import { killProcessTree, spawnLove } from "../shared/love.js";

const MAX_LOG_LINES = 5000;

export class GameRunner {
  constructor() {
    this.child = null;
    this.projectPath = "";
    this.lovePath = "";
    this.logs = [];
    this.nextSeq = 1;
    this.generation = 0;
    this.stopRequested = false;
    this._buffers = { stdout: "", stderr: "" };
    this.logFile = "";
    this.logOffset = 0;
    this.logBuffer = "";
    this.logTailTimer = null;
    this.status = {
      running: false,
      pid: null,
      startedAt: null,
      exitedAt: null,
      exitCode: null,
      error: ""
    };
    this.listeners = new Set();
  }

  snapshot() {
    return {
      ...this.status,
      lovePath: this.lovePath,
      projectPath: this.projectPath,
      logs: this.logs.slice()
    };
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event) {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A disconnected browser must not break the runner.
      }
    }
  }

  append(stream, text) {
    if (text === undefined || text === null) return;
    const lines = String(text).split(/\r\n|\n|\r/);
    if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
    for (const line of lines) {
      if (line === "" && lines.length === 1) continue;
      const entry = {
        seq: this.nextSeq++,
        stream,
        text: line,
        ts: new Date().toISOString()
      };
      this.logs.push(entry);
      this.emit({ type: "log", entry });
    }
    if (this.logs.length > MAX_LOG_LINES) {
      this.logs.splice(0, this.logs.length - MAX_LOG_LINES);
    }
  }

  clear() {
    this.logs = [];
    this.emit({ type: "clear" });
  }

  setStatus(patch) {
    this.status = { ...this.status, ...patch };
    this.emit({ type: "status", status: this.status });
  }

  start(projectPath, lovePath) {
    if (!lovePath) {
      throw new Error("LÖVE was not found. Set its path in Studio → Setup.");
    }
    if (this.child && this.child.exitCode === null) {
      killProcessTree(this.child);
      this.child = null;
    }
    this.generation += 1;
    const generation = this.generation;
    this.stopRequested = false;
    this.projectPath = projectPath;
    this.lovePath = lovePath;
    this.logs = [];
    this.nextSeq = 1;
    this._buffers = { stdout: "", stderr: "" };
    this.stopLogTail();
    this.logOffset = 0;
    this.logBuffer = "";
    this.logFile = path.join(projectPath, ".love2d-studio", "runtime", "game.log");
    try {
      fs.mkdirSync(path.dirname(this.logFile), { recursive: true });
      fs.writeFileSync(this.logFile, "", "utf8");
    } catch {
      this.logFile = "";
    }
    this.emit({ type: "clear" });
    this.setStatus({
      running: true,
      pid: null,
      startedAt: new Date().toISOString(),
      exitedAt: null,
      exitCode: null,
      error: ""
    });
    this.append("system", `$ "${lovePath}" .`);

    let child;
    try {
      child = spawnLove(lovePath, ["."], {
        cwd: projectPath,
        env: this.logFile ? { LOVE2D_STUDIO_LOG: this.logFile } : {}
      });
    } catch (error) {
      this.append("stderr", error.message);
      this.setStatus({
        running: false,
        error: error.message,
        exitedAt: new Date().toISOString()
      });
      throw error;
    }
    this.child = child;
    this.setStatus({ pid: child.pid || null });

    this.pipeStream(child.stdout, "stdout", generation);
    this.pipeStream(child.stderr, "stderr", generation);
    this.startLogTail(generation);

    child.on("error", (error) => {
      if (generation !== this.generation) return;
      this.append("stderr", `[launcher] ${error.message}`);
      this.setStatus({
        running: false,
        error: error.message,
        exitedAt: new Date().toISOString()
      });
    });

    child.on("exit", (code, signal) => {
      if (generation !== this.generation) return;
      this.flushBuffers();
      this.readLogTail(true, generation);
      this.stopLogTail();
      this.child = null;
      const stoppedByUser = this.stopRequested;
      this.stopRequested = false;
      const ok = stoppedByUser || code === 0 || signal === "SIGTERM";
      this.append(
        ok ? "system" : "stderr",
        stoppedByUser
          ? "Game stopped."
          : code === null
            ? `Game stopped (${signal || "signal"}).`
            : `Game exited with code ${code}.`
      );
      this.setStatus({
        running: false,
        pid: null,
        exitedAt: new Date().toISOString(),
        exitCode: stoppedByUser ? 0 : code
      });
    });

    return this.snapshot();
  }

  pipeStream(stream, name, generation) {
    if (!stream) return;
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      if (generation !== this.generation) return;
      const buffers = this._buffers;
      buffers[name] += chunk;
      const parts = buffers[name].split(/\r\n|\n|\r/);
      buffers[name] = parts.pop() ?? "";
      for (const line of parts) {
        this.append(name, line);
      }
    });
    stream.on("error", (error) => {
      if (generation !== this.generation) return;
      this.append("stderr", `[${name}] ${error.message}`);
    });
  }

  flushBuffers() {
    const buffers = this._buffers;
    if (!buffers) return;
    for (const name of ["stdout", "stderr"]) {
      if (buffers[name]) {
        this.append(name, buffers[name]);
        buffers[name] = "";
      }
    }
    this._buffers = { stdout: "", stderr: "" };
  }

  startLogTail(generation) {
    if (!this.logFile) return;
    this.stopLogTail();
    this.readLogTail(false, generation);
    this.logTailTimer = setInterval(() => this.readLogTail(false, generation), 120);
    this.logTailTimer.unref?.();
  }

  stopLogTail() {
    if (this.logTailTimer) {
      clearInterval(this.logTailTimer);
      this.logTailTimer = null;
    }
  }

  readLogTail(final, generation) {
    if (!this.logFile || generation !== this.generation) return;
    let size;
    try {
      size = fs.statSync(this.logFile).size;
    } catch {
      return;
    }
    if (size < this.logOffset) {
      this.logOffset = 0;
      this.logBuffer = "";
    }
    if (size > this.logOffset) {
      let fd;
      try {
        fd = fs.openSync(this.logFile, "r");
        const length = size - this.logOffset;
        const buffer = Buffer.alloc(length);
        fs.readSync(fd, buffer, 0, length, this.logOffset);
        this.logOffset = size;
        this.logBuffer += buffer.toString("utf8");
      } catch {
        return;
      } finally {
        if (fd !== undefined) fs.closeSync(fd);
      }
    }
    if (final && this.logBuffer) {
      this.logBuffer += "\n";
    }
    const lines = this.logBuffer.split(/\r?\n/);
    this.logBuffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) continue;
      const text = line.replace(/^\d{2}:\d{2}:\d{2}\s/, "");
      this.append(/^ERROR:/i.test(text) ? "stderr" : "stdout", text);
    }
  }

  stop() {
    if (!this.child) {
      return { stopped: false };
    }
    this.stopRequested = true;
    this.append("system", "Stopping game…");
    killProcessTree(this.child);
    return { stopped: true };
  }

  shutdown() {
    this.generation += 1;
    this.stopLogTail();
    if (this.child) {
      killProcessTree(this.child);
      this.child = null;
    }
  }
}
