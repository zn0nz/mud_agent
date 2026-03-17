# Repo Guidelines

This repo is intended to be installed and managed by AI agents to play Multi-user dungeon (MUD) session.

## Agent play guideline
Be nice and helpful in the game when interacting with other players, but don't overdo it.

## Local Secrets

Credentials are local machine state and should not be committed.

- Store them in `config/local.secrets.json`.
- Use `config/local.secrets.example.json` as the template.
- Store login credentials for each server under its server id in that file.
- If a server later needs scripted login, read from the same local secrets file.

## Preferred Runtime

Use `tmux` plus `TinTin++`.

**For MUDs using non-UTF-8 encodings (GBK, BIG5, etc.):** See `SETUP.md` for
how to use `luit` in tmux and when to prefer `scripts/tmux-pane-send.sh`.

Before continuing play, read `./walkthrough/README.md` and any relevant
walkthrough files under `./walkthrough/`.

## Web Control Surface

The repo now includes a local web control server for tmux-backed sessions.

- Start it with `npm run dev`.
- It binds to `127.0.0.1` only.
- It exposes tmux and MUD session APIs plus a local monitoring/control page.
- The browser UI is additive. Direct tmux workflows remain supported.

### Web UI Capabilities

- `TMUX Output` streams the selected tmux pane and now renders ANSI colors in the browser.
- `Agent Terminal` is interactive tmux-backed agent control: it launches a real TUI in its own tmux window and drives it from the browser.
- Interactive agents currently use dedicated tmux windows such as `0:codex_tui`, `0:claude_tui`, `0:opencode_tui`, and `0:openclaw_tui`.
- The left-side server panel is agent-first: `Start Agent` will start or reuse the selected tmux target automatically. `Manual Login` remains available only as a recovery control for character/password prompts.

### Interactive Agent Workflow

1. Start the local UI server with `npm run dev`.
2. Open the browser UI.
3. Select the agent.
4. Click `Start Agent`.
5. The UI will create or reuse both the target tmux pane and the agent tmux window automatically.
6. Agent startup is provider-specific. Codex uses a runtime bootstrap file under `apps/server/.runtime/interactive-prompts/` plus a short instruction to read it. OpenClaw uses `openclaw tui` and receives an inline startup prompt directly.
7. Click inside `Agent Terminal` to focus it, then type.

Supported interactive input in the browser:

- Plain text keys
- `Enter`, `Tab`, `Escape`, `Backspace`
- Arrow keys
- `Home`, `End`, `PageUp`, `PageDown`
- `Ctrl` + letter
- Paste text

Notes:

- Interactive agents are tmux-backed, not PTY processes attached directly to the browser.
- Codex and OpenClaw are currently the interactive agent profiles that have passed local smoke tests against live tmux-backed MUD sessions.
- OpenClaw has been smoke-tested against live tmux-backed MUD sessions for safe read/control actions.
- Codex startup uses a runtime bootstrap file plus a short instruction instead of typing the full prompt into the TUI input line.
- OpenClaw startup uses the local Gateway-backed `openclaw tui` flow and works better with a shorter inline operating prompt than with the file-bootstrap model used by Codex.
- If an interactive agent exits immediately, its tmux window is configured with `remain-on-exit` so the failure output can still be inspected.
- For full raw-terminal fidelity later, prefer building on top of tmux or adding `xterm.js`; do not replace tmux with ad hoc shell pipes.

## Standard Workflow

1. Check that tmux is running:
   `tmux ls`
2. Check the Aardwolf window:
   `tmux list-windows -t 0`
3. Read the current game state without attaching:
   `tmux capture-pane -pt 0:aardwolf | tail -n 80`
4. Send game commands:
   `tmux send-keys -t 0:aardwolf 'look' Enter`
5. If interactive control is needed, attach:
   `tmux attach -t 0`

## Interactive Agent Windows

You can also drive interactive coding agents directly in tmux.

- Start Codex TUI manually:
  `tmux new-window -t 0: -n codex_tui 'cd /path/to/mud_agent && exec codex -p codex-lb -s danger-full-access'`
- Start OpenClaw TUI manually:
  `tmux new-window -t 0: -n openclaw_tui 'cd /path/to/mud_agent && exec openclaw tui --session mud-agent'`
- Start Claude Code TUI manually:
  `tmux new-window -t 0: -n claude_tui 'cd /path/to/mud_agent && exec claude --dangerously-skip-permissions'`
- Inspect the window:
  `tmux capture-pane -pt 0:codex_tui | tail -n 80`
- Send keys manually:
  `tmux send-keys -t 0:codex_tui Enter`

The browser `Start Agent` button uses the same model: it creates or reuses a dedicated tmux window per agent, applies the agent's configured startup mode, and then streams that pane back into the UI.

## Non-UTF-8 Workflow

For MUDs that use `GBK`, `GB2312`, `BIG5`, or similar encodings:

1. Start the client through `luit`:
   `tmux new-window -t 0: -n cjk_mud 'luit -encoding GBK telnet <host> <port>'`
2. Inspect the pane:
   `tmux capture-pane -pt 0:cjk_mud | tail -n 80`
3. Send commands with the pane TTY helper when needed:
   `./scripts/tmux-pane-send.sh -t 0:cjk_mud -e GBK 'look'`

If a non-UTF-8 pane wedges, start a fresh tmux window and reconnect there.

## If The Window Is Missing

Start a fresh TinTin++ window inside the existing tmux session:

`tmux new-window -t 0: -n aardwolf './scripts/aardwolf-tintin.sh'`

Then log in with the credentials from `config/local.secrets.json`.

## Operating Rules

- Reuse the configured Aardwolf character; do not create additional throwaway characters unless explicitly requested.
- Prefer driving the live tmux window with `tmux send-keys` and `tmux capture-pane`.
- Before sending commands, inspect the pane so prompts are not skipped blindly.
- Keep actions reversible and low-risk unless the user asks for a specific gameplay choice.
- If disconnected, reconnect in the same `0:aardwolf` window and continue with the saved credentials.
- For non-UTF-8 sessions, prefer `scripts/tmux-pane-send.sh` over raw `tmux send-keys` when the terminal client mangles input.
- Read and update walkthrough notes in `./walkthrough/` while playing.
