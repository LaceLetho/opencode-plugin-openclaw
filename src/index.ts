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

  try {
    const res = await fetch(state.config.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(state.config.apiKey ? { Authorization: `Bearer ${state.config.apiKey}` } : {}),
      },
      body: JSON.stringify(payload),
    })

    if (!res.ok) {
      console.error(`[openclaw] Callback failed for session ${sessionId}: ${res.status} ${res.statusText}`)
    } else {
      console.log(`[openclaw] Callback sent for session: ${sessionId}`)
    }
  } catch (err) {
    console.error(`[openclaw] Failed to send callback for session ${sessionId}:`, err)
  }
}

const handleSessionComplete = async (sessionId: string, state: SessionState) => {
  console.log(`[openclaw] Session ${sessionId} ${state.hasError ? "failed" : "completed"}, sending callback...`)
  await sendCallback(sessionId, state)
  sessionRegistry.delete(sessionId)
}

export default async function OpenclawPlugin({}: PluginInput) {
  const server = createServer(async (req, res) => {
    const url = req.url || "/"
    const method = req.method || "GET"

    res.setHeader("Content-Type", "application/json")

    if (url === "/health" && method === "GET") {
      res.writeHead(200)
      res.end(JSON.stringify({
        status: "ok",
        registeredSessions: sessionRegistry.size,
      }))
      return
    }

    if (url === "/register" && method === "POST") {
      try {
        const body = await readBody(req)
        const { sessionId, callbackConfig } = JSON.parse(body) as {
          sessionId: string
          callbackConfig: CallbackConfig
        }

        if (!sessionId || !callbackConfig?.url) {
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

        console.log(`[openclaw] Registered callback for session: ${sessionId} -> ${callbackConfig.url}`)

        res.writeHead(200)
        res.end(JSON.stringify({ ok: true, sessionId }))
      } catch (err) {
        console.error("[openclaw] Failed to register callback:", err)
        res.writeHead(500)
        res.end(JSON.stringify({ error: "Internal server error" }))
      }
      return
    }

    res.writeHead(404)
    res.end(JSON.stringify({ error: "Not found" }))
  })

  await new Promise<void>((resolve, reject) => {
    server.listen(pluginConfig.port, () => {
      console.log(`[openclaw] Plugin HTTP server listening on port ${pluginConfig.port}`)
      resolve()
    })
    server.on("error", reject)
  })

  return {
    config: async (cfg: { openclaw?: OpenclawConfig }) => {
      if (cfg.openclaw) {
        Object.assign(pluginConfig, cfg.openclaw)
        console.log("[openclaw] Configuration updated")
      }
    },

    "message.part.updated": async (event: any) => {
      const part = event.part
      if (!part?.sessionID) return

      const state = sessionRegistry.get(part.sessionID)
      if (!state) return

      switch (part.type) {
        case "text": {
          if (part.text) {
            state.textParts.push(part.text)
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
                break
              case "error":
                state.hasError = true
                state.toolOutputs.push({
                  tool: part.tool,
                  output: "",
                  error: part.state.error || "Unknown error",
                })
                break
            }
          }
          break
        }
        case "reasoning": {
          break
        }
      }
    },

    "message.part.delta": async (event: any) => {
      const { sessionID, field, delta } = event
      if (!sessionID || field !== "text" || !delta) return

      const state = sessionRegistry.get(sessionID)
      if (!state) return

      if (state.textParts.length > 0) {
        state.textParts[state.textParts.length - 1] += delta
      } else {
        state.textParts.push(delta)
      }
    },

    "session.updated": async (event: any) => {
      const info = event.info
      if (!info?.id) return

      const state = sessionRegistry.get(info.id)
      if (!state) return

      state.status = info.status

      if (info.status === "completed" || info.status === "failed") {
        if (info.status === "failed") {
          state.hasError = true
        }
        await handleSessionComplete(info.id, state)
      }
    },

    "session.error": async (event: any) => {
      const { sessionID, error } = event
      if (!sessionID) return

      const state = sessionRegistry.get(sessionID)
      if (!state) return

      state.hasError = true
      state.errorMessage = error?.message || String(error)
    },

    "session.deleted": async (event: any) => {
      const sessionId = event.info?.id || event.sessionId
      if (sessionId && sessionRegistry.has(sessionId)) {
        console.log(`[openclaw] Session ${sessionId} deleted, removing callback registration`)
        sessionRegistry.delete(sessionId)
      }
    },

    dispose: async () => {
      server.close()
      sessionRegistry.clear()
      console.log("[openclaw] Plugin disposed")
    },
  }
}
