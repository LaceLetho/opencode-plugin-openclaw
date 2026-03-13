# @laceletho/plugin-openclaw

OpenCode plugin for asynchronous task execution with OpenClaw callback support.

## Features

- **Webhook Receiver**: HTTP endpoint to receive tasks from OpenClaw
- **Async Task Queue**: Configurable concurrent task execution
- **Automatic Callback**: Reports task results back to OpenClaw via webhook
- **Session Integration**: Uses OpenCode's session API for task execution

## Architecture

```
┌─────────────┐      POST /tasks       ┌─────────────────────┐
│   OpenClaw  │ ─────────────────────→ │  OpenclawPlugin     │
│  (External) │                        │  (Webhook Server)   │
└─────────────┘                        └──────────┬──────────┘
                                                   │
                           ┌───────────────────────┘
                           │
                           ▼
                   ┌───────────────┐
                   │  Task Queue   │
                   └───────┬───────┘
                           │
                           ▼
                   ┌───────────────┐
                   │   OpenCode    │
                   │   Session     │
                   └───────┬───────┘
                           │
                           ▼
                   ┌───────────────┐
                   │   Callback    │
                   │  to OpenClaw  │
                   │  /hooks/agent │
                   └───────────────┘
```

## Installation

```bash
npm install @laceletho/plugin-openclaw
```

## Configuration

### OpenCode Plugin Configuration

Add to your `opencode.json`:

```json
{
  "plugins": ["@laceletho/plugin-openclaw"],
  "openclaw": {
    "port": 9090,
    "openclawWebhookUrl": "http://localhost:18789/hooks/agent",
    "openclawApiKey": "your-openclaw-hooks-token",
    "maxConcurrentTasks": 5
  }
}
```

### OpenClaw Configuration (Required)

To receive webhook callbacks from this plugin, OpenClaw must have its **hooks system enabled**. Add this to your OpenClaw configuration file (`~/.openclaw/openclaw.json` or `openclaw.json`):

```json
{
  "hooks": {
    "enabled": true,
    "token": "your-openclaw-hooks-token",
    "path": "/hooks",
    "allowedAgentIds": ["main", "hooks"],
    "defaultSessionKey": "hook:opencode",
    "allowRequestSessionKey": false,
    "allowedSessionKeyPrefixes": ["hook:"]
  }
}
```

**Important security settings:**
- `token`: Must match the `openclawApiKey` in the plugin config
- `allowedAgentIds`: Restrict which agents can receive hook messages
- `allowRequestSessionKey: false`: Prevents external callers from specifying session keys (recommended)
- `allowedSessionKeyPrefixes`: When `allowRequestSessionKey` is false, OpenClaw generates session keys with these prefixes

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `OPENCLAW_PORT` | Webhook server port | `9090` |
| `OPENCLAW_WEBHOOK_URL` | OpenClaw hooks endpoint | `http://localhost:18789/hooks/agent` |
| `OPENCLAW_API_KEY` | OpenClaw hooks token | - |
| `OPENCLAW_MAX_CONCURRENT` | Max concurrent tasks | `5` |

## API Endpoints

### POST /tasks

Submit a new task for execution.

**Request:**
```json
{
  "taskId": "unique-task-id",
  "prompt": "Write a Python function to calculate fibonacci numbers",
  "callbackUrl": "http://localhost:18789/hooks/agent",
  "callbackConfig": {
    "name": "OpenCode Task",
    "agentId": "main",
    "deliver": true,
    "channel": "telegram"
  },
  "metadata": {
    "userId": "user-123",
    "priority": "high"
  }
}
```

**Response:**
```json
{
  "taskId": "unique-task-id",
  "status": "accepted"
}
```

### GET /tasks/:taskId

Check task status.

**Response:**
```json
{
  "taskId": "unique-task-id",
  "status": "completed",
  "result": "Here's the Python function...",
  "createdAt": "2024-03-12T10:00:00Z",
  "updatedAt": "2024-03-12T10:05:00Z"
}
```

### GET /health

Health check endpoint.

**Response:**
```json
{
  "status": "ok",
  "tasks": 3,
  "running": 2
}
```

## Callback to OpenClaw

When a task completes, the plugin sends a POST request to OpenClaw's `/hooks/agent` endpoint:

### OpenClaw /hooks/agent Payload Format

The plugin sends task results to OpenClaw using its native hooks format:

```json
{
  "message": "Task completed: File processing finished\n\nResults:\nHere's the Python function...",
  "name": "OpenCode Task",
  "agentId": "main",
  "wakeMode": "now",
  "deliver": true,
  "channel": "last",
  "model": "anthropic/claude-sonnet-4-5",
  "timeoutSeconds": 300
}
```

**Authentication:**
```
Authorization: Bearer <openclawApiKey>
Content-Type: application/json
```

### OpenClaw /hooks/agent Endpoint Reference

OpenClaw's `/hooks/agent` endpoint accepts the following payload structure:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `message` | string | Yes | The message to send to the agent |
| `name` | string | Yes | Display name for this hook invocation |
| `agentId` | string | No | Target agent ID (falls back to default) |
| `wakeMode` | string | No | `"now"` or `"next-heartbeat"` (default: `"now"`) |
| `sessionKey` | string | No | Session identifier (requires `allowRequestSessionKey: true`) |
| `deliver` | boolean | No | Whether to deliver response to messaging channel (default: `true`) |
| `channel` | string | No | Target channel: `"last"`, `"telegram"`, `"slack"`, `"discord"`, etc. |
| `to` | string | No | Recipient identifier for the channel |
| `model` | string | No | Model override (e.g., `"anthropic/claude-sonnet-4-5"`) |
| `thinking` | string | No | Thinking level: `"low"`, `"medium"`, `"high"` |
| `timeoutSeconds` | number | No | Maximum duration for the agent run |

## Usage Example

### 1. Configure OpenClaw

Edit your `~/.openclaw/openclaw.json`:

```json
{
  "hooks": {
    "enabled": true,
    "token": "my-secure-webhook-token",
    "path": "/hooks",
    "allowedAgentIds": ["main"]
  },
  "channels": {
    "telegram": {
      "botToken": "${TELEGRAM_BOT_TOKEN}",
      "allowFrom": ["*"]
    }
  }
}
```

### 2. Start OpenCode with the plugin

```bash
export OPENCLAW_WEBHOOK_URL="http://localhost:18789/hooks/agent"
export OPENCLAW_API_KEY="my-secure-webhook-token"
opencode serve
```

### 3. Send a task from OpenClaw

```bash
curl -X POST http://localhost:9090/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "taskId": "task-001",
    "prompt": "Create a React component for a todo list",
    "callbackUrl": "http://localhost:18789/hooks/agent",
    "callbackConfig": {
      "name": "OpenCode Task",
      "agentId": "main",
      "deliver": true,
      "channel": "telegram"
    }
  }'
```

### 4. Receive callback in OpenClaw

OpenClaw will receive the task completion via its `/hooks/agent` endpoint and can forward it to your configured messaging channel (Telegram, Slack, Discord, etc.).

## Testing Webhook Callback

Test that OpenClaw can receive webhooks:

```bash
curl -X POST http://localhost:18789/hooks/agent \
  -H "Authorization: Bearer your-openclaw-hooks-token" \
  -H "Content-Type: application/json" \
  -d '{
    "message": "Test message from OpenCode plugin",
    "name": "Test Hook",
    "deliver": true,
    "channel": "last"
  }'
```

## Comparison with claude-code-hooks

| Feature | claude-code-hooks | @laceletho/plugin-openclaw |
|---------|------------------|------------------------------|
| Trigger | Stop/SessionEnd hooks | Webhook HTTP endpoint |
| Integration | Shell scripts | TypeScript plugin |
| Orchestration | Agent Teams | Session API |
| Notification | Telegram + file | OpenClaw /hooks/agent |
| Metadata | task-meta.json | In-memory + HTTP API |
| Callback Format | Shell + CLI | HTTP POST to /hooks/agent |

## Troubleshooting

### "Unauthorized" errors

Ensure the `openclawApiKey` in plugin config matches the `hooks.token` in OpenClaw config.

### Callbacks not received

1. Verify OpenClaw Gateway is running: `curl http://localhost:18789/health`
2. Check hooks are enabled in OpenClaw config
3. Ensure network connectivity between OpenCode and OpenClaw
4. Check OpenClaw logs for incoming requests

### Security Considerations

- Keep `hooks.token` secret and use a strong random value
- Run OpenClaw Gateway behind a firewall or Tailscale for remote access
- Use `allowRequestSessionKey: false` to prevent session key injection
- Restrict `allowedAgentIds` to only necessary agents

## Development

```bash
npm install
npm run build
npm run typecheck
```

## License

MIT
