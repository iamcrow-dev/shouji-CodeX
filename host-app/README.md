# CodeX桌面端by.冰点零度（Host App）

桌面端 Host 服务，负责把手机端请求桥接到 `codex app-server`。

## 环境要求

- macOS（当前打包产物：arm64）
- Node.js 20+
- npm
- 本机存在 `Codex.app`：`/Applications/Codex.app`

## 开发运行

```bash
cd /Users/qwe/Documents/codex/host-app
export PATH="/usr/local/bin:$PATH"
npm install
npm start
```

## 代码检查

```bash
cd /Users/qwe/Documents/codex/host-app
export PATH="/usr/local/bin:$PATH"
npm run check
```

## 打包

```bash
cd /Users/qwe/Documents/codex/host-app
export PATH="/usr/local/bin:$PATH"
npm run dist:mac
```

产物：

- `dist/CodeX桌面端by.冰点零度-1.1.0-arm64.dmg`
- `dist/CodeX桌面端by.冰点零度-1.1.0-arm64.zip`
- `dist/mac-arm64/CodeX桌面端by.冰点零度.app`

## API 概览

- `GET /api/health`
- `POST /api/connect/test`
- `GET /api/config`
- `POST /api/config/workspace`
- `GET /api/threads`
- `GET /api/threads/:id`
- `POST /api/threads`
- `POST /api/threads/:id/message`
- `POST /api/threads/:id/interrupt`
- `DELETE /api/threads/:id`
- `GET /api/approvals`
- `POST /api/approvals/:id/respond`
- `GET /ws`

除 `GET /api/health` 外，其他接口均需：

```http
Authorization: Bearer <token>
```
