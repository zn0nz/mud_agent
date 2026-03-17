#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(__filename), "..");
const secretsPath = path.join(rootDir, "config", "local.secrets.json");

function parseArgs(argv) {
  const options = {
    serverId: "",
    profileId: "",
    label: "",
    username: "",
    password: "",
    confirmExistingLogin: "",
    makeDefault: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--server") {
      options.serverId = argv[++index] || "";
    } else if (arg === "--profile-id") {
      options.profileId = argv[++index] || "";
    } else if (arg === "--label") {
      options.label = argv[++index] || "";
    } else if (arg === "--username") {
      options.username = argv[++index] || "";
    } else if (arg === "--password") {
      options.password = argv[++index] || "";
    } else if (arg === "--confirm-existing-login") {
      options.confirmExistingLogin = argv[++index] || "";
    } else if (arg === "--make-default") {
      options.makeDefault = true;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!options.serverId || !options.profileId || !options.label || !options.username || !options.password) {
    throw new Error("Missing required arguments.");
  }

  return options;
}

function printUsage() {
  console.log(`Usage:
  node scripts/save-login-profile.mjs \\
    --server custom-mud \\
    --profile-id main \\
    --label "Main" \\
    --username myuser \\
    --password secret \\
    [--make-default]
`);
}

function sanitizeProfileId(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "profile";
}

function readSecrets() {
  if (!fs.existsSync(secretsPath)) {
    return {};
  }

  return JSON.parse(fs.readFileSync(secretsPath, "utf8"));
}

function writeSecrets(secrets) {
  fs.writeFileSync(secretsPath, `${JSON.stringify(secrets, null, 2)}\n`, "utf8");
}

try {
  const options = parseArgs(process.argv.slice(2));
  const secrets = readSecrets();
  const serverId = String(options.serverId).trim();
  const profileId = sanitizeProfileId(options.profileId);
  const label = String(options.label).trim();
  const username = String(options.username).trim();
  const password = String(options.password);
  const confirmExistingLogin = String(options.confirmExistingLogin || "").trim();

  const existingServer = secrets[serverId] && typeof secrets[serverId] === "object" ? secrets[serverId] : {};
  const existingProfiles =
    existingServer.profiles && typeof existingServer.profiles === "object" ? existingServer.profiles : {};

  existingProfiles[profileId] = {
    ...(existingProfiles[profileId] || {}),
    label,
    username,
    password
  };

  if (confirmExistingLogin) {
    existingProfiles[profileId].confirm_existing_login = confirmExistingLogin;
  } else {
    delete existingProfiles[profileId].confirm_existing_login;
  }

  secrets[serverId] = {
    ...existingServer,
    profiles: existingProfiles,
    defaultProfileId: options.makeDefault
      ? profileId
      : String(existingServer.defaultProfileId || "").trim() || profileId
  };

  writeSecrets(secrets);
  console.log(
    JSON.stringify(
      {
        ok: true,
        secretsPath,
        serverId,
        profileId,
        defaultProfileId: secrets[serverId].defaultProfileId
      },
      null,
      2
    )
  );
} catch (error) {
  console.error(error.message);
  printUsage();
  process.exit(1);
}
