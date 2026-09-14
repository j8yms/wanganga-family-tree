# Quick sync script: pull, commit all changes, push to main
# Usage: .\sync.ps1 "your commit message"

param(
    [string]$Message = "update: $(Get-Date -Format 'yyyy-MM-dd HH:mm')"
)

Write-Host "Syncing with origin/main..." -ForegroundColor Cyan

# Pull latest
Write-Host "Pulling latest changes..."
git pull origin main
if ($LASTEXITCODE -ne 0) {
    Write-Host "Pull failed. Resolve conflicts first." -ForegroundColor Red
    exit 1
}

# Add all changes
Write-Host "Staging changes..."
git add -A

# Check if there's anything to commit
$status = git status --porcelain
if (-not $status) {
    Write-Host "No changes to commit." -ForegroundColor Green
    exit 0
}

# Commit
Write-Host "Committing: $Message"
git commit -m $Message
if ($LASTEXITCODE -ne 0) {
    Write-Host "Commit failed." -ForegroundColor Red
    exit 1
}

# Push
Write-Host "Pushing to origin/main..."
git push origin main
if ($LASTEXITCODE -ne 0) {
    Write-Host "Push failed. Try pulling again." -ForegroundColor Red
    exit 1
}

Write-Host "Sync complete! Site deploys in ~1 min." -ForegroundColor Green