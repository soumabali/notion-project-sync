#!/usr/bin/env node
// Configurable Notion sync engine. No credentials are read until a network operation runs.
import * as defaultFs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ENGINE_FILE = fileURLToPath(import.meta.url);

const defaultOperations = {
  fs: defaultFs,
  env: process.env,
  fetch: (...args) => globalThis.fetch(...args),
  clock: () => new Date(),
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

function now(clock) {
  return clock().toISOString();
}

function fileApi(fs) {
  return {
    readFileSync: fs.readFileSync,
    writeFileSync: fs.writeFileSync,
    existsSync: fs.existsSync,
    mkdirSync: fs.mkdirSync,
    globSync: fs.globSync,
  };
}

function readConfigFile(root, fs) {
  const { existsSync, readFileSync } = fileApi(fs);
  const configPath = path.join(root, '.notion-sync.json');
  return existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf8')) : {};
}

const DEFAULT_CONFIG = {
  version: 1,
  projectSlug: 'my-project',
  trackedPrefixes: ['03-phases/', '04-tasks/', '05-progress/'],
  statePath: 'tooling/.notion-sync-state.json',
  syncBody: true,
  notion: {
    apiBaseUrl: 'https://api.notion.com/v1',
    apiVersion: '2022-06-28',
    tokenEnv: 'NOTION_TOKEN',
    databaseIdEnv: 'NOTION_DATABASE_ID',
    properties: {
      name: 'Name',
      externalId: 'External ID',
      parentId: 'Parent item',
      type: 'Type',
      status: 'Status',
      phase: 'Phase',
      owner: 'Owner',
      securitySensitive: 'Security Sensitive',
      changelogEntry: 'Changelog Entry',
      path: 'Path',
      localUpdated: 'Local Updated',
    },
  },
  statusMapping: {
    backlog: 'Backlog',
    todo: 'Todo',
    'in-progress': 'In progress',
    testing: 'Testing',
    blocked: 'Blocked',
    'in-review': 'In Review',
    done: 'Done',
  },
  artifactTypes: {
    '03-phases/': 'Phase',
    '04-tasks/hotfix/': 'Hotfix',
    '04-tasks/': 'Task',
    '05-progress/': 'Progress',
  },
  retry: { maxAttempts: 3, timeoutMs: 10_000 },
};

function mergeConfig(base, override = {}) {
  const baseNotion = base.notion || {};
  const baseProperties = baseNotion.properties || {};
  return {
    ...base,
    ...override,
    notion: {
      ...baseNotion,
      ...(override.notion || {}),
      properties: {
        ...baseProperties,
        ...(override.notion?.properties || {}),
      },
    },
    retry: { ...(base.retry || {}), ...(override.retry || {}) },
  };
}

export function loadConfig(root = process.cwd(), overrides = {}, fs = defaultFs) {
  const fileConfig = readConfigFile(root, fs);
  return mergeConfig(DEFAULT_CONFIG, mergeConfig(fileConfig, overrides));
}

const CANONICAL_STATUSES = Object.keys(DEFAULT_CONFIG.statusMapping);
const CONFIG_KEYS = new Set(['$schema', 'version', 'projectSlug', 'trackedPrefixes', 'statePath', 'syncBody', 'notion', 'statusMapping', 'artifactTypes', 'retry']);

function diagnostic(severity, code, message, field) {
  return { severity, code, message, ...(field ? { field } : {}) };
}

function validateLocalConfig(root, fs = defaultFs) {
  const { existsSync, readFileSync } = fileApi(fs);
  const diagnostics = [];
  const configPath = path.join(root, '.notion-sync.json');
  if (!existsSync(configPath)) return [diagnostic('failure', 'config_missing', '.notion-sync.json is missing')];
  let raw;
  try {
    raw = JSON.parse(readFileSync(configPath, 'utf8'));
  } catch {
    return [diagnostic('failure', 'config_invalid_json', '.notion-sync.json is not valid JSON')];
  }
  for (const key of Object.keys(raw)) {
    if (!CONFIG_KEYS.has(key)) diagnostics.push(diagnostic('failure', 'config_unknown_key', `unknown config key: ${key}`, key));
  }
  for (const key of ['version', 'projectSlug', 'trackedPrefixes', 'statusMapping']) {
    if (raw[key] === undefined) diagnostics.push(diagnostic('failure', 'config_missing_key', `missing config key: ${key}`, key));
  }
  if (raw.version !== undefined && raw.version !== 1) diagnostics.push(diagnostic('failure', 'config_invalid_version', 'config version must be 1', 'version'));
  if (raw.projectSlug !== undefined && (typeof raw.projectSlug !== 'string' || !raw.projectSlug)) diagnostics.push(diagnostic('failure', 'config_invalid_value', 'projectSlug must be a non-empty string', 'projectSlug'));
  if (raw.trackedPrefixes !== undefined && (!Array.isArray(raw.trackedPrefixes) || raw.trackedPrefixes.length === 0 || raw.trackedPrefixes.some((prefix) => typeof prefix !== 'string'))) {
    diagnostics.push(diagnostic('failure', 'config_invalid_value', 'trackedPrefixes must be a non-empty string array', 'trackedPrefixes'));
  }
  if (raw.statusMapping !== undefined) {
    if (!raw.statusMapping || typeof raw.statusMapping !== 'object' || Array.isArray(raw.statusMapping)) {
      diagnostics.push(diagnostic('failure', 'config_invalid_value', 'statusMapping must be an object', 'statusMapping'));
    } else {
      for (const status of CANONICAL_STATUSES) if (typeof raw.statusMapping[status] !== 'string' || !raw.statusMapping[status]) diagnostics.push(diagnostic('failure', 'config_missing_status', `statusMapping must define ${status}`, `statusMapping.${status}`));
      for (const status of Object.keys(raw.statusMapping)) if (!CANONICAL_STATUSES.includes(status)) diagnostics.push(diagnostic('failure', 'config_unknown_status', `statusMapping has unknown status: ${status}`, `statusMapping.${status}`));
    }
  }
  if (raw.notion) {
    const notion = raw.notion;
    for (const key of ['tokenEnv', 'databaseIdEnv']) {
      if (typeof notion[key] !== 'string' || !/^[A-Z][A-Z0-9_]*$/.test(notion[key])) diagnostics.push(diagnostic('failure', 'env_name_invalid', `${key} must be an uppercase environment variable name`, `notion.${key}`));
    }
  }
  return diagnostics;
}

function envDiagnostics(config) {
  const diagnostics = [];
  for (const key of ['tokenEnv', 'databaseIdEnv']) {
    if (!config.notion[key]) diagnostics.push(diagnostic('failure', 'env_name_missing', `${key} is not configured`, `notion.${key}`));
  }
  return diagnostics;
}

function hasFailure(diagnostics) {
  return diagnostics.some(({ severity }) => severity === 'failure');
}

function initConfig(root, fs = defaultFs) {
  const { existsSync, writeFileSync } = fileApi(fs);
  const configPath = path.join(root, '.notion-sync.json');
  if (existsSync(configPath)) throw new Error('.notion-sync.json already exists; refusing to overwrite');
  const config = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  config.$schema = path.relative(root, path.join(path.dirname(ENGINE_FILE), 'config.schema.json')).split(path.sep).join('/');
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}
`, 'utf8');
}

export function installHooks(root, fs = defaultFs) {
  const { existsSync, readFileSync, mkdirSync, writeFileSync } = fileApi(fs);
  const settingsPath = path.join(root, '.claude', 'settings.json');
  let settings = {};
  if (existsSync(settingsPath)) {
    try {
      settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    } catch (error) {
      throw new Error(`.claude/settings.json is not valid JSON: ${error.message}`);
    }
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('.claude/settings.json must contain a JSON object');
    if (settings.hooks !== undefined && (!settings.hooks || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks))) {
      throw new Error('.claude/settings.json hooks must be a JSON object');
    }
    for (const [event, eventHooks] of Object.entries(settings.hooks || {})) {
      if (!Array.isArray(eventHooks)) throw new Error(`.claude/settings.json hooks.${event} must be an array`);
      for (const group of eventHooks) {
        if (!group || typeof group !== 'object' || Array.isArray(group)) throw new Error(`.claude/settings.json hooks.${event} groups must be objects`);
        if (group.hooks !== undefined && !Array.isArray(group.hooks)) throw new Error(`.claude/settings.json hooks.${event}.hooks must be an array`);
      }
    }
  }
  let changed = false;
  if (!settings.hooks) {
    settings.hooks = {};
    changed = true;
  }
  // Point the hooks at wherever this engine actually lives relative to the
  // project root, not at a fixed wrapper path — the skill may be copied
  // into skills/, .claude/skills/, or anywhere else.
  const enginePath = path.relative(root, ENGINE_FILE).split(path.sep).join('/');
  const hooks = {
    SessionStart: `[ -f .env ] && set -a && . ./.env && set +a; node ${enginePath} pull`,
    PostToolUse: `[ -f .env ] && set -a && . ./.env && set +a; node ${enginePath} push-if-tracked`,
  };
  for (const [event, command] of Object.entries(hooks)) {
    if (!settings.hooks[event]) {
      settings.hooks[event] = [{ hooks: [] }];
      changed = true;
    }
    if (settings.hooks[event].length === 0) {
      settings.hooks[event].push({ hooks: [] });
      changed = true;
    }
    const alreadyInstalled = settings.hooks[event].some(({ hooks: groupHooks }) => groupHooks.some((hook) => hook?.command === command));
    if (!alreadyInstalled) {
      const group = settings.hooks[event][0];
      if (!group.hooks) group.hooks = [];
      group.hooks.push({ type: 'command', command, timeout: event === 'SessionStart' ? 30 : 15 });
      changed = true;
    }
  }
  if (changed || !existsSync(settingsPath)) {
    mkdirSync(path.dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}
`, 'utf8');
  }
}


async function doctor(engine, offline, log) {
  const diagnostics = [...validateLocalConfig(engine.root, engine.fs), ...envDiagnostics(engine.config)];
  if (!offline && !hasFailure(diagnostics)) {
    const token = engine.env[engine.config.notion.tokenEnv];
    const dbId = engine.env[engine.config.notion.databaseIdEnv];
    if (!token || !dbId) {
      if (!token) diagnostics.push(diagnostic('failure', 'credential_missing', `${engine.config.notion.tokenEnv} is not set`));
      if (!dbId) diagnostics.push(diagnostic('failure', 'credential_missing', `${engine.config.notion.databaseIdEnv} is not set`));
    } else {
      try {
        const remote = await engine.fetchDatabase(token, dbId);
        const remoteProperties = remote.properties || {};
        const expectedPropertyTypes = {
          name: 'title',
          externalId: 'rich_text',
          parentId: 'relation',
          type: 'select',
          status: 'status',
          phase: 'rich_text',
          owner: 'rich_text',
          securitySensitive: 'checkbox',
          changelogEntry: 'select',
          path: 'rich_text',
          localUpdated: 'date',
        };
        for (const [key, expectedType] of Object.entries(expectedPropertyTypes)) {
          const propertyName = engine.config.notion.properties[key];
          const actualType = remoteProperties[propertyName]?.type;
          if (!actualType) diagnostics.push(diagnostic('failure', 'remote_property_missing', `remote property is missing: ${propertyName}`, `notion.properties.${key}`));
          else if (actualType !== expectedType) diagnostics.push(diagnostic('failure', 'remote_property_type_mismatch', `remote property has type ${actualType}, expected ${expectedType}: ${propertyName}`, `notion.properties.${key}`));
        }
        const remoteOptions = remoteProperties[engine.config.notion.properties.status]?.status?.options;
        if (!Array.isArray(remoteOptions)) {
          diagnostics.push(diagnostic('failure', 'remote_status_schema_missing', 'remote status options are unavailable'));
        } else {
          const expected = new Set(Object.values(engine.config.statusMapping));
          const actual = new Set(remoteOptions.map((option) => option?.name).filter(Boolean));
          for (const status of expected) if (!actual.has(status)) diagnostics.push(diagnostic('failure', 'missing_remote_status', `remote status option is missing: ${status}`));
          for (const status of actual) if (!expected.has(status)) diagnostics.push(diagnostic('warning', 'unexpected_remote_status', `remote status option is unexpected: ${status}`));
        }
      } catch (error) {
        diagnostics.push(diagnostic('failure', 'remote_check_failed', /\(status \d+\)/.test(error.message) ? error.message : 'Notion request failed'));
      }
    }
  }
  const report = { command: 'doctor', mode: offline ? 'offline' : 'online', ok: !hasFailure(diagnostics), diagnostics };
  log(JSON.stringify(report, null, 2));
  return report;
}

function notionText(value) {
  return value ? [{ text: { content: String(value).slice(0, 2000) } }] : [];
}

export function parseFrontMatter(content) {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  if (!match) return {};
  const fm = {};
  for (const line of match[1].split('\n')) {
    const m = line.match(/^([a-z_]+):\s*(.*)$/);
    if (!m) continue;
    let [, key, value] = m;
    value = value.trim();
    if (value === 'null') value = null;
    else if (value === 'true') value = true;
    else if (value === 'false') value = false;
    else if (value === '[]') value = [];
    else value = value.replace(/^['"]|['"]$/g, '');
    fm[key] = value;
  }
  return fm;
}

function resolveStatePath(root, statePath, config) {
  const configured = statePath || config.statePath;
  return path.isAbsolute(configured) ? configured : path.resolve(root, configured);
}

function trackedFiles(root, config, fs = defaultFs) {
  return config.trackedPrefixes.flatMap((prefix) => fs.globSync(path.join(root, `${prefix}**/*.md`)).filter((f) => !f.endsWith('.gitkeep')));
}

function ensureStateDirectory(statePath, fs) {
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
}

function readState(statePath, fs) {
  return fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8')) : {};
}

function saveSyncState(statePath, id, status, fs, clock) {
  const state = readState(statePath, fs);
  state[id] = { last_sync_status: 'synced', last_synced_status: status, last_sync_at: now(clock) };
  ensureStateDirectory(statePath, fs);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
}

// Persists only a redacted failure record. Tokens and response bodies never reach disk.
function saveFailureState(statePath, id, error, fs, clock) {
  const state = readState(statePath, fs);
  state[id || 'unknown'] = {
    ...(state[id] || {}),
    last_sync_status: 'failed',
    last_error: /\(status \d+\)/.test(error.message) ? error.message.slice(0, 300) : 'Notion request failed',
    last_sync_at: now(clock),
  };
  ensureStateDirectory(statePath, fs);
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');
}

export function contentToBlocks(content) {
  const body = content.replace(/^---\n[\s\S]*?\n---\s*/, '').trim();
  if (!body) return [];
  return body.split('\n').flatMap((line) => {
    if (!line.trim()) return [];
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      const type = `heading_${heading[1].length}`;
      return [{ object: 'block', type, [type]: { rich_text: notionText(heading[2]) } }];
    }
    const bullet = line.match(/^[-*]\s+(.+)$/);
    if (bullet) return [{ object: 'block', type: 'bulleted_list_item', bulleted_list_item: { rich_text: notionText(bullet[1]) } }];
    const numbered = line.match(/^\d+\.\s+(.+)$/);
    if (numbered) return [{ object: 'block', type: 'numbered_list_item', numbered_list_item: { rich_text: notionText(numbered[1]) } }];
    return [{ object: 'block', type: 'paragraph', paragraph: { rich_text: notionText(line) } }];
  });
}

export function createNotionSyncEngine(root = process.cwd(), overrides = {}) {
  root = path.resolve(root);
  const operations = {
    ...defaultOperations,
    fetch: overrides.fetch || defaultOperations.fetch,
    env: overrides.env || process.env,
    fs: overrides.fs || defaultOperations.fs,
    clock: overrides.clock || defaultOperations.clock,
    sleep: overrides.sleep || defaultOperations.sleep,
    ...(overrides.operations || {}),
  };
  const fs = operations.fs;
  const config = loadConfig(root, overrides, fs);
  const { readFileSync, writeFileSync } = fs;
  const saveSync = (statePath, id, status) => saveSyncState(statePath, id, status, fs, operations.clock);
  const saveFailure = (statePath, id, error) => saveFailureState(statePath, id, error, fs, operations.clock);
  const property = config.notion.properties;
  const notionBase = config.notion.apiBaseUrl.replace(/\/$/, '');
  const statusToNotion = (status) => config.statusMapping[status];
  const notionToStatus = Object.fromEntries(Object.entries(config.statusMapping).map(([key, value]) => [value, key]));
  const externalId = (fm) => `${config.projectSlug}:${fm.id}`;
  const artifactType = (relPath) => {
    const match = Object.entries(config.artifactTypes)
      .sort(([a], [b]) => b.length - a.length)
      .find(([prefix]) => relPath.startsWith(prefix));
    return match?.[1] || 'Task';
  };

  function isTrackedPath(relPath) {
    const normalized = relPath.replace(/^\.\//, '');
    return config.trackedPrefixes.some((prefix) => normalized.startsWith(prefix));
  }

  function requireEnv() {
    const token = operations.env[config.notion.tokenEnv];
    const dbId = operations.env[config.notion.databaseIdEnv];
    if (!token) throw new Error(`${config.notion.tokenEnv} env var is required`);
    if (!dbId) throw new Error(`${config.notion.databaseIdEnv} env var is required`);
    return { token, dbId };
  }

  async function notionFetch(url, opts = {}, token) {
    let lastStatus;
    for (let attempt = 1; attempt <= config.retry.maxAttempts; attempt += 1) {
      const res = await operations.fetch(url, {
        ...opts,
        headers: {
          Authorization: `Bearer ${token}`,
          'Notion-Version': config.notion.apiVersion,
          'Content-Type': 'application/json',
          ...(opts.headers || {}),
        },
        signal: AbortSignal.timeout(config.retry.timeoutMs),
      });
      if (res.status === 429 || res.status >= 500) {
        lastStatus = res.status;
        if (attempt < config.retry.maxAttempts) {
          const retryAfter = Number(res.headers.get('retry-after')) || attempt;
          await operations.sleep(retryAfter * 10);
          continue;
        }
        throw new Error(`Notion request failed after ${config.retry.maxAttempts} attempts (status ${lastStatus})`);
      }
      if (!res.ok) throw new Error(`Notion request failed (status ${res.status})`);
      return res;
    }
    throw new Error(`Notion request failed (status ${lastStatus})`);
  }

  function buildProperties(fm, relPath, parentPageId) {
    const notionStatus = statusToNotion(fm.status);
    if (!notionStatus) throw new Error(`invalid status: ${fm.status}`);
    return {
      [property.name]: { title: [{ text: { content: fm.title || fm.id } }] },
      [property.externalId]: { rich_text: notionText(externalId(fm)) },
      [property.parentId]: { relation: fm.parent_id ? [{ id: parentPageId }] : [] },
      [property.type]: { select: { name: artifactType(relPath) } },
      [property.status]: { status: { name: notionStatus } },
      [property.phase]: { rich_text: notionText(fm.phase) },
      [property.owner]: { rich_text: notionText(fm.owner) },
      [property.securitySensitive]: { checkbox: fm.security_sensitive === true },
      [property.changelogEntry]: { select: { name: fm.changelog_entry || 'not-applicable' } },
      [property.path]: { rich_text: notionText(relPath) },
      [property.localUpdated]: fm.updated ? { date: { start: fm.updated } } : { date: null },
    };
  }

  async function resolveParentPageId(fm, token, dbId) {
    if (!fm.parent_id) return null;
    const parentMatches = await queryByExternalId({ id: fm.parent_id }, token, dbId);
    if (parentMatches.length > 1) throw new Error(`multiple Notion pages match parent External ID ${externalId({ id: fm.parent_id })} — refusing to sync child`);
    if (parentMatches.length === 0) throw new Error(`parent page not found for External ID ${externalId({ id: fm.parent_id })} — refusing to sync child`);
    return parentMatches[0].id;
  }

  async function syncPageBody(pageId, content, token) {
    if (!config.syncBody) return;
    const existing = [];
    let cursor;
    do {
      const url = `${notionBase}/blocks/${pageId}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ''}`;
      const res = await notionFetch(url, { method: 'GET' }, token);
      const body = await res.json();
      existing.push(...(body.results || []));
      cursor = body.has_more ? body.next_cursor : null;
    } while (cursor);
    for (const block of existing) await notionFetch(`${notionBase}/blocks/${block.id}`, { method: 'DELETE' }, token);
    const blocks = contentToBlocks(content);
    for (let i = 0; i < blocks.length; i += 100) {
      await notionFetch(
        `${notionBase}/blocks/${pageId}/children`,
        { method: 'PATCH', body: JSON.stringify({ children: blocks.slice(i, i + 100) }) },
        token,
      );
    }
  }

  async function fetchDatabase(token, dbId) {
    const res = await notionFetch(`${notionBase}/databases/${dbId}`, { method: 'GET' }, token);
    return res.json();
  }

  async function queryByExternalId(fm, token, dbId) {
    const results = [];
    let cursor;
    do {
      const body = { filter: { property: property.externalId, rich_text: { equals: externalId(fm) } } };
      if (cursor) body.start_cursor = cursor;
      const res = await notionFetch(
        `${notionBase}/databases/${dbId}/query`,
        { method: 'POST', body: JSON.stringify(body) },
        token,
      );
      const page = await res.json();
      results.push(...(page.results || []));
      cursor = page.has_more ? page.next_cursor : null;
    } while (cursor);
    return results;
  }

  async function push(filePath, statePath) {
    const { token, dbId } = requireEnv();
    const content = readFileSync(filePath, 'utf8');
    const fm = parseFrontMatter(content);
    const relPath = path.relative(root, filePath);
    const stateFile = resolveStatePath(root, statePath, config);
    try {
      const parentPageId = await resolveParentPageId(fm, token, dbId);
      const properties = buildProperties(fm, relPath, parentPageId);
      let result;
      if (fm.notion_page_id) {
        try {
          const res = await notionFetch(`${notionBase}/pages/${fm.notion_page_id}`, { method: 'PATCH', body: JSON.stringify({ properties }) }, token);
          const body = await res.json();
          await syncPageBody(body.id, content, token);
          result = { action: 'updated', pageId: body.id };
        } catch (error) {
          if (!error.message.includes('(status 404)')) throw error;
          const matches = await queryByExternalId(fm, token, dbId);
          if (matches.length > 1) throw new Error(`multiple Notion pages match External ID ${externalId(fm)} — refusing to create a duplicate`);
          if (matches.length !== 1) throw new Error(`stale cached Notion page ID and no External ID match: ${externalId(fm)}`);
          const res = await notionFetch(`${notionBase}/pages/${matches[0].id}`, { method: 'PATCH', body: JSON.stringify({ properties }) }, token);
          const body = await res.json();
          await syncPageBody(body.id, content, token);
          result = { action: 'updated', pageId: body.id };
        }
      } else {
        const matches = await queryByExternalId(fm, token, dbId);
        if (matches.length > 1) throw new Error(`multiple Notion pages match External ID ${externalId(fm)} — refusing to create a duplicate`);
        if (matches.length === 1) {
          const res = await notionFetch(`${notionBase}/pages/${matches[0].id}`, { method: 'PATCH', body: JSON.stringify({ properties }) }, token);
          const body = await res.json();
          await syncPageBody(body.id, content, token);
          result = { action: 'updated', pageId: body.id };
        } else {
          const page = { parent: { database_id: dbId }, properties };
          if (config.syncBody) page.children = contentToBlocks(content).slice(0, 100);
          const res = await notionFetch(`${notionBase}/pages`, { method: 'POST', body: JSON.stringify(page) }, token);
          const body = await res.json();
          result = { action: 'created', pageId: body.id };
        }
      }
      if (fm.id) saveSync(stateFile, fm.id, fm.status);
      return result;
    } catch (error) {
      if (fm.id) saveFailure(stateFile, fm.id, error);
      throw error;
    }
  }

  async function pull(filePaths, statePath) {
    const { token, dbId } = requireEnv();
    const stateFile = resolveStatePath(root, statePath, config);
    const state = readState(stateFile, fs);
    const updated = [];
    const conflicts = [];
    const unknown = [];

    for (const filePath of filePaths) {
      const content = readFileSync(filePath, 'utf8');
      const fm = parseFrontMatter(content);
      const matches = await queryByExternalId(fm, token, dbId);
      if (matches.length !== 1) continue;
      const remoteStatusName = matches[0].properties?.[property.status]?.status?.name;
      const remoteStatus = notionToStatus[remoteStatusName];
      if (!remoteStatus) {
        unknown.push(remoteStatusName);
        continue;
      }
      const lastSynced = state[fm.id]?.last_synced_status;
      if (remoteStatus === fm.status) continue;
      if (fm.status !== lastSynced) {
        conflicts.push({ id: fm.id, local: fm.status, remote: remoteStatus });
        continue;
      }
      writeFileSync(filePath, content.replace(/^status:\s*.*/m, `status: ${remoteStatus}`), 'utf8');
      state[fm.id] = { last_sync_status: 'synced', last_synced_status: remoteStatus, last_sync_at: now(operations.clock) };
      updated.push({ id: fm.id, status: remoteStatus });
    }

    ensureStateDirectory(stateFile, fs);
    writeFileSync(stateFile, JSON.stringify(state, null, 2), 'utf8');
    return { updated, conflicts, unknown };
  }

  function syncStatus(statePath) {
    const state = readState(resolveStatePath(root, statePath, config), fs);
    const records = Object.values(state);
    return {
      tracked_files: trackedFiles(root, config, fs).length,
      tracked_records: records.length,
      synced: records.filter((record) => record.last_sync_status !== 'failed').length,
      failed: records.filter((record) => record.last_sync_status === 'failed').length,
      last_sync_at: records.map((record) => record.last_sync_at || record.last_synced_at).filter(Boolean).sort().at(-1) || null,
    };
  }

  return {
    root,
    config,
    fs,
    env: operations.env,
    statusToNotion,
    statusFromNotion: (status) => notionToStatus[status],
    isTrackedPath,
    push,
    pull,
    syncStatus,
    fetchDatabase,
    trackedFiles: () => trackedFiles(root, config, fs),
  };
}

const defaultEngine = () => createNotionSyncEngine(process.cwd());

export function statusToNotion(status) {
  return defaultEngine().statusToNotion(status);
}
export function statusFromNotion(status) {
  return defaultEngine().statusFromNotion(status);
}
export function isTrackedPath(relPath) {
  return defaultEngine().isTrackedPath(relPath);
}
export async function push(filePath, statePath) {
  return defaultEngine().push(filePath, statePath);
}
export async function pull(filePaths, statePath) {
  return defaultEngine().pull(filePaths, statePath);
}
export function syncStatus(root = process.cwd(), statePath) {
  return createNotionSyncEngine(root).syncStatus(statePath);
}

export async function main(argv = process.argv.slice(2), options = {}) {
  const [cmd, arg] = argv;
  const root = options.root || process.cwd();
  const log = options.log || console.log;
  const error = options.error || console.error;
  const setExitCode = options.setExitCode || ((code) => { process.exitCode = code; });
  if (cmd === 'init') {
    try {
      initConfig(root, options.fs || defaultFs);
      if (argv.includes('--install-hooks')) installHooks(root, options.fs || defaultFs);
      log(`created ${path.join(root, '.notion-sync.json')}`);
    } catch (initError) {
      error(`init failed: ${initError.message}`);
      setExitCode(1);
    }
    return;
  }
  let engine;
  try {
    engine = createNotionSyncEngine(root, options);
  } catch (loadError) {
    if (cmd !== 'doctor') throw loadError;
    const report = {
      command: 'doctor',
      mode: argv.includes('--offline') ? 'offline' : 'online',
      ok: false,
      diagnostics: [diagnostic('failure', 'config_load_failed', loadError.message)],
    };
    log(JSON.stringify(report, null, 2));
    setExitCode(1);
    return;
  }
  if (cmd === 'status' || cmd === 'sync-status') {
    log(JSON.stringify(engine.syncStatus(), null, 2));
  } else if (cmd === 'doctor') {
    const report = await doctor(engine, argv.includes('--offline'), log);
    if (!report.ok) setExitCode(1);
  } else if (cmd === 'push') {
    const result = await engine.push(arg);
    log(`push ${result.action} ${result.pageId}`);
  } else if (cmd === 'push-if-tracked') {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    const filePath = input.tool_input?.file_path;
    if (!filePath) return;
    const relPath = path.relative(process.cwd(), filePath);
    if (!engine.isTrackedPath(relPath)) return;
    try {
      const result = await engine.push(filePath);
      log(`notion-sync: ${result.action} ${result.pageId}`);
    } catch (pushError) {
      error(`notion-sync: push failed, local write kept — ${pushError.message}`);
    }
  } else if (cmd === 'push-all') {
    const files = engine.trackedFiles();
    let pushed = 0;
    for (const file of files) {
      try {
        const result = await engine.push(file);
        log(`push ${result.action} ${result.pageId} ${file}`);
        pushed += 1;
      } catch (pushError) {
        error(`notion-sync: push failed ${file} — ${pushError.message}`);
        setExitCode(1);
      }
    }
    log(`push-all: ${pushed}/${files.length} synced`);
  } else if (cmd === 'pull') {
    const files = engine.trackedFiles();
    try {
      const result = await engine.pull(files);
      log(`pull: ${result.updated.length} updated, ${result.conflicts.length} conflicts, ${result.unknown.length} unknown statuses`);
      for (const conflict of result.conflicts) log(`conflict ${conflict.id}: local=${conflict.local} remote=${conflict.remote} — resolve manually`);
      for (const unknown of result.unknown) log(`unknown remote status "${unknown}" — add it to the mapping or fix the Notion row`);
      if (result.conflicts.length > 0) setExitCode(1);
    } catch (pullError) {
      error(`pull failed: ${pullError.message}`);
      setExitCode(1);
    }
  } else {
    error('usage: notion-sync.mjs init [--install-hooks] | push <file> | push-all | push-if-tracked | pull | status | sync-status | doctor [--offline]');
    setExitCode(1);
  }
}

if (path.resolve(process.argv[1] || '') === ENGINE_FILE) await main();
