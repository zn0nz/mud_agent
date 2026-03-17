export const DEFAULT_BIND_HOST = "127.0.0.1";
export const DEFAULT_PORT = 4315;
export { AGENT_INTERFACE_DOC, AGENT_RUN_STATUSES } from "./agent-types.js";

export const SEND_MODES = {
  TMUX_KEYS: "tmux_keys",
  PANE_TTY: "pane_tty"
};

export const SUPPORTED_ENCODINGS = new Set([
  "UTF-8",
  "GBK",
  "GB2312",
  "BIG5"
]);

export function normalizeEncoding(value) {
  if (!value) {
    return "UTF-8";
  }

  const normalized = String(value).toUpperCase();
  return SUPPORTED_ENCODINGS.has(normalized) ? normalized : "UTF-8";
}

export function encodeTarget(target) {
  return encodeURIComponent(target);
}

export function decodeTarget(target) {
  return decodeURIComponent(target);
}
