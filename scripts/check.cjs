'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
assert.equal(`${manifest.publisher}.${manifest.name}`, 'wangriyu.jetbrains-style-changes');
assert.equal(manifest.icon, 'assets/icon.png');
assert.deepEqual(manifest.extensionDependencies, ['vscode.git']);
assert.equal(manifest.contributes.configurationDefaults['git.repositoryScanMaxDepth'], 2);
assert.equal(manifest.contributes.viewsContainers, undefined, 'RepoLens shares the native Source Control container');
assert.equal(manifest.contributes.views.scm[0].id, 'repolens.changes');
const commands = new Set(manifest.contributes.commands.map(command => command.command));
assert.ok(commands.has('repolens.expandAll'));
assert.ok(commands.has('repolens.restoreSourceControlLayout'));
const translations = ['package.nls.json', 'package.nls.zh-cn.json'].map(name =>
  JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')));
const checkTranslations = value => {
  if (typeof value === 'string' && /^%[^%]+%$/.test(value)) {
    for (const catalog of translations) assert.equal(typeof catalog[value.slice(1, -1)], 'string', `Missing translation ${value}`);
  } else if (value && typeof value === 'object') {
    for (const child of Object.values(value)) checkTranslations(child);
  }
};
checkTranslations(manifest);
for (const entries of Object.values(manifest.contributes.menus)) {
  for (const entry of entries) assert.ok(commands.has(entry.command), `Unknown menu command ${entry.command}`);
}
for (const name of fs.readdirSync(path.join(root, 'src')).filter(name => name.endsWith('.js'))) {
  const file = path.join(root, 'src', name);
  const source = fs.readFileSync(file, 'utf8');
  assert.ok(!/hideReposWithNoChanges|hide-repos-with-no-changes|allChangesAggregate|hide-repos-empty/.test(source), name);
  assert.ok(!source.includes('/Users/') && !source.includes('/Applications/'), `Personal path in ${name}`);
  const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log('PASS independent package, commands, defaults and runtime syntax');
