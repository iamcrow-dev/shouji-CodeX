# CodeX 手机端

这是给安卓设备用的最小客户端原型，和桌面 `host-app` 配套使用。

## 当前能力

- 全中文界面
- 连接页
- 会话列表页
- 聊天页
- 读取 Host App 的线程列表
- 发送消息
- 通过 WebSocket 接收流式回复
- 显示并处理待审批操作

## 目录

- `/Users/qwe/Documents/codex/android-client/app/src/main/java/com/qwe/codexmobile/data/HostApiClient.kt`
- `/Users/qwe/Documents/codex/android-client/app/src/main/java/com/qwe/codexmobile/ui/HostMobileApp.kt`

## 说明

当前机器没有安装 JDK、Gradle 和 Kotlin CLI，所以这一版我已经把 Android Studio 可导入的项目结构和源码写好，但**还没有在本机完成编译验证**。

建议下一步直接在 Android Studio 中导入 `/Users/qwe/Documents/codex/android-client`，同步后检查版本兼容，再继续补登录状态提示、消息时间和更细的审批交互。
