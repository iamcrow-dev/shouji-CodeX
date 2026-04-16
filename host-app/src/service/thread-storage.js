import { existsSync } from "node:fs";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

const DEFAULT_CODEX_HOME = path.join(homedir(), ".codex");

function resolveCodexHome(codexHome) {
  if (typeof codexHome === "string" && codexHome.trim()) {
    return codexHome.trim();
  }

  if (typeof process.env.CODEX_HOME === "string" && process.env.CODEX_HOME.trim()) {
    return process.env.CODEX_HOME.trim();
  }

  return DEFAULT_CODEX_HOME;
}

function isThreadRolloutFile(fileName, threadId) {
  return fileName.startsWith("rollout-") && fileName.endsWith(`${threadId}.jsonl`);
}

function isThreadShellSnapshot(fileName, threadId) {
  return fileName.startsWith(`${threadId}.`) && fileName.endsWith(".sh");
}

async function collectMatchingFiles(rootDir, matcher) {
  if (!existsSync(rootDir)) {
    return [];
  }

  const matches = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const currentDir = stack.pop();
    let entries = [];

    try {
      entries = await readdir(currentDir, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") {
        continue;
      }
      throw error;
    }

    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
        continue;
      }

      if (entry.isFile() && matcher(entry.name, fullPath)) {
        matches.push(fullPath);
      }
    }
  }

  return matches;
}

async function removeMatchingSessionIndexEntries(sessionIndexPath, threadId) {
  if (!existsSync(sessionIndexPath)) {
    return 0;
  }

  const raw = await readFile(sessionIndexPath, "utf8");
  const lines = raw.split(/\r?\n/);
  const keptLines = [];
  let removedEntries = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    try {
      const parsed = JSON.parse(line);
      if (String(parsed?.id || "") === threadId) {
        removedEntries += 1;
        continue;
      }
    } catch {
      // Keep unknown lines intact rather than corrupting the index.
    }

    keptLines.push(line);
  }

  if (removedEntries > 0) {
    const nextContent = keptLines.length > 0 ? `${keptLines.join("\n")}\n` : "";
    await writeFile(sessionIndexPath, nextContent, "utf8");
  }

  return removedEntries;
}

async function countMatchingSessionIndexEntries(sessionIndexPath, threadId) {
  if (!existsSync(sessionIndexPath)) {
    return 0;
  }

  const raw = await readFile(sessionIndexPath, "utf8");
  let count = 0;

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) {
      continue;
    }

    try {
      const parsed = JSON.parse(line);
      if (String(parsed?.id || "") === threadId) {
        count += 1;
      }
    } catch {
      // Ignore malformed lines when only inspecting the index.
    }
  }

  return count;
}

export async function inspectThreadArtifacts(threadId, options = {}) {
  const normalizedThreadId = String(threadId || "").trim();
  if (!normalizedThreadId) {
    throw new Error("缺少线程 ID");
  }

  const codexHome = resolveCodexHome(options.codexHome);
  const archivedSessionsDir = path.join(codexHome, "archived_sessions");
  const sessionsDir = path.join(codexHome, "sessions");
  const shellSnapshotsDir = path.join(codexHome, "shell_snapshots");
  const sessionIndexPath = path.join(codexHome, "session_index.jsonl");

  const [archivedFiles, sessionFiles, shellSnapshots, sessionIndexEntries] = await Promise.all([
    collectMatchingFiles(archivedSessionsDir, (fileName) => isThreadRolloutFile(fileName, normalizedThreadId)),
    collectMatchingFiles(sessionsDir, (fileName) => isThreadRolloutFile(fileName, normalizedThreadId)),
    collectMatchingFiles(shellSnapshotsDir, (fileName) => isThreadShellSnapshot(fileName, normalizedThreadId)),
    countMatchingSessionIndexEntries(sessionIndexPath, normalizedThreadId)
  ]);

  return {
    threadId: normalizedThreadId,
    codexHome,
    archivedFiles,
    sessionFiles,
    shellSnapshots,
    sessionIndexEntries,
    totalMatches: archivedFiles.length + sessionFiles.length + shellSnapshots.length + sessionIndexEntries
  };
}

export async function purgeThreadArtifacts(threadId, options = {}) {
  const normalizedThreadId = String(threadId || "").trim();
  if (!normalizedThreadId) {
    throw new Error("缺少线程 ID");
  }

  const codexHome = resolveCodexHome(options.codexHome);
  const archivedSessionsDir = path.join(codexHome, "archived_sessions");
  const sessionsDir = path.join(codexHome, "sessions");
  const shellSnapshotsDir = path.join(codexHome, "shell_snapshots");
  const sessionIndexPath = path.join(codexHome, "session_index.jsonl");

  const [archivedFiles, sessionFiles, shellSnapshots] = await Promise.all([
    collectMatchingFiles(archivedSessionsDir, (fileName) => isThreadRolloutFile(fileName, normalizedThreadId)),
    collectMatchingFiles(sessionsDir, (fileName) => isThreadRolloutFile(fileName, normalizedThreadId)),
    collectMatchingFiles(shellSnapshotsDir, (fileName) => isThreadShellSnapshot(fileName, normalizedThreadId))
  ]);

  const filesToRemove = [...new Set([...archivedFiles, ...sessionFiles, ...shellSnapshots])];
  const failures = [];

  for (const filePath of filesToRemove) {
    try {
      await rm(filePath, { force: true });
    } catch (error) {
      failures.push(`${path.basename(filePath)}：${error?.message || String(error)}`);
    }
  }

  let removedIndexEntries = 0;
  try {
    removedIndexEntries = await removeMatchingSessionIndexEntries(sessionIndexPath, normalizedThreadId);
  } catch (error) {
    failures.push(`session_index.jsonl：${error?.message || String(error)}`);
  }

  if (failures.length > 0) {
    throw new Error(failures.join("；"));
  }

  return {
    threadId: normalizedThreadId,
    codexHome,
    removedFiles: filesToRemove.length,
    removedIndexEntries
  };
}
