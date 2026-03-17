#!/usr/bin/env bash

set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$repo_root"

server_pid=""
server_port="${PORT:-4315}"
server_url="http://127.0.0.1:${server_port}"
health_url="${server_url}/api/health"
startup_timeout="${MUD_AGENT_START_TIMEOUT_SECONDS:-20}"

log() {
  printf '[start.sh] %s\n' "$*"
}

fail() {
  printf '[start.sh] %s\n' "$*" >&2
  exit 1
}

stop_server() {
  if [[ -n "${server_pid}" ]] && kill -0 "${server_pid}" 2>/dev/null; then
    log "Stopping dev server"
    kill "${server_pid}" 2>/dev/null || true
    wait "${server_pid}" 2>/dev/null || true
  fi
}

trap 'stop_server' EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

require_command() {
  local command_name="$1"
  local install_hint="$2"
  if ! command -v "${command_name}" >/dev/null 2>&1; then
    fail "Missing required command: ${command_name}. ${install_hint}"
  fi
}

wait_for_server() {
  local deadline=$((SECONDS + startup_timeout))

  while (( SECONDS < deadline )); do
    if [[ -n "${server_pid}" ]] && ! kill -0 "${server_pid}" 2>/dev/null; then
      wait "${server_pid}" || true
      return 1
    fi

    if node -e '
      const targetUrl = process.argv[1];
      const client = require(targetUrl.startsWith("https:") ? "https" : "http");
      const request = client.get(targetUrl, (response) => {
        process.exit(response.statusCode === 200 ? 0 : 1);
      });
      request.on("error", () => process.exit(1));
      request.setTimeout(1000, () => {
        request.destroy();
        process.exit(1);
      });
    ' "${health_url}" >/dev/null 2>&1; then
      return 0
    fi

    sleep 1
  done

  return 1
}

open_browser() {
  if [[ -n "${BROWSER:-}" ]]; then
    "${BROWSER}" "${server_url}" >/dev/null 2>&1 &
    return 0
  fi

  if [[ -n "${WSL_DISTRO_NAME:-}" ]] || grep -qi microsoft /proc/sys/kernel/osrelease 2>/dev/null; then
    if command -v cmd.exe >/dev/null 2>&1; then
      if cmd.exe /c start "" "${server_url}" >/dev/null 2>&1; then
        return 0
      fi
    fi
  fi

  if command -v xdg-open >/dev/null 2>&1; then
    if xdg-open "${server_url}" >/dev/null 2>&1; then
      return 0
    fi
  fi

  if command -v open >/dev/null 2>&1; then
    if open "${server_url}" >/dev/null 2>&1; then
      return 0
    fi
  fi

  return 1
}

require_command "node" "Install Node.js 18 or newer."
require_command "npm" "Install npm alongside Node.js."
require_command "tmux" "Install tmux before running this project."

if [[ ! -d node_modules ]]; then
  log "Installing npm dependencies"
  npm install
fi

if [[ ! -f config/local.secrets.json ]]; then
  log "Creating config/local.secrets.json from template"
  cp config/local.secrets.example.json config/local.secrets.json
fi

if tmux has-session -t 0 2>/dev/null; then
  log "Reusing tmux session 0"
else
  log "Creating tmux session 0"
  tmux new-session -d -s 0
fi

log "Starting local server on ${server_url}"
npm run dev &
server_pid=$!

if ! wait_for_server; then
  fail "Server did not become ready at ${health_url} within ${startup_timeout}s."
fi

if open_browser; then
  log "Opened ${server_url} in your browser"
else
  log "Open ${server_url} in your browser"
fi

log "Server is running. Press Ctrl+C to stop it."
wait "${server_pid}"
