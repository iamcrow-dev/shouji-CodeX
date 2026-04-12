# CodeX 手机 + 桌面端（安装与构建）

这个目录包含两部分：

- `host-app`：桌面端 Host 服务（Electron）
- `android-client`：安卓手机客户端（Jetpack Compose）

## 目录结构

```text
codex/
  host-app/
  android-client/
```

## 环境要求

### 桌面端 `host-app`

- macOS（当前产物为 arm64）
- Node.js（建议 20+）
- npm
- 已安装 `Codex.app`（路径：`/Applications/Codex.app`）

### 安卓端 `android-client`

- Android Studio（已验证可用）
- Android SDK（`compileSdk 36`）
- JDK（可直接使用 Android Studio 自带 JBR）

