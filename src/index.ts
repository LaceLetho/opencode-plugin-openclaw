import { createServer } from "http"
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
}

// Global singleton to track server instance across plugin reloads
declare global {
  var __openclawPluginServer: {
    server: ReturnType<typeof createServer> | null
    isRunning: boolean
    startTime: number
  }
}

// Initialize global singleton
if (!globalThis.__openclawPluginServer) {
  globalThis.__openclawPluginServer = {
    server: null,
    isRunning: false,
    startTime: 0,
  }
}

const sessionRegistry = new Map<string, SessionState>()

let pluginConfig: OpenclawConfig = {
  port: 9090,
  openclawApiKey: "",
}

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

const formatCallbackMessage = (sessionId: string, state: SessionState): string => {
  const lines: string[] = []

  // Add forwarding prefix if channel and to are specified
  if (state.config.channel && state.config.to) {
    lines.push(`Forward message below to ${state.config.channel} ${state.config.to}:`)
    lines.push("")  // Empty line for separation
  }

  if (state.hasError) {
    lines.push(`Task failed: ${sessionId}`)
    if (state.errorMessage) {
      lines.push(`\nError:\n${state.errorMessage}`)
    }
  } else {
    lines.push(`Task completed: ${sessionId}`)
  }

  // Display user request if available
  if (state.userPrompt) {
    lines.push("\nYour Request:")
    lines.push(state.userPrompt)
  }

  // Display OpenCode response
  if (state.textParts.length > 0) {
    lines.push("\nOpencode Response:")
    lines.push(state.textParts.join(""))
  }

  if (state.toolOutputs.length > 0) {
    lines.push("\n\nTools executed:")
    for (const tool of state.toolOutputs) {
      lines.push(`\n[${tool.tool}]:`)
      if (tool.error) {
        lines.push(`  Error: ${tool.error}`)
      } else {
        lines.push(`  ${tool.output}`)
      }
    }
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
  logger.info("Session completed, triggering callback", {
    sessionId,
    status: state.status,
    hasError: state.hasError,
  })
  await sendCallback(sessionId, state)
  sessionRegistry.delete(sessionId)
  logger.info("Session removed from registry", { sessionId, remainingSessions: sessionRegistry.size })
}

/**
 * Check if a port is already in use by attempting to connect
 */
const isPortInUse = (port: number): Promise<boolean> => {
  return new Promise((resolve) => {
    const net = require("net")
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

export default async function OpenclawPlugin({ }: PluginInput) {
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
          // Event handling is still active from the original instance
          // But we need to handle events in this instance too for sessionRegistry
          const eventType = event?.type
          if (!eventType) return

          switch (eventType) {
            case "message.part.updated":
            case "message.part.delta":
            case "session.idle":
            case "session.error":
            case "session.deleted": {
              // These events are handled by the original instance
              // But we log them for visibility
              logger.debug(`Event received by secondary instance: ${eventType}`, {
                sessionID: event.sessionID,
              })
              break
            }
          }
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
          },
          textParts: [],
          toolOutputs: [],
          hasError: false,
          partTypes: new Map(),
          messageRoles: new Map(),
        })

        const registeredConfig = sessionRegistry.get(sessionId)!.config
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
      const eventType = event?.type

      if (!eventType) return

      // Extract properties from the event (OpenCode SDK event structure)
      const props = event.properties || {}

      // Log all session and message events for debugging
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
          const { info } = props
          if (!info?.sessionID || !info?.id) return

          const state = sessionRegistry.get(info.sessionID)
          if (!state) return

          // Track message role for later use
          state.messageRoles.set(info.id, info.role)

          // Track the first user message ID
          if (info.role === "user" && !state.userMessageId) {
            state.userMessageId = info.id
            logger.debug("User message tracked", {
              sessionId: info.sessionID,
              messageId: info.id,
            })
          }
          break
        }

        case "message.part.updated": {
          const part = props.part
          if (!part?.sessionID) return

          const state = sessionRegistry.get(part.sessionID)
          if (!state) return

          // Store part type to filter reasoning content from deltas
          state.partTypes.set(part.id, part.type)

          logger.debug("Message part updated", {
            sessionId: part.sessionID,
            partType: part.type,
            partId: part.id,
          })

          switch (part.type) {
            case "text": {
              if (part.text) {
                // Check if this is the user message or assistant message
                const messageRole = state.messageRoles.get(part.messageID)
                if (messageRole === "user" || part.messageID === state.userMessageId) {
                  // This is user's question
                  if (!state.userPrompt) {
                    state.userPrompt = ""
                  }
                  state.userPrompt += part.text
                  logger.debug("User prompt text accumulated", {
                    sessionId: part.sessionID,
                    textLength: part.text.length,
                    totalLength: state.userPrompt.length,
                  })
                } else {
                  // This is assistant's response
                  state.textParts.push(part.text)
                  logger.debug("Text part accumulated", {
                    sessionId: part.sessionID,
                    textLength: part.text.length,
                    totalParts: state.textParts.length,
                  })
                }
              }
              break
            }
            case "tool": {
              if (part.state) {
                switch (part.state.status) {
                  case "completed":
                    state.toolOutputs.push({
                      tool: part.tool,
                      output: part.state.output || "(no output)",
                    })
                    logger.debug("Tool execution completed", {
                      sessionId: part.sessionID,
                      tool: part.tool,
                      totalTools: state.toolOutputs.length,
                    })
                    break
                  case "error":
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
                    break
                }
              }
              break
            }
            case "reasoning": {
              logger.debug("Reasoning part received", { sessionId: part.sessionID })
              break
            }
          }
          break
        }

        case "message.part.delta": {
          const { sessionID, messageID, partID, field, delta } = props
          if (!sessionID || field !== "text" || !delta || !partID || !messageID) return

          const state = sessionRegistry.get(sessionID)
          if (!state) return

          // Only accumulate text from text parts, not reasoning parts
          const partType = state.partTypes.get(partID)
          if (partType !== "text") {
            logger.debug("Skipping delta for non-text part", {
              sessionId: sessionID,
              partId: partID,
              partType: partType || "unknown",
            })
            return
          }

          // Check if this is the user message or assistant message
          const messageRole = state.messageRoles.get(messageID)
          if (messageRole === "user" || messageID === state.userMessageId) {
            // This is user's question delta
            if (!state.userPrompt) {
              state.userPrompt = ""
            }
            state.userPrompt += delta
            logger.debug("User prompt delta received", {
              sessionId: sessionID,
              deltaLength: delta.length,
              totalLength: state.userPrompt.length,
            })
          } else {
            // This is assistant's response delta
            if (state.textParts.length > 0) {
              state.textParts[state.textParts.length - 1] += delta
            } else {
              state.textParts.push(delta)
            }
            logger.debug("Text delta received", {
              sessionId: sessionID,
              deltaLength: delta.length,
              totalLength: state.textParts.join("").length,
            })
          }
          break
        }

        case "session.idle": {
          logger.info("Received session.idle event", { event: JSON.stringify(event) })

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

          logger.info("Session idle, triggering callback", {
            sessionId: sessionID,
            hasText: state.textParts.length > 0,
            hasTools: state.toolOutputs.length > 0,
          })

          await handleSessionComplete(sessionID, state)
          break
        }

        case "session.error": {
          const { sessionID, error } = props
          if (!sessionID) return

          const state = sessionRegistry.get(sessionID)
          if (!state) return

          state.hasError = true
          state.errorMessage = error?.message || String(error)

          logger.error("Session error received", {
            sessionId: sessionID,
            error: state.errorMessage,
          })
          break
        }

        case "session.deleted": {
          const sessionId = props.sessionID || props.info?.id
          if (sessionId && sessionRegistry.has(sessionId)) {
            logger.info("Session deleted, removing callback registration", {
              sessionId,
              wasTracked: true,
            })
            sessionRegistry.delete(sessionId)
          }
          break
        }
      }
    },

    dispose: async () => {
      logger.info("Plugin disposing", { registeredSessions: sessionRegistry.size })

      // Only close the server if we're the primary instance
      if (singleton.server === server) {
        singleton.isRunning = false
        singleton.server = null
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
