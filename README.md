# @laceletho/plugin-openclaw

OpenCode plugin for session callback support with OpenClaw. Subscribes to OpenCode events and sends webhooks to OpenClaw when registered sessions complete.

## Features

- **Event-Driven**: Subscribes to OpenCode `session.updated` events
- **Callback Registration**: HTTP endpoint for CLI/tools to register callback needs
- **Automatic Callback**: Sends webhooks to OpenClaw when sessions complete
- **Session Tracking**: Tracks registered sessions and cleans up after callback

## Architecture

```
┌─────────────────┐      POST /register     ┌─────────────────────┐
│   CLI/Tool      │ ──────────────────────> │  OpenclawPlugin     │
│  (External)     │   {sessionId, callback} │  (HTTP Server 9090) │
└─────────────────┘                         └──────────┬──────────┘
                                                       │
                                                       │ stores in
                                                       │ callbackRegistry
                                                       │
                                                       ▼
                                            ┌─────────────────────┐
                                            │  Subscribe to       │
                                            │  session.updated    │
                                            │  session.deleted    │
                                            └──────────┬──────────┘
                                                       │
                                                       │ session completes
                                                       ▼
                                            ┌─────────────────────┐
                                            │  Send callback to   │
                                            │  OpenClaw /hooks    │
                                            └─────────────────────┘
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
    "openclawApiKey": "your-openclaw-hooks-token"
  }
}
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `OPENCLAW_PORT` | Plugin HTTP server port | `9090` |
| `OPENCLAW_API_KEY` | Default OpenClaw hooks token | - |

## How It Works

1. **Registration**: When a CLI/tool creates an OpenCode session and wants a callback, it sends a POST request to the plugin's `/register` endpoint with the session ID and callback configuration.

2. **Event Subscription**: The plugin subscribes to OpenCode's `session.updated` and `session.deleted` events.

3. **Callback Trigger**: When a registered session's status changes to `completed` or `failed`, the plugin automatically sends a webhook to the configured OpenClaw endpoint.

4. **Cleanup**: After sending the callback (or when a session is deleted), the plugin removes the registration from memory.

## API Endpoints

### POST /register

Register a session for callback when it completes.

**Request:**
```json
{
  "sessionId": "sess_abc123",
  "callbackConfig": {
    "url": "http://localhost:18789/hooks/agent",
    "apiKey": "your-openclaw-token",
    "agentId": "main",
    "channel": "last",
    "deliver": true
  }
}
```

**Response:**
```json
{
  "ok": true,
  "sessionId": "sess_abc123"
}
```

### GET /health

Health check endpoint.

**Response:**
```json
{
  "status": "ok",
  "registeredSessions": 5
}
```

## OpenCode Events

The plugin subscribes to the following OpenCode events:

### `session.updated`

Triggered when any session is updated. The plugin checks if the session is registered and if its status is `completed` or `failed`, then sends the callback.

### `session.deleted`

Triggered when a session is deleted. The plugin removes the session from the callback registry.

## Callback to OpenClaw

When a registered session completes, the plugin sends a POST request to the configured URL:

### Payload Format

```json
{
  "message": "Task completed: sess_abc123\n\nResult:\nHere's the code...",
  "name": "OpenCode Task",
  "agentId": "main",
  "wakeMode": "now",
  "deliver": true,
  "channel": "last"
}
```

**Authentication:**
```
Authorization: Bearer <apiKey>
Content-Type: application/json
```

## Usage with CLI

This plugin is designed to work with `openclaw-opencode-cli`:

```bash
# 1. Start OpenCode with the plugin
opencode serve

# 2. From another terminal, dispatch a task with CLI
export OPENCODE_URL=http://localhost:4096
export OPENCODE_PASSWORD=your-password
export OPENCLAW_CALLBACK_URL=http://localhost:18789/hooks/agent

openclaw-opencode task "Write a Python function"

# 3. Plugin automatically sends callback when session completes
```

## OpenClaw Configuration

To receive webhook callbacks, OpenClaw must have its **hooks system enabled**. Add this to your OpenClaw configuration:

```json
{
  "hooks": {
    "enabled": true,
    "token": "your-openclaw-hooks-token",
    "path": "/hooks",
    "allowedAgentIds": ["main", "hooks"]
  }
}
```

## Testing

Test the plugin health:

```bash
curl http://localhost:9090/health
```

Test callback registration:

```bash
curl -X POST http://localhost:9090/register \
  -H "Content-Type: application/json" \
  -d '{
    "sessionId": "test-session-123",
    "callbackConfig": {
      "url": "http://localhost:18789/hooks/agent",
      "apiKey": "your-token",
      "agentId": "main"
    }
  }'
```

## Development

```bash
npm install
npm run build
npm run typecheck
```

## License

MIT
