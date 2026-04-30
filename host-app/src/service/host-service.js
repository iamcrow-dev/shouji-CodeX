import http from "node:http";
import EventEmitter from "node:events";
import path from "node:path";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { brotliCompressSync, constants as zlibConstants, gzipSync } from "node:zlib";
import express from "express";
import { WebSocketServer } from "ws";
import { CodexBridge } from "./codex-bridge.js";
import { inspectThreadArtifacts, purgeThreadArtifacts } from "./thread-storage.js";

const PURGE_RETRY_ATTEMPTS = 12;
const PURGE_RETRY_DELAY_MS = 250;
const PURGE_SETTLE_DELAY_MS = 400;
const COMPRESS_MIN_BYTES = 1024;
const SIPS_BINARY_PATH = "/usr/bin/sips";
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_PRESERVED_CHUNKS = new Set(["IHDR", "PLTE", "IDAT", "IEND", "tRNS"]);
const IMAGE_EXTENSION_BY_MIME = {
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/heic": "heic",
  "image/heif": "heif"
};
const SIPS_FORMAT_BY_MIME = {
  "image/jpeg": "jpeg",
  "image/jpg": "jpeg",
  "image/png": "png"
};
const MOBILE_FRIENDLY_JPEG_MAX_EDGE = 1600;
const MOBILE_FRIENDLY_JPEG_QUALITY = "85";
const execFileAsync = promisify(execFile);

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function jsonMessage(type, payload = {}) {
  return JSON.stringify({
    type,
    ...payload
  });
}

function acceptsEncoding(request, value) {
  const header = String(request.headers["accept-encoding"] || "");
  return header.toLowerCase().includes(value);
}

function sendJson(response, statusCode, payload) {
  response.status(statusCode).json(payload);
}

function sendCompressedJson(request, response, statusCode, payload) {
  const body = Buffer.from(JSON.stringify(payload));
  response.setHeader("Vary", "Accept-Encoding");

  if (body.length < COMPRESS_MIN_BYTES) {
    response.status(statusCode);
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Content-Length", String(body.length));
    response.end(body);
    return;
  }

  if (acceptsEncoding(request, "br")) {
    const compressed = brotliCompressSync(body, {
      params: {
        [zlibConstants.BROTLI_PARAM_QUALITY]: 4
      }
    });
    response.status(statusCode);
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Content-Encoding", "br");
    response.setHeader("Content-Length", String(compressed.length));
    response.end(compressed);
    return;
  }

  if (acceptsEncoding(request, "gzip")) {
    const compressed = gzipSync(body, { level: 6 });
    response.status(statusCode);
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Content-Encoding", "gzip");
    response.setHeader("Content-Length", String(compressed.length));
    response.end(compressed);
    return;
  }

  response.status(statusCode);
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Content-Length", String(body.length));
  response.end(body);
}

function mapHostStats(state) {
  return {
    clientCount: state.clientCount,
    pendingApprovals: state.pendingApprovals,
    serviceStatus: state.status,
    codexReady: state.codexReady,
    errorMessage: state.errorMessage,
    workspacePath: state.workspacePath
  };
}

function getBearerToken(headerValue) {
  if (!headerValue) {
    return "";
  }

  const [scheme, token] = headerValue.split(" ");
  if (scheme !== "Bearer" || !token) {
    return "";
  }

  return token.trim();
}

function isRemoteImageUrl(value) {
  return /^https?:\/\//i.test(String(value || ""));
}

function parseDataUrl(value) {
  const match = /^data:([^;,]+)(?:;[^,]*)?;base64,(.+)$/is.exec(String(value || ""));
  if (!match) {
    return null;
  }

  try {
    return {
      mimeType: match[1].trim() || "application/octet-stream",
      buffer: Buffer.from(match[2], "base64")
    };
  } catch {
    return null;
  }
}

function extensionForMimeType(mimeType) {
  return IMAGE_EXTENSION_BY_MIME[String(mimeType || "").toLowerCase()] || "bin";
}

function isPngBuffer(buffer) {
  return Buffer.isBuffer(buffer) && buffer.length >= PNG_SIGNATURE.length && buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
}

function shouldReencodeAssetBuffer(buffer, mimeType) {
  return String(mimeType || "").toLowerCase() === "image/png" && isPngBuffer(buffer);
}

function createCrc32Table() {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
}

const CRC32_TABLE = createCrc32Table();

function crc32(buffer) {
  let value = 0xffffffff;
  for (const byte of buffer) {
    value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function stripPngAncillaryChunks(buffer) {
  if (!isPngBuffer(buffer)) {
    return buffer;
  }

  const parts = [PNG_SIGNATURE];
  let offset = PNG_SIGNATURE.length;
  let changed = false;

  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const chunkTypeOffset = offset + 4;
    const chunkDataOffset = chunkTypeOffset + 4;
    const chunkCrcOffset = chunkDataOffset + length;
    const nextOffset = chunkCrcOffset + 4;

    if (nextOffset > buffer.length) {
      return buffer;
    }

    const chunkTypeBuffer = buffer.subarray(chunkTypeOffset, chunkDataOffset);
    const chunkType = chunkTypeBuffer.toString("latin1");
    const chunkData = buffer.subarray(chunkDataOffset, chunkCrcOffset);

    if (PNG_PRESERVED_CHUNKS.has(chunkType)) {
      const chunk = Buffer.allocUnsafe(length + 12);
      chunk.writeUInt32BE(length, 0);
      chunkTypeBuffer.copy(chunk, 4);
      chunkData.copy(chunk, 8);
      chunk.writeUInt32BE(crc32(Buffer.concat([chunkTypeBuffer, chunkData])), length + 8);
      parts.push(chunk);
    } else {
      changed = true;
    }

    offset = nextOffset;
    if (chunkType === "IEND") {
      break;
    }
  }

  return changed ? Buffer.concat(parts) : buffer;
}

async function reencodeAssetBuffer(buffer, mimeType) {
  const normalizedMimeType = String(mimeType || "").toLowerCase();
  if (normalizedMimeType === "image/png") {
    return stripPngAncillaryChunks(buffer);
  }
  const outputFormat = SIPS_FORMAT_BY_MIME[normalizedMimeType];
  if (!outputFormat) {
    return buffer;
  }

  const tempDir = await mkdtemp(path.join(tmpdir(), "codex-host-asset-"));
  const inputPath = path.join(tempDir, `source.${extensionForMimeType(normalizedMimeType)}`);
  const outputExtension = outputFormat === "jpeg" ? "jpg" : outputFormat;
  const outputPath = path.join(tempDir, `normalized.${outputExtension}`);

  try {
    await writeFile(inputPath, buffer);
    await execFileAsync(SIPS_BINARY_PATH, ["-s", "format", outputFormat, inputPath, "--out", outputPath], {
      maxBuffer: 16 * 1024 * 1024
    });
    const normalizedBuffer = await readFile(outputPath);
    return normalizedBuffer.length > 0 ? normalizedBuffer : buffer;
  } catch {
    return buffer;
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function convertImageBuffer(buffer, inputMimeType, outputMimeType, options = {}) {
  const normalizedInputMimeType = String(inputMimeType || "").toLowerCase();
  const normalizedOutputMimeType = String(outputMimeType || "").toLowerCase();
  const outputFormat = SIPS_FORMAT_BY_MIME[normalizedOutputMimeType];
  if (!outputFormat) {
    return buffer;
  }

  const tempDir = await mkdtemp(path.join(tmpdir(), "codex-host-convert-"));
  const inputPath = path.join(tempDir, `source.${extensionForMimeType(normalizedInputMimeType)}`);
  const outputExtension = outputFormat === "jpeg" ? "jpg" : outputFormat;
  const outputPath = path.join(tempDir, `converted.${outputExtension}`);

  try {
    await writeFile(inputPath, buffer);
    const command = [inputPath, "-s", "format", outputFormat];

    if (outputFormat === "jpeg") {
      command.push("-s", "formatOptions", String(options.quality || MOBILE_FRIENDLY_JPEG_QUALITY));
      if (Number(options.maxEdge) > 0) {
        command.push("--resampleHeightWidthMax", String(options.maxEdge));
      }
    }

    command.push("--out", outputPath);

    await execFileAsync(SIPS_BINARY_PATH, command, {
      maxBuffer: 16 * 1024 * 1024
    });
    const convertedBuffer = await readFile(outputPath);
    return convertedBuffer.length > 0 ? convertedBuffer : buffer;
  } catch {
    return buffer;
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

export class HostService extends EventEmitter {
  constructor(options = {}) {
    super();
    this.server = null;
    this.httpApp = null;
    this.wsServer = null;
    this.clients = new Set();
    this.codexBridge = new CodexBridge({
      autoApprove: options.autoApprove,
      bypassPermissions: options.bypassPermissions
    });
    this.token = "";
    this.port = 333;
    this.workspacePath = "";
    this.bypassPermissions = options.bypassPermissions !== false;
    this.hardDeletedThreadIds = new Set();
    this.assetDirectory = options.assetDirectory || path.join(process.cwd(), ".codex-mobile-assets");
    this.assetIndex = new Map();
    this.onWorkspacePathChange =
      typeof options.onWorkspacePathChange === "function" ? options.onWorkspacePathChange : () => {};
    this.state = {
      status: "stopped",
      errorMessage: "",
      clientCount: 0,
      codexReady: false,
      pendingApprovals: 0
    };

    this.codexBridge.on("state-changed", () => {
      this.emitState({
        codexReady: this.codexBridge.getState().ready,
        pendingApprovals: this.codexBridge.getState().pendingApprovals
      });
    });

    this.codexBridge.on("bridge-error", (message) => {
      this.emitState({
        errorMessage: message
      });
      this.broadcast("thread.error", {
        message
      });
    });

    this.codexBridge.on("thread-started", ({ thread }) => {
      this.broadcast("thread.created", {
        thread
      });
    });

    this.codexBridge.on("thread-status", ({ threadId, status, rawStatus }) => {
      if (this.isThreadHardDeleted(threadId)) {
        return;
      }

      this.broadcast("thread.updated", {
        threadId,
        status,
        rawStatus
      });
    });

    this.codexBridge.on("turn-started", (payload) => {
      if (this.isThreadHardDeleted(payload.threadId)) {
        return;
      }

      this.broadcast("turn.started", payload);
    });

    this.codexBridge.on("turn-completed", (payload) => {
      if (this.isThreadHardDeleted(payload.threadId)) {
        return;
      }

      this.broadcast("turn.completed", payload);
    });

    this.codexBridge.on("message-delta", (payload) => {
      if (this.isThreadHardDeleted(payload.threadId)) {
        return;
      }

      this.broadcast("message.delta", payload);
    });

    this.codexBridge.on("message-completed", (payload) => {
      if (this.isThreadHardDeleted(payload.threadId)) {
        return;
      }

      this.broadcast("message.completed", payload);
    });

    this.codexBridge.on("approval-required", (approval) => {
      if (approval.threadId && this.isThreadHardDeleted(approval.threadId)) {
        return;
      }

      this.broadcast("approval.required", approval);
    });

    this.codexBridge.on("approval-resolved", (payload) => {
      if (payload.threadId && this.isThreadHardDeleted(payload.threadId)) {
        return;
      }

      this.broadcast("approval.resolved", payload);
    });

    this.codexBridge.on("turn-error", (payload) => {
      if (payload.threadId && this.isThreadHardDeleted(payload.threadId)) {
        return;
      }

      this.broadcast("thread.error", payload);
    });
  }

  getState() {
    return {
      ...this.state,
      port: this.port,
      workspacePath: this.workspacePath
    };
  }

  emitState(nextState) {
    this.state = {
      ...this.state,
      ...nextState
    };
    if (this.clients.size > 0) {
      this.broadcast("host.state", {
        clientCount: this.state.clientCount,
        pendingApprovals: this.state.pendingApprovals,
        serviceStatus: this.state.status,
        codexReady: this.state.codexReady,
        errorMessage: this.state.errorMessage,
        workspacePath: this.workspacePath
      });
    }
    this.emit("state-changed", this.getState());
  }

  broadcast(type, payload = {}) {
    const data = jsonMessage(type, payload);
    for (const client of this.clients) {
      if (client.readyState === 1) {
        client.send(data);
      }
    }
  }

  async buildBootstrapPayload() {
    const [threads, approvals] = await Promise.all([
      this.codexBridge.listThreads({ cwd: this.workspacePath }),
      Promise.resolve(
        this.codexBridge
          .listPendingApprovals()
          .filter((approval) => !approval.threadId || !this.isThreadHardDeleted(approval.threadId))
      )
    ]);

    return {
      stats: mapHostStats(this.getState()),
      threads: this.filterHardDeletedThreads(threads),
      approvals
    };
  }

  buildAssetUrl(assetId) {
    return `/api/assets/${encodeURIComponent(assetId)}?token=${encodeURIComponent(this.token)}`;
  }

  async materializeDataUrlAsset(sourceUrl, preferredMimeType = "", options = {}) {
    const parsed = parseDataUrl(sourceUrl);
    if (!parsed) {
      return null;
    }

    let mimeType = String(preferredMimeType || parsed.mimeType || "").toLowerCase() || "application/octet-stream";
    let normalizedBuffer = shouldReencodeAssetBuffer(parsed.buffer, mimeType)
      ? await reencodeAssetBuffer(parsed.buffer, mimeType)
      : parsed.buffer;

    if (options.preferJpeg && mimeType === "image/png") {
      const jpegBuffer = await convertImageBuffer(normalizedBuffer, mimeType, "image/jpeg", {
        maxEdge: options.maxEdge || MOBILE_FRIENDLY_JPEG_MAX_EDGE,
        quality: options.quality || MOBILE_FRIENDLY_JPEG_QUALITY
      });
      if (jpegBuffer !== normalizedBuffer) {
        normalizedBuffer = jpegBuffer;
        mimeType = "image/jpeg";
      }
    }

    const assetId =
      createHash("sha1")
        .update(mimeType)
        .update("\n")
        .update(normalizedBuffer)
        .digest("hex");
    const filePath = path.join(this.assetDirectory, `${assetId}.${extensionForMimeType(mimeType)}`);

    this.assetIndex.set(assetId, {
      filePath,
      mimeType
    });

    if (!existsSync(filePath)) {
      await mkdir(this.assetDirectory, { recursive: true });
      await writeFile(filePath, normalizedBuffer);
    }

    return {
      id: assetId,
      url: this.buildAssetUrl(assetId),
      mimeType
    };
  }

  async materializeClientImages(images = []) {
    const resolved = [];

    for (const [index, image] of images.entries()) {
      const sourceUrl = String(image?.sourceUrl || image?.url || "").trim();
      if (!sourceUrl) {
        continue;
      }

      const imageId = String(image?.id || `img_${index + 1}`);
      const mimeType = String(image?.mimeType || "").trim();

      if (sourceUrl.startsWith("data:")) {
        const asset = await this.materializeDataUrlAsset(sourceUrl, mimeType, {
          preferJpeg: image?.preferJpeg === true
        });
        if (asset) {
          resolved.push(asset);
        }
        continue;
      }

      if (isRemoteImageUrl(sourceUrl)) {
        resolved.push({
          id: imageId,
          url: sourceUrl,
          mimeType
        });
      }
    }

    return resolved;
  }

  async prepareThreadForClient(thread) {
    const items = await Promise.all(
      (thread.items || []).map(async (item) => {
        if (!Array.isArray(item.images) || item.images.length === 0) {
          return item;
        }

        return {
          ...item,
          images: await this.materializeClientImages(item.images)
        };
      })
    );

    return {
      ...thread,
      items
    };
  }

  isAuthorized(request) {
    const headerToken = getBearerToken(request.headers.authorization);
    const queryToken = new URL(request.url, "http://localhost").searchParams.get("token") || "";
    return headerToken === this.token || queryToken === this.token;
  }

  isThreadHardDeleted(threadId) {
    return this.hardDeletedThreadIds.has(String(threadId));
  }

  markThreadHardDeleted(threadId) {
    this.hardDeletedThreadIds.add(String(threadId));
  }

  filterHardDeletedThreads(threads = []) {
    return threads.filter((thread) => !this.isThreadHardDeleted(thread.id));
  }

  sendThreadNotFound(response) {
    response.status(404).json({
      ok: false,
      message: "会话不存在"
    });
  }

  summarizeRemainingArtifacts(inspection) {
    const names = [
      ...inspection.archivedFiles.map((value) => value.split("/").pop()),
      ...inspection.sessionFiles.map((value) => value.split("/").pop()),
      ...inspection.shellSnapshots.map((value) => value.split("/").pop())
    ];

    if (inspection.sessionIndexEntries > 0) {
      names.push(`session_index.jsonl x${inspection.sessionIndexEntries}`);
    }

    return names.slice(0, 6).join("、");
  }

  async purgeThreadArtifactsWithRetries(threadId) {
    let lastPurgeResult = null;
    let lastInspection = null;

    for (let attempt = 0; attempt < PURGE_RETRY_ATTEMPTS; attempt += 1) {
      lastPurgeResult = await purgeThreadArtifacts(threadId);

      await delay(PURGE_RETRY_DELAY_MS);
      lastInspection = await inspectThreadArtifacts(threadId);

      if (lastInspection.totalMatches === 0) {
        await delay(PURGE_SETTLE_DELAY_MS);
        lastInspection = await inspectThreadArtifacts(threadId);

        if (lastInspection.totalMatches === 0) {
          return {
            ...lastPurgeResult,
            attempts: attempt + 1
          };
        }
      }
    }

    const remainingSummary = lastInspection ? this.summarizeRemainingArtifacts(lastInspection) : "";
    throw new Error(remainingSummary || "仍有归档文件残留");
  }

  async updateWorkspacePath(workspacePath) {
    const normalizedPath = String(workspacePath || "").trim();
    if (!normalizedPath) {
      throw new Error("工作目录不能为空");
    }
    if (!existsSync(normalizedPath)) {
      throw new Error("工作目录不存在");
    }

    const stat = statSync(normalizedPath);
    if (!stat.isDirectory()) {
      throw new Error("工作目录必须是文件夹");
    }

    const previousPath = this.workspacePath;
    this.workspacePath = normalizedPath;
    this.onWorkspacePathChange(normalizedPath);

    if (
      this.server &&
      this.state.status === "running" &&
      this.codexBridge.getState().ready &&
      previousPath &&
      previousPath !== normalizedPath
    ) {
      await this.codexBridge.restartBridge();
    }

    this.emitState({});
    return this.workspacePath;
  }

  async updateBypassPermissions(enabled) {
    const nextValue = Boolean(enabled);
    const changed = this.bypassPermissions !== nextValue;
    this.bypassPermissions = nextValue;
    this.codexBridge.setBypassPermissions(nextValue);

    if (changed && this.server && this.state.status === "running" && this.codexBridge.getState().ready) {
      await this.codexBridge.restartBridge();
    }

    this.emitState({});
    return this.bypassPermissions;
  }

  async start({ port, token, workspacePath, bypassPermissions }) {
    if (this.server) {
      return this.getState();
    }

    this.port = port;
    this.token = token;
    await this.updateBypassPermissions(bypassPermissions);
    await this.updateWorkspacePath(workspacePath);
    this.emitState({
      status: "starting",
      errorMessage: ""
    });

    this.httpApp = express();
    this.httpApp.disable("x-powered-by");
    this.httpApp.use(express.json({ limit: "12mb" }));
    this.httpApp.use((request, response, next) => {
      response.setHeader("Cache-Control", "no-store");
      response.setHeader("X-Content-Type-Options", "nosniff");
      next();
    });

    this.httpApp.get("/api/health", (_request, response) => {
      response.json({
        ok: true,
        service: this.state.status,
        codex: this.state.codexReady ? "已连接" : "未连接",
        wsPath: "/ws"
      });
    });

    this.httpApp.use("/api", (request, response, next) => {
      if (!this.isAuthorized(request)) {
        response.status(401).json({
          ok: false,
          message: "访问令牌无效"
        });
        return;
      }

      next();
    });

    this.httpApp.post("/api/connect/test", (_request, response) => {
      response.json({
        ok: true,
        deviceName: "CodeX桌面端by.冰点零度",
        codexReady: this.codexBridge.getState().ready
      });
    });

    this.httpApp.get("/api/config", (_request, response) => {
      response.json({
        ok: true,
        port: this.port,
        ...mapHostStats(this.getState())
      });
    });

    this.httpApp.get("/api/bootstrap", (request, response) => {
      this.buildBootstrapPayload()
        .then((payload) => {
          sendCompressedJson(request, response, 200, {
            ok: true,
            ...payload
          });
        })
        .catch((error) => {
          sendJson(response, 500, {
            ok: false,
            message: error.message
          });
        });
    });

    this.httpApp.post("/api/config/workspace", async (request, response) => {
      try {
        const workspacePath = await this.updateWorkspacePath(request.body?.workspacePath);
        response.json({
          ok: true,
          workspacePath
        });
      } catch (error) {
        response.status(400).json({
          ok: false,
          message: error.message || "工作目录设置失败"
        });
      }
    });

    this.httpApp.get("/api/assets/:assetId", (request, response) => {
      const asset = this.assetIndex.get(String(request.params.assetId));
      if (!asset || !existsSync(asset.filePath)) {
        sendJson(response, 404, {
          ok: false,
          message: "图片资源不存在"
        });
        return;
      }

      if (asset.mimeType) {
        response.type(asset.mimeType);
      }

      response.sendFile(asset.filePath, (error) => {
        if (!error || response.headersSent) {
          return;
        }

        sendJson(response, error.statusCode || 500, {
          ok: false,
          message: "图片资源读取失败"
        });
      });
    });

    this.httpApp.get("/api/threads", (request, response) => {
      this.codexBridge
        .listThreads({ cwd: this.workspacePath })
        .then((threads) => {
          sendCompressedJson(request, response, 200, {
            ok: true,
            threads: this.filterHardDeletedThreads(threads)
          });
        })
        .catch((error) => {
          sendJson(response, 500, {
            ok: false,
            message: error.message
          });
        });
    });

    this.httpApp.get("/api/threads/:id", (request, response) => {
      if (this.isThreadHardDeleted(request.params.id)) {
        this.sendThreadNotFound(response);
        return;
      }

      this.codexBridge
        .readThread(request.params.id)
        .then((thread) => this.prepareThreadForClient(thread))
        .then((thread) => {
          sendCompressedJson(request, response, 200, {
            ok: true,
            thread
          });
        })
        .catch((error) => {
          sendJson(response, 500, {
            ok: false,
            message: error.message
          });
        });
    });

    this.httpApp.post("/api/threads", (request, response) => {
      this.codexBridge
        .createThread({
          cwd: this.workspacePath,
          title: request.body?.title || null
        })
        .then((thread) => {
          response.json({
            ok: true,
            thread
          });
        })
        .catch((error) => {
          response.status(500).json({
            ok: false,
            message: error.message
          });
        });
    });

    this.httpApp.post("/api/threads/:id/message", (request, response) => {
      if (this.isThreadHardDeleted(request.params.id)) {
        this.sendThreadNotFound(response);
        return;
      }

      const text = typeof request.body?.text === "string" ? request.body.text : "";
      const images = Array.isArray(request.body?.images)
        ? request.body.images.filter((value) => typeof value === "string" && value.length > 0)
        : [];
      const files = Array.isArray(request.body?.files)
        ? request.body.files
            .filter((file) => file && typeof file === "object")
            .map((file) => ({
              name: typeof file.name === "string" ? file.name.trim() : "",
              mimeType: typeof file.mimeType === "string" ? file.mimeType.trim() : "",
              dataUrl: typeof file.dataUrl === "string" ? file.dataUrl.trim() : ""
            }))
            .filter((file) => file.name && file.dataUrl)
        : [];

      if (!text.trim() && images.length === 0 && files.length === 0) {
        response.status(400).json({
          ok: false,
          message: "缺少消息内容"
        });
        return;
      }

      this.codexBridge
        .sendMessage({
          threadId: request.params.id,
          text,
          images,
          files
        })
        .then((result) => {
          response.json({
            ok: true,
            ...result
          });
        })
        .catch((error) => {
          response.status(500).json({
            ok: false,
            message: error.message
          });
        });
    });

    this.httpApp.post("/api/threads/:id/interrupt", (request, response) => {
      if (this.isThreadHardDeleted(request.params.id)) {
        this.sendThreadNotFound(response);
        return;
      }

      this.codexBridge
        .interruptThread(request.params.id)
        .then((result) => {
          response.json({
            ok: true,
            ...result
          });
        })
        .catch((error) => {
          response.status(400).json({
            ok: false,
            message: error.message
          });
        });
    });

    this.httpApp.delete("/api/threads/:id", async (request, response) => {
      const threadId = String(request.params.id);

      if (this.isThreadHardDeleted(threadId)) {
        response.json({
          ok: true,
          threadId
        });
        return;
      }

      try {
        await this.codexBridge.archiveThread(threadId);
      } catch (error) {
        response.status(500).json({
          ok: false,
          message: error.message
        });
        return;
      }

      try {
        const purgeResult = await this.purgeThreadArtifactsWithRetries(threadId);
        this.markThreadHardDeleted(threadId);
        this.broadcast("thread.deleted", { threadId });
        response.json({
          ok: true,
          threadId,
          purge: purgeResult
        });
      } catch (error) {
        response.status(500).json({
          ok: false,
          message: `已归档，但彻底删除未完成：${error.message}`
        });
      }
    });

    this.httpApp.get("/api/approvals", (_request, response) => {
      response.json({
        ok: true,
        approvals: this.codexBridge
          .listPendingApprovals()
          .filter((approval) => !approval.threadId || !this.isThreadHardDeleted(approval.threadId))
      });
    });

    this.httpApp.post("/api/approvals/:id/respond", (request, response) => {
      this.codexBridge
        .resolveApproval({
          requestId: request.params.id,
          decision: request.body?.decision,
          answers: request.body?.answers
        })
        .then((result) => {
          response.json(result);
        })
        .catch((error) => {
          response.status(400).json({
            ok: false,
            message: error.message
          });
        });
    });

    this.server = http.createServer(this.httpApp);
    this.wsServer = new WebSocketServer({ noServer: true });

    this.server.on("upgrade", (request, socket, head) => {
      if (!request.url?.startsWith("/ws")) {
        socket.destroy();
        return;
      }

      if (!this.isAuthorized(request)) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      this.wsServer.handleUpgrade(request, socket, head, (ws) => {
        this.wsServer.emit("connection", ws, request);
      });
    });

    this.wsServer.on("connection", (ws) => {
      this.clients.add(ws);
      this.emitState({ clientCount: this.clients.size });

      ws.send(
        jsonMessage("connected", {
          message: "已连接到 CodeX桌面端by.冰点零度",
          status: this.state.status,
          codexReady: this.state.codexReady
        })
      );

      ws.on("message", (data) => {
        const text = data.toString();
        if (text === "ping") {
          ws.send(jsonMessage("pong"));
        }
      });

      ws.on("close", () => {
        this.clients.delete(ws);
        this.emitState({ clientCount: this.clients.size });
      });
    });

    await new Promise((resolve, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.port, "0.0.0.0", () => {
        this.server.off("error", reject);
        resolve();
      });
    }).catch((error) => {
      this.server = null;
      this.wsServer = null;
      this.emitState({
        status: "error",
        errorMessage: error.code === "EADDRINUSE" ? `端口 ${this.port} 已被占用` : error.message
      });
      throw error;
    });

    try {
      await this.codexBridge.start({
        workspacePath: this.workspacePath
      });
    } catch (error) {
      await new Promise((resolve) => {
        this.server.close(() => resolve());
      });
      this.server = null;
      this.wsServer = null;
      this.emitState({
        status: "error",
        errorMessage: error.message,
        codexReady: false
      });
      throw error;
    }

    this.emitState({
      status: "running",
      errorMessage: "",
      codexReady: this.codexBridge.getState().ready,
      pendingApprovals: this.codexBridge.getState().pendingApprovals
    });

    return this.getState();
  }

  async stop() {
    if (!this.server) {
      this.emitState({
        status: "stopped",
        errorMessage: "",
        clientCount: 0,
        codexReady: false,
        pendingApprovals: 0
      });
      return this.getState();
    }

    this.emitState({
      status: "stopping",
      errorMessage: ""
    });

    for (const client of this.clients) {
      client.close(4000, "服务已停止");
    }
    this.clients.clear();

    await new Promise((resolve) => {
      this.wsServer.close(() => {
        resolve();
      });
    });

    await new Promise((resolve, reject) => {
      this.server.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });

    await this.codexBridge.stop();

    this.server = null;
    this.httpApp = null;
    this.wsServer = null;

    this.emitState({
      status: "stopped",
      errorMessage: "",
      clientCount: 0,
      codexReady: false,
      pendingApprovals: 0
    });

    return this.getState();
  }

  updateToken(token) {
    this.token = token;

    for (const client of this.clients) {
      client.send(
        jsonMessage("token_reset", {
          message: "访问令牌已重置，请重新连接。"
        })
      );
      client.close(4001, "访问令牌已重置");
    }

    this.clients.clear();
    this.emitState({ clientCount: 0 });
    return this.getState();
  }
}
