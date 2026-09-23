import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

test('plugin and marketplace manifests describe one installable plugin', () => {
  const marketplace = readJson('.claude-plugin/marketplace.json');
  const plugin = readJson('.claude-plugin/plugin.json');

  assert.match(marketplace.name, NAME);
  assert.equal(typeof marketplace.owner?.name, 'string');
  assert.ok(marketplace.plugins?.length > 0);

  const entry = marketplace.plugins.find(({ name }) => name === plugin.name);
  assert.ok(entry, 'marketplace must list plugin manifest name');
  assert.equal(entry.source, './');
  assert.match(plugin.name, NAME);
  assert.equal(typeof plugin.description, 'string');
  assert.equal(typeof plugin.version, 'string');
});
