const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("closeDialog", {
  choose: (action) => ipcRenderer.invoke("close-dialog:choose", action)
});
