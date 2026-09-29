#!/usr/bin/env bash
# Installs beeper-assistant for one or more agents, then checks the setup.
#
#   ./install.sh                       copy into every agent found on this Mac
#   ./install.sh --to ~/.hermes/skills copy into one folder. Repeat --to for more
#   ./install.sh --link                symlink instead of copy, for working on the skill
#   ./install.sh --remove              remove it from the target folders
#   ./install.sh --no-check            skip the setup check at the end
#
# A copy is made read-only. Some agents rewrite their own skills after a session,
# and a read-only copy keeps this one the way it was shipped. Run again to update.
set -euo pipefail

NAME="beeper-assistant"
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE="copy"
CHECK=1
TARGETS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --to) [ $# -ge 2 ] || { echo "--to needs a folder" >&2; exit 2; }; TARGETS+=("${2/#\~/$HOME}"); shift 2 ;;
    --link) MODE="link"; shift ;;
    --remove) MODE="remove"; CHECK=0; shift ;;
    --no-check) CHECK=0; shift ;;
    -h|--help) awk 'NR>1 && /^#/ {sub(/^# ?/,""); print; next} NR>1 {exit}' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

if [ ${#TARGETS[@]} -eq 0 ]; then
  # An agent is installed when its home folder exists. Its skills folder may not exist yet.
  [ -d "$HOME/.claude" ] && TARGETS+=("$HOME/.claude/skills")                          # Claude Code
  { [ -d "$HOME/.agents" ] || [ -d "$HOME/.codex" ]; } && TARGETS+=("$HOME/.agents/skills")  # Codex and others
  if [ -d "$HOME/.hermes" ]; then                                                      # Hermes
    if [ -d "$HOME/.agents" ] && grep -qs "agents/skills" "$HOME/.hermes/config.yaml"; then
      echo "Hermes already reads ~/.agents/skills, so it needs no copy of its own."
    else
      TARGETS+=("$HOME/.hermes/skills")
    fi
  fi
fi

if [ ${#TARGETS[@]} -eq 0 ]; then
  echo "No agent found on this Mac. Looked for ~/.claude, ~/.agents, ~/.codex and ~/.hermes." >&2
  echo "Name your agent's skills folder yourself:  ./install.sh --to <folder>" >&2
  exit 1
fi

clear_dest() {
  local dest="$1"
  if [ -L "$dest" ]; then rm "$dest"
  elif [ -d "$dest" ]; then
    [ -f "$dest/SKILL.md" ] && grep -qs "^name: $NAME$" "$dest/SKILL.md" || { echo "  $dest exists and is not this skill. Left alone." >&2; return 1; }
    chmod -R u+w "$dest" && rm -rf "$dest"
  fi
}

DONE=()
for dir in "${TARGETS[@]}"; do
  dest="$dir/$NAME"
  case "$MODE" in
    remove)
      if [ -e "$dest" ] || [ -L "$dest" ]; then clear_dest "$dest" && echo "Removed $dest"; else echo "Nothing at $dest"; fi
      ;;
    link)
      [ "$SRC" = "$dest" ] && { echo "Found   $dest  (this checkout is already in place)"; DONE+=("$dest"); continue; }
      mkdir -p "$dir"; clear_dest "$dest" || continue
      ln -s "$SRC" "$dest"; echo "Linked  $dest -> $SRC"; DONE+=("$dest")
      ;;
    copy)
      [ "$SRC" = "$dest" ] && { echo "Found   $dest  (this checkout is already in place)"; DONE+=("$dest"); continue; }
      mkdir -p "$dir"; clear_dest "$dest" || continue
      mkdir -p "$dest"
      cp "$SRC/SKILL.md" "$dest/"
      cp -R "$SRC/references" "$SRC/scripts" "$dest/"
      [ -f "$SRC/LICENSE" ] && cp "$SRC/LICENSE" "$dest/"
      # The source may be a download and not a git checkout, so none of this may fail the install.
      rev="$(git -C "$SRC" rev-parse --short HEAD 2>/dev/null || true)"
      dirty=""
      if [ -n "$rev" ]; then dirty="$(git -C "$SRC" status --porcelain -- "$SRC" 2>/dev/null | head -1 || true)"; fi
      rev="${rev:-not from git}"
      printf 'source: %s\nrevision: %s%s\ninstalled: %s\n' "$SRC" "$rev" "${dirty:+ plus uncommitted changes}" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$dest/INSTALLED"
      chmod -R a-w "$dest"
      echo "Copied  $dest  (read-only, revision $rev${dirty:+ plus uncommitted changes})"
      DONE+=("$dest")
      ;;
  esac
done

[ "$MODE" = "remove" ] && exit 0
[ ${#DONE[@]} -gt 0 ] || { echo "Nothing was installed." >&2; exit 1; }

BA="${DONE[0]}/scripts/ba.mjs"
echo
if [ "$CHECK" = "1" ]; then
  echo "Checking the setup:"
  if ! command -v node >/dev/null 2>&1; then
    echo "FAIL  Node not found"
    echo "      Fix: brew install node"
    echo "      No brew command? Install Homebrew first, from https://brew.sh"
    echo
    echo "Setup is not finished. Fix the line marked FAIL, then check again."
  elif node "$BA" check; then
    echo
    echo "Ready. Ask your agent:  what needs my reply?"
    echo "A new skill loads when a session starts. An agent that is mid-session can read"
    echo "${DONE[0]}/SKILL.md and use it right away."
  else
    echo
    echo "Setup is not finished. Fix each line marked FAIL, then check again."
  fi
  echo
fi
echo "Check the setup any time:  node \"$BA\" check"
