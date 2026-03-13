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
  "channel": "last"
}
```

**Authentication:**
```
Authorization: Bearer <apiKey>
Content-Type: application/json
```

## Usage with CLI

This plugin is designed to work with `@laceletho/openclaw-opencode-cli`.

**See the [CLI documentation](https://github.com/LaceLetho/openclaw-opencode-cli) for usage instructions.**

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
