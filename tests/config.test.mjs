// Minimal, dependency-free schema check for the config contract only.
// ponytail: hand-rolled checks instead of a JSON-Schema library — schema is
// small and fixed; add ajv only if the schema grows nested/generic validation needs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const CANONICAL_STATUSES = ['backlog', 'todo', 'in-progress', 'testing', 'blocked', 'in-review', 'done'];
const TOP_LEVEL_KEYS = ['$schema', 'version', 'projectSlug', 'trackedPrefixes', 'statePath', 'syncBody', 'notion', 'statusMapping', 'artifactTypes', 'retry'];
const SECRET_SHAPED = /^(token|apiKey|api_key|secret|password|databaseId)$/i;

function validateConfig(config) {
  const errors = [];
  for (const key of Object.keys(config)) {
    if (!TOP_LEVEL_KEYS.includes(key)) errors.push(`unknown top-level key: ${key}`);
    if (SECRET_SHAPED.test(key)) errors.push(`secret-shaped key not allowed: ${key}`);
  }
  for (const required of ['version', 'projectSlug', 'statusMapping']) {
    if (config[required] === undefined) errors.push(`missing required key: ${required}`);
  }
  if (config.statusMapping) {
    const keys = Object.keys(config.statusMapping);
    const missing = CANONICAL_STATUSES.filter((s) => !keys.includes(s));
    const extra = keys.filter((k) => !CANONICAL_STATUSES.includes(k));
    if (missing.length) errors.push(`statusMapping missing: ${missing.join(', ')}`);
    if (extra.length) errors.push(`statusMapping has non-canonical keys: ${extra.join(', ')}`);
  }
  return errors;
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

test('skill example config matches schema contract', () => {
  const config = loadJson('.notion-sync.example.json');
  assert.deepEqual(validateConfig(config), []);
});

test('examples/.notion-sync.json matches schema contract', () => {
  const config = loadJson('examples/.notion-sync.json');
  assert.deepEqual(validateConfig(config), []);
});

test('schema rejects config missing version/projectSlug/statusMapping', () => {
  assert.equal(validateConfig({}).length > 0, true);
  const missingSlug = loadJson('.notion-sync.example.json');
  delete missingSlug.projectSlug;
  assert.ok(validateConfig(missingSlug).some((e) => e.includes('projectSlug')));
});

test('schema rejects unknown top-level keys', () => {
  const config = { ...loadJson('.notion-sync.example.json'), extraField: 'nope' };
  assert.ok(validateConfig(config).some((e) => e.includes('extraField')));
});

test('schema rejects literal secret-shaped fields, only env-var names allowed', () => {
  const config = { ...loadJson('.notion-sync.example.json'), token: 'ntn_leak' };
  assert.ok(validateConfig(config).some((e) => e.includes('token')));
  // env-var *names* remain fine — they hold no secret value.
  assert.equal(loadJson('.notion-sync.example.json').notion.tokenEnv, 'NOTION_TOKEN');
});

test('no example config file contains a secret-looking value', () => {
  for (const path of ['.notion-sync.example.json', 'examples/.notion-sync.json']) {
    const raw = readFileSync(path, 'utf8');
    assert.doesNotMatch(raw, /ntn_[a-zA-Z0-9]/);
    assert.doesNotMatch(raw, /secret_[a-zA-Z0-9]/);
  }
});
