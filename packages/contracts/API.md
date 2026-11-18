# 宝妍 API 索引

本机 Vite 在 `127.0.0.1:5173`，以同源 `/api` 代理访问 Express 的 `127.0.0.1:3001`。写请求通过来源校验，浏览器请求使用同源 Cookie。会话及管理操作由服务端校验设备身份、会话和权限。

| 入口 | 用途 |
| --- | --- |
| `GET /api/health`、`GET /api/bootstrap` | 健康状态、资料初始化状态和能力配置 |
| `POST /api/setup` | 本机虚构家庭资料初始化 |
| `POST /api/calls`、`POST /api/calls/:id/turn` | 开始普通聊天、发送文字 |
| `POST /api/calls/:id/audio`、`POST /api/calls/:id/image` | 语音或图片输入 |
| `POST /api/calls/:id/speech` | 合成普通回复或回复片段 |
| `POST /api/calls/:id/realtime/start`、`GET /api/calls/:id/realtime/events` | 启动独立实时语音、接收事件 |
| `POST /api/calls/:id/end` | 结束当前会话 |
| `/api/parent/*`、`/api/account/*`、`/api/admin/*` | 家庭权限、账号与运营接口 |

请求字段以服务端 [路由](../../apps/server/src/app.ts) 和 [运营路由](../../apps/server/src/admin-router.ts) 为准，浏览器通过 [API 客户端](../../apps/web/src/lib/api.ts) 调用。普通回复和实时语音的协议细节分别在[会话源码](../../apps/server/src/app.ts)、[实时会话](../../apps/server/src/realtime-session.ts)及[模拟联调测试](../../tests/realtime-app.test.ts)。
