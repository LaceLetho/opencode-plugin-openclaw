#!/usr/bin/env node
/**
 * Test harness for @laceletho/plugin-openclaw
 * Tests the fixed implementation with message part accumulation
 */

import { createServer } from "http"
import OpenclawPlugin from "./dist/index.js"

const MOCK_OPENCLAW_PORT = 18789
const PLUGIN_PORT = 9090

let receivedCallbacks = []

const mockOpenclawServer = createServer((req, res) => {
  const url = req.url || "/"
  const method = req.method || "GET"

  if (url === "/hooks/agent" && method === "POST") {
    let body = ""
    req.on("data", chunk => body += chunk)
    req.on("end", () => {
      try {
        const data = JSON.parse(body)
        receivedCallbacks.push({
          timestamp: new Date().toISOString(),
          data,
          headers: req.headers
        })
        console.log("\n✅ [Mock OpenClaw] Received callback:")
        console.log(JSON.stringify(data, null, 2))
        res.writeHead(200)
        res.end(JSON.stringify({ ok: true }))
      } catch (err) {
        console.error("[Mock OpenClaw] Failed to parse callback:", err)
        res.writeHead(400)
        res.end(JSON.stringify({ error: "Invalid JSON" }))
      }
    })
    return
  }

  res.writeHead(404)
  res.end(JSON.stringify({ error: "Not found" }))
})

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

async function testHealthEndpoint() {
  console.log("\n📋 Test 1: Health endpoint")
  const res = await fetch(`http://localhost:${PLUGIN_PORT}/health`)
  const data = await res.json()
  console.log("Response:", JSON.stringify(data, null, 2))
  if (data.status === "ok") {
    console.log("✅ Health check passed")
    return true
  }
  console.log("❌ Health check failed")
  return false
}

async function testRegisterEndpoint() {
  console.log("\n📋 Test 2: Register callback")
  const res = await fetch(`http://localhost:${PLUGIN_PORT}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: "test-session-001",
      callbackConfig: {
        url: `http://localhost:${MOCK_OPENCLAW_PORT}/hooks/agent`,
        apiKey: "test-api-key-123",
        agentId: "test-agent",
        channel: "last",
        deliver: true
      }
    })
  })
  const data = await res.json()
  console.log("Response:", JSON.stringify(data, null, 2))
  if (data.ok) {
    console.log("✅ Registration successful")
    return true
  }
  console.log("❌ Registration failed")
  return false
}

async function testMessagePartAccumulation(plugin) {
  console.log("\n📋 Test 3: Message part accumulation")
  
  await plugin["message.part.updated"]({
    part: {
      id: "part-1",
      sessionID: "test-session-001",
      messageID: "msg-1",
      type: "text",
      text: "Here's the solution:\n\n"
    }
  })
  
  await plugin["message.part.updated"]({
    part: {
      id: "part-2",
      sessionID: "test-session-001",
      messageID: "msg-1",
      type: "text",
      text: "```python\ndef hello():\n    print('Hello World')\n```"
    }
  })
  
  await plugin["message.part.delta"]({
    sessionID: "test-session-001",
    messageID: "msg-1",
    partID: "part-2",
    field: "text",
    delta: "\n\nThis function prints a greeting."
  })
  
  console.log("✅ Message parts accumulated")
  return true
}

async function testToolExecution(plugin) {
  console.log("\n📋 Test 4: Tool execution tracking")
  
  await plugin["message.part.updated"]({
    part: {
      id: "part-3",
      sessionID: "test-session-001",
      messageID: "msg-1",
      type: "tool",
      callID: "call-1",
      tool: "bash",
      state: {
        status: "completed",
        input: { command: "ls -la" },
        output: "file1.txt\nfile2.txt",
        title: "List files",
        metadata: {},
        time: { start: Date.now(), end: Date.now() }
      }
    }
  })
  
  console.log("✅ Tool execution tracked")
  return true
}

async function testSessionCompletion(plugin) {
  console.log("\n📋 Test 5: Session completion callback")
  
  receivedCallbacks = []
  
  await plugin["session.updated"]({
    info: {
      id: "test-session-001",
      status: "completed",
      title: "Test Session"
    }
  })
  
  await sleep(500)
  
  if (receivedCallbacks.length > 0) {
    const callback = receivedCallbacks[0]
    console.log("✅ Callback received with content:")
    console.log(callback.data.message)
    
    if (callback.data.message.includes("Here's the solution")) {
      console.log("✅ Accumulated text content included")
    } else {
      console.log("❌ Accumulated text content missing")
      return false
    }
    
    if (callback.data.message.includes("bash")) {
      console.log("✅ Tool output included")
    } else {
      console.log("❌ Tool output missing")
      return false
    }
    
    return true
  }
  console.log("❌ Callback not received")
  return false
}

async function testFailedSession(plugin) {
  console.log("\n📋 Test 6: Failed session handling")
  
  receivedCallbacks = []
  
  await fetch(`http://localhost:${PLUGIN_PORT}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: "test-session-002",
      callbackConfig: {
        url: `http://localhost:${MOCK_OPENCLAW_PORT}/hooks/agent`,
        apiKey: "test-api-key-123",
        agentId: "test-agent"
      }
    })
  })
  
  await plugin["session.error"]({
    sessionID: "test-session-002",
    error: { message: "API rate limit exceeded" }
  })
  
  await plugin["session.updated"]({
    info: {
      id: "test-session-002",
      status: "failed",
      title: "Failed Session"
    }
  })
  
  await sleep(500)
  
  if (receivedCallbacks.length > 0) {
    const callback = receivedCallbacks[0]
    console.log("✅ Failed session callback received")
    
    if (callback.data.message.includes("Task failed")) {
      console.log("✅ Failed status correctly indicated")
    }
    
    if (callback.data.message.includes("API rate limit exceeded")) {
      console.log("✅ Error message included")
    }
    
    return true
  }
  console.log("❌ Failed session callback not received")
  return false
}

async function testSessionDeletion(plugin) {
  console.log("\n📋 Test 7: Session deletion cleanup")
  
  await fetch(`http://localhost:${PLUGIN_PORT}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId: "test-session-003",
      callbackConfig: {
        url: `http://localhost:${MOCK_OPENCLAW_PORT}/hooks/agent`,
        apiKey: "test-api-key-123",
        agentId: "test-agent"
      }
    })
  })
  
  const res1 = await fetch(`http://localhost:${PLUGIN_PORT}/health`)
  const data1 = await res1.json()
  console.log(`Registered sessions before delete: ${data1.registeredSessions}`)
  
  await plugin["session.deleted"]({
    info: { id: "test-session-003" }
  })
  
  const res2 = await fetch(`http://localhost:${PLUGIN_PORT}/health`)
  const data2 = await res2.json()
  console.log(`Registered sessions after delete: ${data2.registeredSessions}`)
  
  if (data2.registeredSessions < data1.registeredSessions) {
    console.log("✅ Session deleted successfully")
    return true
  }
  console.log("❌ Session not deleted")
  return false
}

async function runTests() {
  console.log("=".repeat(60))
  console.log("Testing @laceletho/plugin-openclaw (Fixed)")
  console.log("=".repeat(60))

  console.log("\n🚀 Starting mock OpenClaw server...")
  await new Promise((resolve, reject) => {
    mockOpenclawServer.listen(MOCK_OPENCLAW_PORT, () => {
      console.log(`✅ Mock OpenClaw listening on port ${MOCK_OPENCLAW_PORT}`)
      resolve()
    })
    mockOpenclawServer.on("error", reject)
  })

  console.log("\n🔌 Initializing plugin...")
  const plugin = await OpenclawPlugin({
    config: {
      openclaw: {
        port: PLUGIN_PORT,
        openclawApiKey: "test-api-key"
      }
    }
  })
  console.log("✅ Plugin initialized")

  await sleep(500)

  let passed = 0
  let failed = 0

  try {
    if (await testHealthEndpoint()) passed++
    else failed++

    if (await testRegisterEndpoint()) passed++
    else failed++

    if (await testMessagePartAccumulation(plugin)) passed++
    else failed++

    if (await testToolExecution(plugin)) passed++
    else failed++

    if (await testSessionCompletion(plugin)) passed++
    else failed++

    if (await testFailedSession(plugin)) passed++
    else failed++

    if (await testSessionDeletion(plugin)) passed++
    else failed++

  } catch (err) {
    console.error("\n❌ Test error:", err)
    failed++
  }

  console.log("\n🧹 Cleaning up...")
  mockOpenclawServer.close()
  if (plugin.dispose) {
    await plugin.dispose()
  }

  console.log("\n" + "=".repeat(60))
  console.log("Test Results:")
  console.log(`  Passed: ${passed}`)
  console.log(`  Failed: ${failed}`)
  console.log("=".repeat(60))

  process.exit(failed > 0 ? 1 : 0)
}

runTests().catch(err => {
  console.error("Fatal error:", err)
  process.exit(1)
})
