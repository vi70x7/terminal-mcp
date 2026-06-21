/**
 * PtydClient — JSON-lines client for the ptyd Unix domain socket daemon.
 *
 * Sends requests with auto-incrementing `id`, returns Promises
 * that resolve when the matching response arrives, and emits
 * `output` / `exit` events for server-pushed notifications.
 *
 * Pure ESM — no require(), no native deps.
 */

import { createConnection } from "node:net";

/**
 * Signal name → number mapping (POSIX standard signals).
 */
const SIGNAL_MAP = {
  SIGHUP: 1,
  SIGINT: 2,
  SIGQUIT: 3,
  SIGILL: 4,
  SIGTRAP: 5,
  SIGABRT: 6,
  SIGBUS: 7,
  SIGFPE: 8,
  SIGKILL: 9,
  SIGUSR1: 10,
  SIGSEGV: 11,
  SIGUSR2: 12,
  SIGPIPE: 13,
  SIGALRM: 14,
  SIGTERM: 15,
};

export class PtydClient {
  /**
   * @param {string} socketPath - Path to the ptyd Unix domain socket
   */
  constructor(socketPath) {
    this.socketPath = socketPath;
    /** @type {import('node:net').Socket|null} */
    this._socket = null;
    this._nextId = 1;
    /** @type {Map<number, {{ resolve: Function, reject: Function }>} */
    this._pending = new Map();
    /** @type {Map<string, Set<Function>>} */
    this._listeners = new Map();
    this._connected = false;
    this._buffer = "";
  }

  // ── Event emitter ──────────────────────────────────────────────

  /**
   * Subscribe to an event.
   * @param {string} event - 'output' or 'exit'
   * @param {Function} handler
   */
  on(event, handler) {
    if (!this._listeners.has(event)) {
      this._listeners.set(event, new Set());
    }
    this._listeners.get(event).add(handler);
  }

  /**
   * Unsubscribe from an event.
   * @param {string} event
   * @param {Function} handler
   */
  off(event, handler) {
    const set = this._listeners.get(event);
    if (set) {
      set.delete(handler);
    }
  }

  /**
   * Emit an event to all subscribers.
   * @param {string} event
   * @param {*} data
   */
  _emit(event, data) {
    const set = this._listeners.get(event);
    if (set) {
      for (const handler of set) {
        try {
          handler(data);
        } catch {
          // Swallow handler errors
        }
      }
    }
  }

  // ── Connection lifecycle ────────────────────────────────────────

  /**
   * Connect to the ptyd socket. Returns a promise that resolves when connected.
   * @returns {Promise<void>}
   */
  connect() {
    return new Promise((resolve, reject) => {
      if (this._connected && this._socket && !this._socket.destroyed) {
        resolve();
        return;
      }

      const socket = createConnection(this.socketPath, () => {
        this._connected = true;
        resolve();
      });

      socket.on("error", (err) => {
        if (!this._connected) {
          reject(err);
        } else {
          this._emit("error", err);
        }
      });

      socket.on("close", () => {
        this._connected = false;
        // Reject all pending requests
        for (const [id, { reject: rej }] of this._pending) {
          rej(new Error("Socket closed"));
        }
        this._pending.clear();
        this._emit("disconnect");
      });

      socket.on("data", (chunk) => {
        this._buffer += chunk.toString("utf-8");
        this._processBuffer();
      });

      this._socket = socket;
    });
  }

  /**
   * Disconnect from the ptyd socket.
   */
  disconnect() {
    if (this._socket && !this._socket.destroyed) {
      this._socket.destroy();
    }
    this._connected = false;
    this._socket = null;
    this._buffer = "";
  }

  // ── JSON-lines framing ─────────────────────────────────────────

  /**
   * Process the inbound buffer, extracting complete JSON-lines.
   */
  _processBuffer() {
    let idx;
    while ((idx = this._buffer.indexOf("\n")) !== -1) {
      const line = this._buffer.slice(0, idx).trim();
      this._buffer = this._buffer.slice(idx + 1);
      if (line.length === 0) continue;
      try {
        const msg = JSON.parse(line);
        this._handleMessage(msg);
      } catch {
        // Malformed line — skip
      }
    }
  }

  /**
   * Route a parsed JSON message: response (has `id`) or event (has `type`).
   */
  _handleMessage(msg) {
    if (msg.id !== undefined) {
      // Response to a pending request
      const pending = this._pending.get(msg.id);
      if (pending) {
        this._pending.delete(msg.id);
        if (msg.error !== undefined) {
          pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
        } else {
          pending.resolve(msg.result);
        }
      }
    } else if (msg.type === "output") {
      // Server-pushed output event — decode base64 data
      const decoded = atob(msg.data);
      this._emit("output", {
        sessionId: msg.sessionId,
        data: decoded,
        bytesEmitted: msg.bytesEmitted,
      });
    } else if (msg.type === "exit") {
      this._emit("exit", {
        sessionId: msg.sessionId,
        exitCode: msg.exitCode,
      });
    }
  }

  // ── Request methods ────────────────────────────────────────────

  /**
   * Send a request and return a Promise that resolves with the result.
   * @param {string} method
   * @param {object} [params={}]
   * @returns {Promise<object>}
   */
  _request(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this._connected || !this._socket || this._socket.destroyed) {
        reject(new Error("Not connected to ptyd"));
        return;
      }
      const id = this._nextId++;
      const msg = JSON.stringify({ id, method, params }) + "\n";
      this._pending.set(id, { resolve, reject });
      this._socket.write(msg, "utf-8");
    });
  }

  /**
   * Start a new PTY session in ptyd.
   * @param {object} params
   * @param {string} params.id - Session ID
   * @param {string} params.shell - Shell binary path
   * @param {number} [params.cols=80] - Terminal columns
   * @param {number} [params.rows=24] - Terminal rows
   * @param {string} [params.cwd] - Working directory
   * @param {object} [params.env] - Environment variables
   * @returns {Promise<{id: string, pid: number, cols: number, rows: number, slavePath: string, alive: boolean}>}
   */
  start(params) {
    return this._request("start", params);
  }

  /**
   * Write data to a PTY session.
   * @param {string} sessionId
   * @param {string} data - Raw string data to write
   * @returns {Promise<{bytesWritten: number}>}
   */
  write(sessionId, data) {
    return this._request("write", { id: sessionId, data });
  }

  /**
   * Resize a PTY session.
   * @param {string} sessionId
   * @param {number} cols
   * @param {number} rows
   * @returns {Promise<{ok: boolean}>}
   */
  resize(sessionId, cols, rows) {
    return this._request("resize", { id: sessionId, cols, rows });
  }

  /**
   * Send a signal to a PTY session.
   * @param {string} sessionId
   * @param {number} signal - Signal number (e.g. 2 for SIGINT)
   * @returns {Promise<{ok: boolean}>}
   */
  signal(sessionId, signal) {
    return this._request("signal", { id: sessionId, signal });
  }

  /**
   * Kill a PTY session.
   * @param {string} sessionId
   * @returns {Promise<{ok: boolean}>}
   */
  kill(sessionId) {
    return this._request("kill", { id: sessionId });
  }

  /**
   * List all active PTY sessions.
   * @returns {Promise<{sessions: Array}>}
   */
  list() {
    return this._request("list", {});
  }

  /**
   * Shut down the ptyd daemon.
   * @returns {Promise<{ok: boolean}>}
   */
  shutdown() {
    return this._request("shutdown", {});
  }

  // ── Static helpers ─────────────────────────────────────────────

  /**
   * Map a signal name to its number.
   * @param {string} name - e.g. 'SIGINT', 'SIGTERM'
   * @returns {number|undefined}
   */
  static signalNumber(name) {
    return SIGNAL_MAP[name];
  }

  /**
   * Default socket path for the current user.
   * @returns {string}
   */
  static defaultSocketPath() {
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    return `/tmp/ptyd-${uid}.sock`;
  }
}
