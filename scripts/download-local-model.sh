#!/bin/sh
set -eu

MODEL_DIR="${1:-$PWD/local-model-assets}"
MODEL_URL="https://modelscope.cn/models/OpenBMB/MiniCPM5-2B-GGUF/resolve/master/MiniCPM5-2B-Q4_K_M.gguf"
mkdir -p "$MODEL_DIR"
if [ -f "$MODEL_DIR/MiniCPM5-2B-Q4_K_M.gguf" ]; then
  echo "模型已存在：$MODEL_DIR/MiniCPM5-2B-Q4_K_M.gguf"
  exit 0
fi
command -v curl >/dev/null 2>&1 || { echo "需要 curl" >&2; exit 127; }
echo "开始下载约 1.56GB 的 MiniCPM5 Q4_K_M 模型..."
curl -L --fail --retry 3 --continue-at - "$MODEL_URL" -o "$MODEL_DIR/MiniCPM5-2B-Q4_K_M.gguf"
echo "模型下载完成。请另外准备对应平台的 llama-server，然后设置 APISAVERWRITER_LOCAL_MODEL 和 APISAVERWRITER_LLAMA_SERVER。"
