# CodeX 桌面端说明（Host App v1.2.0）

## 项目定位
桌面端是本地桥接服务（Electron Host App），用于把手机端请求转发到 `codex app-server`，并提供可视化控制面板。

## 功能点
1. 桌面控制面板
- 显示连接信息：服务地址、可用地址、端口、访问令牌。
- 服务控制：启动、停止、重置令牌。
- 启动选项：
  - 开机自启动
  - 启动后自动开启服务
  - 跳过审批（高权限）
- 提供复制地址、复制令牌、显示/隐藏令牌。

2. 服务能力（HostService）
- HTTP + WebSocket 双通道。
- 默认监听 `0.0.0.0:333`。
- 所有 `/api/*` 接口和 `/ws` 都要求 token 鉴权。
- 工作目录可动态更新并持久化。

3. 与 Codex 桥接（CodexBridge）
- 子进程启动：`codex app-server`。
- 通过 stdin/stdout 进行 JSON-RPC 通信。
- 支持线程与消息全链路：
  - 创建线程、恢复线程、读取线程
  - 发送文本/图片/文件
  - 中断 turn
  - 消息流式事件转发

4. 自动审批与 bypass
- `autoApprove=true` 默认自动处理审批请求。
- `bypassPermissions=true` 时新线程策略：
  - `approvalPolicy=never`
  - `sandbox=danger-full-access`
- 运行中切换 bypass 会自动重连 bridge 并生效。
- 审批类型覆盖 command/file_change/user_input/tool_call/permissions 等。

5. 会话可见性和消息限流
- 删除会话采用“软删除”（记录 `deletedThreadIds`，对移动端隐藏）。
- 聊天详情返回最近 `400` 条消息，降低移动端加载压力。
- 线程摘要优先提取最后 assistant 消息，按更新时间倒序返回。

## 源码结构

```text
host-app/
  package.json
  src/
    main.js
    preload.cjs
    config-store.js
    service/
      host-service.js
      codex-bridge.js
      token.js
    renderer/
      index.html
      app.js
      styles.css
```

## 核心实现

### 1) 主进程（main.js）
- 初始化 `ConfigStore` 和 `HostService`。
- 创建窗口并加载 renderer。
- 通过 IPC 暴露服务控制与设置能力：
  - `service:start/stop`
  - `token:reset`
  - `settings:set-launch-at-login`
  - `settings:set-auto-start-service`
  - `settings:set-bypass-permissions`
  - `clipboard:copy`
- 服务状态变化时统一推送 `state:updated` 到 UI。

### 2) 配置存储（config-store.js）
- 存储位置：`<userData>/host-config.json`。
- 默认配置：
  - `port=333`
  - `token=20位`
  - `workspacePath=Documents`
  - `launchAtLogin=false`
  - `autoStartService=false`
  - `bypassPermissions=true`
  - `autoApprove=true`
  - `deletedThreadIds=[]`
- 加载时有容错和字段修复逻辑。

### 3) 服务层（host-service.js）
- 启动流程：
  - 校验工作目录
  - 启动 codex bridge
  - 启动 HTTP/WS 服务
- 停止流程：
  - 关闭客户端连接
  - 关闭 HTTP/WS
  - 停止 bridge 子进程
- 路由提供线程、消息、审批、配置管理 API。

### 4) Bridge 层（codex-bridge.js）
- 维护 pending request、pending approvals、active turns。
- 把 app-server 原始事件转换为移动端可消费事件。
- `MAX_THREAD_ITEMS = 400` 控制详情消息返回上限。
- 支持附件文件落地、审批自动应答和桥接重启恢复。

## 控制逻辑
1. 状态机
- 服务状态：`stopped -> starting -> running -> stopping -> (error)`。
- 同步维护 `codexReady`、`pendingApprovals`、`clientCount`。

2. 鉴权与安全
- `Bearer token` 作为统一准入。
- token 重置后主动踢掉已连接客户端，要求重新连接。

3. 动态配置生效
- 工作目录变更会更新配置并在必要时重启 bridge。
- bypass 切换同理，确保策略立即生效。

## 依赖与环境
1. 开发环境
- Node.js 20+（建议 LTS）
- npm
- macOS 打包环境（electron-builder）
- 已安装 Codex Desktop（包含 `codex app-server`）

2. 依赖
- 运行时：`express`、`ws`
- 开发与打包：`electron`、`electron-builder`

## 常用命令
在 `host-app/` 目录执行：

```bash
npm install
npm run start
npm run check
npm run dist:mac
```

打包输出目录：

```text
host-app/dist/
```
