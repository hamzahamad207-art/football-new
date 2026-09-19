#!/usr/bin/env bash
# deploy.sh — safe one-shot deployer for The Touchline AR bot.
#
# What this does:
#   1. Verifies `gh` (GitHub CLI) is installed and authenticated.
#   2. Asks you for a repo name + visibility.
#   3. Asks you for your Z.ai API key (for LLM Arabic text generation).
#   4. Asks you for your Threads token + user id (silent input).
#   5. Creates the repo on your GitHub account (or pushes to an existing one).
#   6. Commits + pushes all bot files.
#   7. Sets four GitHub Secrets: LLM_API_KEY, LLM_MODEL, THREADS_ACCESS_TOKEN, THREADS_USER_ID.
#   8. Triggers the first dry-run workflow.
#
# You never paste a GitHub PAT anywhere. The `gh` CLI uses OAuth via browser.
# Your Z.ai key + Threads token are only ever typed in your own terminal
# (silent prompts) and go straight to GitHub Secrets.

set -euo pipefail

# ─── Colors ───────────────────────────────────────────────────────────────
GREEN='\033[0;32m'; YELLOW='\033[0;33m'; RED='\033[0;31m'; CYAN='\033[0;36m'; NC='\033[0m'
log()  { echo -e "${GREEN}✓${NC} $*"; }
warn() { echo -e "${YELLOW}!${NC} $*"; }
err()  { echo -e "${RED}✗${NC} $*" >&2; }
step() { echo -e "\n${CYAN}── $* ──${NC}"; }

# ─── 1. Pre-flight checks ─────────────────────────────────────────────────
step "1/8  Pre-flight checks"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [[ ! -f package.json ]] || [[ ! -d src ]]; then
  err "Must run from the bot root (next to package.json). Aborting."
  exit 1
fi
log "Running from: $SCRIPT_DIR"

if ! command -v git >/dev/null 2>&1; then
  err "git not installed. Install it first: https://git-scm.com/downloads"
  exit 1
fi
log "git: OK"

if ! command -v gh >/dev/null 2>&1; then
  err "GitHub CLI (gh) not installed."
  echo ""
  echo "Install it from https://cli.github.com/ — then run:"
  echo "  gh auth login      # choose: GitHub.com → HTTPS → Login with browser"
  echo "  ./deploy.sh"
  exit 1
fi
log "gh: OK ($(gh --version | head -1))"

if ! gh auth status >/dev/null 2>&1; then
  warn "You're not logged in to gh. Starting login flow..."
  echo ""
  echo "When the browser opens, choose:"
  echo "  • GitHub.com"
  echo "  • HTTPS"
  echo "  • Login with a web browser"
  echo ""
  gh auth login --web --git-protocol https
fi

GH_USER="$(gh api user --jq .login 2>/dev/null || true)"
if [[ -z "$GH_USER" ]]; then
  err "Could not read your GitHub username. Re-run: gh auth login"
  exit 1
fi
log "Authenticated as: $GH_USER"

# ─── 2. Repo name + visibility ────────────────────────────────────────────
step "2/8  Repo details"

read -rp "Repo name [touchline-arabic-bot]: " REPO_NAME
REPO_NAME="${REPO_NAME:-touchline-arabic-bot}"

read -rp "Visibility (private/public) [private]: " VIS
VIS="${VIS:-private}"
case "${VIS,,}" in
  p|private)  VIS_FLAG="--private"  ;;
  pub|public) VIS_FLAG="--public"   ;;
  *)          VIS_FLAG="--private"  ;;
esac

EXISTING_REPO=""
if gh repo view "$GH_USER/$REPO_NAME" >/dev/null 2>&1; then
  warn "Repo $GH_USER/$REPO_NAME already exists."
  read -rp "Push to this existing repo (replaces its main branch)? [y/N]: " PUSH_EXISTING
  case "${PUSH_EXISTING:-n}" in
    y|Y|yes|YES) EXISTING_REPO="yes" ;;
    *)
      read -rp "Use a different name? Leave blank to abort: " REPO_NAME
      REPO_NAME="${REPO_NAME:-}"
      [[ -z "$REPO_NAME" ]] && { err "Aborted."; exit 1; }
      ;;
  esac
fi

# ─── 3. Z.ai LLM API key ─────────────────────────────────────────────────
step "3/8  Z.ai API key (for Arabic text generation)"

echo "The bot uses Z.ai's public GLM-4 API (OpenAI-compatible) to generate Arabic text."
echo "Get a free API key at: https://z.ai/  → Sign in → API Keys → Create new key"
echo ""
echo "Paste your Z.ai API key (input is hidden)."
read -rs -p "Z.ai API key: " LLM_API_KEY; echo

if [[ -z "$LLM_API_KEY" ]]; then
  err "No Z.ai API key entered. Aborting."
  echo "  → Sign up at https://z.ai and create an API key, then re-run this script."
  exit 1
fi

echo ""
echo "Optionally override the model (default: glm-4.5-flash, free tier)."
echo "  Free:  glm-4.5-flash, glm-4.7-flash"
echo "  Paid:  glm-4.6 (flagship), glm-5.3 (latest)"
read -rp "LLM_MODEL [glm-4.5-flash]: " LLM_MODEL_INPUT
LLM_MODEL="${LLM_MODEL_INPUT:-glm-4.5-flash}"

log "LLM key + model captured."

# ─── 4. Threads credentials ──────────────────────────────────────────────
step "4/8  Threads credentials"

if [[ -z "${THREADS_ACCESS_TOKEN:-}" ]]; then
  echo "Paste your Threads access token (input is hidden)."
  echo "  Get it from: https://developers.facebook.com/apps/  → your Threads app"
  read -rs -p "THREADS_ACCESS_TOKEN: " THREADS_ACCESS_TOKEN; echo
  if [[ -z "$THREADS_ACCESS_TOKEN" ]]; then
    err "No token entered. Aborting."
    exit 1
  fi
fi

if [[ -z "${THREADS_USER_ID:-}" ]]; then
  echo "Paste your Threads user id (numeric, ~17 digits)."
  read -rs -p "THREADS_USER_ID: " THREADS_USER_ID; echo
  if [[ -z "$THREADS_USER_ID" ]]; then
    err "No user id entered. Aborting."
    exit 1
  fi
fi

if ! [[ "$THREADS_USER_ID" =~ ^[0-9]{8,20}$ ]]; then
  warn "Threads user id doesn't look numeric. Continuing anyway — verify it on https://developers.facebook.com/"
fi
if ! [[ "$THREADS_ACCESS_TOKEN" =~ ^[A-Za-z0-9]{50,}$ ]]; then
  warn "Threads token doesn't look right. Continuing anyway — verify it."
fi

log "Threads credentials captured."

# ─── 5. Initialize git + commit ────────────────────────────────────────────
step "5/8  Committing bot files"

if [[ ! -d .git ]]; then
  git init -q
  git branch -M main
fi
git add -A
git commit -q -m "init: The Touchline AR bot" 2>/dev/null || log "Nothing new to commit (already committed)."

# ─── 6. Create the repo (or push to existing) + push code ─────────────────
if [[ -n "$EXISTING_REPO" ]]; then
  step "6/8  Pushing to existing repo"
  warn "Force-pushing your local main to $GH_USER/$REPO_NAME (replaces the remote main)."
  git remote remove origin 2>/dev/null || true
  git remote add origin "https://github.com/$GH_USER/$REPO_NAME.git"
  git push -u origin main --force
else
  step "6/8  Creating repo and pushing code"
  gh repo create "$GH_USER/$REPO_NAME" $VIS_FLAG \
    --source=. --remote=origin --push 2>/dev/null || \
  {
    warn "Repo creation or initial push had an issue. Trying push manually..."
    git remote remove origin 2>/dev/null || true
    git remote add origin "https://github.com/$GH_USER/$REPO_NAME.git"
    git push -u origin main
  }
fi

log "Pushed to: https://github.com/$GH_USER/$REPO_NAME"

# ─── 7. Set GitHub Secrets ────────────────────────────────────────────────
step "7/8  Setting GitHub Secrets"

# LLM_API_KEY + LLM_MODEL (set with the default so the workflow is consistent)
printf '%s' "$LLM_API_KEY" | gh secret set LLM_API_KEY --repo "$GH_USER/$REPO_NAME"
log "LLM_API_KEY → set"

printf '%s' "$LLM_MODEL" | gh secret set LLM_MODEL --repo "$GH_USER/$REPO_NAME"
log "LLM_MODEL → set ($LLM_MODEL)"

# Threads creds
printf '%s' "$THREADS_ACCESS_TOKEN" | gh secret set THREADS_ACCESS_TOKEN --repo "$GH_USER/$REPO_NAME"
log "THREADS_ACCESS_TOKEN → set"

printf '%s' "$THREADS_USER_ID" | gh secret set THREADS_USER_ID --repo "$GH_USER/$REPO_NAME"
log "THREADS_USER_ID → set"

# Wipe from local env
LLM_API_KEY=""
LLM_MODEL=""
THREADS_ACCESS_TOKEN=""
THREADS_USER_ID=""

# ─── 8. Trigger first dry-run + show next steps ───────────────────────────
step "8/8  Triggering first dry-run"

sleep 5

if gh workflow list --repo "$GH_USER/$REPO_NAME" | grep -q "Post to Threads"; then
  gh workflow run "post.yml" --repo "$GH_USER/$REPO_NAME" \
    --raw-field content_type=random \
    --raw-field dry_run=true
  log "Triggered first dry-run workflow."
  log "Watch it at: https://github.com/$GH_USER/$REPO_NAME/actions"
else
  warn "Workflow file not detected yet (sometimes takes 30s)."
  echo "  → Open https://github.com/$GH_USER/$REPO_NAME/actions"
  echo "  → Click 'The Touchline AR — Post to Threads' → 'Run workflow'"
fi

echo ""
echo "───────────────────────────────────────────────────────────────────"
echo "✅ Deployed!  Repo:  https://github.com/$GH_USER/$REPO_NAME"
echo ""
echo "Secrets set:"
echo "  • LLM_API_KEY          (your Z.ai API key)"
echo "  • LLM_MODEL            ($LLM_MODEL)"
echo "  • THREADS_ACCESS_TOKEN"
echo "  • THREADS_USER_ID"
echo ""
echo "Next steps:"
echo "  1. Watch the dry-run in the Actions tab."
echo "  2. When happy, click 'Run workflow' again, set dry_run=false, pick a type."
echo "  3. Check your Threads — the post should appear within ~1 min."
echo ""
echo "Quick re-trigger commands:"
echo "  gh workflow run post.yml --repo $GH_USER/$REPO_NAME \\"
echo "    --raw-field content_type=news --raw-field dry_run=false"
echo ""
echo "  gh run watch --repo $GH_USER/$REPO_NAME   # watch the latest run live"
echo "───────────────────────────────────────────────────────────────────"
