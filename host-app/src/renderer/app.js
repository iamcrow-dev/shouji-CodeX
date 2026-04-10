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
  tokenValue: document.getElementById("token-value"),
  serviceStatusText: document.getElementById("service-status-text"),
  codexStatus: document.getElementById("codex-status"),
  clientCount: document.getElementById("client-count"),
  pendingApprovals: document.getElementById("pending-approvals"),
  errorMessage: document.getElementById("error-message"),
  startButton: document.getElementById("start-button"),
  stopButton: document.getElementById("stop-button"),
  resetTokenButton: document.getElementById("reset-token-button"),
  copyAddressButton: document.getElementById("copy-address-button"),
  copyTokenButton: document.getElementById("copy-token-button"),
  toggleTokenButton: document.getElementById("toggle-token-button"),
  launchAtLoginToggle: document.getElementById("launch-at-login-toggle"),
  autoStartServiceToggle: document.getElementById("auto-start-service-toggle"),
  bypassPermissionsToggle: document.getElementById("bypass-permissions-toggle")
};

let currentState = null;
let tokenVisible = false;

function showRendererError(message) {
  elements.errorMessage.textContent = message;
  elements.codexStatus.textContent = "界面接入异常";
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
  const addressList = state.addresses.allAddresses.map((address) => `${address}:${state.config.port}`);

  elements.badge.textContent = statusText;
  elements.badge.dataset.status = state.serviceState.status;
  elements.primaryAddress.textContent = `${host}:${state.config.port}`;
  elements.allAddresses.textContent = addressList.join(" / ");
  elements.port.textContent = String(state.config.port);
  elements.tokenValue.textContent = renderToken(state.config.token);
  elements.serviceStatusText.textContent = statusText;
  elements.codexStatus.textContent = state.codexStatus;
  elements.clientCount.textContent = String(state.serviceState.clientCount);
  elements.pendingApprovals.textContent = String(state.serviceState.pendingApprovals);
  elements.errorMessage.textContent = state.serviceState.errorMessage || "无";
  elements.launchAtLoginToggle.checked = Boolean(state.config.launchAtLogin);
  elements.autoStartServiceToggle.checked = Boolean(state.config.autoStartService);
  elements.bypassPermissionsToggle.checked = Boolean(state.config.bypassPermissions);

  elements.startButton.disabled = state.serviceState.status === "running" || state.serviceState.status === "starting";
  elements.stopButton.disabled = state.serviceState.status === "stopped" || state.serviceState.status === "stopping";
}

async function refreshState() {
  if (!window.hostApp) {
    showRendererError("未连接到主进程，请重启 CodeX桌面端by.冰点零度。");
    return;
  }

  const nextState = await window.hostApp.getState();
  render(nextState);
}

elements.startButton.addEventListener("click", async () => {
  await window.hostApp.startService();
});

elements.stopButton.addEventListener("click", async () => {
  await window.hostApp.stopService();
});

elements.copyAddressButton.addEventListener("click", async () => {
  if (!currentState) {
    return;
  }

  const value = `${currentState.addresses.primaryAddress}:${currentState.config.port}`;
  await window.hostApp.copyText(value);
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

  await window.hostApp.resetToken();
});

elements.launchAtLoginToggle.addEventListener("change", async (event) => {
  await window.hostApp.setLaunchAtLogin(event.target.checked);
});

elements.autoStartServiceToggle.addEventListener("change", async (event) => {
  await window.hostApp.setAutoStartService(event.target.checked);
});

elements.bypassPermissionsToggle.addEventListener("change", async (event) => {
  await window.hostApp.setBypassPermissions(event.target.checked);
});

if (window.hostApp) {
  window.hostApp.onStateUpdated((state) => {
    render(state);
  });
}

refreshState();
