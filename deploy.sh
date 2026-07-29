#!/bin/bash
set -e

echo "==> Pushing to GitHub..."
git add -A
git commit -m "${1:-deploy: update}" 2>/dev/null || echo "(nothing to commit)"
git push origin main

echo "==> Deploying to VPS..."
ssh root@159.195.47.180 "
  cd /var/www/auto-video &&
  git pull origin main &&
  npm install --production --silent &&
  pm2 restart auto-video &&
  echo 'Deploy OK'
"
