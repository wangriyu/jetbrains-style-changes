# JetBrains-style Changes

**A JetBrains-inspired changes view for multi-repository workspaces.**

See changes from your Git repositories together in the native Source Control panel. Review diffs and conflicts, organize files into persistent Changelists, then stage, commit or stash an explicit scope.

An independent extension inspired by JetBrains IDE workflows. It is not affiliated with JetBrains.

## Preview / 界面预览

Review multi-repository changes and a file diff together in the native Source Control workspace.

在原生 Source Control 工作区中集中浏览多仓变更，并查看所选文件的差异。

[![JetBrains-style Changes multi-repository changes and diff overview](https://wangriyu.gallery.vsassets.io/_apis/public/gallery/publisher/wangriyu/extension/jetbrains-style-changes/0.2.3/assetbyname/Microsoft.VisualStudio.Services.Screenshots.1)](https://wangriyu.gallery.vsassets.io/_apis/public/gallery/publisher/wangriyu/extension/jetbrains-style-changes/0.2.3/assetbyname/Microsoft.VisualStudio.Services.Screenshots.1)

[Open full-size screenshot / 点击查看大图](https://wangriyu.gallery.vsassets.io/_apis/public/gallery/publisher/wangriyu/extension/jetbrains-style-changes/0.2.3/assetbyname/Microsoft.VisualStudio.Services.Screenshots.1)

## Features

- **Multi-repository overview:** group changes by status, repository, branch and relative folder. Discover nested repositories within a configurable depth.
- **Persistent Changelists:** create named task lists, choose an active list, rename or delete lists, and move files using the context menu or drag and drop. A list can contain files from several repositories.
- **Conflicts first:** merge conflicts stay in a dedicated top section, with navigation to the editor's native Git merge flow.
- **Accurate native diffs:** inspect working-tree and staged content separately. New files open against an empty baseline.
- **Explicit file selection:** checking files or moving them between lists does not stage them. Stage and unstage are separate actions.
- **Selected-file commit:** commit the current complete working-tree contents of selected paths while preserving unrelated staged and working changes.
- **Selected-file Stash:** save selected staged, unstaged and untracked content using standard Git Stash objects, while leaving unselected paths alone.
- **Native navigation:** switch between a relative folder tree and a flat list, filter by file path/repository/branch/status, expand or collapse groups, and navigate changes with `Alt+Up` / `Alt+Down`.
- **English and Chinese:** labels, menus, prompts and confirmations follow the editor's Display Language.

## Quick start

1. Open a local Git workspace with VS Code or a compatible editor.
2. Open **Source Control**. In its `…` menu, enable **All Changes** if the view is hidden. The native Changes and Repositories views remain available in the same container.
3. Click a file to review its diff. Use the title-bar filter or grouping controls to narrow the view.
4. To organize a task, choose **New Changelist…** in the view's `…` menu. New changes enter the active list; existing files retain their assignment. Move or drag files into the desired list.
5. Check the files to operate on, then choose stage, selected-file commit or selected-file Stash. Review the repository, branch and path list in the confirmation.

You can also run **JetBrains-style Changes: Open JetBrains-style Changes** from the Command Palette.

## Commit and Stash scope

**Commit Selected Files (Working Tree)… commits complete current file contents, including unstaged edits in those selected files.** To commit only already staged content, use **Commit Staged Files in This Repository…** instead.

A selection spanning multiple repositories requires choosing one repository before commit or Stash. The extension does not automatically commit across repositories.

Selected-file Stash records preserve the selected index, working-tree and untracked snapshots. Use `git stash apply --index` when you want Git to restore the original staging state. Native repository-level Stash commands remain available.

Save selected dirty editor documents before committing or stashing them. Selected-file operations wait for a clear Git state: unresolved conflicts, an in-progress merge/rebase/cherry-pick, or an existing index lock prevent the action. Changes to selected file contents or repository state during confirmation require a refresh and retry.

## Settings

| Setting | Default | Purpose |
|---|---|---|
| `git.repositoryScanMaxDepth` | `2` | Repository discovery depth; the workspace root is depth 0. Explicit user/workspace settings take precedence. |
| `repolens.collapseThreshold` | `20` | Large repository groups start collapsed. Manual expansion state is remembered. |
| `repolens.additionalRepositories` | `[]` | Exact workspace-relative paths for deeper or hidden repositories. Wildcards and paths outside the workspace are not supported. |
| `repolens.ignoredFolders` | Dependency/build folders | Folder names skipped during repository discovery. |

For example, add a deeper repository explicitly:

```json
{
  "repolens.additionalRepositories": ["services/payments/backend"]
}
```

The native Git extension supplies Git status and diff baselines. Initial diff availability therefore depends on the editor's initial Git scan. **Show JetBrains-style Changes Diagnostics** reports initialization state, discovered/open repositories and file counts.

## Requirements and data

- VS Code API **1.107 or newer**, the editor's built-in Git extension, and a local Git executable.
- A trusted, local filesystem workspace. Virtual workspaces and sparse-checkout selected-file operations are not supported.
- No additional repository-aggregation extension or npm runtime dependencies are required.
- Changelist names, the active list and file membership are stored in the editor's local workspace state. They are not included in a VSIX and are not synchronized between machines.
- No account, extension-owned network service or telemetry is required. Git actions use the local repository and its Git configuration.

The Marketplace extension ID is **`wangriyu.jetbrains-style-changes`**. If you used the local prototype `repolens-local.repolens`, disable it before enabling this extension to avoid duplicate view registrations. Its Changelist workspace data is not automatically transferred between extension identities; the `repolens.*` settings retain their existing names.

## 中文说明

**JetBrains 风格的多仓变更工作台。**

在 Source Control 中集中查看多个仓库的变更、冲突与文件差异，按需选择、暂存和提交。

- 在 Source Control 的 `…` 菜单启用 **全部变更**，原生 Changes、Repositories 和汇总视图共用一个入口。
- 支持“按状态分组”和“按变更列表分组”。在 `…` 菜单新建 Changelist；列表可包含多个仓库的文件，支持右键移动和拖拽，重载后保留归属。
- 勾选和移动文件只改变选择范围或逻辑分组，不自动执行 `git add`。
- **提交所选文件完整内容**会包含这些文件里尚未暂存的修改。若只想提交已暂存片段，使用**提交此仓库的已暂存文件**。
- **仅 Stash 所选文件**保存所选路径的暂存、未暂存与未跟踪内容，保留其他文件的状态；需要恢复原暂存状态时使用 `git stash apply --index`。
- 多仓选择在提交或 Stash 前需要选定一个仓库；冲突始终置顶，点击文件打开原生 diff。
- 默认扫描深度为 `2`。更深或隐藏仓库可通过 `repolens.additionalRepositories` 登记精确相对路径。

## Source and support

- [Source code](https://github.com/wangriyu/jetbrains-style-changes)
- [Report an issue](https://github.com/wangriyu/jetbrains-style-changes/issues)

The Marketplace **Q & A** tab is also available for questions. Include the editor version and a minimal reproduction using a sample repository; omit credentials and private source code.

## License

MIT.
