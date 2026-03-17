#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: tmux-pane-send.sh [-t target] [-e encoding] [-n] text

Write text directly to the target pane TTY. This bypasses `tmux send-keys`
and is more reliable for non-UTF-8 text inside some `luit`-wrapped sessions.

Options:
  -t target    tmux target pane/window/session (default: active pane)
  -e encoding  text encoding to write to the pane TTY (default: UTF-8)
  -n           do not press Enter after paste

Examples:
  tmux-pane-send.sh 'look'
  tmux-pane-send.sh -t 0:cjk_mud 'look'
  tmux-pane-send.sh -t 0:cjk_mud -e GBK 'score'
EOF
}

target=''
encoding='UTF-8'
append_cr=1

while getopts ':t:e:nh' opt; do
  case "$opt" in
    t) target="$OPTARG" ;;
    e) encoding="$OPTARG" ;;
    n) append_cr=0 ;;
    h)
      usage
      exit 0
      ;;
    :)
      echo "Missing argument for -$OPTARG" >&2
      usage >&2
      exit 2
      ;;
    \?)
      echo "Unknown option: -$OPTARG" >&2
      usage >&2
      exit 2
      ;;
  esac
done
shift $((OPTIND - 1))

if [ "$#" -lt 1 ]; then
  usage >&2
  exit 2
fi

text="$1"

if [ -z "$target" ]; then
  target="$(tmux display-message -p '#{session_name}:#{window_index}.#{pane_index}')"
fi

pane_tty="$(tmux display-message -p -t "$target" '#{pane_tty}')"

payload="$text"
if [ "$append_cr" -eq 1 ]; then
  payload+=$'\r'
fi

if [ "${encoding^^}" = 'UTF-8' ] || [ "${encoding^^}" = 'UTF8' ]; then
  printf '%s' "$payload" > "$pane_tty"
else
  printf '%s' "$payload" | iconv -f UTF-8 -t "$encoding" > "$pane_tty"
fi
