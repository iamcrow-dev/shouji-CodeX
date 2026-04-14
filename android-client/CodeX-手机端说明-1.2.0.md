# CodeX 手机端说明（Android v1.2.0）

## 项目定位
CodeX 手机端是连接桌面 Host 服务的 Android 客户端，负责连接配置、会话浏览、聊天发送、审批处理和实时状态显示。

## 功能点
1. 连接配置
- 配置项：服务地址、端口、访问令牌、工作目录。
- 保存并连接会依次调用：
  - `POST /api/connect/test`
  - `POST /api/config/workspace`
- 本地持久化在 SharedPreferences（`codex_mobile`）。
- 默认端口 `333`，默认工作目录 `/Users/qwe/Documents/codex`。

2. 会话列表
- 顶部显示：设备数、待审批数、主机状态、CodeX 状态、当前工作目录。
- 会话按 `updatedAt` 倒序排序。
- 卡片标题最多 2 行，摘要截断为约 52 字符。
- 卡片支持长按菜单：进入 / 新建 / 删除。
- 右下角悬浮按钮支持新建会话。

3. 聊天页
- 进入时读取会话详情（当前服务端限制最近 400 条）。
- 消息列表使用倒序渲染（`reverseLayout = true`），默认底部视角。
- 助手消息使用 Markdown 渲染（Markwon + 表格插件）。
- 用户消息保持纯文本渲染。
- 顶部操作：`+`（文件附件）、刷新、返回、停止。
- 底部输入区支持文本、图片附件、发送。

4. 附件能力
- 图片：读取 URI 后压缩为 JPEG，转为 base64 Data URL 发送。
- 文件：读取 URI 并编码为 base64 Data URL，附带 name/mimeType。
- 发送后由桌面端落地到工作目录 `.codex-mobile-uploads/`。

5. 审批能力
- 支持待审批列表显示和提交审批动作。
- 输入型审批可填写答案后提交。
- 审批结果通过接口提交并同步刷新状态。

6. 交互细节
- 点击聊天气泡可收起键盘。
- 长按聊天气泡弹出复制/选取文字菜单。
- 输入框激活时，系统返回键优先收起输入法（不直接返回列表）。
- 仅 `http://` 和 `https://` 链接允许点击。

7. 实时链路
- 使用 WebSocket `/ws` 接收事件并驱动 UI：
  - 线程创建/更新/删除
  - turn started/completed
  - message delta/completed
  - approval required/resolved
  - host state / thread error

## 源码结构

```text
android-client/
  app/
    build.gradle.kts
    src/main/java/com/qwe/codexmobile/
      MainActivity.kt
      data/
        HostApiClient.kt
        HostPreferences.kt
      model/
        Models.kt
      ui/
        HostMobileApp.kt
  gradle/libs.versions.toml
```

## 核心实现

### 1) UI 状态机（HostMobileApp.kt）
- 单 Activity + Compose。
- 三屏状态：`Connection` / `Threads` / `Chat`。
- 核心状态：
  - `config` 连接配置
  - `threads` 会话列表
  - `chatItems` 消息列表
  - `approvals` 待审批
  - `hostStats` 主机状态
- 关键流程：
  - `connectAndLoad()`：连通性检查 + 同步工作目录 + 拉取列表 + 建立 WS
  - `openThread()`：读取线程详情并进入聊天页
  - `connectSocketBridge()`：消费事件并增量更新 UI

### 2) API 客户端（HostApiClient.kt）
- 基于 OkHttp（HTTP + WebSocket）。
- 统一鉴权头：`Authorization: Bearer <token>`。
- 主要能力：
  - 连接测试、拉取线程、读取线程、创建/删除线程
  - 发送消息/图片/文件、打断线程
  - 查询与响应审批
  - 获取主机状态、设置工作目录

### 3) Markdown 渲染
- assistant 消息通过 `Markwon` 渲染。
- 启用 `TablePlugin` 支持 Markdown 表格。
- 保留长按复制/选取逻辑（Compose + AlertDialog）。

### 4) 附件读取
- `readImageAttachment()`：压缩、编码并限制数量。
- `readFileAttachment()`：读取字节并编码，保留 mimeType。

## 控制逻辑
1. 会话排序逻辑
- 任意线程变更后调用 `sortThreadsByUpdatedAt()`，保持最新在前。

2. 自动重连逻辑
- 监听 `Lifecycle.Event.ON_RESUME`，执行重连并刷新主机状态。

3. 错误处理
- 统一使用 `runCatching` + Snackbar 呈现用户可读错误。
- 对部分预期断链文案做抑制，避免无效提示噪音。

## 依赖与环境
1. 构建环境
- Android Studio（Panda 或更新）
- JDK 17
- Android SDK：`compileSdk=36`、`targetSdk=36`、`minSdk=26`

2. 核心依赖
- Jetpack Compose（BOM 2026.01.00）
- Material3
- OkHttp 4.12.0
- Markwon 4.6.2（core + ext-tables）

## 构建命令
在 `android-client/` 目录执行：

```bash
./gradlew clean assembleRelease
```

产物：

```text
android-client/app/build/outputs/apk/release/app-release.apk
```
