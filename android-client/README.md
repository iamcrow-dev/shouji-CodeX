# CodeX 手机端（Android）

安卓客户端，连接桌面端 Host 服务进行会话查看、消息发送、审批处理。

## 环境要求

- Android Studio（建议 Panda 2 或更新）
- Android SDK（`compileSdk 36`）
- JDK（可直接使用 Android Studio 自带 JBR）

## Android Studio 运行（推荐）

1. 打开工程目录：`/Users/qwe/Documents/codex/android-client`
2. 等待 Gradle 同步完成
3. 连接真机，运行 `app` 模块

## 命令行构建

```bash
cd /Users/qwe/Documents/codex/android-client
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export PATH="/usr/local/bin:$JAVA_HOME/bin:$PATH"
./gradlew :app:assembleRelease
```

产物：

- `app/build/outputs/apk/release/app-release.apk`

## 安装包发布（当前约定）

```bash
cp -f "/Users/qwe/Documents/codex/android-client/app/build/outputs/apk/release/app-release.apk" "/Users/qwe/Documents/ob/CodeX 安装包/CodeX-手机端-1.1-release.apk"
```

## 关键代码

- 数据层：`app/src/main/java/com/qwe/codexmobile/data/HostApiClient.kt`
- 主界面：`app/src/main/java/com/qwe/codexmobile/ui/HostMobileApp.kt`
