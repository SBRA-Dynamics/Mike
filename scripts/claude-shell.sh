# shellcheck shell=bash
# `Claude` — Claude Code in a terminal, the way Mike can take it over.
#
# Source it from ~/.bashrc (or ~/.bash_aliases):
#
#   export MIKE_CLAUDE_FLAGS="--dangerously-skip-permissions"   # optional
#   . ~/mike/scripts/claude-shell.sh
#
# Then start Claude Code with `Claude` instead of `claude`:
#
#  * Every session runs in the background (`claude --bg`) and this terminal
#    attaches to it, so closing the window or pressing Ctrl+Z leaves the job
#    running. `claude agents` lists the sessions, `claude attach <id>` opens one.
#  * Every session gets a free spoken name from Mike's book — Wyoh, Prof,
#    Mannie… — unless -n is given, so "Mike, connect to Wyoh" can find it.
#  * `Claude -r Wyoh` opens a background session again by name or id. Plain
#    `claude --resume` with flags would start a copy of it instead.
#  * When Mike has taken the session over, the terminal says so as it detaches.
#
# MIKE_CLAUDE_FLAGS is passed to every new session: permissions, model, effort.
# It is word-split, so it cannot hold an argument with a space in it. Plain
# `claude` is left alone. Needs bash, node and Claude Code 2.1.273 or later.

_MIKE_CLAUDE_HELPER="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/terminal-session.mjs"

unalias Claude 2>/dev/null
Claude() {
	local a prev="" ref="" named="" helper="$_MIKE_CLAUDE_HELPER"
	# shellcheck disable=SC2206
	local flags=($MIKE_CLAUDE_FLAGS)
	# Subcommands and one-shot/info flags do not make sense in the background.
	case "$1" in
		agents|attach|auth|auto-mode|doctor|gateway|import|install|logs|mcp|plugin|plugins|project|respawn|rm|stop|kill|setup-token|ultrareview|update|upgrade)
			command claude "$@"; return ;;
	esac
	for a in "$@"; do
		case "$a" in
			-p|--print|-h|--help|-v|--version)
				command claude "${flags[@]}" "$@"; return ;;
			-n|--name|--name=*) named=1 ;;
			--resume=*) ref="${a#--resume=}" ;;
		esac
		case "$prev" in -r|--resume) ref="$a" ;; esac
		prev="$a"
	done
	# A bare -r opens the picker, which needs a foreground session.
	case "$prev" in -r|--resume)
		command claude "${flags[@]}" "$@"; return ;;
	esac

	local out id name
	if [ -n "$ref" ] && [ -f "$helper" ] && id=$(node "$helper" find "$ref" 2>/dev/null); then
		command claude attach "$id"
		node "$helper" after "$id" 2>/dev/null
		return
	fi

	local extra=()
	if [ -z "$named" ] && [ -f "$helper" ] && name=$(node "$helper" name 2>/dev/null) && [ -n "$name" ]; then
		extra=(-n "$name")
	fi
	out=$(command claude "${flags[@]}" --bg "${extra[@]}" "$@" 2>&1)
	id=$(sed -n 's/.*backgrounded · \([0-9a-f]\{8\}\).*/\1/p' <<<"$out" | head -n 1)
	if [ -z "$id" ]; then
		printf '%s\n' "$out"
		return 1
	fi
	command claude attach "$id"
	[ -f "$helper" ] && node "$helper" after "$id" 2>/dev/null
}
