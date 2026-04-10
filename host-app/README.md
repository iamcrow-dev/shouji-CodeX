# CodeX 主机

一个用于承载移动端接入的本机桌面 Host App 原型。当前版本包含：

- 中文 GUI 主界面
- 固定端口 `333`
- 32 字符访问令牌
- 启动/停止服务
- 开机自启动开关
- 自动启动服务开关
- 真实接入 `codex app-server`
- 线程列表、会话读取、发消息和中断任务
- 待处理审批列表与审批响应接口
- 受令牌保护的 HTTP / WebSocket 入口

## 启动

```bash
cd /Users/qwe/Documents/codex/host-app
npm install
npm start
```

## 当前接口

- `GET /api/health`
- `POST /api/connect/test`
- `GET /api/config`
- `GET /api/threads`
- `GET /api/threads/:id`
- `POST /api/threads`
- `POST /api/threads/:id/message`
- `POST /api/threads/:id/interrupt`
- `GET /api/approvals`
- `POST /api/approvals/:id/respond`
- `GET /ws`

除 `GET /api/health` 外，其他接口都要求：

```http
Authorization: Bearer <token>
```

## 说明

WebSocket 会推送这些实时事件：

- `thread.created`
- `thread.updated`
- `turn.started`
- `turn.completed`
- `message.delta`
- `message.completed`
- `approval.required`
- `approval.resolved`
- `thread.error`
