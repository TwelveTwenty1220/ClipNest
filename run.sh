#!/usr/bin/env bash
# 启动 ClipNest。单进程多线程 —— 文件数据库的锁只在进程内可靠。
set -euo pipefail
cd "$(dirname "$0")"

HOST="${CLIPNEST_HOST:-127.0.0.1}"
PORT="${CLIPNEST_PORT:-8420}"

exec gunicorn \
  --workers 1 \
  --threads 8 \
  --bind "${HOST}:${PORT}" \
  --access-logfile - \
  --error-logfile - \
  --timeout 60 \
  wsgi:app
