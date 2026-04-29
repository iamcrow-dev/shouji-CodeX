import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";

const CODEX_BINARY_PATH = "/Applications/Codex.app/Contents/Resources/codex";
const MOBILE_UPLOAD_DIR = ".codex-mobile-uploads";
const MAX_THREAD_ITEMS = 330;

function summarizeUserContent(contentItems = []) {
  const textLines = [];

  for (const item of contentItems) {
    if (item.type === "text" || item.type === "input_text") {
      if (item.text) {
        textLines.push(item.text);
      }
      continue;
    }
  }

  return textLines.join("\n");
}

function extractImageSource(value) {
  if (!value) {
    return "";
  }

  if (typeof value === "string") {
    return value.trim();
  }

  if (typeof value === "object") {
    const directCandidates = [
      value.url,
      value.image_url,
      value.imageUrl,
      value.sourceUrl,
      value.src,
      value.href
    ];

    for (const candidate of directCandidates) {
      const resolved = extractImageSource(candidate);
      if (resolved) {
        return resolved;
      }
    }
  }

  return "";
}

function extractImageMimeType(sourceUrl, explicitMimeType = "") {
  if (typeof explicitMimeType === "string" && explicitMimeType.trim()) {
    return explicitMimeType.trim();
  }

  if (typeof sourceUrl !== "string" || !sourceUrl.startsWith("data:")) {
    return "";
  }

  const match = /^data:([^;,]+)/i.exec(sourceUrl);
  return match?.[1]?.trim() || "";
}

function extractUserImages(contentItems = []) {
  const images = [];

  for (const [index, item] of contentItems.entries()) {
    if (!item || typeof item !== "object") {
      continue;
    }

    if (item.type !== "input_image" && item.type !== "image") {
      continue;
    }

    const sourceUrl = extractImageSource(item);
    if (!sourceUrl) {
      continue;
    }

    images.push({
      id: item.id || `img_${index + 1}`,
      sourceUrl,
      mimeType: extractImageMimeType(
        sourceUrl,
        item.mimeType || item.mime_type || item.mediaType || item.contentType || ""
      )
    });
  }

  return images;
}

function normalizeTimestamp(value) {
  if (!value) {
    return 0;
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return 0;
  }

  return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
}

function summarizePreviewText(value) {
  if (!value || typeof value !== "string") {
    return "";
  }

  return value.replace(/\s+/g, " ").trim().slice(0, 180);
}

function normalizeThreadStatus(status, waitingApproval = false) {
  if (!status || typeof status !== "object") {
    return "idle";
  }

  if (waitingApproval) {
    return "waiting_approval";
  }

  if (status.type === "systemError") {
    return "error";
  }

  if (status.type === "active") {
    return "running";
  }

  return "idle";
}

function summarizeApproval(serverRequest) {
  if (serverRequest.method === "item/commandExecution/requestApproval") {
    return serverRequest.params.command || serverRequest.params.reason || "命令执行审批";
  }

  if (serverRequest.method === "item/fileChange/requestApproval") {
    return serverRequest.params.reason || "文件修改审批";
  }

  if (serverRequest.method === "item/tool/requestUserInput") {
    return "等待用户输入";
  }

  if (serverRequest.method === "item/tool/call") {
    return serverRequest.params.tool ? `工具调用：${serverRequest.params.tool}` : "工具调用";
  }

  if (serverRequest.method === "item/permissions/requestApproval") {
    return serverRequest.params.reason || "权限授权";
  }

  if (serverRequest.method === "mcpServer/elicitation/request") {
    return serverRequest.params.message || "MCP 交互请求";
  }

  if (serverRequest.method === "applyPatchApproval") {
    return serverRequest.params.reason || "补丁应用审批";
  }

  if (serverRequest.method === "execCommandApproval") {
    return Array.isArray(serverRequest.params.command) && serverRequest.params.command.length > 0
      ? serverRequest.params.command.join(" ")
      : serverRequest.params.reason || "命令执行审批";
  }

  if (serverRequest.method === "account/chatgptAuthTokens/refresh") {
    return "刷新 ChatGPT 授权令牌";
  }

  return "等待处理";
}

function formatApprovalOption(option) {
  if (typeof option === "string") {
    return option;
  }

  if (option && typeof option === "object") {
    return option.label || option.name || option.description || JSON.stringify(option);
  }

  return String(option ?? "");
}

function normalizeApprovalQuestions(params = {}) {
  const source = Array.isArray(params.questions)
    ? params.questions
    : Array.isArray(params.items)
      ? params.items
      : [];

  return source.map((question, index) => ({
    id: question.id || `answer_${index + 1}`,
    label: question.header || question.label || `问题 ${index + 1}`,
    prompt: question.question || question.prompt || question.text || question.label || `请输入问题 ${index + 1} 的回答`,
    options: Array.isArray(question.options) ? question.options.map(formatApprovalOption).filter(Boolean) : []
  }));
}

function summarizeFileChange(change) {
  if (!change || typeof change !== "object") {
    return "";
  }

  return change.path || change.file || change.newPath || "";
}

function truncateText(value, maxLength = 320) {
  if (typeof value !== "string") {
    return "";
  }

  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }

  return `${normalized.slice(0, maxLength).trimEnd()}…`;
}

function summarizeToolArguments(argumentsValue) {
  if (!argumentsValue) {
    return "";
  }

  if (typeof argumentsValue === "string") {
    return truncateText(argumentsValue, 220);
  }

  if (typeof argumentsValue === "object") {
    try {
      return truncateText(JSON.stringify(argumentsValue, null, 0), 220);
    } catch {
      return "";
    }
  }

  return truncateText(String(argumentsValue), 220);
}

function summarizeToolError(errorValue) {
  if (!errorValue) {
    return "";
  }

  if (typeof errorValue === "string") {
    return truncateText(errorValue, 220);
  }

  try {
    return truncateText(JSON.stringify(errorValue, null, 0), 220);
  } catch {
    return truncateText(String(errorValue), 220);
  }
}

function summarizeToolCall(item) {
  const tool = item.tool || item.name || "tool_call";
  const lines = [`工具：${tool}`];

  if (item.server) {
    lines.push(`服务：${item.server}`);
  }

  if (tool === "get_app_state" && item.arguments?.app) {
    lines.push(`应用：${item.arguments.app}`);
    lines.push("详细窗口树和页面结构已省略。");
  } else {
    const argumentSummary = summarizeToolArguments(item.arguments);
    if (argumentSummary) {
      lines.push(`参数：${argumentSummary}`);
    }
  }

  if (item.status) {
    lines.push(`状态：${item.status}`);
  }

  const errorSummary = summarizeToolError(item.error);
  if (errorSummary) {
    lines.push(`错误：${errorSummary}`);
  }

  if (Number.isFinite(item.durationMs) && item.durationMs > 0) {
    lines.push(`耗时：${item.durationMs}ms`);
  }

  return lines.join("\n");
}

function summarizeWebSearch(item) {
  const action = item.action && typeof item.action === "object" ? item.action : {};
  const actionType = action.type || "";
  const lines = [];

  if (actionType === "search") {
    lines.push(`搜索：${truncateText(item.query || action.query || "（空查询）", 200)}`);
  } else if (actionType === "openPage") {
    lines.push(`打开页面：${truncateText(action.url || item.query || "（未知页面）", 220)}`);
  } else if (actionType === "findInPage") {
    lines.push(`页内查找：${truncateText(action.pattern || item.query || "（空模式）", 180)}`);
    if (action.url) {
      lines.push(`页面：${truncateText(action.url, 220)}`);
    }
  } else {
    lines.push(`网页检索：${truncateText(item.query || "（无摘要）", 200)}`);
  }

  if (item.status) {
    lines.push(`状态：${item.status}`);
  }

  return lines.join("\n");
}

function normalizeImageGenerationSource(sourceValue, mimeType = "") {
  if (typeof sourceValue !== "string") {
    return "";
  }

  const trimmed = sourceValue.trim();
  if (!trimmed) {
    return "";
  }

  if (trimmed.startsWith("data:") || /^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }

  const normalized = trimmed.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/=]+$/.test(normalized) || normalized.length < 128) {
    return "";
  }

  const resolvedMimeType = mimeType || "image/png";
  return `data:${resolvedMimeType};base64,${normalized}`;
}

function extractGeneratedImages(item) {
  if (!item || typeof item !== "object") {
    return [];
  }

  const mimeType =
    String(item.mimeType || item.mime_type || item.mediaType || item.contentType || "").trim() || "image/png";
  const sources = [];

  if (typeof item.result === "string" && item.result.trim()) {
    sources.push(item.result);
  }

  if (typeof item.imageUrl === "string" && item.imageUrl.trim()) {
    sources.push(item.imageUrl);
  }

  if (typeof item.url === "string" && item.url.trim()) {
    sources.push(item.url);
  }

  if (Array.isArray(item.images)) {
    for (const image of item.images) {
      if (typeof image === "string") {
        sources.push(image);
        continue;
      }

      if (image && typeof image === "object") {
        sources.push(
          image.url || image.image_url || image.imageUrl || image.sourceUrl || image.src || image.href || image.result || ""
        );
      }
    }
  }

  const resolved = [];
  for (const [index, source] of sources.entries()) {
    const sourceUrl = normalizeImageGenerationSource(source, mimeType);
    if (!sourceUrl) {
      continue;
    }

    resolved.push({
      id: `${item.id || "generated_image"}_${index + 1}`,
      sourceUrl,
      mimeType
    });
  }

  return resolved;
}

function extractApprovalDetails(serverRequest) {
  const details = [];
  const params = serverRequest.params || {};

  if (params.command) {
    details.push(`命令：${params.command}`);
  }

  if (params.cwd) {
    details.push(`目录：${params.cwd}`);
  }

  if (params.reason) {
    details.push(`原因：${params.reason}`);
  }

  if (params.toolName) {
    details.push(`工具：${params.toolName}`);
  }

  if (params.tool) {
    details.push(`工具：${params.tool}`);
  }

  if (params.serverName) {
    details.push(`MCP 服务：${params.serverName}`);
  }

  if (params.message) {
    details.push(`消息：${params.message}`);
  }

  if (Array.isArray(params.command) && params.command.length > 0) {
    details.push(`命令：${params.command.join(" ")}`);
  }

  if (params.permissions) {
    details.push("包含额外权限申请");
  }

  if (Array.isArray(params.changes) && params.changes.length > 0) {
    const files = params.changes.map(summarizeFileChange).filter(Boolean).slice(0, 6);
    if (files.length > 0) {
      details.push(`涉及文件：${files.join("、")}`);
    }
  }

  if (params.fileChanges && typeof params.fileChanges === "object") {
    const files = Object.keys(params.fileChanges).filter(Boolean).slice(0, 6);
    if (files.length > 0) {
      details.push(`涉及文件：${files.join("、")}`);
    }
  }

  return details;
}

function normalizeApproval(serverRequest) {
  const kindMap = {
    "item/commandExecution/requestApproval": "command",
    "item/fileChange/requestApproval": "file_change",
    "item/tool/requestUserInput": "user_input",
    "item/tool/call": "tool_call",
    "item/permissions/requestApproval": "permissions",
    "mcpServer/elicitation/request": "elicitation",
    "applyPatchApproval": "apply_patch",
    "execCommandApproval": "exec_command",
    "account/chatgptAuthTokens/refresh": "auth_refresh"
  };

  return {
    requestId: String(serverRequest.id),
    method: serverRequest.method,
    kind: kindMap[serverRequest.method] || "unknown",
    threadId: serverRequest.params.threadId || null,
    turnId: serverRequest.params.turnId || null,
    itemId: serverRequest.params.itemId || null,
    summary: summarizeApproval(serverRequest),
    details: extractApprovalDetails(serverRequest),
    questions: normalizeApprovalQuestions(serverRequest.params),
    params: serverRequest.params
  };
}

export class CodexBridge extends EventEmitter {
  constructor(options = {}) {
    super();
    this.child = null;
    this.buffer = "";
    this.requestId = 0;
    this.pendingRequests = new Map();
    this.pendingApprovals = new Map();
    this.activeTurns = new Map();
    this.loadedThreads = new Set();
    this.ready = false;
    this.workspacePath = "";
    this.lastError = "";
    this.pendingStop = null;
    this.bypassPermissions = options.bypassPermissions !== false;
    this.autoApprove = options.autoApprove !== false;
    this.threadSummaryCache = new Map();
    this.summaryEnrichLimit = Number.isFinite(options.summaryEnrichLimit)
      ? Math.max(0, Number(options.summaryEnrichLimit))
      : 12;
  }

  isThreadNotFoundError(error) {
    return String(error?.message || "").includes("thread not found");
  }

  isConfigurationLoadError(error) {
    return String(error?.message || "").toLowerCase().includes("failed to load configuration");
  }

  setBypassPermissions(enabled) {
    this.bypassPermissions = Boolean(enabled);
  }

  getThreadPolicy() {
    if (this.bypassPermissions) {
      return {
        approvalPolicy: "never",
        sandbox: "danger-full-access"
      };
    }

    return {
      approvalPolicy: "on-request",
      sandbox: "workspace-write"
    };
  }

  async restartBridge() {
    const workspacePath = this.workspacePath;
    await this.stop();
    await this.start({ workspacePath });
  }

  async withRecoveredThread(threadId, operation) {
    await this.ensureThreadLoaded(threadId);

    try {
      return await operation();
    } catch (error) {
      if (!this.isThreadNotFoundError(error)) {
        throw error;
      }

      await this.reloadThread(threadId);
      return operation();
    }
  }

  getState() {
    return {
      ready: this.ready,
      lastError: this.lastError,
      pendingApprovals: this.pendingApprovals.size,
      activeTurns: this.activeTurns.size
    };
  }

  async start({ workspacePath }) {
    if (this.child) {
      return this.getState();
    }

    this.workspacePath = workspacePath;
    this.lastError = "";
    this.child = spawn(CODEX_BINARY_PATH, ["app-server"], {
      cwd: workspacePath,
      stdio: ["pipe", "pipe", "pipe"]
    });

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      this.onStdout(chunk);
    });

    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (!text) {
        return;
      }

      this.lastError = text;
      this.emit("stderr", text);
    });

    this.child.on("exit", (code, signal) => {
      const exitingByRequest = Boolean(this.pendingStop);
      const errorMessage =
        !exitingByRequest && (code !== 0 || signal)
          ? `codex app-server 已退出（code=${code ?? "null"} signal=${signal ?? "null"}）`
          : "";

      this.ready = false;
      this.rejectAllPending(errorMessage || "codex app-server 已停止");
      this.child = null;
      this.buffer = "";
      this.pendingApprovals.clear();
      this.activeTurns.clear();
      this.loadedThreads.clear();

      if (this.pendingStop) {
        this.pendingStop.resolve();
        this.pendingStop = null;
      }

      if (errorMessage) {
        this.lastError = errorMessage;
        this.emit("bridge-error", errorMessage);
      }

      this.emit("state-changed", this.getState());
    });

    await this.request("initialize", {
      clientInfo: {
        name: "codex-desktop-by-bingdianlingdu",
        version: "1.2.0"
      },
      capabilities: {
        experimentalApi: true
      }
    });

    this.notify({ method: "initialized" });
    this.ready = true;
    this.emit("state-changed", this.getState());
    return this.getState();
  }

  async stop() {
    if (!this.child) {
      this.ready = false;
      return this.getState();
    }

    this.ready = false;
    this.emit("state-changed", this.getState());

    await new Promise((resolve) => {
      this.pendingStop = { resolve };
      this.child.kill("SIGTERM");

      setTimeout(() => {
        if (this.pendingStop && this.child) {
          this.child.kill("SIGKILL");
        }
      }, 1500);
    });

    this.pendingApprovals.clear();
    this.activeTurns.clear();
    this.loadedThreads.clear();
    this.emit("state-changed", this.getState());
    return this.getState();
  }

  async listThreads({ cwd }) {
    const response = await this.request("thread/list", {
      cwd,
      archived: false,
      limit: 100
    });

    const baseThreads = response.data
      .map((thread) => this.normalizeThread(thread))
      .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0));

    const resolvedThreads = baseThreads.map((thread) => this.applyCachedSummary(thread));
    const toEnrich = [];

    for (const thread of resolvedThreads) {
      if (this.needsSummaryEnrichment(thread)) {
        toEnrich.push(thread);
      }
      if (toEnrich.length >= this.summaryEnrichLimit) {
        break;
      }
    }

    if (toEnrich.length > 0) {
      const enriched = await Promise.all(toEnrich.map(async (thread) => this.enrichThreadSummary(thread)));
      const enrichedById = new Map(enriched.map((thread) => [thread.id, thread]));
      for (let index = 0; index < resolvedThreads.length; index += 1) {
        const replaced = enrichedById.get(resolvedThreads[index].id);
        if (replaced) {
          resolvedThreads[index] = replaced;
        }
      }
    }

    return resolvedThreads.sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0));
  }

  applyCachedSummary(thread) {
    const cached = this.threadSummaryCache.get(thread.id);
    if (!cached) {
      return thread;
    }

    const baseUpdatedAt = Number(thread.updatedAt || 0);
    if (cached.baseUpdatedAt !== baseUpdatedAt) {
      return thread;
    }

    return {
      ...thread,
      preview: cached.preview || thread.preview,
      updatedAt: cached.updatedAt || thread.updatedAt
    };
  }

  needsSummaryEnrichment(thread) {
    const cached = this.threadSummaryCache.get(thread.id);
    if (!cached) {
      return true;
    }

    return cached.baseUpdatedAt !== Number(thread.updatedAt || 0);
  }

  cacheThreadSummary(thread, baseUpdatedAt) {
    this.threadSummaryCache.set(thread.id, {
      baseUpdatedAt: Number(baseUpdatedAt || 0),
      preview: thread.preview || "",
      updatedAt: Number(thread.updatedAt || 0)
    });

    if (this.threadSummaryCache.size > 300) {
      const firstKey = this.threadSummaryCache.keys().next().value;
      if (firstKey) {
        this.threadSummaryCache.delete(firstKey);
      }
    }
  }

  async enrichThreadSummary(thread) {
    const baseUpdatedAt = Number(thread.updatedAt || 0);
    try {
      const detail = await this.readThread(thread.id);
      const reversedItems = [...detail.items].reverse();
      const lastAssistantMessage = reversedItems.find(
        (item) => item.type === "message" && item.role === "assistant" && item.text?.trim()
      );
      const lastMessage = reversedItems.find((item) => item.type === "message" && item.text?.trim());
      const summarySource = lastAssistantMessage || lastMessage;

      const enriched = {
        ...thread,
        preview: summarizePreviewText(summarySource?.text || thread.preview),
        updatedAt: summarySource?.timestamp || thread.updatedAt
      };
      this.cacheThreadSummary(enriched, baseUpdatedAt);
      return enriched;
    } catch {
      const fallback = {
        ...thread,
        preview: summarizePreviewText(thread.preview)
      };
      this.cacheThreadSummary(fallback, baseUpdatedAt);
      return fallback;
    }
  }

  async readThread(threadId) {
    return this.withRecoveredThread(threadId, async () => {
      let response;

      try {
        response = await this.request("thread/read", {
          threadId,
          includeTurns: true
        });
      } catch (error) {
        if (!String(error.message).includes("includeTurns is unavailable before first user message")) {
          throw error;
        }

        response = await this.request("thread/read", {
          threadId,
          includeTurns: false
        });
      }

      return this.normalizeThreadDetail(response.thread);
    });
  }

  async createThread({ cwd, title }) {
    const threadPolicy = this.getThreadPolicy();
    let response;
    try {
      response = await this.request("thread/start", {
        cwd,
        ...threadPolicy,
        experimentalRawEvents: false,
        persistExtendedHistory: true,
        serviceName: "CodeX桌面端by.冰点零度"
      });
    } catch (error) {
      if (!this.isConfigurationLoadError(error)) {
        throw error;
      }

      await this.restartBridge();
      response = await this.request("thread/start", {
        cwd,
        ...threadPolicy,
        experimentalRawEvents: false,
        persistExtendedHistory: true,
        serviceName: "CodeX桌面端by.冰点零度"
      });
    }

    if (title) {
      await this.request("thread/name/set", {
        threadId: response.thread.id,
        name: title
      });
    }

    this.loadedThreads.add(response.thread.id);

    return this.normalizeThread({
      ...response.thread,
      name: title || response.thread.name
    });
  }

  async sendMessage({ threadId, text, images = [], files = [] }) {
    const uploadedFilePaths = await this.saveFileAttachments(files);
    const input = [];
    const textParts = [];

    if (text && typeof text === "string" && text.trim()) {
      textParts.push(text.trim());
    }

    if (uploadedFilePaths.length > 0) {
      textParts.push(
        [
          "已上传附件文件，请优先读取这些文件路径：",
          ...uploadedFilePaths.map((filePath) => `- ${filePath}`)
        ].join("\n")
      );
    }

    const normalizedText = textParts.join("\n\n").trim();
    if (normalizedText) {
      input.push({
        type: "text",
        text: normalizedText,
        text_elements: []
      });
    }

    for (const imageUrl of images) {
      input.push({
        type: "image",
        url: imageUrl
      });
    }

    if (input.length === 0) {
      throw new Error("消息内容不能为空");
    }

    const response = await this.withRecoveredThread(threadId, async () => {
      return this.request("turn/start", {
        threadId,
        input
      });
    });

    this.activeTurns.set(threadId, response.turn.id);
    this.emit("state-changed", this.getState());
    return {
      threadId,
      turnId: response.turn.id,
      status: response.turn.status
    };
  }

  async saveFileAttachments(files = []) {
    if (!Array.isArray(files) || files.length === 0) {
      return [];
    }

    if (!this.workspacePath) {
      throw new Error("工作目录未设置，无法上传附件");
    }

    const uploadDir = path.join(this.workspacePath, MOBILE_UPLOAD_DIR);
    await mkdir(uploadDir, { recursive: true });

    const savedPaths = [];
    const timestamp = Date.now();

    for (let index = 0; index < files.length; index += 1) {
      const file = files[index] || {};
      const name = this.sanitizeAttachmentFileName(file.name || `附件_${index + 1}`);
      const dataBuffer = this.decodeAttachmentDataUrl(file.dataUrl);
      if (dataBuffer.length === 0) {
        continue;
      }

      const fileName = `${timestamp}-${index + 1}-${name}`;
      const targetPath = path.join(uploadDir, fileName);
      await writeFile(targetPath, dataBuffer);
      savedPaths.push(targetPath);
    }

    return savedPaths;
  }

  sanitizeAttachmentFileName(rawName) {
    const name = String(rawName || "")
      .replaceAll("\\", "_")
      .replaceAll("/", "_")
      .trim();
    const safe = name.replace(/[^a-zA-Z0-9._\-\u4e00-\u9fff ]/g, "_").slice(0, 120);
    return safe || `附件_${Date.now()}`;
  }

  decodeAttachmentDataUrl(rawDataUrl) {
    if (typeof rawDataUrl !== "string" || rawDataUrl.trim().length === 0) {
      throw new Error("附件内容为空");
    }

    const value = rawDataUrl.trim();
    const matched = value.match(/^data:[^;]+;base64,(.+)$/s);
    const base64Payload = (matched ? matched[1] : value).replace(/\s+/g, "");
    const buffer = Buffer.from(base64Payload, "base64");
    if (buffer.length === 0) {
      throw new Error("附件解析失败");
    }
    return buffer;
  }

  async interruptThread(threadId) {
    const turnId = this.activeTurns.get(threadId);
    if (!turnId) {
      throw new Error("当前线程没有可中断的任务");
    }

    await this.withRecoveredThread(threadId, async () => {
      return this.request("turn/interrupt", {
        threadId,
        turnId
      });
    });

    return {
      threadId,
      turnId
    };
  }

  async archiveThread(threadId) {
    await this.withRecoveredThread(threadId, async () => {
      return this.request("thread/archive", {
        threadId
      });
    });

    this.clearThreadState(threadId);

    return {
      threadId
    };
  }

  clearThreadState(threadId) {
    this.activeTurns.delete(threadId);
    this.loadedThreads.delete(threadId);
    this.threadSummaryCache.delete(threadId);

    for (const [requestId, approval] of this.pendingApprovals.entries()) {
      if (approval.threadId === threadId) {
        this.pendingApprovals.delete(requestId);
      }
    }

    this.emit("state-changed", this.getState());

    return {
      threadId
    };
  }

  listPendingApprovals() {
    return Array.from(this.pendingApprovals.values());
  }

  async buildApprovalResult(approval, decision, answers) {
    if (approval.method === "item/commandExecution/requestApproval") {
      return {
        decision: decision || "accept"
      };
    }

    if (approval.method === "item/fileChange/requestApproval") {
      return {
        decision: decision || "accept"
      };
    }

    if (approval.method === "item/tool/requestUserInput") {
      return {
        answers: answers || {}
      };
    }

    if (approval.method === "item/tool/call") {
      return this.buildToolCallResult(approval);
    }

    if (approval.method === "item/permissions/requestApproval") {
      return {
        permissions: approval.params.permissions || {},
        scope: "session"
      };
    }

    if (approval.method === "mcpServer/elicitation/request") {
      return {
        action: "accept",
        content: this.buildElicitationContent(approval.params),
        _meta: approval.params._meta || null
      };
    }

    if (approval.method === "applyPatchApproval" || approval.method === "execCommandApproval") {
      return {
        decision: "approved_for_session"
      };
    }

    if (approval.method === "account/chatgptAuthTokens/refresh") {
      return this.buildChatgptAuthRefreshResult(approval.params);
    }

    throw new Error("暂不支持该审批类型");
  }

  buildToolCallResult(approval) {
    const toolName = approval?.params?.tool || "unknown";

    if (toolName === "read_thread_terminal") {
      return {
        success: false,
        contentItems: [
          {
            type: "inputText",
            text: "CodeX桌面端by.冰点零度 当前不支持 read_thread_terminal；这个会话没有可供移动端读取的桌面线程终端输出。"
          }
        ]
      };
    }

    return {
      success: false,
      contentItems: [
        {
          type: "inputText",
          text: `CodeX桌面端by.冰点零度 当前不支持工具调用：${toolName}`
        }
      ]
    };
  }

  buildElicitationContent(params = {}) {
    if (params.mode !== "form") {
      return null;
    }

    const properties = params.requestedSchema?.properties || {};
    const content = {};

    for (const [key, schema] of Object.entries(properties)) {
      content[key] = this.buildElicitationValue(schema);
    }

    return content;
  }

  buildElicitationValue(schema = {}) {
    if (Array.isArray(schema.default)) {
      return schema.default;
    }

    if (Object.prototype.hasOwnProperty.call(schema, "default")) {
      return schema.default;
    }

    if (Array.isArray(schema.enum) && schema.enum.length > 0) {
      return schema.enum[0];
    }

    if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
      return schema.oneOf[0]?.const ?? "";
    }

    if (schema.type === "array") {
      if (Array.isArray(schema.items?.enum) && schema.items.enum.length > 0) {
        return [schema.items.enum[0]];
      }

      if (Array.isArray(schema.items?.oneOf) && schema.items.oneOf.length > 0) {
        const first = schema.items.oneOf[0]?.const;
        return first === undefined ? [] : [first];
      }

      return [];
    }

    if (schema.type === "boolean") {
      return false;
    }

    if (schema.type === "number" || schema.type === "integer") {
      return typeof schema.minimum === "number" ? schema.minimum : 0;
    }

    return "";
  }

  async buildChatgptAuthRefreshResult(params = {}) {
    const authStatus = await this.request("getAuthStatus", {
      includeToken: true,
      refreshToken: true
    });

    const accountResponse = await this.request("account/read", {
      refreshToken: true
    });

    return {
      accessToken: authStatus.authToken || "",
      chatgptAccountId: params.previousAccountId || accountResponse.account?.email || "default",
      chatgptPlanType: accountResponse.account?.planType || null
    };
  }

  buildAutoApprovalAnswers(approval) {
    const answers = {};

    for (const question of approval.questions || []) {
      answers[question.id] = question.options?.[0] || "";
    }

    return answers;
  }

  async resolveApproval({ requestId, decision, answers }) {
    const approval = this.pendingApprovals.get(String(requestId));
    if (!approval) {
      throw new Error("未找到待处理审批");
    }

    const result = await this.buildApprovalResult(approval, decision, answers);

    this.respond(approval.requestId, result);
    this.pendingApprovals.delete(String(requestId));
    this.emit("approval-resolved", {
      requestId: String(requestId)
    });
    this.emit("state-changed", this.getState());
    return {
      ok: true
    };
  }

  async autoResolveApproval(approval) {
    const answers = approval.method === "item/tool/requestUserInput" ? this.buildAutoApprovalAnswers(approval) : {};
    try {
      await this.resolveApproval({
        requestId: approval.requestId,
        decision: "accept",
        answers
      });
    } catch (error) {
      this.lastError = `自动审批失败：${error.message}`;
      this.emit("bridge-error", this.lastError);
      this.emit("state-changed", this.getState());
    }
  }

  async ensureThreadLoaded(threadId) {
    if (this.loadedThreads.has(threadId)) {
      return;
    }

    await this.reloadThread(threadId);
  }

  async reloadThread(threadId) {
    this.loadedThreads.delete(threadId);
    await this.request("thread/resume", {
      threadId,
      ...this.getThreadPolicy(),
      persistExtendedHistory: true
    });
    this.loadedThreads.add(threadId);
  }

  normalizeThread(thread) {
    const hasPendingApproval = this.listPendingApprovals().some((item) => item.threadId === thread.id);
    return {
      id: thread.id,
      title: thread.name || thread.preview || "未命名会话",
      preview: summarizePreviewText(thread.preview || ""),
      cwd: thread.cwd,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      status: normalizeThreadStatus(thread.status, hasPendingApproval),
      rawStatus: thread.status,
      source: thread.source
    };
  }

  normalizeThreadDetail(thread) {
    const normalizedThread = this.normalizeThread(thread);
    const flattened = [];

    for (const turn of thread.turns || []) {
      for (const item of turn.items || []) {
        flattened.push({
          turn,
          item
        });
      }
    }

    const limitedEntries =
      flattened.length > MAX_THREAD_ITEMS ? flattened.slice(flattened.length - MAX_THREAD_ITEMS) : flattened;
    const items = limitedEntries.map((entry) => this.normalizeThreadItem(entry.item, entry.turn.id, entry.turn));

    return {
      ...normalizedThread,
      items
    };
  }

  normalizeThreadItem(item, turnId, turn = null) {
    const timestamp = normalizeTimestamp(
      item.timestamp || item.createdAt || item.updatedAt || turn?.createdAt || turn?.startedAt || turn?.completedAt
    );

    if (item.type === "userMessage") {
      return {
        id: item.id,
        turnId,
        type: "message",
        role: "user",
        text: summarizeUserContent(item.content),
        images: extractUserImages(item.content),
        timestamp
      };
    }

    if (item.type === "agentMessage") {
      return {
        id: item.id,
        turnId,
        type: "message",
        role: "assistant",
        text: item.text,
        phase: item.phase,
        timestamp
      };
    }

    if (item.type === "plan") {
      return {
        id: item.id,
        turnId,
        type: "plan",
        text: item.text,
        timestamp
      };
    }

    if (item.type === "reasoning") {
      return {
        id: item.id,
        turnId,
        type: "reasoning",
        summary: item.summary,
        content: item.content,
        timestamp
      };
    }

    if (item.type === "commandExecution") {
      return {
        id: item.id,
        turnId,
        type: "command_execution",
        command: item.command,
        cwd: item.cwd,
        status: item.status,
        output: item.aggregatedOutput,
        exitCode: item.exitCode,
        timestamp
      };
    }

    if (item.type === "fileChange") {
      return {
        id: item.id,
        turnId,
        type: "file_change",
        status: item.status,
        changes: item.changes,
        timestamp
      };
    }

    if (item.type === "webSearch") {
      return {
        id: item.id,
        turnId,
        type: "web_search",
        status: item.status,
        text: summarizeWebSearch(item),
        timestamp
      };
    }

    if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") {
      return {
        id: item.id,
        turnId,
        type: "tool_call",
        status: item.status,
        text: summarizeToolCall(item),
        timestamp
      };
    }

    if (item.type === "imageGeneration") {
      const images = extractGeneratedImages(item);
      return {
        id: item.id,
        turnId,
        type: "message",
        role: "assistant",
        text: images.length > 0 ? "" : truncateText(item.revisedPrompt || "已生成图片", 220),
        images,
        timestamp
      };
    }

    return {
      id: item.id,
      turnId,
      type: item.type,
      text: truncateText(JSON.stringify(item, null, 0), 400),
      timestamp
    };
  }

  onStdout(chunk) {
    this.buffer += chunk.toString();

    let index;
    while ((index = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);

      if (!line) {
        continue;
      }

      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.lastError = `无法解析来自 codex app-server 的消息：${line}`;
        this.emit("bridge-error", this.lastError);
        continue;
      }

      this.handleMessage(message);
    }
  }

  handleMessage(message) {
    if (Object.prototype.hasOwnProperty.call(message, "id") && !message.method) {
      const resolver = this.pendingRequests.get(String(message.id));
      if (resolver) {
        this.pendingRequests.delete(String(message.id));
        if (message.error) {
          resolver.reject(new Error(message.error.message || "请求失败"));
        } else {
          resolver.resolve(message.result);
        }
      }
      return;
    }

    if (message.method && Object.prototype.hasOwnProperty.call(message, "id")) {
      this.handleServerRequest(message);
      return;
    }

    if (message.method) {
      this.handleNotification(message);
    }
  }

  handleServerRequest(message) {
    const normalized = normalizeApproval(message);
    this.pendingApprovals.set(normalized.requestId, normalized);
    this.emit("state-changed", this.getState());
    if (this.autoApprove) {
      void this.autoResolveApproval(normalized);
      return;
    }

    this.emit("approval-required", normalized);
  }

  handleNotification(message) {
    if (message.method === "turn/started") {
      this.activeTurns.set(message.params.threadId, message.params.turn.id);
      this.loadedThreads.add(message.params.threadId);
      this.emit("turn-started", {
        threadId: message.params.threadId,
        turnId: message.params.turn.id,
        status: message.params.turn.status
      });
    }

    if (message.method === "turn/completed") {
      this.activeTurns.delete(message.params.threadId);
      this.emit("turn-completed", {
        threadId: message.params.threadId,
        turnId: message.params.turn.id,
        status: message.params.turn.status,
        error: message.params.turn.error
      });
    }

    if (message.method === "thread/status/changed") {
      const approvalPending = this.listPendingApprovals().some((item) => item.threadId === message.params.threadId);
      this.emit("thread-status", {
        threadId: message.params.threadId,
        status: normalizeThreadStatus(message.params.status, approvalPending),
        rawStatus: message.params.status
      });
    }

    if (message.method === "item/agentMessage/delta") {
      this.emit("message-delta", {
        threadId: message.params.threadId,
        turnId: message.params.turnId,
        messageId: message.params.itemId,
        delta: message.params.delta,
        timestamp: Date.now()
      });
    }

    if (message.method === "item/completed" && message.params.item.type === "agentMessage") {
      const timestamp = Date.now();
      const cached = this.threadSummaryCache.get(message.params.threadId);
      this.threadSummaryCache.set(message.params.threadId, {
        baseUpdatedAt: cached?.baseUpdatedAt ?? Number(timestamp),
        preview: summarizePreviewText(message.params.item.text || ""),
        updatedAt: timestamp
      });
      this.emit("message-completed", {
        threadId: message.params.threadId,
        turnId: message.params.turnId,
        messageId: message.params.item.id,
        text: message.params.item.text,
        phase: message.params.item.phase,
        timestamp
      });
    }

    if (message.method === "thread/started") {
      this.loadedThreads.add(message.params.thread.id);
      this.emit("thread-started", {
        thread: this.normalizeThread(message.params.thread)
      });
    }

    if (message.method === "serverRequest/resolved") {
      this.pendingApprovals.delete(String(message.params.requestId));
      this.emit("approval-resolved", {
        requestId: String(message.params.requestId),
        threadId: message.params.threadId
      });
    }

    if (message.method === "error") {
      this.emit("turn-error", {
        threadId: message.params.threadId,
        turnId: message.params.turnId,
        error: message.params.error,
        willRetry: message.params.willRetry
      });
    }

    this.emit("notification", message);
    this.emit("state-changed", this.getState());
  }

  request(method, params) {
    if (!this.child) {
      throw new Error("codex app-server 未启动");
    }

    const id = String(++this.requestId);
    const payload = {
      method,
      id,
      params
    };

    this.child.stdin.write(`${JSON.stringify(payload)}\n`);

    return new Promise((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve,
        reject
      });
    });
  }

  notify(payload) {
    if (!this.child) {
      return;
    }

    this.child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  respond(id, result) {
    if (!this.child) {
      return;
    }

    this.child.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }

  rejectAllPending(message) {
    for (const pending of this.pendingRequests.values()) {
      pending.reject(new Error(message));
    }
    this.pendingRequests.clear();
  }
}
