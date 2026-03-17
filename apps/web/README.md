# Web App Placeholder

The active local UI currently ships from `apps/server/public`, not from this
workspace.

Current browser features provided by the server-hosted UI:

- tmux-backed MUD session monitoring and command send
- ANSI-colored pane rendering for `TMUX Output`
- interactive tmux-backed coding agent windows, including agent-specific startup modes and browser key send

Current interactive agent notes:

- `Codex` uses a runtime bootstrap file plus a short instruction to read it.
- `OpenClaw` uses `openclaw tui` against the local Gateway and works better with a shorter inline operating prompt.
- The browser UI is agent-first: `Start Agent` now opens a launch-mode choice so the agent can either use the saved login profile or start without auto-login for new-user setup.

This `apps/web` package still exists as the reserved slot for a future
React/Vite frontend if the project later moves the browser UI out of the server
package.
