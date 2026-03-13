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

// 内存中存储 session 到回调配置的映射
const callbackRegistry = new Map<string, CallbackConfig>()

// 插件级别的默认配置
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

const formatCallbackMessage = (session: any): string => {
  const status = session.status === "completed" ? "completed" : "failed"
  const result = session.result || session.messages?.slice(-1)[0]?.content || "(no output)"
  const error = session.error

  if (status === "failed" && error) {
    return `Task failed: ${session.id}\n\nError:\n${error}`
  }

  return `Task completed: ${session.id}\n\nResult:\n${result}`
}

const sendCallback = async (config: CallbackConfig, session: any): Promise<void> => {
  const payload = {
    message: formatCallbackMessage(session),
    name: "OpenCode Task",
    agentId: config.agentId || "main",
    wakeMode: "now",
    deliver: config.deliver ?? true,
    channel: config.channel || "last",
  }

  try {
    const res = await fetch(config.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify(payload),
    })

    if (!res.ok) {
      console.error(`[openclaw] Callback failed for session ${session.id}: ${res.status} ${res.statusText}`)
    } else {
      console.log(`[openclaw] Callback sent for session: ${session.id}`)
    }
  } catch (err) {
    console.error(`[openclaw] Failed to send callback for session ${session.id}:`, err)
  }
}

export default async function OpenclawPlugin({}: PluginInput) {
  // 启动 HTTP 服务器用于接收回调注册
  const server = createServer(async (req, res) => {
    const url = req.url || "/"
    const method = req.method || "GET"

    res.setHeader("Content-Type", "application/json")

    // 健康检查端点
    if (url === "/health" && method === "GET") {
      res.writeHead(200)
      res.end(JSON.stringify({
        status: "ok",
        registeredSessions: callbackRegistry.size,
      }))
      return
    }

    // 注册回调端点 - CLI 调用此端点注册需要回调的 session
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

        // 存储到注册表
        callbackRegistry.set(sessionId, {
          url: callbackConfig.url,
          apiKey: callbackConfig.apiKey || pluginConfig.openclawApiKey,
          agentId: callbackConfig.agentId || "main",
          channel: callbackConfig.channel || "last",
          deliver: callbackConfig.deliver ?? true,
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

    // 未匹配的路由
    res.writeHead(404)
    res.end(JSON.stringify({ error: "Not found" }))
  })

  // 启动服务器
  await new Promise<void>((resolve, reject) => {
    server.listen(pluginConfig.port, () => {
      console.log(`[openclaw] Plugin HTTP server listening on port ${pluginConfig.port}`)
      resolve()
    })
    server.on("error", reject)
  })

  // 返回符合 OpenCode 插件规范的对象
  return {
    // 配置更新处理
    config: async (cfg: { openclaw?: OpenclawConfig }) => {
      if (cfg.openclaw) {
        Object.assign(pluginConfig, cfg.openclaw)
        console.log("[openclaw] Configuration updated")
      }
    },

    // 核心：订阅 session 更新事件
    "session.updated": async (event: any) => {
      const session = event.session
      if (!session?.id) return

      const config = callbackRegistry.get(session.id)
      if (!config) return // 这个 session 没有注册回调

      // 检查 session 是否完成
      if (session.status === "completed" || session.status === "failed") {
        console.log(`[openclaw] Session ${session.id} ${session.status}, sending callback...`)
        await sendCallback(config, session)
        callbackRegistry.delete(session.id) // 清理注册表
      }
    },

    // 清理：session 被删除时移除注册
    "session.deleted": async (event: any) => {
      const sessionId = event.sessionId
      if (callbackRegistry.has(sessionId)) {
        console.log(`[openclaw] Session ${sessionId} deleted, removing callback registration`)
        callbackRegistry.delete(sessionId)
      }
    },

    // 清理：插件卸载时关闭服务器
    dispose: async () => {
      server.close()
      callbackRegistry.clear()
      console.log("[openclaw] Plugin disposed")
    },
  }
}
