# 用手机连上电脑的codex进行聊天和发任务
#### 界面直观简单一看就懂，缺失的功能以后补上
#### windows的桌面版也做好了，增加bypass permissions（绕过审批）模式
#### 手机和电脑不在同一局域网的时候，通常需要用端口映射到公网，自己想办法吧
#### 聊天页面对话超过200条，进入的时候加载时间会长一点是正常现象
![桌面端界面](https://github.com/iamcrow-dev/shouji-CodeX/blob/main/%E6%97%A0%E6%A0%87%E9%A2%98.png)
![手机界面](https://github.com/iamcrow-dev/shouji-CodeX/blob/main/Screenshot_2026-03-20-13-51-59-957_com.qwe.codexmobile.png)
![聊天页](https://github.com/iamcrow-dev/shouji-CodeX/blob/main/Screenshot_2026-03-20-17-41-43-442_com.qwe.codexmobile.png)
# CodeX 安卓手机 + 桌面端（安装与构建）

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

