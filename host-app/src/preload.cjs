const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("hostApp", {
  getState: () => ipcRenderer.invoke("app:get-state"),
  startService: () => ipcRenderer.invoke("service:start"),
  stopService: () => ipcRenderer.invoke("service:stop"),
  resetToken: () => ipcRenderer.invoke("token:reset"),
  setLaunchAtLogin: (enabled) => ipcRenderer.invoke("settings:set-launch-at-login", enabled),
  setAutoStartService: (enabled) => ipcRenderer.invoke("settings:set-auto-start-service", enabled),
  setBypassPermissions: (enabled) => ipcRenderer.invoke("settings:set-bypass-permissions", enabled),
  copyText: (value) => ipcRenderer.invoke("clipboard:copy", value),
  onStateUpdated: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on("state:updated", listener);
    return () => ipcRenderer.removeListener("state:updated", listener);
  }
});
