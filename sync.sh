#!/bin/bash
# Quick sync script: pull, commit all changes, push to main
# Usage: ./sync.sh "your commit message"

set -e

MSG="${1:-update: $(date '+%Y-%m-%d %H:%M')}"

echo "🔄 Syncing with origin/main..."

# Pull latest
echo "📥 Pulling latest changes..."
git pull origin main

# Add all changes
echo "📦 Staging changes..."
git add -A

# Check if there's anything to commit
if [ -z "$(git status --porcelain)" ]; then
    echo "✅ No changes to commit."
    exit 0
fi

# Commit
echo "💾 Committing: $MSG"
git commit -m "$MSG"

# Push
echo "📤 Pushing to origin/main..."
git push origin main

echo "✅ Sync complete! Site deploys in ~1 min."