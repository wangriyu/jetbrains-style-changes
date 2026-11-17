'use strict';

const vscode = require('vscode');
const { t, setLanguage } = require('./i18n');
const { RepoLensController } = require('./controller');
const { migrateSourceControlLayout } = require('./layout');

let controller;

async function activate(context) {
  setLanguage(vscode.env?.language);
  const extension = vscode.extensions.getExtension('vscode.git');
  if (!extension) {
    await vscode.window.showErrorMessage(t('JetBrains-style Changes requires the built-in Git extension.'));
    return undefined;
  }
  if (!extension.isActive) await extension.activate();
  const api = extension.exports.getAPI(1);
  controller = new RepoLensController(vscode, context, api);
  context.subscriptions.push(controller);
  await controller.start();
  try {
    await migrateSourceControlLayout(vscode, context);
  } catch (error) {
    controller.logError(error);
  }
  return { refresh: () => controller.refresh(), diagnostics: () => controller.diagnostics() };
}

function deactivate() {
  controller?.dispose();
  controller = undefined;
}

module.exports = { activate, deactivate };
