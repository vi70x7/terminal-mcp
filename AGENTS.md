# smart-terminal-mcp

PTY-based MCP server that gives AI agents persistent, interactive terminal access. Pure ESM JavaScript, Node 20+, no native build step.

## Structure

```
src/
  index.js            Server bootstrap, graceful shutdown, Smithery scan detection
  tools.js            MCP tool registrations (15 tools) with Zod schemas
  pty-session.js      PTY session: marker-based completion, idle reads, buffer/history, watch
  session-manager.js  Session lifecycle, TTL cleanup, concurrency limits (max 10)
  command-runner.js   One-shot non-interactive exec (shell=false), structured parsing, Windows PATH resolution
  command-parsers.js  Structured parsers for git/tasklist/which read-only commands
  smart-tools.js      Retry (with backoff) and diff helpers for higher-level tools
  ansi.js             ANSI stripping, CR collapse, erase-in-line simulation
  shell-detector.js   Cross-platform shell auto-detection
  session-id.js       Human-readable session IDs (adjective-noun pairs)
  pager.js            Line-based pagination for large stdout
  regex-utils.js      User-regex validation and compilation (nested-quantifier guard)
scripts/
  publish.js          Version bump, server-card.json generation, npm publish, git tag
test/                 Node built-in test runner (node --test), 14 files
```

## Commands

- `npm start` — run the server
- `npm test` — run all tests (`node --test`)

No build, no transpile, no typecheck. The project is pure JavaScript ESM.

## Rules

- Delegate all code changes via `spawn_agent` — never edit source files directly
- Run `npm test` after any code change; e2e tests require a Unix PTY
- Use npm, not yarn or pnpm
- Never commit `.env`, secrets, or credentials
- After delegated edits land, call `register_edit` to keep the jcodemunch index fresh

## Delegation

`spawn_agent` is stateless — every prompt must include the full context. Always pass: repo id (`vi70x4/smart-terminal-mcp`), target symbol_ids, jcodemunch lookup mandate, and all relevant surrounding context.

## Further Reference

- `RULES.md §0` — agent SOP: plan → delegate → review loop
- `RULES.md §1–§4` — project-specific rules (testing, architecture, release, PTY quirks)
- `README.md` — full tool API reference, usage examples, and configuration
- `CHANGELOG.md` — version history and breaking changes
- `.agents/skills/jcodemunch-guide/` — detailed jcodemunch workflow patterns

## jcodemunch

Repo: `vi70x4/smart-terminal-mcp`
- `plan_turn` → `get_file_outline` → `get_symbol_source` — explore before pulling source
- `search_symbols` / `get_context_bundle` — targeted retrieval, never read full files
- `get_blast_radius(symbol=..., include_source=true)` — check impact before approving changes
- `register_edit(reindex=true)` after any file write — keep the index fresh
- Symbol ID format: `src/pty-session.js::PtySession#class`
