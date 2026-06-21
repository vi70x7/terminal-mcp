#!/usr/bin/env node

import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { PtydClient } from "./ptyd-client.js";
import { SessionManager } from "./session-manager.js";
import { registerTools } from "./tools.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(
  readFileSync(resolve(__dirname, "..", "package.json"), "utf8"),
);
const version = pkg.version;

const log = (msg) => process.stderr.write(`[smart-terminal-mcp] ${msg}\n`);

/**
 * Spawn the ptyd daemon and wait for its socket to appear.
 * @param {string} ptydBinary - Absolute path to the ptyd binary
 * @param {string} socketPath - Unix domain socket path for the daemon
 * @returns {Promise<{ daemon: import('node:child_process').ChildProcess, ptydClient: PtydClient }>}
 */
async function startPtyd(ptydBinary, socketPath) {
  const daemon = spawn(ptydBinary, ["--socket", socketPath], {
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
  });

  daemon.stdout?.on("data", (d) => process.stderr.write(`[ptyd:out] ${d}`));
  daemon.stderr?.on("data", (d) => process.stderr.write(`[ptyd:err] ${d}`));

  daemon.on("exit", (code, signal) => {
    log(`ptyd daemon exited (code=${code}, signal=${signal})`);
  });

  // Wait for the socket file to appear (poll every 100ms for up to 5s)
  const SOCKET_TIMEOUT_MS = 5000;
  const POLL_INTERVAL_MS = 100;
  const maxAttempts = SOCKET_TIMEOUT_MS / POLL_INTERVAL_MS;
  for (let i = 0; i < maxAttempts; i++) {
    if (existsSync(socketPath)) break;
    if (!daemon.killed && daemon.exitCode === null) {
      await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
    } else {
      throw new Error(
        `ptyd daemon exited before socket appeared (code=${daemon.exitCode})`,
      );
    }
  }

  if (!existsSync(socketPath)) {
    daemon.kill();
    throw new Error(
      `ptyd socket ${socketPath} did not appear within ${SOCKET_TIMEOUT_MS}ms`,
    );
  }

  const ptydClient = new PtydClient(socketPath);
  await ptydClient.connect();

  return { daemon, ptydClient };
}

/**
 * Shut down the ptyd daemon and clean up the socket.
 * @param {import('node:child_process').ChildProcess} daemon
 * @param {PtydClient} ptydClient
 * @param {string} socketPath
 */
async function stopPtyd(daemon, ptydClient, socketPath) {
  try {
    await ptydClient.shutdown();
  } catch {
    // shutdown command may fail if daemon is already gone
  }
  if (!daemon.killed) {
    daemon.kill();
  }
  try {
    unlinkSync(socketPath);
  } catch {
    // socket file may already be removed by the daemon
  }
}

export function createSandboxServer({ ptydClient } = {}) {
  const server = new McpServer({
    name: "smart-terminal-mcp",
    version,
  });
  const manager = new SessionManager({ ptydClient });
  registerTools(server, manager);
  return { server, manager };
}
export default createSandboxServer;

async function main() {
  const __root = resolve(__dirname, "..");
  const ptydBinary = resolve(__root, "ptyd", "build", "ptyd");

  const uid = typeof process.getuid === "function" ? process.getuid() : "node";
  const socketPath = `/tmp/ptyd-${uid}-${Date.now()}.sock`;

  log(`Spawning ptyd daemon: ${ptydBinary} --socket ${socketPath}`);
  const { daemon, ptydClient } = await startPtyd(ptydBinary, socketPath);
  log("ptyd daemon ready");

  const manager = new SessionManager({ ptydClient });
  const server = new McpServer({
    name: "smart-terminal-mcp",
    version,
  });
  registerTools(server, manager);

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    log("Shutting down, cleaning up sessions...");
    manager.destroyAll();
    await stopPtyd(daemon, ptydClient, socketPath);
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  process.on("exit", () => manager.destroyAll());

  // Daemon crash: log and exit
  daemon.on("exit", (code) => {
    if (!shuttingDown) {
      log(`ptyd daemon crashed (exit code ${code}), shutting down server`);
      manager.destroyAll();
      try {
        unlinkSync(socketPath);
      } catch {
        /* already gone */
      }
      process.exit(1);
    }
  });

  const transport = new StdioServerTransport();
  await server.connect(transport);

  log("Server started on stdio transport");
}

// Skip auto-start when imported by Smithery scanner or other bundlers
const scriptPath = (process.argv[1] || "").replace(/\\/g, "/");
const isScanning =
  Boolean(process.env.SMITHERY_SCAN) ||
  scriptPath.includes(".smithery") ||
  scriptPath.includes("/scan-");

if (!isScanning) {
  main().catch((err) => {
    process.stderr.write(
      `[smart-terminal-mcp] Fatal: ${err.message}\n${err.stack}\n`,
    );
    process.exit(1);
  });
}
