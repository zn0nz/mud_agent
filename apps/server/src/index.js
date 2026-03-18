import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { EventEmitter } from "node:events";
import { WebSocketServer } from "ws";

import {
  AGENT_RUN_STATUSES,
  DEFAULT_BIND_HOST,
  DEFAULT_PORT,
  SEND_MODES,
  normalizeEncoding
} from "../../../packages/shared/src/index.js";

const execFileAsync = promisify(execFile);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "../../..");
const publicDir = path.join(repoRoot, "apps", "server", "public");
const xtermVendorAssets = new Map([
  ["/vendor/xterm/xterm.css", path.join(repoRoot, "node_modules", "@xterm", "xterm", "css", "xterm.css")],
  ["/vendor/xterm/xterm.js", path.join(repoRoot, "node_modules", "@xterm", "xterm", "lib", "xterm.js")],
  ["/vendor/xterm/addon-fit.js", path.join(repoRoot, "node_modules", "@xterm", "addon-fit", "lib", "addon-fit.js")]
]);
const runtimeDir = path.join(repoRoot, "apps", "server", ".runtime");
const interactivePromptDir = path.join(runtimeDir, "interactive-prompts");
const builtInServerConfigPath = path.join(repoRoot, "config", "servers.json");
const localServerConfigPath = path.join(repoRoot, "config", "local.servers.json");
const localSecretsPath = path.join(repoRoot, "config", "local.secrets.json");
const agentConfigPath = path.join(repoRoot, "config", "agents.json");
const workspaceGuidePath = path.join(repoRoot, "AGENTS.md");
const walkthroughDir = path.join(repoRoot, "walkthrough");
const userHomeDir = os.homedir();
const codexConfigPath = path.join(userHomeDir, ".codex", "config.toml");
const agentEventBus = new EventEmitter();
const agentRuns = new Map();
const interactiveAutoplayWorkers = new Map();
const interactiveAgentRuntimeProfiles = new Map();
const MAX_RETAINED_RUNS = 20;

let writeLock = Promise.resolve();
let nextStreamClientId = 1;
let nextAgentRunId = 1;

function clampNumber(value, min, max, fallback) {
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) {
    return fallback;
  }
  return Math.min(Math.max(numericValue, min), max);
}

function createError(message, code, statusCode = 500, details) {
  const error = new Error(message);
  error.code = code;
  error.statusCode = statusCode;
  error.details = details;
  return error;
}

function json(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(JSON.stringify(payload, null, 2));
}

function setCorsHeaders(request, response) {
  const allowedOrigin = process.env.CORS_ORIGIN;
  if (!allowedOrigin || !request.headers.origin) {
    return;
  }

  if (allowedOrigin === "*" || allowedOrigin === request.headers.origin) {
    response.setHeader("Access-Control-Allow-Origin", allowedOrigin === "*" ? "*" : request.headers.origin);
    response.setHeader("Access-Control-Allow-Headers", "Content-Type");
    response.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  }
}

function text(response, statusCode, payload, contentType = "text/plain; charset=utf-8") {
  response.writeHead(statusCode, {
    "Content-Type": contentType,
    "Cache-Control": "no-store"
  });
  response.end(payload);
}

function contentTypeForFilePath(filePath) {
  const ext = path.extname(filePath);
  if (ext === ".html") {
    return "text/html; charset=utf-8";
  }
  if (ext === ".js") {
    return "text/javascript; charset=utf-8";
  }
  if (ext === ".css") {
    return "text/css; charset=utf-8";
  }
  if (ext === ".map") {
    return "application/json; charset=utf-8";
  }
  return "application/octet-stream";
}

function isLocalHostHeader(hostHeader) {
  return !hostHeader || hostHeader.startsWith("127.0.0.1") || hostHeader.startsWith("localhost");
}

function isMissingTmuxTargetError(error) {
  return error.message.includes("can't find pane") || error.message.includes("can't find window");
}

function isTmuxUnavailableError(error) {
  return (
    error.message.includes("no server running") ||
    error.message.includes("can't find session") ||
    error.message.includes("error connecting to")
  );
}

function sendSse(response, event, payload) {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function withWriteLock(fn) {
  const previous = writeLock;
  let release;
  writeLock = new Promise((resolve) => {
    release = resolve;
  });
  await previous;
  try {
    return await fn();
  } finally {
    release();
  }
}

async function readJsonBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(raw);
  } catch {
    throw createError("Invalid JSON body", "INVALID_JSON", 400);
  }
}

async function readJsonFile(filePath, fallbackValue) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch (error) {
    if (error.code === "ENOENT") {
      return fallbackValue;
    }
    throw error;
  }
}

async function readOptionalTextFile(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function readOptionalDirEntries(dirPath) {
  try {
    return await fs.readdir(dirPath, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function loadLocalSecrets() {
  return readJsonFile(localSecretsPath, {});
}

async function saveLocalSecrets(secrets) {
  const payload = JSON.stringify(secrets, null, 2);
  await fs.writeFile(localSecretsPath, `${payload}\n`, "utf8");
}

function sanitizeProfileId(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "profile";
}

function normalizeLoginProfile(entry, fallbackId) {
  const profile = entry && typeof entry === "object" ? entry : {};
  const id = sanitizeProfileId(profile.id || fallbackId);
  const label = String(profile.label || profile.name || id || "Profile").trim() || id;
  return {
    id,
    label,
    username: String(profile.username || "").trim(),
    password: String(profile.password || ""),
    confirmExistingLogin: String(
      profile.confirmExistingLogin ?? profile.confirm_existing_login ?? ""
    ).trim()
  };
}

function normalizeLoginProfilesForServer(serverId, secrets) {
  const serverSecrets = secrets?.[serverId];
  if (!serverSecrets || typeof serverSecrets !== "object") {
    return {
      defaultProfileId: "",
      profiles: []
    };
  }

  const normalizedProfiles = [];
  const seenIds = new Set();
  const rawProfiles = serverSecrets.profiles;
  const appendProfile = (rawEntry, fallbackId) => {
    const profile = normalizeLoginProfile(rawEntry, fallbackId);
    if (!profile.username && !profile.password && !profile.confirmExistingLogin) {
      return;
    }

    let candidateId = profile.id;
    let suffix = 2;
    while (seenIds.has(candidateId)) {
      candidateId = `${profile.id}-${suffix++}`;
    }
    seenIds.add(candidateId);
    normalizedProfiles.push({
      ...profile,
      id: candidateId
    });
  };

  if (Array.isArray(rawProfiles)) {
    rawProfiles.forEach((profile, index) => {
      appendProfile(profile, profile?.id || profile?.label || `profile-${index + 1}`);
    });
  } else if (rawProfiles && typeof rawProfiles === "object") {
    for (const [profileId, profile] of Object.entries(rawProfiles)) {
      appendProfile(profile, profileId);
    }
  }

  if (
    normalizedProfiles.length === 0 &&
    (serverSecrets.username || serverSecrets.password || serverSecrets.confirm_existing_login)
  ) {
    appendProfile(
      {
        id: "default",
        label: serverSecrets.profileLabel || "Default",
        username: serverSecrets.username,
        password: serverSecrets.password,
        confirmExistingLogin: serverSecrets.confirm_existing_login
      },
      "default"
    );
  }

  let defaultProfileId = sanitizeProfileId(serverSecrets.defaultProfileId || "");
  if (!normalizedProfiles.some((profile) => profile.id === defaultProfileId)) {
    defaultProfileId = normalizedProfiles[0]?.id || "";
  }

  return {
    defaultProfileId,
    profiles: normalizedProfiles.map((profile) => ({
      ...profile,
      isDefault: profile.id === defaultProfileId
    }))
  };
}

function serializeLoginProfilesForServer(existingServerSecrets, { defaultProfileId, profiles }) {
  const preserved = { ...(existingServerSecrets || {}) };
  delete preserved.username;
  delete preserved.password;
  delete preserved.confirm_existing_login;
  delete preserved.profileLabel;
  delete preserved.defaultProfileId;
  delete preserved.profiles;

  const normalizedProfiles = [];
  const seenIds = new Set();
  for (const [index, entry] of (profiles || []).entries()) {
    const profile = normalizeLoginProfile(entry, entry?.id || `profile-${index + 1}`);
    if (!profile.label || !profile.username || !profile.password) {
      continue;
    }

    let candidateId = profile.id;
    let suffix = 2;
    while (seenIds.has(candidateId)) {
      candidateId = `${profile.id}-${suffix++}`;
    }
    seenIds.add(candidateId);
    normalizedProfiles.push({
      ...profile,
      id: candidateId
    });
  }

  const resolvedDefaultProfileId = normalizedProfiles.some((profile) => profile.id === defaultProfileId)
    ? defaultProfileId
    : normalizedProfiles[0]?.id || "";

  const storedProfiles = {};
  for (const profile of normalizedProfiles) {
    storedProfiles[profile.id] = {
      label: profile.label,
      username: profile.username,
      password: profile.password
    };
    if (profile.confirmExistingLogin) {
      storedProfiles[profile.id].confirm_existing_login = profile.confirmExistingLogin;
    }
  }

  return {
    ...preserved,
    defaultProfileId: resolvedDefaultProfileId,
    profiles: storedProfiles
  };
}

function getAgentCommandName(agentDefinition) {
  const command = resolveExecutable(agentDefinition?.interactiveCommand || agentDefinition?.command || "");
  return path.basename(command || "");
}

function parseTomlScalar(rawValue) {
  const value = String(rawValue || "").trim();
  if (!value) {
    return "";
  }
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replace(/\\"/g, '"');
  }
  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}

function stripTomlInlineComment(line) {
  let quoted = false;
  let quoteChar = "";
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    const previous = index > 0 ? line[index - 1] : "";
    if ((char === '"' || char === "'") && previous !== "\\") {
      if (!quoted) {
        quoted = true;
        quoteChar = char;
      } else if (quoteChar === char) {
        quoted = false;
        quoteChar = "";
      }
      continue;
    }
    if (char === "#" && !quoted) {
      return line.slice(0, index).trimEnd();
    }
  }
  return line.trimEnd();
}

function parseCodexConfigProfiles(rawConfig) {
  const lines = String(rawConfig || "").split(/\r?\n/);
  const topLevel = {};
  const profiles = [];
  let currentProfile = null;
  let currentSection = "";

  const flushCurrentProfile = () => {
    if (!currentProfile) {
      return;
    }
    profiles.push(currentProfile);
    currentProfile = null;
  };

  for (const rawLine of lines) {
    const line = stripTomlInlineComment(rawLine).trim();
    if (!line) {
      continue;
    }
    const sectionMatch = line.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      flushCurrentProfile();
      currentSection = sectionMatch[1].trim();
      const profileMatch = currentSection.match(/^profiles\.(?:"([^"]+)"|([^\]]+))$/);
      if (profileMatch) {
        const profileId = String(profileMatch[1] || profileMatch[2] || "").trim();
        currentProfile = {
          id: profileId,
          label: profileId,
          model: "",
          modelProvider: "",
          modelReasoningEffort: ""
        };
      }
      continue;
    }

    const valueMatch = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/);
    if (!valueMatch) {
      continue;
    }

    const key = valueMatch[1];
    const value = parseTomlScalar(valueMatch[2]);
    if (!currentSection) {
      topLevel[key] = value;
      continue;
    }
    if (currentProfile) {
      if (key === "model") {
        currentProfile.model = value;
      } else if (key === "model_provider") {
        currentProfile.modelProvider = value;
      } else if (key === "model_reasoning_effort") {
        currentProfile.modelReasoningEffort = value;
      }
    }
  }

  flushCurrentProfile();
  return {
    topLevel,
    profiles
  };
}

async function loadCodexRuntimeProfiles() {
  const rawConfig = await readOptionalTextFile(codexConfigPath);
  const parsed = parseCodexConfigProfiles(rawConfig);
  const defaultDescription = [
    parsed.topLevel.model ? `model ${parsed.topLevel.model}` : "",
    parsed.topLevel.model_reasoning_effort ? `reasoning ${parsed.topLevel.model_reasoning_effort}` : "",
    "uses base ~/.codex/config.toml settings"
  ].filter(Boolean).join(" / ");
  const profiles = [
    {
      id: "default",
      label: "default",
      description: defaultDescription || "Uses base ~/.codex/config.toml settings.",
      source: codexConfigPath,
      isDefault: true
    }
  ];

  for (const profile of parsed.profiles) {
    if (!profile.id || profile.id === "default") {
      continue;
    }
    profiles.push({
      id: profile.id,
      label: profile.label,
      description: [
        profile.modelProvider ? `provider ${profile.modelProvider}` : "",
        profile.model ? `model ${profile.model}` : "",
        profile.modelReasoningEffort ? `reasoning ${profile.modelReasoningEffort}` : ""
      ].filter(Boolean).join(" / "),
      source: codexConfigPath,
      isDefault: false
    });
  }

  return {
    defaultProfileId: "default",
    profileFlag: "--profile",
    profiles
  };
}

async function loadOpenClawRuntimeProfiles() {
  const openClawRoot = path.join(userHomeDir, ".openclaw");
  const agentRoot = path.join(openClawRoot, "agents");
  let entries = [];
  try {
    entries = await fs.readdir(agentRoot, {
      withFileTypes: true
    });
  } catch {
    entries = [];
  }

  const profiles = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const agentId = entry.name.trim();
    if (!agentId) {
      continue;
    }
    const agentDir = path.join(agentRoot, agentId, "agent");
    let stats = null;
    try {
      stats = await fs.stat(agentDir);
    } catch {
      stats = null;
    }
    if (!stats?.isDirectory()) {
      continue;
    }
    profiles.push({
      id: agentId,
      label: agentId,
      description: `${agentId === "main" ? "Default OpenClaw agent" : "OpenClaw agent"} / ${agentDir}`,
      source: agentDir,
      isDefault: agentId === "main"
    });
  }

  if (profiles.length === 0) {
    profiles.push({
      id: "main",
      label: "main",
      description: `Default OpenClaw agent / ${path.join(agentRoot, "main", "agent")}`,
      source: path.join(agentRoot, "main", "agent"),
      isDefault: true
    });
  }

  profiles.sort((left, right) => {
    if (left.isDefault) {
      return -1;
    }
    if (right.isDefault) {
      return 1;
    }
    return left.label.localeCompare(right.label);
  });

  const defaultProfileId = profiles.find((profile) => profile.isDefault)?.id || profiles[0]?.id || "main";
  return {
    defaultProfileId,
    profileFlag: "",
    profiles
  };
}

async function loadAgentRuntimeProfiles(agentDefinition) {
  const commandName = getAgentCommandName(agentDefinition);
  if (commandName === "codex") {
    return loadCodexRuntimeProfiles();
  }
  if (commandName === "openclaw") {
    return loadOpenClawRuntimeProfiles();
  }
  return {
    defaultProfileId: "default",
    profileFlag: "",
    profiles: [
      {
        id: "default",
        label: "default",
        description: `Uses the configured ${agentDefinition.name} defaults.`,
        source: "",
        isDefault: true
      }
    ]
  };
}

async function loadAgentRuntimeProfileById(agentDefinition, profileId) {
  const state = await loadAgentRuntimeProfiles(agentDefinition);
  const resolvedProfileId = String(profileId || state.defaultProfileId || "default").trim() || "default";
  const profile = state.profiles.find((entry) => entry.id === resolvedProfileId) || state.profiles[0];
  return {
    ...state,
    selectedProfile: profile || {
      id: "default",
      label: "default",
      description: "",
      source: "",
      isDefault: true
    }
  };
}

function stripCliOptions(args, optionNames) {
  const names = new Set(optionNames.filter(Boolean));
  const stripped = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = String(args[index]);
    if (names.has(value)) {
      index += 1;
      continue;
    }
    const matchedName = [...names].find((name) => value.startsWith(`${name}=`));
    if (matchedName) {
      continue;
    }
    stripped.push(value);
  }
  return stripped;
}

function normalizeOpenClawAgentId(value) {
  return String(value || "").trim() || "main";
}

function normalizeOpenClawSessionKeyForAgent(rawSessionKey, agentId) {
  const resolvedAgentId = normalizeOpenClawAgentId(agentId);
  const normalizedSessionKey = String(rawSessionKey || "").trim();
  if (!normalizedSessionKey) {
    return `agent:${resolvedAgentId}:main`;
  }
  if (normalizedSessionKey === "global" || normalizedSessionKey === "unknown") {
    return normalizedSessionKey;
  }
  if (normalizedSessionKey.startsWith("agent:")) {
    const [, , ...suffixParts] = normalizedSessionKey.split(":");
    const suffix = suffixParts.join(":").trim() || "main";
    return `agent:${resolvedAgentId}:${suffix}`;
  }
  return `agent:${resolvedAgentId}:${normalizedSessionKey}`;
}

function applyOpenClawAgentToArgs(args, selectedProfile, options = {}) {
  const baseArgs = Array.isArray(args) ? args.map((value) => String(value)) : [];
  const selectedAgentId = normalizeOpenClawAgentId(selectedProfile?.id);
  if (baseArgs.length === 0) {
    return baseArgs;
  }

  const subcommand = baseArgs[0];
  if (options.interactive || subcommand === "tui") {
    const rawSessionKey = readCliOption(baseArgs, "--session").trim() || "main";
    const normalizedArgs = stripCliOptions(baseArgs, ["--session"]);
    if (normalizedArgs[0] !== "tui") {
      return normalizedArgs;
    }
    return [
      "tui",
      "--session",
      normalizeOpenClawSessionKeyForAgent(rawSessionKey, selectedAgentId),
      ...normalizedArgs.slice(1)
    ];
  }

  if (subcommand === "agent") {
    const normalizedArgs = stripCliOptions(baseArgs, ["--agent"]);
    return [
      "agent",
      "--agent",
      selectedAgentId,
      ...normalizedArgs.slice(1)
    ];
  }

  if (subcommand === "sessions") {
    const normalizedArgs = stripCliOptions(baseArgs, ["--agent"]);
    return [
      "sessions",
      "--agent",
      selectedAgentId,
      ...normalizedArgs.slice(1)
    ];
  }

  return baseArgs;
}

function applyAgentRuntimeProfileToArgs(agentDefinition, args, runtimeProfiles, selectedProfile, options = {}) {
  const baseArgs = Array.isArray(args) ? args.map((value) => String(value)) : [];
  const commandName = getAgentCommandName(agentDefinition);
  if (commandName === "openclaw") {
    return applyOpenClawAgentToArgs(baseArgs, selectedProfile, options);
  }

  const profileFlag = String(runtimeProfiles?.profileFlag || "").trim();
  if (!profileFlag) {
    return baseArgs;
  }

  const normalizedArgs = stripCliOptions(baseArgs, [profileFlag, profileFlag === "--profile" ? "-p" : ""]);
  if (!selectedProfile || selectedProfile.id === "default") {
    return normalizedArgs;
  }

  return [profileFlag, selectedProfile.id, ...normalizedArgs];
}

async function loadResolvedAgentArgs(agentDefinition, options = {}) {
  const interactive = Boolean(options.interactive);
  const requestedProfileId = String(
    options.profileId || interactiveAgentRuntimeProfiles.get(agentDefinition?.id) || ""
  ).trim();
  const runtimeProfiles = await loadAgentRuntimeProfileById(
    agentDefinition,
    requestedProfileId || undefined
  );
  const configuredArgs = interactive
    ? getInteractiveAgentArgs(agentDefinition)
    : Array.isArray(agentDefinition?.args)
      ? agentDefinition.args.map((value) => String(value))
      : [];
  return {
    runtimeProfiles,
    selectedProfile: runtimeProfiles.selectedProfile,
    args: applyAgentRuntimeProfileToArgs(
      agentDefinition,
      configuredArgs,
      runtimeProfiles,
      runtimeProfiles.selectedProfile,
      { interactive }
    )
  };
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function loadBuiltInServers() {
  const parsed = await readJsonFile(builtInServerConfigPath, { servers: [] });
  return (parsed.servers ?? []).map((server) => ({
    ...server,
    isBuiltIn: true
  }));
}

async function loadLocalServerState() {
  const parsed = await readJsonFile(localServerConfigPath, { servers: [], removedBuiltInServerIds: [] });
  return {
    servers: Array.isArray(parsed.servers) ? parsed.servers : [],
    removedBuiltInServerIds: Array.isArray(parsed.removedBuiltInServerIds)
      ? [...new Set(parsed.removedBuiltInServerIds.map((value) => String(value).trim()).filter(Boolean))]
      : []
  };
}

async function loadCustomServers() {
  const parsed = await loadLocalServerState();
  return parsed.servers.map((server) => ({
    ...server,
    isBuiltIn: false
  }));
}

async function saveLocalServerState({ servers, removedBuiltInServerIds = [] }) {
  const payload = JSON.stringify(
    {
      servers: servers.map(({ isBuiltIn, ...server }) => server),
      removedBuiltInServerIds: [...new Set(removedBuiltInServerIds.map((value) => String(value).trim()).filter(Boolean))]
    },
    null,
    2
  );
  await fs.writeFile(localServerConfigPath, `${payload}\n`, "utf8");
}

async function saveCustomServers(servers, options = {}) {
  const state = await loadLocalServerState();
  await saveLocalServerState({
    servers,
    removedBuiltInServerIds: options.removedBuiltInServerIds ?? state.removedBuiltInServerIds
  });
}

async function loadServers() {
  const [builtInServers, localState] = await Promise.all([
    loadBuiltInServers(),
    loadLocalServerState()
  ]);
  const customServers = localState.servers.map((server) => ({
    ...server,
    isBuiltIn: false
  }));
  const removedBuiltInServerIds = new Set(localState.removedBuiltInServerIds);
  const customOverridesById = new Map(customServers.map((server) => [server.id, server]));
  const builtInIds = new Set(builtInServers.map((server) => server.id));

  const mergedBuiltIns = builtInServers
    .filter((server) => !removedBuiltInServerIds.has(server.id))
    .map((server) => ({
      ...server,
      ...(customOverridesById.get(server.id) || {}),
      isBuiltIn: true
    }));

  const customOnlyServers = customServers.filter(
    (server) => !builtInIds.has(server.id) || removedBuiltInServerIds.has(server.id)
  );
  return [...mergedBuiltIns, ...customOnlyServers];
}

async function loadAgentDefinitions() {
  const parsed = await readJsonFile(agentConfigPath, { agents: [] });
  return (parsed.agents ?? []).map((agent) => ({
    ...agent,
    isBuiltIn: agent.isBuiltIn !== false
  }));
}

async function loadAgentDefinitionById(agentId) {
  const definitions = await loadAgentDefinitions();
  const definition = definitions.find((entry) => entry.id === agentId);
  if (!definition) {
    throw createError(`Unknown agent id: ${agentId}`, "AGENT_NOT_FOUND", 404, {
      agentId
    });
  }
  return definition;
}

function summarizeRun(run) {
  return {
    id: run.id,
    agentId: run.agentId,
    agentName: run.agentName,
    target: run.target,
    serverId: run.serverId,
    status: run.status,
    pid: run.pid,
    startedAt: run.startedAt,
    stoppedAt: run.stoppedAt,
    exitCode: run.exitCode,
    command: run.command,
    args: run.args
  };
}

function emitAgentEvent(runId, event, payload) {
  agentEventBus.emit("event", {
    runId,
    event,
    payload
  });
}

function formatAgentDisplayText(run, textChunk) {
  if (!textChunk) {
    return "";
  }

  run.output = `${run.output}${textChunk}`.slice(-50000);
  return textChunk;
}

function emitAgentOutput(run, stream, textChunk) {
  const displayText = formatAgentDisplayText(run, textChunk);
  if (!displayText) {
    return;
  }

  emitAgentEvent(run.id, "agent-output", {
    runId: run.id,
    stream,
    text: displayText
  });
}

function formatPromptTranscript(prompt) {
  const normalizedPrompt = String(prompt || "").trim();
  if (!normalizedPrompt) {
    return "";
  }

  const quotedPrompt = normalizedPrompt
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");

  return `${quotedPrompt}\n\n`;
}

function summarizeCommand(command) {
  return String(command || "").trim() || "(unknown command)";
}

function formatCodexJsonEvent(run, event) {
  if (!event || typeof event !== "object") {
    return "";
  }

  if (event.type === "item.started" && event.item?.type === "command_execution") {
    return `$ ${summarizeCommand(event.item.command)}\n`;
  }

  if (event.type === "item.completed" && event.item?.type === "command_execution") {
    if (event.item.status === "completed" && Number(event.item.exit_code) !== 0) {
      return `Command exited with code ${event.item.exit_code}.\n`;
    }
    return "";
  }

  if (event.type === "item.completed" && event.item?.type === "agent_message") {
    const text = String(event.item.text || "").trimEnd();
    return text ? `${text}\n\n` : "";
  }

  if (event.type === "error") {
    return event.message ? `Error: ${event.message}\n` : "";
  }

  return "";
}

function isIgnorableCodexText(text) {
  return String(text || "").trim() === "Reading prompt from stdin...";
}

function handleCodexJsonStdout(run, chunk) {
  run.stdoutBuffer = `${run.stdoutBuffer || ""}${chunk.toString("utf8")}`;
  const lines = run.stdoutBuffer.split("\n");
  run.stdoutBuffer = lines.pop() || "";

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || isIgnorableCodexText(trimmed)) {
      continue;
    }

    try {
      const parsed = JSON.parse(trimmed);
      emitAgentOutput(run, "stdout", formatCodexJsonEvent(run, parsed));
    } catch {
      emitAgentOutput(run, "stdout", `${line}\n`);
    }
  }
}

function flushAgentStdoutBuffer(run) {
  const remainder = String(run.stdoutBuffer || "").trim();
  run.stdoutBuffer = "";
  if (!remainder || isIgnorableCodexText(remainder)) {
    return;
  }

  try {
    const parsed = JSON.parse(remainder);
    emitAgentOutput(run, "stdout", formatCodexJsonEvent(run, parsed));
  } catch {
    emitAgentOutput(run, "stdout", `${remainder}\n`);
  }
}

function pruneAgentRuns() {
  if (agentRuns.size <= MAX_RETAINED_RUNS) {
    return;
  }

  for (const [runId, run] of agentRuns.entries()) {
    if (agentRuns.size <= MAX_RETAINED_RUNS) {
      break;
    }

    if (run.status === AGENT_RUN_STATUSES.STOPPED || run.status === AGENT_RUN_STATUSES.ERROR) {
      agentRuns.delete(runId);
    }
  }
}

async function run(command, args, options = {}) {
  try {
    return await execFileAsync(command, args, {
      cwd: repoRoot,
      maxBuffer: 1024 * 1024,
      ...options
    });
  } catch (error) {
    const stderr = error.stderr ? String(error.stderr).trim() : "";
    const stdout = error.stdout ? String(error.stdout).trim() : "";
    const detail = stderr || stdout || error.message;
    error.message = `${command} ${args.join(" ")} failed: ${detail}`;
    throw error;
  }
}

async function runTmux(args, options) {
  return run("tmux", args, options);
}

async function ensureTmuxSession(sessionName) {
  try {
    await runTmux(["has-session", "-t", sessionName]);
  } catch {
    await runTmux(["new-session", "-d", "-s", sessionName, "-n", "shell", "bash"]);
  }
}

async function listTmuxSessions() {
  let stdout = "";
  try {
    ({ stdout } = await runTmux([
      "list-sessions",
      "-F",
      "#{session_name}\t#{session_windows}\t#{session_created_string}"
    ]));
  } catch (error) {
    if (isTmuxUnavailableError(error)) {
      return [];
    }
    throw error;
  }

  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, windows, created] = line.split("\t");
      return {
        name,
        windows: Number(windows),
        created
      };
    });
}

async function listTmuxWindows(sessionName = "0") {
  let stdout = "";
  try {
    ({ stdout } = await runTmux([
      "list-windows",
      "-t",
      sessionName,
      "-F",
      "#{session_name}:#{window_name}\t#{window_index}\t#{window_name}\t#{window_active}\t#{window_panes}"
    ]));
  } catch (error) {
    if (isTmuxUnavailableError(error)) {
      return [];
    }
    throw error;
  }

  return stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [target, index, windowName, active, panes] = line.split("\t");
      return {
        target,
        index: Number(index),
        windowName,
        active: active === "1",
        panes: Number(panes)
      };
    });
}

async function capturePane(target, lines = 200, options = {}) {
  const args = [
    "capture-pane",
    "-p",
    "-t",
    target,
    "-S",
    `-${lines}`
  ];

  if (options.includeAnsi) {
    args.splice(2, 0, "-e");
  }

  try {
    const { stdout } = await runTmux(args);
    return stdout;
  } catch (error) {
    if (isMissingTmuxTargetError(error)) {
      throw createError(`Unknown tmux target: ${target}`, "INVALID_TARGET", 404, {
        target
      });
    }
    throw error;
  }
}

async function sendViaTmuxKeys(target, textToSend) {
  try {
    await runTmux(["send-keys", "-t", target, textToSend, "Enter"]);
  } catch (error) {
    if (isMissingTmuxTargetError(error)) {
      throw createError(`Unknown tmux target: ${target}`, "INVALID_TARGET", 404, {
        target
      });
    }
    throw error;
  }
}

async function sendRawKeysViaTmux(target, keys) {
  try {
    await runTmux(["send-keys", "-t", target, ...keys]);
  } catch (error) {
    if (isMissingTmuxTargetError(error)) {
      throw createError(`Unknown tmux target: ${target}`, "INVALID_TARGET", 404, {
        target
      });
    }
    throw error;
  }
}

async function sendLiteralViaTmux(target, textToSend) {
  try {
    await runTmux(["send-keys", "-t", target, "-l", textToSend]);
  } catch (error) {
    if (isMissingTmuxTargetError(error)) {
      throw createError(`Unknown tmux target: ${target}`, "INVALID_TARGET", 404, {
        target
      });
    }
    throw error;
  }
}

async function sendLiteralInChunksViaTmux(target, textToSend, chunkSize = 200) {
  const text = String(textToSend || "");
  for (let index = 0; index < text.length; index += chunkSize) {
    const chunk = text.slice(index, index + chunkSize);
    if (!chunk) {
      continue;
    }
    await sendLiteralViaTmux(target, chunk);
    if (index + chunkSize < text.length) {
      await sleep(30);
    }
  }
}

async function killTmuxWindow(target) {
  try {
    await runTmux(["kill-window", "-t", target]);
  } catch (error) {
    if (isMissingTmuxTargetError(error)) {
      throw createError(`Unknown tmux target: ${target}`, "INVALID_TARGET", 404, {
        target
      });
    }
    throw error;
  }
}

async function sendViaPaneTty(target, textToSend, encoding, options = {}) {
  const scriptPath = path.join(repoRoot, "scripts", "tmux-pane-send.sh");
  const args = ["-t", target, "-e", encoding];
  if (options.appendEnter === false) {
    args.push("-n");
  }
  args.push(textToSend);
  try {
    await run(scriptPath, args);
  } catch (error) {
    if (isMissingTmuxTargetError(error)) {
      throw createError(`Unknown tmux target: ${target}`, "INVALID_TARGET", 404, {
        target
      });
    }
    throw error;
  }
}

function parseTerminalInput(data) {
  const text = String(data || "");
  const actions = [];
  let buffer = "";

  const flushBuffer = () => {
    if (!buffer) {
      return;
    }
    actions.push({
      type: "text",
      text: buffer
    });
    buffer = "";
  };

  const controlKeyMap = new Map([
    ["\r\n", "Enter"],
    ["\r", "Enter"],
    ["\n", "Enter"],
    ["\t", "Tab"],
    ["\u007f", "BSpace"],
    ["\x1b[A", "Up"],
    ["\x1b[B", "Down"],
    ["\x1b[C", "Right"],
    ["\x1b[D", "Left"],
    ["\x1b[H", "Home"],
    ["\x1b[F", "End"],
    ["\x1b[5~", "PageUp"],
    ["\x1b[6~", "PageDown"],
    ["\x1b", "Escape"]
  ]);

  for (let index = 0; index < text.length; ) {
    let matchedKey = null;
    let matchedSequence = "";

    for (const [sequence, key] of controlKeyMap.entries()) {
      if (text.startsWith(sequence, index)) {
        matchedKey = key;
        matchedSequence = sequence;
        break;
      }
    }

    if (matchedKey) {
      flushBuffer();
      actions.push({
        type: "keys",
        keys: [matchedKey]
      });
      index += matchedSequence.length;
      continue;
    }

    const codePoint = text.charCodeAt(index);
    if (codePoint >= 1 && codePoint <= 26) {
      flushBuffer();
      actions.push({
        type: "keys",
        keys: [`C-${String.fromCharCode(codePoint + 96)}`]
      });
      index += 1;
      continue;
    }

    buffer += text[index];
    index += 1;
  }

  flushBuffer();
  return actions;
}

function containsNonAsciiText(value) {
  return /[^\x20-\x7e]/.test(String(value || ""));
}

async function resizeTmuxPane(target, cols, rows) {
  try {
    await runTmux([
      "resize-pane",
      "-t",
      target,
      "-x",
      String(clampNumber(cols, 20, 500, 80)),
      "-y",
      String(clampNumber(rows, 5, 200, 24))
    ]);
  } catch (error) {
    if (isMissingTmuxTargetError(error)) {
      throw createError(`Unknown tmux target: ${target}`, "INVALID_TARGET", 404, {
        target
      });
    }
    throw error;
  }
}

async function sendTerminalData(target, session, data) {
  const actions = parseTerminalInput(data);
  if (actions.length === 0) {
    return {
      ok: true,
      target,
      encoding: session.encoding,
      sendMode: session.sendMode
    };
  }

  const encoding = normalizeEncoding(session.encoding || "UTF-8");
  let usedPaneTty = false;
  let usedTmuxKeys = false;

  for (const action of actions) {
    if (action.type === "keys") {
      await sendRawKeysViaTmux(target, action.keys);
      usedTmuxKeys = true;
      continue;
    }

    const text = String(action.text || "");
    if (!text) {
      continue;
    }

    if (encoding !== "UTF-8" && containsNonAsciiText(text)) {
      await sendViaPaneTty(target, text, encoding, {
        appendEnter: false
      });
      usedPaneTty = true;
      continue;
    }

    await sendLiteralInChunksViaTmux(target, text);
    usedTmuxKeys = true;
  }

  return {
    ok: true,
    target,
    encoding,
    sendMode: usedPaneTty && !usedTmuxKeys ? SEND_MODES.PANE_TTY : SEND_MODES.TMUX_KEYS,
    raw: true
  };
}

function resolveScript(commandPath) {
  if (!commandPath) {
    return null;
  }

  if (path.isAbsolute(commandPath)) {
    return commandPath;
  }

  return path.resolve(repoRoot, commandPath);
}

function resolveExecutable(commandPath) {
  if (!commandPath) {
    return null;
  }

  if (path.isAbsolute(commandPath)) {
    return commandPath;
  }

  if (commandPath.includes("/") || commandPath.startsWith(".")) {
    return path.resolve(repoRoot, commandPath);
  }

  return commandPath;
}

function shellEscape(value) {
  return `'${String(value).replaceAll("'", `'\"'\"'`)}'`;
}

function normalizeInteractivePrompt(prompt) {
  return String(prompt || "").replace(/\r\n/g, "\n").replace(/\r/g, "\n").trim();
}

function normalizeInteractivePromptInstruction(prompt) {
  return String(prompt || "")
    .replace(/\r/g, "\n")
    .replace(/\n+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sanitizeFileSegment(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "session";
}

async function writeInteractivePromptFile(agentDefinition, target, prompt) {
  const normalizedPrompt = normalizeInteractivePrompt(prompt);
  if (!normalizedPrompt) {
    return null;
  }

  await fs.mkdir(interactivePromptDir, { recursive: true });
  const targetSlug = sanitizeFileSegment(target.replaceAll(":", "-"));
  const fileName = `${sanitizeFileSegment(agentDefinition.id)}-${targetSlug}.md`;
  const filePath = path.join(interactivePromptDir, fileName);
  const fileContents = [
    `# Interactive Agent Bootstrap`,
    ``,
    `Treat this file as an active operating brief, not a one-shot question.`,
    `After reading it, immediately begin working and continue taking safe low-risk actions until you hit a real blocker or need user approval for a risky choice.`,
    `Do not stop after the first summary or wait for another prompt between routine steps.`,
    ``,
    `- Agent: ${agentDefinition.name} (${agentDefinition.id})`,
    `- Target: ${target}`,
    `- Generated: ${new Date().toISOString()}`,
    ``,
    `---`,
    ``,
    normalizedPrompt,
    ``
  ].join("\n");

  await fs.writeFile(filePath, fileContents, "utf8");
  return filePath;
}

function buildInteractivePromptInstruction(filePath) {
  return normalizeInteractivePromptInstruction(
    `Read ${filePath}, treat it as your standing operating brief, and begin executing it immediately. Continue operating autonomously until you reach a real blocker or need approval for a risky action.`
  );
}

function getInteractiveStartupMode(agentDefinition) {
  const mode = String(agentDefinition?.interactiveStartupMode || "bootstrap_file").trim();
  return mode === "inline_prompt" ? "inline_prompt" : "bootstrap_file";
}

function resolveWorkingDirectory(workingDirectory) {
  if (!workingDirectory) {
    return repoRoot;
  }

  if (path.isAbsolute(workingDirectory)) {
    return workingDirectory;
  }

  return path.resolve(repoRoot, workingDirectory);
}

function getWindowNames(server) {
  const names = new Set([server.windowName, ...(server.windowNames || [])].filter(Boolean));
  return [...names];
}

function supportsInteractiveTmux(agentDefinition) {
  return Boolean(agentDefinition?.interactiveTmux);
}

function getInteractiveWindowNames(agentDefinition) {
  const names = new Set([
    agentDefinition?.interactiveWindowName,
    ...(agentDefinition?.interactiveWindowNames || [])
  ].filter(Boolean));
  return [...names];
}

function getInteractiveAgentArgs(agentDefinition) {
  if (Array.isArray(agentDefinition?.interactiveArgs)) {
    return agentDefinition.interactiveArgs.map((value) => String(value));
  }
  if (Array.isArray(agentDefinition?.args)) {
    return agentDefinition.args.map((value) => String(value));
  }
  return [];
}

function readCliOption(args, optionName) {
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (value === optionName) {
      return index + 1 < args.length ? String(args[index + 1] || "") : "";
    }
    if (value.startsWith(`${optionName}=`)) {
      return value.slice(optionName.length + 1);
    }
  }
  return "";
}

function isOpenClawInteractiveAgent(agentDefinition) {
  const command = path.basename(
    resolveExecutable(agentDefinition?.interactiveCommand || agentDefinition?.command) || ""
  );
  return command === "openclaw";
}

async function listOpenClawSessions() {
  const command = resolveExecutable("openclaw");
  const { stdout } = await run(command, ["sessions", "--json"]);

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch (error) {
    throw createError(
      `Unable to parse OpenClaw sessions output: ${error.message}`,
      "OPENCLAW_SESSIONS_PARSE_FAILED",
      500
    );
  }

  return Array.isArray(parsed?.sessions) ? parsed.sessions : [];
}

async function resolveOpenClawInteractiveSessionKey(agentDefinition) {
  const { args } = await loadResolvedAgentArgs(agentDefinition, {
    interactive: true
  });
  const rawSessionKey = readCliOption(args, "--session").trim().toLowerCase();
  if (!rawSessionKey) {
    return "";
  }
  if (
    rawSessionKey === "global" ||
    rawSessionKey === "unknown" ||
    rawSessionKey.startsWith("agent:")
  ) {
    return rawSessionKey;
  }

  const matches = (await listOpenClawSessions())
    .filter((session) => typeof session?.key === "string")
    .filter((session) => String(session.key).toLowerCase().endsWith(`:${rawSessionKey}`))
    .sort((left, right) => Number(right?.updatedAt || 0) - Number(left?.updatedAt || 0));

  if (matches.length > 0) {
    return String(matches[0].key);
  }

  return `agent:main:${rawSessionKey}`;
}

async function abortOpenClawInteractiveSession(agentDefinition) {
  const sessionKey = await resolveOpenClawInteractiveSessionKey(agentDefinition);
  return abortOpenClawChatSession({ sessionKey });
}

async function abortOpenClawChatSession({ sessionKey, runId = "" }) {
  if (!sessionKey) {
    return {
      backend: "openclaw",
      aborted: false,
      runIds: [],
      sessionKey: ""
    };
  }

  const params = runId ? { sessionKey, runId } : { sessionKey };
  const { payload } = await runOpenClawGatewayCall("chat.abort", params, {
    timeoutMs: 10000
  });

  return {
    backend: "openclaw",
    aborted: Boolean(payload?.aborted),
    runIds: Array.isArray(payload?.runIds) ? payload.runIds : [],
    sessionKey
  };
}

async function resolveOpenClawInteractiveSessionInfo(agentDefinition) {
  const { args } = await loadResolvedAgentArgs(agentDefinition, {
    interactive: true
  });
  const rawSessionKey = readCliOption(args, "--session").trim().toLowerCase();
  if (!rawSessionKey) {
    return {
      rawSessionKey: "",
      sessionKey: "",
      sessionId: ""
    };
  }
  if (rawSessionKey === "global" || rawSessionKey === "unknown" || rawSessionKey.startsWith("agent:")) {
    const sessions = await listOpenClawSessions().catch(() => []);
    const match = sessions.find((session) => String(session?.key || "").toLowerCase() === rawSessionKey);
    return {
      rawSessionKey,
      sessionKey: rawSessionKey,
      sessionId: String(match?.sessionId || "")
    };
  }

  const matches = (await listOpenClawSessions().catch(() => []))
    .filter((session) => typeof session?.key === "string")
    .filter((session) => String(session.key).toLowerCase().endsWith(`:${rawSessionKey}`))
    .sort((left, right) => Number(right?.updatedAt || 0) - Number(left?.updatedAt || 0));
  const match = matches[0] || null;
  return {
    rawSessionKey,
    sessionKey: match?.key ? String(match.key) : `agent:main:${rawSessionKey}`,
    sessionId: match?.sessionId ? String(match.sessionId) : ""
  };
}

function isOpenClawAutoplayActive(worker) {
  return Boolean(worker && !worker.stopRequested && ["starting", "running", "waiting"].includes(worker.status));
}

function summarizeOpenClawAutoplayWorker(worker) {
  if (!worker) {
    return null;
  }
  return {
    enabled: isOpenClawAutoplayActive(worker),
    status: worker.status,
    turnCount: worker.turnCount,
    maxTurns: worker.maxTurns,
    stopReason: worker.stopReason,
    startedAt: worker.startedAt,
    stoppedAt: worker.stoppedAt,
    mudTarget: worker.mudTarget,
    sessionKey: worker.sessionKey || "",
    lastError: worker.lastError || "",
    lastAssistantReply: worker.lastAssistantReply || ""
  };
}

function getOpenClawAutoplayWorker(agentId) {
  return interactiveAutoplayWorkers.get(agentId) || null;
}

function getOpenClawAutoplayWorkerByInteractiveTarget(target) {
  for (const worker of interactiveAutoplayWorkers.values()) {
    if (worker.interactiveTarget === target) {
      return worker;
    }
  }
  return null;
}

function updateOpenClawAutoplayWorker(worker, updates = {}) {
  Object.assign(worker, updates);
  interactiveAutoplayWorkers.set(worker.agentId, worker);
}

function extractOpenClawMessageText(message) {
  const content = Array.isArray(message?.content) ? message.content : [];
  return content
    .filter((entry) => entry && typeof entry === "object" && entry.type === "text" && typeof entry.text === "string")
    .map((entry) => entry.text)
    .join("\n")
    .trim();
}

function normalizeAutoplaySnapshot(output) {
  return String(output || "").replace(/\u001b\[[0-9;]*m/g, "").trim();
}

function detectOpenClawAutoplayStopReason(worker, latestAssistantReply, mudSnapshot, previousMudSnapshot = "") {
  const reply = String(latestAssistantReply || "");
  if (
    /(real blocker|need user approval|need approval|need user input|need more information|can't proceed safely|cannot proceed safely|无法继续|需要用户|需要你提供|需要.*批准|明确批准|需要批准|需要许可|需要授权)/i.test(
      reply
    )
  ) {
    return {
      status: "blocked",
      reason: "Agent reported a blocker."
    };
  }

  if (mudSnapshot && mudSnapshot === previousMudSnapshot) {
    const repeats = Number(worker.repeatedSnapshotCount || 0) + 1;
    worker.repeatedSnapshotCount = repeats;
    if (repeats >= 3) {
      return {
        status: "stopped",
        reason: "MUD output stopped changing across consecutive turns."
      };
    }
  } else {
    worker.repeatedSnapshotCount = 0;
  }

  return null;
}

async function buildOpenClawAutoplayContinuationPrompt(worker) {
  const latestOutput = await capturePane(worker.mudTarget, 160).catch(() => "");
  return [
    `Active tmux target: ${worker.mudTarget}`,
    `Latest MUD output:\n${latestOutput || "(no output captured)"}`,
    "Continue playing autonomously from this exact state.",
    "Inspect before sending commands.",
    "Take the next safe low-risk action or short sequence of actions.",
    "Do not stop for routine confirmation. Only stop if you hit a real blocker, a risky irreversible choice, or need missing information."
  ].join("\n\n");
}

function spawnOpenClawGatewayCall(method, params, options = {}) {
  const command = resolveExecutable("openclaw");
  const args = [
    "gateway",
    "call",
    method,
    "--params",
    JSON.stringify(params),
    "--json"
  ];
  if (options.expectFinal) {
    args.push("--expect-final");
  }
  if (options.timeoutMs) {
    args.push("--timeout", String(options.timeoutMs));
  }

  const child = spawn(command, args, {
    cwd: repoRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"]
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString("utf8");
  });

  const completion = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code, signal) => {
      if (code === 0) {
        resolve({
          stdout,
          stderr,
          code,
          signal,
          child
        });
        return;
      }

      const detail = String(stderr || stdout || `${method} exited with code ${code}`).trim();
      const error = createError(
        `openclaw gateway call ${method} failed: ${detail}`,
        "OPENCLAW_GATEWAY_CALL_FAILED",
        500,
        {
          method,
          params,
          code,
          signal
        }
      );
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
  }).then((result) => {
    let payload;
    try {
      payload = JSON.parse(String(result.stdout || "{}"));
    } catch (error) {
      throw createError(
        `Unable to parse OpenClaw ${method} output: ${error.message}`,
        "OPENCLAW_GATEWAY_PARSE_FAILED",
        500,
        {
          method
        }
      );
    }

    return {
      payload,
      child
    };
  });

  return {
    child,
    completion
  };
}

async function runOpenClawGatewayCall(method, params, options = {}) {
  const { completion } = spawnOpenClawGatewayCall(method, params, options);
  return await completion;
}

async function waitForOpenClawRunResult(runId, timeoutMs = 5000) {
  const normalizedRunId = String(runId || "").trim();
  if (!normalizedRunId) {
    return null;
  }

  const { payload } = await runOpenClawGatewayCall(
    "agent.wait",
    {
      runId: normalizedRunId,
      timeoutMs
    },
    {
      timeoutMs: Math.max(timeoutMs + 2000, 5000)
    }
  );
  return payload && typeof payload === "object" ? payload : null;
}

async function loadOpenClawChatHistory(sessionKey, limit = 8) {
  const { payload } = await runOpenClawGatewayCall(
    "chat.history",
    {
      sessionKey,
      limit
    },
    {
      timeoutMs: 15000
    }
  );
  return Array.isArray(payload?.messages) ? payload.messages : [];
}

async function stopOpenClawAutoplayWorker(worker, reason, options = {}) {
  if (!worker) {
    return {
      backend: "openclaw",
      aborted: false,
      runIds: [],
      sessionKey: "",
      autoplayStopped: false
    };
  }

  const wasActive = isOpenClawAutoplayActive(worker);
  worker.stopRequested = true;
  worker.stopReason = reason || worker.stopReason || "Stopped.";
  if (wasActive) {
    worker.status = "stopping";
  }

  if (worker.currentProcess && !worker.currentProcess.killed) {
    worker.currentProcess.kill("SIGTERM");
    setTimeout(() => {
      if (worker.currentProcess && !worker.currentProcess.killed) {
        worker.currentProcess.kill("SIGKILL");
      }
    }, 1000).unref();
  }

  let backendStop = {
    backend: "openclaw",
    aborted: false,
    runIds: [],
    sessionKey: worker.sessionKey || "",
    autoplayStopped: true
  };
  if (options.abortSession !== false && worker.sessionKey) {
    backendStop = await abortOpenClawChatSession({
      sessionKey: worker.sessionKey,
      runId: worker.currentRunId || ""
    }).catch(() => backendStop);
    backendStop.autoplayStopped = true;
    if (worker.currentRunId) {
      backendStop.waitResult = await waitForOpenClawRunResult(
        worker.currentRunId,
        Number(options.waitTimeoutMs || 5000)
      ).catch(() => null);
    }
  }

  updateOpenClawAutoplayWorker(worker, {
    status: options.finalStatus || "stopped",
    stopRequested: true,
    stopReason: reason || worker.stopReason || "Stopped.",
    stoppedAt: new Date().toISOString(),
    currentProcess: null,
    currentRunId: ""
  });

  return backendStop;
}

async function stopOpenClawAutoplayForInteractiveTarget(target, reason, options = {}) {
  const worker = getOpenClawAutoplayWorkerByInteractiveTarget(target);
  if (!isOpenClawAutoplayActive(worker)) {
    return null;
  }

  return stopOpenClawAutoplayWorker(worker, reason || "Manual takeover.", {
    abortSession: options.abortSession !== false,
    finalStatus: options.finalStatus || "stopped"
  });
}

async function runOpenClawAutoplayLoop(worker) {
  try {
    updateOpenClawAutoplayWorker(worker, {
      status: "running",
      startedAt: worker.startedAt || new Date().toISOString(),
      stoppedAt: null,
      lastError: ""
    });

    while (!worker.stopRequested && worker.turnCount < worker.maxTurns) {
      const mudPaneState = await inspectTmuxWindow(worker.mudTarget).catch(() => null);
      if (mudPaneState?.paneDead) {
        updateOpenClawAutoplayWorker(worker, {
          status: "error",
          stopReason: "MUD pane died.",
          stoppedAt: new Date().toISOString(),
          lastError: "MUD pane died."
        });
        return;
      }

      const prompt =
        worker.turnCount === 0 && worker.initialPrompt
          ? worker.initialPrompt
          : await buildOpenClawAutoplayContinuationPrompt(worker);

      const idempotencyKey = `mud-agent-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
      const sendCall = spawnOpenClawGatewayCall(
        "chat.send",
        {
          sessionKey: worker.sessionKey,
          message: prompt,
          deliver: false,
          idempotencyKey
        },
        {
          timeoutMs: 15000
        }
      );

      updateOpenClawAutoplayWorker(worker, {
        status: "running",
        currentProcess: sendCall.child,
        currentRunId: "",
        lastPrompt: prompt
      });

      let sendPayload;
      try {
        ({ payload: sendPayload } = await sendCall.completion);
      } catch (error) {
        if (worker.stopRequested) {
          break;
        }
        throw error;
      }

      updateOpenClawAutoplayWorker(worker, {
        currentProcess: null
      });

      if (worker.stopRequested) {
        break;
      }

      const runId = String(sendPayload?.runId || "").trim();
      const sendStatus = String(sendPayload?.status || "").trim().toLowerCase();
      if (!runId || !["started", "in_flight", "ok"].includes(sendStatus)) {
        throw createError(
          `OpenClaw autoplay turn did not start cleanly (status: ${sendStatus || "unknown"})`,
          "OPENCLAW_AUTOPLAY_START_FAILED",
          500,
          {
            sessionKey: worker.sessionKey,
            runId
          }
        );
      }

      const waitCall = spawnOpenClawGatewayCall(
        "agent.wait",
        {
          runId,
          timeoutMs: worker.turnTimeoutMs
        },
        {
          timeoutMs: worker.turnTimeoutMs + 35000
        }
      );
      updateOpenClawAutoplayWorker(worker, {
        currentProcess: waitCall.child,
        currentRunId: runId
      });

      let waitPayload;
      try {
        ({ payload: waitPayload } = await waitCall.completion);
      } catch (error) {
        if (worker.stopRequested) {
          break;
        }
        throw error;
      }

      updateOpenClawAutoplayWorker(worker, {
        currentProcess: null
      });

      if (worker.stopRequested) {
        break;
      }

      const waitStatus = String(waitPayload?.status || "").trim().toLowerCase();
      if (waitStatus === "timeout") {
        await abortOpenClawChatSession({
          sessionKey: worker.sessionKey,
          runId
        }).catch(() => null);
        await waitForOpenClawRunResult(runId, 5000).catch(() => null);
        throw createError(
          "OpenClaw autoplay turn timed out.",
          "OPENCLAW_AUTOPLAY_TURN_TIMEOUT",
          500,
          {
            runId
          }
        );
      }
      if (waitStatus === "error") {
        throw createError(
          `OpenClaw autoplay turn failed: ${String(waitPayload?.error || "agent.wait returned error")}`,
          "OPENCLAW_AUTOPLAY_TURN_FAILED",
          500,
          {
            runId
          }
        );
      }
      if (waitStatus && waitStatus !== "ok") {
        throw createError(
          `OpenClaw autoplay turn ended unexpectedly with status: ${waitStatus}`,
          "OPENCLAW_AUTOPLAY_TURN_FAILED",
          500,
          {
            runId
          }
        );
      }

      const messages = await loadOpenClawChatHistory(worker.sessionKey, 10).catch(() => []);
      const latestAssistant = [...messages].reverse().find((message) => message?.role === "assistant") || null;
      const latestAssistantReply = extractOpenClawMessageText(latestAssistant);
      const latestMudOutput = await capturePane(worker.mudTarget, 160).catch(() => "");
      const latestMudSnapshot = normalizeAutoplaySnapshot(latestMudOutput);
      const turnCompletedAt = new Date().toISOString();
      const previousMudSnapshot = worker.lastMudSnapshot;
      const nextTurnCount = Number(worker.turnCount || 0) + 1;

      const detectedStop = detectOpenClawAutoplayStopReason(worker, latestAssistantReply, latestMudSnapshot, previousMudSnapshot);
      updateOpenClawAutoplayWorker(worker, {
        turnCount: nextTurnCount,
        lastAssistantReply: latestAssistantReply,
        lastMudOutput: latestMudOutput,
        lastMudSnapshot: latestMudSnapshot,
        lastTurnCompletedAt: turnCompletedAt,
        repeatedSnapshotCount: Number(worker.repeatedSnapshotCount || 0),
        currentRunId: ""
      });
      if (detectedStop) {
        updateOpenClawAutoplayWorker(worker, {
          status: detectedStop.status,
          stopRequested: true,
          stopReason: detectedStop.reason,
          stoppedAt: new Date().toISOString(),
          currentProcess: null,
          currentRunId: ""
        });
        return;
      }

      updateOpenClawAutoplayWorker(worker, {
        status: "waiting"
      });
      if (worker.turnCount >= worker.maxTurns) {
        break;
      }
      if (worker.interTurnDelayMs > 0) {
        await sleep(worker.interTurnDelayMs);
      }
    }

    updateOpenClawAutoplayWorker(worker, {
      status: worker.stopRequested ? worker.status : "stopped",
      stopRequested: true,
      stopReason: worker.stopReason || (worker.turnCount >= worker.maxTurns ? "Reached max turns." : "Autoplay stopped."),
      stoppedAt: new Date().toISOString(),
      currentProcess: null,
      currentRunId: ""
    });
  } catch (error) {
    updateOpenClawAutoplayWorker(worker, {
      status: "error",
      stopRequested: true,
      stopReason: "Autoplay failed.",
      stoppedAt: new Date().toISOString(),
      currentProcess: null,
      currentRunId: "",
      lastError: error.message
    });
  }
}

async function startOpenClawAutoplayWorker({
  agentDefinition,
  interactiveTarget,
  mudTarget,
  serverId,
  launchMode,
  loginProfileId,
  prompt
}) {
  if (!mudTarget || !prompt.trim()) {
    return null;
  }

  const existing = getOpenClawAutoplayWorker(agentDefinition.id);
  if (existing) {
    await stopOpenClawAutoplayWorker(existing, "Restarted autoplay.", {
      abortSession: true,
      finalStatus: "stopped"
    }).catch(() => {});
  }

  const sessionInfo = await resolveOpenClawInteractiveSessionInfo(agentDefinition);
  const worker = {
    agentId: agentDefinition.id,
    agentName: agentDefinition.name,
    interactiveTarget,
    mudTarget,
    serverId: serverId || "",
    launchMode: normalizeLaunchMode(launchMode),
    loginProfileId: loginProfileId || "",
    rawSessionKey: sessionInfo.rawSessionKey,
    sessionKey: sessionInfo.sessionKey,
    sessionId: sessionInfo.sessionId,
    status: "starting",
    turnCount: 0,
    maxTurns: Number(agentDefinition.interactiveAutoplayMaxTurns || 50),
    interTurnDelayMs: Number(agentDefinition.interactiveAutoplayInterTurnDelayMs || 2000),
    turnTimeoutMs: Number(agentDefinition.interactiveAutoplayTurnTimeoutMs || 600000),
    stopRequested: false,
    stopReason: "",
    startedAt: new Date().toISOString(),
    stoppedAt: "",
    currentProcess: null,
    currentRunId: "",
    initialPrompt: String(prompt || ""),
    lastAssistantReply: "",
    lastMudOutput: "",
    lastMudSnapshot: "",
    repeatedSnapshotCount: 0,
    lastError: ""
  };

  interactiveAutoplayWorkers.set(agentDefinition.id, worker);
  void runOpenClawAutoplayLoop(worker);
  return summarizeOpenClawAutoplayWorker(worker);
}

async function stopInteractiveAgentExecution(agentDefinition, options = {}) {
  if (isOpenClawInteractiveAgent(agentDefinition)) {
    const worker = getOpenClawAutoplayWorker(agentDefinition.id);
    if (worker) {
      const backendStop = await stopOpenClawAutoplayWorker(worker, options.reason || "Stopped interactive agent.", {
        abortSession: options.abortSession !== false,
        finalStatus: options.finalStatus || "stopped"
      });
      const paneStop = await stopPaneProcessGroup(options.panePid, {
        graceMs: options.graceMs
      });
      return {
        backend: "openclaw",
        paneStop,
        ...backendStop,
        stopped: Boolean(
          (backendStop.aborted || backendStop.autoplayStopped) &&
          (paneStop.stopped || paneStop.panePid <= 0)
        )
      };
    }
    const backendStop = await abortOpenClawInteractiveSession(agentDefinition);
    const paneStop = await stopPaneProcessGroup(options.panePid, {
      graceMs: options.graceMs
    });
    return {
      backend: "openclaw",
      paneStop,
      ...backendStop,
      stopped: Boolean(backendStop.aborted && (paneStop.stopped || paneStop.panePid <= 0))
    };
  }

  const paneStop = await stopPaneProcessGroup(options.panePid, {
    graceMs: options.graceMs
  });
  return {
    backend: "process_group",
    ...paneStop
  };
}

function validateServerPayload(payload, { existingId } = {}) {
  const normalized = {
    id: String(payload.id || "").trim(),
    name: String(payload.name || "").trim(),
    host: String(payload.host || "").trim(),
    port: Number(payload.port),
    encoding: normalizeEncoding(payload.encoding || "UTF-8"),
    protocol: String(payload.protocol || "telnet").trim() || "telnet",
    launcherType: String(payload.launcherType || "custom_command").trim() || "custom_command",
    launcherCommand: String(payload.launcherCommand || "").trim(),
    loginCommand: payload.loginCommand ? String(payload.loginCommand).trim() : undefined,
    windowName: String(payload.windowName || "").trim(),
    windowNames: Array.isArray(payload.windowNames)
      ? [...new Set(payload.windowNames.map((entry) => String(entry).trim()).filter(Boolean))]
      : undefined,
    tmuxSession: String(payload.tmuxSession || "0").trim() || "0",
    sendMode: payload.sendMode === SEND_MODES.PANE_TTY ? SEND_MODES.PANE_TTY : SEND_MODES.TMUX_KEYS,
    notes: payload.notes ? String(payload.notes) : "",
    loginWaitMs: Number(payload.loginWaitMs || 0) || undefined,
    isBuiltIn: false
  };

  for (const field of ["id", "name", "host", "launcherCommand", "windowName"]) {
    if (!normalized[field]) {
      throw createError(`Missing required field: ${field}`, "INVALID_SERVER_PAYLOAD", 400, {
        field
      });
    }
  }

  if (!Number.isInteger(normalized.port) || normalized.port <= 0 || normalized.port > 65535) {
    throw createError("port must be an integer between 1 and 65535", "INVALID_SERVER_PAYLOAD", 400, {
      field: "port"
    });
  }

  if (existingId && normalized.id !== existingId) {
    throw createError("Custom server id cannot be changed", "IMMUTABLE_SERVER_ID", 400, {
      serverId: existingId
    });
  }

  normalized.windowNames = [...new Set([normalized.windowName, ...(normalized.windowNames || [])])];
  return normalized;
}

async function createOrReuseWindow(server, tmuxSession) {
  const windows = await listTmuxWindows(tmuxSession);
  const existingNames = new Set(getWindowNames(server));
  const existing = windows.find((window) => existingNames.has(window.windowName));
  if (existing) {
    const paneState = await inspectTmuxWindow(existing.target);
    if (paneState.paneDead) {
      await killTmuxWindow(existing.target).catch(() => {});
    } else {
      return {
        id: existing.target,
        target: existing.target,
        tmuxSession,
        windowName: existing.windowName,
        serverId: server.id,
        encoding: normalizeEncoding(server.encoding),
        sendMode: server.sendMode,
        reused: true
      };
    }
  }

  const launcherCommand = resolveScript(server.launcherCommand);
  const { stdout } = await runTmux([
    "new-window",
    "-P",
    "-F",
    "#{session_name}:#{window_name}",
    "-t",
    `${tmuxSession}:`,
    "-n",
    server.windowName,
    launcherCommand
  ]);

  const target = stdout.trim();
  return {
    id: target,
    target,
    tmuxSession,
    windowName: server.windowName,
    serverId: server.id,
    encoding: normalizeEncoding(server.encoding),
    sendMode: server.sendMode,
    reused: false
  };
}

async function inspectTmuxWindow(target) {
  try {
    const { stdout } = await runTmux([
      "display-message",
      "-p",
      "-t",
      target,
      "#{pane_dead}\t#{pane_current_command}"
    ]);
    const [paneDeadRaw = "1", currentCommand = ""] = stdout.trim().split("\t");
    return {
      paneDead: paneDeadRaw === "1",
      currentCommand
    };
  } catch (error) {
    if (error.message.includes("can't find pane") || error.message.includes("can't find window")) {
      return {
        paneDead: true,
        currentCommand: ""
      };
    }
    throw error;
  }
}

async function inspectTmuxPaneProcess(target) {
  try {
    const { stdout } = await runTmux([
      "display-message",
      "-p",
      "-t",
      target,
      "#{pane_dead}\t#{pane_pid}\t#{pane_current_command}\t#{pane_tty}"
    ]);
    const [paneDeadRaw = "1", panePidRaw = "0", currentCommand = "", paneTty = ""] = stdout.trim().split("\t");
    return {
      paneDead: paneDeadRaw === "1",
      panePid: Number(panePidRaw) || 0,
      currentCommand,
      paneTty
    };
  } catch (error) {
    if (error.message.includes("can't find pane") || error.message.includes("can't find window")) {
      return {
        paneDead: true,
        panePid: 0,
        currentCommand: "",
        paneTty: ""
      };
    }
    throw error;
  }
}

async function inspectInteractiveAgentPane(target) {
  return inspectTmuxWindow(target);
}

async function getProcessGroupId(pid) {
  const normalizedPid = Number(pid);
  if (!Number.isFinite(normalizedPid) || normalizedPid <= 0) {
    return 0;
  }

  try {
    const { stdout } = await run("ps", ["-o", "pgid=", "-p", String(normalizedPid)]);
    return Number(String(stdout || "").trim()) || 0;
  } catch {
    return 0;
  }
}

function canSignalProcessGroup(pgid) {
  const normalizedPgid = Number(pgid);
  if (!Number.isFinite(normalizedPgid) || normalizedPgid <= 0) {
    return false;
  }

  try {
    process.kill(-normalizedPgid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function terminateProcessGroup(pgid, options = {}) {
  const normalizedPgid = Number(pgid);
  if (!Number.isFinite(normalizedPgid) || normalizedPgid <= 0 || !canSignalProcessGroup(normalizedPgid)) {
    return {
      pgid: normalizedPgid || 0,
      signaled: false,
      finalSignal: "",
      stillRunning: false
    };
  }

  const termSignal = options.termSignal || "SIGTERM";
  const killSignal = options.killSignal || "SIGKILL";
  const graceMs = Number(options.graceMs || 1500);

  process.kill(-normalizedPgid, termSignal);
  if (graceMs > 0) {
    await sleep(graceMs);
  }

  if (!canSignalProcessGroup(normalizedPgid)) {
    return {
      pgid: normalizedPgid,
      signaled: true,
      finalSignal: termSignal,
      stillRunning: false
    };
  }

  process.kill(-normalizedPgid, killSignal);
  await sleep(200);

  return {
    pgid: normalizedPgid,
    signaled: true,
    finalSignal: killSignal,
    stillRunning: canSignalProcessGroup(normalizedPgid)
  };
}

async function stopPaneProcessGroup(panePid, options = {}) {
  const normalizedPanePid = Number(panePid || 0);
  const pgid = await getProcessGroupId(normalizedPanePid);
  if (!pgid) {
    return {
      panePid: normalizedPanePid,
      pgid: 0,
      signaled: false,
      finalSignal: "",
      stillRunning: false,
      stopped: false
    };
  }

  const termination = await terminateProcessGroup(pgid, {
    graceMs: Number(options.graceMs || 1500)
  });
  return {
    panePid: normalizedPanePid,
    ...termination,
    stopped: termination.signaled && !termination.stillRunning
  };
}

function summarizeInteractiveAgentSession(agentDefinition, target, tmuxSession, reused = true, agentProfile = null) {
  const windowName = target.includes(":") ? target.split(":").slice(1).join(":") : target;
  const autoplay = isOpenClawInteractiveAgent(agentDefinition)
    ? summarizeOpenClawAutoplayWorker(
        getOpenClawAutoplayWorkerByInteractiveTarget(target) || getOpenClawAutoplayWorker(agentDefinition.id)
      )
    : null;
  return {
    id: `${agentDefinition.id}@${target}`,
    agentId: agentDefinition.id,
    agentName: agentDefinition.name,
    agentProfileId: agentProfile?.id || "default",
    agentProfileLabel: agentProfile?.label || agentProfile?.id || "default",
    target,
    tmuxSession,
    windowName,
    status: "running",
    reused,
    autoplay
  };
}


async function findInteractiveAgentWindow(agentDefinition, tmuxSession, options = {}) {
  const { includeDead = false } = options;
  const windows = await listTmuxWindows(tmuxSession);
  const existingNames = new Set(getInteractiveWindowNames(agentDefinition));
  let deadWindow = null;

  for (const window of windows) {
    if (!existingNames.has(window.windowName)) {
      continue;
    }

    const paneState = await inspectInteractiveAgentPane(window.target);
    const candidate = {
      ...window,
      ...paneState
    };

    if (!candidate.paneDead) {
      return candidate;
    }

    if (includeDead && !deadWindow) {
      deadWindow = candidate;
    }
  }

  return includeDead ? deadWindow : null;
}

function buildInteractiveAgentCommand(agentDefinition, runtimeProfiles = null, selectedProfile = null) {
  const command = resolveExecutable(agentDefinition.interactiveCommand || agentDefinition.command);
  const configuredArgs = Array.isArray(agentDefinition.interactiveArgs)
    ? agentDefinition.interactiveArgs
    : Array.isArray(agentDefinition.args)
      ? agentDefinition.args
      : [];
  const args = applyAgentRuntimeProfileToArgs(
    agentDefinition,
    configuredArgs,
    runtimeProfiles,
    selectedProfile,
    { interactive: true }
  );
  const workingDirectory = resolveWorkingDirectory(
    agentDefinition.interactiveWorkingDirectory || agentDefinition.workingDirectory
  );
  const envPairs = Object.entries({
    ...(agentDefinition.env || {}),
    ...(agentDefinition.interactiveEnv || {})
  });
  const envPrefix = envPairs.length
    ? `${envPairs.map(([key, value]) => `${key}=${shellEscape(value)}`).join(" ")} `
    : "";

  return `cd ${shellEscape(workingDirectory)} && ${envPrefix}exec ${[command, ...args].map(shellEscape).join(" ")}`;
}

async function createOrReuseInteractiveAgentWindow(agentDefinition, agentProfileId = "default") {
  if (!supportsInteractiveTmux(agentDefinition)) {
    throw createError(
      `Interactive tmux mode is not configured for ${agentDefinition.id}`,
      "AGENT_INTERACTIVE_UNSUPPORTED",
      400,
      {
        agentId: agentDefinition.id
      }
    );
  }

  const tmuxSession = String(agentDefinition.interactiveTmuxSession || "0");
  await ensureTmuxSession(tmuxSession);

  const existing = await findInteractiveAgentWindow(agentDefinition, tmuxSession, {
    includeDead: true
  });
  const runtimeProfiles = await loadAgentRuntimeProfileById(agentDefinition, agentProfileId);
  const selectedProfile = runtimeProfiles.selectedProfile;
  if (existing) {
    const existingProfileId = interactiveAgentRuntimeProfiles.get(existing.target) || interactiveAgentRuntimeProfiles.get(agentDefinition.id) || "default";
    if (existing.paneDead) {
      await killTmuxWindow(existing.target).catch(() => {});
      interactiveAgentRuntimeProfiles.delete(existing.target);
    } else if (existingProfileId === selectedProfile.id) {
      return summarizeInteractiveAgentSession(agentDefinition, existing.target, tmuxSession, true, selectedProfile);
    } else {
      await killTmuxWindow(existing.target).catch(() => {});
      interactiveAgentRuntimeProfiles.delete(existing.target);
    }
  }

  const windowName = agentDefinition.interactiveWindowName || `${agentDefinition.id}_tui`;
  const command = buildInteractiveAgentCommand(agentDefinition, runtimeProfiles, selectedProfile);
  const { stdout } = await runTmux([
    "new-window",
    "-P",
    "-F",
    "#{session_name}:#{window_name}",
    "-t",
    `${tmuxSession}:`,
    "-n",
    windowName,
    command
  ]);

  const target = stdout.trim();
  interactiveAgentRuntimeProfiles.set(target, selectedProfile.id);
  interactiveAgentRuntimeProfiles.set(agentDefinition.id, selectedProfile.id);
  await runTmux(["set-window-option", "-t", target, "remain-on-exit", "on"]);
  await sleep(150);
  const paneState = await inspectInteractiveAgentPane(target);
  if (paneState.paneDead) {
    throw createError(
      `Interactive agent ${target} exited immediately after launch`,
      "AGENT_INTERACTIVE_START_FAILED",
      500,
      {
        target,
        command
      }
    );
  }
  return summarizeInteractiveAgentSession(agentDefinition, target, tmuxSession, false, selectedProfile);
}

async function waitForInteractiveAgentReady(agentDefinition, target) {
  const readyPatterns = Array.isArray(agentDefinition.interactiveReadyPatterns)
    ? agentDefinition.interactiveReadyPatterns.map((value) => String(value)).filter(Boolean)
    : [];
  const readyAnyPatterns = Array.isArray(agentDefinition.interactiveReadyAnyPatterns)
    ? agentDefinition.interactiveReadyAnyPatterns.map((value) => String(value)).filter(Boolean)
    : [];
  const notReadyPatterns = Array.isArray(agentDefinition.interactiveNotReadyPatterns)
    ? agentDefinition.interactiveNotReadyPatterns.map((value) => String(value)).filter(Boolean)
    : [];
  const failurePatterns = [
    "Pane is dead",
    ...(Array.isArray(agentDefinition.interactiveFailurePatterns)
      ? agentDefinition.interactiveFailurePatterns.map((value) => String(value)).filter(Boolean)
      : [])
  ];

  if (readyPatterns.length === 0 && readyAnyPatterns.length === 0 && notReadyPatterns.length === 0) {
    const readyDelayMs = Number(agentDefinition.interactiveReadyDelayMs || 1200);
    if (readyDelayMs > 0) {
      await sleep(readyDelayMs);
    }
    const paneState = await inspectInteractiveAgentPane(target);
    if (paneState.paneDead) {
      throw createError(
        `Interactive agent ${target} exited before becoming ready`,
        "AGENT_INTERACTIVE_START_FAILED",
        500,
        {
          target
        }
      );
    }
    return;
  }

  const timeoutMs = Number(agentDefinition.interactiveReadyTimeoutMs || 15000);
  const pollMs = Number(agentDefinition.interactiveReadyPollMs || 250);
  const startedAt = Date.now();

  const findLastPatternIndex = (output, patterns) =>
    patterns.reduce((maxIndex, pattern) => {
      const index = output.lastIndexOf(pattern);
      return index > maxIndex ? index : maxIndex;
    }, -1);

  while (Date.now() - startedAt < timeoutMs) {
    const output = await capturePane(target, 120).catch(() => "");

    if (failurePatterns.some((pattern) => output.includes(pattern))) {
      throw createError(
        `Interactive agent ${target} exited before becoming ready`,
        "AGENT_INTERACTIVE_START_FAILED",
        500,
        {
          target
        }
      );
    }

    const hasAllReadyPatterns = readyPatterns.every((pattern) => output.includes(pattern));
    const hasAnyReadyPattern = readyAnyPatterns.length === 0 || readyAnyPatterns.some((pattern) => output.includes(pattern));
    const lastNotReadyIndex = findLastPatternIndex(output, notReadyPatterns);
    const lastReadyIndex = Math.max(
      findLastPatternIndex(output, readyPatterns),
      findLastPatternIndex(output, readyAnyPatterns)
    );
    const hasBlockingNotReadyPattern = lastNotReadyIndex !== -1 && lastReadyIndex <= lastNotReadyIndex;

    if (hasAllReadyPatterns && hasAnyReadyPattern && !hasBlockingNotReadyPattern) {
      return;
    }

    await sleep(pollMs);
  }

  throw createError(
    `Interactive agent ${target} did not become ready before timeout`,
    "AGENT_INTERACTIVE_READY_TIMEOUT",
    504,
    {
      target,
      timeoutMs
    }
  );
}

async function waitForInteractivePromptEcho(target, prompt, timeoutMs = 2000, pollMs = 60) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const output = await capturePane(target, 120).catch(() => "");
    if (output.includes(prompt)) {
      return true;
    }
    await sleep(pollMs);
  }
  return false;
}

async function waitForInteractiveSubmitConfirmation(agentDefinition, target) {
  const confirmPatterns = Array.isArray(agentDefinition.interactiveSubmitConfirmPatterns)
    ? agentDefinition.interactiveSubmitConfirmPatterns.map((value) => String(value)).filter(Boolean)
    : [];
  if (confirmPatterns.length === 0) {
    return true;
  }

  const timeoutMs = Number(agentDefinition.interactiveSubmitConfirmTimeoutMs || 2000);
  const pollMs = Number(agentDefinition.interactiveSubmitConfirmPollMs || 100);
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const output = await capturePane(target, 120).catch(() => "");
    if (confirmPatterns.some((pattern) => output.includes(pattern))) {
      return true;
    }
    await sleep(pollMs);
  }

  return false;
}

async function acknowledgeInteractiveStartupPrompt(agentDefinition, target) {
  const promptPatterns = Array.isArray(agentDefinition.interactiveStartupAcknowledgePatterns)
    ? agentDefinition.interactiveStartupAcknowledgePatterns.map((value) => String(value)).filter(Boolean)
    : [];
  const keys = Array.isArray(agentDefinition.interactiveStartupAcknowledgeKeys)
    ? agentDefinition.interactiveStartupAcknowledgeKeys.map((value) => String(value)).filter(Boolean)
    : [];

  if (promptPatterns.length === 0 || keys.length === 0) {
    return false;
  }

  const timeoutMs = Number(agentDefinition.interactiveStartupAcknowledgeTimeoutMs || 5000);
  const pollMs = Number(agentDefinition.interactiveStartupAcknowledgePollMs || 150);
  const postDelayMs = Number(agentDefinition.interactiveStartupAcknowledgePostDelayMs || 1000);
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    const output = await capturePane(target, 120).catch(() => "");
    if (promptPatterns.every((pattern) => output.includes(pattern))) {
      await sendRawKeysViaTmux(target, keys);
      if (postDelayMs > 0) {
        await sleep(postDelayMs);
      }
      return true;
    }

    const paneState = await inspectInteractiveAgentPane(target);
    if (paneState.paneDead) {
      throw createError(
        `Interactive agent ${target} exited while waiting for startup acknowledgement`,
        "AGENT_INTERACTIVE_START_FAILED",
        500,
        {
          target
        }
      );
    }

    await sleep(pollMs);
  }

  return false;
}

async function sendInteractivePrompt(agentDefinition, target, prompt) {
  await acknowledgeInteractiveStartupPrompt(agentDefinition, target);
  await waitForInteractiveAgentReady(agentDefinition, target);
  const startupMode = getInteractiveStartupMode(agentDefinition);

  try {
    let textToSend = "";
    let promptFilePath = null;

    if (startupMode === "inline_prompt") {
      textToSend = normalizeInteractivePromptInstruction(prompt);
      if (!textToSend) {
        return;
      }
    } else {
      promptFilePath = await writeInteractivePromptFile(agentDefinition, target, prompt);
      if (!promptFilePath) {
        return;
      }
      textToSend = buildInteractivePromptInstruction(promptFilePath);
    }

    await sendLiteralInChunksViaTmux(target, textToSend);
    if (startupMode !== "inline_prompt") {
      await waitForInteractivePromptEcho(target, textToSend);
    }
    await sleep(Number(agentDefinition.interactiveSubmitDelayMs || 120));
    await sendRawKeysViaTmux(target, ["Enter"]);

    const confirmed = await waitForInteractiveSubmitConfirmation(agentDefinition, target);
    if (!confirmed) {
      await sleep(150);
      await sendRawKeysViaTmux(target, ["Enter"]);
    }
  } catch (error) {
    throw createError(
        `Failed to send startup prompt to interactive agent ${target}`,
        "AGENT_PROMPT_SEND_FAILED",
        500,
        {
          target,
          startupMode,
          detail: error.message
        }
      );
  }
}

async function listInteractiveAgentSessions() {
  const definitions = await loadAgentDefinitions();
  const sessions = [];

  for (const agentDefinition of definitions) {
    if (!supportsInteractiveTmux(agentDefinition)) {
      continue;
    }

    const tmuxSession = String(agentDefinition.interactiveTmuxSession || "0");
    const existing = await findInteractiveAgentWindow(agentDefinition, tmuxSession);
    if (!existing) {
      continue;
    }

    const runtimeProfile = await loadAgentRuntimeProfileById(
      agentDefinition,
      interactiveAgentRuntimeProfiles.get(existing.target) || interactiveAgentRuntimeProfiles.get(agentDefinition.id) || "default"
    );
    sessions.push(
      summarizeInteractiveAgentSession(agentDefinition, existing.target, tmuxSession, true, runtimeProfile.selectedProfile)
    );
  }

  return sessions;
}

async function loadInteractiveAgentSessionByAgentId(agentId) {
  const agentDefinition = await loadAgentDefinitionById(agentId);
  const tmuxSession = String(agentDefinition.interactiveTmuxSession || "0");
  const existing = await findInteractiveAgentWindow(agentDefinition, tmuxSession);
  if (!existing) {
    throw createError(`No interactive session for agent: ${agentId}`, "AGENT_SESSION_NOT_FOUND", 404, {
      agentId
    });
  }

  const runtimeProfile = await loadAgentRuntimeProfileById(
    agentDefinition,
    interactiveAgentRuntimeProfiles.get(existing.target) || interactiveAgentRuntimeProfiles.get(agentDefinition.id) || "default"
  );
  return summarizeInteractiveAgentSession(agentDefinition, existing.target, tmuxSession, true, runtimeProfile.selectedProfile);
}

async function loadServerById(serverId) {
  const servers = await loadServers();
  const server = servers.find((entry) => entry.id === serverId);
  if (!server) {
    throw createError(`Unknown server id: ${serverId}`, "SERVER_NOT_FOUND", 404, {
      serverId
    });
  }
  return server;
}

async function loadLoginProfilesByServerId(serverId) {
  const secrets = await loadLocalSecrets();
  return normalizeLoginProfilesForServer(serverId, secrets);
}

async function loadLoginProfileById(serverId, profileId) {
  const { profiles, defaultProfileId } = await loadLoginProfilesByServerId(serverId);
  const resolvedProfileId = sanitizeProfileId(profileId || defaultProfileId);
  const profile = profiles.find((entry) => entry.id === resolvedProfileId);
  if (!profile) {
    throw createError(`Unknown login profile: ${profileId || defaultProfileId}`, "LOGIN_PROFILE_NOT_FOUND", 404, {
      serverId,
      profileId: profileId || defaultProfileId
    });
  }
  return profile;
}

async function saveLoginProfilesByServerId(serverId, payload) {
  return withWriteLock(async () => {
    const secrets = await loadLocalSecrets();
    secrets[serverId] = serializeLoginProfilesForServer(secrets[serverId], payload);
    await saveLocalSecrets(secrets);
    return normalizeLoginProfilesForServer(serverId, secrets);
  });
}

function normalizeLaunchMode(value) {
  return value === "new-user" ? "new-user" : "existing-login";
}

async function describeSession(target, serverId) {
  const servers = await loadServers();
  const targetWindow = target.includes(":") ? target.split(":").slice(1).join(":") : target;
  const matchedServer =
    (serverId && servers.find((entry) => entry.id === serverId)) ||
    servers.find((entry) => getWindowNames(entry).includes(targetWindow));

  return {
    id: target,
    target,
    serverId: matchedServer?.id ?? null,
    encoding: normalizeEncoding(matchedServer?.encoding ?? "UTF-8"),
    sendMode: matchedServer?.sendMode ?? SEND_MODES.TMUX_KEYS
  };
}

function defaultTargetForServer(server) {
  if (!server?.windowName) {
    return "";
  }

  return `${server.tmuxSession || "0"}:${server.windowName}`;
}

async function listWalkthroughMarkdownFiles(serverId) {
  const candidateDirs = [walkthroughDir];
  if (serverId) {
    candidateDirs.push(path.join(walkthroughDir, serverId));
  }

  const files = [];
  for (const dirPath of candidateDirs) {
    const entries = await readOptionalDirEntries(dirPath);
    for (const entry of entries) {
      if (!entry.isFile() || path.extname(entry.name).toLowerCase() !== ".md") {
        continue;
      }
      files.push(path.join(dirPath, entry.name));
    }
  }

  return files.sort((left, right) => left.localeCompare(right));
}

async function resolvePromptGuideFiles(serverId) {
  const walkthroughFiles = await listWalkthroughMarkdownFiles(serverId);
  const files = [
    {
      label: "Workspace Instructions",
      filePath: workspaceGuidePath
    },
    ...walkthroughFiles.map((filePath) => ({
      label: "Walkthrough",
      filePath
    }))
  ];

  const resolved = await Promise.all(
    files.map(async ({ label, filePath }) => {
      const content = (await readOptionalTextFile(filePath)).trim();
      if (!content) {
        return null;
      }
      return {
        label,
        filePath,
        displayPath: `./${path.relative(repoRoot, filePath).replace(/\\/g, "/")}`
      };
    })
  );

  return resolved.filter(Boolean);
}

function normalizeAgentObjective(objective) {
  return String(objective || "").trim();
}

function buildAgentObjectiveSection(objective) {
  const normalizedObjective = normalizeAgentObjective(objective);
  if (!normalizedObjective) {
    return "";
  }

  return [
    "Objective:",
    normalizedObjective,
    "Follow it when safe. If safety conflicts with it, stabilize the session first and then continue."
  ].join("\n");
}

function injectAgentObjective(prompt, objective) {
  const basePrompt = String(prompt || "").trim();
  const objectiveSection = buildAgentObjectiveSection(objective);
  if (!basePrompt || !objectiveSection) {
    return basePrompt;
  }
  if (basePrompt.includes(objectiveSection)) {
    return basePrompt;
  }
  return `${basePrompt}\n\n${objectiveSection}`;
}

async function buildAgentPrompt({
  agentDefinition,
  server,
  session,
  target,
  launchMode = "existing-login",
  loginProfile = null,
  objective = ""
}) {
  const guideFiles = await resolvePromptGuideFiles(server?.id || session?.serverId || "");
  const helperScripts = [
    "./scripts/tmux-pane-send.sh",
    "./scripts/save-login-profile.mjs",
    "./scripts/aardwolf-tintin.sh"
  ].join(", ");
  const resolvedLaunchMode = normalizeLaunchMode(launchMode);
  const objectiveSection = buildAgentObjectiveSection(objective);
  const guideInstructions = [
    ...guideFiles.map(({ label, displayPath }) => `- Read ${displayPath} (${label}) before acting.`),
    "- Use walkthrough files under ./walkthrough/ instead of rediscovering known routes.",
    "- Do not rely on long game-state excerpts in the startup prompt; open the files directly when you need details.",
    "- While playing, write important discoveries, safe routes, and workflow fixes back to markdown files under ./walkthrough/."
  ].join("\n");
  const launchInstructions =
    resolvedLaunchMode === "new-user"
      ? [
          "- Launch mode: create a new user.",
          "- Do not reuse saved credentials or an existing character.",
          "- If the game is at account or character creation, continue from that fresh state.",
          `- Before finishing, save the new credentials for ${(server?.id || session?.serverId || "the server")} with ./scripts/save-login-profile.mjs.`
        ].join("\n")
      : [
          `- Launch mode: use an existing login profile${loginProfile?.label ? ` (${loginProfile.label})` : ""}.`,
          "- Reuse the existing saved profile instead of creating a new user.",
          loginProfile?.id && (server?.id || session?.serverId)
            ? `- Selected profile: config/local.secrets.json -> ${(server?.id || session?.serverId)}.profiles.${loginProfile.id}`
            : "",
          loginProfile?.username
            ? `- Username: ${loginProfile.username}`
            : "- If the session is at a login prompt, use the selected saved credentials from local secrets.",
          loginProfile?.id && (server?.id || session?.serverId)
            ? "- Read the password and any other saved fields from config/local.secrets.json before entering them."
            : "",
          "- If the session is at login or password prompts, perform the login in the tmux pane using that profile.",
          "- If the session is already in-game, continue safely from the current state."
        ].join("\n");

  if (agentDefinition.promptTemplate) {
    return injectAgentObjective(
      agentDefinition.promptTemplate
      .replaceAll("{serverName}", server?.name || session?.serverId || target)
      .replaceAll("{serverId}", server?.id || session?.serverId || "")
      .replaceAll("{target}", target)
      .replaceAll("{encoding}", session?.encoding || server?.encoding || "UTF-8")
      .replaceAll("{helpers}", helperScripts)
      .replaceAll("{launchMode}", resolvedLaunchMode)
      .replaceAll("{launchInstructions}", launchInstructions)
      .replaceAll("{guideInstructions}", guideInstructions)
      .replaceAll("{loginProfileLabel}", loginProfile?.label || "")
      .replaceAll("{loginProfileUsername}", loginProfile?.username || "")
      .replaceAll("{objective}", normalizeAgentObjective(objective))
      .replaceAll("{objectiveInstructions}", objectiveSection),
      objective
    );
  }

  return injectAgentObjective(
    [
    "You are operating an existing MUD session through tmux.",
    "Settings:",
    `- Target: ${target}`,
    `- Server: ${server?.name || session?.serverId || "unknown"} (${server?.host || "unknown"}:${server?.port || "unknown"})`,
    `- Encoding: ${session?.encoding || server?.encoding || "UTF-8"}`,
    server?.notes ? `Server runtime notes: ${server.notes}` : "",
    objectiveSection,
    "Basic guidelines:",
    resolvedLaunchMode === "new-user"
      ? "- Reuse the live tmux window but create a new user instead of reusing saved credentials."
      : "- Reuse the existing live tmux session and character instead of creating a new session.",
    "- Inspect the pane before sending commands so prompts and state are not skipped blindly.",
    "- Keep actions reversible and low-risk unless the user explicitly asks for a specific gameplay choice.",
    "- Follow the objective if one is set.",
    "- After startup, continue taking safe routine actions on your own; do not pause after the first summary.",
    "- Only stop and wait if you hit a real blocker, a risky or irreversible choice, or you need information the workspace does not provide.",
    "Important workflow:",
    guideInstructions,
    "- For non-UTF-8 sessions, prefer ./scripts/tmux-pane-send.sh over raw tmux send-keys when the client mangles input.",
    `- Helper scripts: ${helperScripts}`,
    "Launch workflow:",
    launchInstructions,
    "Start now: briefly assess the state, take the next safe action, and keep going until blocked."
  ]
    .filter(Boolean)
    .join("\n\n"),
    objective
  );
}

async function testAgentDefinition(agentDefinition) {
  try {
    const detectArgs = Array.isArray(agentDefinition.detectArgs) ? agentDefinition.detectArgs : ["--version"];
    const { stdout, stderr } = await run(agentDefinition.command, detectArgs, {
      cwd: resolveWorkingDirectory(agentDefinition.workingDirectory),
      env: {
        ...process.env,
        ...(agentDefinition.env || {})
      }
    });
    return {
      available: true,
      command: agentDefinition.command,
      detail: String(stdout || stderr).trim().split("\n").slice(0, 3).join("\n")
    };
  } catch (error) {
    const unavailableCodes = new Set(["ENOENT", "EACCES"]);
    if (error.code && !unavailableCodes.has(error.code)) {
      return {
        available: true,
        command: agentDefinition.command,
        detail: error.message
      };
    }

    return {
      available: false,
      command: agentDefinition.command,
      detail: error.message
    };
  }
}

async function startAgentRun({ agentId, agentProfileId, serverId, target, prompt, launchMode, loginProfileId, objective }) {
  if (!agentId) {
    throw createError("agentId is required", "MISSING_AGENT_ID", 400);
  }

  if (!target) {
    throw createError("target is required", "MISSING_TARGET", 400);
  }

  const agentDefinition = await loadAgentDefinitionById(agentId);
  const server = serverId ? await loadServerById(serverId).catch(() => null) : null;
  const session = await describeSession(target, serverId);
  const resolvedLaunchMode = normalizeLaunchMode(launchMode);
  const loginProfile =
    resolvedLaunchMode === "existing-login" && server?.id
      ? await loadLoginProfileById(server.id, loginProfileId).catch(() => null)
      : null;
  const resolvedPrompt =
    typeof prompt === "string" && prompt.trim()
      ? injectAgentObjective(prompt, objective)
      : await buildAgentPrompt({
          agentDefinition,
          server,
          session,
          target,
          launchMode: resolvedLaunchMode,
          loginProfile,
          objective
        });

  const { args, selectedProfile } = await loadResolvedAgentArgs(agentDefinition, {
    interactive: false,
    profileId: agentProfileId
  });
  const child = spawn(agentDefinition.command, args, {
    cwd: resolveWorkingDirectory(agentDefinition.workingDirectory),
    env: {
      ...process.env,
      ...(agentDefinition.env || {})
    },
    stdio: ["pipe", "pipe", "pipe"]
  });

  const run = {
    id: `run-${nextAgentRunId++}`,
    agentId: agentDefinition.id,
    agentName: agentDefinition.name,
    agentProfileId: selectedProfile?.id || "default",
    agentProfileLabel: selectedProfile?.label || selectedProfile?.id || "default",
    serverId: serverId || session.serverId,
    target,
    status: AGENT_RUN_STATUSES.RUNNING,
    process: child,
    pid: child.pid,
    startedAt: new Date().toISOString(),
    stoppedAt: null,
    exitCode: null,
    command: agentDefinition.command,
    args,
    output: agentDefinition.outputFormat === "codex_exec_jsonl" ? formatPromptTranscript(resolvedPrompt) : "",
    prompt: resolvedPrompt,
    stdoutBuffer: ""
  };

  agentRuns.set(run.id, run);
  pruneAgentRuns();
  emitAgentEvent(run.id, "agent-status", {
    run: summarizeRun(run)
  });

  if (agentDefinition.outputFormat === "codex_exec_jsonl") {
    child.stdout.on("data", (chunk) => handleCodexJsonStdout(run, chunk));
  } else {
    child.stdout.on("data", (chunk) => emitAgentOutput(run, "stdout", chunk.toString("utf8")));
  }
  child.stderr.on("data", (chunk) => {
    const textChunk = chunk.toString("utf8");
    if (agentDefinition.outputFormat === "codex_exec_jsonl" && isIgnorableCodexText(textChunk)) {
      return;
    }
    emitAgentOutput(run, "stderr", textChunk);
  });

  child.on("error", (error) => {
    run.status = AGENT_RUN_STATUSES.ERROR;
    run.stoppedAt = new Date().toISOString();
    run.exitCode = null;
    emitAgentEvent(run.id, "agent-output", {
      runId: run.id,
      stream: "stderr",
      text: `${error.message}\n`
    });
    emitAgentEvent(run.id, "agent-status", {
      run: summarizeRun(run)
    });
    pruneAgentRuns();
  });

  child.on("close", (code) => {
    if (agentDefinition.outputFormat === "codex_exec_jsonl") {
      flushAgentStdoutBuffer(run);
    }
    run.status = code === 0 ? AGENT_RUN_STATUSES.STOPPED : AGENT_RUN_STATUSES.ERROR;
    run.stoppedAt = new Date().toISOString();
    run.exitCode = code;
    emitAgentEvent(run.id, "agent-status", {
      run: summarizeRun(run)
    });
    pruneAgentRuns();
  });

  if (agentDefinition.promptToStdin !== false && child.stdin.writable) {
    child.stdin.write(resolvedPrompt);
    if (!resolvedPrompt.endsWith("\n")) {
      child.stdin.write("\n");
    }
    child.stdin.end();
  }

  return summarizeRun(run);
}

async function stopAgentRun(runId) {
  const run = agentRuns.get(runId);
  if (!run) {
    throw createError(`Unknown agent run id: ${runId}`, "AGENT_RUN_NOT_FOUND", 404, {
      runId
    });
  }

  if (!run.process || run.process.killed || run.status !== AGENT_RUN_STATUSES.RUNNING) {
    return summarizeRun(run);
  }

  run.status = AGENT_RUN_STATUSES.STOPPING;
  emitAgentEvent(run.id, "agent-status", {
    run: summarizeRun(run)
  });

  run.process.kill("SIGTERM");
  setTimeout(() => {
    if (run.process && !run.process.killed && run.status === AGENT_RUN_STATUSES.STOPPING) {
      run.process.kill("SIGKILL");
    }
  }, 2000).unref();

  return summarizeRun(run);
}

function handleEventStream(request, response, url) {
  const target = url.searchParams.get("target") || "";
  const agentRunId = url.searchParams.get("agentRunId") || "";
  const agentTarget = url.searchParams.get("agentTarget") || "";
  const intervalMs = Math.max(500, Number(url.searchParams.get("intervalMs") || 1000));
  const clientId = nextStreamClientId++;

  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    Connection: "keep-alive"
  });

  let lastPaneOutput = "";
  let lastAgentPaneOutput = "";
  let closed = false;

  sendSse(response, "connected", {
    clientId,
    target,
    agentRunId,
    agentTarget
  });

  if (agentRunId && agentRuns.has(agentRunId)) {
    const run = agentRuns.get(agentRunId);
    if (run.output) {
      sendSse(response, "agent-output", {
        runId: run.id,
        stream: "buffered",
        text: run.output
      });
    }
    sendSse(response, "agent-status", {
      run: summarizeRun(run)
    });
  }

  const paneInterval = target
    ? setInterval(async () => {
        try {
          const output = await capturePane(target, 220, {
            includeAnsi: true
          });
          if (output !== lastPaneOutput) {
            lastPaneOutput = output;
            sendSse(response, "pane-output", {
              target,
              output
            });
          }
        } catch (error) {
          sendSse(response, "stream-error", {
            target,
            code: error.code || "STREAM_CAPTURE_ERROR",
            error: error.message
          });
        }
      }, intervalMs)
    : null;

  const agentPaneInterval = agentTarget
    ? setInterval(async () => {
        try {
          const output = await capturePane(agentTarget, 220, {
            includeAnsi: true
          });
          if (output !== lastAgentPaneOutput) {
            lastAgentPaneOutput = output;
            sendSse(response, "agent-pane-output", {
              target: agentTarget,
              output
            });
          }
        } catch (error) {
          sendSse(response, "stream-error", {
            target: agentTarget,
            code: error.code || "STREAM_CAPTURE_ERROR",
            error: error.message
          });
        }
      }, intervalMs)
    : null;

  const keepAlive = setInterval(() => {
    sendSse(response, "ping", {
      now: Date.now()
    });
  }, 15000);

  const agentListener = agentRunId
    ? ({ runId, event, payload }) => {
        if (runId !== agentRunId) {
          return;
        }
        sendSse(response, event, payload);
      }
    : null;

  if (agentListener) {
    agentEventBus.on("event", agentListener);
  }

  const cleanup = () => {
    if (closed) {
      return;
    }
    closed = true;
    if (paneInterval) {
      clearInterval(paneInterval);
    }
    if (agentPaneInterval) {
      clearInterval(agentPaneInterval);
    }
    clearInterval(keepAlive);
    if (agentListener) {
      agentEventBus.off("event", agentListener);
    }
    response.end();
  };

  request.on("close", cleanup);
}

async function handleApi(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/health") {
    return json(response, 200, {
      ok: true,
      bindHost: DEFAULT_BIND_HOST,
      port: Number(process.env.PORT || DEFAULT_PORT),
      repoRoot
    });
  }

  if (request.method === "GET" && url.pathname === "/api/events") {
    handleEventStream(request, response, url);
    return true;
  }

  if (request.method === "GET" && url.pathname === "/api/servers") {
    const servers = await loadServers();
    return json(response, 200, {
      servers: servers.map((server) => ({
        ...server,
        supportsLoginProfiles: true,
        supportsScriptedLogin: Boolean(server.loginCommand)
      }))
    });
  }

  if (request.method === "POST" && url.pathname === "/api/servers") {
    const server = await withWriteLock(async () => {
      const body = await readJsonBody(request);
      const [customServers, allServers] = await Promise.all([loadCustomServers(), loadServers()]);
      const normalized = validateServerPayload(body);

      if (allServers.some((entry) => entry.id === normalized.id)) {
        throw createError(`Server id already exists: ${normalized.id}`, "SERVER_ID_CONFLICT", 409, {
          serverId: normalized.id
        });
      }

      customServers.push(normalized);
      await saveCustomServers(customServers);
      return normalized;
    });

    return json(response, 201, { server });
  }

  const serverMatch = url.pathname.match(/^\/api\/servers\/([^/]+)$/);
  const serverLoginProfilesMatch = url.pathname.match(/^\/api\/servers\/([^/]+)\/login-profiles$/);
  if (serverLoginProfilesMatch && request.method === "GET") {
    const serverId = decodeURIComponent(serverLoginProfilesMatch[1]);
    const server = await loadServerById(serverId);
    const profileState = await loadLoginProfilesByServerId(serverId);
    return json(response, 200, {
      serverId,
      serverName: server.name,
      supportsScriptedLogin: Boolean(server.loginCommand),
      defaultProfileId: profileState.defaultProfileId,
      profiles: profileState.profiles
    });
  }

  if (serverLoginProfilesMatch && request.method === "PUT") {
    const serverId = decodeURIComponent(serverLoginProfilesMatch[1]);
    await loadServerById(serverId);
    const body = await readJsonBody(request);
    const profileState = await saveLoginProfilesByServerId(serverId, {
      defaultProfileId: body.defaultProfileId,
      profiles: Array.isArray(body.profiles) ? body.profiles : []
    });
    return json(response, 200, {
      serverId,
      defaultProfileId: profileState.defaultProfileId,
      profiles: profileState.profiles
    });
  }

  if (serverMatch && request.method === "PUT") {
    const server = await withWriteLock(async () => {
      const serverId = decodeURIComponent(serverMatch[1]);
      const [customServers, builtInServers, localState] = await Promise.all([
        loadCustomServers(),
        loadBuiltInServers(),
        loadLocalServerState()
      ]);
      const customIndex = customServers.findIndex((entry) => entry.id === serverId);
      const builtInServer = builtInServers.find((entry) => entry.id === serverId) || null;
      if (customIndex === -1 && !builtInServer) {
        throw createError(`Unknown server id: ${serverId}`, "SERVER_NOT_FOUND", 404, {
          serverId
        });
      }
      const body = await readJsonBody(request);
      const baseServer = customIndex !== -1 ? customServers[customIndex] : builtInServer;
      const normalized = validateServerPayload({ ...baseServer, ...body, id: serverId }, {
        existingId: serverId
      });
      if (customIndex !== -1) {
        customServers[customIndex] = normalized;
      } else {
        customServers.push(normalized);
      }

      await saveLocalServerState({
        servers: customServers,
        removedBuiltInServerIds: localState.removedBuiltInServerIds.filter((entry) => entry !== serverId)
      });

      return {
        ...(builtInServer || {}),
        ...normalized,
        isBuiltIn: Boolean(builtInServer)
      };
    });

    return json(response, 200, { server });
  }

  if (serverMatch && request.method === "DELETE") {
    const server = await withWriteLock(async () => {
      const serverId = decodeURIComponent(serverMatch[1]);
      const [customServers, builtInServers, localState] = await Promise.all([
        loadCustomServers(),
        loadBuiltInServers(),
        loadLocalServerState()
      ]);
      const builtInServer = builtInServers.find((entry) => entry.id === serverId) || null;
      const nextCustomServers = customServers.filter((entry) => entry.id !== serverId);

      if (builtInServer) {
        await saveLocalServerState({
          servers: nextCustomServers,
          removedBuiltInServerIds: [...new Set([...localState.removedBuiltInServerIds, serverId])]
        });
        return {
          ...builtInServer,
          isBuiltIn: true
        };
      }

      const removed = customServers.find((entry) => entry.id === serverId) || null;
      if (!removed) {
        throw createError(`Unknown server id: ${serverId}`, "SERVER_NOT_FOUND", 404, {
          serverId
        });
      }

      await saveLocalServerState({
        servers: nextCustomServers,
        removedBuiltInServerIds: localState.removedBuiltInServerIds
      });
      return removed;
    });

    return json(response, 200, {
      ok: true,
      server
    });
  }

  if (request.method === "GET" && url.pathname === "/api/tmux/sessions") {
    const sessions = await listTmuxSessions();
    return json(response, 200, { sessions });
  }

  if (request.method === "GET" && url.pathname === "/api/tmux/windows") {
    const target = url.searchParams.get("target") || "0";
    const windows = await listTmuxWindows(target);
    return json(response, 200, { target, windows });
  }

  if (request.method === "GET" && url.pathname === "/api/sessions") {
    const servers = await loadServers();
    const sessions = [];

    for (const server of servers) {
      try {
        const windows = await listTmuxWindows(server.tmuxSession || "0");
        const match = windows.find((window) => getWindowNames(server).includes(window.windowName));
        if (match) {
          sessions.push({
            id: match.target,
            target: match.target,
            serverId: server.id,
            tmuxSession: server.tmuxSession || "0",
            windowName: match.windowName,
            canonicalWindowName: server.windowName,
            encoding: normalizeEncoding(server.encoding),
            sendMode: server.sendMode
          });
        }
      } catch (error) {
        console.error(`Skipping session discovery for server ${server.id}: ${error.message}`);
      }
    }

    return json(response, 200, { sessions });
  }

  if (request.method === "POST" && url.pathname === "/api/sessions") {
    const body = await readJsonBody(request);
    if (!body.serverId) {
      throw createError("serverId is required", "MISSING_SERVER_ID", 400);
    }

    const server = await loadServerById(body.serverId);
    const tmuxSession = String(body.tmuxSession || server.tmuxSession || "0");
    await ensureTmuxSession(tmuxSession);
    const session = await createOrReuseWindow(server, tmuxSession);
    return json(response, 201, session);
  }

  if (request.method === "POST" && url.pathname === "/api/sessions/login") {
    const body = await readJsonBody(request);
    if (!body.serverId) {
      throw createError("serverId is required", "MISSING_SERVER_ID", 400);
    }

    const server = await loadServerById(body.serverId);
    if (!server.loginCommand) {
      throw createError(`No login command configured for ${server.id}`, "LOGIN_NOT_SUPPORTED", 400, {
        serverId: server.id
      });
    }

    const target = body.target || `${body.tmuxSession || server.tmuxSession || "0"}:${server.windowName}`;
    const profile = await loadLoginProfileById(server.id, body.profileId);
    const loginCommand = resolveScript(server.loginCommand);
    const { stdout, stderr } = await run(loginCommand, [target, profile.id], {
      env: {
        ...process.env,
        MUD_LOGIN_PROFILE_ID: profile.id,
        MUD_LOGIN_PROFILE_LABEL: profile.label,
        MUD_LOGIN_USERNAME: profile.username,
        MUD_LOGIN_PASSWORD: profile.password,
        MUD_LOGIN_CONFIRM_EXISTING_LOGIN: profile.confirmExistingLogin || ""
      }
    });
    return json(response, 200, {
      ok: true,
      target,
      profileId: profile.id,
      profileLabel: profile.label,
      recommendedRefreshDelayMs: Number(server.loginWaitMs || 1500),
      stdout: stdout.trim(),
      stderr: stderr.trim()
    });
  }

  const outputMatch = url.pathname.match(/^\/api\/sessions\/(.+)\/output$/);
  if (request.method === "GET" && outputMatch) {
    const target = decodeURIComponent(outputMatch[1]);
    const lines = Number(url.searchParams.get("lines") || 200);
    const output = await capturePane(target, lines, {
      includeAnsi: true
    });
    const session = await describeSession(target, url.searchParams.get("serverId"));
    return json(response, 200, {
      session,
      lines,
      output
    });
  }

  const sendMatch = url.pathname.match(/^\/api\/sessions\/(.+)\/send$/);
  if (request.method === "POST" && sendMatch) {
    const target = decodeURIComponent(sendMatch[1]);
    const body = await readJsonBody(request);
    const session = await describeSession(target, body.serverId);
    const encoding = normalizeEncoding(body.encoding || session.encoding);

    if (Array.isArray(body.keys) && body.keys.length > 0) {
      await sendRawKeysViaTmux(target, body.keys.map((value) => String(value)));
      return json(response, 200, {
        ok: true,
        target,
        sendMode: SEND_MODES.TMUX_KEYS,
        encoding
      });
    }

    if (typeof body.text !== "string" || body.text.length === 0) {
      throw createError("text or keys is required", "MISSING_TEXT", 400);
    }

    if (body.raw) {
      await sendViaPaneTty(target, body.text, encoding, {
        appendEnter: false
      });
      return json(response, 200, {
        ok: true,
        target,
        sendMode: SEND_MODES.PANE_TTY,
        encoding,
        raw: true
      });
    }

    const sendMode =
      body.sendMode ||
      (encoding !== "UTF-8" ? SEND_MODES.PANE_TTY : session.sendMode || SEND_MODES.TMUX_KEYS);

    if (sendMode === SEND_MODES.PANE_TTY) {
      await sendViaPaneTty(target, body.text, encoding);
    } else {
      await sendViaTmuxKeys(target, body.text);
    }

    return json(response, 200, {
      ok: true,
      target,
      sendMode,
      encoding
    });
  }

  if (request.method === "GET" && url.pathname === "/api/agents") {
    const agents = await loadAgentDefinitions();
    return json(response, 200, {
      agents: agents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        type: agent.type,
        command: agent.command,
        args: agent.args || [],
        isBuiltIn: agent.isBuiltIn !== false,
        promptToStdin: agent.promptToStdin !== false,
        workingDirectory: agent.workingDirectory || ".",
        interactiveTmux: supportsInteractiveTmux(agent),
        interactiveCommand: agent.interactiveCommand || "",
        interactiveArgs: Array.isArray(agent.interactiveArgs) ? agent.interactiveArgs : [],
        interactiveWindowName: agent.interactiveWindowName || "",
        interactiveTmuxSession: agent.interactiveTmuxSession || "0",
        notes: agent.notes || ""
      }))
    });
  }

  if (request.method === "GET" && url.pathname === "/api/agent-sessions") {
    const sessions = await listInteractiveAgentSessions();
    return json(response, 200, {
      sessions
    });
  }

  if (request.method === "POST" && url.pathname === "/api/agent-sessions") {
    const body = await readJsonBody(request);
    if (!body.agentId) {
      throw createError("agentId is required", "MISSING_AGENT_ID", 400);
    }

    const agentDefinition = await loadAgentDefinitionById(body.agentId);
    const agentProfileId = String(body.agentProfileId || "").trim() || "default";
    const interactiveSession = await createOrReuseInteractiveAgentWindow(agentDefinition, agentProfileId);
    const serverId = String(body.serverId || "").trim();
    const server = serverId ? await loadServerById(serverId).catch(() => null) : null;
    const target =
      typeof body.target === "string" && body.target.trim()
        ? body.target.trim()
        : defaultTargetForServer(server);
    const launchMode = normalizeLaunchMode(body.launchMode);
    const loginProfileId = String(body.loginProfileId || body.profileId || "").trim();
    const objective = normalizeAgentObjective(body.objective);

    if (isOpenClawInteractiveAgent(agentDefinition)) {
      if (!target) {
        throw createError("target is required", "MISSING_TARGET", 400);
      }

      const mudSession = await describeSession(target, serverId);
      const loginProfile =
        launchMode === "existing-login" && server?.id
          ? await loadLoginProfileById(server.id, loginProfileId).catch(() => null)
          : null;
      const prompt =
        typeof body.prompt === "string" && body.prompt.trim()
          ? injectAgentObjective(body.prompt, objective)
          : await buildAgentPrompt({
              agentDefinition,
              server,
              session: mudSession,
              target,
              launchMode,
              loginProfile,
              objective
            });

      await startOpenClawAutoplayWorker({
        agentDefinition,
        interactiveTarget: interactiveSession.target,
        mudTarget: target,
        serverId,
        launchMode,
        loginProfileId,
        prompt
      });

      return json(response, 201, {
        session: summarizeInteractiveAgentSession(
          agentDefinition,
          interactiveSession.target,
          interactiveSession.tmuxSession,
          interactiveSession.reused,
          {
            id: interactiveSession.agentProfileId,
            label: interactiveSession.agentProfileLabel
          }
        )
      });
    }

    if (typeof body.prompt === "string" && body.prompt.trim()) {
      await sendInteractivePrompt(agentDefinition, interactiveSession.target, body.prompt);
    }
    return json(response, 201, {
      session: interactiveSession
    });
  }

  const agentSessionMatch = url.pathname.match(/^\/api\/agent-sessions\/([^/]+)$/);
  if (agentSessionMatch && request.method === "GET") {
    const agentId = decodeURIComponent(agentSessionMatch[1]);
    const session = await loadInteractiveAgentSessionByAgentId(agentId);
    return json(response, 200, {
      session
    });
  }

  const agentSessionSendMatch = url.pathname.match(/^\/api\/agent-sessions\/([^/]+)\/send$/);
  if (agentSessionSendMatch && request.method === "POST") {
    const agentId = decodeURIComponent(agentSessionSendMatch[1]);
    const session = await loadInteractiveAgentSessionByAgentId(agentId);
    const body = await readJsonBody(request);
    const encoding = normalizeEncoding(body.encoding || "UTF-8");
    const autoplayStop = await stopOpenClawAutoplayForInteractiveTarget(
      session.target,
      "Manual terminal input stopped autoplay."
    );

    if (Array.isArray(body.keys) && body.keys.length > 0) {
      await sendRawKeysViaTmux(session.target, body.keys.map((value) => String(value)));
    } else if (body.raw && typeof body.text === "string" && body.text.length > 0) {
      await sendViaPaneTty(session.target, body.text, encoding, {
        appendEnter: false
      });
    } else if (typeof body.text === "string" && body.text.length > 0) {
      await sendLiteralViaTmux(session.target, body.text);
    } else {
      throw createError("text or keys is required", "MISSING_TEXT", 400);
    }

    return json(response, 200, {
      ok: true,
      session: summarizeInteractiveAgentSession(
        await loadAgentDefinitionById(agentId),
        session.target,
        session.tmuxSession,
        true,
        {
          id: session.agentProfileId,
          label: session.agentProfileLabel
        }
      ),
      autoplayStop
    });
  }

  const agentSessionStopMatch = url.pathname.match(/^\/api\/agent-sessions\/([^/]+)\/stop$/);
  if (agentSessionStopMatch && request.method === "POST") {
    const agentId = decodeURIComponent(agentSessionStopMatch[1]);
    const agentDefinition = await loadAgentDefinitionById(agentId);
    const session = await loadInteractiveAgentSessionByAgentId(agentId);
    const paneProcess = await inspectTmuxPaneProcess(session.target);
    const backendStop = await stopInteractiveAgentExecution(agentDefinition, {
      reason: "Stopped interactive agent.",
      panePid: paneProcess.panePid
    });
    await killTmuxWindow(session.target).catch((error) => {
      if (!isMissingTmuxTargetError(error)) {
        throw error;
      }
    });
    interactiveAgentRuntimeProfiles.delete(session.target);
    interactiveAgentRuntimeProfiles.delete(agentId);
    return json(response, 200, {
      ok: true,
      backendStop,
      session: {
        ...session,
        status: "stopped"
      }
    });
  }

  const agentProfilesMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/profiles$/);
  const agentTestMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/test$/);
  const agentPromptMatch = url.pathname.match(/^\/api\/agents\/([^/]+)\/prompt-preview$/);
  if (agentProfilesMatch && request.method === "GET") {
    const agentId = decodeURIComponent(agentProfilesMatch[1]);
    const agentDefinition = await loadAgentDefinitionById(agentId);
    const runtimeProfiles = await loadAgentRuntimeProfiles(agentDefinition);
    return json(response, 200, {
      agentId,
      defaultProfileId: runtimeProfiles.defaultProfileId,
      profileFlag: runtimeProfiles.profileFlag,
      profiles: runtimeProfiles.profiles
    });
  }

  if (agentPromptMatch && request.method === "GET") {
    const agentId = decodeURIComponent(agentPromptMatch[1]);
    const agentDefinition = await loadAgentDefinitionById(agentId);
    const serverId = url.searchParams.get("serverId");
    const server = serverId ? await loadServerById(serverId).catch(() => null) : null;
    const target = url.searchParams.get("target") || defaultTargetForServer(server);
    const launchMode = normalizeLaunchMode(url.searchParams.get("launchMode"));
    const loginProfileId = url.searchParams.get("profileId") || "";
    const objective = normalizeAgentObjective(url.searchParams.get("objective"));

    if (!target) {
      throw createError("target or serverId with a windowName is required", "MISSING_TARGET", 400);
    }

    const session = await describeSession(target, serverId).catch(() => ({
      id: target,
      target,
      serverId: server?.id ?? null,
      encoding: normalizeEncoding(server?.encoding || "UTF-8"),
      sendMode: server?.sendMode || SEND_MODES.TMUX_KEYS
    }));
    const loginProfile =
      launchMode === "existing-login" && server?.id
        ? await loadLoginProfileById(server.id, loginProfileId).catch(() => null)
        : null;
    const prompt = await buildAgentPrompt({
      agentDefinition,
      server,
      session,
      target,
      launchMode,
      loginProfile,
      objective
    });

    return json(response, 200, {
      agentId,
      serverId: server?.id || session.serverId,
      target,
      launchMode,
      profileId: loginProfile?.id || "",
      prompt
    });
  }

  if (agentTestMatch && request.method === "POST") {
    const agentId = decodeURIComponent(agentTestMatch[1]);
    const agent = await loadAgentDefinitionById(agentId);
    const result = await testAgentDefinition(agent);
    return json(response, 200, {
      agentId,
      ...result
    });
  }

  if (request.method === "POST" && url.pathname === "/api/agent-runs") {
    const body = await readJsonBody(request);
    const run = await startAgentRun(body);
    return json(response, 201, {
      run
    });
  }

  if (request.method === "GET" && url.pathname === "/api/agent-runs") {
    return json(response, 200, {
      runs: [...agentRuns.values()].map((run) => summarizeRun(run))
    });
  }

  const agentRunMatch = url.pathname.match(/^\/api\/agent-runs\/([^/]+)$/);
  if (agentRunMatch && request.method === "GET") {
    const runId = decodeURIComponent(agentRunMatch[1]);
    const run = agentRuns.get(runId);
    if (!run) {
      throw createError(`Unknown agent run id: ${runId}`, "AGENT_RUN_NOT_FOUND", 404, {
        runId
      });
    }
    return json(response, 200, {
      run: summarizeRun(run),
      output: run.output,
      prompt: run.prompt
    });
  }

  const stopMatch = url.pathname.match(/^\/api\/agent-runs\/([^/]+)\/stop$/);
  if (stopMatch && request.method === "POST") {
    const runId = decodeURIComponent(stopMatch[1]);
    const run = await stopAgentRun(runId);
    return json(response, 200, {
      run
    });
  }

  return false;
}

async function serveStatic(request, response, url) {
  if (xtermVendorAssets.has(url.pathname)) {
    const filePath = xtermVendorAssets.get(url.pathname);
    try {
      const content = await fs.readFile(filePath);
      text(response, 200, content, contentTypeForFilePath(filePath));
      return true;
    } catch {
      json(response, 404, {
        error: "Not found",
        code: "NOT_FOUND"
      });
      return true;
    }
  }

  const requestedPath = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = path.normalize(path.join(publicDir, requestedPath));

  if (!filePath.startsWith(publicDir)) {
    json(response, 403, {
      error: "Forbidden",
      code: "FORBIDDEN"
    });
    return true;
  }

  try {
    const content = await fs.readFile(filePath);
    text(response, 200, content, contentTypeForFilePath(filePath));
    return true;
  } catch {
    json(response, 404, {
      error: "Not found",
      code: "NOT_FOUND"
    });
    return true;
  }
}

function sendWebSocketMessage(socket, payload) {
  if (socket.readyState !== 1) {
    return;
  }
  socket.send(JSON.stringify(payload));
}

async function handleTerminalWebSocket(socket, request, url) {
  const target = url.searchParams.get("target");
  const serverId = url.searchParams.get("serverId") || "";
  const requestedEncoding = url.searchParams.get("encoding");
  const intervalMs = clampNumber(url.searchParams.get("intervalMs"), 50, 1000, 100);
  const lines = clampNumber(url.searchParams.get("lines"), 40, 400, 220);

  if (!target) {
    throw createError("target is required", "MISSING_TARGET", 400);
  }

  const session = await describeSession(target, serverId);
  if (requestedEncoding) {
    session.encoding = normalizeEncoding(requestedEncoding);
  }

  let closed = false;
  let captureTimer = null;
  let captureInFlight = false;
  let lastOutput = "";

  const clearCaptureTimer = () => {
    if (captureTimer) {
      clearTimeout(captureTimer);
      captureTimer = null;
    }
  };

  const cleanup = () => {
    if (closed) {
      return;
    }
    closed = true;
    clearCaptureTimer();
  };

  const scheduleCapture = (delayMs = intervalMs) => {
    if (closed) {
      return;
    }
    clearCaptureTimer();
    captureTimer = setTimeout(runCapture, delayMs);
  };

  const runCapture = async (force = false) => {
    if (closed || captureInFlight) {
      return;
    }

    captureInFlight = true;
    try {
      const output = await capturePane(target, lines, {
        includeAnsi: true
      });
      if (force || output !== lastOutput) {
        lastOutput = output;
        sendWebSocketMessage(socket, {
          type: "snapshot",
          target,
          output
        });
      }
    } catch (error) {
      sendWebSocketMessage(socket, {
        type: "error",
        target,
        code: error.code || "STREAM_CAPTURE_ERROR",
        error: error.message
      });
    } finally {
      captureInFlight = false;
      if (!closed) {
        scheduleCapture();
      }
    }
  };

  socket.on("close", cleanup);
  socket.on("error", cleanup);
  socket.on("message", async (rawMessage, isBinary) => {
    if (closed) {
      return;
    }

    try {
      if (isBinary) {
        throw createError("Binary WebSocket frames are not supported", "INVALID_MESSAGE", 400);
      }

      const payload = JSON.parse(String(rawMessage || ""));
      if (!payload || typeof payload !== "object") {
        throw createError("Invalid WebSocket message", "INVALID_MESSAGE", 400);
      }

      if (payload.type === "data") {
        const autoplayStop = await stopOpenClawAutoplayForInteractiveTarget(
          target,
          "Manual terminal input stopped autoplay."
        );
        const result = await sendTerminalData(target, session, payload.data);
        sendWebSocketMessage(socket, {
          type: "ack",
          action: "data",
          ...result,
          autoplayStop
        });
        return;
      }

      if (payload.type === "keys") {
        if (!Array.isArray(payload.keys) || payload.keys.length === 0) {
          throw createError("keys must be a non-empty array", "INVALID_MESSAGE", 400);
        }
        const autoplayStop = await stopOpenClawAutoplayForInteractiveTarget(
          target,
          "Manual terminal input stopped autoplay."
        );
        await sendRawKeysViaTmux(target, payload.keys.map((value) => String(value)));
        sendWebSocketMessage(socket, {
          type: "ack",
          action: "keys",
          ok: true,
          target,
          autoplayStop
        });
        return;
      }

      if (payload.type === "resize") {
        await resizeTmuxPane(target, payload.cols, payload.rows);
        sendWebSocketMessage(socket, {
          type: "ack",
          action: "resize",
          ok: true,
          target,
          cols: clampNumber(payload.cols, 20, 500, 80),
          rows: clampNumber(payload.rows, 5, 200, 24)
        });
        scheduleCapture(10);
        return;
      }

      if (payload.type === "refresh") {
        await runCapture(true);
        return;
      }

      throw createError(`Unsupported message type: ${payload.type || "(missing type)"}`, "INVALID_MESSAGE", 400);
    } catch (error) {
      sendWebSocketMessage(socket, {
        type: "error",
        target,
        code: error.code || "INVALID_MESSAGE",
        error: error.message
      });
    }
  });

  sendWebSocketMessage(socket, {
    type: "ready",
    target,
    session
  });
  await runCapture(true);
}

const server = http.createServer(async (request, response) => {
  setCorsHeaders(request, response);
  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  const hostHeader = request.headers.host || "";
  if (!isLocalHostHeader(hostHeader)) {
    return json(response, 403, {
      error: "Local access only",
      code: "LOCAL_ACCESS_ONLY"
    });
  }

  const url = new URL(request.url || "/", `http://${request.headers.host || "127.0.0.1"}`);

  try {
    const handled = await handleApi(request, response, url);
    if (handled !== false) {
      return;
    }

    await serveStatic(request, response, url);
  } catch (error) {
    return json(response, Number(error.statusCode) || 500, {
      error: error.message,
      code: error.code || "INTERNAL_ERROR",
      details: error.details
    });
  }
});

const terminalSocketServer = new WebSocketServer({
  noServer: true
});

terminalSocketServer.on("connection", (socket, request) => {
  const url = new URL(request.url || "/ws/terminal", `http://${request.headers.host || "127.0.0.1"}`);
  handleTerminalWebSocket(socket, request, url).catch((error) => {
    sendWebSocketMessage(socket, {
      type: "error",
      code: error.code || "INTERNAL_ERROR",
      error: error.message
    });
    socket.close(1011, "Terminal setup failed");
  });
});

server.on("upgrade", (request, socket, head) => {
  const hostHeader = request.headers.host || "";
  if (!isLocalHostHeader(hostHeader)) {
    socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
    socket.destroy();
    return;
  }

  const url = new URL(request.url || "/", `http://${hostHeader || "127.0.0.1"}`);
  if (url.pathname !== "/ws/terminal") {
    socket.destroy();
    return;
  }

  terminalSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
    terminalSocketServer.emit("connection", webSocket, request);
  });
});

const port = Number(process.env.PORT || DEFAULT_PORT);
server.listen(port, DEFAULT_BIND_HOST, () => {
  console.log(`mud-agent server listening on http://${DEFAULT_BIND_HOST}:${port}`);
});
