#!/usr/bin/env bash
# Auto Video Creator — khởi động server
cd "$(dirname "$0")"

if [ ! -d node_modules ]; then
  echo "📦 Đang cài dependencies..."
  npm install
fi

echo ""
echo "🎬 Khởi động Auto Video Creator..."
echo "   Truy cập: http://localhost:3000"
echo ""
node server.js
