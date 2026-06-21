# RULES.md

Task-specific rules for agents working on smart-terminal-mcp.
Read §0 before any code change. Read other sections as needed.

## §0: Agent SOP

The planning → delegation → review loop for code changes.

### Step 1: Analyze & Plan

Use jcodemunch to understand scope and risk before delegating:

1. `plan_turn(repo="vi70x4/smart-terminal-mcp", query="...")` — opening move. Returns confidence + recommended symbols.
2. `search_symbols` / `get_file_outline` — find exact symbols involved.
3. `get_blast_radius(symbol="...", include_source=true, depth=2)` — check downstream impact before planning.
4. `get_hotspots` / `find_dead_code` — identify risk areas related to the task.
5. `get_dependency_graph(file="...", direction="both")` — map module boundaries.

Break the work into the smallest logical steps. One step per delegation.

### Step 2: Delegate

Use `spawn_agent` for every code change. Every prompt MUST include:

- **Repo identifier**: `vi70x4/smart-terminal-mcp`
- **Target symbol_ids** the subagent needs to read or modify
- **jcodemunch mandate** — the subagent must use `get_file_outline` before reading any file, and `search_symbols` / `get_symbol_source` instead of reading whole files
- **Token budget** when using `get_ranked_context` or `get_context_bundle`
- **Full context** — `spawn_agent` is stateless; it knows nothing from prior turns

Delegation preamble template:

```
You are working in repo "vi70x4/smart-terminal-mcp" (indexed via jcodemunch-mcp).
Mandatory: use jcodemunch tools for ALL code lookup. Never read a full file.
- get_file_outline before pulling source
- search_symbols / get_symbol_source for targeted retrieval
- Batch with symbol_ids[] instead of repeated calls
- get_ranked_context(query="...", token_budget=4000) for task-driven context

Target symbols: <list symbol_ids>
```

Delegate only the immediate next step. Do not bundle multiple steps.

If the subagent should parallelize, include the phrase "fan out subagents" in the prompt. If you ARE the spawned subagent, do the work directly — do not recursively spawn unless explicitly told to fan out.

### Step 3: Review

After the subagent returns, verify with jcodemunch:

- `get_blast_radius(symbol="...", include_source=true)` — confirm the change's impact matches expectations
- `find_references(identifier="...")` — verify no call site is broken
- `get_call_hierarchy(symbol_id="...", direction="callers")` — trace upstream dependents
- `get_symbol_source(symbol_id="...", verify=true)` — confirm the indexed source matches what was written
- `register_edit(file_paths=["..."], reindex=true)` — keep the index fresh
- Run `npm test` to validate the change

If approved, move to the next step. If revision is needed, delegate again with: the repo id, the updated symbol_ids, corrective feedback, and instruction to `get_symbol_source` the current state of affected symbols.

## §1: Testing

- Test framework: Node built-in test runner (`node --test`), no external test libraries
- Run: `npm test` from the project root
- E2E tests (`test/e2e-pty-*.test.js`) require a Unix PTY — they will skip or fail in environments without PTY support (containers, some CI)
- Unit tests (`test/ansi.test.js`, `test/command-parsers.test.js`, etc.) run anywhere
- No coverage tool is configured — check correctness by running the suite, not by coverage percentage
- Tests share a `TIMEOUT` constant (typically 10s); do not add tests with shorter timeouts than the session startup banner wait (~3s)

## §2: Architecture

### Core data flow

```
MCP client → tools.js (Zod validation) → session-manager.js → pty-session.js (spawn PTY)
                                    ↘ command-runner.js (one-shot, no PTY)
```

- `tools.js` owns all MCP tool registration and Zod schemas. Tool names, descriptions, and parameter defaults all live here.
- `pty-session.js` is the largest file (~1300 lines) and the heart of the project. It owns: marker-based command completion, idle-output reading, buffer management, rolling history, and the watch/wait-for-pattern event loop.
- `command-runner.js` is independent of sessions — it spawns a bare child process, not a PTY. Used by `terminal_run` and `terminal_run_paged`.
- `command-parsers.js` is purely functional — no state, no side effects. Each parser function matches a specific `cmd + args` signature and returns structured JSON.

### Key invariants

- `PtySession` instances are managed exclusively through `SessionManager`. Call `manager.create()` / `manager.get()` / `manager.stop()`, never instantiate `PtySession` directly in tools.
- Sessions cap at 10 concurrent. TTL is 30 minutes. `manager._cleanupExpired()` runs every 60s.
- PTY output buffer caps at 1MB (`MAX_BUFFER_BYTES`). Rolling history holds 10,000 lines (`HISTORY_MAX_LINES`).
- Marker strings for command completion are UUIDs generated per-exec. Never hardcode or reuse markers.
- `terminal_write_file` resolves paths relative to `session.cwd`. Never resolve relative to the server process CWD.

### Tool registration model

`tools.js` reads `SMART_TERMINAL_DISABLED_TOOLS` at startup. Tools not in that set get full MCP schemas; tools in the set get collected behind the `terminal_extra` meta-tool. The default moves 8 convenience tools behind `terminal_extra` to reduce tool-definition token overhead. Set the env var to empty string to register all 15 tools with full schemas.

When adding a new tool: add it via the `tool()` helper in `registerTools`. If it should be extra by default, add its name to `DEFAULT_EXTRA`.

### Cross-platform considerations

- `shell-detector.js` picks shell on startup: Windows → `pwsh.exe` > `powershell.exe` > `cmd.exe`. Unix → `$SHELL` > `bash` > `sh`.
- `command-runner.js` has extensive Windows PATH/PATHEXT resolution and `.cmd`/`.bat` handling. Changes to command resolution must be tested on both platforms.
- `buildSpawnPlan()` in `command-runner.js` is the single source of truth for how a command string becomes a `child_process.spawn()` call.

## §3: Release and Publishing

- `scripts/publish.js` handles the full release: version bump → `server-card.json` generation → `server.json` sync → git tag → npm publish
- It parses and rewrites source using Babel (for `server-card.json` import injection), so changes to import structure in `index.js` may need publish.js updates
- The `stable` npm dist-tag is managed manually: `npm run stable` points it at a pinned version
- `smithery.yaml`, `smithery.json`, and `server.json` are consumed by the Smithery registry and MCP registry respectively. Schema changes to `server-card.json` must stay in sync with both.

## §4: PTY and Terminal Quirks

These are learned-the-hard-way constraints that surface when working on `pty-session.js` or `command-runner.js`:

- **Marker injection**: Exec commands are wrapped as `{preMarker} {command} && echo {marker} || echo {marker} {exitCode}`. The preMarker prevents shell echo from polluting output. Changing the wrap format changes marker detection.
- **CR/LF handling**: PTY output uses `\r\n`. The `_parseOutput` method strips echoed commands using preMarker boundaries. Any change to how the command is echoed (e.g. shell PS1 changes) can break output parsing.
- **Process group kill**: On Unix, `terminal_stop` calls `kill(-pid)` to kill the entire process group. This prevents orphan child processes (e.g. `npm run dev` → webpack → esbuild). If you change kill behavior, test with nested process trees.
- **ANSI stripping pipeline**: `applyEraseInLine` → `simulateBackspace` → `collapseCarriageReturns` → `stripAnsi`. Order matters — erase-in-line must be processed before backspace simulation.
- **Quiet-exit detection**: `quietExitMs` arms a timer that resets on every data event. It only triggers after `minOutputBytes` of output has been received. This prevents false-early-return on commands that produce nothing (exit 0 instantly).
- **Watch trigger cooldowns**: Each trigger has an independent `lastFiredAt` timestamp. Cooldowns prevent rapid re-firing on repeated matches. Changing this affects log-watching workflows.
- **Buffer overflow**: When `_totalBytesEmitted` exceeds `MAX_BUFFER_BYTES` (1MB), new data is silently dropped. The rolling history still retains the last 10K lines. If you increase `MAX_BUFFER_BYTES`, consider memory implications for the 10-session cap.
