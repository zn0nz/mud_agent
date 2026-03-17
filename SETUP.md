# Terminal MUD Client Setup

## Encoding Configuration (CJK / GBK / BIG5 MUDs)

When connecting to MUDs that use non-UTF-8 encodings (e.g., GBK, GB2312, BIG5),
the terminal will display garbled text because tmux defaults to UTF-8.

### Solution: Use `luit` to wrap the client

`luit` converts encoding between a child program and the terminal, solving
display issues at the source.

**Step 1:** Ensure `luit` is installed:

```bash
which luit || sudo apt install luit
```

**Step 2:** Start the client wrapped with luit in a new tmux window:

```bash
tmux new-window -t <session>: -n <window_name> 'luit -encoding GBK <client> <args...>'
```

Replace `GBK` with the target encoding:
- `GBK` — Simplified Chinese MUDs (most common)
- `GB2312` — Older Simplified Chinese MUDs
- `BIG5` — Traditional Chinese MUDs

For `telnet`, connect directly in the command line.
For `tt++`, connect from within the client with `#session {name} {host} {port}`.

### Why not convert after `tmux capture-pane`?

Using `tmux capture-pane | iconv -f GBK -t UTF-8` works for reading output,
but does NOT fix display in the tmux window itself. `luit` fixes encoding
at the terminal layer so everything displays correctly in real time.

If you are reading the pane through the local web UI, the browser now renders
standard ANSI color sequences directly. That fixes the old `^[31m`-style escape
garbage in `TMUX Output`, but it does not replace `luit`: you still need
`luit -encoding <encoding> ...` for the client itself.

### Quick Reference

| Task | Command |
|------|---------|
| Create luit+telnet window | `tmux new-window -t 0: -n cjk_mud 'luit -encoding GBK telnet <host> <port>'` |
| Create luit+tt++ window | `tmux new-window -t 0: -n cjk_mud 'luit -encoding GBK tt++'` |
| Send commands | `./scripts/tmux-pane-send.sh -t 0:cjk_mud -e GBK 'look'` |
| Read output | `tmux capture-pane -pt 0:cjk_mud \| tail -n 80` |

## Recommended Workflow

For non-UTF-8 servers, prefer `luit + telnet` over `luit + tt++` when input
through the terminal client becomes unreliable.

Observed behavior:

- `luit + tt++` may display correctly but can still mangle or truncate non-UTF-8 input on some servers.
- `luit + telnet` is usually the simpler and more predictable baseline.
- `./scripts/tmux-pane-send.sh` can bypass `tmux send-keys` and write encoded text directly to the pane TTY.

## Web UI Notes

The local server started with `npm run dev` includes a browser UI with:

- ANSI-colored tmux pane rendering for `TMUX Output`
- Interactive agent TUI windows backed by tmux
- An agent-first left panel where `Start Agent` starts or reuses the selected tmux target automatically; `Manual Login` remains available as a recovery control

Interactive coding agents are launched in dedicated tmux windows such as
`0:codex_tui` and `0:claude_tui`. The browser `Start Agent` action creates or
reuses the tmux window and applies the agent's configured startup mode. Codex
uses a runtime bootstrap file under `apps/server/.runtime/interactive-prompts/`
plus a short instruction to read it. OpenClaw uses the local Gateway-backed
`openclaw tui` flow and receives a shorter inline operating prompt. Both are
tmux-backed; the browser is not attaching to a raw PTY directly.

When agents discover useful routes or workflow details, record them in
`walkthrough/` so later runs can reuse them.

## TinTin++ Caveat

`luit + tt++` can still be useful for display-only testing on GBK/BIG5 MUDs,
but it is not the default recommendation when non-UTF-8 input is required.
