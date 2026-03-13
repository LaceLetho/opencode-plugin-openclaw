#!/bin/bash

# OpenCode Plugin Task Dispatch Script
# 
# This script sends tasks to OpenCode for async execution.
# Results are sent back to OpenClaw via its /hooks/agent endpoint.
#
# Prerequisites:
# 1. OpenCode server running with @laceletho/plugin-openclaw installed
# 2. OpenClaw Gateway running with hooks enabled
# 3. OPENCLAW_API_KEY environment variable set (matching OpenClaw hooks.token)

OPENCODE_URL="${OPENCODE_URL:-http://localhost:9090}"
TASK_ID="task-$(date +%s)"
PROMPT="$1"

# OpenClaw /hooks/agent endpoint (not a custom webhook URL)
CALLBACK_URL="${CALLBACK_URL:-http://localhost:18789/hooks/agent}"

if [ -z "$PROMPT" ]; then
  echo "Usage: $0 'Your task prompt here'"
  echo ""
  echo "Examples:"
  echo "  $0 'Write a Python function to calculate fibonacci numbers'"
  echo "  $0 'Refactor src/auth.ts to use JWT tokens'"
  exit 1
fi

echo "Dispatching task: $TASK_ID"
echo "Prompt: $PROMPT"
echo "Callback: $CALLBACK_URL"
echo ""

# Send task to OpenCode
# The plugin will execute the task and POST results to OpenClaw's /hooks/agent
curl -X POST "${OPENCODE_URL}/tasks" \
  -H "Content-Type: application/json" \
  -d "{
    \"taskId\": \"${TASK_ID}\",
    \"prompt\": \"${PROMPT}\",
    \"callbackUrl\": \"${CALLBACK_URL}\",
    \"callbackConfig\": {
      \"name\": \"OpenCode Task\",
      \"agentId\": \"main\",
      \"deliver\": true,
      \"channel\": \"last\"
    }
  }"

echo ""
echo ""
echo "Task dispatched successfully!"
echo ""
echo "Next steps:"
echo "1. OpenCode will process the task in the background"
echo "2. When complete, results will be POSTed to OpenClaw's /hooks/agent"
echo "3. OpenClaw will forward the results to your configured channel (Telegram, Slack, etc.)"
echo ""
echo "Check task status:"
echo "  curl ${OPENCODE_URL}/tasks/${TASK_ID}"
