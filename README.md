# CursorCLI2API

将 Cursor Agent CLI 反代为 OpenAI / Anthropic 兼容的 HTTP API 网关。同时支持 Codex、Claude Code、Gemini CLI 作为 Provider。

## 工作原理

```
客户端 (Cherry Studio / OpenAI SDK / ...)
    │
    │  标准 OpenAI / Anthropic HTTP 请求
    ▼
┌──────────────────────────────┐
│  CursorCLI2API  (Hono)       │
│  - 认证 (Bearer Token)       │
│  - 并发控制 (信号量)          │
│  - SSE 流式 / JSON 响应      │
│  - Tool Call 模拟 (Cursor)   │
└──────────┬───────────────────┘
           │
     ┌─────┼─────┬──────────┐
     ▼     ▼     ▼          ▼
   Codex  Claude  Gemini  Cursor Agent
   (CLI)  (CLI)   (CLI)   (CLI subprocess)
```

每个请求通过 `child_process.spawn` 启动对应 CLI，解析 NDJSON/stream-json 输出，转换为标准 OpenAI SSE 格式返回。

## 功能特性

- **OpenAI 兼容** — `POST /v1/chat/completions`、`POST /v1/responses`
- **Anthropic 兼容** — `POST /v1/messages`（流式和非流式）
- **多 Provider** — Cursor Agent、Codex、Claude Code、Gemini CLI
- **SSE 流式** — token 级流式输出，含 keepalive 心跳
- **Tool Call** — Cursor Agent 通过提示工程实现标准 function calling
- **OAuth 直连** — Claude OAuth API、Gemini Cloud Code API
- **并发控制** — 可配置最大并发数
- **认证** — 可选 Bearer Token 鉴权
- **预设系统** — 一键应用推荐配置

## 前置要求

- **Node.js >= 20**
- 安装 Cursor Agent CLI：

```bash
curl https://cursor.com/install -fsS | bash
agent login    # 或准备 CURSOR_API_KEY
```

## 快速开始

### 1. 安装

```bash
cd ~/project/cursorcli2api
npm install
```

### 2. 环境检查

```bash
npm run doctor
```

### 3. 配置

```bash
cp .env.example .env
# 编辑 .env 设置 CODEX_GATEWAY_TOKEN 等
```

### 4. 启动

```bash
# 开发模式（Cursor Agent）
npm run dev -- cursor-agent --host 0.0.0.0

# 指定模型和 token
CODEX_GATEWAY_TOKEN=sk-your-key \
CODEX_ADVERTISED_MODELS="auto,gpt-5.4-medium,claude-4.6-sonnet-medium" \
npm run dev -- cursor-agent --host 0.0.0.0

# 生产模式
npm run build
npm start
```

服务默认监听 `http://0.0.0.0:8000`。

### 5. 测试

```bash
# 健康检查
curl http://127.0.0.1:8000/healthz

# 对话
curl http://127.0.0.1:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-key" \
  -d '{"model":"auto","messages":[{"role":"user","content":"你好"}]}'

# 流式
curl -N http://127.0.0.1:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-key" \
  -d '{"model":"auto","stream":true,"messages":[{"role":"user","content":"你好"}]}'

# Tool Call
curl http://127.0.0.1:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer sk-your-key" \
  -d '{
    "model":"auto",
    "messages":[{"role":"user","content":"北京今天天气如何？"}],
    "tools":[{
      "type":"function",
      "function":{
        "name":"get_weather",
        "description":"获取天气",
        "parameters":{"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}
      }
    }]
  }'
```

## API 端点

| 方法 | 路径 | 描述 |
|------|------|------|
| `GET` | `/healthz` | 健康检查 |
| `GET` | `/v1/models` | 列出可用模型 |
| `POST` | `/v1/chat/completions` | OpenAI Chat Completions |
| `POST` | `/v1/responses` | OpenAI Responses API |
| `POST` | `/v1/messages` | Anthropic Messages API |
| `GET` | `/debug/config` | 查看当前配置 |

## 客户端对接

### Cherry Studio / NextChat / ChatBox

| 配置项 | 值 |
|--------|-----|
| API Base URL | `http://127.0.0.1:8000/v1` |
| API Key | 你设置的 `CODEX_GATEWAY_TOKEN` |
| Model | `auto` 或从列表选择 |

### Python (OpenAI SDK)

```python
from openai import OpenAI

client = OpenAI(base_url="http://127.0.0.1:8000/v1", api_key="sk-your-key")

# 对话
resp = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "Hello!"}],
)
print(resp.choices[0].message.content)

# 流式
for chunk in client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "Hello!"}],
    stream=True,
):
    print(chunk.choices[0].delta.content or "", end="")

# Tool Call
resp = client.chat.completions.create(
    model="auto",
    messages=[{"role": "user", "content": "北京天气"}],
    tools=[{
        "type": "function",
        "function": {
            "name": "get_weather",
            "description": "获取天气",
            "parameters": {
                "type": "object",
                "properties": {"city": {"type": "string"}},
                "required": ["city"],
            },
        },
    }],
)
if resp.choices[0].finish_reason == "tool_calls":
    print(resp.choices[0].message.tool_calls)
```

### Python (Anthropic SDK)

```python
from anthropic import Anthropic

client = Anthropic(base_url="http://127.0.0.1:8000/v1", api_key="sk-your-key")
msg = client.messages.create(
    model="auto", max_tokens=1024,
    messages=[{"role": "user", "content": "Hello!"}],
)
print(msg.content[0].text)
```

## Tool Call 说明

Cursor Agent 通过**提示工程**实现了 OpenAI 标准 function calling：

1. 请求中的 `tools` 定义注入到 prompt
2. 模型用特定标记格式输出工具调用
3. 服务端解析标记，转换为标准 `tool_calls` 返回
4. 客户端发送 `tool` 角色结果后继续对话

支持嵌套 JSON 参数、多轮调用、流式和非流式。每次限调一个工具。

## 配置预设

| 预设 | Provider | 模型 | 说明 |
|------|----------|------|------|
| `cursor-auto` | cursor-agent | auto | 自动选模型，高并发（默认） |
| `cursor-fast` | cursor-agent | gpt-5.3-codex | 固定快速模型 |
| `codex-fast` | codex | gpt-5.2 | Codex 低推理，高并发 |
| `claude-oauth` | claude | — | Claude OAuth 直连 |
| `gemini-cloudcode` | gemini | gemini-3-flash-preview | Gemini 直连 |

## 环境变量

详见 [`.env.example`](.env.example)，关键变量：

| 变量 | 默认值 | 描述 |
|------|--------|------|
| `CODEX_GATEWAY_TOKEN` | — | Bearer Token 鉴权（空=无鉴权） |
| `CODEX_PROVIDER` | `auto` | Provider: `cursor-agent`/`codex`/`claude`/`gemini` |
| `CODEX_PRESET` | — | 预设名 |
| `CURSOR_AGENT_BIN` | `cursor-agent` | CLI 路径 |
| `CURSOR_AGENT_WORKSPACE` | — | 工作目录（建议 `/tmp/cursor-empty-workspace`） |
| `CURSOR_AGENT_API_KEY` | — | Cursor API Key |
| `CURSOR_AGENT_MODEL` | — | 默认模型 |
| `CODEX_ADVERTISED_MODELS` | — | `/v1/models` 返回的模型列表 |
| `CODEX_MAX_CONCURRENCY` | `100` | 最大并发 |
| `CODEX_TIMEOUT_SECONDS` | `600` | 请求超时 |

## Provider 路由

```json
{"model": "auto"}                                  // 默认 Provider
{"model": "cursor-agent:claude-4.6-sonnet-medium"}  // 指定 Cursor + 模型
{"model": "claude:sonnet"}                          // Claude Code
{"model": "gemini:gemini-3-flash-preview"}          // Gemini
```

需设置 `CODEX_ALLOW_CLIENT_PROVIDER_OVERRIDE=true`。

## 部署

### WSL2 + Windows

```bash
npm run dev -- cursor-agent --host 0.0.0.0
# Windows 浏览器访问 http://localhost:8000/healthz
```

### systemd

```ini
# /etc/systemd/system/cursorcli2api.service
[Unit]
Description=CursorCLI2API
After=network.target

[Service]
Type=simple
User=your-user
WorkingDirectory=/home/your-user/project/cursorcli2api
ExecStart=/usr/bin/node dist/cli.js cursor-agent --host 0.0.0.0
Restart=always
EnvironmentFile=/home/your-user/project/cursorcli2api/.env

[Install]
WantedBy=multi-user.target
```

```bash
npm run build
sudo systemctl enable --now cursorcli2api
```

## 项目结构

```
cursorcli2api/
├── package.json
├── tsconfig.json
├── .env.example
├── .gitignore
├── README.md
├── src/
│   ├── cli.ts                  # CLI 入口
│   ├── server.ts               # HTTP 服务器 + 路由 + 请求处理
│   ├── config.ts               # 环境变量 + 预设
│   ├── doctor.ts               # 诊断工具
│   ├── index.ts                # 模块导出
│   ├── lib/
│   │   ├── openai-compat.ts    # OpenAI 格式转换 + Tool Call
│   │   ├── anthropic-compat.ts # Anthropic 格式转换
│   │   └── http-client.ts      # HTTP 客户端
│   ├── providers/
│   │   ├── stream-json-cli.ts  # NDJSON 流解析器
│   │   ├── codex-cli.ts        # Codex CLI
│   │   ├── codex-responses.ts  # Codex Responses API
│   │   ├── claude-oauth.ts     # Claude OAuth
│   │   └── gemini-cloudcode.ts # Gemini Cloud Code
│   └── codex_instructions/     # 系统指令模板
└── dist/                       # 编译输出
```

## License

MIT


## 致谢

本项目受到 [LINUX DO](https://linux.do/) 社区的启发和支持。
