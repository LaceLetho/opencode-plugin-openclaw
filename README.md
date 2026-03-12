# @opencode-ai/plugin-openclaw

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
                  │   to OpenClaw │
                  └───────────────┘
```

## Installation

```bash
npm install @opencode-ai/plugin-openclaw
```

## Configuration

Add to your `opencode.json`:

```json
{
  "plugins": ["@opencode-ai/plugin-openclaw"],
  "openclaw": {
    "port": 9090,
    "openclawWebhookUrl": "https://openclaw.example.com/webhook/results",
    "openclawApiKey": "your-api-key",
    "maxConcurrentTasks": 5
  }
}
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `OPENCLAW_PORT` | Webhook server port | `9090` |
| `OPENCLAW_WEBHOOK_URL` | Default callback URL for OpenClaw | - |
| `OPENCLAW_API_KEY` | API key for callback authentication | - |
| `OPENCLAW_MAX_CONCURRENT` | Max concurrent tasks | `5` |

## API Endpoints

### POST /tasks

Submit a new task for execution.

**Request:**
```json
{
  "taskId": "unique-task-id",
  "prompt": "Write a Python function to calculate fibonacci numbers",
  "callbackUrl": "https://openclaw.example.com/webhook/results",
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

## Callback Payload

When a task completes, the plugin sends a POST request to the callback URL:

```json
{
  "taskId": "unique-task-id",
  "status": "completed",
  "result": "Task execution result...",
  "error": null,
  "sessionId": "session-uuid",
  "completedAt": "2024-03-12T10:05:00Z"
}
```

**Headers:**
- `Content-Type: application/json`
- `Authorization: Bearer <openclawApiKey>` (if configured)

## Usage Example

### 1. Start OpenCode with the plugin

```bash
opencode serve
```

### 2. Send a task from OpenClaw

```bash
curl -X POST http://opencode-server:9090/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "taskId": "task-001",
    "prompt": "Create a React component for a todo list",
    "callbackUrl": "https://openclaw.example.com/webhook/results"
  }'
```

### 3. Receive callback

Your OpenClaw server will receive:

```json
{
  "taskId": "task-001",
  "status": "completed",
  "result": "Here's the React component...",
  "completedAt": "2024-03-12T10:05:00Z"
}
```

## Comparison with claude-code-hooks

| Feature | claude-code-hooks | @opencode-ai/plugin-openclaw |
|---------|------------------|------------------------------|
| Trigger | Stop/SessionEnd hooks | Webhook HTTP endpoint |
| Integration | Shell scripts | TypeScript plugin |
| Orchestration | Agent Teams | Session API |
| Notification | Telegram + file | HTTP webhook callback |
| Metadata | task-meta.json | In-memory + HTTP API |

## Development

```bash
npm install
npm run build
npm run typecheck
```

## License

MIT
