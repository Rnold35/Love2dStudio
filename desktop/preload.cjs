const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("love2dDesktop", {
  isDesktop: true,
  platform: process.platform,
  selectDirectory: (options) => ipcRenderer.invoke("desktop:select-directory", options || {}),
  selectFile: (options) => ipcRenderer.invoke("desktop:select-file", options || {}),
  info: () => ipcRenderer.invoke("desktop:info"),
  gamePreview: {
    attach: (options) => ipcRenderer.invoke("desktop:game-preview-attach", options || {}),
    setBounds: (options) => ipcRenderer.invoke("desktop:game-preview-bounds", options || {}),
    setVisible: (visible) => ipcRenderer.invoke("desktop:game-preview-visibility", { visible: Boolean(visible) })
  }
});
