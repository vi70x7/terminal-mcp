#!/usr/bin/env node
// Smoke test for ptyd - sends JSON commands via Unix socket, validates responses
import net from "node:net";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const SOCKET = "/tmp/ptyd-1000.sock";
const BINARY = "./build/ptyd";

let id = 0;
function nextId() {
  return ++id;
}

function send(client, method, params) {
  return new Promise((resolve, reject) => {
    const reqId = nextId();
    const msg = JSON.stringify({ id: reqId, method, params }) + "\n";
    const handler = (data) => {
      try {
        const lines = data.toString().split("\n").filter(Boolean);
        for (const line of lines) {
          const msg = JSON.parse(line);
          if (msg.id === reqId) {
            client.off("data", handler);
            resolve(msg);
            return;
          }
        }
      } catch {
        // ignore partial JSON
      }
    };
    client.on("data", handler);
    setTimeout(() => {
      client.off("data", handler);
      reject(new Error("timeout waiting for response"));
    }, 5000).unref();
    client.write(msg);
  });
}

function waitForEvent(client, eventType, sessionId, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const handler = (data) => {
      try {
        const lines = data.toString().split("\n").filter(Boolean);
        for (const line of lines) {
          const msg = JSON.parse(line);
          if (msg.type === eventType && msg.sessionId === sessionId) {
            client.off("data", handler);
            resolve(msg);
            return;
          }
        }
      } catch {}
    };
    client.on("data", handler);
    setTimeout(() => {
      client.off("data", handler);
      reject(new Error(`timeout waiting for ${eventType} on ${sessionId}`));
    }, timeoutMs).unref();
  });
}

async function run() {
  console.log("=== PTYD SMOKE TEST ===\n");

  // Start daemon
  const daemon = spawn(BINARY, [], {
    stdio: "pipe",
    cwd: "/home/vi/smart-terminal-mcp/ptyd",
  });
  daemon.stdout.on("data", (d) => console.log("[ptyd]", d.toString().trim()));
  daemon.stderr.on("data", (d) => console.log("[ptyd]", d.toString().trim()));

  // Wait for socket to appear
  for (let i = 0; i < 50; i++) {
    try {
      await sleep(100);
      await new Promise((r, j) => {
        const client = net.createConnection(SOCKET, () => {
          client.end();
          r();
        });
        client.on("error", () => j(new Error("not ready")));
      });
      break;
    } catch {}
  }

  const client = net.createConnection(SOCKET);
  await new Promise((r) => client.once("connect", r));

  // Test 1: start session
  console.log("\n[Test 1] terminal_start...");
  const startRes = await send(client, "start", {
    id: "s1",
    shell: "/bin/bash",
    cols: 80,
    rows: 24,
    cwd: "/tmp",
  });
  console.log("  start response:", JSON.stringify(startRes));
  if (!startRes.result || !startRes.result.pid)
    throw new Error("start failed: no pid");
  console.log("  ✓ session started, PID:", startRes.result.pid);

  // Test 2: write command
  console.log("\n[Test 2] terminal_write...");
  const writeRes = await send(client, "write", {
    id: "s1",
    data: "echo 'hello-from-pty'\n",
  });
  console.log("  write response:", JSON.stringify(writeRes));
  if (writeRes.result.bytesWritten <= 0) throw new Error("write failed");
  console.log("  ✓ write succeeded");

  // Test 3: wait for output event
  console.log("\n[Test 3] wait for output event...");
  const outputEvt = await waitForEvent(client, "output", "s1");
  const decoded = Buffer.from(outputEvt.data, "base64").toString();
  console.log(
    "  output (decoded):",
    decoded.slice(0, 200).replace(/\n/g, "\\n"),
  );
  if (!decoded.includes("hello-from-pty")) {
    // Try one more event
    const outputEvt2 = await waitForEvent(client, "output", "s1");
    const decoded2 = Buffer.from(outputEvt2.data, "base64").toString();
    console.log(
      "  output2 (decoded):",
      decoded2.slice(0, 200).replace(/\n/g, "\\n"),
    );
    if (!decoded2.includes("hello-from-pty")) {
      throw new Error("expected output to contain 'hello-from-pty'");
    }
  }
  console.log("  ✓ output event received with expected data");

  // Test 4: list
  console.log("\n[Test 4] terminal_list...");
  const listRes = await send(client, "list", {});
  console.log("  list response: sessions =", listRes.result.sessions.length);
  if (listRes.result.sessions.length !== 1)
    throw new Error("expected 1 session");
  console.log("  ✓ list returns 1 session");

  // Test 5: resize
  console.log("\n[Test 5] terminal_resize...");
  const resizeRes = await send(client, "resize", {
    id: "s1",
    cols: 120,
    rows: 40,
  });
  if (!resizeRes.result.ok) throw new Error("resize failed");
  console.log("  ✓ resize succeeded", resizeRes.result);

  // Test 6: signal (SIGINT)
  console.log("\n[Test 6] terminal_signal SIGINT...");
  const signalRes = await send(client, "signal", { id: "s1", signal: 2 });
  if (!signalRes.result.ok) throw new Error("signal failed");
  console.log("  ✓ signal sent");

  // Test 7: start second session
  console.log("\n[Test 7] terminal_start second...");
  const start2Res = await send(client, "start", {
    id: "s2",
    shell: "/bin/bash",
    cols: 80,
    rows: 24,
  });
  if (!start2Res.result || !start2Res.result.pid)
    throw new Error("start s2 failed");
  console.log("  ✓ second session started, PID:", start2Res.result.pid);

  // Test 8: kill first
  console.log("\n[Test 8] terminal_kill s1...");
  const killRes = await send(client, "kill", { id: "s1" });
  if (!killRes.result.ok) throw new Error("kill failed");
  console.log("  ✓ kill s1 succeeded");

  // Test 9: list after kill
  console.log("\n[Test 9] list after kill...");
  const list2Res = await send(client, "list", {});
  console.log("  sessions remaining:", list2Res.result.sessions.length);
  if (list2Res.result.sessions.length !== 1)
    throw new Error("expected 1 session after kill");
  console.log("  ✓ list shows 1 remaining session");

  // Shutdown
  console.log("\n[Test 10] shutdown...");
  const shutdownRes = await send(client, "shutdown", {});
  console.log("  shutdown response:", JSON.stringify(shutdownRes));

  client.end();
  daemon.kill("SIGTERM");

  console.log("\n=== ALL SMOKE TESTS PASSED ===");
}

run().catch((err) => {
  console.error("\n❌ SMOKE TEST FAILED:", err.message);
  process.exit(1);
});
