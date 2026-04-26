import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  shell,
  systemPreferences
} from "electron";
import { ConfigStore } from "./config-store.js";
import { HostService } from "./service/host-service.js";
import { generateToken } from "./service/token.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const codexBinaryPath = "/Applications/Codex.app/Contents/Resources/codex";
const hostIconPath = path.join(__dirname, "..", "assets", "codex-icon.png");

let mainWindow = null;
let configStore = null;
let hostService = null;
let accessibilityPromptShown = false;

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

function mapCodexStatus() {
  return existsSync(codexBinaryPath) ? "可用" : "未找到";
}

function buildRendererState() {
  const config = configStore.get();
  const addresses = getPrimaryAddress();
  const serviceState = hostService.getState();

  return {
    config,
    addresses,
    serviceState,
    codexStatus:
      serviceState.status === "running" && serviceState.codexReady
        ? "已连接"
        : mapCodexStatus()
  };
}

function sendStateUpdate() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.webContents.send("state:updated", buildRendererState());
}

function hasAccessibilityPermission(prompt = false) {
  if (process.platform !== "darwin") {
    return true;
  }

  return systemPreferences.isTrustedAccessibilityClient(prompt);
}

async function ensureAccessibilityPermission({ prompt = false } = {}) {
  if (process.platform !== "darwin") {
    return true;
  }

  const granted = hasAccessibilityPermission(prompt);
  if (granted || !prompt || accessibilityPromptShown) {
    return granted;
  }

  accessibilityPromptShown = true;
  const result = await dialog.showMessageBox({
    type: "warning",
    buttons: ["打开系统设置", "稍后处理"],
    defaultId: 0,
    cancelId: 1,
    title: "需要辅助功能权限",
    message: "CodeX桌面端执行 /Computer use 任务需要 macOS 辅助功能权限。",
    detail:
      "请在“系统设置 > 隐私与安全性 > 辅助功能”里启用“CodeX桌面端by.冰点零度”。完成后重新发起任务。首次发起 Computer Use 时，系统还会对自动化控制弹出单独授权。 "
  });

  if (result.response === 0) {
    await shell.openExternal("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility");
  }

  return granted;
}

async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 760,
    minWidth: 900,
    minHeight: 680,
    backgroundColor: "#f4efe4",
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false
    },
    title: "CodeX桌面端by.冰点零度",
    icon: hostIconPath
  });

  await mainWindow.loadFile(path.join(__dirname, "renderer/index.html"));
}

function registerIpcHandlers() {
  ipcMain.handle("app:get-state", () => buildRendererState());

  ipcMain.handle("service:start", async () => {
    await ensureAccessibilityPermission({ prompt: true });
    const config = configStore.get();
    await hostService.start(config);
    sendStateUpdate();
    return buildRendererState();
  });

  ipcMain.handle("service:stop", async () => {
    await hostService.stop();
    sendStateUpdate();
    return buildRendererState();
  });

  ipcMain.handle("token:reset", () => {
    const token = generateToken(20);
    configStore.update({ token });
    hostService.updateToken(token);
    sendStateUpdate();
    return buildRendererState();
  });

  ipcMain.handle("settings:set-launch-at-login", (_event, enabled) => {
    app.setLoginItemSettings({
      openAtLogin: Boolean(enabled)
    });
    configStore.update({
      launchAtLogin: Boolean(enabled)
    });
    sendStateUpdate();
    return buildRendererState();
  });

  ipcMain.handle("settings:set-auto-start-service", (_event, enabled) => {
    configStore.update({
      autoStartService: Boolean(enabled)
    });
    sendStateUpdate();
    return buildRendererState();
  });

  ipcMain.handle("settings:set-bypass-permissions", async (_event, enabled) => {
    const bypassPermissions = Boolean(enabled);
    configStore.update({
      bypassPermissions
    });
    await hostService.updateBypassPermissions(bypassPermissions);
    sendStateUpdate();
    return buildRendererState();
  });

  ipcMain.handle("clipboard:copy", (_event, value) => {
    clipboard.writeText(value);
    return true;
  });
}

async function bootstrap() {
  await app.whenReady();

  if (process.platform === "darwin" && existsSync(hostIconPath)) {
    app.dock.setIcon(hostIconPath);
  }

  configStore = new ConfigStore({ app });
  hostService = new HostService({
    bypassPermissions: configStore.get().bypassPermissions,
    autoApprove: configStore.get().autoApprove,
    onWorkspacePathChange: (workspacePath) => {
      configStore.update({ workspacePath });
    }
  });

  const loginSettings = app.getLoginItemSettings();
  if (configStore.get().launchAtLogin !== loginSettings.openAtLogin) {
    app.setLoginItemSettings({
      openAtLogin: configStore.get().launchAtLogin
    });
  }

  hostService.on("state-changed", () => {
    sendStateUpdate();
  });

  registerIpcHandlers();
  await createWindow();
  await ensureAccessibilityPermission({ prompt: true });

  if (configStore.get().autoStartService) {
    try {
      await hostService.start(configStore.get());
      sendStateUpdate();
    } catch {
      sendStateUpdate();
    }
  }

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      await createWindow();
    }
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
