# @laceletho/plugin-openclaw

OpenCode plugin for session callback support with OpenClaw. Subscribes to OpenCode events and sends webhooks to OpenClaw when registered sessions complete.

## Features

- **Event-Driven**: Subscribes to OpenCode `session.updated` events
- **Callback Registration**: HTTP endpoint for CLI/tools to register callback needs
- **Automatic Callback**: Sends webhooks to OpenClaw when sessions complete
- **Session Tracking**: Tracks registered sessions and cleans up after callback

## Architecture

This plugin runs inside **OpenCode** and provides an HTTP server for callback registration:

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
                                            │  message.part.*     │
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

### Enable Plugin

Add to your `opencode.json`:

```json
{
  "plugins": ["@laceletho/plugin-openclaw"],
}
```

### Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `OPENCLAW_PORT` | Plugin HTTP server port | `9090` |
| `OPENCLAW_API_KEY` | Default OpenClaw hooks token | - |
| `LOG_LEVEL` | Log verbosity: `debug`, `info`, `warn`, `error` | `info` |

## How It Works

1. **Registration**: A CLI/tool creates an OpenCode session and sends a POST request to the plugin's `/register` endpoint with the session ID and callback configuration.

2. **Event Subscription**: The plugin subscribes to OpenCode's `session.updated`, `message.part.*`, and `session.deleted` events.

3. **Content Accumulation**: The plugin accumulates text content and tool outputs from `message.part.updated` and `message.part.delta` events.

4. **Callback Trigger**: When a registered session's status changes to `completed` or `failed`, the plugin sends a webhook to the configured OpenClaw endpoint with the accumulated content.

5. **Cleanup**: After sending the callback (or when a session is deleted), the plugin removes the registration from memory.

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

| Event | Purpose |
|-------|---------|
| `message.part.updated` | Accumulate text content and tool outputs |
| `message.part.delta` | Append streaming text deltas |
| `session.updated` | Monitor session status for completion |
| `session.error` | Track session errors |
| `session.deleted` | Clean up registry on session deletion |

## Callback to OpenClaw

When a registered session completes, the plugin sends a POST request to the configured URL:

**Payload:**
```json
{
  "message": "Task completed: sess_abc123\n\nResult:\nHere's the code...",
  "name": "OpenCode Task",
  "agentId": "main",
  "wakeMode": "now",
  "deliver": true,
  "channel": "last",
  "to": "123456789"
}
```

`channel` and `to` are passed as top-level `/hooks/agent` fields so OpenClaw can route delivery directly. The callback `message` body should only contain the task result text.

**Authentication:**
```
Authorization: Bearer <apiKey>
Content-Type: application/json
```

## Usage with CLI

This plugin is designed to work with `@laceletho/openclaw-opencode-cli`.

**See the [CLI documentation](https://github.com/LaceLetho/openclaw-opencode-cli) for usage instructions.**

## Logging

The plugin outputs structured logs to stdout for Railway Dashboard visibility:

### Log Levels

Set `LOG_LEVEL` environment variable:

```bash
# Debug mode - detailed event tracking
LOG_LEVEL=debug opencode serve

# Info mode (default) - key events only
LOG_LEVEL=info opencode serve

# Error mode - errors only
LOG_LEVEL=error opencode serve
```

### Log Format

```
2025-03-13T10:30:45.123Z [openclaw-plugin] [INFO] Plugin HTTP server started {"port":9090}
2025-03-13T10:30:50.456Z [openclaw-plugin] [INFO] Callback registered successfully {"sessionId":"sess_abc123","totalRegistered":1}
2025-03-13T10:31:15.789Z [openclaw-plugin] [INFO] Session status updated {"sessionId":"sess_abc123","previousStatus":"running","currentStatus":"completed"}
2025-03-13T10:31:15.890Z [openclaw-plugin] [INFO] Sending callback to OpenClaw {"sessionId":"sess_abc123","callbackUrl":"http://localhost:18789/hooks/agent"}
2025-03-13T10:31:16.012Z [openclaw-plugin] [INFO] Callback sent successfully {"sessionId":"sess_abc123","status":200,"duration":122}
```

### Railway Dashboard

Logs are automatically captured. View them in your project's **Observability** tab.

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
