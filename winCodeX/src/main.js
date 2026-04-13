import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  Tray
} from "electron";
import { ConfigStore } from "./config-store.js";
import { HostService } from "./service/host-service.js";
import { resolveCodexBinary } from "./service/codex-path.js";
import { ensureValidPort } from "./service/port.js";
import { generateToken } from "./service/token.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const hostIconPath = path.join(
  __dirname,
  "..",
  "assets",
  process.platform === "win32" ? "codex-icon.ico" : "codex-icon.png"
);

let mainWindow = null;
let closePromptWindow = null;
let appTray = null;
let configStore = null;
let hostService = null;
let codexInfoCache = null;
let codexInfoCacheKey = "";
let isQuitting = false;

function getLoginItemSettingsOptions(openAtLogin) {
  const baseOptions = {
    openAtLogin: Boolean(openAtLogin)
  };

  if (process.platform !== "win32") {
    return baseOptions;
  }

  // Portable builds run from a temp-unpacked executable, so launch at login
  // should point back to the outer portable .exe when available.
  const portableExecutablePath =
    process.env.PORTABLE_EXECUTABLE_FILE ||
    process.env.PORTABLE_EXECUTABLE_DIR && process.env.PORTABLE_EXECUTABLE_APP_FILENAME
      ? path.join(
          process.env.PORTABLE_EXECUTABLE_DIR,
          process.env.PORTABLE_EXECUTABLE_APP_FILENAME
        )
      : "";

  return {
    ...baseOptions,
    path: portableExecutablePath || process.execPath,
    args: []
  };
}

function getPrimaryAddress() {
  const interfaces = os.networkInterfaces();
  const addresses = [];

  for (const entries of Object.values(interfaces)) {
    for (const item of entries || []) {
      if (item.family === "IPv4" && !item.internal) {
        addresses.push(item.address);
      }
    }
  }

  return {
    primaryAddress: addresses[0] || "127.0.0.1",
    allAddresses: addresses.length > 0 ? addresses : ["127.0.0.1"]
  };
}

async function getCodexInfo({ force = false, configuredPath } = {}) {
  const nextConfiguredPath =
    typeof configuredPath === "string" ? configuredPath.trim() : configStore?.get().codexBinaryPath?.trim() || "";

  if (!force && codexInfoCache && codexInfoCacheKey === nextConfiguredPath) {
    return codexInfoCache;
  }

  const resolved = await resolveCodexBinary({
    configuredPath: nextConfiguredPath
  });
  codexInfoCache = resolved;
  codexInfoCacheKey = nextConfiguredPath;
  return resolved;
}

async function buildRendererState() {
  const config = configStore.get();
  const addresses = getPrimaryAddress();
  const serviceState = hostService.getState();
  const codexInfo = await getCodexInfo();

  return {
    config,
    addresses,
    serviceState,
    codexInfo,
    codexStatus:
      serviceState.status === "running" && serviceState.codexReady
        ? "已连接"
        : codexInfo.statusLabel
  };
}

async function sendStateUpdate(prebuiltState = null) {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return prebuiltState;
  }

  const nextState = prebuiltState || (await buildRendererState());
  mainWindow.webContents.send("state:updated", nextState);
  return nextState;
}

async function resolveCodexForServiceStart() {
  const codexInfo = await getCodexInfo({ force: true });
  if (!codexInfo.ok) {
    throw new Error(codexInfo.errorMessage);
  }

  return codexInfo;
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1098,
    height: 760,
    minWidth: 1008,
    minHeight: 680,
    backgroundColor: "#f4efe4",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    },
    title: "win\u684c\u9762CodeX",
    icon: hostIconPath
  });

  if (process.platform === "win32") {
    mainWindow.on("close", async (event) => {
      if (isQuitting) {
        return;
      }

      event.preventDefault();
      await showClosePrompt();
    });
  }

  await mainWindow.loadFile(path.join(__dirname, "renderer/index.html"));
}

async function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    await createWindow();
    await sendStateUpdate();
    return;
  }

  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.setSkipTaskbar(false);
  mainWindow.show();
  mainWindow.focus();
}

function hideMainWindowToTray() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.setSkipTaskbar(true);
  mainWindow.hide();
}

async function quitApplication() {
  isQuitting = true;

  if (closePromptWindow && !closePromptWindow.isDestroyed()) {
    closePromptWindow.destroy();
  }
  closePromptWindow = null;

  app.quit();
}

function ensureTray() {
  if (process.platform !== "win32" || appTray) {
    return;
  }

  appTray = new Tray(hostIconPath);
  appTray.setToolTip("win\u684c\u9762CodeX");
  appTray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "显示窗口",
        click: () => {
          showMainWindow();
        }
      },
      {
        label: "退出",
        click: () => {
          quitApplication();
        }
      }
    ])
  );

  appTray.on("click", () => {
    showMainWindow();
  });
}

async function showClosePrompt() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  if (closePromptWindow && !closePromptWindow.isDestroyed()) {
    closePromptWindow.focus();
    return;
  }

  closePromptWindow = new BrowserWindow({
    width: 360,
    height: 255,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    modal: true,
    parent: mainWindow,
    frame: false,
    show: false,
    skipTaskbar: true,
    backgroundColor: "#f4efe4",
    webPreferences: {
      preload: path.join(__dirname, "close-confirm-preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  closePromptWindow.on("closed", () => {
    closePromptWindow = null;
  });

  closePromptWindow.once("ready-to-show", () => {
    closePromptWindow?.show();
    closePromptWindow?.focus();
  });
  await closePromptWindow.loadFile(path.join(__dirname, "renderer/close-confirm.html"));
}

async function applyCodexBinaryPath(configuredPath) {
  const normalizedPath = String(configuredPath || "").trim();
  const codexInfo = await getCodexInfo({
    force: true,
    configuredPath: normalizedPath
  });

  if (!codexInfo.ok) {
    throw new Error(codexInfo.errorMessage);
  }

  configStore.update({
    codexBinaryPath: normalizedPath
  });
  await hostService.updateCodexBinaryPath(codexInfo.path);
  return sendStateUpdate();
}

async function applyPort(portValue) {
  const nextPort = ensureValidPort(portValue);
  const serviceWasRunning = hostService.getState().status === "running";
  const codexInfo = serviceWasRunning ? await resolveCodexForServiceStart() : null;

  configStore.update({
    port: nextPort
  });

  if (serviceWasRunning) {
    await hostService.stop();
    await hostService.start({
      ...configStore.get(),
      codexBinaryPath: codexInfo.path
    });
  }

  return sendStateUpdate();
}

function registerIpcHandlers() {
  ipcMain.handle("app:get-state", () => buildRendererState());

  ipcMain.handle("service:start", async () => {
    const config = configStore.get();
    const codexInfo = await resolveCodexForServiceStart();
    await hostService.start({
      ...config,
      codexBinaryPath: codexInfo.path
    });
    return sendStateUpdate();
  });

  ipcMain.handle("service:stop", async () => {
    await hostService.stop();
    return sendStateUpdate();
  });

  ipcMain.handle("token:reset", async () => {
    const token = generateToken(20);
    configStore.update({ token });
    hostService.updateToken(token);
    return sendStateUpdate();
  });

  ipcMain.handle("settings:set-launch-at-login", async (_event, enabled) => {
    app.setLoginItemSettings(getLoginItemSettingsOptions(enabled));
    configStore.update({
      launchAtLogin: Boolean(enabled)
    });
    return sendStateUpdate();
  });

  ipcMain.handle("settings:set-auto-start-service", async (_event, enabled) => {
    configStore.update({
      autoStartService: Boolean(enabled)
    });
    return sendStateUpdate();
  });

  ipcMain.handle("settings:set-port", async (_event, portValue) => {
    return applyPort(portValue);
  });

  ipcMain.handle("settings:set-bypass-permissions", async (_event, enabled) => {
    const bypassPermissions = Boolean(enabled);
    configStore.update({
      bypassPermissions
    });
    await hostService.updateBypassPermissions(bypassPermissions);
    return sendStateUpdate();
  });

  ipcMain.handle("settings:set-codex-binary-path", async (_event, configuredPath) => {
    return applyCodexBinaryPath(configuredPath);
  });

  ipcMain.handle("settings:reset-codex-binary-path", async () => {
    return applyCodexBinaryPath("");
  });

  ipcMain.handle("settings:pick-codex-binary-path", async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ["openFile"],
      filters:
        process.platform === "win32"
          ? [{ name: "Codex Executable", extensions: ["exe"] }]
          : [{ name: "All Files", extensions: ["*"] }]
    });

    if (result.canceled || result.filePaths.length === 0) {
      return "";
    }

    return result.filePaths[0];
  });

  ipcMain.handle("clipboard:copy", (_event, value) => {
    clipboard.writeText(value);
    return true;
  });

  ipcMain.handle("close-dialog:choose", async (_event, action) => {
    if (action === "tray") {
      if (closePromptWindow && !closePromptWindow.isDestroyed()) {
        closePromptWindow.close();
      }
      hideMainWindowToTray();
      return true;
    }

    if (action === "exit") {
      await quitApplication();
      return true;
    }

    return false;
  });
}

async function bootstrap() {
  await app.whenReady();

  if (process.platform === "darwin") {
    app.dock.setIcon(hostIconPath);
  }

  configStore = new ConfigStore({ app });
  const initialCodexInfo = await getCodexInfo({ force: true });
  hostService = new HostService({
    codexBinaryPath: initialCodexInfo.ok ? initialCodexInfo.path : "",
    bypassPermissions: configStore.get().bypassPermissions,
    autoApprove: configStore.get().autoApprove,
    deletedThreadIds: configStore.get().deletedThreadIds,
    onDeletedThreadIdsChange: (deletedThreadIds) => {
      configStore.update({ deletedThreadIds });
    },
    getFallbackWorkspacePath: () => configStore.get().workspacePath,
    onWorkspacePathChange: (workspacePath) => {
      configStore.update({ workspacePath });
    }
  });

  const loginSettings = app.getLoginItemSettings(
    getLoginItemSettingsOptions(configStore.get().launchAtLogin)
  );
  if (configStore.get().launchAtLogin !== loginSettings.openAtLogin) {
    app.setLoginItemSettings(
      getLoginItemSettingsOptions(configStore.get().launchAtLogin)
    );
  }

  hostService.on("state-changed", () => {
    sendStateUpdate();
  });

  registerIpcHandlers();
  await createWindow();
  ensureTray();

  if (configStore.get().autoStartService) {
    try {
      const codexInfo = await resolveCodexForServiceStart();
      await hostService.start({
        ...configStore.get(),
        codexBinaryPath: codexInfo.path
      });
      await sendStateUpdate();
    } catch {
      await sendStateUpdate();
    }
  }

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
      return;
    }

    await showMainWindow();
  });
}

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

app.on("before-quit", async (event) => {
  if (!hostService || hostService.getState().status === "stopped") {
    return;
  }

  event.preventDefault();
  await hostService.stop();
  app.exit(0);
});

bootstrap();
