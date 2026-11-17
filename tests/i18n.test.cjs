'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { t, setLanguage } = require('../src/i18n');
const { collectRepositories, diffCommand, statusLabel } = require('../src/changes');
const { buildTree } = require('../src/tree');
const { createActions } = require('../src/actions');
const { createWorkflows } = require('../src/workflows');

const uri = fsPath => ({ scheme: 'file', fsPath, path: fsPath, toString() { return `file://${fsPath}`; } });

test('runtime defaults to English and uses English for unsupported editor languages', () => {
    assert.equal(t('Open Changes'), 'Open Changes');
    for (const language of [undefined, '', 'en', 'en-US', 'ja', 'fr']) {
        setLanguage(language);
        assert.equal(t('Open Changes'), 'Open Changes');
        assert.equal(statusLabel(5), 'Modified');
        assert.equal(statusLabel(999), 'Unknown status');
    }
});

test('Chinese editor variants share the Chinese catalog and language can change after modules load', () => {
    for (const language of ['zh', 'zh-cn', 'zh-TW', 'ZH-Hant']) {
        setLanguage(language);
        assert.equal(t('Open Changes'), '打开更改');
        assert.equal(statusLabel(5), '修改');
        assert.equal(statusLabel(999), '未知状态');
        assert.equal(t('{0} repository', 1), '1 个仓库');
    }
    setLanguage('en');
    assert.equal(statusLabel(5), 'Modified');
});

test('placeholders preserve user text, repeated ordering and untranslated fallback', () => {
    setLanguage('zh-cn');
    const filename = '商家-$&-{1}.go';
    assert.equal(t('Delete the untracked file “{0}”?', filename), `删除未跟踪文件“${filename}”？`);
    assert.equal(t('Fallback {1} / {0} / {1}', '中文分支', '$&'), 'Fallback $& / 中文分支 / $&');
    assert.equal(t('Missing {0} / {1}', 'given'), 'Missing given / {1}');
    assert.equal(t('Unknown source string'), 'Unknown source string');
    assert.equal(t('toString'), 'toString');
    assert.equal(t('__proto__'), '__proto__');
});

test('tree sections, stage labels, counts and diff titles follow the editor language', () => {
    const root = path.join(path.parse(process.cwd()).root, 'repolens-i18n');
    const file = uri(path.join(root, '中文名.go'));
    const repo = { rootUri: uri(root), state: { HEAD: { name: 'feature/中文分支' },
        workingTreeChanges: [{ uri: file, status: 5 }], indexChanges: [{ uri: file, status: 0 }], mergeChanges: [] } };
    for (const [language, labels, phase] of [
        ['en', ['Changes', 'Working Tree', 'Staged'], 'Index'],
        ['zh-cn', ['变更', '工作区', '已暂存'], '暂存区']
    ]) {
        setLanguage(language);
        const result = buildTree(collectRepositories([repo]));
        assert.equal(result.roots[0].label, labels[0]);
        assert.deepEqual(result.roots[0].children[0].children.map(item => item.label), labels.slice(1));
        assert.match(result.roots[0].description, language === 'en' ? /1 file$/ : /1 个文件$/);
        assert.equal(result.files[0].label, '中文名.go');
        assert.match(result.files[0].tooltip, /feature\/中文分支/);
        const command = diffCommand({ Uri: { from: value => value } }, { toGitUri: value => value }, repo,
            { uri: file, status: 1 }, 'index');
        assert.equal(command.title, language === 'en' ? 'Open Changes' : '打开更改');
        assert.match(command.arguments[2], new RegExp(phase));
        assert.match(command.arguments[2], /中文名.go/);
    }
});

test('file action confirmations and errors are bilingual without translating filenames or raw errors', async () => {
    const file = uri(path.join(path.parse(process.cwd()).root, 'repolens-i18n', '中文新文件.go'));
    const rootUri = uri(path.dirname(file.fsPath));
    for (const language of ['en', 'zh-cn']) {
        setLanguage(language);
        const messages = [];
        const repo = { rootUri, state: { workingTreeChanges: [], untrackedChanges: [{ uri: file, status: 7 }] } };
        const vscode = {
            workspace: { getConfiguration: () => ({ get: () => true }) },
            window: {
                showWarningMessage: async (message, options, action) => { messages.push({ message, options, action }); },
                showInformationMessage: async message => messages.push({ message }),
                showErrorMessage: async message => messages.push({ message })
            }
        };
        const actions = createActions({ vscode, getGit: () => ({ repositories: [repo] }), refresh: async () => {} });
        await actions.discard({ type: 'file', repoKey: rootUri.toString(), kind: 'working', uri: file });
        assert.match(messages[0].message, language === 'en' ? /Delete the untracked file/ : /删除未跟踪文件/);
        assert.match(messages[0].message, /中文新文件.go/);
        assert.match(messages[0].options.detail, language === 'en' ? /system Trash/ : /系统废纸篓/);
        assert.equal(messages[0].action, language === 'en' ? 'Delete file' : '删除文件');
        const broken = createActions({ vscode, getGit: () => { throw new Error('原始错误'); }, refresh: async () => {} });
        await broken.openFile({ type: 'file', repoKey: rootUri.toString(), kind: 'working', uri: file });
        assert.equal(messages[1].message, language === 'en' ? 'Open file failed: 原始错误' : '打开文件失败：原始错误');
    }
});

test('commit inputs, confirmations and action buttons follow the language while preserving user content', async () => {
    const rootUri = uri(path.join(path.parse(process.cwd()).root, 'repolens-i18n'));
    const repo = { rootUri, state: { HEAD: { name: 'feature/中文分支', commit: 'abcdef' },
        indexChanges: [{ uri: uri(path.join(rootUri.fsPath, '文件.go')), status: 0 }] } };
    for (const language of ['en', 'zh-cn']) {
        setLanguage(language);
        const captured = {};
        const vscode = { window: {
            showInputBox: async options => { captured.input = options; return '保留用户提交信息'; },
            showWarningMessage: async (message, options, action) => { captured.warning = { message, options, action }; },
            showInformationMessage: async () => {}, showErrorMessage: async message => assert.fail(message)
        } };
        const workflows = createWorkflows({ vscode, getGit: () => ({ repositories: [repo] }),
            refresh: async () => {}, getSelectedNodes: () => [] });
        await workflows.commit({ type: 'repo', repoKey: rootUri.toString() });
        assert.match(captured.input.prompt, language === 'en' ? /Enter a commit message/ : /输入提交信息/);
        assert.match(captured.warning.options.detail, /feature\/中文分支/);
        assert.match(captured.warning.options.detail, /保留用户提交信息/);
        assert.equal(captured.warning.action, language === 'en' ? 'Commit staged content' : '提交暂存内容');
    }
});

test('manifest localization resolves every token in both catalogs without changing view or command identities', () => {
    const root = path.join(__dirname, '..');
    const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    const english = JSON.parse(fs.readFileSync(path.join(root, 'package.nls.json'), 'utf8'));
    const chinese = JSON.parse(fs.readFileSync(path.join(root, 'package.nls.zh-cn.json'), 'utf8'));
    const genericChinese = JSON.parse(fs.readFileSync(path.join(root, 'package.nls.zh.json'), 'utf8'));
    assert.deepEqual(genericChinese, chinese);
    const tokens = JSON.stringify(manifest).matchAll(/%([^%]+)%/g);
    for (const [, key] of tokens) {
        assert.equal(typeof english[key], 'string', `English: ${key}`);
        assert.equal(typeof chinese[key], 'string', `Chinese: ${key}`);
        assert.ok(english[key].length > 0 && chinese[key].length > 0);
    }
    assert.equal(english['view.allChanges'], 'All Changes');
    assert.equal(chinese['view.allChanges'], '全部变更');
    assert.equal(english.displayName, 'JetBrains-style Changes');
    assert.equal(chinese.displayName, 'JetBrains-style Changes');
    assert.equal(english['command.restoreSourceControlLayout'], 'Restore Source Control View Layout');
    assert.ok(manifest.contributes.views.scm.some(view => view.id === 'repolens.changes'));
    assert.ok(manifest.contributes.commands.some(command => command.command === 'repolens.expandAll'));
    for (const value of Object.values(english)) assert.doesNotMatch(value, /\p{Script=Han}/u);
});

test('activation sets the editor language before controller UI and tolerates layout migration failures', async () => {
    const source = fs.readFileSync(path.join(__dirname, '../src/extension.js'), 'utf8');
    for (const language of ['en', 'zh-cn']) {
        const calls = [];
        const vscode = { env: { language }, extensions: { getExtension: () => ({
            isActive: true, exports: { getAPI: () => ({}) }
        }) } };
        class Controller {
            constructor() { calls.push(t('Changes')); }
            async start() { calls.push('started'); }
            logError(error) { calls.push(error.message); }
            refresh() { return 'refreshed'; }
            diagnostics() { return {}; }
            dispose() {}
        }
        const module = { exports: {} };
        new Function('require', 'module', 'exports', source)(name => {
            if (name === 'vscode') return vscode;
            if (name === './controller') return { RepoLensController: Controller };
            if (name === './layout') return { migrateSourceControlLayout: async () => { throw new Error('layout failure'); } };
            if (name === './i18n') return require('../src/i18n');
            throw new Error(`Unexpected import: ${name}`);
        }, module, module.exports);
        const result = await module.exports.activate({ subscriptions: [] });
        assert.deepEqual(calls, [language === 'en' ? 'Changes' : '变更', 'started', 'layout failure']);
        assert.equal(result.refresh(), 'refreshed');
        module.exports.deactivate();
    }
});
