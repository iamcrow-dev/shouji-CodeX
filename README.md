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

## 桌面端安装与构建

### 本地运行（开发）

```bash
cd /Users/qwe/Documents/codex/host-app
export PATH="/usr/local/bin:$PATH"
npm install
npm start
```

### 打包

```bash
cd /Users/qwe/Documents/codex/host-app
export PATH="/usr/local/bin:$PATH"
npm run dist:mac
```

打包产物：

- `host-app/dist/CodeX桌面端by.冰点零度-1.1.0-arm64.dmg`
- `host-app/dist/CodeX桌面端by.冰点零度-1.1.0-arm64.zip`
- 可直接覆盖安装的 app：`host-app/dist/mac-arm64/CodeX桌面端by.冰点零度.app`

### 替换已安装桌面端（可选）

```bash
pkill -f "/Applications/CodeX桌面端by.冰点零度.app" || true
rm -rf "/Applications/CodeX桌面端by.冰点零度.app"
cp -R "/Users/qwe/Documents/codex/host-app/dist/mac-arm64/CodeX桌面端by.冰点零度.app" "/Applications/CodeX桌面端by.冰点零度.app"
open -a "/Applications/CodeX桌面端by.冰点零度.app"
```

## 安卓端安装与构建

### Android Studio 安装运行（推荐）

1. 打开 `android-client` 工程。
2. 同步 Gradle。
3. 连接手机后直接运行 `app`（Debug）。

### 命令行构建 Release APK

```bash
cd /Users/qwe/Documents/codex/android-client
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export PATH="/usr/local/bin:$JAVA_HOME/bin:$PATH"
./gradlew :app:assembleRelease
```

APK 产物：

- `android-client/app/build/outputs/apk/release/app-release.apk`

## 发布到 OB 目录（当前约定）

```bash
cp -f "/Users/qwe/Documents/codex/android-client/app/build/outputs/apk/release/app-release.apk" "/Users/qwe/Documents/ob/CodeX 安装包/CodeX-手机端-1.1-release.apk"
cp -f "/Users/qwe/Documents/codex/host-app/dist/CodeX桌面端by.冰点零度-1.1.0-arm64.dmg" "/Users/qwe/Documents/ob/CodeX 安装包/CodeX桌面端by.冰点零度-1.1.0-arm64.dmg"
cp -f "/Users/qwe/Documents/codex/host-app/dist/CodeX桌面端by.冰点零度-1.1.0-arm64.zip" "/Users/qwe/Documents/ob/CodeX 安装包/CodeX桌面端by.冰点零度-1.1.0-arm64.zip"
```
