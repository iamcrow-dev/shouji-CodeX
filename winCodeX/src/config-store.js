import fs from "node:fs";
import path from "node:path";
import { DEFAULT_PORT, normalizePort } from "./service/port.js";
import { generateToken } from "./service/token.js";

export class ConfigStore {
  constructor({ app }) {
    this.app = app;
    this.filePath = path.join(app.getPath("userData"), "host-config.json");
    this.config = this.load();
  }

  defaults() {
    return {
      port: DEFAULT_PORT,
      token: generateToken(20),
      workspacePath: this.app.getPath("documents"),
      codexBinaryPath: "",
      launchAtLogin: false,
      autoStartService: false,
      bypassPermissions: true,
      autoApprove: true,
      deletedThreadIds: []
    };
  }

  load() {
    const defaults = this.defaults();

    try {
      if (!fs.existsSync(this.filePath)) {
        this.write(defaults);
        return defaults;
      }

      const raw = fs.readFileSync(this.filePath, "utf8");
      const parsed = JSON.parse(raw);
      const merged = {
        ...defaults,
        ...parsed
      };

      if (!merged.token || typeof merged.token !== "string" || merged.token.length !== 20) {
        merged.token = generateToken(20);
      }

      if (!Array.isArray(merged.deletedThreadIds)) {
        merged.deletedThreadIds = [];
      } else {
        merged.deletedThreadIds = merged.deletedThreadIds.filter((value) => typeof value === "string" && value);
      }

      merged.autoApprove = Boolean(merged.autoApprove);
      merged.bypassPermissions = Boolean(merged.bypassPermissions);
      merged.port = normalizePort(merged.port, defaults.port);
      merged.codexBinaryPath = typeof merged.codexBinaryPath === "string" ? merged.codexBinaryPath.trim() : "";

      this.write(merged);
      return merged;
    } catch {
      this.write(defaults);
      return defaults;
    }
  }

  write(value) {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(value, null, 2));
  }

  get() {
    return { ...this.config };
  }

  update(nextPartial) {
    this.config = {
      ...this.config,
      ...nextPartial
    };
    this.write(this.config);
    return this.get();
  }
}
