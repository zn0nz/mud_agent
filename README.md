<p align="center">
  <a href="./README.md">English</a> |
  <a href="./README_CN.md">中文</a> |
  <a href="./README_JA.md">日本語</a> |
  <a href="./README_FR.md">Français</a> |
  <a href="./README_ES.md">Español</a>
</p>

![aardwolf_play_sample](https://github.com/user-attachments/assets/e397507d-028f-46d3-a561-9d91730100bb)

# mud-agent

`mud-agent` is a local control surface for running MUD sessions through AI coding
agents. It combines `tmux`, launcher scripts, per-server configuration, and a
small local web server so agents can inspect live game output and act through
existing panes instead of ad hoc shell pipes.

## Usage Notice

Some MUDs forbid bot play, AFK play, or other forms of automation. Before using
this repo against any game, check that game's rules and make sure your usage
complies with them.

## What It Supports

- Built-in Aardwolf support (`UTF-8`)
- Custom MUD server definitions, including non-UTF-8 encodings such as `GBK`, `GB2312`, and `BIG5`
- Agent CLIs such as Codex, Claude Code, OpenClaw, and OpenCode
- Direct `tmux` workflows and a local browser UI on `127.0.0.1`

## Architecture

```text
tmux session
  -> MUD launcher scripts in ./scripts
  -> per-server config in ./config
  -> local control server in ./apps/server
  -> browser UI for pane output, manual commands, and interactive agent windows
```

The browser UI is additive. You can still inspect and control sessions directly
with `tmux capture-pane` and `tmux send-keys`.

## Requirements

- `tmux`
- `Node.js` 18+
- `npm`
- At least one supported agent CLI if you want agent control

Optional, depending on the server:

- `TinTin++` (`tt++`) for the bundled Aardwolf launcher
- `luit` for non-UTF-8 MUDs
- `telnet` for telnet-based MUDs

## Quick Start

### Linux

```bash
git clone https://github.com/zn0nz/mud_agent.git
cd mud_agent
./start.sh
```

### macOS

Install `tmux` first if needed:

```bash
brew install tmux
git clone https://github.com/zn0nz/mud_agent.git
cd mud_agent
./start.sh
```

### Windows

Set up WSL first, then launch through PowerShell:

```powershell
git clone https://github.com/zn0nz/mud_agent.git
cd mud_agent
.\start.ps1
```

See `SETUP_WINDOWS.md` for the full WSL setup flow.

`start.sh` will install dependencies when needed, create
`config/local.secrets.json` from the example template, ensure tmux session `0`
exists, start the local UI server, and open the browser automatically.
Edit `config/local.secrets.json` with your own credentials before using scripted
logins.

## Configuration

- `config/servers.json`: built-in server definitions
- `config/agents.json`: built-in agent definitions
- `config/local.secrets.json`: local-only credentials, based on `config/local.secrets.example.json`
- `config/local.servers.json`: optional local custom servers
- `walkthrough/`: agent-readable and agent-writable gameplay notes

Credentials are local machine state and should never be committed.

## Common Workflows

### Aardwolf

```bash
tmux new-window -t 0: -n aardwolf './scripts/aardwolf-tintin.sh'
tmux capture-pane -pt 0:aardwolf | tail -n 80
tmux send-keys -t 0:aardwolf 'look' Enter
```

### Non-UTF-8 MUDs

For `GBK`, `GB2312`, `BIG5`, or similar servers, wrap the client with `luit`
and use `./scripts/tmux-pane-send.sh` when raw `tmux send-keys` is unreliable.

```bash
tmux new-window -t 0: -n cjk_mud 'luit -encoding GBK telnet <host> <port>'
./scripts/tmux-pane-send.sh -t 0:cjk_mud -e GBK 'look'
tmux capture-pane -pt 0:cjk_mud | tail -n 80
```

See `SETUP.md` for encoding notes. Store gameplay notes and routes in
`walkthrough/`.

## Web Control Surface

Start the local server with:

```bash
npm run dev
```

It binds to `127.0.0.1` and provides:

- tmux pane inspection
- manual command sending
- interactive tmux-backed agent windows
- agent startup wiring based on `config/agents.json`

## Adding a Server

Add a server entry to `config/servers.json` or `config/local.servers.json` with:

- host and port
- encoding
- tmux session/window settings
- launcher command
- optional login command
- send mode (`tmux_keys` or `pane_tty`)

## Adding an Agent

Add an agent entry to `config/agents.json` with:

- CLI command and detection args
- non-interactive run args
- optional interactive tmux settings
- ready/submit patterns for TUI-backed agents

## Repo Notes

- This repo is intended to be published as source, not as an npm package.
- The root `package.json` stays `private` because the workspace is for local use.
- If you are publishing a cleaned copy, do not reuse git history that contains secrets.
- Agents should keep durable gameplay notes in `walkthrough/`, not in ad hoc root files.

## License

MIT. See `LICENSE`.
