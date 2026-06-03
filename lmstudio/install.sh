#!/bin/bash
# lmstudio/install.sh — Install LM Studio daemon (llmster) and pull default model

set -e

echo "Installing LM Studio headless daemon (llmster)..."
curl -fsSL https://lmstudio.ai/install.sh | bash

echo ""
echo "Starting daemon..."
llmster start

echo ""
echo "Pulling default TAP core model (Qwen3 0.8B IQ4_XS)..."
llmster pull Qwen3-Zero-Coder-Reasoning-V2-0.8B-NEO-EX-IQ4_XS

echo ""
echo "Verifying..."
llmster status

echo ""
echo "LM Studio ready at http://localhost:1234"
echo "API endpoint: http://localhost:1234/v1/chat/completions"
