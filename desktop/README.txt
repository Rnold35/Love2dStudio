Love2D Studio 0.1.0

Run: Love2D Studio.exe

This is the native visual editor and built-in AI assistant for Love2D projects.

- Create or open a project, design scenes, and browse assets.
  Drag files into the Assets tab to import them, drag an image onto the canvas
  to add a sprite, or drag one into a selected sprite's Asset path field.
- Select an entity to edit its custom gameplay properties (numbers, text, or
  on/off values) in the inspector. Read them from Lua as entity.properties.key.
- Open the "Scripts" tab to read Lua files created by the AI or by hand.
  Use "Open in Zed" or Copy to continue editing.
- Click "Run" to play the real LOVE game inside the editor stage. Click the game
  once for keyboard focus; Stop returns to the scene.
- Click "AI" in the toolbar to chat with the DeepSeek assistant.
  It can create modular Lua files/folders, read/edit scenes, and run the game
  with approval. A persistent Lua index and project memory live in
  .love2d-studio/ai/. When it needs a decision, it shows clickable choice cards.
- Click "Build" to export a Windows ZIP, a playable Windows folder, or a
  portable .love file. Windows builds include the LOVE runtime DLLs.
- Requires LOVE 11.5 to run games and to create Windows exports.
- Requires Node.js only for the optional Zed ACP agent and browser fallback.
- Configure the DeepSeek API key in Setup.

Projects default to %USERPROFILE%\Documents\Love2D Projects.
Studio config is stored in %APPDATA%\Love2D Studio.

The browser fallback is available from the source project with:
  npm run studio

License: MIT
