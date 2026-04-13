import os from "node:os";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import path from "node:path";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { formatCodexLaunchError } from "./codex-path.js";

const MOBILE_UPLOAD_DIR = ".codex-mobile-uploads";
const SESSION_ROOT_DIR = path.join(os.homedir(), ".codex", "sessions");
const THREAD_DETAIL_ITEM_LIMIT = 460;
const LOCAL_METADATA_PREFIXES = [
  "<environment_context>",
  "<permissions instructions>",
  "<app-context>",
  "<collaboration_mode>",
  "<skills_instructions>"
];

function normalizeWorkspacePath(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }

  const withoutNamespace = raw.replace(/^\\\\\?\\/, "");
  const preferredSeparators =
    process.platform === "win32"
      ? withoutNamespace.replaceAll("/", "\\")
      : withoutNamespace.replaceAll("\\", "/");
  const resolved = path.resolve(preferredSeparators);

  if (process.platform !== "win32") {
    return resolved.replace(/[\\/]+$/, "");
  }

  return resolved.replace(/[\\/]+$/, "").toLowerCase();
}

function isWorkspaceMatch(sessionCwd, requestedCwd) {
  const normalizedSessionCwd = normalizeWorkspacePath(sessionCwd);
  const normalizedRequestedCwd = normalizeWorkspacePath(requestedCwd);

  if (!normalizedSessionCwd || !normalizedRequestedCwd) {
    return false;
  }

  return normalizedSessionCwd === normalizedRequestedCwd;
}

function summarizeUserContent(contentItems = []) {
  const textLines = [];
  let imageCount = 0;

  for (const item of contentItems) {
    if (item.type === "text" || item.type === "input_text") {
      if (item.text) {
        textLines.push(item.text);
      }
      continue;
    }

    if (item.type === "input_image") {
      imageCount += 1;
    }
  }

  if (imageCount > 0) {
    textLines.push(`[鍥剧墖 ${imageCount} 寮燷`);
  }

  return textLines.join("\n");
}

function normalizeTimestamp(value) {
  if (!value) {
    return 0;
  }

  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric < 1_000_000_000_000 ? numeric * 1000 : numeric;
  }

  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function summarizePreviewText(value) {
  if (!value || typeof value !== "string") {
    return "";
  }

  return value.replace(/\s+/g, " ").trim().slice(0, 180);
}

function isConversationMessageText(value) {
  const normalized = summarizePreviewText(value);
  if (!normalized) {
    return false;
  }

  return !LOCAL_METADATA_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function summarizeMessageContent(content = []) {
  if (!Array.isArray(content) || content.length === 0) {
    return "";
  }

  return summarizePreviewText(
    content
      .map((item) => item?.text)
      .filter((text) => typeof text === "string" && text.trim())
      .join("\n")
  );
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
    return serverRequest.params.command || serverRequest.params.reason || "鍛戒护鎵ц瀹℃壒";
  }

  if (serverRequest.method === "item/fileChange/requestApproval") {
    return serverRequest.params.reason || "鏂囦欢淇敼瀹℃壒";
  }

  if (serverRequest.method === "item/tool/requestUserInput") {
    return "绛夊緟鐢ㄦ埛杈撳叆";
  }

  if (serverRequest.method === "item/tool/call") {
    return serverRequest.params.tool ? `工具调用: ${serverRequest.params.tool}` : "工具调用";
  }

  if (serverRequest.method === "item/permissions/requestApproval") {
    return serverRequest.params.reason || "鏉冮檺鎺堟潈";
  }

  if (serverRequest.method === "mcpServer/elicitation/request") {
    return serverRequest.params.message || "MCP 浜や簰璇锋眰";
  }

  if (serverRequest.method === "applyPatchApproval") {
    return serverRequest.params.reason || "琛ヤ竵搴旂敤瀹℃壒";
  }

  if (serverRequest.method === "execCommandApproval") {
    return Array.isArray(serverRequest.params.command) && serverRequest.params.command.length > 0
      ? serverRequest.params.command.join(" ")
      : serverRequest.params.reason || "鍛戒护鎵ц瀹℃壒";
  }

  if (serverRequest.method === "account/chatgptAuthTokens/refresh") {
    return "鍒锋柊 ChatGPT 鎺堟潈浠ょ墝";
  }

  return "绛夊緟澶勭悊";
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
    label: question.header || question.label || `闂 ${index + 1}`,
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

function extractApprovalDetails(serverRequest) {
  const details = [];
  const params = serverRequest.params || {};

  if (params.command) {
    details.push(`命令: ${params.command}`);
  }

  if (params.cwd) {
    details.push(`目录: ${params.cwd}`);
  }

  if (params.reason) {
    details.push(`原因: ${params.reason}`);
  }

  if (params.toolName) {
    details.push(`工具: ${params.toolName}`);
  }

  if (params.tool) {
    details.push(`工具: ${params.tool}`);
  }

  if (params.serverName) {
    details.push(`MCP 服务: ${params.serverName}`);
  }

  if (params.message) {
    details.push(`消息: ${params.message}`);
  }

  if (Array.isArray(params.command) && params.command.length > 0) {
    details.push(`命令: ${params.command.join(" ")}`);
  }

  if (params.permissions) {
    details.push("鍖呭惈棰濆鏉冮檺鐢宠");
  }

  if (Array.isArray(params.changes) && params.changes.length > 0) {
    const files = params.changes.map(summarizeFileChange).filter(Boolean).slice(0, 6);
    if (files.length > 0) {
      details.push(`涉及文件: ${files.join("、")}`);
    }
  }

  if (params.fileChanges && typeof params.fileChanges === "object") {
    const files = Object.keys(params.fileChanges).filter(Boolean).slice(0, 6);
    if (files.length > 0) {
      details.push(`涉及文件: ${files.join("、")}`);
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
    this.codexBinaryPath = options.codexBinaryPath || "";
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

  setCodexBinaryPath(codexBinaryPath) {
    this.codexBinaryPath = String(codexBinaryPath || "").trim();
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

  async start({ workspacePath, codexBinaryPath } = {}) {
    if (this.child) {
      return this.getState();
    }

    this.workspacePath = workspacePath;
    if (codexBinaryPath) {
      this.codexBinaryPath = String(codexBinaryPath).trim();
    }

    if (!this.codexBinaryPath) {
      throw new Error("未找到可执行的 Codex，请先配置 codex.exe 路径。");
    }

    this.lastError = "";
    this.child = spawn(this.codexBinaryPath, ["app-server"], {
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

    this.child.on("error", (error) => {
      const message = formatCodexLaunchError(error, this.codexBinaryPath);
      this.lastError = message;
      this.ready = false;
      this.rejectAllPending(message);
      this.child = null;
      this.buffer = "";
      this.pendingApprovals.clear();
      this.activeTurns.clear();
      this.loadedThreads.clear();
      this.emit("bridge-error", message);
      this.emit("state-changed", this.getState());
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
        version: "1.1"
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

  async readLocalSessionMetas(sessionDir = SESSION_ROOT_DIR) {
    let entries = [];
    try {
      entries = await readdir(sessionDir, { withFileTypes: true });
    } catch {
      return [];
    }

    const nested = await Promise.all(
      entries.map(async (entry) => {
        const targetPath = path.join(sessionDir, entry.name);
        if (entry.isDirectory()) {
          return this.readLocalSessionMetas(targetPath);
        }

        if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
          return [];
        }

        try {
          const content = await readFile(targetPath, "utf8");
          const firstLine = content.split(/\r?\n/, 1)[0];
          if (!firstLine) {
            return [];
          }

          const parsed = JSON.parse(firstLine);
          if (parsed.type !== "session_meta" || !parsed.payload?.id || !parsed.payload?.cwd) {
            return [];
          }

          return [
            {
              id: String(parsed.payload.id),
              cwd: String(parsed.payload.cwd),
              filePath: targetPath,
              createdAt: Date.parse(parsed.payload.timestamp || "") || 0,
              updatedAt: Date.parse(parsed.payload.timestamp || "") || 0
            }
          ];
        } catch {
          return [];
        }
      })
    );

    return nested.flat();
  }

  async readLocalSessionSummary(session) {
    let content = "";
    try {
      content = await readFile(session.filePath, "utf8");
    } catch {
      return {
        id: session.id,
        title: "Unnamed thread",
        preview: "",
        cwd: session.cwd,
        createdAt: session.createdAt,
        updatedAt: session.updatedAt,
        status: "idle",
        rawStatus: null,
        source: "local-session"
      };
    }

    let createdAt = Number(session.createdAt || 0);
    let updatedAt = Number(session.updatedAt || 0);
    let lastConversationAt = 0;
    let title = "";
    let lastUserText = "";
    let lastAssistantText = "";

    for (const line of content.split(/\r?\n/)) {
      if (!line) {
        continue;
      }

      try {
        const entry = JSON.parse(line);
        const entryTimestamp = normalizeTimestamp(entry.timestamp || entry.payload?.timestamp);
        if (entryTimestamp > 0) {
          createdAt = createdAt > 0 ? Math.min(createdAt, entryTimestamp) : entryTimestamp;
          updatedAt = Math.max(updatedAt, entryTimestamp);
        }

        if (entry.type !== "response_item" || entry.payload?.type !== "message") {
          continue;
        }

        const messageText = summarizeMessageContent(entry.payload.content);
        if (!isConversationMessageText(messageText)) {
          continue;
        }

        if (entry.payload.role === "user") {
          if (!title) {
            title = messageText;
          }
          lastUserText = messageText;
          lastConversationAt = Math.max(lastConversationAt, entryTimestamp);
          continue;
        }

        if (entry.payload.role === "assistant") {
          lastAssistantText = messageText;
          lastConversationAt = Math.max(lastConversationAt, entryTimestamp);
        }
      } catch {
        continue;
      }
    }

    return {
      id: session.id,
      title: title || lastUserText || lastAssistantText || "Unnamed thread",
      preview: lastAssistantText || lastUserText || "",
      cwd: session.cwd,
      createdAt,
      updatedAt: lastConversationAt || updatedAt,
      status: "idle",
      rawStatus: null,
      source: "local-session"
    };
  }

  async buildThreadListFromLocalSessions({ cwd, limit = 100 }) {
    const localSessions = await this.readLocalSessionMetas();
    const matchingSessions = localSessions
      .filter((session) => isWorkspaceMatch(session.cwd, cwd))
      .sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0))
      .slice(0, limit);

    const summarizedThreads = await Promise.all(
      matchingSessions.map((session) => this.readLocalSessionSummary(session))
    );

    return summarizedThreads.sort((left, right) => Number(right.updatedAt || 0) - Number(left.updatedAt || 0));
  }

  async listThreads({ cwd }) {
    const response = await this.request("thread/list", {
      cwd,
      archived: false,
      limit: 100
    });

    if (!Array.isArray(response.data) || response.data.length === 0) {
      return this.buildThreadListFromLocalSessions({ cwd, limit: 100 });
    }

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
        serviceName: "win\u684c\u9762CodeX"
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
        serviceName: "win\u684c\u9762CodeX"
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
          "宸蹭笂浼犻檮浠舵枃浠讹紝璇蜂紭鍏堣鍙栬繖浜涙枃浠惰矾寰勶細",
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
      throw new Error("娑堟伅鍐呭涓嶈兘涓虹┖");
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
      throw new Error("宸ヤ綔鐩綍鏈缃紝鏃犳硶涓婁紶闄勪欢");
    }

    const uploadDir = path.join(this.workspacePath, MOBILE_UPLOAD_DIR);
    await mkdir(uploadDir, { recursive: true });

    const savedPaths = [];
    const timestamp = Date.now();

    for (let index = 0; index < files.length; index += 1) {
      const file = files[index] || {};
      const name = this.sanitizeAttachmentFileName(file.name || `闄勪欢_${index + 1}`);
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
    return safe || `闄勪欢_${Date.now()}`;
  }

  decodeAttachmentDataUrl(rawDataUrl) {
    if (typeof rawDataUrl !== "string" || rawDataUrl.trim().length === 0) {
      throw new Error("闄勪欢鍐呭涓虹┖");
    }

    const value = rawDataUrl.trim();
    const matched = value.match(/^data:[^;]+;base64,(.+)$/s);
    const base64Payload = (matched ? matched[1] : value).replace(/\s+/g, "");
    const buffer = Buffer.from(base64Payload, "base64");
    if (buffer.length === 0) {
      throw new Error("闄勪欢瑙ｆ瀽澶辫触");
    }
    return buffer;
  }

  async interruptThread(threadId) {
    const turnId = this.activeTurns.get(threadId);
    if (!turnId) {
      throw new Error("褰撳墠绾跨▼娌℃湁鍙腑鏂殑浠诲姟");
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
            text: "win\u684c\u9762CodeX \u5f53\u524d\u4e0d\u652f\u6301 read_thread_terminal\uff1b\u8fd9\u4e2a\u4f1a\u8bdd\u6ca1\u6709\u53ef\u4f9b\u79fb\u52a8\u7aef\u8bfb\u53d6\u7684\u684c\u9762\u7ebf\u7a0b\u7ec8\u7aef\u8f93\u51fa\u3002"
          }
        ]
      };
    }

    return {
      success: false,
      contentItems: [
        {
          type: "inputText",
          text: `win\u684c\u9762CodeX \u5f53\u524d\u4e0d\u652f\u6301\u5de5\u5177\u8c03\u7528\uff1a${toolName}`
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
      throw new Error("鏈壘鍒板緟澶勭悊瀹℃壒");
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
      this.lastError = `自动审批失败: ${error.message}`;
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
    const createdAt = normalizeTimestamp(thread.createdAt);
    const updatedAt = normalizeTimestamp(thread.updatedAt || thread.lastActivityAt || thread.createdAt);
    return {
      id: thread.id,
      title: thread.name || thread.preview || "Unnamed thread",
      preview: summarizePreviewText(thread.preview || ""),
      cwd: thread.cwd,
      createdAt,
      updatedAt,
      status: normalizeThreadStatus(thread.status, hasPendingApproval),
      rawStatus: thread.status,
      source: thread.source
    };
  }

  normalizeThreadDetail(thread) {
    const normalizedThread = this.normalizeThread(thread);
    const turns = (thread.turns || []).map((turn) => ({
      id: turn.id,
      status: turn.status,
      error: turn.error,
      items: (turn.items || []).map((item) => this.normalizeThreadItem(item, turn.id, turn))
    }));
    const items = turns.flatMap((turn) => turn.items);

    if (items.length <= THREAD_DETAIL_ITEM_LIMIT) {
      return {
        ...normalizedThread,
        turns,
        items
      };
    }

    const limitedItems = items.slice(-THREAD_DETAIL_ITEM_LIMIT);
    const limitedItemIds = new Set(limitedItems.map((item) => item.id));
    const limitedTurns = turns
      .map((turn) => ({
        ...turn,
        items: turn.items.filter((item) => limitedItemIds.has(item.id))
      }))
      .filter((turn) => turn.items.length > 0);

    return {
      ...normalizedThread,
      turns: limitedTurns,
      items: limitedItems
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

    return {
      id: item.id,
      turnId,
      type: item.type,
      raw: item,
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
        this.lastError = `鏃犳硶瑙ｆ瀽鏉ヨ嚜 codex app-server 鐨勬秷鎭細${line}`;
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
          resolver.reject(new Error(message.error.message || "璇锋眰澶辫触"));
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

