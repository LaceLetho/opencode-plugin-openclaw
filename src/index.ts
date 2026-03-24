import { createServer } from "http"
import net from "net"
import type { PluginInput } from "@opencode-ai/plugin"

export interface OpenclawConfig {
  port?: number
  openclawApiKey?: string
}

interface CallbackConfig {
  url: string
  apiKey?: string
  agentId?: string
  channel?: string
  deliver?: boolean
  to?: string  // Target recipient for message forwarding
  prompt?: string  // Original user prompt from CLI
}

interface SessionState {
  config: CallbackConfig
  status?: string
  textParts: string[]
  toolOutputs: Array<{ tool: string; output: string; error?: string }>
  hasError: boolean
  errorMessage?: string
  partTypes: Map<string, string> // Track partID -> partType to filter out reasoning content
  messageRoles: Map<string, string> // Track messageID -> role (user/assistant)
  userPrompt?: string // Store user's original question
  userMessageId?: string // Track the first user message ID
  processedPartIDs: Set<string> // Track already processed partIDs to avoid duplicates
  registeredAt: number // Timestamp when session was registered
  completed: boolean // Whether callback has been triggered
  poller?: ReturnType<typeof setInterval>
}

type SessionGetResult = {
  data?: {
    directory?: string
  }
  error?: unknown
}

// Global singleton to track server instance across plugin reloads
declare global {
  var __openclawPluginServer: {
    server: ReturnType<typeof createServer> | null
    isRunning: boolean
    startTime: number
    poller: ReturnType<typeof setInterval> | null
  }
}

// Initialize global singleton
if (!globalThis.__openclawPluginServer) {
  globalThis.__openclawPluginServer = {
    server: null,
    isRunning: false,
    startTime: 0,
    poller: null,
  }
}

const sessionRegistry = new Map<string, SessionState>()

let pluginConfig: OpenclawConfig = {
  port: 9090,
  openclawApiKey: "",
}

const POLL_INTERVAL_MS = 3000

/**
 * Logger utility for structured logging to stdout
 * Railway Dashboard captures stdout/stderr for log visibility
 */
const log = (level: "DEBUG" | "INFO" | "WARN" | "ERROR", message: string, meta?: Record<string, unknown>) => {
  const timestamp = new Date().toISOString()
  const metaStr = meta ? ` ${JSON.stringify(meta)}` : ""
  const logLine = `${timestamp} [openclaw-plugin] [${level}] ${message}${metaStr}`

  if (level === "ERROR") {
    console.error(logLine)
  } else if (level === "WARN") {
    console.warn(logLine)
  } else {
    console.log(logLine)
  }
}

const logger = {
  debug: (message: string, meta?: Record<string, unknown>) => {
    if (process.env.LOG_LEVEL?.toLowerCase() === "debug") {
      log("DEBUG", message, meta)
    }
  },
  info: (message: string, meta?: Record<string, unknown>) => log("INFO", message, meta),
  warn: (message: string, meta?: Record<string, unknown>) => log("WARN", message, meta),
  error: (message: string, meta?: Record<string, unknown>) => log("ERROR", message, meta),
}

const readBody = (req: any): Promise<string> => {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    req.on("data", (chunk: Buffer) => chunks.push(chunk))
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")))
    req.on("error", reject)
  })
}

/**
 * Clean oh-my-opencode injected content from user prompt
 * Removes system-reminder tags and OMO internal markers
 */
const cleanUserPrompt = (prompt: string): string => {
  if (!prompt) return prompt

  // Remove <system-reminder>...</system-reminder> blocks
  let cleaned = prompt.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "")

  // Remove <!-- OMO_INTERNAL_INITIATOR --> marker
  cleaned = cleaned.replace(/<!--\s*OMO_INTERNAL_INITIATOR\s*-->/g, "")

  // Trim whitespace and extra newlines
  cleaned = cleaned.trim()

  return cleaned
}

const formatCallbackMessage = (sessionId: string, state: SessionState): string => {
  const lines: string[] = []

  // Add forwarding prefix if channel and to are specified
  if (state.config.channel && state.config.to) {
    lines.push(`Forward message below to ${state.config.channel} ${state.config.to}:`)
    lines.push("")  // Empty line for separation
  }

  if (state.hasError) {
    lines.push(`Task completed with error`)
    if (state.errorMessage) {
      lines.push(`\nError:\n${state.errorMessage}`)
    }
  } else {
    lines.push(`Task completed successfully`)
  }
  lines.push(`sessionId: ${sessionId}`)

  // Display user request if available
  // Try userPrompt first (from event extraction), fallback to config.prompt (from registration)
  const rawUserPrompt = state.userPrompt || state.config.prompt
  const userPrompt = cleanUserPrompt(rawUserPrompt)
  if (userPrompt) {
    lines.push("\nYour Request:")
    lines.push(userPrompt)
  }

  // Display OpenCode response
  if (state.textParts.length > 0) {
    lines.push("\nOpencode Response:")
    const combinedText = state.textParts.join("")
    logger.warn("[DEBUG] Formatting callback message", {
      sessionId,
      textPartsCount: state.textParts.length,
      textPartsLengths: state.textParts.map(p => p.length),
      textPartsPreviews: state.textParts.map(p => p.substring(0, 100)),
      combinedLength: combinedText.length,
      combinedPreview: combinedText.substring(0, 200),
    })
    lines.push(combinedText)
  }

  return lines.join("\n")
}

const sendCallback = async (sessionId: string, state: SessionState): Promise<void> => {
  const payload: Record<string, any> = {
    message: formatCallbackMessage(sessionId, state),
    name: "OpenCode Task",
    agentId: state.config.agentId || "main",
    wakeMode: "now",
    deliver: state.config.deliver ?? true,
    channel: state.config.channel || "last",
  }

  logger.info("Sending callback to OpenClaw", {
    sessionId,
    callbackUrl: state.config.url,
    agentId: payload.agentId,
    channel: state.config.channel,
    to: state.config.to,
    hasError: state.hasError,
    textParts: state.textParts.length,
    toolOutputs: state.toolOutputs.length,
  })

  const startTime = Date.now()

  try {
    const res = await fetch(state.config.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(state.config.apiKey ? { Authorization: `Bearer ${state.config.apiKey}` } : {}),
      },
      body: JSON.stringify(payload),
    })

    const duration = Date.now() - startTime

    if (!res.ok) {
      logger.error("Callback failed", {
        sessionId,
        status: res.status,
        statusText: res.statusText,
        duration,
      })
    } else {
      logger.info("Callback sent successfully", {
        sessionId,
        status: res.status,
        duration,
      })
    }
  } catch (err) {
    logger.error("Failed to send callback", {
      sessionId,
      error: err instanceof Error ? err.message : String(err),
      duration: Date.now() - startTime,
    })
  }
}

const handleSessionComplete = async (sessionId: string, state: SessionState) => {
  if (state.completed) {
    logger.debug("Callback already triggered for session, skipping", { sessionId })
    return
  }

  state.completed = true
  if (state.poller) {
    clearInterval(state.poller)
    state.poller = undefined
    logger.info("Session poller stopped", { sessionId })
  }
  logger.info("Session completed, triggering callback", {
    sessionId,
    status: state.status,
    hasError: state.hasError,
  })
  await sendCallback(sessionId, state)
  sessionRegistry.delete(sessionId)
  logger.info("Session removed from registry", { sessionId, remainingSessions: sessionRegistry.size })
}

const getSession = async (client: PluginInput["client"], sessionId: string): Promise<SessionGetResult> => {
  const api = client.session as any
  const attempts = [
    async () => api.get({ path: { id: sessionId } }),
    async () => api.get({ path: { sessionID: sessionId } }),
    async () => api.get({ sessionID: sessionId }),
  ]

  for (const attempt of attempts) {
    try {
      const result = await attempt()
      if (!result?.error && result?.data) {
        return result
      }
      if (result?.error) {
        return result
      }
    } catch (err) {
      logger.debug("Session lookup attempt failed", {
        sessionId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return {
    error: "Unable to load session with any supported SDK shape",
  }
}

const handleEvent = async (event: any) => {
  const eventType = event?.type

  if (!eventType) return

  const props = event.properties || {}

  if (eventType.includes("session") || eventType.includes("message")) {
    logger.info(`Received event: ${eventType}`, {
      sessionID: props.sessionID,
      propertiesKeys: Object.keys(props),
    })
  }

  switch (eventType) {
    case "message.created":
    case "message.updated": {
      logger.warn("TRACK_MESSAGE", { eventType, hasProps: !!props, hasInfo: !!props.info })
      const info = props.info
      if (!info?.sessionID || !info?.id) return

      const state = sessionRegistry.get(info.sessionID)
      if (!state) return

      state.messageRoles.set(info.id, info.role)

      if (info.role === "user" && !state.userMessageId) {
        state.userMessageId = info.id
        logger.debug("User message tracked", {
          sessionId: info.sessionID,
          messageId: info.id,
        })
      }
      return
    }

    case "message.part.updated": {
      const part = props.part
      if (!part?.sessionID) return

      const state = sessionRegistry.get(part.sessionID)
      if (!state) return

      state.partTypes.set(part.id, part.type)

      logger.debug("Message part updated", {
        sessionId: part.sessionID,
        partType: part.type,
        partId: part.id,
      })

      if (part.type === "text" && part.text) {
        const messageRole = state.messageRoles.get(part.messageID)
        if (messageRole === "user" || part.messageID === state.userMessageId) {
          state.userPrompt = state.userPrompt || ""
          state.userPrompt += part.text
          logger.debug("User prompt text accumulated", {
            sessionId: part.sessionID,
            textLength: part.text.length,
            totalLength: state.userPrompt.length,
          })
          return
        }

        if (state.processedPartIDs.has(part.id)) {
          logger.warn("[DEBUG] SKIPPING message.part.updated - part already processed via delta", {
            sessionId: part.sessionID,
            partId: part.id,
            textLength: part.text.length,
            processedCount: state.processedPartIDs.size,
          })
          return
        }

        state.processedPartIDs.add(part.id)

        logger.warn("[DEBUG] Adding text via message.part.updated", {
          sessionId: part.sessionID,
          messageId: part.messageID,
          partId: part.id,
          textLength: part.text.length,
          textPreview: part.text.substring(0, 100),
          currentTextPartsCount: state.textParts.length,
          processedCount: state.processedPartIDs.size,
        })

        state.textParts.push(part.text)

        logger.debug("Text part accumulated", {
          sessionId: part.sessionID,
          textLength: part.text.length,
          totalParts: state.textParts.length,
        })
        return
      }

      if (part.type === "tool" && part.state) {
        if (part.state.status === "completed") {
          state.toolOutputs.push({
            tool: part.tool,
            output: part.state.output || "(no output)",
          })
          logger.debug("Tool execution completed", {
            sessionId: part.sessionID,
            tool: part.tool,
            totalTools: state.toolOutputs.length,
          })
          return
        }

        if (part.state.status === "error") {
          state.hasError = true
          state.toolOutputs.push({
            tool: part.tool,
            output: "",
            error: part.state.error || "Unknown error",
          })
          logger.warn("Tool execution failed", {
            sessionId: part.sessionID,
            tool: part.tool,
            error: part.state.error,
          })
          return
        }
      }

      if (part.type === "reasoning") {
        logger.debug("Reasoning part received", { sessionId: part.sessionID })
      }
      return
    }

    case "message.part.delta": {
      const sessionID = props.sessionID
      const messageID = props.messageID
      const partID = props.partID
      const field = props.field
      const delta = props.delta
      if (!sessionID || field !== "text" || !delta || !partID || !messageID) return

      const state = sessionRegistry.get(sessionID)
      if (!state) return

      const partType = state.partTypes.get(partID)
      if (partType !== "text") {
        logger.debug("Skipping delta for non-text part", {
          sessionId: sessionID,
          partId: partID,
          partType: partType || "unknown",
        })
        return
      }

      const messageRole = state.messageRoles.get(messageID)
      if (messageRole === "user" || messageID === state.userMessageId) {
        state.userPrompt = state.userPrompt || ""
        state.userPrompt += delta
        logger.debug("User prompt delta received", {
          sessionId: sessionID,
          deltaLength: delta.length,
          totalLength: state.userPrompt.length,
        })
        return
      }

      const lastPart = state.textParts.length > 0 ? state.textParts[state.textParts.length - 1] : null
      const isFirstDeltaForPart = !state.processedPartIDs.has(partID)

      logger.warn("[DEBUG] Adding text via message.part.delta", {
        sessionId: sessionID,
        messageId: messageID,
        partId: partID,
        deltaLength: delta.length,
        deltaPreview: delta.substring(0, 100),
        currentTextPartsCount: state.textParts.length,
        isAppending: state.textParts.length > 0,
        isFirstDeltaForPart,
        lastPartLength: lastPart ? lastPart.length : 0,
        lastPartPreview: lastPart ? lastPart.substring(0, 100) : null,
        textPartsArray: state.textParts,
      })

      state.processedPartIDs.add(partID)

      if (state.textParts.length > 0) {
        state.textParts[state.textParts.length - 1] += delta
        logger.warn("[DEBUG] Appended delta to existing text part", {
          sessionId: sessionID,
          partId: partID,
          newLength: state.textParts[state.textParts.length - 1].length,
          newPreview: state.textParts[state.textParts.length - 1].substring(0, 100),
        })
        return
      }

      state.textParts.push(delta)
      logger.warn("[DEBUG] Pushed new text part from delta (was empty)", {
        sessionId: sessionID,
        partId: partID,
      })
      return
    }

    case "session.status": {
      const sessionID = props.sessionID
      const status = props.status
      if (!sessionID) {
        logger.warn("No sessionID in session.status event", { event, props })
        return
      }

      if (status?.type !== "idle") {
        logger.debug("Ignoring non-idle session status", { sessionID, statusType: status?.type })
        return
      }

      const state = sessionRegistry.get(sessionID)
      if (!state) {
        logger.warn("No registered state for session", { sessionID, registeredSessions: Array.from(sessionRegistry.keys()) })
        return
      }

      logger.info("Session idle (via session.status), triggering callback", {
        sessionId: sessionID,
        hasText: state.textParts.length > 0,
        hasTools: state.toolOutputs.length > 0,
      })

      await handleSessionComplete(sessionID, state)
      return
    }

    case "session.idle": {
      logger.info("Received deprecated session.idle event", { event: JSON.stringify(event) })

      const sessionID = props.sessionID
      if (!sessionID) {
        logger.warn("No sessionID in session.idle event", { event, props })
        return
      }

      const state = sessionRegistry.get(sessionID)
      if (!state) {
        logger.warn("No registered state for session", { sessionID, registeredSessions: Array.from(sessionRegistry.keys()) })
        return
      }

      logger.info("Session idle (via deprecated session.idle), triggering callback", {
        sessionId: sessionID,
        hasText: state.textParts.length > 0,
        hasTools: state.toolOutputs.length > 0,
      })

      await handleSessionComplete(sessionID, state)
      return
    }

    case "session.error": {
      const sessionID = props.sessionID
      const error = props.error
      if (!sessionID) return

      const state = sessionRegistry.get(sessionID)
      if (!state) return

      state.hasError = true
      state.errorMessage = error?.message || String(error)

      logger.error("Session error received, triggering callback", {
        sessionId: sessionID,
        error: state.errorMessage,
      })

      await handleSessionComplete(sessionID, state)
      return
    }

    case "session.deleted": {
      const sessionId = props.sessionID || props.info?.id
      if (!sessionId || !sessionRegistry.has(sessionId)) return

      const state = sessionRegistry.get(sessionId)!
      logger.info("Session deleted, triggering callback before cleanup", {
        sessionId,
        wasTracked: true,
        hasText: state.textParts.length > 0,
        hasTools: state.toolOutputs.length > 0,
      })
      await handleSessionComplete(sessionId, state)
      return
    }
  }
}

/**
 * Check if a port is already in use by attempting to connect
 */
const isPortInUse = (port: number): Promise<boolean> => {
  return new Promise((resolve) => {
    const client = net.createConnection({ port, host: "127.0.0.1", timeout: 500 })

    client.on("connect", () => {
      client.destroy()
      resolve(true)
    })

    client.on("error", () => {
      resolve(false)
    })

    client.on("timeout", () => {
      client.destroy()
      resolve(false)
    })
  })
}

/**
 * Health check the existing server
 */
const checkExistingServer = async (port: number): Promise<boolean> => {
  try {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 1000)

    const response = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: controller.signal,
    })

    clearTimeout(timeout)
    return response.ok
  } catch {
    return false
  }
}

export default async function OpenclawPlugin({ client }: PluginInput) {
  logger.info("Initializing OpenClaw plugin", { port: pluginConfig.port })

  // Check if server is already running (from previous plugin instance)
  const singleton = globalThis.__openclawPluginServer

  if (singleton.isRunning && singleton.server) {
    // Verify the server is still responding
    const isHealthy = await checkExistingServer(pluginConfig.port)

    if (isHealthy) {
      logger.info("Reusing existing OpenClaw plugin server", {
        port: pluginConfig.port,
        startTime: new Date(singleton.startTime).toISOString(),
      })

      // Return a minimal plugin interface that reuses the existing server
      return {
        config: async (cfg: { openclaw?: OpenclawConfig }) => {
          if (cfg.openclaw) {
            Object.assign(pluginConfig, cfg.openclaw)
            logger.info("Configuration updated (server reused)", {
              port: pluginConfig.port,
              hasApiKey: !!pluginConfig.openclawApiKey,
            })
          }
        },

        event: async ({ event }: { event: any }) => {
          await handleEvent(event)
        },

        dispose: async () => {
          // Don't close the server - it's shared
          logger.info("Plugin instance disposed (server still running)")
        },
      }
    } else {
      logger.warn("Existing server not responding, will start new one", {
        port: pluginConfig.port,
      })
      singleton.isRunning = false
      singleton.server = null
    }
  }

  // Check if another process is using the port
  const portBusy = await isPortInUse(pluginConfig.port)
  if (portBusy) {
    logger.error("Port is already in use by another process", {
      port: pluginConfig.port,
    })
    throw new Error(`Port ${pluginConfig.port} is already in use`)
  }

  const checkSessionCompletion = async (sessionId: string, state: SessionState) => {
    if (state.completed) return

    const sessionResult = await getSession(client, sessionId)
    if (sessionResult.error) {
      logger.warn("Session poll failed", {
        sessionId,
        error: sessionResult.error,
      })
      return
    }

    const session = sessionResult.data
    if (!session) {
      logger.warn("Session poll returned no data", { sessionId })
      return
    }

    const statusResult = await client.session.status({
      query: { directory: session.directory },
    })
    if (statusResult.error) {
      logger.warn("Session status poll failed", {
        sessionId,
        error: statusResult.error,
      })
      return
    }

    const status = statusResult.data?.[sessionId]
    if (status && status.type !== "idle") return

    logger.info("Session idle (via poller), triggering callback", {
      sessionId,
      hasText: state.textParts.length > 0,
      hasTools: state.toolOutputs.length > 0,
    })

    await handleSessionComplete(sessionId, state)
  }

  const ensurePoller = () => {
    if (singleton.poller) return

    singleton.poller = setInterval(() => {
      const entries = Array.from(sessionRegistry.entries())
      if (entries.length === 0) return

      void (async () => {
        for (const [sessionId, state] of entries) {
          await checkSessionCompletion(sessionId, state)
        }
      })()
    }, POLL_INTERVAL_MS)

    logger.info("Session completion poller started", {
      intervalMs: POLL_INTERVAL_MS,
    })
  }

  const ensureSessionPoller = (sessionId: string, state: SessionState) => {
    if (state.poller) return

    state.poller = setInterval(() => {
      void checkSessionCompletion(sessionId, state)
    }, POLL_INTERVAL_MS)

    logger.info("Per-session completion poller started", {
      sessionId,
      intervalMs: POLL_INTERVAL_MS,
    })
  }

  const server = createServer(async (req, res) => {
    const url = req.url || "/"
    const method = req.method || "GET"
    const startTime = Date.now()

    res.setHeader("Content-Type", "application/json")

    // Log all HTTP requests
    logger.debug("HTTP request received", { method, url, userAgent: req.headers["user-agent"] })

    if (url === "/health" && method === "GET") {
      res.writeHead(200)
      res.end(JSON.stringify({
        status: "ok",
        registeredSessions: sessionRegistry.size,
      }))
      logger.debug("Health check served", { duration: Date.now() - startTime })
      return
    }

    if (url === "/register" && method === "POST") {
      try {
        const body = await readBody(req)
        const { sessionId, callbackConfig } = JSON.parse(body) as {
          sessionId: string
          callbackConfig: CallbackConfig
        }

        logger.info("Callback registration request", {
          sessionId,
          callbackUrl: callbackConfig?.url,
          agentId: callbackConfig?.agentId,
          channel: callbackConfig?.channel,
          to: callbackConfig?.to,
        })

        if (!sessionId || !callbackConfig?.url) {
          logger.warn("Invalid callback registration - missing fields", { sessionId, hasUrl: !!callbackConfig?.url })
          res.writeHead(400)
          res.end(JSON.stringify({ error: "Missing required fields: sessionId, callbackConfig.url" }))
          return
        }

        sessionRegistry.set(sessionId, {
          config: {
            url: callbackConfig.url,
            apiKey: callbackConfig.apiKey || pluginConfig.openclawApiKey,
            agentId: callbackConfig.agentId || "main",
            channel: callbackConfig.channel || "telegram",
            deliver: callbackConfig.deliver ?? true,
            to: callbackConfig.to,
            prompt: callbackConfig.prompt,
          },
          textParts: [],
          toolOutputs: [],
          hasError: false,
          partTypes: new Map(),
          messageRoles: new Map(),
          processedPartIDs: new Set(),
          registeredAt: Date.now(),
          completed: false,
        })

        const registeredConfig = sessionRegistry.get(sessionId)!.config
        const registeredState = sessionRegistry.get(sessionId)!
        logger.info("Callback registered successfully", {
          sessionId,
          callbackUrl: callbackConfig.url,
          agentId: callbackConfig.agentId || "main",
          channel: callbackConfig.channel,
          to: callbackConfig.to,
          hasApiKey: !!registeredConfig.apiKey,
          apiKeySource: callbackConfig.apiKey ? "provided" : (pluginConfig.openclawApiKey ? "env" : "none"),
          totalRegistered: sessionRegistry.size,
        })

        ensurePoller()
        ensureSessionPoller(sessionId, registeredState)

        res.writeHead(200)
        res.end(JSON.stringify({ ok: true, sessionId }))
      } catch (err) {
        logger.error("Failed to register callback", {
          error: err instanceof Error ? err.message : String(err),
        })
        res.writeHead(500)
        res.end(JSON.stringify({ error: "Internal server error" }))
      }
      return
    }

    logger.warn("Unknown endpoint accessed", { method, url })
    res.writeHead(404)
    res.end(JSON.stringify({ error: "Not found" }))
  })

  await new Promise<void>((resolve, reject) => {
    server.listen(pluginConfig.port, () => {
      // Update global singleton
      singleton.server = server
      singleton.isRunning = true
      singleton.startTime = Date.now()

      logger.info("Plugin HTTP server started", {
        port: pluginConfig.port,
        logLevel: process.env.LOG_LEVEL || "info",
        singleton: true,
      })
      resolve()
    })
    server.on("error", (err) => {
      logger.error("Failed to start HTTP server", { error: err.message })
      reject(err)
    })
  })

  // Load default API key from environment variable if not already set
  const envApiKey = process.env.OPENCLAW_API_KEY
  if (envApiKey) {
    pluginConfig.openclawApiKey = envApiKey
    logger.info("Loaded openclawApiKey from environment variable", {
      hasApiKey: true,
    })
  }

  return {
    // Plugin configuration is now only via environment variables
    // No opencode.json configuration to avoid compatibility issues
    config: async () => {
      // Configuration is loaded from environment variables only
      logger.debug("Plugin config called (no opencode.json config needed)")
    },

    // Use 'event' hook to receive all events, then filter by type
    event: async ({ event }: { event: any }) => {
      await handleEvent(event)
    },

    dispose: async () => {
      logger.info("Plugin disposing", { registeredSessions: sessionRegistry.size })

      // Only close the server if we're the primary instance
      if (singleton.server === server) {
        singleton.isRunning = false
        singleton.server = null
        if (singleton.poller) {
          clearInterval(singleton.poller)
          singleton.poller = null
          logger.info("Session completion poller stopped")
        }
        server.close((err) => {
          if (err) {
            logger.error("Error closing server", { error: err.message })
          } else {
            logger.info("Server closed successfully")
          }
        })
      }

      sessionRegistry.clear()
      logger.info("Plugin disposed")
    },
  }
}
