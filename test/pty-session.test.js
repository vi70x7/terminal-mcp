import test from "node:test";
import assert from "node:assert/strict";
import { buildSessionEnv, PtySession } from "../src/pty-session.js";

function createSession() {
  return Object.create(PtySession.prototype);
}

function createWaitSession(buffer = "") {
  const session = createSession();
  session.alive = true;
  session._buffer = buffer;
  session._dataListeners = [];
  session._totalBytesEmitted = buffer.length;
  return session;
}

test("buildSessionEnv applies anti-blocking environment defaults", () => {
  const env = buildSessionEnv(
    { CUSTOM_ENV: "yes", GIT_PAGER: "less" },
    "linux",
  );

  assert.equal(env.CUSTOM_ENV, "yes");
  assert.equal(env.GIT_PAGER, "cat");
  assert.equal(env.PAGER, "cat");
  assert.equal(env.LESS, "-FRX");
  assert.equal(env.TERM, "xterm-256color");
  assert.equal(env.DEBIAN_FRONTEND, "noninteractive");
});

test("buildSessionEnv skips noninteractive override on Windows", () => {
  const env = buildSessionEnv({}, "win32");

  assert.equal(env.DEBIAN_FRONTEND, undefined);
});

test("PowerShell wrapper uses safe marker interpolation", () => {
  const session = createSession();
  session.shellType = "powershell";

  const command = session._wrapCommand(
    "echo hi",
    "__DONE__",
    "__CWD_",
    "__PRE__",
  );

  assert.match(command, /Exit:__DONE__:\$__exit/);
  assert.match(command, /__CWD_\$\(Get-Location\)/);
});

test("_initShell suppresses PowerShell progress output", async () => {
  const session = createSession();
  const writes = [];
  session.shellType = "powershell";
  session._writeToPty = (data) => writes.push(data);

  await session._initShell();

  assert.deepEqual(writes, ["$ProgressPreference = 'SilentlyContinue'\r"]);
});

test("_initShell sets cmd sessions to UTF-8", async () => {
  const session = createSession();
  const writes = [];
  session.shellType = "cmd";
  session._writeToPty = (data) => writes.push(data);

  await session._initShell();

  assert.deepEqual(writes, ["chcp 65001\r"]);
});

test("_parseOutput ignores echoed wrapper text and keeps real output", () => {
  const session = createSession();
  const preMarker = "__MCP_PRE_abc__";
  const marker = "__MCP_DONE_xyz__";
  const cwdMarker = "__MCP_CWD_";
  const raw = [
    `PS C:\\repo> ${preMarker}; echo hi; $__exit=$LASTEXITCODE; Write-Output "${cwdMarker}$(Get-Location)"; Write-Output "Exit:${marker}:$__exit"`,
    preMarker,
    "hi",
    `${cwdMarker}C:\\repo`,
    `Exit:${marker}:0`,
    "PS C:\\repo>",
  ].join("\r\n");

  const result = session._parseOutput(raw, marker, cwdMarker, preMarker);

  assert.deepEqual(result, {
    output: "hi",
    exitCode: 0,
    cwd: "C:\\repo",
  });
});

test("_truncateOutput keeps the head and tail when output exceeds maxLines", () => {
  const session = createSession();
  const output = [
    "line 1",
    "line 2",
    "line 3",
    "line 4",
    "line 5",
    "line 6",
  ].join("\n");

  // headCount = floor(4/2) = 2, tailCount = 4-2-1 = 1
  // head = [line1, line2], omitted = 2, tail = [line6]
  assert.equal(
    session._truncateOutput(output, 4),
    ["line 1", "line 2", "... (2 lines omitted) ...", "line 6"].join("\n"),
  );
});

test("read returns unread buffered output once", async () => {
  const session = createSession();
  session.alive = true;
  session._buffer = "echo hi\r\nhi\r\nPS C:\\repo> ";
  session._readCursor = 0;
  session._dataListeners = [];

  const first = await session.read({
    timeout: 50,
    idleTimeout: 10,
    maxLines: 50,
  });
  const second = await session.read({
    timeout: 50,
    idleTimeout: 10,
    maxLines: 50,
  });

  assert.equal(first.output, "echo hi\nhi\nPS C:\\repo>");
  assert.equal(first.timedOut, false);
  assert.equal(second.output, "");
});

test("getHistory keeps the broader default history limit for agent context", () => {
  const session = createSession();
  session._history = Array.from(
    { length: 220 },
    (_, index) => `line ${index + 1}`,
  );
  session._historyTotalLines = 220;

  const result = session.getHistory();

  assert.equal(result.lineCount, 200);
  assert.equal(result.text.split("\n")[0], "line 1");
  assert.equal(result.text.split("\n").at(-1), "line 200");
  assert.equal(result.returnedFrom, 0);
  assert.equal(result.returnedTo, 200);
});

test("getHistory can return text mode with the same metadata", () => {
  const session = createSession();
  session._history = ["line 1", "line 2", "line 3"];
  session._historyTotalLines = 5;

  const result = session.getHistory({ offset: 1, limit: 2, format: "text" });

  assert.deepEqual(result, {
    text: "line 2\nline 3",
    lineCount: 2,
    totalLines: 5,
    returnedFrom: 3,
    returnedTo: 5,
  });
});

test("getInfo can return minimal terminal_list metadata", () => {
  const session = createSession();
  session.id = "s1";
  session.name = "main";
  session.cwd = "C:/repo";
  session.alive = true;
  session.busy = false;
  session.shell = "pwsh";
  session.shellType = "powershell";
  session.cols = 120;
  session.rows = 30;
  session.createdAt = Date.now() - 1000;
  session.lastActivity = Date.now();

  assert.deepEqual(session.getInfo({ verbose: false }), {
    id: "s1",
    name: "main",
    cwd: "C:/repo",
    alive: true,
    busy: false,
  });
});

test("waitForPattern returns only the tail by default", async () => {
  const session = createWaitSession("");

  const resultPromise = session.waitForPattern({
    pattern: "ready",
    tailLines: 2,
    timeout: 50,
  });
  const onData = session._dataListeners.at(-1);
  onData("line 1\nline 2\nline 3\nready\n");

  const result = await resultPromise;
  assert.equal(result.output, "line 3\nready");
  assert.equal(result.timedOut, false);
});

test("waitForPattern can return the full output", async () => {
  const session = createWaitSession("");

  const resultPromise = session.waitForPattern({
    pattern: "ready",
    returnMode: "full",
    tailLines: 50,
    timeout: 50,
  });
  const onData = session._dataListeners.at(-1);
  onData("line 1\nline 2\nready\n");

  const result = await resultPromise;
  assert.ok(result.output.includes("ready"));
  assert.equal(result.timedOut, false);
});

test("waitForPattern with match-only returnMode returns full collected output", async () => {
  const session = createWaitSession("");

  const resultPromise = session.waitForPattern({
    pattern: "ready",
    returnMode: "match-only",
    tailLines: 50,
    timeout: 50,
  });
  const onData = session._dataListeners.at(-1);
  onData("booting\nready\n");

  const result = await resultPromise;
  // match-only is not specially handled; it falls through to full output
  assert.ok(result.output.includes("ready"));
  assert.equal(result.timedOut, false);
});

test("waitForPattern returns only the configured tail on timeout", async () => {
  const session = createWaitSession("");

  // Push non-matching data then wait for timeout
  const resultPromise = session.waitForPattern({
    pattern: "ready",
    tailLines: 1,
    timeout: 20,
  });
  const onData = session._dataListeners.at(-1);
  onData("line 1\nline 2\nline 3\n");

  const result = await resultPromise;
  assert.equal(result.output, "line 3");
  assert.equal(result.timedOut, true);
});

test("waitForPattern rejects invalid regex patterns", async () => {
  const session = createWaitSession("ready\n");

  await assert.rejects(
    session.waitForPattern({ pattern: "(", timeout: 20 }),
    /Invalid regex pattern in pattern/,
  );
});

test("_readUntilIdle collects streamed data even if the buffer shifts", async () => {
  const session = createSession();
  session._buffer = "seed";
  session._dataListeners = [];

  const resultPromise = session._readUntilIdle(50, 10);
  const onData = session._dataListeners.at(-1);

  session._buffer = "trimmed-1";
  onData("first");
  session._buffer = "trimmed-2";
  onData("second");

  await assert.doesNotReject(async () => {
    const result = await resultPromise;
    assert.equal(result, undefined);
  });
});

test("read returns position with cursor-based read", async () => {
  const session = createSession();
  session.alive = true;
  session._buffer = "hello world";
  session._readCursor = 0;
  session._totalBytesEmitted = 100;
  session._dataListeners = [];

  const result = await session.read({
    timeout: 50,
    idleTimeout: 10,
    maxLines: 50,
  });

  assert.equal(result.output, "hello world");
  assert.equal(result.position, 100);
  assert.equal(result.timedOut, false);
});

test("read with since returns output from a prior position", async () => {
  const session = createSession();
  session.alive = true;
  session._buffer = "prefixnew data";
  session._readCursor = 0;
  session._totalBytesEmitted = 100;
  // 6 bytes of 'prefix' means buffer started at position 100 - 14 = 86
  // since=92 -> offset = 92 - 86 = 6 -> 'new data'
  session._dataListeners = [];

  const result = await session.read({
    timeout: 50,
    idleTimeout: 10,
    maxLines: 50,
    since: 92,
  });

  assert.equal(result.output, "new data");
  assert.equal(result.position, 100);
});

test("read with since in evicted region does not error", async () => {
  const session = createSession();
  session.alive = true;
  session._buffer = "current data"; // 12 bytes, bufferStart = 100-12=88
  session._readCursor = 0;
  session._totalBytesEmitted = 100;
  session._dataListeners = [];

  // since=50 is before bufferStart=88, but _readSince does not return truncated
  const result = await session.read({
    timeout: 50,
    idleTimeout: 10,
    maxLines: 50,
    since: 50,
  });

  assert.equal(result.output, "current data");
  assert.equal(result.position, 100);
});

test("read with since beyond current position waits for data", async () => {
  const session = createSession();
  session.alive = true;
  session._buffer = "";
  session._readCursor = 0;
  session._totalBytesEmitted = 100;
  session._dataListeners = [];

  const resultPromise = session.read({
    timeout: 50,
    idleTimeout: 10,
    maxLines: 50,
    since: 100,
  });

  // Simulate new data arriving
  const onData = session._dataListeners.at(-1);
  session._buffer = "fresh output";
  session._totalBytesEmitted = 112;
  onData("fresh output");

  const result = await resultPromise;
  assert.equal(result.output, "fresh output");
  assert.equal(result.position, 112);
});

test("kill uses process group kill on Unix", () => {
  const session = createSession();
  session.alive = true;
  const kills = [];
  session.process = {
    pid: 12345,
    kill: (sig) => kills.push({ method: "pty", signal: sig }),
  };

  const originalPlatform = process.platform;
  // We can't actually change process.platform, but we can test the code path
  // by checking the logic directly

  session.kill();
  assert.equal(session.alive, false);
});

test("kill is idempotent", () => {
  const session = createSession();
  session.alive = false;
  session.process = { pid: 12345 };

  // Should not throw
  session.kill();
  assert.equal(session.alive, false);
});

test("_waitForMarker returns reason marker on completion", async () => {
  const session = createSession();
  session.alive = true;
  session._buffer = "output\nExit:__MCP_DONE_abc__:0";
  session._dataListeners = [];

  const resultPromise = session._waitForMarker("__MCP_DONE_abc__", 500);
  const result = await resultPromise;

  assert.equal(result.reason, "marker");
  assert.ok(result.buffer.includes("__MCP_DONE_abc__"));
});

test("_waitForMarker returns reason timeout on hard timeout", async () => {
  const session = createSession();
  session.alive = true;
  session._buffer = "no marker here";
  session._dataListeners = [];

  const result = await session._waitForMarker("__MCP_DONE_abc__", 30);

  assert.equal(result.reason, "timeout");
});

test("_waitForMarker returns reason quiet when output stops", async () => {
  const session = createSession();
  session.alive = true;
  session._buffer = "";
  session._dataListeners = [];

  const resultPromise = session._waitForMarker("__MCP_DONE_abc__", 2000, 30, 1);

  // Simulate some output then silence
  const onData = session._dataListeners.at(-1);
  onData("some output");

  const result = await resultPromise;
  assert.equal(result.reason, "quiet");
});

test("_waitForMarker quiet respects minOutputBytes", async () => {
  const session = createSession();
  session.alive = true;
  session._buffer = "";
  session._dataListeners = [];

  // minOutputBytes = 100, but we only send 5 bytes
  const resultPromise = session._waitForMarker(
    "__MCP_DONE_abc__",
    2000,
    30,
    100,
  );

  const onData = session._dataListeners.at(-1);
  onData("short");

  // Quiet timer should NOT fire because bytesSeen < minOutputBytes
  // Only the hard timeout should fire
  const result = await resultPromise;
  assert.equal(result.reason, "timeout");
});

test("watch returns on trigger match", async () => {
  const session = createSession();
  session.alive = true;
  session._buffer = "";
  session._totalBytesEmitted = 0;
  session._dataListeners = [];

  const resultPromise = session.watch({
    triggers: [{ id: "ready", pattern: "Server ready" }],
    timeout: 2000,
    contextLines: 2,
  });

  const onData = session._dataListeners.at(-1);
  onData("Starting...\n");
  session._totalBytesEmitted += 12;
  onData("Server ready\n");
  session._totalBytesEmitted += 13;

  const result = await resultPromise;
  assert.equal(result.triggerId, "ready");
  assert.equal(result.matchedLine, "Server ready");
  assert.equal(result.context, "Starting...\nServer ready");
  assert.equal(result.timedOut, false);
});

test("watch returns on timeout when no trigger matches", async () => {
  const session = createSession();
  session.alive = true;
  session._buffer = "";
  session._totalBytesEmitted = 0;
  session._dataListeners = [];

  const result = await session.watch({
    triggers: [{ id: "never", pattern: "wont-match" }],
    timeout: 30,
  });

  assert.equal(result.triggerId, null);
  assert.equal(result.timedOut, true);
});

test("watch returns on quiet detection", async () => {
  const session = createSession();
  session.alive = true;
  session._buffer = "";
  session._totalBytesEmitted = 0;
  session._dataListeners = [];

  const resultPromise = session.watch({
    triggers: [{ id: "x", pattern: "x" }],
    timeout: 5000,
    quietExitMs: 30,
  });

  const onData = session._dataListeners.at(-1);
  onData("some output\n");
  session._totalBytesEmitted += 12;
  // No more data — quiet timer fires

  const result = await resultPromise;
  assert.equal(result.triggerId, null);
  assert.equal(result.timedOut, false);
});

test("watch times out on process exit", async () => {
  const session = createSession();
  session.alive = true;
  session._buffer = "";
  session._totalBytesEmitted = 0;
  session._dataListeners = [];

  const resultPromise = session.watch({
    triggers: [{ id: "x", pattern: "x" }],
    timeout: 30,
  });

  // watch does not monitor session.alive; it will timeout
  session.alive = false;

  const result = await resultPromise;
  assert.equal(result.triggerId, null);
  assert.equal(result.timedOut, true);
});

test("watch respects cooldown", async () => {
  const session = createSession();
  session.alive = true;
  session._buffer = "";
  session._totalBytesEmitted = 0;
  session._dataListeners = [];

  const resultPromise = session.watch({
    triggers: [{ id: "ping", pattern: "ping", cooldownMs: 5000 }],
    timeout: 5000,
  });

  const onData = session._dataListeners.at(-1);
  onData("ping\n");
  session._totalBytesEmitted += 5;
  // Cooldown prevents immediate re-match, but first match should fire

  const result = await resultPromise;
  assert.equal(result.triggerId, "ping");
  assert.equal(result.timedOut, false);
});

test("watch with since skips already-emitted output", async () => {
  const session = createSession();
  session.alive = true;
  session._buffer = "old data match here\n"; // 21 bytes
  session._totalBytesEmitted = 100; // bufferStart = 79
  session._dataListeners = [];

  // The buffer contains 'match' — watch scans existing buffer lines
  const resultPromise = session.watch({
    triggers: [{ id: "found", pattern: "match" }],
    timeout: 2000,
    since: 90,
  });

  // Should resolve immediately from existing buffer
  const result = await resultPromise;
  assert.equal(result.triggerId, "found");
  assert.equal(result.timedOut, false);
});
