#!/bin/bash

OPENCODE_URL="${OPENCODE_URL:-http://localhost:9090}"
TASK_ID="task-$(date +%s)"
PROMPT="$1"
CALLBACK_URL="${CALLBACK_URL:-https://your-openclaw-server.com/webhook/results}"

if [ -z "$PROMPT" ]; then
  echo "Usage: $0 'Your task prompt here'"
  exit 1
fi

echo "Dispatching task: $TASK_ID"
echo "Prompt: $PROMPT"

curl -X POST "${OPENCODE_URL}/tasks" \
  -H "Content-Type: application/json" \
  -d "{
    \"taskId\": \"${TASK_ID}\",
    \"prompt\": \"${PROMPT}\",
    \"callbackUrl\": \"${CALLBACK_URL}\"
  }"

echo ""
echo "Task dispatched. Waiting for callback..."
