import fs from "node:fs";
import path from "node:path";
import { generateToken } from "./service/token.js";

export class ConfigStore {
  constructor({ app }) {
    this.app = app;
    this.filePath = path.join(app.getPath("userData"), "host-config.json");
    this.config = this.load();
  }

  defaults() {
    return {
      port: 333,
      token: generateToken(20),
      workspacePath: this.app.getPath("documents"),
      launchAtLogin: false,
      autoStartService: false,
      bypassPermissions: true,
      autoApprove: true
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

      if (Object.prototype.hasOwnProperty.call(merged, "deletedThreadIds")) {
        delete merged.deletedThreadIds;
      }

      merged.autoApprove = Boolean(merged.autoApprove);
      merged.bypassPermissions = Boolean(merged.bypassPermissions);

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
