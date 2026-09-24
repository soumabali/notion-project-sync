import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, globSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createNotionSyncEngine, main } from '../engine.mjs';

async function captureMain(argv, root) {
  const output = [];
  const errors = [];
  const exitCode = { value: 0 };
  await main(argv, {
    root,
    log: (...args) => output.push(args.join(' ')),
    error: (...args) => errors.push(args.join(' ')),
    setExitCode: (code) => { exitCode.value = code; },
  });
  return { output, errors, exitCode: exitCode.value };
}

const FRONT_MATTER = `---
id: task-custom
phase: phase-custom
type: feature
title: Custom task
status: testing
owner: claude
security_sensitive: false
changelog_entry: pending
updated: 2026-09-23
---

body
`;

function project(config = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'notion-engine-'));
  mkdirSync(path.join(root, 'custom'), { recursive: true });
  writeFileSync(path.join(root, '.notion-sync.json'), JSON.stringify({
    version: 1,
    projectSlug: 'custom-project',
    trackedPrefixes: ['custom/'],
    statePath: 'state.json',
    syncBody: false,
    statusMapping: {
      backlog: 'Backlog',
      todo: 'Todo',
      'in-progress': 'In progress',
      testing: 'Testing',
      blocked: 'Blocked',
      'in-review': 'In Review',
      done: 'Done',
    },
    ...config,
  }), 'utf8');
  const file = path.join(root, 'custom', 'task.md');
  writeFileSync(file, FRONT_MATTER, 'utf8');
  return { root, file };
}

const ENV_BACKUP = { ...process.env };

beforeEach(() => {
  process.env.NOTION_TOKEN = 'test-token';
  process.env.NOTION_DATABASE_ID = 'test-db-id';
});

afterEach(() => {
  process.env = { ...ENV_BACKUP };
  mock.restoreAll();
});

test('custom config changes External ID and property names', async () => {
  const { root, file } = project({
    notion: { properties: { name: 'Title', externalId: 'Key', status: 'State', parentId: 'Parent item' } },
  });
  const queryBodies = [];
  let createBody;
  mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).includes('/databases/')) {
      queryBodies.push(JSON.parse(options.body));
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }
    createBody = JSON.parse(options.body);
    return new Response(JSON.stringify({ id: 'page-1' }), { status: 200 });
  });

  const result = await createNotionSyncEngine(root).push(file);
  assert.equal(result.action, 'created');
  assert.equal(queryBodies[0].filter.property, 'Key');
  assert.equal(queryBodies[0].filter.rich_text.equals, 'custom-project:phase-custom:task-custom');
  assert.equal(createBody.properties.Title.title[0].text.content, 'Custom task');
  assert.equal(createBody.properties.Key.rich_text[0].text.content, 'custom-project:phase-custom:task-custom');
  assert.equal(createBody.properties.State.status.name, 'Testing');
});

test('custom tracked prefixes control path filtering and discovery', () => {
  const { root, file } = project();
  const engine = createNotionSyncEngine(root);
  assert.equal(engine.isTrackedPath('custom/task.md'), true);
  assert.equal(engine.isTrackedPath('04-tasks/task.md'), false);
  assert.deepEqual(engine.trackedFiles(), [file]);
});

test('most-specific artifact prefix wins', async () => {
  const { root, file } = project({
    syncBody: false,
    artifactTypes: { 'custom/': 'Task', 'custom/hotfix/': 'Hotfix' },
  });
  const hotfixDir = path.join(root, 'custom', 'hotfix');
  mkdirSync(hotfixDir);
  const hotfix = path.join(hotfixDir, 'task.md');
  writeFileSync(hotfix, FRONT_MATTER, 'utf8');
  let createBody;
  mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).includes('/databases/')) return new Response(JSON.stringify({ results: [] }), { status: 200 });
    createBody = JSON.parse(options.body);
    return new Response(JSON.stringify({ id: 'page-hotfix' }), { status: 200 });
  });
  await createNotionSyncEngine(root).push(hotfix);
  assert.equal(createBody.properties.Type.select.name, 'Hotfix');
});

test('syncBody false sends no block requests', async () => {
  const { root, file } = project({ syncBody: false });
  const calls = [];
  mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url: String(url), method: options.method });
    if (String(url).includes('/databases/')) return new Response(JSON.stringify({ results: [] }), { status: 200 });
    return new Response(JSON.stringify({ id: 'page-no-body' }), { status: 200 });
  });
  await createNotionSyncEngine(root).push(file);
  assert.equal(calls.some(({ url }) => url.includes('/blocks/')), false);
  assert.equal(JSON.parse(readFileSync(path.join(root, 'state.json'), 'utf8'))['task-custom'].last_synced_status, 'testing');
});

test('CLI push without a file path fails with a clear error, not a stack trace', async () => {
  const { root } = project();
  const result = await captureMain(['push'], root);
  assert.equal(result.exitCode, 1);
  assert.match(result.errors.join('\n'), /push requires a file path/);
});

test('init creates config only when absent and refuses overwrite', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'notion-init-'));
  const first = await captureMain(['init'], root);
  assert.equal(first.exitCode, 0);
  assert.equal(existsSync(path.join(root, '.notion-sync.json')), true);
  const original = readFileSync(path.join(root, '.notion-sync.json'), 'utf8');
  const second = await captureMain(['init'], root);
  assert.equal(second.exitCode, 1);
  assert.equal(readFileSync(path.join(root, '.notion-sync.json'), 'utf8'), original);
  assert.match(second.errors.join('\n'), /already exists/);
  assert.doesNotMatch(original, /NOTION_TOKEN\s*:\s*\S+/);
  assert.equal(existsSync(path.join(root, '.claude', 'settings.json')), false);
  rmSync(root, { recursive: true, force: true });
});

test('init installs hooks only when explicitly requested', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'notion-hooks-'));
  const result = await captureMain(['init', '--install-hooks'], root);
  assert.equal(result.exitCode, 0);
  const settings = JSON.parse(readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'));
  assert.ok(settings.hooks.SessionStart);
  assert.ok(settings.hooks.PostToolUse);
  rmSync(root, { recursive: true, force: true });
});

test('hook installation preserves existing settings and hooks', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'notion-hooks-preserve-'));
  mkdirSync(path.join(root, '.claude'), { recursive: true });
  const original = {
    enabledPlugins: { example: true },
    customSetting: 'preserve me',
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: 'existing-start', timeout: 5 }] }],
      PostToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'existing-push' }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'unrelated' }] }],
    },
  };
  writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify(original));
  const result = await captureMain(['init', '--install-hooks'], root);
  assert.equal(result.exitCode, 0);
  const settings = JSON.parse(readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'));
  assert.equal(settings.enabledPlugins.example, true);
  assert.equal(settings.customSetting, 'preserve me');
  assert.deepEqual(settings.hooks.UserPromptSubmit, original.hooks.UserPromptSubmit);
  assert.ok(settings.hooks.SessionStart[0].hooks.some(({ command }) => command === 'existing-start'));
  assert.ok(settings.hooks.PostToolUse[0].hooks.some(({ command }) => command === 'existing-push'));
  rmSync(root, { recursive: true, force: true });
});

test('hook installation is idempotent', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'notion-hooks-idempotent-'));
  const result = await captureMain(['init', '--install-hooks'], root);
  assert.equal(result.exitCode, 0);
  const first = readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8');
  const { installHooks } = await import('../engine.mjs');
  installHooks(root);
  assert.equal(readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'), first);
  rmSync(root, { recursive: true, force: true });
});

test('malformed settings fail without rewriting the file', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'notion-hooks-malformed-'));
  mkdirSync(path.join(root, '.claude'), { recursive: true });
  const settingsPath = path.join(root, '.claude', 'settings.json');
  const original = '{ malformed settings';
  writeFileSync(settingsPath, original);
  const result = await captureMain(['init', '--install-hooks'], root);
  assert.equal(result.exitCode, 1);
  assert.equal(readFileSync(settingsPath, 'utf8'), original);
  assert.match(result.errors.join('\n'), /JSON/);
  rmSync(root, { recursive: true, force: true });
});

test('existing project hooks continue to invoke wrapper commands', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'notion-hooks-wrapper-'));
  mkdirSync(path.join(root, '.claude'), { recursive: true });
  writeFileSync(path.join(root, '.claude', 'settings.json'), JSON.stringify({ hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: 'node tooling/notion-sync.mjs pull' }] }],
    PostToolUse: [{ hooks: [{ type: 'command', command: 'node tooling/notion-sync.mjs push-if-tracked' }] }],
  }}));
  const result = await captureMain(['init', '--install-hooks'], root);
  assert.equal(result.exitCode, 0);
  const settings = JSON.parse(readFileSync(path.join(root, '.claude', 'settings.json'), 'utf8'));
  assert.match(settings.hooks.SessionStart[0].hooks[0].command, /node tooling\/notion-sync\.mjs pull/);
  assert.match(settings.hooks.PostToolUse[0].hooks[0].command, /node tooling\/notion-sync\.mjs push-if-tracked/);
  rmSync(root, { recursive: true, force: true });
});

test('status is an alias for sync-status', async () => {
  const { root } = project();
  const alias = await captureMain(['status'], root);
  const canonical = await captureMain(['sync-status'], root);
  assert.deepEqual(JSON.parse(alias.output[0]), JSON.parse(canonical.output[0]));
});

test('doctor offline validates local config and env names without network or credentials', async () => {
  const { root } = project();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { throw new Error('network called'); };
  const oldToken = process.env.NOTION_TOKEN;
  const oldDb = process.env.NOTION_DATABASE_ID;
  delete process.env.NOTION_TOKEN;
  delete process.env.NOTION_DATABASE_ID;
  try {
    const result = await captureMain(['doctor', '--offline'], root);
    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.output[0]), {
      command: 'doctor',
      mode: 'offline',
      ok: true,
      diagnostics: [],
    });
  } finally {
    globalThis.fetch = originalFetch;
    process.env.NOTION_TOKEN = oldToken;
    process.env.NOTION_DATABASE_ID = oldDb;
  }
});

test('doctor online fails missing remote statuses and warns on extras without mutation', async () => {
  const { root } = project();
  const before = readFileSync(path.join(root, '.notion-sync.json'), 'utf8');
  mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(options.method, 'GET');
    assert.match(String(url), /\/databases\/test-db-id$/);
    return new Response(JSON.stringify({ properties: {
      Status: { status: { options: [{ name: 'Backlog' }, { name: 'Todo' }, { name: 'Testing' }, { name: 'Unexpected' }] } },
    } }), { status: 200 });
  });
  const result = await captureMain(['doctor'], root);
  assert.equal(result.exitCode, 1);
  const report = JSON.parse(result.output[0]);
  assert.equal(report.ok, false);
  assert.equal(report.mode, 'online');
  assert.ok(report.diagnostics.some((diagnostic) => diagnostic.severity === 'failure' && diagnostic.code === 'missing_remote_status'));
  assert.ok(report.diagnostics.some((diagnostic) => diagnostic.severity === 'warning' && diagnostic.code === 'unexpected_remote_status'));
  assert.equal(readFileSync(path.join(root, '.notion-sync.json'), 'utf8'), before);
});

test('doctor detects missing and mismatched remote properties', async () => {
  const { root } = project();
  const statuses = ['Backlog', 'Todo', 'In progress', 'Testing', 'Blocked', 'In Review', 'Done'];
  mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
    properties: {
      Name: { type: 'title' },
      'External ID': { type: 'rich_text' },
      'Parent item': { type: 'rich_text' },
      Type: { type: 'select' },
      Status: { type: 'status', status: { options: statuses.map((name) => ({ name })) } },
      Phase: { type: 'rich_text' },
      Owner: { type: 'rich_text' },
      'Security Sensitive': { type: 'checkbox' },
      'Changelog Entry': { type: 'select' },
      Path: { type: 'rich_text' },
      'Local Updated': { type: 'date' },
    },
  }), { status: 200 }));
  const result = await captureMain(['doctor'], root);
  const report = JSON.parse(result.output[0]);
  assert.equal(report.ok, false);
  assert.ok(report.diagnostics.some(({ code }) => code === 'remote_property_type_mismatch'));
  assert.equal(result.exitCode, 1);
});

test('doctor redacts configured credential values', async () => {
  const { root } = project({ notion: { tokenEnv: 'CUSTOM_TOKEN', databaseIdEnv: 'CUSTOM_DB' } });
  process.env.CUSTOM_TOKEN = 'secret-token-value';
  process.env.CUSTOM_DB = 'secret-db-value';
  const result = await captureMain(['doctor', '--offline'], root);
  assert.doesNotMatch(JSON.stringify(result), /secret-(token|db)-value/);
  delete process.env.CUSTOM_TOKEN;
  delete process.env.CUSTOM_DB;
});

test('engine accepts injected operation seams without global state', async () => {
  const { root, file } = project({ retry: { maxAttempts: 2 } });
  const calls = [];
  const waits = [];
  const writes = [];
  const clock = () => new Date('2026-09-23T00:00:00.000Z');
  const fs = {
    readFileSync,
    writeFileSync: (...args) => { writes.push(args[0]); return writeFileSync(...args); },
    existsSync,
    mkdirSync,
    globSync,
  };
  let attempts = 0;
  const fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).includes('/databases/')) {
      attempts += 1;
      if (attempts === 1) return new Response('raw-response-secret', { status: 503 });
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({ id: 'injected-page' }), { status: 200 });
  };
  const result = await createNotionSyncEngine(root, {
    env: { NOTION_TOKEN: 'injected-token', NOTION_DATABASE_ID: 'injected-db' },
    fetch,
    fs,
    clock,
    sleep: async (milliseconds) => waits.push(milliseconds),
  }).push(file);
  assert.equal(result.pageId, 'injected-page');
  assert.deepEqual(waits, [10]);
  assert.equal(calls[0].options.headers.Authorization, 'Bearer injected-token');
  assert.ok(writes.some((filePath) => filePath.endsWith('state.json')));
});

test('doctor diagnostics redact injected fetch errors and request content', async () => {
  const { root } = project();
  const output = [];
  await main(['doctor'], {
    root,
    log: (line) => output.push(line),
    error: () => {},
    setExitCode: () => {},
    env: { NOTION_TOKEN: 'doctor-token', NOTION_DATABASE_ID: 'doctor-db' },
    fetch: async () => {
      throw new Error('doctor-token request-body-secret markdown-body-secret');
    },
  });
  const report = JSON.parse(output[0]);
  assert.equal(report.ok, false);
  assert.doesNotMatch(output[0], /doctor-token|request-body-secret|markdown-body-secret/);
});

test('pull conflict and unknown status preserve local files and state bytes', async () => {
  for (const remoteStatus of ['Done', 'Unknown status']) {
    const { root, file } = project(remoteStatus === 'Done' ? { } : {});
    if (remoteStatus === 'Done') writeFileSync(file, readFileSync(file, 'utf8').replace('status: testing', 'status: in-review'), 'utf8');
    const statePath = path.join(root, 'state.json');
    writeFileSync(statePath, JSON.stringify({ 'task-custom': { last_synced_status: 'testing' } }, null, 2), 'utf8');
    const beforeFile = readFileSync(file, 'utf8');
    const beforeState = readFileSync(statePath, 'utf8');
    const fetch = async (url) => String(url).includes('/databases/')
      ? new Response(JSON.stringify({ results: [{ id: 'page', properties: { Status: { status: { name: remoteStatus } } } }] }), { status: 200 })
      : new Response('{}', { status: 200 });
    const result = await createNotionSyncEngine(root, {
      env: { NOTION_TOKEN: 'token', NOTION_DATABASE_ID: 'db' },
      fetch,
    }).pull([file], statePath);
    assert.equal(result.updated.length, 0);
    assert.equal(readFileSync(file, 'utf8'), beforeFile);
    assert.equal(readFileSync(statePath, 'utf8'), beforeState);
  }
});

test('push resolves parent External ID and sends a native relation', async () => {
  const { root, file } = project({ notion: { properties: { parentId: 'Parent item' } } });
  writeFileSync(file, FRONT_MATTER.replace('id: task-custom', 'id: child-task').replace('status: testing', 'status: todo').replace('owner: claude', 'owner: claude\nparent_id: parent-task'), 'utf8');
  const calls = [];
  mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url: String(url), body: options.body && JSON.parse(options.body) });
    if (String(url).includes('/databases/') && String(url).endsWith('/query')) {
      const external = calls.at(-1).body.filter.rich_text.equals;
      if (external === 'custom-project:phase-custom:parent-task') return new Response(JSON.stringify({ results: [{ id: 'parent-page' }] }), { status: 200 });
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({ id: 'child-page' }), { status: 200 });
  });

  const result = await createNotionSyncEngine(root).push(file);
  assert.equal(result.action, 'created');
  const create = calls.find(({ url }) => url.endsWith('/pages'));
  assert.deepEqual(create.body.properties['Parent item'], { relation: [{ id: 'parent-page' }] });
  assert.equal(calls.filter(({ url }) => url.endsWith('/pages')).length, 1);
});

test('push refuses child creation when parent is missing', async () => {
  const { root, file } = project();
  writeFileSync(file, FRONT_MATTER.replace('id: task-custom', 'id: child-task').replace('owner: claude', 'owner: claude\nparent_id: missing-parent'), 'utf8');
  const calls = [];
  mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url: String(url), body: options.body && JSON.parse(options.body) });
    return new Response(JSON.stringify({ results: [] }), { status: 200 });
  });

  await assert.rejects(() => createNotionSyncEngine(root).push(file), /parent page not found.*custom-project:phase-custom:missing-parent/);
  assert.equal(calls.some(({ url }) => url.endsWith('/pages')), false);
});

test('push qualifies External ID with phase', async () => {
  const { root, file } = project();
  const queryExternalIds = [];
  mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).includes('/databases/')) {
      queryExternalIds.push(JSON.parse(options.body).filter.rich_text.equals);
      return new Response(JSON.stringify({ results: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({ id: 'phase-page' }), { status: 200 });
  });

  await createNotionSyncEngine(root).push(file);
  assert.equal(queryExternalIds[0], 'custom-project:phase-custom:task-custom');
});

test('push upgrades one legacy External ID match without creating duplicate', async () => {
  const { root, file } = project();
  const queries = [];
  let patched;
  mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).includes('/databases/')) {
      const external = JSON.parse(options.body).filter.rich_text.equals;
      queries.push(external);
      const results = external === 'custom-project:task-custom' ? [{ id: 'legacy-page' }] : [];
      return new Response(JSON.stringify({ results }), { status: 200 });
    }
    if (String(url).endsWith('/pages/legacy-page')) {
      patched = JSON.parse(options.body);
      return new Response(JSON.stringify({ id: 'legacy-page' }), { status: 200 });
    }
    throw new Error(`unexpected URL: ${url}`);
  });

  const result = await createNotionSyncEngine(root).push(file);
  assert.equal(result.action, 'updated');
  assert.deepEqual(queries, ['custom-project:phase-custom:task-custom', 'custom-project:task-custom']);
  assert.equal(patched.properties['External ID'].rich_text[0].text.content, 'custom-project:phase-custom:task-custom');
});

test('parent lookup qualifies parent External ID with child phase', async () => {
  const { root, file } = project();
  writeFileSync(file, FRONT_MATTER.replace('id: task-custom', 'id: child-task').replace('owner: claude', 'owner: claude\nparent_id: parent-task'), 'utf8');
  const parentExternalIds = [];
  mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).includes('/databases/')) {
      parentExternalIds.push(JSON.parse(options.body).filter.rich_text.equals);
      return new Response(JSON.stringify({ results: [{ id: 'parent-page' }] }), { status: 200 });
    }
    return new Response(JSON.stringify({ id: 'child-page' }), { status: 200 });
  });

  await createNotionSyncEngine(root).push(file);
  assert.equal(parentExternalIds[0], 'custom-project:phase-custom:parent-task');
});

test('all canonical statuses push to mapped Notion statuses', async () => {
  const statuses = ['backlog', 'todo', 'in-progress', 'testing', 'blocked', 'in-review', 'done'];
  const mapping = {
    backlog: 'Backlog', todo: 'Todo', 'in-progress': 'In progress', testing: 'Testing',
    blocked: 'Blocked', 'in-review': 'In Review', done: 'Done',
  };
  for (const status of statuses) {
    const { root, file } = project();
    writeFileSync(file, FRONT_MATTER.replace('status: testing', `status: ${status}`), 'utf8');
    let create;
    mock.method(globalThis, 'fetch', async (url, options) => {
      if (String(url).includes('/databases/')) return new Response(JSON.stringify({ results: [] }), { status: 200 });
      create = JSON.parse(options.body);
      return new Response(JSON.stringify({ id: `page-${status}` }), { status: 200 });
    });
    await createNotionSyncEngine(root).push(file);
    assert.equal(create.properties.Status.status.name, mapping[status]);
    mock.restoreAll();
  }
});

test('all canonical Notion statuses pull to local statuses', async () => {
  const mapping = {
    backlog: 'Backlog', todo: 'Todo', 'in-progress': 'In progress', testing: 'Testing',
    blocked: 'Blocked', 'in-review': 'In Review', done: 'Done',
  };
  for (const [status, remoteStatus] of Object.entries(mapping)) {
    const { root, file } = project();
    const localStatus = status === 'testing' ? 'backlog' : 'testing';
    writeFileSync(file, FRONT_MATTER.replace('status: testing', `status: ${localStatus}`), 'utf8');
    writeFileSync(path.join(root, 'state.json'), JSON.stringify({ 'task-custom': { last_synced_status: localStatus } }), 'utf8');
    mock.method(globalThis, 'fetch', async () => new Response(JSON.stringify({
      results: [{ id: 'page', properties: { Status: { status: { name: remoteStatus } } } }],
    }), { status: 200 }));
    const result = await createNotionSyncEngine(root, {
      env: { NOTION_TOKEN: 'token', NOTION_DATABASE_ID: 'db' },
    }).pull([file], path.join(root, 'state.json'));
    assert.deepEqual(result.updated, [{ id: 'task-custom', status }]);
    assert.match(readFileSync(file, 'utf8'), new RegExp(`status: ${status}`));
    mock.restoreAll();
  }
});

// Keep the temporary project helper isolated from the repository filesystem.
