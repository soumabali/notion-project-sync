---
name: notion-project-sync
description: "Sync status-tracked project markdown files with a Notion database through configurable REST operations, while keeping credentials out of repository files and protecting local changes from silent conflicts."
---

# notion-project-sync

Reusable, config-driven sync between status-tracked markdown files and a Notion
 database. The default tracked paths are `03-phases/`, `04-tasks/`, and
`05-progress/`. Copy this skill into a project, commit its configuration, and
keep credentials in environment variables only.

## Requirements

- Node.js 20 or newer.
- A Notion integration with access to the target database.
- Notion API version `2022-06-28` (the default `notion.apiVersion`).
- A committed `.notion-sync.json` at the consuming project root.
- `NOTION_TOKEN` and `NOTION_DATABASE_ID`, or the environment-variable names
  configured by `notion.tokenEnv` and `notion.databaseIdEnv`.

The token and database ID are secret values. Never commit them, put them in
`.notion-sync.json`, print them, or include them in examples. Use a local `.env`
file excluded by `.gitignore`, a process environment, or a secret manager.

## Setup

From the consuming project root:

```bash
node skills/notion-project-sync/engine.mjs init
node skills/notion-project-sync/engine.mjs doctor --offline
```

`init` creates `.notion-sync.json` only when it does not already exist. It
refuses to overwrite an existing file. Add `--install-hooks` only when the
project should install additive, idempotent SessionStart and PostToolUse hooks
in `.claude/settings.json`.

Set the credentials in the local environment, then run the online diagnostics:

```bash
node skills/notion-project-sync/engine.mjs doctor
```

## Configuration

`.notion-sync.json` contains project metadata and API/property configuration,
never secret values. The schema is `config.schema.json`; a reusable example is
`.notion-sync.example.json`.

```json
{
  "$schema": "./skills/notion-project-sync/config.schema.json",
  "version": 1,
  "projectSlug": "example-project",
  "trackedPrefixes": ["03-phases/", "04-tasks/", "05-progress/"],
  "statePath": "tooling/.notion-sync-state.json",
  "syncBody": false,
  "notion": {
    "apiBaseUrl": "https://api.notion.com/v1",
    "apiVersion": "2022-06-28",
    "tokenEnv": "NOTION_TOKEN",
    "databaseIdEnv": "NOTION_DATABASE_ID",
    "properties": {
      "name": "Name",
      "externalId": "External ID",
      "parentId": "Parent item",
      "type": "Type",
      "status": "Status",
      "phase": "Phase",
      "owner": "Owner",
      "securitySensitive": "Security Sensitive",
      "changelogEntry": "Changelog Entry",
      "path": "Path",
      "localUpdated": "Local Updated"
    }
  },
  "statusMapping": {
    "backlog": "Backlog",
    "todo": "Todo",
    "in-progress": "In progress",
    "testing": "Testing",
    "blocked": "Blocked",
    "in-review": "In Review",
    "done": "Done"
  },
  "artifactTypes": {
    "03-phases/": "Phase",
    "04-tasks/hotfix/": "Hotfix",
    "04-tasks/": "Task",
    "05-progress/": "Progress"
  },
  "retry": { "maxAttempts": 3, "timeoutMs": 10000 }
}
```

`projectSlug` prefixes each Notion External ID and should remain stable after
first sync. `trackedPrefixes` controls which markdown files commands discover.
`statePath` stores local sync metadata and should be gitignored.

### Body privacy

`syncBody: false` syncs database properties only and makes no Notion block API
calls. `syncBody: true` also replaces the page body with markdown-derived
blocks. Body sync is disabled in the generic example; enable it deliberately
when project markdown may be copied to Notion. Tokens, responses, request bodies,
and markdown bodies are not written to failure state or diagnostics.

## CLI

```bash
node skills/notion-project-sync/engine.mjs <command> [options]
```

- `init [--install-hooks]` — create `.notion-sync.json` from defaults.
  Create-only: refuses to overwrite an existing config. `--install-hooks`
  additionally wires the SessionStart/PostToolUse hooks into
  `.claude/settings.json`; omit it to leave hooks untouched.
- `status` / `sync-status` — print the same operational summary
  (`tracked_files`, `tracked_records`, `synced`, `failed`, `last_sync_at`).
  `status` is a plain alias.
- `doctor [--offline]` — read-only diagnostics, printed as one redacted JSON
  report (`{ command, mode, ok, diagnostics[] }`); never creates, renames, or
  deletes anything in Notion.
  - Always checks: config file exists/parses, required keys present,
    `statusMapping` covers exactly the seven canonical statuses, and
    `tokenEnv`/`databaseIdEnv` are configured as env-var *names* (not values).
  - `--offline` stops there — no network call, no credentials required.
  - Online mode (default) additionally reads the env vars named by the config
    and does one `GET` on the Notion database to compare its `Status`
    property options against `statusMapping`: a configured status missing
    remotely is a **failure** (exit code 1); an extra remote option not in the
    mapping is a **warning** only (exit code stays 0 unless another failure
    exists).
  - Diagnostics never include raw token/database-id values or response
    bodies — only config field names and status names.
- `push <file>` — create or update one Notion page by External ID. Duplicate
  matches refuse to create a page.
- `push-all` — push every tracked markdown file. Individual failures are
  reported and produce a non-zero exit code.
- `push-if-tracked` — consume a Claude Code PostToolUse JSON event from stdin;
  push only when its file path matches `trackedPrefixes`. A push failure is
  fail-open: the local write remains successful.
- `pull` — inspect tracked files and update local status only when safe. Remote
  unknown statuses are reported; conflicts are reported and not overwritten.

## Status contract and conflict safety

The seven canonical local statuses are `backlog`, `todo`, `in-progress`,
`testing`, `blocked`, `in-review`, and `done`. Mapping values are the matching
Notion status option names. `not-started` is not supported.

Pull records the last successfully synced status. If both local and remote
status changed since that sync, it reports a conflict, leaves the local file
unchanged, and exits non-zero. Resolve the disagreement manually, then sync
again. It never silently overwrites local work. Unknown remote status names are
also left untouched until the mapping or Notion row is corrected.

## REST, hooks, and MCP boundary

SessionStart and PostToolUse hooks run the Node CLI and use the Notion REST API.
They cannot call MCP interactively; MCP servers are not a hook transport.
`push-if-tracked` is therefore REST-via-hooks only. Pull is manual or invoked by
the SessionStart hook. MCP may be used separately for interactive Notion work,
but it is not required by this skill and does not replace the sync engine.

`doctor` online performs a read-only database schema check. The engine does
not create or repair databases, properties, or status options.

## Operational safety

- `doctor` never mutates Notion.
- `init` never overwrites configuration.
- Credentials are environment-only.
- State failures are redacted.
- Hooks are additive and idempotent.
- Hook push is fail-open so local edits are not blocked.
- No live network call is needed for `doctor --offline`, configuration checks,
  or the automated tests.

## Non-goals

- Notion webhooks or real-time remote-to-local sync.
- MCP calls from hooks.
- Automatic database/property creation or repair.
- Full YAML parsing.
- Secret scanning.
- Body merge or conflict resolution.
- npm publication or remote repository operations.

## Open-source use

The skill is MIT licensed. Copy `skills/notion-project-sync/` into another
project, retain its license and schema, create a project-specific
`.notion-sync.json`, and review tracked paths and property names before enabling
hooks. Keep project credentials and sync state outside committed files.
