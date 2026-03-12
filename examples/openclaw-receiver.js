const http = require("http")

const PORT = process.env.PORT || 3000

const server = http.createServer((req, res) => {
  if (req.url === "/webhook/opencode-results" && req.method === "POST") {
    let body = ""
    req.on("data", (chunk) => body += chunk)
    req.on("end", () => {
      try {
        const result = JSON.parse(body)
        console.log("[OpenClaw] Received callback from OpenCode:")
        console.log(JSON.stringify(result, null, 2))
        
        res.writeHead(200)
        res.end(JSON.stringify({ received: true }))
      } catch (err) {
        console.error("[OpenClaw] Failed to parse callback:", err)
        res.writeHead(400)
        res.end(JSON.stringify({ error: "Invalid JSON" }))
      }
    })
    return
  }

  res.writeHead(404)
  res.end(JSON.stringify({ error: "Not found" }))
})

server.listen(PORT, () => {
  console.log(`[OpenClaw] Webhook receiver listening on port ${PORT}`)
  console.log(`[OpenClaw] Endpoint: http://localhost:${PORT}/webhook/opencode-results`)
})
