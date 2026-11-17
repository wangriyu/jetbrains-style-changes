'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const vscode = require('vscode');

const execute = promisify(execFile);
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

async function until(description, predicate, timeout = 60000) {
  const deadline = Date.now() + timeout;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const value = await predicate();
      if (value) return value;
    } catch (error) { lastError = error; }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${description}${lastError ? `: ${lastError.message}` : ''}`);
}

function fileNode(repo, filename, kind = 'working') {
  const uri = vscode.Uri.file(filename);
  const repoKey = repo.rootUri.toString();
  return { id: JSON.stringify(['file', repoKey, kind, uri.toString()]), type: 'file', repoKey, kind, uri };
}

function findDiff(filename) {
  return vscode.window.tabGroups.all.flatMap(group => group.tabs).find(tab =>
    tab.input instanceof vscode.TabInputTextDiff && tab.input.modified.fsPath === filename);
}

async function run() {
  const resultPath = process.env.REPOLENS_TEST_RESULT;
  const fixturePath = process.env.REPOLENS_TEST_FIXTURE;
  if (!resultPath || !fixturePath) throw new Error('REPOLENS_TEST_RESULT and REPOLENS_TEST_FIXTURE are required');
  const fixture = JSON.parse(await fs.readFile(fixturePath, 'utf8'));
  const finishMarker = process.env.REPOLENS_TEST_FINISH_MARKER || path.join(path.dirname(resultPath), 'finish.marker');
  const hold = process.env.REPOLENS_TEST_HOLD === '1';
  const result = {
    ok: false, phase: 'running', startedAt: new Date().toISOString(),
    extensionId: 'wangriyu.jetbrains-style-changes', workspace: fixture.workspace,
    resultPath, finishMarker, checks: []
  };
  async function save() {
    await fs.mkdir(path.dirname(resultPath), { recursive: true });
    const temporary = `${resultPath}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(result, null, 2));
    await fs.rename(temporary, resultPath);
  }
  async function check(name, action) {
    const started = Date.now();
    await action();
    result.checks.push({ name, ok: true, durationMs: Date.now() - started });
    await save();
  }
  await save();
  try {
    assert.equal(vscode.workspace.workspaceFolders?.length, 1);
    assert.equal(vscode.workspace.workspaceFolders[0].uri.fsPath, fixture.workspace);
    const gitExtension = vscode.extensions.getExtension('vscode.git');
    assert.ok(gitExtension, 'Built-in Git extension is missing');
    await gitExtension.activate();
    const git = gitExtension.exports.getAPI(1);
    await until('native Git initialization', () => git.state === 'initialized');
    const extension = vscode.extensions.getExtension(result.extensionId);
    assert.ok(extension, `Development extension ${result.extensionId} was not loaded`);
    const repolens = await extension.activate();
    assert.equal(typeof repolens?.diagnostics, 'function');
    assert.equal(typeof repolens?.refresh, 'function');
    result.editorLanguage = vscode.env.language;

    await check('All Changes contributes to native Source Control without a separate activity container', async () => {
      assert.equal(extension.packageJSON.contributes.viewsContainers, undefined);
      assert.ok(extension.packageJSON.contributes.views.scm.some(view => view.id === 'repolens.changes'));
      const commands = await vscode.commands.getCommands(true);
      assert.ok(commands.includes('workbench.scm.focus'), 'The native Changes view remains registered');
      assert.ok(commands.includes('repolens.changes.focus'), 'All Changes exposes the native view visibility/focus entry');
      assert.ok(commands.includes('repolens.changes.toggleVisibility'), 'All Changes participates in the native view visibility menu');
      assert.ok(commands.includes('workbench.scm.resetViewLocation'));
      assert.ok(commands.includes('repolens.changes.resetViewLocation'));
      result.allChangesTitle = extension.packageJSON.contributes.views.scm.find(view => view.id === 'repolens.changes').name;
    });

    const knownRoots = new Set(fixture.repositories.map(repo => repo.path));
    const gitPath = git.git?.path || 'git';
    async function readGit(root, ...args) {
      assert.ok(knownRoots.has(root), `Refusing Git access outside fixture repositories: ${root}`);
      assert.ok(['status', 'diff', 'show', 'rev-parse', 'ls-files', 'ls-tree'].includes(args[0]), 'Native runner permits only read-only Git commands');
      return (await execute(gitPath, ['-C', root, ...args], {
        encoding: 'utf8', timeout: 15000,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' }
      })).stdout;
    }
    function liveRepository(root) {
      return git.repositories.find(repo => repo.rootUri.fsPath === root);
    }
    const alpha = fixture.repositories.find(repo => repo.name === 'alpha');
    const beta = fixture.repositories.find(repo => repo.name === 'beta');
    assert.ok(alpha && beta);
    await check('isolated fixture configuration', async () => {
      const configuration = vscode.workspace.getConfiguration('git');
      assert.equal(configuration.get('repositoryScanMaxDepth'), 2);
      assert.equal(configuration.get('openRepositoryInParentFolders'), 'never');
      assert.equal(configuration.get('mergeEditor'), true);
    });
    await check('two native repositories and all expected RepoLens files', async () => {
      await repolens.refresh();
      await until('both fixture repositories', () => [...knownRoots].every(root => liveRepository(root)));
      await until('RepoLens fixture counts', () => {
        const diagnostics = repolens.diagnostics();
        result.latestDiagnostics = diagnostics;
        return diagnostics.changedRepositories === 2 && diagnostics.changedFiles === fixture.expectedFiles && diagnostics.visibleFiles === fixture.expectedFiles;
      });
      assert.deepEqual(new Set(git.repositories.map(repo => repo.rootUri.fsPath)), knownRoots,
        'The isolated host must not include business repositories');
      result.initialDiagnostics = repolens.diagnostics();
      assert.equal(result.initialDiagnostics.gitState, 'initialized');
      assert.ok(!result.initialDiagnostics.error);
    });

    await check('tracked file opens a real Git-to-working diff', async () => {
      await vscode.commands.executeCommand('repolens.openChange', fileNode(liveRepository(alpha.path), alpha.tracked));
      const tab = await until('tracked diff tab', () => findDiff(alpha.tracked));
      assert.equal(tab.input.original.scheme, 'git');
      assert.equal(tab.input.modified.scheme, 'file');
      assert.equal((await vscode.workspace.openTextDocument(tab.input.original)).getText(), alpha.baselineTracked);
      assert.equal((await vscode.workspace.openTextDocument(tab.input.modified)).getText(), alpha.modifiedTracked);
      assert.ok(tab.label.includes(vscode.env.language.toLowerCase().startsWith('zh') ? '工作区' : 'Working Tree'),
        `The diff title must follow the editor language: ${vscode.env.language}, ${tab.label}`);
      result.localizedWorkingTitle = tab.label;
      result.trackedDiff = { original: tab.input.original.toString(), modified: tab.input.modified.toString() };
    });
    await check('untracked file opens an empty-to-new diff', async () => {
      await vscode.commands.executeCommand('repolens.openChange', fileNode(liveRepository(alpha.path), alpha.untracked));
      const tab = await until('untracked diff tab', () => findDiff(alpha.untracked));
      assert.equal(tab.input.original.scheme, 'repolens-empty');
      assert.equal((await vscode.workspace.openTextDocument(tab.input.original)).getText(), '');
      assert.equal((await vscode.workspace.openTextDocument(tab.input.modified)).getText(), alpha.untrackedText);
      result.untrackedDiff = { original: tab.input.original.toString(), modified: tab.input.modified.toString() };
    });
    await check('staged file opens HEAD-to-index diff', async () => {
      await vscode.commands.executeCommand('repolens.openChange', fileNode(liveRepository(alpha.path), alpha.staged, 'index'));
      const tab = await until('staged diff tab', () => findDiff(alpha.staged));
      assert.equal(tab.input.original.scheme, 'git');
      assert.equal(tab.input.modified.scheme, 'git');
      assert.equal(JSON.parse(tab.input.original.query).ref, 'HEAD');
      assert.equal(JSON.parse(tab.input.modified.query).ref, '');
      assert.equal((await vscode.workspace.openTextDocument(tab.input.original)).getText(), alpha.baselineStaged);
      assert.equal((await vscode.workspace.openTextDocument(tab.input.modified)).getText(), alpha.modifiedStaged);
    });

    const alphaBefore = await readGit(alpha.path, 'status', '--porcelain=v1');
    const betaBefore = await readGit(beta.path, 'status', '--porcelain=v1');
    await check('stage and unstage affect only one fixture file and preserve its working content', async () => {
      const workingText = await fs.readFile(alpha.tracked, 'utf8');
      await vscode.commands.executeCommand('repolens.stage', fileNode(liveRepository(alpha.path), alpha.tracked));
      await until('tracked fixture entering the index', () => liveRepository(alpha.path).state.indexChanges.some(change => change.uri.fsPath === alpha.tracked));
      assert.equal((await readGit(alpha.path, 'diff', '--cached', '--name-only', '--', path.basename(alpha.tracked))).trim(), path.basename(alpha.tracked));
      assert.equal(await fs.readFile(alpha.tracked, 'utf8'), workingText);
      await vscode.commands.executeCommand('repolens.unstage', fileNode(liveRepository(alpha.path), alpha.tracked, 'index'));
      await until('tracked fixture leaving the index', () => !liveRepository(alpha.path).state.indexChanges.some(change => change.uri.fsPath === alpha.tracked));
      assert.equal(await fs.readFile(alpha.tracked, 'utf8'), workingText);
      assert.equal(await readGit(alpha.path, 'status', '--porcelain=v1'), alphaBefore);
      assert.equal(await readGit(beta.path, 'status', '--porcelain=v1'), betaBefore);
    });
    await check('native Changes and All Changes restore together without changing fixture files', async () => {
      assert.deepEqual(await vscode.commands.executeCommand('repolens.restoreSourceControlLayout'),
        ['workbench.scm', 'repolens.changes']);
      assert.equal(await readGit(alpha.path, 'status', '--porcelain=v1'), alphaBefore);
      assert.equal(await readGit(beta.path, 'status', '--porcelain=v1'), betaBefore);
    });
    await check('Source Control All Changes expands deep folders and retains final counts', async () => {
      await vscode.commands.executeCommand('repolens.focus');
      await repolens.refresh();
      const expansion = await vscode.commands.executeCommand('repolens.expandAll');
      assert.ok(expansion.expanded > 0);
      assert.ok(!expansion.cancelled);
      assert.ok(!expansion.failed);
      result.expansion = expansion;
      await until('final RepoLens counts', () => {
        const diagnostics = repolens.diagnostics();
        return diagnostics.changedRepositories === 2 && diagnostics.changedFiles === fixture.expectedFiles;
      });
      result.finalDiagnostics = repolens.diagnostics();
      assert.equal(git.repositories.length, 2);
      // Leave the added-file comparison visible for the optional visual check.
      await vscode.commands.executeCommand('repolens.openChange', fileNode(liveRepository(alpha.path), alpha.untracked));
    });

    await check('changelist commands register and logical grouping preserves native Git content', async () => {
      const commands = await vscode.commands.getCommands(true);
      for (const command of ['createChangelist', 'renameChangelist', 'deleteChangelist', 'activateChangelist',
        'moveToChangelist', 'commitSelected', 'stashSelected']) {
        assert.ok(commands.includes(`repolens.${command}`), `Missing ${command} command`);
      }
      const { ChangelistStore } = require('../src/changelists');
      const { collectRepositories } = require('../src/changes');
      const { buildTree } = require('../src/tree');
      const state = new Map();
      const workspaceState = { get: key => state.get(key), update: async (key, value) => { state.set(key, value); } };
      const store = new ChangelistStore(workspaceState);
      const snapshots = collectRepositories([liveRepository(alpha.path), liveRepository(beta.path)]);
      store.sync(snapshots);
      await store.flush();
      const review = await store.create('Native review');
      await store.setActive(review.id);
      const selected = fileNode(liveRepository(alpha.path), alpha.tracked);
      await store.move([selected], review.id);
      const model = buildTree(snapshots, {
        grouping: 'changelist', changelists: store.lists, activeListId: store.activeId,
        listFor: (repoKey, uri) => store.listFor(repoKey, uri),
      });
      assert.ok([...model.nodeById.values()].some(node => node.type === 'changelist' && node.label === 'Native review'));
      assert.equal(new ChangelistStore(workspaceState).listFor(selected.repoKey, selected.uri), review.id);
      assert.equal(await readGit(alpha.path, 'status', '--porcelain=v1'), alphaBefore);
      assert.equal(await readGit(beta.path, 'status', '--porcelain=v1'), betaBefore);
      assert.equal(await fs.readFile(alpha.tracked, 'utf8'), alpha.modifiedTracked);
      result.changelist = { name: review.name, persisted: true, gitUnchanged: true };
    });

    const workflowFixtures = fixture.workflowRepositories || [];
    assert.equal(workflowFixtures.length, 2, 'Native selected workflows require their two owned repositories');
    for (const owned of workflowFixtures) {
      const relative = path.relative(path.dirname(fixturePath), owned.path);
      assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative), 'Selected workflow fixture must stay in the owned control directory');
      // Move our repositories into the workspace only after the original
      // two-repository assertions. Trae correctly honors the fixture's
      // openRepositoryInParentFolders=never setting for external roots.
      const destination = path.join(fixture.workspace, owned.name);
      await assert.rejects(fs.access(destination));
      await fs.rename(owned.path, destination);
      for (const key of ['selected', 'unselected', 'untracked']) {
        owned[key] = path.join(destination, path.basename(owned[key]));
      }
      owned.path = destination;
      knownRoots.add(owned.path);
      // Exercise the same absolute-path command used by repository discovery.
      await vscode.commands.executeCommand('git.openRepository', owned.path);
      await until(`native repository ${owned.name}`, () => liveRepository(owned.path));
      await liveRepository(owned.path).status();
    }
    const { createWorkflows } = require('../src/workflows');
    const workflowUi = { inputs: [], confirmations: [], info: [], errors: [] };
    let selectedWorkflowNodes = [];
    const workflows = createWorkflows({
      vscode: {
        workspace: vscode.workspace,
        commands: vscode.commands,
        window: {
          showInputBox: async options => { workflowUi.inputs.push(options); return 'test: native selected scope'; },
          showQuickPick: async items => items[0],
          showWarningMessage: async (message, options, action) => {
            workflowUi.confirmations.push({ message, detail: options.detail });
            return action;
          },
          showInformationMessage: async message => { workflowUi.info.push(message); },
          showErrorMessage: async message => { workflowUi.errors.push(message); },
        },
      },
      getGit: () => git,
      getSelectedNodes: () => selectedWorkflowNodes,
      getNodeFiles: node => node?.type === 'file' ? [node] : node?.files || [],
      refresh: () => repolens.refresh(),
    });
    const commitFixture = workflowFixtures.find(item => item.name === 'selected-commit');
    const stashFixture = workflowFixtures.find(item => item.name === 'selected-stash');
    assert.ok(commitFixture && stashFixture);

    await check('selected commit uses full chosen files and rename paths while preserving another partial index', async () => {
      const repo = liveRepository(commitFixture.path);
      const beforeHead = (await readGit(commitFixture.path, 'rev-parse', 'HEAD')).trim();
      const unselectedIndex = await readGit(commitFixture.path, 'show', ':unselected.txt');
      const unselectedWorking = await fs.readFile(commitFixture.unselected, 'utf8');
      const untouchedUntracked = await fs.readFile(commitFixture.untracked, 'utf8');
      const rename = repo.state.indexChanges.find(change => change.status === 3);
      assert.ok(rename, 'The native Git API must expose the owned staged rename');
      selectedWorkflowNodes = [fileNode(repo, commitFixture.selected, 'index'), fileNode(repo, rename.uri.fsPath, 'index')];
      await workflows.commitSelected();
      assert.deepEqual(workflowUi.errors, []);
      assert.notEqual((await readGit(commitFixture.path, 'rev-parse', 'HEAD')).trim(), beforeHead);
      assert.equal(await readGit(commitFixture.path, 'show', 'HEAD:selected.txt'), 'selected complete working copy\n');
      assert.equal(await readGit(commitFixture.path, 'show', 'HEAD:unselected.txt'), 'unselected baseline\n');
      assert.equal(await readGit(commitFixture.path, 'show', 'HEAD:new name.txt'), 'rename baseline\n');
      assert.equal((await readGit(commitFixture.path, 'ls-tree', '--name-only', 'HEAD', '--', 'old name.txt')).trim(), '');
      assert.equal(await readGit(commitFixture.path, 'show', ':unselected.txt'), unselectedIndex);
      assert.equal(await fs.readFile(commitFixture.unselected, 'utf8'), unselectedWorking);
      assert.equal(await fs.readFile(commitFixture.untracked, 'utf8'), untouchedUntracked);
      assert.equal((await readGit(commitFixture.path, 'diff', '--cached', '--name-only')).trim(), 'unselected.txt');
      assert.equal((await readGit(commitFixture.path, 'diff', '--', 'selected.txt')).trim(), '');
      result.selectedCommit = { completeWorkingFile: true, renameCommitted: true, unrelatedIndexAndWorkingPreserved: true };
    });

    await check('selected stash removes only chosen tracked and untracked files while preserving another partial index', async () => {
      const repo = liveRepository(stashFixture.path);
      const head = (await readGit(stashFixture.path, 'rev-parse', 'HEAD')).trim();
      const unselectedIndex = await readGit(stashFixture.path, 'show', ':unselected.txt');
      const unselectedWorking = await fs.readFile(stashFixture.unselected, 'utf8');
      selectedWorkflowNodes = [fileNode(repo, stashFixture.selected, 'index'), fileNode(repo, stashFixture.untracked)];
      await workflows.stashSelected();
      assert.deepEqual(workflowUi.errors, []);
      assert.equal((await readGit(stashFixture.path, 'rev-parse', 'HEAD')).trim(), head);
      assert.equal(await readGit(stashFixture.path, 'show', 'refs/stash:selected.txt'), 'selected complete working copy\n');
      assert.equal(await readGit(stashFixture.path, 'show', 'refs/stash^2:selected.txt'), 'selected staged\n');
      assert.equal(await readGit(stashFixture.path, 'show', 'refs/stash^3:untracked name.txt'), 'selected untracked contents\n');
      assert.equal(await fs.readFile(stashFixture.selected, 'utf8'), 'selected baseline\n');
      await assert.rejects(fs.access(stashFixture.untracked));
      assert.equal(await readGit(stashFixture.path, 'show', ':unselected.txt'), unselectedIndex);
      assert.equal(await fs.readFile(stashFixture.unselected, 'utf8'), unselectedWorking);
      assert.equal((await readGit(stashFixture.path, 'diff', '--cached', '--name-only')).trim(), 'unselected.txt');
      assert.equal((await readGit(stashFixture.path, 'diff', '--name-only')).trim(), 'unselected.txt');
      assert.equal(workflowUi.confirmations.length, 2);
      assert.ok(workflowUi.confirmations.every(item => item.detail.includes('feature') || item.detail.includes('main')));
      assert.equal(await readGit(alpha.path, 'status', '--porcelain=v1'), alphaBefore);
      assert.equal(await readGit(beta.path, 'status', '--porcelain=v1'), betaBefore);
      result.selectedStash = { stagedAndWorkingStored: true, untrackedStored: true, unrelatedIndexAndWorkingPreserved: true };
      result.selectedWorkflowPrompts = workflowUi.confirmations;
    });

    result.ok = true;
    result.phase = hold ? 'ready' : 'finished';
    result.readyAt = new Date().toISOString();
    if (!hold) result.finishedAt = result.readyAt;
    await save();
    if (hold) {
      const deadline = Date.now() + 600000;
      let reason = 'timeout';
      while (Date.now() < deadline) {
        try { await fs.access(finishMarker); reason = 'finish.marker'; break; } catch (_) { /* Await our controller marker. */ }
        await delay(1000);
      }
      result.phase = 'finished';
      result.holdFinishedBy = reason;
      result.finishedAt = new Date().toISOString();
      await save();
    }
  } catch (error) {
    result.phase = 'failed';
    result.error = { message: error.message, stack: error.stack };
    result.finishedAt = new Date().toISOString();
    await save();
    throw error;
  }
}

module.exports = { run };
