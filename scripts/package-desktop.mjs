import path from "node:path";
import fs from "node:fs";
import { execSync } from "node:child_process";
import { packager } from "@electron/packager";

const root = process.cwd();
const dist = process.env.LOVE2D_STUDIO_DIST
  ? path.resolve(process.env.LOVE2D_STUDIO_DIST)
  : path.join(root, "dist");
const stage = path.join(dist, "staging");
const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));

console.log("Preparing clean desktop staging directory…");
fs.rmSync(stage, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });

for (const item of ["desktop", "src", "bin", "templates", "vendor", "zed"]) {
  const source = path.join(root, item);
  if (fs.existsSync(source)) {
    fs.cpSync(source, path.join(stage, item), { recursive: true });
  }
}
for (const item of ["LICENSE"]) {
  const source = path.join(root, item);
  if (fs.existsSync(source)) fs.copyFileSync(source, path.join(stage, item));
}

const stagedPackage = {
  name: packageJson.name,
  version: packageJson.version,
  productName: packageJson.productName,
  type: packageJson.type,
  main: packageJson.main,
  description: packageJson.description,
  author: packageJson.author,
  license: packageJson.license,
  dependencies: packageJson.dependencies
};
fs.writeFileSync(
  path.join(stage, "package.json"),
  `${JSON.stringify(stagedPackage, null, 2)}\n`,
  "utf8"
);

console.log("Installing production dependencies in staging…");
execSync("npm install --omit=dev --ignore-scripts --no-audit --no-fund --package-lock=false", {
  cwd: stage,
  stdio: "inherit",
  env: { ...process.env, ELECTRON_SKIP_BINARY_DOWNLOAD: "1" }
});

console.log("Packaging Electron app…");
const paths = await packager({
  dir: stage,
  name: "Love2D Studio",
  executableName: "Love2D Studio",
  platform: "win32",
  arch: "x64",
  out: dist,
  overwrite: true,
  asar: false,
  prune: false,
  icon: path.join(root, "desktop", "icon.ico"),
  appVersion: packageJson.version,
  appCopyright: "Copyright Love2D Studio contributors",
  win32metadata: {
    CompanyName: "Love2D Studio",
    FileDescription: "Love2D Studio",
    ProductName: "Love2D Studio",
    InternalName: "Love2DStudio",
    OriginalFilename: "Love2D Studio.exe"
  }
});

const packagedReadme = path.join(root, "desktop", "README.txt");
for (const outputPath of paths) {
  if (fs.existsSync(packagedReadme)) {
    fs.copyFileSync(packagedReadme, path.join(outputPath, "README.txt"));
  }
  console.log(`Packaged desktop app: ${outputPath}`);
  console.log(`Executable: ${path.join(outputPath, "Love2D Studio.exe")}`);
}

fs.rmSync(stage, { recursive: true, force: true });
