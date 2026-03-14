import { createServer } from "http"
import type { PluginInput } from "@opencode-ai/plugin"

export interface OpenclawConfig {
  port?: number
  openclawWebhookUrl?: string
  openclawApiKey?: string
}

interface CallbackConfig {
  url: string
  apiKey?: string
  agentId?: string
  channel?: string
  deliver?: boolean
}

interface SessionState {
  config: CallbackConfig
  status?: string
  textParts: string[]
  toolOutputs: Array<{ tool: string; output: string; error?: string }>
  hasError: boolean
  errorMessage?: string
}

const sessionRegistry = new Map<string, SessionState>()

let pluginConfig: OpenclawConfig = {
  port: 9090,
  openclawWebhookUrl: "",
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

  if (state.hasError) {
    lines.push(`Task failed: ${sessionId}`)
    if (state.errorMessage) {
      lines.push(`\nError:\n${state.errorMessage}`)
    }
  } else {
    lines.push(`Task completed: ${sessionId}`)
  }

  if (state.textParts.length > 0) {
    lines.push("\nResult:")
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
  const payload = {
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

export default async function OpenclawPlugin({}: PluginInput) {
  logger.info("Initializing OpenClaw plugin", { port: pluginConfig.port })

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
            channel: callbackConfig.channel || "last",
            deliver: callbackConfig.deliver ?? true,
          },
          textParts: [],
          toolOutputs: [],
          hasError: false,
        })

        logger.info("Callback registered successfully", {
          sessionId,
          callbackUrl: callbackConfig.url,
          agentId: callbackConfig.agentId || "main",
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
      logger.info("Plugin HTTP server started", {
        port: pluginConfig.port,
        logLevel: process.env.LOG_LEVEL || "info",
      })
      resolve()
    })
    server.on("error", (err) => {
      logger.error("Failed to start HTTP server", { error: err.message })
      reject(err)
    })
  })

  return {
    config: async (cfg: { openclaw?: OpenclawConfig }) => {
      if (cfg.openclaw) {
        Object.assign(pluginConfig, cfg.openclaw)
        logger.info("Configuration updated", {
          port: pluginConfig.port,
          hasApiKey: !!pluginConfig.openclawApiKey,
        })
      }
    },

    // Use 'event' hook to receive all events, then filter by type
    event: async ({ event }: { event: any }) => {
      const eventType = event?.type

      if (!eventType) return

      // Log all session and message events for debugging
      if (eventType.includes("session") || eventType.includes("message")) {
        logger.info(`Received event: ${eventType}`, {
          sessionID: event.sessionID,
          propertiesKeys: event.properties ? Object.keys(event.properties) : null,
        })
      }

      switch (eventType) {
        case "message.part.updated": {
          const part = event.part
          if (!part?.sessionID) return

          const state = sessionRegistry.get(part.sessionID)
          if (!state) return

          logger.debug("Message part updated", {
            sessionId: part.sessionID,
            partType: part.type,
            partId: part.id,
          })

          switch (part.type) {
            case "text": {
              if (part.text) {
                state.textParts.push(part.text)
                logger.debug("Text part accumulated", {
                  sessionId: part.sessionID,
                  textLength: part.text.length,
                  totalParts: state.textParts.length,
                })
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
          const { sessionID, field, delta } = event
          if (!sessionID || field !== "text" || !delta) return

          const state = sessionRegistry.get(sessionID)
          if (!state) return

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
          break
        }

        case "session.idle": {
          logger.info("Received session.idle event", { event: JSON.stringify(event) })

          const sessionID = event.sessionID || event.properties?.sessionID
          if (!sessionID) {
            logger.warn("No sessionID in session.idle event", { event })
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
          const { sessionID, error } = event
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
          const sessionId = event.info?.id || event.sessionId
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
      server.close()
      sessionRegistry.clear()
      logger.info("Plugin disposed")
    },
  }
}
