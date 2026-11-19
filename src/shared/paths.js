import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const APP_NAME = "Love2D Studio";
export const APP_ID = "love2d-studio";

function env(name) {
  const value = process.env[name];
  return typeof value === "string" && value.trim() ? value.trim() : "";
}

export function configDir() {
  if (env("LOVE2D_STUDIO_CONFIG_DIR")) {
    return path.resolve(env("LOVE2D_STUDIO_CONFIG_DIR"));
  }
  if (process.platform === "win32") {
    return path.join(env("APPDATA") || path.join(os.homedir(), "AppData", "Roaming"), APP_NAME);
  }
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", APP_NAME);
  }
  return path.join(env("XDG_CONFIG_HOME") || path.join(os.homedir(), ".config"), "love2d-studio");
}

export function configPath() {
  return path.join(configDir(), "config.json");
}

export function runtimePath() {
  return path.join(configDir(), "runtime.json");
}

export function luacatsDir() {
  return path.join(configDir(), "luacats", "love2d");
}

export function defaultProjectsDir() {
  const documents = process.platform === "win32"
    ? path.join(os.homedir(), "Documents")
    : os.homedir();
  return path.join(documents, "Love2D Projects");
}

export function defaultConfig() {
  return {
    version: 1,
    lovePath: "",
    zedPath: "",
    projectsDir: defaultProjectsDir(),
    deepseek: {
      apiKey: "",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-flash",
      maxTokens: 16384
    },
    recentProjects: []
  };
}

export function normalizeConfig(value) {
  const defaults = defaultConfig();
  const raw = value && typeof value === "object" ? value : {};
  const deepseek = raw.deepseek && typeof raw.deepseek === "object" ? raw.deepseek : {};
  return {
    ...defaults,
    ...raw,
    lovePath: typeof raw.lovePath === "string" ? raw.lovePath : defaults.lovePath,
    zedPath: typeof raw.zedPath === "string" ? raw.zedPath : defaults.zedPath,
    projectsDir: typeof raw.projectsDir === "string" && raw.projectsDir
      ? raw.projectsDir
      : defaults.projectsDir,
    deepseek: {
      apiKey: typeof deepseek.apiKey === "string" ? deepseek.apiKey : "",
      baseUrl: typeof deepseek.baseUrl === "string" && deepseek.baseUrl.trim()
        ? deepseek.baseUrl.trim().replace(/\/+$/, "")
        : defaults.deepseek.baseUrl,
      model: typeof deepseek.model === "string" && deepseek.model.trim()
        ? deepseek.model.trim()
        : defaults.deepseek.model,
      maxTokens: Number.isFinite(Number(deepseek.maxTokens))
        ? Math.max(256, Math.min(65536, Math.trunc(Number(deepseek.maxTokens))))
        : defaults.deepseek.maxTokens
    },
    recentProjects: Array.isArray(raw.recentProjects)
      ? raw.recentProjects.filter((item) => item && typeof item.path === "string").slice(0, 12)
      : []
  };
}

export function readConfig() {
  try {
    const raw = fs.readFileSync(configPath(), "utf8");
    return normalizeConfig(JSON.parse(raw));
  } catch (error) {
    if (error.code !== "ENOENT") {
      console.error(`[config] Could not read ${configPath()}: ${error.message}`);
    }
    return defaultConfig();
  }
}

export function writeConfig(config) {
  const file = configPath();
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const normalized = normalizeConfig(config);
  const temp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(normalized, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600
  });
  fs.renameSync(temp, file);
  try {
    if (process.platform !== "win32") {
      fs.chmodSync(file, 0o600);
    }
  } catch {
    // Best effort on filesystems without POSIX modes.
  }
  return normalized;
}

export function rememberProject(projectPath) {
  if (!projectPath) return readConfig();
  const config = readConfig();
  const resolved = path.resolve(projectPath);
  const entry = { path: resolved, name: path.basename(resolved), openedAt: new Date().toISOString() };
  config.recentProjects = [
    entry,
    ...config.recentProjects.filter((item) => path.resolve(item.path) !== resolved)
  ].slice(0, 12);
  return writeConfig(config);
}

export function publicConfig(config = readConfig()) {
  return {
    lovePath: config.lovePath,
    zedPath: config.zedPath,
    projectsDir: config.projectsDir,
    deepseek: {
      configured: Boolean(process.env.DEEPSEEK_API_KEY || config.deepseek.apiKey),
      baseUrl: config.deepseek.baseUrl,
      model: config.deepseek.model,
      maxTokens: config.deepseek.maxTokens
    },
    recentProjects: config.recentProjects
  };
}
