# Love2D Studio

A desktop visual editor for [LÖVE](https://love2d.org/) games, with a built-in
DeepSeek assistant and optional script editing/agent support in
[Zed](https://zed.dev/).

Love2D Studio provides two connected surfaces:

- **Love2D Studio Desktop** — the native editor: project wizard, scene/level
  canvas, asset browser, **read-only Scripts workspace**, inspector,
  **in-editor game preview**, live game console, **Build & Export**, setup, and
  a built-in **AI chat drawer** that can inspect, edit, and run the project.
- **Zed** — the code editor. Generated projects include Zed tasks and the
  **Love2D Assistant** ACP agent, backed by the same DeepSeek API key.

![Love2D Studio icon](desktop/icon.png)

## Quick start

### Run the built desktop app

```text
D:\project\Love2dEditor\dist\Love2D Studio-win32-x64\Love2D Studio.exe
```

or double-click:

```text
D:\project\Love2dEditor\Love2D Studio.cmd
```

A distributable ZIP can be created from the packaged folder:

```powershell
tar -a -c -f "dist\Love2D-Studio-0.1.0-win64.zip" -C "dist" "Love2D Studio-win32-x64"
```

Using `tar.exe` keeps ZIP paths standard (`/`) so the release extracts cleanly on
other platforms. The current build is also available at
`dist\Love2D-Studio-0.1.0-win64.zip`.

The packaged build is self-contained for the editor. Zed, LÖVE, and Node.js are
still needed for script editing, running games, and the AI agent. The desktop
build uses native folder/file pickers and does not require a browser.

### First project

1. Open the desktop app.
2. Click **New project**.
3. Choose the starter platformer or empty template, a location, and a window size.
4. Design the scene in the Studio.
5. Click **Run** to play the game inside the Studio, or **Open in Zed** to edit code.
6. Click the **AI** button for the built-in assistant.
7. Click **Build** to export a playable Windows build or a portable `.love` file.

Opening an existing Love2D folder is supported as well. The Studio adds its
scene runtime and Zed integration files if they are missing; it does not overwrite
an existing `main.lua`.

## Requirements

- Windows 10/11 (the packaged target).
- LÖVE 11.5 installed. `C:\Program Files\LOVE\lovec.exe` is detected automatically;
  `love.exe` works too, but `lovec.exe` gives the most reliable console bridge.
- A DeepSeek API key for the built-in chat and the Zed agent.
- [Node.js](https://nodejs.org/) 20+ for development, packaging, the Zed agent,
  and the browser fallback. The packaged desktop AI chat does not need a separate
  Node installation.
- Zed 1.29+ if you want code editing or the ACP assistant there.

## Setup

The app's **Setup** panel is reachable from the welcome screen and the gear icon.
It manages:

- **DeepSeek API key** — used by the desktop AI chat and the Love2D Assistant in Zed.
- **Model** — defaults to `deepseek-flash`; `deepseek-v4-pro` is also accepted.
- **API base URL** — defaults to `https://api.deepseek.com`.
- **Zed agent and LÖVE snippets** — one-click installation into Zed's user settings.
- **LÖVE executable** — auto-detected, with a native file picker.
- **Projects folder** — the default location for the project wizard.

Get a DeepSeek key at <https://platform.deepseek.com/api_keys>. The key is stored
in the local Studio config, never in a game project:

```text
%APPDATA%\Love2D Studio\config.json
```

You can also set `DEEPSEEK_API_KEY` in the environment. Both the desktop chat and
the Zed agent check the environment before the Studio config.

After installing the Zed integration, restart Zed, open the Agent panel, choose
**+ → External Agents → Love2D Assistant**, and send a prompt. The desktop AI
chat works without Zed.

## Desktop AI assistant

Click **AI** in the desktop toolbar (or the AI rail button). The drawer streams
DeepSeek responses and shows tool activity, reasoning, and approval requests.

The assistant is project-aware and can:

- inspect files, search code, and review scenes/assets
- generate modular Lua projects across multiple files and folders
- look up functions through a persistent Lua index without rereading whole scripts
- save durable project decisions and preferences to persistent project memory
- create or replace Studio scenes with schema validation
- run a short LÖVE smoke test and read its output
- ask clarifying questions as clickable 2–4 option cards instead of plain text

When the assistant needs you to choose a direction—menu style, animation feel,
scene layout, or implementation approach—it uses an interactive question card.
Pick an option and the assistant continues with that choice. The question and
your selection stay in the chat transcript.

Every write and game run shows an approval card first. **Allow once**,
**Always allow** for the current chat, and **Deny** are supported. The agent can
only access the current project, and scene edits refresh the open canvas when it
is safe to do so.

Chat history is kept in memory for the current Studio backend session. It resets
when you start a new chat, switch projects, or restart the app. Use the refresh
button in the drawer header for a new conversation. Persistent project memory and
the Lua code index are separate from chat history and survive new chats and
restarts.

The chat transcript scrolls independently. Auto-follow pauses when you scroll up,
so you can read earlier messages while a response is still streaming.

If a reasoning-heavy response consumes the model's output budget without making
files, the Studio shows a status note and retries once with an action-focused
prompt. If the retry still produces no answer, an explicit error explains what
happened instead of leaving the message hanging on “Thinking.”

The same tool layer is exposed through the Zed ACP agent, so the assistant
behaves consistently in both surfaces.

## In-editor game preview

In the desktop app on Windows, **Run** starts the real LÖVE game and places its
window in the Studio stage instead of opening a separate game window. The live
console and approval-based tools keep working while the preview is open.

- Click the game area once to give LÖVE keyboard focus.
- The preview preserves the game window aspect ratio and configured resolution
  from `conf.lua`. It does not enlarge the game beyond its designed window size;
  it is centered on a distinct letterbox backdrop and only scales down when the
  editor panel is smaller than the game.
- The preview follows Studio window moves, resizes, and console size changes.
- The game stays visible beside the AI drawer when the two do not overlap. A
  Studio dialog, or a panel that actually covers the preview, temporarily hides
  the native game window and shows a short explanation; closing or resizing the
  overlay brings it back.
- Click **Stop** in the preview header, the top toolbar, or the console to return
  to the scene editor.
- If native embedding fails, the game continues in its own LÖVE window and a
  warning explains the fallback.

The browser fallback opens games in a normal LÖVE window. The embedded preview is
a Windows desktop feature because it uses Win32 window ownership.

## Assets and drag-and-drop

Open the **Assets** tab to browse project images, audio, and fonts.

- Drag files from Windows Explorer into the Assets panel to import them. Images,
  audio, and fonts go into `assets/images`, `assets/audio`, and `assets/fonts`.
- Drag an image asset from the panel onto the scene canvas to create a sprite
  where you drop it.
- Select a sprite, then drag an image asset into the inspector's **Asset path**
  field to replace that sprite's image without changing its position or size.
- Click an image asset to use it as a placement brush, then click the canvas to
  place it.

Imports keep the original file name and add a numeric suffix instead of
overwriting an existing asset.

## Gameplay properties

Select an entity, then use the **Gameplay** section of the inspector to add
custom properties. Each property has a name, a type (**Number**, **Text**, or
**On/off**), and a value. They are stored on the entity in the scene JSON:

```json
"properties": {
  "playerSpeed": 260,
  "invulnerable": false,
  "label": "Player"
}
```

Read them from Lua with a fallback and clamping:

```lua
local speed = tonumber(player.properties and player.properties.playerSpeed) or 260
speed = math.max(20, math.min(speed, 2000))
```

The Studio only supports primitive property values (number, string, boolean);
nested objects are ignored when the scene is saved. Pressing **R** while the
game is running reloads the scene and reapplies edited properties.

## Scripts workspace

The **Scripts** tab in the desktop Studio lists every Lua module in the project,
including files created by the AI. Selecting a module opens a read-only code
viewer with line numbers and a function/symbol count. Use **Copy** or **Open in
Zed** to continue editing.

Scripts written by the AI are refreshed in the list automatically when its tools
finish. The visual scene canvas remains focused on scene JSON entities; code is
shown here or in Zed rather than being mixed into the canvas.

## Project memory and modular code

The assistant is instructed to keep `main.lua` small and split substantial work
into focused Lua modules under folders such as:

```text
main.lua
conf.lua
src/game.lua
src/player.lua
src/enemies/enemy.lua
src/world/map.lua
src/ui/menu.lua
src/ui/settings.lua
src/systems/audio.lua
```

It uses a batch **write_files** tool to scaffold several modules in one approved
operation, then `edit_file` for focused changes.

Two persistent files support long-running projects:

```text
.love2d-studio/ai/index.json    generated Lua module/function index
.love2d-studio/ai/memory.md     durable AI notes
```

The index records every Lua module, function, method, line number, documentation
comment, and `require` dependency. It refreshes automatically when Lua files
change. A compact architecture outline is included in the assistant's system
context, and the `code_index` / `read_symbol` tools retrieve details or a single
function body without loading entire files.

The assistant can call `remember` to append durable decisions and conventions to
`memory.md`. That memory is loaded into new chats and after restarts. These files
are editor-local metadata and are excluded from game builds. The generated project
`.gitignore` also ignores `.love2d-studio/ai/`.

## Build & export

The **Build** button in the Studio toolbar opens a small export dialog with three
targets:

- **Windows ZIP** (recommended) — a playable folder plus a ZIP you can share.
- **Windows folder** — a fused `.exe` with the LÖVE runtime and DLLs.
- **Portable .love** — a single archive for players who already have LÖVE.

The output folder defaults to `<project>/build` and can be changed with the native
folder picker. Builds never overwrite an earlier artifact; another build gets a
`-2`, `-3`, … suffix.

For Windows builds, the Studio uses the installed `love.exe` and its DLLs. It
creates `<Game>.exe` by appending the project ZIP to the LÖVE executable (LÖVE's
fused-game format), then copies the runtime DLLs and `license.txt`. The original
`love.exe` is not needed by players. The exported game uses LÖVE's standard
executable icon.

The project ZIP contains the game source (Lua files, `scenes/`, `assets/`, and
the `studio/` runtime). It excludes editor metadata and development files:

```text
.zed/  .git/  .love2d-studio/  node_modules/  build/  dist/
.testprojects/  .research/  runtime logs and caches
.luarc.json  .rules  .env / keys  OS junk
```

Scenes are saved before a build, so the export includes the current canvas state.
The portable `.love` format does not require LÖVE to create, but players need
LÖVE 11.5 installed. Windows formats require the graphical `love.exe` (not only
`lovec.exe`) and its DLLs.

## Zed integration

Each generated project gets:

```text
.zed/tasks.json       Love2D: Run Game
                      Love2D: Open Studio
                      Love2D: New Project
                      Love2D: Open Studio in Browser
.zed/settings.json    Lua editing conventions
.zed/keymap.json      Alt+R, Alt+Shift+S
.luarc.json           LuaCATS LÖVE definitions and LuaJIT runtime
.rules                Love2D conventions for AI assistants
```

Project tasks are active after the project is trusted in Zed. The **Love2D: Open
Studio** task launches the desktop app with the project path. If the desktop app
is unavailable, use **Love2D: Open Studio in Browser**.

The Zed agent is a custom ACP (Agent Client Protocol) server. It is registered in
Zed's user settings under `agent_servers` and uses a standalone Node executable,
not the Electron runtime. Its tools can:

- inspect project files, search text, and read scenes/assets
- write files or edit text with a diff and an explicit permission prompt
- create/replace Studio scenes with schema validation
- run the game for a short smoke test, capture console output, then stop it

Both AI surfaces are project-scoped and restrict file tools to the project root
(plus any additional directories Zed includes). Writes and game runs require
approval; reads do not.

## Development

```powershell
npm install
npm start                 # Electron desktop app in development
npm run studio            # browser version / embedded server fallback
npm run package           # build dist/Love2D Studio-win32-x64/
npm test                  # Node/ACP/project tests
```

Development desktop launch:

```powershell
npm start -- --project "D:\path\to\project"
npm start -- --new
```

Packaged launch:

```powershell
& ".\dist\Love2D Studio-win32-x64\Love2D Studio.exe" --project "D:\path\to\project"
```

The desktop app:

- starts a local Studio backend on `127.0.0.1` (port 4317 by default)
- reuses an already-running Studio backend instead of duplicating it
- uses a single-instance lock, so opening another project focuses the existing window
- loads the editor in an Electron window with `contextIsolation` enabled
- exposes native folder/file dialogs through a small preload bridge
- shuts down the backend it owns when the app closes

## Project layout

```text
main.lua                  game entry point
conf.lua                  LÖVE window/module config
src/                      your Lua modules
scenes/                   visual scene JSON files
assets/                   images, audio, and fonts
studio/log.lua            console bridge for the Studio
studio/scene.lua          scene runtime for LÖVE
studio/json.lua           JSON decoder for the scene runtime
build/                    generated exports (gitignored)
.zed/                     Zed tasks, settings, and keymaps
.love2d-studio/           editor metadata, runtime logs, LuaCATS definitions
.love2d-studio/ai/        persistent Lua index and AI project memory
.rules                    project guidance for the AI assistant
```

Scenes are plain JSON:

```json
{
  "version": 1,
  "name": "main",
  "width": 960,
  "height": 600,
  "background": [0.055, 0.065, 0.085, 1],
  "entities": [
    {
      "id": "ground",
      "name": "Ground",
      "type": "rectangle",
      "x": 0,
      "y": 520,
      "w": 960,
      "h": 80,
      "rotation": 0,
      "opacity": 1,
      "layer": 10,
      "visible": true,
      "color": [0.16, 0.2, 0.26, 1],
      "fill": true,
      "properties": { "solid": true }
    }
  ]
}
```

Load them with:

```lua
local Scene = require("studio.scene")
local scene = Scene.load("main")
scene:draw()
```

The scene runtime supports `sprite`, `rectangle`, `circle`, and `text` entities.
Game code can read `properties` (the starter uses `properties.solid` for collision).

## Studio shortcuts

- `V`, `R`, `O`, `T`, `S` — select, rectangle, circle, text, sprite tools
- `Ctrl+S` — save the scene
- `Ctrl+Z` / `Ctrl+Shift+Z` — undo / redo
- `Delete` — delete the selected entity
- `Ctrl+D` — duplicate the selected entity
- Arrow keys — nudge by 1 px; `Shift` — 10 px
- Space + drag — pan; wheel — zoom
- `R` while the game is focused — reload the active scene

## Tests

The test suite covers:

- ACP initialization, streaming, tool calls, and permission-gated writes
- desktop AI selectable questions, answer continuation, and transcript state
- Lua function/module indexing, symbol reads, persistent AI memory, and batch writes
- Scripts tab listing/viewing Lua modules (manually verified in the desktop app)
- project scaffolding, scene validation/persistence, asset import/delete
- custom gameplay property editing and scene persistence (verified in the browser Studio)
- asset drag-and-drop into the Assets panel, scene canvas, and sprite path field
  (verified in the browser Studio)
- `.love` ZIP contents and development-file exclusions
- fused Windows executables, runtime DLLs, and Windows ZIP packaging
- the desktop app packaging path (manually verified)
- in-editor LÖVE preview positioning, input focus, overlay hiding, and stop
  behavior (manually verified with the desktop app)

Run:

```powershell
npm test
```

The in-app chat streaming, tool calls, write approval, and scene-canvas refresh
were also exercised end-to-end with a local mock OpenAI-compatible model and a
mock Studio project. The real DeepSeek path is not exercised in `npm test`
(it requires a live API key).

## Known limitations

- The packaged target in this repository is Windows x64. Electron can be run on
  macOS/Linux, but the packaging script targets Windows.
- The in-editor game preview uses the Windows window API. On other platforms, and
  in the browser fallback, **Run** opens the game in a separate LÖVE window.
- The game remains a real native LÖVE window, so exclusive fullscreen games or
  native game dialogs can temporarily leave the editor layout. Stop and run again
  to restore the preview.
- Exported Windows games use LÖVE's executable icon and are built for the same
  Windows architecture as the installed LÖVE runtime. Custom game icons and code
  signing are not implemented yet.
- The desktop AI chat and Zed agent both require a DeepSeek API key. The desktop
  chat history is in memory and is cleared when the backend restarts or the
  project changes.
- Zed's AI agent is launched with the system Node.js executable. Node.js is
  required for the Zed agent even when using the packaged desktop build.
- The Zed integration paths are absolute. If you move the Studio installation or
  the source folder, reinstall the agent/snippets from Setup and regenerate project
  tasks by creating a new project or updating `.zed/tasks.json`.
- Zed cannot render custom UI panels, which is why the scene/asset editor is a
  separate desktop app rather than a Zed extension.
- The Studio config stores the API key locally in plain JSON (user-profile
  permissions apply). Use `DEEPSEEK_API_KEY` if you prefer not to persist it.
- The LuaCATS definitions are downloaded from
  [LuaCATS/love2d](https://github.com/LuaCATS/love2d) when a project is created.
  A small built-in fallback is used when offline.

## Related projects and docs

- [LÖVE](https://love2d.org/) — the game framework
- [Zed](https://zed.dev/) — the editor and ACP client
- [DeepSeek API](https://platform.deepseek.com/) — the assistant's model provider
- [Agent Client Protocol](https://agentclientprotocol.com/) — editor/agent protocol
- [LuaCATS love2d](https://github.com/LuaCATS/love2d) — LÖVE type definitions

## License

MIT. See `LICENSE`.
