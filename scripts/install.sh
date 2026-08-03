#!/bin/sh
set -eu

cd "$(dirname "$0")/.."
npm install
npm run build
chmod +x dist/cli.js
npm link

echo "安装完成。请运行: agentctl init"
