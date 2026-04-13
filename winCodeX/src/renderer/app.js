const statusMap = {
  stopped: "未启动",
  starting: "启动中",
  running: "运行中",
  stopping: "停止中",
  error: "连接异常"
};

const elements = {
  badge: document.getElementById("service-status-badge"),
  primaryAddress: document.getElementById("primary-address"),
  allAddresses: document.getElementById("all-addresses"),
  port: document.getElementById("port-value"),
  portInput: document.getElementById("port-input"),
  tokenValue: document.getElementById("token-value"),
  serviceStatusText: document.getElementById("service-status-text"),
  codexStatus: document.getElementById("codex-status"),
  clientCount: document.getElementById("client-count"),
  pendingApprovals: document.getElementById("pending-approvals"),
  workspacePath: document.getElementById("workspace-path"),
  errorMessage: document.getElementById("error-message"),
  startButton: document.getElementById("start-button"),
  stopButton: document.getElementById("stop-button"),
  resetTokenButton: document.getElementById("reset-token-button"),
  savePortButton: document.getElementById("save-port-button"),
  copyTokenButton: document.getElementById("copy-token-button"),
  toggleTokenButton: document.getElementById("toggle-token-button"),
  launchAtLoginToggle: document.getElementById("launch-at-login-toggle"),
  autoStartServiceToggle: document.getElementById("auto-start-service-toggle"),
  bypassPermissionsToggle: document.getElementById("bypass-permissions-toggle"),
  codexPathValue: document.getElementById("codex-path-value"),
  codexPathSource: document.getElementById("codex-path-source"),
  codexPathStatus: document.getElementById("codex-path-status"),
  codexPathInput: document.getElementById("codex-path-input"),
  saveCodexPathButton: document.getElementById("save-codex-path-button"),
  browseCodexPathButton: document.getElementById("browse-codex-path-button"),
  resetCodexPathButton: document.getElementById("reset-codex-path-button")
};

let currentState = null;
let tokenVisible = false;

function showRendererError(message) {
  elements.errorMessage.textContent = message;
}

async function runAction(action) {
  try {
    const nextState = await action();
    if (nextState) {
      render(nextState);
    }
  } catch (error) {
    showRendererError(error?.message || "操作失败");
  }
}

function renderToken(token) {
  if (tokenVisible) {
    return token;
  }

  return "•".repeat(token.length);
}

function render(state) {
  currentState = state;
  const statusText = statusMap[state.serviceState.status] || state.serviceState.status;
  const host = state.addresses.primaryAddress;
  const addressList = state.addresses.allAddresses;

  elements.badge.textContent = statusText;
  elements.badge.dataset.status = state.serviceState.status;
  elements.primaryAddress.textContent = host;
  elements.allAddresses.textContent = addressList.join(" / ");
  elements.port.textContent = String(state.config.port);
  elements.portInput.value = String(state.config.port);
  elements.tokenValue.textContent = renderToken(state.config.token);
  elements.serviceStatusText.textContent = statusText;
  elements.codexStatus.textContent = state.codexStatus;
  elements.clientCount.textContent = String(state.serviceState.clientCount);
  elements.pendingApprovals.textContent = String(state.serviceState.pendingApprovals);
  elements.workspacePath.textContent = state.serviceState.workspacePath || state.config.workspacePath || "--";
  elements.errorMessage.textContent = state.serviceState.errorMessage || state.codexInfo.errorMessage || "无";
  elements.launchAtLoginToggle.checked = Boolean(state.config.launchAtLogin);
  elements.autoStartServiceToggle.checked = Boolean(state.config.autoStartService);
  elements.bypassPermissionsToggle.checked = Boolean(state.config.bypassPermissions);
  elements.codexPathValue.textContent = state.codexInfo.path || "--";
  elements.codexPathSource.textContent = state.codexInfo.sourceLabel;
  elements.codexPathStatus.textContent = state.codexInfo.statusLabel;
  elements.codexPathInput.value = state.config.codexBinaryPath || "";

  elements.startButton.disabled = state.serviceState.status === "running" || state.serviceState.status === "starting";
  elements.stopButton.disabled = state.serviceState.status === "stopped" || state.serviceState.status === "stopping";
}

async function refreshState() {
  if (!window.hostApp) {
    showRendererError("未连接到主进程，请重启 CodeX 桌面端。");
    return;
  }

  const nextState = await window.hostApp.getState();
  render(nextState);
}

elements.startButton.addEventListener("click", () => runAction(() => window.hostApp.startService()));

elements.stopButton.addEventListener("click", () => runAction(() => window.hostApp.stopService()));

elements.savePortButton.addEventListener("click", () =>
  runAction(() => window.hostApp.setPort(elements.portInput.value))
);

elements.portInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter") {
    return;
  }

  event.preventDefault();
  runAction(() => window.hostApp.setPort(elements.portInput.value));
});

elements.copyTokenButton.addEventListener("click", async () => {
  if (!currentState) {
    return;
  }

  await window.hostApp.copyText(currentState.config.token);
});

elements.toggleTokenButton.addEventListener("click", () => {
  if (!currentState) {
    return;
  }

  tokenVisible = !tokenVisible;
  elements.toggleTokenButton.textContent = tokenVisible ? "隐藏令牌" : "显示令牌";
  elements.tokenValue.textContent = renderToken(currentState.config.token);
});

elements.resetTokenButton.addEventListener("click", async () => {
  const confirmed = window.confirm("确定要重置访问令牌吗？重置后，已连接设备会立即断开。");
  if (!confirmed) {
    return;
  }

  await runAction(() => window.hostApp.resetToken());
});

elements.launchAtLoginToggle.addEventListener("change", (event) =>
  runAction(() => window.hostApp.setLaunchAtLogin(event.target.checked))
);

elements.autoStartServiceToggle.addEventListener("change", (event) =>
  runAction(() => window.hostApp.setAutoStartService(event.target.checked))
);

elements.bypassPermissionsToggle.addEventListener("change", (event) =>
  runAction(() => window.hostApp.setBypassPermissions(event.target.checked))
);

elements.saveCodexPathButton.addEventListener("click", () =>
  runAction(() => window.hostApp.setCodexBinaryPath(elements.codexPathInput.value))
);

elements.browseCodexPathButton.addEventListener("click", () =>
  runAction(async () => {
    const selectedPath = await window.hostApp.pickCodexBinaryPath();
    if (!selectedPath) {
      return null;
    }

    elements.codexPathInput.value = selectedPath;
    return window.hostApp.setCodexBinaryPath(selectedPath);
  })
);

elements.resetCodexPathButton.addEventListener("click", () =>
  runAction(() => window.hostApp.resetCodexBinaryPath())
);

if (window.hostApp) {
  window.hostApp.onStateUpdated((state) => {
    render(state);
  });
}

refreshState();
