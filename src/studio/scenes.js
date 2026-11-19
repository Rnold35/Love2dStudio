import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { readJson, resolveInside, sanitizeSlug, writeJsonAtomic } from "../shared/fsx.js";

export const ENTITY_TYPES = ["sprite", "rectangle", "circle", "text"];
const MAX_ENTITIES = 4000;
const MAX_SCENE_SIZE = 16384;

function number(value, fallback = 0, min = -100000, max = 100000) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function color(value, fallback = [1, 1, 1, 1]) {
  if (!Array.isArray(value)) return [...fallback];
  const toChannel = (channel, index) => {
    const parsed = Number(channel);
    if (!Number.isFinite(parsed)) return fallback[index];
    return Math.min(1, Math.max(0, parsed));
  };
  return [
    toChannel(value[0], 0),
    toChannel(value[1], 1),
    toChannel(value[2], 2),
    value[3] === undefined ? 1 : toChannel(value[3], 3)
  ];
}

function safeProperties(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const allowedPrimitive = (item) =>
    typeof item === "string" || typeof item === "number" || typeof item === "boolean";
  const output = {};
  for (const [key, item] of Object.entries(value)) {
    if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(key)) continue;
    if (allowedPrimitive(item)) output[key] = item;
  }
  return output;
}

function entityId(value, seen) {
  let id = typeof value === "string" ? value.trim().replace(/[^A-Za-z0-9_-]/g, "") : "";
  if (!id || seen.has(id)) {
    id = `ent_${Date.now().toString(36)}_${crypto.randomBytes(3).toString("hex")}`;
  }
  seen.add(id);
  return id;
}

function sanitiseEntity(raw, index, seen, projectPath) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const type = ENTITY_TYPES.includes(raw.type) ? raw.type : "rectangle";
  const id = entityId(raw.id, seen);
  const entity = {
    id,
    name: typeof raw.name === "string" && raw.name.trim()
      ? raw.name.trim().slice(0, 120)
      : `Entity ${index + 1}`,
    type,
    x: number(raw.x),
    y: number(raw.y),
    w: number(raw.w, type === "text" ? 300 : 64, 1, MAX_SCENE_SIZE),
    h: number(raw.h, type === "text" ? 32 : 64, 1, MAX_SCENE_SIZE),
    rotation: number(raw.rotation, 0, -36000, 36000),
    opacity: number(raw.opacity, 1, 0, 1),
    layer: Math.trunc(number(raw.layer, 0, -9999, 9999)),
    visible: raw.visible !== false,
    color: color(raw.color)
  };
  if (type === "sprite") {
    const candidate = typeof raw.path === "string" ? raw.path.replace(/\\/g, "/") : "";
    if (candidate) {
      try {
        const resolved = resolveInside(projectPath, candidate);
        const relative = path.relative(projectPath, resolved).replace(/\\/g, "/");
        if (relative.startsWith("assets/") || relative.startsWith("scenes/")) {
          entity.path = relative;
        }
      } catch {
        // Ignore paths outside the project.
      }
    }
    if (!entity.path) entity.path = "";
  } else if (type === "rectangle") {
    entity.fill = raw.fill !== false;
    entity.radius = number(raw.radius, 0, 0, 512);
  } else if (type === "circle") {
    entity.fill = raw.fill !== false;
  } else if (type === "text") {
    entity.text = typeof raw.text === "string" ? raw.text.slice(0, 10000) : "Text";
    entity.fontSize = Math.trunc(number(raw.fontSize, 16, 4, 512));
    entity.align = ["left", "center", "right", "justify"].includes(raw.align)
      ? raw.align
      : "left";
  }
  if (raw.properties && typeof raw.properties === "object") {
    entity.properties = safeProperties(raw.properties);
  }
  if (Array.isArray(raw.tags)) {
    entity.tags = raw.tags
      .filter((tag) => typeof tag === "string")
      .map((tag) => tag.slice(0, 40))
      .slice(0, 20);
  }
  return entity;
}

export function validateScene(input, projectPath) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Scene must be a JSON object.");
  }
  const width = Math.trunc(number(input.width, 960, 1, MAX_SCENE_SIZE));
  const height = Math.trunc(number(input.height, 600, 1, MAX_SCENE_SIZE));
  const rawEntities = Array.isArray(input.entities) ? input.entities : [];
  if (rawEntities.length > MAX_ENTITIES) {
    throw new Error(`A scene can contain at most ${MAX_ENTITIES} entities.`);
  }
  const seen = new Set();
  const entities = rawEntities
    .map((entity, index) => sanitiseEntity(entity, index, seen, projectPath))
    .filter(Boolean);
  const name = typeof input.name === "string" && input.name.trim()
    ? input.name.trim().slice(0, 100)
    : "Scene";
  return {
    version: 1,
    name,
    width,
    height,
    background: color(input.background, [0.055, 0.065, 0.085, 1]),
    entities
  };
}

export function sceneFile(projectPath, name) {
  const slug = sanitizeSlug(name);
  const file = resolveInside(projectPath, path.join("scenes", `${slug}.json`), {
    allowMissing: true
  });
  return { slug, file };
}

export function loadScene(projectPath, name) {
  const { slug, file } = sceneFile(projectPath, name);
  if (!fs.existsSync(file)) throw new Error(`Scene not found: ${slug}`);
  const raw = readJson(file);
  return { ...validateScene(raw, projectPath), file: `${slug}.json` };
}

export function saveScene(projectPath, name, input) {
  const { slug, file } = sceneFile(projectPath, name);
  const scene = validateScene({ ...input, name: input?.name ?? slug }, projectPath);
  writeJsonAtomic(file, scene);
  return { ...scene, file: `${slug}.json` };
}

export function createScene(projectPath, { name, width = 960, height = 600 }) {
  const { slug, file } = sceneFile(projectPath, name);
  if (fs.existsSync(file)) throw new Error(`A scene named "${slug}" already exists.`);
  const scene = validateScene(
    {
      name: slug,
      width,
      height,
      background: [0.055, 0.065, 0.085, 1],
      entities: []
    },
    projectPath
  );
  writeJsonAtomic(file, scene);
  return { ...scene, file: `${slug}.json` };
}

export function deleteScene(projectPath, name) {
  const { slug, file } = sceneFile(projectPath, name);
  if (!fs.existsSync(file)) throw new Error(`Scene not found: ${slug}`);
  const remaining = fs.readdirSync(path.join(projectPath, "scenes"))
    .filter((entry) => entry.toLowerCase().endsWith(".json"));
  if (remaining.length <= 1) {
    throw new Error("Keep at least one scene in the project.");
  }
  fs.unlinkSync(file);
  return { deleted: `${slug}.json` };
}

export function duplicateScene(projectPath, name, newName) {
  const source = loadScene(projectPath, name);
  return createScene(projectPath, {
    name: newName,
    width: source.width,
    height: source.height
  }).file
    ? saveScene(projectPath, newName, { ...source, name: newName })
    : null;
}
