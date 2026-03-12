/**
 * OpenClaw Webhook Receiver Example
 * 
 * This example shows how to create a simple HTTP server that receives
 * webhook callbacks from the @opencode-ai/plugin-openclaw.
 * 
 * IMPORTANT: This is for demonstration purposes. In production, OpenClaw
 * has a built-in /hooks/agent endpoint that should be used instead.
 * 
 * To use OpenClaw's native webhook support:
 * 1. Configure OpenClaw with hooks.enabled: true
 * 2. Set hooks.token to a secure value
 * 3. Use callbackUrl: "http://localhost:18789/hooks/agent"
 * 4. OpenClaw will receive and process callbacks automatically
 */

const http = require("http")

const PORT = process.env.PORT || 3000

// Simple webhook receiver for demonstration
// In production, use OpenClaw's built-in /hooks/agent endpoint
const server = http.createServer((req, res) => {
  if (req.url === "/webhook/opencode-results" && req.method === "POST") {
    let body = ""
    req.on("data", (chunk) => body += chunk)
    req.on("end", () => {
      try {
        const result = JSON.parse(body)
        console.log("[Receiver] Received callback from OpenCode:")
        console.log("-".repeat(50))
        console.log(JSON.stringify(result, null, 2))
        console.log("-".repeat(50))
        
        // In a real implementation, you might:
        // - Forward to Telegram/Slack/Discord
        // - Store in a database
        // - Trigger other workflows
        
        res.writeHead(200)
        res.end(JSON.stringify({ received: true }))
      } catch (err) {
        console.error("[Receiver] Failed to parse callback:", err)
        res.writeHead(400)
        res.end(JSON.stringify({ error: "Invalid JSON" }))
      }
    })
    return
  }

  // Health check endpoint
  if (req.url === "/health" && req.method === "GET") {
    res.writeHead(200)
    res.end(JSON.stringify({ status: "ok" }))
    return
  }

  res.writeHead(404)
  res.end(JSON.stringify({ error: "Not found" }))
})

server.listen(PORT, () => {
  console.log(`[Receiver] Webhook receiver listening on port ${PORT}`)
  console.log(`[Receiver] Endpoint: http://localhost:${PORT}/webhook/opencode-results`)
  console.log("")
  console.log("NOTE: For OpenClaw integration, use the built-in /hooks/agent endpoint:")
  console.log("  http://localhost:18789/hooks/agent")
  console.log("")
  console.log("Configure OpenClaw in ~/.openclaw/openclaw.json:")
  console.log(JSON.stringify({
    hooks: {
      enabled: true,
      token: "your-secure-token",
      path: "/hooks",
      allowedAgentIds: ["main"]
    }
  }, null, 2))
})
