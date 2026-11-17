'use strict';

const { t } = require('./i18n');

const VIEW_IDS = ['workbench.scm', 'repolens.changes'];
const MIGRATION_KEY = 'repolens.sourceControlLayout.v1';

async function restoreSourceControlLayout(vscode) {
  // Reset only these views. The editor owns their containers and saved layout;
  // resetting all view locations would also disturb unrelated user panels.
  const available = new Set(await vscode.commands.getCommands(true));
  const commands = VIEW_IDS.map(id => `${id}.resetViewLocation`);
  if (!commands.every(command => available.has(command))) {
    throw new Error(t('This editor does not provide the commands to restore the Source Control views.'));
  }
  for (const command of commands) await vscode.commands.executeCommand(command);
  return [...VIEW_IDS];
}

async function migrateSourceControlLayout(vscode, context) {
  if (!(vscode.workspace.workspaceFolders || []).length || context.globalState.get(MIGRATION_KEY, false)) return false;
  await restoreSourceControlLayout(vscode);
  await context.globalState.update(MIGRATION_KEY, true);
  return true;
}

module.exports = { restoreSourceControlLayout, migrateSourceControlLayout, VIEW_IDS, MIGRATION_KEY };
