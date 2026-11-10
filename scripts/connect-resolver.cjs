#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const { execFileSync } = require("node:child_process");

const request = JSON.parse(fs.readFileSync(0, "utf8"));

if (request.protocolVersion !== 1 || !Array.isArray(request.ids)) {
  process.exit(2);
}

const token = fs.readFileSync("/opt/op-connect/token", "utf8").trim();
if (!token || !process.env.OP_CONNECT_HOST) {
  process.stderr.write("Connect configuration unavailable\n");
  process.exit(1);
}

const env = {
  PATH: process.env.PATH || "/usr/local/bin:/usr/bin:/bin",
  OP_CONNECT_HOST: process.env.OP_CONNECT_HOST,
  OP_CONNECT_TOKEN: token,
  OP_LOAD_DESKTOP_APP_SETTINGS: "false",
  OP_BIOMETRIC_UNLOCK_ENABLED: "false"
};

const values = {};
const errors = {};

for (const id of request.ids) {
  // Defense in depth: only Gateway-vault references.
  if (typeof id !== "string" ||
      !id.startsWith("op://OpenClaw-Gateway/")) {
    errors[id] = { code: "NOT_FOUND" };
    continue;
  }

  try {
    values[id] = execFileSync("/usr/bin/op", ["read", id], {
      encoding: "utf8",
      env,
      timeout: 8000,
      maxBuffer: 1048576
    }).replace(/\r?\n$/, "");
  } catch {
    errors[id] = { code: "RESOLUTION_FAILED" };
  }
}

process.stdout.write(
  JSON.stringify({ protocolVersion: 1, values, errors }) + "\n"
);
