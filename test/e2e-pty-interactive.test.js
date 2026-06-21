import test from "node:test";
import assert from "node:assert/strict";
import { execSync } from "node:child_process";
import { PtySession } from "../src/pty-session.js";

// Skip entire suite on Windows
if (process.platform === "win32") {
  test.skip("E2E interactive tests — skipped on Windows (requires Unix PTY)", () => {});
} else {
  const TIMEOUT = 15000;
  const IDLE_TIMEOUT = 2000;

  /** Drain any remaining buffered output so the next read is clean. */
  async function drainSession(session) {
    try {
      await session.read({ timeout: 3000, idleTimeout: IDLE_TIMEOUT });
    } catch {}
  }

  // ---------------------------------------------------------------------------
  // 1. Interactive REPL (Node.js)
  // ---------------------------------------------------------------------------

  test("Interactive Node.js REPL — write, read, exit", async () => {
    const session = new PtySession({
      id: "test-repl-node",
      shell: "/bin/bash",
      shellArgs: [],
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
    });
    try {
      await session.waitForBanner();
      await drainSession(session);

      // Start node REPL
      session.write("node -i\n");
      await new Promise((r) => setTimeout(r, 1500));
      await drainSession(session);

      // Write expression and read output
      session.write('console.log("from-repl")\n');
      await new Promise((r) => setTimeout(r, 1500));
      const read1 = await session.read({
        timeout: TIMEOUT,
        idleTimeout: IDLE_TIMEOUT,
      });
      assert.ok(
        read1.output.includes("from-repl"),
        `REPL should output "from-repl", got: ${JSON.stringify(read1.output)}`,
      );

      // Exit REPL
      session.write(".exit\n");
      await new Promise((r) => setTimeout(r, 500));
    } finally {
      session.kill();
    }
  });

  // ---------------------------------------------------------------------------
  // 2. Interactive Python3
  // ---------------------------------------------------------------------------

  let HAS_PYTHON3 = false;
  try {
    execSync("which python3", { stdio: "ignore" });
    HAS_PYTHON3 = true;
  } catch {}

  test(
    "Interactive Python3 — write, read, exit",
    { skip: HAS_PYTHON3 ? undefined : "python3 not found" },
    async () => {
      const session = new PtySession({
        id: "test-repl-python",
        shell: "/bin/bash",
        shellArgs: [],
        cols: 80,
        rows: 24,
        cwd: process.cwd(),
      });
      try {
        await session.waitForBanner();
        await drainSession(session);

        // Start python REPL
        session.write("python3 -i\n");
        await new Promise((r) => setTimeout(r, 2000));
        await drainSession(session);

        // Write print command and read output
        session.write('print("from-python")\n');
        await new Promise((r) => setTimeout(r, 1500));
        const read1 = await session.read({
          timeout: TIMEOUT,
          idleTimeout: IDLE_TIMEOUT,
        });
        assert.ok(
          read1.output.includes("from-python"),
          `Python should output "from-python", got: ${JSON.stringify(read1.output)}`,
        );

        // Exit REPL
        session.write("exit()\n");
        await new Promise((r) => setTimeout(r, 500));
      } finally {
        session.kill();
      }
    },
  );

  // ---------------------------------------------------------------------------
  // 3. Cat as Interactive Input
  // ---------------------------------------------------------------------------

  test("Cat — interactive echo and exit", async () => {
    const session = new PtySession({
      id: "test-cat-interactive",
      shell: "/bin/bash",
      shellArgs: [],
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
    });
    try {
      await session.waitForBanner();
      await drainSession(session);

      // Start cat
      session.write("cat\n");
      await new Promise((r) => setTimeout(r, 500));

      // Write data — cat echoes what it receives
      session.write("hello from cat\n");
      await new Promise((r) => setTimeout(r, 1500));
      const read1 = await session.read({
        timeout: TIMEOUT,
        idleTimeout: IDLE_TIMEOUT,
      });
      assert.ok(
        read1.output.includes("hello from cat"),
        `cat should echo "hello from cat", got: ${JSON.stringify(read1.output)}`,
      );

      // Exit cat with ctrl+c
      session.sendKey("ctrl+c");
      await new Promise((r) => setTimeout(r, 500));
    } finally {
      session.kill();
    }
  });

  // ---------------------------------------------------------------------------
  // 4. Terminal Resize (stty)
  // ---------------------------------------------------------------------------

  test("Resize — stty size reports new dimensions", async () => {
    const session = new PtySession({
      id: "test-stty-size",
      shell: "/bin/bash",
      shellArgs: [],
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
    });
    try {
      await session.waitForBanner();
      await drainSession(session);

      // Resize to 100x30
      session.resize(100, 30);
      await new Promise((r) => setTimeout(r, 300));

      const result = await session.exec({
        command: "stty size",
        timeout: TIMEOUT,
      });
      const clean = result.output.replace(/\s+/g, " ").trim();
      assert.ok(
        clean.includes("30"),
        `stty should report 30 rows, got: ${JSON.stringify(clean)}`,
      );
      assert.ok(
        clean.includes("100"),
        `stty should report 100 cols, got: ${JSON.stringify(clean)}`,
      );
    } finally {
      session.kill();
    }
  });

  // ---------------------------------------------------------------------------
  // 5. Arrow Keys / Tab / Backspace (tested via exec, more reliable)
  // ---------------------------------------------------------------------------

  test("Arrow up — recalls last command from history", async () => {
    const session = new PtySession({
      id: "test-arrow-up",
      shell: "/bin/bash",
      shellArgs: [],
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
    });
    try {
      await session.waitForBanner();

      // Run a command so it enters bash history (via exec)
      await session.exec({
        command: "echo test-history-arrow",
        timeout: TIMEOUT,
      });
      await drainSession(session);

      // Send up arrow — should recall the command
      session.sendKey("up");
      await new Promise((r) => setTimeout(r, 500));
      session.sendKey("enter");
      await new Promise((r) => setTimeout(r, 2000));

      const read1 = await session.read({ timeout: TIMEOUT, idleTimeout: 1000 });
      assert.ok(
        read1.output.includes("test-history-arrow"),
        `up arrow should recall last command, got: ${JSON.stringify(read1.output)}`,
      );

      // Cancel any leftover state
      session.sendKey("ctrl+c");
      await new Promise((r) => setTimeout(r, 300));
    } finally {
      session.kill();
    }
  });

  test("Tab — completes partial command", async () => {
    const session = new PtySession({
      id: "test-tab-complete",
      shell: "/bin/bash",
      shellArgs: [],
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
    });
    try {
      await session.waitForBanner();
      await drainSession(session);

      // Write partial command and Tab-complete
      session.write("ech");
      await new Promise((r) => setTimeout(r, 200));
      session.sendKey("tab");
      await new Promise((r) => setTimeout(r, 800));
      session.sendKey("enter");
      await new Promise((r) => setTimeout(r, 1500));

      const read1 = await session.read({ timeout: TIMEOUT, idleTimeout: 1000 });
      // After tab, "ech" should complete to "echo" — we see it in the output
      assert.ok(
        read1.output.includes("echo"),
        `tab should complete "ech" to "echo", got: ${JSON.stringify(read1.output)}`,
      );

      // Cancel
      session.sendKey("ctrl+c");
      await new Promise((r) => setTimeout(r, 300));
    } finally {
      session.kill();
    }
  });

  test("Backspace — deletes character before cursor", async () => {
    const session = new PtySession({
      id: "test-backspace",
      shell: "/bin/bash",
      shellArgs: [],
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
    });
    try {
      await session.waitForBanner();
      await drainSession(session);

      // Write "echo hellx" then backspace + enter
      session.write("echo hellx");
      await new Promise((r) => setTimeout(r, 200));
      session.sendKey("backspace");
      await new Promise((r) => setTimeout(r, 200));
      session.sendKey("enter");
      await new Promise((r) => setTimeout(r, 1500));

      const read1 = await session.read({ timeout: TIMEOUT, idleTimeout: 1000 });
      // The command output should contain "hell" (backspace removed the x)
      assert.ok(
        read1.output.includes("hell"),
        `backspace should delete x so output contains "hell", got: ${JSON.stringify(read1.output)}`,
      );
    } finally {
      session.kill();
    }
  });

  // ---------------------------------------------------------------------------
  // 6. Watch Triggers
  // ---------------------------------------------------------------------------

  test("Watch — fires on matching output pattern", async () => {
    const session = new PtySession({
      id: "test-watch-trigger",
      shell: "/bin/bash",
      shellArgs: [],
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
    });
    try {
      await session.waitForBanner();

      const UNIQUE_TRIGGER = `TRIGGER_FIRE_${Date.now()}`;

      // Start watch (do NOT await — it resolves when trigger matches)
      const watchPromise = session.watch({
        triggers: [{ id: "fire", pattern: UNIQUE_TRIGGER }],
        timeout: 10000,
      });

      // Small delay so watch listener is registered
      await new Promise((r) => setTimeout(r, 100));

      // Produce output that matches
      session.write(`echo ${UNIQUE_TRIGGER}\n`);

      const watchResult = await watchPromise;
      assert.equal(
        watchResult.triggerId,
        "fire",
        "watch should fire the correct trigger",
      );
      assert.equal(watchResult.timedOut, false, "watch should not time out");
      assert.ok(
        watchResult.matchedLine.includes(UNIQUE_TRIGGER),
        `matchedLine should contain trigger text, got: ${JSON.stringify(watchResult.matchedLine)}`,
      );
    } finally {
      session.kill();
    }
  });

  // ---------------------------------------------------------------------------
  // 7. Quiet Exit Detection
  // ---------------------------------------------------------------------------

  test("Exec — quietExitMs returns early when output goes silent", async () => {
    const session = new PtySession({
      id: "test-quiet-exit",
      shell: "/bin/bash",
      shellArgs: [],
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
    });
    try {
      await session.waitForBanner();
      const start = Date.now();
      const result = await session.exec({
        command: "echo fast && sleep 10",
        timeout: 30000,
        quietExitMs: 500,
      });
      const elapsed = Date.now() - start;

      assert.equal(
        result.quietExited,
        true,
        "exec should report quietExited=true",
      );
      // Should return well before the 10s sleep + 30s timeout
      assert.ok(
        elapsed < 15000,
        `should return early (elapsed ${elapsed}ms), not wait for full timeout`,
      );
    } finally {
      session.kill();
    }
  });

  // ---------------------------------------------------------------------------
  // 8. Large Output Handling
  // ---------------------------------------------------------------------------

  test("Exec — maxLines truncates large output", async () => {
    const session = new PtySession({
      id: "test-large-output",
      shell: "/bin/bash",
      shellArgs: [],
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
    });
    try {
      await session.waitForBanner();
      const result = await session.exec({
        command: "seq 1 500",
        maxLines: 50,
        timeout: TIMEOUT,
      });

      assert.match(
        result.output,
        /omitted/,
        "truncated output should contain truncation marker",
      );
      // Output should not contain all 500 lines
      const lineCount = result.output.split("\n").length;
      assert.ok(
        lineCount <= 52,
        `output should be roughly ≤ 50 lines plus marker (got ${lineCount})`,
      );
    } finally {
      session.kill();
    }
  });

  // ---------------------------------------------------------------------------
  // 9. Output Diff
  // ---------------------------------------------------------------------------

  test("Separate exec calls produce different outputs", async () => {
    const session = new PtySession({
      id: "test-output-diff",
      shell: "/bin/bash",
      shellArgs: [],
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
    });
    try {
      await session.waitForBanner();

      const result1 = await session.exec({
        command: "echo aaa",
        timeout: 5000,
      });
      const result2 = await session.exec({
        command: "echo bbb",
        timeout: 5000,
      });

      assert.ok(
        result1.output.includes("aaa"),
        'first exec should contain "aaa"',
      );
      assert.ok(
        result2.output.includes("bbb"),
        'second exec should contain "bbb"',
      );
      assert.ok(
        !result1.output.includes("bbb"),
        'first exec should NOT contain "bbb"',
      );
      assert.ok(
        !result2.output.includes("aaa"),
        'second exec should NOT contain "aaa"',
      );
    } finally {
      session.kill();
    }
  });
} // end of platform guard
