#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const rootDir = path.resolve(path.dirname(__filename), "..");
const secretsPath = path.join(rootDir, "config", "local.secrets.json");
const keyPath = process.argv[2];

if (!keyPath) {
  console.error("Usage: read-local-secret.mjs <dot.path>");
  process.exit(2);
}

if (!fs.existsSync(secretsPath)) {
  process.exit(1);
}

let data;
try {
  data = JSON.parse(fs.readFileSync(secretsPath, "utf8"));
} catch (error) {
  console.error(`Failed to parse ${secretsPath}: ${error.message}`);
  process.exit(1);
}

let value = data;
for (const part of keyPath.split(".")) {
  if (value && Object.prototype.hasOwnProperty.call(value, part)) {
    value = value[part];
  } else {
    process.exit(1);
  }
}

if (value === undefined || value === null) {
  process.exit(1);
}

process.stdout.write(String(value));
