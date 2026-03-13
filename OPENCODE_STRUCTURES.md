# OpenCode Event & Object Structures

This document describes the structure of OpenCode events and core objects, based on analysis of the OpenCode source code.

**IMPORTANT FINDING**: The current plugin code has a bug - `session.updated` events only contain `session.info` (basic metadata), NOT the full session with messages. To get the actual task result, you need to call the OpenCode API separately.

---

## Table of Contents

- [Event System Overview](#event-system-overview)
- [Session Objects & Events](#session-objects--events)
- [Message Objects & Events](#message-objects--events)
- [Command Objects & Events](#command-objects--events)
- [Permission Objects & Events](#permission-objects--events)
- [Todo Objects & Events](#todo-objects--events)
- [Tool Objects](#tool-objects)
- [MCP/Server Objects & Events](#mcpserver-objects--events)

---

## Event System Overview

OpenCode uses a bus-based event system (`BusEvent`) for internal communication. All events are defined using Zod schemas.

```typescript
// Event definition pattern
BusEvent.define(
  "event.name",
  z.object({
    // payload schema
  })
)
```

### Event Payload Structure

Events typically contain only the minimal data needed:
- Session events: `{ info: Session.Info }`
- Message events: `{ info: Message.Info }` or `{ sessionID, messageID }`
- Deletion events: `{ id }` or `{ sessionID, messageID }`

---

## Session Objects & Events

### Session.Info (Session Metadata)

**File**: `packages/opencode/src/session/index.ts`

```typescript
{
  id: string,              // Session identifier (e.g., "sess_abc123")
  slug: string,            // URL-friendly identifier
  projectID: string,       // Associated project
  workspaceID?: string,    // Associated workspace (optional)
  directory: string,       // Working directory path
  parentID?: string,       // Parent session ID (for forks)
  
  title: string,           // Session title
  version: string,         // Session version
  
  summary?: {              // Code change summary (optional)
    additions: number,
    deletions: number,
    files: number,
    diffs?: FileDiff[],
  },
  
  share?: {                // Share info (optional)
    url: string,
  },
  
  revert?: {               // Revert info (optional)
    messageID: string,
    partID?: string,
    snapshot?: string,
    diff?: string,
  },
  
  permission?: PermissionRuleset,  // Permission rules
  
  time: {
    created: number,       // Unix timestamp (ms)
    updated: number,       // Unix timestamp (ms)
    compacting?: number,   // Last compaction time
    archived?: number,     // Archive time
  }
}
```

### Session Events

**File**: `packages/opencode/src/session/index.ts`

```typescript
// session.created
{ info: Session.Info }

// session.updated - ⚠️ ONLY contains info, NOT messages!
{ info: Session.Info }

// session.deleted
{ info: Session.Info }

// session.diff
{ sessionID: string, diff: FileDiff[] }

// session.error
{ sessionID?: string, error: MessageError }
```

### ⚠️ Critical Finding: session.updated Event

The `session.updated` event **DOES NOT** contain messages or results:

```typescript
// What you get:
{
  info: {
    id: "sess_abc123",
    status: "completed",  // If status changes
    title: "...",
    // ... other metadata
    // ❌ NO messages field!
    // ❌ NO result field!
  }
}
```

To get the actual task result, you must:
1. Call OpenCode API: `GET /sessions/{sessionId}/messages`
2. Or use the SDK: `session.messages.list(sessionId)`

---

## Message Objects & Events

### Message.Info (Union Type)

**File**: `packages/opencode/src/session/message-v2.ts`

Messages are discriminated by `role`: `"user"` | `"assistant"`

#### User Message

```typescript
{
  id: string,
  sessionID: string,
  role: "user",
  time: {
    created: number,
  },
  format?: OutputFormat,     // text | json_schema
  summary?: {
    title?: string,
    body?: string,
    diffs: FileDiff[],
  },
  agent: string,             // Agent name
  model: {
    providerID: string,
    modelID: string,
  },
  system?: string,           // System prompt
  tools?: Record<string, boolean>,  // Enabled tools
  variant?: string,
}
```

#### Assistant Message

```typescript
{
  id: string,
  sessionID: string,
  role: "assistant",
  time: {
    created: number,
    completed?: number,
  },
  error?: MessageError,      // AuthError | OutputLengthError | etc.
  parentID: string,          // Parent message ID
  modelID: string,
  providerID: string,
  mode: string,              // Deprecated
  agent: string,
  path: {
    cwd: string,             // Current working directory
    root: string,            // Project root
  },
  summary?: boolean,
  cost: number,              // Token cost
  tokens: {
    total?: number,
    input: number,
    output: number,
    reasoning: number,
    cache: {
      read: number,
      write: number,
    },
  },
  structured?: any,          // Structured output
  variant?: string,
  finish?: string,           // Finish reason
}
```

### Message Parts

Messages can have multiple parts (stored separately):

```typescript
MessageV2.WithParts = {
  info: Message.Info,
  parts: Part[],
}
```

#### Part Types

```typescript
// Text content
type TextPart = {
  type: "text",
  id: string,
  sessionID: string,
  messageID: string,
  text: string,
  synthetic?: boolean,
  ignored?: boolean,
  time?: { start: number, end?: number },
  metadata?: Record<string, any>,
}

// Tool execution
type ToolPart = {
  type: "tool",
  id: string,
  sessionID: string,
  messageID: string,
  callID: string,
  tool: string,              // Tool name
  state: ToolState,          // pending | running | completed | error
  metadata?: Record<string, any>,
}

// File reference
type FilePart = {
  type: "file",
  id: string,
  sessionID: string,
  messageID: string,
  mime: string,
  filename?: string,
  url: string,
  source?: FilePartSource,
}

// Reasoning/thinking
type ReasoningPart = {
  type: "reasoning",
  id: string,
  sessionID: string,
  messageID: string,
  text: string,
  metadata?: Record<string, any>,
  time: { start: number, end?: number },
}

// Subtask invocation
type SubtaskPart = {
  type: "subtask",
  id: string,
  sessionID: string,
  messageID: string,
  prompt: string,
  description: string,
  agent: string,
  model?: { providerID: string, modelID: string },
  command?: string,
}

// Git snapshot
type SnapshotPart = {
  type: "snapshot",
  id: string,
  sessionID: string,
  messageID: string,
  snapshot: string,          // Git commit hash
}

// Git patch
type PatchPart = {
  type: "patch",
  id: string,
  sessionID: string,
  messageID: string,
  hash: string,
  files: string[],
}
```

### Message Events

```typescript
// message.updated - ⚠️ ONLY metadata, NO content/parts!
{ info: Message.Info }

// message.removed
{ sessionID: string, messageID: string }

// message.part.updated - ✅ Contains actual content
{ part: Part }

// message.part.delta (streaming updates)
{ sessionID: string, messageID: string, partID: string, field: string, delta: string }

// message.part.removed
{ sessionID: string, messageID: string, partID: string }
```

### ⚠️ Key Finding: message.updated has no content!

Just like `session.updated`, `message.updated` only contains message **metadata** (role, timestamps, tokens, cost) but **NOT** the actual content.

**Content lives in Parts**, which are sent via separate events:
- `message.part.updated` - When a part is created/updated
- `message.part.delta` - Streaming updates (for text generation)

To reconstruct a complete message with content:

```typescript
// 1. Track parts as they arrive
const parts = new Map()

Bus.subscribe(MessageV2.Event.PartUpdated, ({ part }) => {
  parts.set(part.id, part)
})

Bus.subscribe(MessageV2.Event.PartDelta, ({ partID, field, delta }) => {
  const part = parts.get(partID)
  if (part && field === 'text') {
    part.text += delta  // Append streaming content
  }
})

// 2. Or fetch complete messages via API
const response = await fetch(`/sessions/${sessionId}/messages?includeParts=true`)
const { messages } = await response.json()
// messages[0].parts contains the actual content
```

---

## Command Objects & Events

### Command.Info

**File**: `packages/opencode/src/command/index.ts`

```typescript
{
  name: string,
  description?: string,
  agent?: string,            // Target agent
  model?: string,            // Target model
  source: "command" | "mcp" | "skill",
  template: Promise<string> | string,  // Prompt template
  subtask?: boolean,         // Whether it's a subtask
  hints: string[],           // Template variables (e.g., ["$1", "$2", "$ARGUMENTS"])
}
```

### Command Event

```typescript
// command.executed
{
  name: string,
  sessionID: string,
  arguments: string,         // Command arguments
  messageID: string,
}
```

---

## Permission Objects & Events

### Permission.Info

**File**: `packages/opencode/src/permission/index.ts`

```typescript
{
  id: string,
  type: string,              // Permission type (e.g., "bash", "file_write")
  pattern?: string | string[],  // File/tool pattern
  sessionID: string,
  messageID: string,
  callID?: string,           // Tool call ID
  message: string,           // User-facing message
  metadata: Record<string, any>,
  time: {
    created: number,
  }
}
```

### Permission Ruleset

**File**: `packages/opencode/src/permission/next.ts`

```typescript
// Individual rule
type Rule = {
  permission: string,
  pattern: string,
  action: "allow" | "deny" | "ask",
}

// Ruleset is an array of rules
type Ruleset = Rule[]
```

### Permission Events

```typescript
// permission.updated
Permission.Info

// permission.replied
{
  sessionID: string,
  permissionID: string,
  response: "once" | "always" | "reject",
}

// permission.asked (new system)
PermissionNext.Request

// permission.replied (new system)
{
  sessionID: string,
  permissionID: string,
  response: "once" | "always" | "reject",
}
```

---

## Todo Objects & Events

### Todo.Info

**File**: `packages/opencode/src/session/todo.ts`

```typescript
{
  content: string,           // Task description
  status: string,            // pending | in_progress | completed | cancelled
  priority: string,          // high | medium | low
}
```

### Todo Event

```typescript
// todo.updated
{
  sessionID: string,
  todos: Todo.Info[],
}
```

---

## Tool Objects

### Tool.Info

**File**: `packages/opencode/src/tool/tool.ts`

```typescript
{
  id: string,
  init: (ctx?: InitContext) => Promise<{
    description: string,
    parameters: z.ZodType,   // Zod schema for parameters
    execute: (
      args: z.infer<Parameters>,
      ctx: Tool.Context
    ) => Promise<{
      title: string,
      metadata: Metadata,
      output: string,
      attachments?: Omit<FilePart, "id" | "sessionID" | "messageID">[],
    }>,
    formatValidationError?: (error: z.ZodError) => string,
  }>
}
```

### Tool Context

```typescript
{
  sessionID: string,
  messageID: string,
  agent: string,
  abort: AbortSignal,
  callID?: string,
  extra?: { [key: string]: any },
  messages: MessageV2.WithParts[],
  metadata: (input: { title?: string; metadata?: M }) => void,
  ask: (input: Omit<PermissionNext.Request, "id" | "sessionID" | "tool">) => Promise<void>,
}
```

### Tool State (in Message Parts)

```typescript
type ToolState = 
  | { status: "pending", input: object, raw: string }
  | { status: "running", input: object, title?: string, metadata?: object, time: { start: number } }
  | { status: "completed", input: object, output: string, title: string, metadata: object, time: { start: number, end: number, compacted?: number }, attachments?: FilePart[] }
  | { status: "error", input: object, error: string, metadata?: object, time: { start: number, end: number } }
```

---

## MCP/Server Objects & Events

### MCP Resource

**File**: `packages/opencode/src/mcp/index.ts`

```typescript
{
  name: string,
  uri: string,
  description?: string,
  mimeType?: string,
  client: string,            // MCP client name
}
```

### MCP Status

```typescript
type MCPStatus = 
  | { status: "connected" }
  | { status: "disabled" }
  | { status: "failed", error: string }
  | { status: "needs_auth" }
  | { status: "needs_client_registration", error: string }
```

### Server Events

```typescript
// server.connected
{}

// global.disposed
{}

// mcp.tools.changed
{ server: string }

// mcp.browser.open.failed
{ mcpName: string, url: string }
```

---

## Plugin Bug: Current Implementation Issue

### The Problem

The current `opencode-plugin-openclaw` code assumes `session.updated` events contain the full session with messages:

```typescript
// ❌ WRONG - This code doesn't work!
const formatCallbackMessage = (session: any): string => {
  const result = session.result || session.messages?.slice(-1)[0]?.content || "(no output)"
  // ...
}

// session.updated event handler
"session.updated": async (event: any) => {
  const session = event.session  // ❌ Should be event.info!
  // session.messages is always undefined!
}
```

### Correct Implementation

To fix this, the plugin should:

1. **Use correct event path**: `event.info` not `event.session`
2. **Fetch messages separately** when session completes:

```typescript
"session.updated": async (event: any) => {
  const sessionInfo = event.info
  if (!sessionInfo?.id) return
  
  const config = callbackRegistry.get(sessionInfo.id)
  if (!config) return
  
  if (sessionInfo.status === "completed" || sessionInfo.status === "failed") {
    // Fetch messages to get the actual result
    const messages = await fetchSessionMessages(sessionInfo.id)
    const lastMessage = messages[messages.length - 1]
    const result = extractResultFromMessage(lastMessage)
    
    await sendCallback(config, { ...sessionInfo, result })
    callbackRegistry.delete(sessionInfo.id)
  }
}
```

### API Call to Get Messages

```typescript
async function fetchSessionMessages(sessionId: string) {
  const response = await fetch(`${OPENCODE_URL}/sessions/${sessionId}/messages`, {
    headers: {
      "Authorization": `Basic ${btoa(`${username}:${password}`)}`
    }
  })
  return response.json()
}
```

---

## Summary Table: Event Payloads

| Event | Payload | Contains Full Data? |
|-------|---------|---------------------|
| session.created | `{ info: Session.Info }` | ❌ No messages |
| session.updated | `{ info: Session.Info }` | ❌ No messages |
| session.deleted | `{ info: Session.Info }` | ❌ No messages |
| message.updated | `{ info: Message.Info }` | ❌ **NO parts/content** |
| message.part.updated | `{ part: Part }` | ✅ **Full part content** |
| message.part.delta | `{ sessionID, messageID, partID, field, delta }` | ✅ Partial (streaming) |
| todo.updated | `{ sessionID, todos: Todo[] }` | ✅ Yes |
| command.executed | `{ name, sessionID, arguments, messageID }` | ✅ Yes |
| permission.updated | `Permission.Info` | ✅ Yes |
| mcp.tools.changed | `{ server: string }` | ✅ Yes |

### ⚠️ Critical: Neither Session nor Message events contain content!

To get actual task results, you need to:

1. **Listen for `message.part.updated`** events for text/tool/file content
2. **Or call API** to fetch full messages with parts:

```typescript
// Fetch complete messages with parts
GET /sessions/{sessionId}/messages?includeParts=true

// Response includes:
{
  "messages": [
    {
      "info": { /* Message.Info */ },
      "parts": [
        { "type": "text", "text": "Actual content here..." },
        { "type": "tool", "tool": "bash", "state": { "status": "completed", "output": "..." } }
      ]
    }
  ]
}
```

---

## File Locations Reference

| Object | File Path |
|--------|-----------|
| Session | `packages/opencode/src/session/index.ts` |
| Message | `packages/opencode/src/session/message-v2.ts` |
| Command | `packages/opencode/src/command/index.ts` |
| Permission | `packages/opencode/src/permission/index.ts` |
| PermissionNext | `packages/opencode/src/permission/next.ts` |
| Todo | `packages/opencode/src/session/todo.ts` |
| Tool | `packages/opencode/src/tool/tool.ts` |
| MCP | `packages/opencode/src/mcp/index.ts` |
| BusEvent | `packages/opencode/src/bus/bus-event.ts` |
| Session SQL Schema | `packages/opencode/src/session/session.sql.ts` |

---

## Fixed Implementation: Message Part Accumulation

The corrected plugin implementation listens to multiple events and accumulates content:

```typescript
export default async function OpenclawPlugin({}: PluginInput) {
  const sessionRegistry = new Map<string, SessionState>()
  
  return {
    // Track text content from message parts
    "message.part.updated": async (event: any) => {
      const part = event.part
      if (!part?.sessionID) return
      
      const state = sessionRegistry.get(part.sessionID)
      if (!state) return
      
      switch (part.type) {
        case "text":
          if (part.text) state.textParts.push(part.text)
          break
        case "tool":
          if (part.state?.status === "completed") {
            state.toolOutputs.push({
              tool: part.tool,
              output: part.state.output
            })
          }
          break
      }
    },
    
    // Handle streaming text deltas
    "message.part.delta": async (event: any) => {
      const { sessionID, field, delta } = event
      if (field !== "text" || !delta) return
      
      const state = sessionRegistry.get(sessionID)
      if (!state) return
      
      // Append to last text part or create new
      if (state.textParts.length > 0) {
        state.textParts[state.textParts.length - 1] += delta
      } else {
        state.textParts.push(delta)
      }
    },
    
    // Monitor session completion
    "session.updated": async (event: any) => {
      const info = event.info  // Note: event.info, not event.session!
      if (!info?.id) return
      
      const state = sessionRegistry.get(info.id)
      if (!state) return
      
      if (info.status === "completed" || info.status === "failed") {
        // Send callback with accumulated content
        await sendCallback(info.id, state)
        sessionRegistry.delete(info.id)
      }
    },
    
    // Track errors
    "session.error": async (event: any) => {
      const { sessionID, error } = event
      const state = sessionRegistry.get(sessionID)
      if (state) {
        state.hasError = true
        state.errorMessage = error?.message
      }
    }
  }
}
```

### Key Differences from Broken Implementation

| Aspect | Broken | Fixed |
|--------|--------|-------|
| Event path | `event.session` | `event.info` |
| Content source | `session.messages` (undefined) | Accumulated from `message.part.*` events |
| Event handlers | 2 (`session.updated`, `session.deleted`) | 5 (+ `message.part.updated`, `message.part.delta`, `session.error`) |
| Content in callback | Always "(no output)" | Actual text + tool outputs |

---

*Generated from OpenCode source analysis*
