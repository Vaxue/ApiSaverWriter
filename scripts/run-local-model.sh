#!/bin/sh
set -eu

MODEL_PATH="${MINICPM_MODEL:-}"
if [ -z "$MODEL_PATH" ]; then
  echo "请设置 MINICPM_MODEL，例如：/models/MiniCPM5-2B-Q4_K_M.gguf" >&2
  exit 2
fi
if ! command -v llama-server >/dev/null 2>&1; then
  echo "未找到 llama-server，请安装 llama.cpp 后重试。" >&2
  exit 127
fi

HOST="${MINICPM_HOST:-127.0.0.1}"
PORT="${MINICPM_PORT:-8080}"
CONTEXT="${MINICPM_CONTEXT:-4096}"
THREADS="${MINICPM_THREADS:-}"

set -- llama-server -m "$MODEL_PATH" --host "$HOST" --port "$PORT" -c "$CONTEXT"
if [ -n "$THREADS" ]; then set -- "$@" -t "$THREADS"; fi
if [ "${MINICPM_GPU_LAYERS:-99}" != "0" ]; then set -- "$@" -ngl "${MINICPM_GPU_LAYERS:-99}"; fi
exec "$@"
