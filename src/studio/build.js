import fs from "node:fs";
import path from "node:path";
import AdmZip from "adm-zip";
import { findLove, loveVersion } from "../shared/love.js";
import { isInside, sanitizeName } from "../shared/fsx.js";

export const BUILD_FORMATS = Object.freeze([
  {
    id: "windows-zip",
    name: "Windows ZIP",
    description: "A playable Windows folder plus a ZIP you can share.",
    requiresLove: true,
    recommended: true
  },
  {
    id: "windows",
    name: "Windows folder",
    description: "A fused .exe with the LÖVE runtime and DLLs.",
    requiresLove: true
  },
  {
    id: "love",
    name: "Portable .love",
    description: "The game as a single archive. Requires LÖVE to play.",
    requiresLove: false
  }
]);

const FORMATS = new Map(BUILD_FORMATS.map((format) => [format.id, format]));

// These are editor, VCS, tooling, or runtime files that should never be
// distributed with a game. Keep game source (main.lua, src/, scenes/, assets/).
const ALWAYS_EXCLUDED = new Set([
  ".git",
  ".hg",
  ".svn",
  ".zed",
  ".love2d-studio",
  ".github",
  ".vscode",
  ".idea",
  ".research",
  ".testprojects",
  ".claude",
  ".cache",
  "node_modules",
  "__pycache__"
]);
const TOP_LEVEL_EXCLUDED = new Set(["build", "dist"]);
const EXCLUDED_FILES = new Set([
  ".luarc.json",
  ".rules",
  ".gitignore",
  ".gitattributes",
  ".npmrc",
  ".netrc",
  ".DS_Store",
  "Thumbs.db",
  "desktop.ini"
]);

function cleanBaseName(name) {
  let safe = sanitizeName(name, "Love2D Game")
    .replace(/^\.+/, "")
    .trim();
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(safe)) {
    safe = `${safe}-game`;
  }
  return safe || "Love2D Game";
}

function projectName(projectPath) {
  try {
    const meta = JSON.parse(fs.readFileSync(
      path.join(projectPath, ".love2d-studio", "project.json"),
      "utf8"
    ));
    if (typeof meta.name === "string" && meta.name.trim()) return meta.name.trim();
  } catch {
    // Projects created outside the Studio have no metadata.
  }
  return path.basename(projectPath);
}

function findWindowsLove() {
  if (process.platform !== "win32") {
    return {
      found: false,
      windowsReady: false,
      executable: "",
      directory: "",
      version: "",
      dlls: [],
      license: ""
    };
  }
  const executable = findLove({ console: false });
  if (!executable || path.basename(executable).toLowerCase() !== "love.exe") {
    return {
      found: false,
      windowsReady: false,
      executable: "",
      directory: "",
      version: "",
      dlls: [],
      license: ""
    };
  }
  const directory = path.dirname(executable);
  let entries = [];
  try {
    entries = fs.readdirSync(directory);
  } catch {
    // The checks below report a useful error.
  }
  const dlls = entries
    .filter((name) => name.toLowerCase().endsWith(".dll"))
    .sort((a, b) => a.localeCompare(b));
  const license = entries.find((name) => name.toLowerCase() === "license.txt") || "";
  const versionExecutable = entries.includes("lovec.exe")
    ? path.join(directory, "lovec.exe")
    : executable;
  return {
    found: true,
    windowsReady: dlls.length > 0,
    executable,
    directory,
    version: loveVersion(versionExecutable),
    dlls,
    license
  };
}

function shouldSkipFile(name) {
  if (EXCLUDED_FILES.has(name)) return true;
  if (name === ".env" || name.startsWith(".env.")) return true;
  if (/\.(pem|key|p12|pfx)$/i.test(name)) return true;
  return false;
}

function collectProjectFiles(projectPath, outputDir) {
  const files = [];
  const stack = [projectPath];

  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (cause) {
      throw new Error(`Could not read ${dir}: ${cause.message}`);
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (isInside(outputDir, full)) continue;

      const relative = path.relative(projectPath, full).split(path.sep).join("/");
      const parts = relative.split("/");
      if (parts.some((part) => ALWAYS_EXCLUDED.has(part))) continue;
      if (TOP_LEVEL_EXCLUDED.has(parts[0])) continue;

      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile() && !shouldSkipFile(entry.name)) {
        files.push({
          relative,
          full,
          size: entry.isFile() ? fs.statSync(full).size : 0
        });
      }
    }
  }

  files.sort((a, b) => a.relative.localeCompare(b.relative));
  return files;
}

function makeProjectZip(files) {
  const zip = new AdmZip();
  for (const file of files) {
    zip.addFile(file.relative, fs.readFileSync(file.full));
  }
  return zip;
}

function uniquePath(target) {
  if (!fs.existsSync(target)) return target;
  const extension = path.extname(target);
  const base = extension ? target.slice(0, -extension.length) : target;
  for (let index = 2; index < 1000; index += 1) {
    const candidate = `${base}-${index}${extension}`;
    if (!fs.existsSync(candidate)) return candidate;
  }
  throw new Error(`Could not choose a unique build path near ${target}.`);
}

function writeFileUnique(outputDir, name, buffer) {
  const target = uniquePath(path.join(outputDir, name));
  const temporary = path.join(
    outputDir,
    `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`
  );
  try {
    fs.writeFileSync(temporary, buffer);
    fs.renameSync(temporary, target);
    return target;
  } catch (cause) {
    try { fs.rmSync(temporary, { force: true }); } catch {}
    throw cause;
  }
}

function walkAllFiles(dir) {
  const files = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) files.push(full);
    }
  }
  return files;
}

function folderSize(dir) {
  let total = 0;
  for (const file of walkAllFiles(dir)) {
    try { total += fs.statSync(file).size; } catch {}
  }
  return total;
}

function makeFolderZip(folder, rootName) {
  const zip = new AdmZip();
  const files = walkAllFiles(folder)
    .map((file) => ({
      full: file,
      relative: path.relative(folder, file).split(path.sep).join("/")
    }))
    .sort((a, b) => a.relative.localeCompare(b.relative));
  for (const file of files) {
    zip.addFile(`${rootName}/${file.relative}`, fs.readFileSync(file.full));
  }
  return zip;
}

function gameReadme(name, loveVersionLabel) {
  return [
    name,
    "",
    "Built with Love2D Studio.",
    "",
    `Run ${name}.exe to play. Keep the DLLs and license.txt in this folder.`,
    "The game runs from the executable; the .love archive is fused into the .exe.",
    loveVersionLabel ? `Runtime: LÖVE ${loveVersionLabel}` : "Runtime: LÖVE",
    "",
    "The game source is included inside the executable and can be inspected with",
    "any ZIP reader after the LÖVE executable header."
  ].join("\r\n") + "\r\n";
}

/**
 * Returns metadata for the Build & Export dialog without writing anything.
 */
export function buildInfo(projectPath) {
  const projectRoot = path.resolve(projectPath);
  const love = findWindowsLove();
  return {
    project: {
      path: projectRoot,
      name: projectName(projectRoot),
      hasMain: fs.existsSync(path.join(projectRoot, "main.lua"))
    },
    formats: BUILD_FORMATS.map((format) => ({ ...format })),
    love: {
      found: love.found,
      windowsReady: love.windowsReady,
      executable: love.executable,
      version: love.version
    },
    defaultOutputDir: path.join(projectRoot, "build")
  };
}

/**
 * Builds a distributable game. The operation is synchronous because it uses
 * local files and ZIP buffers; the HTTP layer guards against concurrent builds.
 *
 * @param {string} projectPath
 * @param {{ format?: string, outputDir?: string }} options
 */
export function buildGame(projectPath, { format = "windows-zip", outputDir = "" } = {}) {
  const projectRoot = path.resolve(projectPath);
  const formatSpec = FORMATS.get(format);
  if (!formatSpec) {
    throw new Error(`Unknown build format. Choose one of: ${[...FORMATS.keys()].join(", ")}.`);
  }

  let projectStat;
  try {
    projectStat = fs.statSync(projectRoot);
  } catch {
    throw new Error(`Project folder does not exist: ${projectRoot}`);
  }
  if (!projectStat.isDirectory()) throw new Error("The project path is not a folder.");
  if (!fs.existsSync(path.join(projectRoot, "main.lua"))) {
    throw new Error("This project has no main.lua. Add a game entry point before building.");
  }

  const displayName = projectName(projectRoot);
  const safeName = cleanBaseName(displayName);
  const resolvedOutput = path.resolve(outputDir || path.join(projectRoot, "build"));
  if (resolvedOutput === projectRoot) {
    throw new Error("Choose an output folder other than the project folder.");
  }
  if (fs.existsSync(resolvedOutput) && !fs.statSync(resolvedOutput).isDirectory()) {
    throw new Error(`The output path is not a folder: ${resolvedOutput}`);
  }
  fs.mkdirSync(resolvedOutput, { recursive: true });

  const files = collectProjectFiles(projectRoot, resolvedOutput);
  if (!files.some((file) => file.relative === "main.lua")) {
    throw new Error("main.lua was excluded from the build. Check the project layout.");
  }
  if (!files.length) throw new Error("There are no game files to build.");

  const zipBuffer = makeProjectZip(files).toBuffer();
  const warnings = [];
  const artifacts = [];
  const createdFiles = [];
  let buildDir = "";
  let loveRuntime = null;

  try {
    if (format === "love") {
      const target = writeFileUnique(resolvedOutput, `${safeName}.love`, zipBuffer);
      createdFiles.push(target);
      artifacts.push({
        kind: "love",
        label: path.basename(target),
        path: target,
        bytes: fs.statSync(target).size
      });
    } else {
      loveRuntime = findWindowsLove();
      if (!loveRuntime.found) {
        throw new Error(
          "LÖVE for Windows was not found. Install LÖVE 11.5 or set love.exe in Setup, then try again."
        );
      }
      if (!loveRuntime.windowsReady) {
        throw new Error(
          `The LÖVE folder at ${loveRuntime.directory} has no runtime DLLs. Reinstall LÖVE or select love.exe in Setup.`
        );
      }

      buildDir = uniquePath(path.join(resolvedOutput, `${safeName}-win64`));
      fs.mkdirSync(buildDir);
      const executable = path.join(buildDir, `${safeName}.exe`);
      fs.copyFileSync(loveRuntime.executable, executable);
      createdFiles.push(executable);
      // LÖVE loads a ZIP appended to its executable as a fused game.
      fs.appendFileSync(executable, zipBuffer);

      for (const dll of loveRuntime.dlls) {
        const destination = path.join(buildDir, dll);
        fs.copyFileSync(path.join(loveRuntime.directory, dll), destination);
      }
      if (loveRuntime.license) {
        fs.copyFileSync(
          path.join(loveRuntime.directory, loveRuntime.license),
          path.join(buildDir, loveRuntime.license)
        );
      } else {
        warnings.push("LÖVE's license.txt was not found in the runtime folder.");
      }
      fs.writeFileSync(
        path.join(buildDir, "README.txt"),
        gameReadme(safeName, loveRuntime.version),
        "utf8"
      );

      artifacts.push({
        kind: "folder",
        label: `${path.basename(buildDir)}/`,
        path: buildDir,
        bytes: folderSize(buildDir),
        fileCount: fs.readdirSync(buildDir).length
      });

      if (format === "windows-zip") {
        const folderName = path.basename(buildDir);
        const zip = makeFolderZip(buildDir, folderName);
        const zipTarget = writeFileUnique(resolvedOutput, `${folderName}.zip`, zip.toBuffer());
        createdFiles.push(zipTarget);
        artifacts.push({
          kind: "zip",
          label: path.basename(zipTarget),
          path: zipTarget,
          bytes: fs.statSync(zipTarget).size
        });
      }
    }
  } catch (cause) {
    if (buildDir) {
      try { fs.rmSync(buildDir, { recursive: true, force: true }); } catch {}
    }
    for (const file of createdFiles) {
      try { fs.rmSync(file, { force: true }); } catch {}
    }
    throw cause;
  }

  return {
    version: 1,
    name: displayName,
    safeName,
    format,
    formatLabel: formatSpec.name,
    outputDir: resolvedOutput,
    artifacts,
    warnings,
    source: {
      files: files.length,
      bytes: files.reduce((total, file) => total + file.size, 0)
    },
    love: loveRuntime
      ? { version: loveRuntime.version, executable: loveRuntime.executable }
      : { version: "", executable: "" },
    builtAt: new Date().toISOString()
  };
}
