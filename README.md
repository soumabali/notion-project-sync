# Notion Project Sync

Reusable, MIT-licensed Claude Code skill for syncing status-tracked Markdown files with a Notion database. Requires Node.js 20+.

## What it does

- Pushes tracked Markdown records to Notion through the REST API.
- Uses stable External IDs for create/update safety.
- Links child records through Notion relation properties (`Parent item` / `Sub-item`).
- Supports `backlog`, `todo`, `in-progress`, `testing`, `blocked`, `in-review`, and `done`.
- Pulls remote status changes without overwriting local conflicts.
- Provides offline and online read-only diagnostics.
- Installs additive, idempotent Claude Code hooks.

## Install in a project

Clone the skill, then copy it into the consuming project:

```bash
git clone https://github.com/soumabali/notion-project-sync.git
cp -R notion-project-sync /path/to/your-project/skills/notion-project-sync
cd /path/to/your-project
node skills/notion-project-sync/engine.mjs init
node skills/notion-project-sync/engine.mjs doctor --offline
```

`init` creates `.notion-sync.json` only when absent. It refuses to overwrite an existing configuration.

Copy `.notion-sync.example.json` when you need a starting point with editable defaults. The `examples/` directory contains a complete example and Claude Code hook settings.

### Claude Code skill installation

Claude Code loads skills from a project's `.claude/skills/` directory or a user-level `~/.claude/skills/` directory. To install this as a discoverable skill:

```bash
mkdir -p .claude/skills
cp -R skills/notion-project-sync .claude/skills/notion-project-sync
```

Keep the executable engine path in your project configuration and hooks. If the skill is installed under `.claude/skills/`, use:

```bash
node .claude/skills/notion-project-sync/engine.mjs init
```

The skill can also remain under `skills/notion-project-sync/`; Claude Code documentation and hooks may refer to that path directly.

## Credentials

Credentials are environment-only. Set the variables named by `notion.tokenEnv` and `notion.databaseIdEnv` (defaults: `NOTION_TOKEN` and `NOTION_DATABASE_ID`) through a local ignored `.env`, process environment, or secret manager.

Never commit token values, database IDs, passwords, request bodies, response bodies, or Markdown bodies. The engine does not persist raw credentials or payloads in diagnostics or failure state.

```bash
export NOTION_TOKEN='your-integration-token'
export NOTION_DATABASE_ID='your-database-id'
node skills/notion-project-sync/engine.mjs doctor
```

Share the target Notion database with the integration before syncing.

## Configuration

`.notion-sync.json` is project configuration, not a credential file. Use `config.schema.json` for editor validation.

Required concepts:

- `projectSlug`: stable prefix for Notion External IDs. Do not change after first sync.
- `trackedPrefixes`: directories discovered by `push-all`, `pull`, and hooks.
- `statePath`: local sync metadata path; add it to `.gitignore`.
- `syncBody`: `false` syncs properties only; `true` also copies Markdown into page blocks.
- `notion.properties.parentId`: the Notion relation property paired with `Sub-item`, commonly `Parent item`.
- `statusMapping`: exactly seven canonical local statuses mapped to Notion status option names.
- `artifactTypes`: path-prefix rules for Notion select values.
- `retry`: bounded transient-request retries and timeout.

Notion database must provide configured properties with these types:

| Config key | Notion type |
| --- | --- |
| `name` | `title` |
| `externalId` | `rich_text` |
| `parentId` | `relation` |
| `type` | `select` |
| `status` | `status` |
| `phase` | `rich_text` |
| `owner` | `rich_text` |
| `securitySensitive` | `checkbox` |
| `changelogEntry` | `select` |
| `path` | `rich_text` |
| `localUpdated` | `date` |

The relation property should be created in Notion so Notion exposes its paired sub-item relation. `doctor` reports schema drift but never mutates the database.

## Commands

Run from consuming project root:

```bash
node skills/notion-project-sync/engine.mjs <command> [options]
```

| Command | Behavior |
| --- | --- |
| `init [--install-hooks]` | Create config once; optionally install additive hooks. |
| `status` | Alias for `sync-status`. |
| `sync-status` | Print tracked-file, sync, failure, and latest-sync summary. |
| `doctor` | Read-only local and online schema diagnostics. |
| `doctor --offline` | Local diagnostics only; no credentials or network. |
| `push <file>` | Create/update one page by External ID. |
| `push-all` | Push every tracked Markdown file. |
| `push-if-tracked` | Consume Claude Code PostToolUse JSON and push a matching file. |
| `pull` | Pull safe remote status changes into tracked files. |

## Claude Code hooks

Install hooks explicitly:

```bash
node skills/notion-project-sync/engine.mjs init --install-hooks
```

This adds `SessionStart` pull and `PostToolUse` push-if-tracked commands without deleting existing settings. Re-running is idempotent. Malformed or structurally unsafe settings are rejected without rewriting.

Hooks call the Notion REST API. They cannot invoke MCP interactively; MCP is not a hook transport. Interactive MCP work remains separate and is not required by this skill.

## Status and conflict safety

Canonical statuses:

```text
backlog | todo | in-progress | testing | blocked | in-review | done
```

`not-started` is unsupported. `pull` stores the last synced status. If both local and remote status changed, it reports a conflict and leaves the local file unchanged. Unknown remote statuses are also left untouched. Resolve manually, then sync again.

Hook pushes are fail-open: a failed push reports an error but does not undo or block the local write. `doctor` is read-only against Notion.

## Testing

No runtime dependency installation is required:

```bash
node --check engine.mjs
node --test tests/*.test.mjs
git diff --check
```

Tests use Node's built-in `node:test` and never call live Notion services.

## License

MIT. See [LICENSE](LICENSE).
