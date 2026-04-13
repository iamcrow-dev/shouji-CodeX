import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const VALIDATION_TIMEOUT_MS = 2500;
const DARWIN_DEFAULT_PATH = "/Applications/Codex.app/Contents/Resources/codex";

function normalizeCandidate(value) {
  return String(value || "").trim().replace(/^"(.*)"$/, "$1");
}

function isAccessDeniedError(error) {
  const detail = String(error?.message || "").toLowerCase();
  return error?.code === "EACCES" || detail.includes("access is denied");
}

function dedupeCandidates(values = []) {
  const seen = new Set();
  const result = [];

  for (const value of values) {
    const normalized = normalizeCandidate(value);
    if (!normalized) {
      continue;
    }

    const key = process.platform === "win32" ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(normalized);
  }

  return result;
}

function buildNotFoundResult(configuredPath = "") {
  const normalized = normalizeCandidate(configuredPath);
  const isManual = Boolean(normalized);

  return {
    ok: false,
    path: "",
    configuredPath: normalized,
    source: isManual ? "manual" : "auto",
    sourceLabel: isManual ? "手动指定" : "自动探测",
    statusLabel: isManual ? "手动路径无效" : "未找到",
    errorMessage: isManual
      ? `找不到可执行的 Codex：${normalized}`
      : "未找到可执行的 Codex，请手动指定 codex.exe 路径。",
    version: ""
  };
}

export function formatCodexLaunchError(error, candidatePath) {
  const normalized = normalizeCandidate(candidatePath);
  const detail = String(error?.message || "").trim();

  if (isAccessDeniedError(error)) {
    return `无法启动 Codex：${normalized} 没有执行权限。`;
  }

  if (error?.code === "ENOENT") {
    return `无法启动 Codex：未找到 ${normalized}。`;
  }

  if (detail) {
    return `无法启动 Codex：${detail}`;
  }

  return `无法启动 Codex：${normalized}`;
}

export async function validateCodexBinaryPath(candidatePath, source = "manual") {
  const normalized = normalizeCandidate(candidatePath);
  if (!normalized) {
    return buildNotFoundResult();
  }

  const sourceLabel = source === "manual" ? "手动指定" : "自动探测";

  if (path.isAbsolute(normalized)) {
    if (!existsSync(normalized)) {
      return {
        ok: false,
        path: "",
        configuredPath: normalized,
        source,
        sourceLabel,
        statusLabel: source === "manual" ? "手动路径无效" : "未找到",
        errorMessage: `路径不存在：${normalized}`,
        version: ""
      };
    }

    try {
      const stat = statSync(normalized);
      if (!stat.isFile()) {
        return {
          ok: false,
          path: "",
          configuredPath: normalized,
          source,
          sourceLabel,
          statusLabel: source === "manual" ? "手动路径无效" : "未找到",
          errorMessage: `不是可执行文件：${normalized}`,
          version: ""
        };
      }
    } catch (error) {
      return {
        ok: false,
        path: "",
        configuredPath: normalized,
        source,
        sourceLabel,
        statusLabel: source === "manual" ? "手动路径无效" : "未找到",
        errorMessage: formatCodexLaunchError(error, normalized),
        version: ""
      };
    }
  }

  try {
    const { stdout, stderr } = await execFileAsync(normalized, ["--version"], {
      windowsHide: true,
      timeout: VALIDATION_TIMEOUT_MS
    });
    const version = String(stdout || stderr || "").trim().split(/\r?\n/)[0] || "";

    return {
      ok: true,
      path: normalized,
      configuredPath: normalized,
      source,
      sourceLabel,
      statusLabel: "可用",
      errorMessage: "",
      version
    };
  } catch (error) {
    return {
      ok: false,
      path: "",
      configuredPath: normalized,
      source,
      sourceLabel,
      statusLabel: source === "manual" ? "手动路径无效" : "未找到",
      errorMessage: formatCodexLaunchError(error, normalized),
      version: ""
    };
  }
}

async function getPathCandidatesFromWhere() {
  if (process.platform !== "win32") {
    return [];
  }

  try {
    const { stdout } = await execFileAsync("where.exe", ["codex"], {
      windowsHide: true,
      timeout: VALIDATION_TIMEOUT_MS
    });
    return dedupeCandidates(stdout.split(/\r?\n/));
  } catch (error) {
    const fallbackStdout = String(error?.stdout || "");
    if (!fallbackStdout.trim()) {
      return [];
    }

    return dedupeCandidates(fallbackStdout.split(/\r?\n/));
  }
}

function getKnownWindowsCandidates() {
  const candidates = [];
  const localAppData = process.env.LOCALAPPDATA;
  const programFiles = process.env.ProgramFiles || "C:\\Program Files";

  if (localAppData) {
    candidates.push(path.join(localAppData, "Programs", "OpenAI Codex", "codex.exe"));
  }

  const windowsAppsPath = path.join(programFiles, "WindowsApps");
  try {
    const entries = readdirSync(windowsAppsPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith("OpenAI.Codex_")) {
        continue;
      }
      candidates.push(path.join(windowsAppsPath, entry.name, "app", "resources", "codex.exe"));
    }
  } catch {
    // WindowsApps often restricts directory listing; PATH probing covers the common case.
  }

  return dedupeCandidates(candidates);
}

async function getAutoCandidates() {
  if (process.platform === "win32") {
    const userHomeCandidate = path.join(os.homedir(), ".codex", ".sandbox-bin", "codex.exe");
    const pathCandidates = await getPathCandidatesFromWhere();
    const knownCandidates = getKnownWindowsCandidates();
    return [
      { path: userHomeCandidate, source: "auto-home", sourceLabel: "自动探测（用户目录）" },
      ...pathCandidates.map((candidate) => ({
        path: candidate,
        source: "auto-path",
        sourceLabel: "自动探测（PATH）"
      })),
      ...knownCandidates.map((candidate) => ({
        path: candidate,
        source: "auto-known",
        sourceLabel: "自动探测（已知路径）"
      }))
    ];
  }

  if (process.platform === "darwin") {
    return [
      { path: DARWIN_DEFAULT_PATH, source: "auto-known", sourceLabel: "自动探测（macOS 默认路径）" },
      { path: "codex", source: "auto-path", sourceLabel: "自动探测（PATH）" }
    ];
  }

  return [{ path: "codex", source: "auto-path", sourceLabel: "自动探测（PATH）" }];
}

export async function resolveCodexBinary({ configuredPath = "" } = {}) {
  const normalizedConfiguredPath = normalizeCandidate(configuredPath);

  if (normalizedConfiguredPath) {
    const manualResult = await validateCodexBinaryPath(normalizedConfiguredPath, "manual");
    return {
      ...manualResult,
      configuredPath: normalizedConfiguredPath,
      sourceLabel: "手动指定"
    };
  }

  const candidates = await getAutoCandidates();
  let lastError = "";

  for (const candidate of candidates) {
    const result = await validateCodexBinaryPath(candidate.path, candidate.source);
    if (result.ok) {
      return {
        ...result,
        configuredPath: "",
        sourceLabel: candidate.sourceLabel
      };
    }

    if (result.errorMessage && !isAccessDeniedError({ message: result.errorMessage })) {
      lastError = result.errorMessage;
    }
  }

  return {
    ...buildNotFoundResult(""),
    errorMessage: lastError || "未找到可执行的 Codex，请手动指定 codex.exe 路径。"
  };
}
