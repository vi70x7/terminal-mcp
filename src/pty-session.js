import { randomUUID } from "node:crypto";
import { spawn, execSync } from "node:child_process";
import {
  openSync,
  closeSync,
  readSync,
  writeSync,
  readFileSync,
  unlinkSync,
  accessSync,
  constants,
} from "node:fs";
import os, { platform, tmpdir } from "node:os";
import { join as joinPath, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { stripAnsi } from "./ansi.js";
import { compileUserRegex } from "./regex-utils.js";
import { getShellType } from "./shell-detector.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const MAX_BUFFER_BYTES = 1024 * 1024; // 1MB
const HISTORY_MAX_LINES = 10_000;
const BANNER_WAIT_MS = 2000;
const BANNER_IDLE_MS = 500;
export const DEFAULT_EXEC_MAX_LINES = 200;
export const DEFAULT_READ_MAX_LINES = 200;
export const DEFAULT_HISTORY_LIMIT = 200;
export const DEFAULT_HISTORY_FORMAT = "lines";
const DEFAULT_WAIT_RETURN_MODE = "tail";
const DEFAULT_WAIT_TAIL_LINES = 50;

/**
 * Environment variables set for each session.
 * Sensible defaults that make non-interactive, pipe-friendly output from common tools.
 */
export function buildSessionEnv(customEnv = {}, platformName = platform()) {
  const env = {
    ...process.env,
    ...customEnv,
    GIT_PAGER: "cat",
    PAGER: "cat",
    LESS: "-FRX",
    TERM: "xterm-256color",
  };

  if (platformName !== "win32") {
    env.DEBIAN_FRONTEND = "noninteractive";
  }

  return env;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Key name to escape sequence mapping for terminal_send_key.
 */
const KEY_MAP = {
  "ctrl+c": "\x03",
  "ctrl+d": "\x04",
  "ctrl+z": "\x1A",
  "ctrl+l": "\x0C",
  "ctrl+a": "\x01",
  "ctrl+e": "\x05",
  "ctrl+u": "\x15",
  "ctrl+k": "\x0B",
  "ctrl+w": "\x17",
  tab: "\t",
  enter: "\r",
  escape: "\x1B",
  up: "\x1B[A",
  down: "\x1B[B",
  right: "\x1B[C",
  left: "\x1B[D",
  home: "\x1B[H",
  end: "\x1B[F",
  pageup: "\x1B[5~",
  pagedown: "\x1B[6~",
  backspace: "\x7F",
  delete: "\x1B[3~",
  f1: "\x1BOP",
  f2: "\x1BOQ",
  f3: "\x1BOR",
  f4: "\x1BOS",
  f5: "\x1B[15~",
  f6: "\x1B[17~",
  f7: "\x1B[18~",
  f8: "\x1B[19~",
  f9: "\x1B[20~",
  f10: "\x1B[21~",
  f11: "\x1B[23~",
  f12: "\x1B[24~",
};

export const SUPPORTED_KEYS = Object.keys(KEY_MAP);

/**
 * Allocate a PTY (Unix only).
 *
 * Two modes:
 *  - "direct" (os.ptsname() available): opens /dev/ptmx, returns masterFd
 *  - "helper" (no os.ptsname()): spawns pty-helper binary which proxies master I/O
 *
 * Falls back to null if allocation fails (e.g. Windows, restricted envs).
 * @returns {{ mode: 'direct', masterFd: number, slaveFd: number, slavePath: string, cleanup: () => void } | { mode: 'helper', helper: import('node:child_process').ChildProcess, slaveFd: number, slavePath: string, cleanup: () => void } | null}
 */
function allocatePty() {
  if (platform() === "win32") return null;

  // --- Fast path: native os.ptsname() is available ---
  let nativePtsname = null;
  // os is imported at the top of the file
  try {
    if (typeof os.ptsname === "function") {
      nativePtsname = os.ptsname;
    }
  } catch {}

  if (nativePtsname) {
    try {
      const master = openSync("/dev/ptmx", "r+");
      try {
        const slavePath = nativePtsname(master);
        if (!slavePath) {
          closeSync(master);
          return null;
        }
        const slaveFd = openSync(slavePath, "r+");
        return {
          mode: "direct",
          masterFd: master,
          slaveFd,
          slavePath,
          cleanup: () => {
            try {
              closeSync(master);
            } catch {}
            try {
              closeSync(slaveFd);
            } catch {}
          },
        };
      } catch {
        closeSync(master);
        return null;
      }
    } catch {
      return null;
    }
  }

  // --- Fallback path: pty-helper binary ---
  try {
    // spawn is imported at the top of the file
    const headerPath = joinPath(
      tmpdir(),
      `pty-helper-${Date.now()}-${Math.random().toString(36).slice(2)}.hdr`,
    );
    const helperPath = joinPath(__dirname, "pty-helper");

    // Check helper binary exists and is executable
    try {
      accessSync(helperPath, constants.R_OK | constants.X_OK);
    } catch {
      return null;
    }

    const helper = spawn(helperPath, [headerPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Wait up to 3 seconds for the helper to write the header file
    // The helper writes the slave path to the header file before entering the proxy loop
    execSync(
      `timeout 3 bash -c 'while [ ! -s "${headerPath}" ]; do sleep 0.01; done'`,
      { timeout: 5000 },
    );

    const content = readFileSync(headerPath, "utf8").trim();
    // Clean up the header file immediately
    try {
      unlinkSync(headerPath);
    } catch {}

    if (!content || !content.startsWith("/dev/pts/")) {
      try {
        helper.kill();
      } catch {}
      return null;
    }

    const slavePath = content;

    // Open the slave PTY (works because the helper holds the master open)
    const slaveFd = openSync(slavePath, "r+");

    return {
      mode: "helper",
      helper,
      slaveFd,
      slavePath,
      cleanup: () => {
        try {
          helper.kill();
        } catch {}
        try {
          closeSync(slaveFd);
        } catch {}
      },
    };
  } catch {
    return null;
  }
}

export class PtySession {
  /**
   * @param {object} opts
   * @param {string} opts.id
   * @param {string} opts.shell
   * @param {string[]} opts.shellArgs
   * @param {number} opts.cols
   * @param {number} opts.rows
   * @param {string} opts.cwd
   * @param {string} [opts.name]
   * @param {Record<string, string>} [opts.env]
   */
  constructor({ id, shell, shellArgs, cols, rows, cwd, name, env: customEnv }) {
    this.id = id;
    this.shell = shell;
    this.shellType = getShellType(shell);
    this.name = name || null;
    this.cols = cols;
    this.rows = rows;
    this.cwd = cwd;
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
    this.busy = false;
    this.alive = true;

    /** @type {string} */
    this._buffer = "";
    /** Monotonic byte counter — total bytes ever emitted. Never resets. */
    this._totalBytesEmitted = 0;
    /** @type {string[]} Rolling history of cleaned output lines */
    this._history = [];
    /** Total lines ever appended (monotonic counter for detecting eviction) */
    this._historyTotalLines = 0;
    /** Partial line not yet terminated by newline */
    this._historyPartial = "";
    /** Byte offset for unread output returned by terminal_read */
    this._readCursor = 0;
    /** @type {((data: string) => void)[]} */
    this._dataListeners = [];
    /** @type {string | null} */
    this._pendingMarker = null;

    const env = buildSessionEnv(customEnv);

    // Try to allocate a real PTY; fall back to plain pipe if unavailable
    const ptyInfo = allocatePty();

    /** @type {'direct'|'helper'|null} */
    this._ptyMode = ptyInfo ? ptyInfo.mode : null;
    /** @type {import('node:child_process').ChildProcess|null} */
    this._helper = ptyInfo?.mode === "helper" ? ptyInfo.helper : null;
    this._ptyMasterFd = ptyInfo?.mode === "direct" ? ptyInfo.masterFd : null;
    this._ptySlaveFd = ptyInfo ? ptyInfo.slaveFd : null;
    /** @type {string|null} Slave PTY path (used by resize) */
    this._ptySlavePath = ptyInfo ? ptyInfo.slavePath : null;
    this._ptyCleanup = ptyInfo ? ptyInfo.cleanup : null;

    const isPty = ptyInfo !== null;

    const spawnOpts = {
      cwd,
      env,
      stdio: isPty
        ? [ptyInfo.slaveFd, ptyInfo.slaveFd, ptyInfo.slaveFd]
        : ["pipe", "pipe", "pipe"],
      detached: true,
      windowsHide: platform() === "win32",
    };

    this.process = spawn(
      shell,
      shellArgs.length > 0 ? shellArgs : [],
      spawnOpts,
    );

    // Close slave FDs in the parent after spawn — the child has them now
    if (isPty) {
      try {
        closeSync(this._ptySlaveFd);
      } catch {}
      this._ptySlaveFd = null;
    }

    // Set up reading for the appropriate mode
    if (this._ptyMode === "direct" && this._ptyMasterFd !== null) {
      this._startPtyReader(this._ptyMasterFd);
    } else if (this._ptyMode === "helper" && this._helper) {
      // Helper mode: read from the helper's stdout (which proxies the PTY master)
      this._helper.stdout.on("data", (data) => {
        this._handleData(data);
      });
      this._helper.on("exit", () => {
        this._ptyReadRunning = false;
        this.alive = false;
        this._cleanupPty();
      });
    } else {
      // Pipe mode: read from the child's stdout/stderr streams
      this.process.stdout?.on("data", (data) => {
        this._handleData(data);
      });
      this.process.stderr?.on("data", (data) => {
        this._handleData(data);
      });
    }

    this.process.on("exit", (code, signal) => {
      this.alive = false;
      this._cleanupPty();
    });

    this.process.on("error", (err) => {
      if (!this.alive) return;
      this.alive = false;
      this._cleanupPty();
    });
  }

  /**
   * Read from the PTY master FD in a non-blocking loop.
   * Uses a temporary buffer + setImmediate to stay async-friendly.
   * @param {number} fd
   */
  _startPtyReader(fd) {
    const buf = Buffer.alloc(64 * 1024); // 64KB read buffer
    this._ptyReadRunning = true;

    const doRead = () => {
      if (!this._ptyReadRunning || this._ptyMasterFd === null) return;

      try {
        const bytesRead = readSync(fd, buf, 0, buf.length, null);
        if (bytesRead > 0) {
          this._handleData(buf.toString("utf-8", 0, bytesRead));
          // Continue reading immediately
          setImmediate(doRead);
        } else {
          // EOF — process exited
          this._ptyReadRunning = false;
          this.alive = false;
          this._cleanupPty();
        }
      } catch (err) {
        if (err.code === "EIO") {
          // PTY slave closed — normal on process exit
          this._ptyReadRunning = false;
          this.alive = false;
          this._cleanupPty();
          return;
        }
        if (err.code === "EBADF") {
          this._ptyReadRunning = false;
          this.alive = false;
          this._cleanupPty();
          return;
        }
        // Transient error (e.g. EAGAIN) — retry after a tick
        if (this._ptyReadRunning) {
          setTimeout(doRead, 10);
        }
      }
    };

    setImmediate(doRead);
  }

  _cleanupPty() {
    this._ptyReadRunning = false;
    if (this._ptyMode === "helper" && this._helper) {
      try {
        this._helper.kill();
      } catch {}
      this._helper = null;
    }
    if (this._ptyCleanup) {
      try {
        this._ptyCleanup();
      } catch {}
      this._ptyCleanup = null;
    }
    if (this._ptyMasterFd !== null) {
      try {
        closeSync(this._ptyMasterFd);
      } catch {}
      this._ptyMasterFd = null;
    }
  }

  /**
   * Write data to the PTY master FD (PTY mode) or process stdin (pipe mode).
   * @param {string|Buffer} data
   */
  _writeToPty(data) {
    if (!this.alive) {
      throw new Error(`Session ${this.id} is no longer alive.`);
    }

    if (this._ptyMode === "direct" && this._ptyMasterFd !== null) {
      // Direct PTY mode: write directly to master FD
      const buf = typeof data === "string" ? Buffer.from(data, "utf-8") : data;
      try {
        writeSync(this._ptyMasterFd, buf, 0, buf.length, null);
      } catch (err) {
        if (err.code === "EIO" || err.code === "EBADF") {
          // PTY slave closed — process exited
          this.alive = false;
          this._cleanupPty();
        }
      }
    } else if (
      this._ptyMode === "helper" &&
      this._helper?.stdin &&
      !this._helper.stdin.destroyed
    ) {
      // Helper mode: write to helper's stdin (proxied to PTY master)
      this._helper.stdin.write(data);
    } else if (this.process?.stdin && !this.process.stdin.destroyed) {
      // Pipe mode: write to child's stdin
      this.process.stdin.write(data);
    }
  }

  /**
   * Send a signal to the child's process group (PTY mode) or child process directly.
   * @param {string} signal - e.g. 'SIGINT', 'SIGTERM', 'SIGHUP'
   */
  sendSignal(signal) {
    if (!this.alive) return;

    if (
      (this._ptyMode === "direct" || this._ptyMode === "helper") &&
      this.process?.pid
    ) {
      try {
        // Send to the entire process group via the child's PGID
        process.kill(-this.process.pid, signal);
      } catch {}
    } else {
      try {
        this.process?.kill(signal);
      } catch {}
    }
  }

  /**
   * Forward inbound data through the buffer / history / listener pipeline.
   * @param {string|Buffer} data
   */
  _handleData(data) {
    const str = typeof data === "string" ? data : data.toString("utf-8");
    this.lastActivity = Date.now();
    this._buffer += str;
    this._totalBytesEmitted += str.length;

    if (this._pendingMarker && this._buffer.includes(this._pendingMarker)) {
      this.busy = false;
      this._pendingMarker = null;
    }

    // Enforce buffer cap — keep tail
    if (this._buffer.length > MAX_BUFFER_BYTES) {
      const overflow = this._buffer.length - MAX_BUFFER_BYTES;
      this._buffer = this._buffer.slice(-MAX_BUFFER_BYTES);
      this._readCursor = Math.max(0, this._readCursor - overflow);
    }

    // Append cleaned output to rolling history
    this._appendToHistory(str);

    // Notify listeners with a copy-safe iteration (listeners may splice)
    const listeners = this._dataListeners.slice();
    for (const listener of listeners) {
      listener(str);
    }
  }

  /**
   * Wait for the shell startup banner.
   * @returns {Promise<string>}
   */
  async waitForBanner() {
    const banner = await this._readUntilIdle(BANNER_WAIT_MS, BANNER_IDLE_MS);
    // Run shell-specific init commands after banner
    await this._initShell();
    return banner;
  }

  async _initShell() {
    // Shell-specific initialization for non-bash shells
    if (this.shellType === "powershell") {
      try {
        this._writeToPty("$ProgressPreference = 'SilentlyContinue'\r");
      } catch {}
    } else if (this.shellType === "cmd") {
      try {
        this._writeToPty("chcp 65001\r");
      } catch {}
    }
    // Give the shell a moment to process init
    await new Promise((r) => setTimeout(r, 200));
  }

  /**
   * Run a command with completion marker detection.
   * @param {object} opts
   * @param {string} opts.command
   * @param {number} [opts.timeout=30000]
   * @param {number} [opts.maxLines=100]
   * @param {number} [opts.quietExitMs] - Return early if output is silent for this long after first output
   * @param {number} [opts.minOutputBytes=1] - Require at least this many bytes before quiet detection
   * @param {Function} [opts.sendNotification] - MCP sendNotification function for progress
   * @param {string|number} [opts.progressToken] - Progress token from client
   * @returns {Promise<{ output: string, exitCode: number|null, cwd: string|null, timedOut: boolean, quietExited?: boolean, hint?: string }>}
   */
  async exec({
    command,
    timeout = 30000,
    maxLines = DEFAULT_EXEC_MAX_LINES,
    quietExitMs,
    minOutputBytes = 1,
    sendNotification,
    progressToken,
  }) {
    if (this.busy) {
      throw new Error(
        `Session ${this.id} is busy with a background command. Wait for it to finish, or use terminal_read to check output, or terminal_send_key("ctrl+c") to abort it.`,
      );
    }
    if (!this.alive) {
      throw new Error(`Session ${this.id} is no longer alive.`);
    }

    this.busy = true;
    this._resetBuffer();

    const marker = `__MCP_DONE_${randomUUID().replace(/-/g, "")}__`;
    const cwdMarker = `__MCP_CWD_`;
    const preMarker = `__MCP_PRE_${randomUUID().replace(/-/g, "")}__`;
    const wrappedCommand = this._wrapCommand(
      command,
      marker,
      cwdMarker,
      preMarker,
    );

    try {
      this._writeToPty(wrappedCommand + "\n");

      const { buffer: raw, reason } = await this._waitForMarker(
        marker,
        timeout,
        quietExitMs,
        minOutputBytes,
        sendNotification,
        progressToken,
      );
      const markerFoundRegex = new RegExp(
        "Exit:" + escapeRegExp(marker) + ":[-]?\\d+",
      );
      const markerFound = markerFoundRegex.test(raw);
      const timedOut = reason === "timeout";
      const quietExited = reason === "quiet";

      const { output, exitCode, cwd } = this._parseOutput(
        raw,
        marker,
        cwdMarker,
        preMarker,
      );
      if (cwd) this.cwd = cwd;

      if (markerFound) {
        this.busy = false;
        this._pendingMarker = null;
      } else {
        this._pendingMarker = marker;
      }

      return {
        output: this._truncateOutput(output, maxLines),
        exitCode: markerFound ? exitCode : null,
        cwd: this.cwd,
        timedOut,
        ...(quietExited && { quietExited: true }),
        ...((timedOut || quietExited) && {
          hint: `Command is still running in the background. Session remains busy. Use terminal_read to get new output, or terminal_send_key("ctrl+c") to abort.`,
        }),
      };
    } catch (err) {
      this.busy = false;
      this._pendingMarker = null;
      throw err;
    }
  }

  /**
   * Write raw data to PTY (for interactive programs).
   * @param {string} data
   */
  write(data) {
    if (!this.alive) {
      throw new Error(`Session ${this.id} is no longer alive.`);
    }
    this._writeToPty(data);
  }

  /**
   * Send a named special key.
   * @param {string} key
   */
  sendKey(key) {
    const seq = KEY_MAP[key.toLowerCase()];
    if (!seq) {
      throw new Error(
        `Unknown key: "${key}". Supported: ${SUPPORTED_KEYS.join(", ")}`,
      );
    }

    // For ctrl+c, prefer sending SIGINT to the process group
    // (more reliable in PTY mode than writing \x03 byte)
    if (key.toLowerCase() === "ctrl+c") {
      this.sendSignal("SIGINT");
      return;
    }

    this.write(seq);
  }

  /**
   * Read buffered output with idle detection.
   * @param {object} opts
   * @param {number} [opts.timeout=30000]
   * @param {number} [opts.idleTimeout=500]
   * @param {number} [opts.maxLines=80]
   * @param {number} [opts.since] - Absolute byte position; returns output emitted since that position
   * @returns {Promise<{ output: string, timedOut: boolean, position: number, truncated?: boolean }>}
   */
  async read({
    timeout = 30000,
    idleTimeout = 500,
    maxLines = DEFAULT_READ_MAX_LINES,
    since,
  } = {}) {
    if (!this.alive) {
      // Return whatever is left in buffer
      const leftover = stripAnsi(this._consumeUnreadBuffer()).trim();
      this._resetBuffer();
      return {
        output: leftover,
        timedOut: false,
        position: this._totalBytesEmitted,
      };
    }

    // Position-based read: return only output since a prior byte position
    if (since !== undefined) {
      return this._readSince({ since, timeout, idleTimeout, maxLines });
    }

    await this._readUntilIdle(timeout, idleTimeout);
    const raw = this._consumeUnreadBuffer();
    const output = stripAnsi(raw).trim();

    return {
      output: this._truncateOutput(output, maxLines),
      timedOut: false,
      position: this._totalBytesEmitted,
    };
  }

  /**
   * Wait for a specific pattern in the output.
   * @param {object} opts
   * @param {string} opts.pattern - String or regex pattern to match
   * @param {number} [opts.timeout=30000]
   * @param {string} [opts.returnMode='tail'] - 'tail' returns last N lines after match, 'from_start' returns everything from beginning
   * @param {number} [opts.tailLines=50] - Number of lines to return when returnMode is 'tail'
   * @param {number} [opts.cooldownMs=0] - Minimum ms between matches (for watch)
   * @param {Function} [opts.sendNotification] - MCP sendNotification function for progress
   * @param {string|number} [opts.progressToken] - Progress token from client
   * @returns {Promise<{ output: string, timedOut: boolean, position: number }>}
   */
  async waitForPattern({
    pattern,
    timeout = 30000,
    returnMode = DEFAULT_WAIT_RETURN_MODE,
    tailLines = DEFAULT_WAIT_TAIL_LINES,
    cooldownMs = 0,
    sendNotification,
    progressToken,
  }) {
    const regex = compileUserRegex(pattern);
    const startTime = Date.now();
    let collected = "";
    let lastProgressAt = 0;
    const tailTracker = this._createTailTracker(tailLines);

    return new Promise((resolve) => {
      let resolved = false;
      let hardTimer;

      const cleanup = () => {
        clearTimeout(hardTimer);
        const idx = this._dataListeners.indexOf(onData);
        if (idx !== -1) this._dataListeners.splice(idx, 1);
      };

      const safeResolve = (val) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve(val);
      };

      hardTimer = setTimeout(() => {
        const output =
          returnMode === "tail"
            ? this._tailTrackerToOutput(tailTracker)
            : stripAnsi(collected);
        safeResolve({
          output,
          timedOut: true,
          position: this._totalBytesEmitted,
        });
      }, timeout);

      const onData = (data) => {
        collected += data;
        const clean = stripAnsi(data);
        this._appendToTailTracker(tailTracker, clean);

        const now = Date.now();
        if (sendNotification && progressToken && now - lastProgressAt > 1000) {
          lastProgressAt = now;
          this._sendProgress(
            sendNotification,
            progressToken,
            stripAnsi(collected),
            startTime,
            timeout,
          );
        }

        if (regex.test(stripAnsi(collected))) {
          const output =
            returnMode === "tail"
              ? this._tailTrackerToOutput(tailTracker)
              : stripAnsi(collected);
          safeResolve({
            output: this._truncateOutput(output, tailLines * 2),
            timedOut: false,
            position: this._totalBytesEmitted,
          });
        }
      };

      this._dataListeners.push(onData);
      // Check if pattern already matched in existing buffer
      if (regex.test(stripAnsi(this._buffer + collected))) {
        // Will be picked up on next tick via the check below
      }
    });
  }

  /**
   * Read only new output since a specific byte position.
   * @param {object} opts
   * @param {number} opts.since - Absolute byte position
   * @param {number} [opts.timeout=30000]
   * @param {number} [opts.idleTimeout=500]
   * @param {number} [opts.maxLines=200]
   * @returns {Promise<{ output: string, timedOut: boolean, position: number }>}
   */
  async _readSince({ since, timeout, idleTimeout, maxLines }) {
    const currentPos = this._totalBytesEmitted;
    if (currentPos > since) {
      // We already have newer data in buffer
      const newPos = this._totalBytesEmitted;
      // Calculate how far back in the buffer to go
      const bytesNew = newPos - since;
      const offset = Math.max(0, this._buffer.length - bytesNew);
      const raw = this._buffer.slice(offset);
      return {
        output: this._truncateOutput(stripAnsi(raw).trim(), maxLines),
        timedOut: false,
        position: newPos,
      };
    }

    // Wait for new data with timeout
    try {
      const newPos = await this._waitForNewBytes(since, timeout);
      const bytesNew = newPos - since;
      const offset = Math.max(0, this._buffer.length - bytesNew);
      const raw = this._buffer.slice(offset);
      return {
        output: this._truncateOutput(stripAnsi(raw).trim(), maxLines),
        timedOut: false,
        position: newPos,
      };
    } catch {
      // Timeout
      const newPos = this._totalBytesEmitted;
      const bytesNew = Math.max(0, newPos - since);
      if (bytesNew > 0) {
        const offset = Math.max(0, this._buffer.length - bytesNew);
        const raw = this._buffer.slice(offset);
        return {
          output: this._truncateOutput(stripAnsi(raw).trim(), maxLines),
          timedOut: true,
          position: newPos,
        };
      }
      return {
        output: "",
        timedOut: true,
        position: newPos,
      };
    }
  }

  /**
   * Wait until totalBytesEmitted exceeds `since` or timeout.
   * Resolves with the new totalBytesEmitted, or rejects on timeout.
   */
  _waitForNewBytes(since, timeout) {
    return new Promise((resolve, reject) => {
      if (this._totalBytesEmitted > since) {
        resolve(this._totalBytesEmitted);
        return;
      }

      const timer = setTimeout(() => {
        this._dataListeners.splice(this._dataListeners.indexOf(onData), 1);
        reject(new Error("timeout"));
      }, timeout);

      const onData = () => {
        if (this._totalBytesEmitted > since) {
          clearTimeout(timer);
          this._dataListeners.splice(this._dataListeners.indexOf(onData), 1);
          resolve(this._totalBytesEmitted);
        }
      };

      this._dataListeners.push(onData);
    });
  }

  /**
   * Watch for patterns in ongoing output.
   * @param {object} opts
   * @param {Array<{id: string, pattern: string, isRegex?: boolean, cooldownMs?: number}>} opts.triggers
   * @param {number} [opts.timeout=300000]
   * @param {number} [opts.quietExitMs] - Return early if silence after first match
   * @param {number} [opts.contextLines=2] - Lines of context before match
   * @param {Function} [opts.sendNotification]
   * @param {string|number} [opts.progressToken]
   * @returns {Promise<{ triggerId: string|null, matchedLine: string, context: string, timedOut: boolean, position: number }>}
   */
  async watch({
    triggers,
    timeout = 300000,
    quietExitMs,
    contextLines = 2,
    sendNotification,
    progressToken,
  }) {
    const compiled = triggers.map((t) => ({
      id: t.id,
      regex: compileUserRegex(t.pattern),
      cooldownMs: t.cooldownMs ?? 0,
      lastFiredAt: 0,
    }));

    const contextBuffer = [];
    let partialLine = "";
    let hasOutput = false;

    const testLine = (line) => {
      const now = Date.now();
      for (const t of compiled) {
        if (now - t.lastFiredAt < t.cooldownMs) continue;
        if (t.regex.test(line)) {
          t.lastFiredAt = now;
          return {
            triggerId: t.id,
            matchedLine: line,
            context: contextBuffer.slice(-contextLines).join("\n"),
            position: this._totalBytesEmitted,
            timedOut: false,
          };
        }
      }
      return null;
    };

    const processCleanLine = (line) => {
      if (!line) return null;
      contextBuffer.push(line);
      if (contextBuffer.length > contextLines * 2 + 1) {
        contextBuffer.shift();
      }
      return testLine(line);
    };

    // Check existing buffer first
    const offset = Math.max(0, this._buffer.length - 4096);
    const existing = this._buffer.slice(offset);
    const existingParts = (partialLine + existing).split(/\r?\n/);
    partialLine = existingParts.pop();
    for (const part of existingParts) {
      const result = processCleanLine(part);
      if (result) return result;
    }

    return new Promise((resolve) => {
      let settled = false;
      let quietTimer;

      const safeResolve = (val) => {
        if (settled) return;
        settled = true;
        clearTimeout(hardTimer);
        clearTimeout(quietTimer);
        const idx = this._dataListeners.indexOf(onData);
        if (idx !== -1) this._dataListeners.splice(idx, 1);
        resolve(val);
      };

      const hardTimer = setTimeout(() => {
        safeResolve({
          triggerId: null,
          matchedLine: "",
          context: "",
          timedOut: true,
          position: this._totalBytesEmitted,
        });
      }, timeout);

      const armQuiet = () => {
        if (!quietExitMs || !hasOutput) return;
        clearTimeout(quietTimer);
        quietTimer = setTimeout(() => {
          safeResolve({
            triggerId: null,
            matchedLine: "",
            context: "",
            timedOut: false,
            position: this._totalBytesEmitted,
          });
        }, quietExitMs);
      };

      const onData = (raw) => {
        hasOutput = true;
        const clean = stripAnsi(raw);
        const parts = (partialLine + clean).split(/\r?\n/);
        partialLine = parts.pop();
        for (const part of parts) {
          const result = processCleanLine(part);
          if (result) {
            safeResolve(result);
            return;
          }
        }
        armQuiet();
      };

      this._dataListeners.push(onData);
      armQuiet();
    });
  }

  resize(cols, rows) {
    if (!this.alive) {
      throw new Error(`Session ${this.id} is no longer alive.`);
    }
    this.cols = cols;
    this.rows = rows;

    if (this._ptyMode === "direct" || this._ptyMode === "helper") {
      // PTY mode: use stty to set window size on the slave PTY
      try {
        if (this._ptySlavePath) {
          execSync(`stty rows ${rows} cols ${cols} < "${this._ptySlavePath}"`);
        }
      } catch {}
      // Also send SIGWINCH so the child knows to re-query
      this.sendSignal("SIGWINCH");
    }
    // Pipe mode: no native resize; just update the stored dimensions
  }

  /**
   * Kill the PTY process and clean up.
   * On Unix, kills the entire process group to prevent orphan children.
   * @param {string} [signal='SIGTERM']
   */
  kill(signal = "SIGTERM") {
    if (!this.alive) return;
    const pid = this.process.pid;
    if (pid != null) {
      if (platform() !== "win32") {
        try {
          // Kill process group
          process.kill(-pid, signal);
        } catch (err) {
          if (err.code !== "ESRCH") {
            try {
              this.process.kill(signal);
            } catch {}
          }
        }
      } else {
        this.process.kill(signal);
      }
    }
    this.alive = false;
    this._cleanupPty();
  }

  /**
   * Get session metadata for terminal_list.
   * @param {object} [opts]
   * @param {boolean} [opts.verbose=true]
   */
  getInfo({ verbose = true } = {}) {
    const baseInfo = {
      id: this.id,
      name: this.name,
      cwd: this.cwd,
      alive: this.alive,
      busy: this.busy,
    };

    if (!verbose) {
      return baseInfo;
    }

    return {
      ...baseInfo,
      shell: this.shell,
      shellType: this.shellType,
      cols: this.cols,
      rows: this.rows,
      createdAt: this.createdAt,
      lastActivity: this.lastActivity,
      idleSeconds: Math.floor((Date.now() - this.lastActivity) / 1000),
    };
  }

  /**
   * Get a window of output lines from the rolling history.
   * @param {object} [opts]
   * @param {number} [opts.offset]
   * @param {number} [opts.limit=200]
   * @param {string} [opts.format='lines']
   * @returns {{ text: string, lineCount: number, totalLines: number }}
   */
  getHistory({
    offset = 0,
    limit = DEFAULT_HISTORY_LIMIT,
    format = DEFAULT_HISTORY_FORMAT,
  } = {}) {
    const len = this._history.length;
    const end = Math.min(len, offset + limit);
    const start = Math.max(0, offset);
    const lines = this._history.slice(start, end);
    const evicted = this._historyTotalLines - len;
    const result = {
      totalLines: this._historyTotalLines,
      returnedFrom: start + evicted,
      returnedTo: end + evicted,
    };

    // format is always 'lines' for now, could support 'text' if needed
    let text;
    if (format === "lines") {
      text = lines.join("\n");
    } else {
      text = lines.join("\n");
    }

    return { ...result, text, lineCount: lines.length };
  }

  _appendToHistory(raw) {
    const clean = stripAnsi(raw);
    const parts = clean.split(/\r?\n/);
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (i === 0 && this._historyPartial) {
        // Continuation of partial line
        this._historyPartial += part;
        if (
          i === parts.length - 1 &&
          clean[clean.length - 1] !== "\n" &&
          clean[clean.length - 1] !== "\r"
        ) {
          // Still partial
          return;
        }
        // Completed line
        this._pushHistoryLine(this._historyPartial);
        this._historyPartial = "";
      } else if (
        i === parts.length - 1 &&
        clean[clean.length - 1] !== "\n" &&
        clean[clean.length - 1] !== "\r"
      ) {
        // Last partial line
        this._historyPartial = part;
      } else {
        this._pushHistoryLine(part);
      }
    }
  }

  _pushHistoryLine(line) {
    this._history.push(line);
    this._historyTotalLines++;
    if (this._history.length > HISTORY_MAX_LINES) {
      this._history.shift();
    }
  }

  _wrapCommand(command, marker, cwdMarker, preMarker) {
    const shellType = this.shellType;
    const escaped = command.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

    if (shellType === "powershell") {
      // CWD echo after command so cd is reflected; capture exit code before CWD echo
      return (
        `${preMarker}; ` +
        `${command}; ` +
        `$__exit=$LASTEXITCODE; ` +
        `Write-Output "${cwdMarker}$(Get-Location)"; ` +
        `Write-Output "Exit:${marker}:$__exit"`
      );
    }

    if (shellType === "cmd") {
      return (
        `${preMarker} && ` +
        `${command} && ` +
        `echo ${cwdMarker}%cd% && ` +
        `echo Exit:${marker}:%errorlevel%`
      );
    }

    // Default: bash/sh/zsh
    // Capture exit code before CWD echo; CWD echo after command so cd is reflected
    return (
      `${preMarker}; ` +
      `${command}; ` +
      `__exit=$?; ` +
      `echo "${cwdMarker}$(pwd)"; ` +
      `echo "Exit:${marker}:$__exit"`
    );
  }

  _resetBuffer() {
    this._buffer = "";
    this._readCursor = 0;
  }

  _consumeUnreadBuffer() {
    const start = Math.min(this._readCursor, this._buffer.length);
    const unread = this._buffer.slice(start);
    this._readCursor = this._buffer.length;
    return unread;
  }

  /**
   * Wait for the completion marker in the output stream.
   * @param {string} marker
   * @param {number} timeout
   * @param {number} [quietExitMs]
   * @param {number} [minOutputBytes]
   * @param {Function} [sendNotification]
   * @param {string|number} [progressToken]
   * @returns {Promise<{buffer: string, reason: 'marker'|'timeout'|'quiet'}>}
   */
  _waitForMarker(
    marker,
    timeout,
    quietExitMs,
    minOutputBytes = 1,
    sendNotification,
    progressToken,
  ) {
    return new Promise((resolve) => {
      const startTime = Date.now();
      let lastProgressAt = 0;
      let bytesSeen = 0;
      let quietTimer;
      let resolved = false;

      const cleanup = () => {
        clearTimeout(timer);
        clearTimeout(quietTimer);
        const idx = this._dataListeners.indexOf(onData);
        if (idx !== -1) this._dataListeners.splice(idx, 1);
      };

      const safeResolve = (val) => {
        if (resolved) return;
        resolved = true;
        cleanup();
        resolve(val);
      };

      const timer = setTimeout(() => {
        safeResolve({ buffer: this._buffer, reason: "timeout" });
      }, timeout);

      const armQuiet = () => {
        if (!quietExitMs || bytesSeen < minOutputBytes) return;
        clearTimeout(quietTimer);
        quietTimer = setTimeout(() => {
          safeResolve({ buffer: this._buffer, reason: "quiet" });
        }, quietExitMs);
      };

      const checkBuffer = () => {
        // The real marker appears as "Exit:__MCP_DONE_xxx__:0" in the output
        // (because we echo it). We must NOT match the marker in the echoed
        // typed command, which contains "Exit:__MCP_DONE_xxx__:$?" — note the
        // literal "$?" instead of a digit. So we check for "Exit:" + marker
        // followed by ":" and a digit, which only the real output has.
        const exitMarkerRegex = new RegExp(
          "Exit:" + escapeRegExp(marker) + ":[0-9]",
        );
        if (exitMarkerRegex.test(this._buffer)) {
          safeResolve({ buffer: this._buffer, reason: "marker" });
        }
      };

      const onData = (_data) => {
        bytesSeen += _data.length;
        // Send progress
        if (
          sendNotification &&
          progressToken &&
          Date.now() - lastProgressAt > 1000
        ) {
          lastProgressAt = Date.now();
          const clean = stripAnsi(this._buffer);
          this._sendProgress(
            sendNotification,
            progressToken,
            clean,
            startTime,
            timeout,
          );
        }
        armQuiet();
        checkBuffer();
      };

      this._dataListeners.push(onData);
      // Check if marker already in buffer
      checkBuffer();
    });
  }

  /**
   * Read output until no new data arrives for idleTimeout ms.
   */
  _readUntilIdle(timeout, idleTimeout) {
    return new Promise((resolve) => {
      let idleTimer;
      let resolved = false;

      const cleanup = () => {
        if (resolved) return;
        resolved = true;
        clearTimeout(hardTimer);
        clearTimeout(idleTimer);
        const idx = this._dataListeners.indexOf(onData);
        if (idx !== -1) this._dataListeners.splice(idx, 1);
      };

      const done = () => {
        cleanup();
        resolve();
      };

      const hardTimer = setTimeout(done, timeout);

      const resetIdle = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(done, idleTimeout);
      };

      const onData = (data) => {
        resetIdle();
      };

      this._dataListeners.push(onData);
      resetIdle();
    });
  }

  /**
   * Parse raw output: strip echoed command using preMarker, extract exit code, extract CWD.
   */
  _parseOutput(raw, marker, cwdMarker, preMarker) {
    const clean = stripAnsi(raw);
    const lines = clean.split(/\r?\n/);
    const outputLines = [];
    let exitCode = null;
    let cwd = null;
    const markerRegex = new RegExp(escapeRegExp(marker) + ":(-?\\d+)$");
    // Match lines like "Exit:__MCP_DONE_xxx__:0" or just "__MCP_DONE_xxx__:0"
    const exitMarkerRegex = new RegExp(
      "^Exit:" + escapeRegExp(marker) + ":(-?\\d+)$",
    );
    const cwdRegex = new RegExp(escapeRegExp(cwdMarker) + "(.*)");
    let foundPreMarker = false;
    let foundExitMarker = false;

    for (const line of lines) {
      const trimmedLine = line.trim();
      // Skip lines containing preMarker (echoed command + any error messages about it)
      if (trimmedLine.includes(preMarker)) {
        foundPreMarker = true;
        continue;
      }
      if (!foundPreMarker) continue;
      if (foundExitMarker) continue;

      const markerMatch =
        trimmedLine.match(exitMarkerRegex) || trimmedLine.match(markerRegex);
      if (markerMatch) {
        exitCode = parseInt(markerMatch[1], 10);
        foundExitMarker = true;
        continue;
      }
      const cwdMatch = trimmedLine.match(cwdRegex);
      if (cwdMatch) {
        cwd = cwdMatch[1];
        continue;
      }
      outputLines.push(line);
    }

    const output = outputLines.join("\n");
    return { output, exitCode, cwd };
  }

  _truncateOutput(output, maxLines) {
    const lines = output.split("\n");
    if (lines.length <= maxLines) return output;
    const headCount = Math.floor(maxLines / 2);
    const tailCount = maxLines - headCount - 1;
    const head = lines.slice(0, headCount);
    const tail = lines.slice(-tailCount);
    const omitted = lines.length - maxLines;
    return [...head, `... (${omitted} lines omitted) ...`, ...tail].join("\n");
  }

  _formatWaitOutput({ output, timedOut, tailLines }) {
    const trimmedOutput = output.trim();
    if (!trimmedOutput) {
      return timedOut ? "(timed out with no output)" : "(no output)";
    }
    return trimmedOutput;
  }

  _tailOutput(output, tailLines) {
    const lines = output.split("\n");
    if (lines.length <= tailLines) return output;
    return lines.slice(-tailLines).join("\n");
  }

  /**
   * Create a rolling line tracker with a maximum capacity.
   * @param {number} maxLines
   */
  _createTailTracker(maxLines) {
    const lines = [];
    let partial = "";
    return {
      maxLines,
      lines,
      partial,
      append(text) {
        const combined = partial + text;
        const parts = combined.split(/\r?\n/);
        partial = parts.pop();
        for (const p of parts) {
          lines.push(p);
          // Evict excess lines from the front
          while (lines.length > maxLines) {
            lines.shift();
          }
        }
        // If the text ends with a newline, the partial was pushed as a complete line
        // but parts.pop() removed it — re-add if it was a real line ending
      },
      tail() {
        return lines.slice(-maxLines).join("\n");
      },
    };
  }

  _appendToTailTracker(tracker, text) {
    tracker.append(text);
  }

  _tailTrackerToOutput(tracker) {
    return tracker.lines.join("\n");
  }

  _sendProgress(sendNotification, progressToken, clean, startTime, timeout) {
    try {
      const lines = clean.split("\n");
      const lastLine = lines[lines.length - 1];
      const elapsed = Date.now() - startTime;
      sendNotification({
        method: "notifications/progress",
        params: {
          progressToken,
          progress: Math.min(Math.floor((elapsed / timeout) * 100), 99),
          total: 100,
          message: lastLine?.slice(0, 100),
        },
      });
    } catch {
      // Silently swallow — progress notifications are best-effort
    }
  }
}
