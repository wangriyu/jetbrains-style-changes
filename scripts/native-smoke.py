#!/usr/bin/env python3
"""Run RepoLens in an isolated VS Code host with disposable Git fixtures."""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import plistlib
import shutil
import subprocess
import sys
import tempfile
import time


def editor_launcher(cli: str) -> tuple[str, bool]:
    """Use the macOS app executable directly instead of the CLI's open routing."""
    if sys.platform == "darwin":
        resolved = Path(cli).resolve()
        bundle = next((parent for parent in resolved.parents if parent.suffix == ".app"), None)
        if bundle is not None:
            with (bundle / "Contents" / "Info.plist").open("rb") as info:
                executable_name = plistlib.load(info).get("CFBundleExecutable")
            if not isinstance(executable_name, str) or Path(executable_name).name != executable_name:
                raise RuntimeError(f"Invalid CFBundleExecutable in {bundle}")
            executable = bundle / "Contents" / "MacOS" / executable_name
            if not executable.is_file():
                raise RuntimeError(f"Editor app executable does not exist: {executable}")
            return str(executable), True
    return cli, False


def git_environment() -> dict[str, str]:
    environment = os.environ.copy()
    for key in list(environment):
        if key in {"GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY",
                   "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_CONFIG_COUNT", "GIT_CONFIG_PARAMETERS"} or key.startswith(("GIT_CONFIG_KEY_", "GIT_CONFIG_VALUE_")):
            environment.pop(key, None)
    environment["GIT_CONFIG_GLOBAL"] = os.devnull
    environment["GIT_CONFIG_NOSYSTEM"] = "1"
    return environment


def prepare_fixture(base: Path) -> tuple[Path, dict, dict[str, str]]:
    workspace = base / f"RepoLens-smoke-{base.name.rsplit('-', 1)[-1]}"
    control = base / "control"
    workspace.mkdir()
    control.mkdir()
    hooks = control / "empty-hooks"
    template = control / "empty-git-template"
    hooks.mkdir()
    template.mkdir()
    environment = git_environment()
    environment["GIT_TEMPLATE_DIR"] = str(template)

    def git(repository: Path, *arguments: str) -> str:
        return subprocess.run(["git", "-C", str(repository), *arguments], env=environment,
                              check=True, text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE).stdout

    def initialize(name: str, contents: dict[str, str], parent: Path = workspace) -> Path:
        repository = parent / name
        repository.mkdir()
        git(repository, "init", "--initial-branch=main")
        git(repository, "config", "user.name", "RepoLens Native Test")
        git(repository, "config", "user.email", "repolens-smoke@example.invalid")
        git(repository, "config", "commit.gpgsign", "false")
        git(repository, "config", "core.hooksPath", str(hooks))
        for filename, content in contents.items():
            (repository / filename).write_text(content, encoding="utf-8")
        git(repository, "add", "--", *contents.keys())
        git(repository, "commit", "-m", "test: isolated RepoLens baseline")
        assert git(repository, "remote").strip() == ""
        return repository

    baseline_tracked = "alpha baseline\nsecond line\n"
    modified_tracked = "alpha edited\nsecond line\n"
    baseline_staged = "staged baseline\n"
    modified_staged = "staged change\n"
    untracked_text = "new fixture file\nsecond new line\n"
    alpha = initialize("alpha", {"tracked.txt": baseline_tracked, "staged.txt": baseline_staged})
    beta = initialize("beta", {"other.txt": "beta baseline\n"})
    (alpha / "tracked.txt").write_text(modified_tracked, encoding="utf-8")
    (alpha / "staged.txt").write_text(modified_staged, encoding="utf-8")
    untracked_file = alpha / "one" / "two" / "three" / "four" / "new.txt"
    untracked_file.parent.mkdir(parents=True)
    untracked_file.write_text(untracked_text, encoding="utf-8")
    # Keep each directory level visible in the compact tree so expansion must
    # traverse more than the native reveal API's three-level limit.
    for depth in range(1, 4):
        sibling = alpha.joinpath(*("one", "two", "three")[:depth], "neighbor.txt")
        sibling.write_text("unchanged by RepoLens actions\n", encoding="utf-8")
    git(alpha, "add", "--", "staged.txt")
    (beta / "other.txt").write_text("beta edited\n", encoding="utf-8")

    # These repositories stay outside the workspace scan. The native runner
    # opens them only after the original two-repository/diff checks finish.
    workflow_root = control / "selected-workflows"
    workflow_root.mkdir()
    workflow_repositories = []
    for name in ("selected-commit", "selected-stash"):
        baseline = {"selected.txt": "selected baseline\n", "unselected.txt": "unselected baseline\n",
                    "old name.txt": "rename baseline\n"}
        repository = initialize(name, baseline, workflow_root)
        (repository / "selected.txt").write_text("selected staged\n", encoding="utf-8")
        (repository / "unselected.txt").write_text("unselected staged\n", encoding="utf-8")
        git(repository, "add", "--", "selected.txt", "unselected.txt")
        (repository / "selected.txt").write_text("selected complete working copy\n", encoding="utf-8")
        (repository / "unselected.txt").write_text("unselected complete working copy\n", encoding="utf-8")
        (repository / "untracked name.txt").write_text("selected untracked contents\n", encoding="utf-8")
        if name == "selected-commit":
            git(repository, "mv", "--", "old name.txt", "new name.txt")
        workflow_repositories.append({"name": name, "path": str(repository),
                                      "selected": str(repository / "selected.txt"),
                                      "unselected": str(repository / "unselected.txt"),
                                      "untracked": str(repository / "untracked name.txt")})
    (workspace / ".vscode").mkdir()
    (workspace / ".vscode" / "settings.json").write_text(json.dumps({
        "git.autoRepositoryDetection": True,
        "git.repositoryScanMaxDepth": 2,
        "git.openRepositoryInParentFolders": "never",
        "git.mergeEditor": True,
        "git.autofetch": False,
        "workbench.startupEditor": "none",
    }, indent=2), encoding="utf-8")
    fixture = {
        "workspace": str(workspace),
        "expectedFiles": 7,
        "workflowRepositories": workflow_repositories,
        "repositories": [
            {"name": "alpha", "path": str(alpha), "tracked": str(alpha / "tracked.txt"),
             "staged": str(alpha / "staged.txt"), "untracked": str(untracked_file),
             "baselineTracked": baseline_tracked, "modifiedTracked": modified_tracked,
             "baselineStaged": baseline_staged, "modifiedStaged": modified_staged,
             "untrackedText": untracked_text},
            {"name": "beta", "path": str(beta), "tracked": str(beta / "other.txt")}
        ],
    }
    fixture_path = control / "fixture.json"
    fixture_path.write_text(json.dumps(fixture, indent=2), encoding="utf-8")
    return fixture_path, fixture, environment


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--hold", action="store_true", help="Keep the isolated window until its finish.marker or ten minutes")
    parser.add_argument("--cli", help="VS Code CLI executable path")
    parser.add_argument("--locale", choices=("en", "zh-cn"), default="en", help="Editor display language requested for this isolated host")
    parser.add_argument("--timeout", type=float, default=180, help="Seconds to await test results (default: 180)")
    arguments = parser.parse_args()
    project = Path(__file__).resolve().parents[1]
    runner = project / "tests" / "native-runner.cjs"
    cli = arguments.cli or shutil.which("code")
    if cli is None:
        candidate = Path("/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code")
        if candidate.is_file():
            cli = str(candidate)
    if not cli or not Path(cli).is_file():
        parser.error("VS Code CLI not found; pass --cli /path/to/code")
    launcher, direct_app = editor_launcher(str(cli))
    if not (project / "package.json").is_file() or not runner.is_file():
        parser.error("RepoLens package.json and tests/native-runner.cjs must exist before running")
    if shutil.which("git") is None:
        parser.error("Git must be available on PATH")

    # macOS Unix-domain IPC sockets are limited to 103 bytes. Its default
    # per-user temp path can make an isolated Electron user-data path too long.
    base = Path(tempfile.mkdtemp(prefix="repolens-native-", dir="/tmp" if sys.platform == "darwin" else None)).resolve()
    fixture_path, fixture, environment = prepare_fixture(base)
    control = fixture_path.parent
    result_path = control / "result.json"
    finish_marker = control / "finish.marker"
    log_path = control / "native-host.log"
    for key in ("VSCODE_IPC_HOOK_CLI", "VSCODE_CWD", "ELECTRON_RUN_AS_NODE"):
        environment.pop(key, None)
    environment.update({
        "REPOLENS_TEST_RESULT": str(result_path),
        "REPOLENS_TEST_FIXTURE": str(fixture_path),
        "REPOLENS_TEST_FINISH_MARKER": str(finish_marker),
        "REPOLENS_TEST_HOLD": "1" if arguments.hold else "0",
    })
    command = [launcher, "--new-window", *([] if direct_app else ["--wait"]), "--skip-welcome", "--skip-release-notes",
               "--disable-workspace-trust", f"--locale={arguments.locale}", "--user-data-dir", str(base / "user-data"),
               "--extensions-dir", str(base / "extensions"),
               f"--extensionDevelopmentPath={project}", f"--extensionTestsPath={runner}", fixture["workspace"]]
    print(json.dumps({"fixtureRoot": str(base), "workspace": fixture["workspace"],
                      "resultPath": str(result_path), "finishMarker": str(finish_marker),
                      "logPath": str(log_path), "hold": arguments.hold,
                      "launcher": launcher, "directApp": direct_app}, indent=2), flush=True)
    with log_path.open("w", encoding="utf-8") as log:
        process = subprocess.Popen(command, env=environment, stdout=log, stderr=subprocess.STDOUT,
                                   start_new_session=True)
        print(f"Started isolated editor {'app' if direct_app else 'CLI'} PID {process.pid}", flush=True)
        deadline = time.monotonic() + arguments.timeout
        result = None
        announced_ready = False
        try:
            while True:
                if result_path.is_file():
                    try:
                        result = json.loads(result_path.read_text(encoding="utf-8"))
                    except (OSError, json.JSONDecodeError):
                        result = None
                if result and result.get("phase") in {"ready", "finished", "failed"}:
                    if not announced_ready:
                        print(json.dumps(result, indent=2, ensure_ascii=False), flush=True)
                        announced_ready = True
                        if arguments.hold and result.get("phase") == "ready":
                            print(f"Visual check ready; create {finish_marker} to finish this test window.", flush=True)
                            deadline = time.monotonic() + 620
                    if result.get("phase") in {"finished", "failed"}:
                        break
                code = process.poll()
                if code is not None and code != 0:
                    raise RuntimeError(f"Isolated VS Code CLI exited with {code}; inspect {log_path}")
                if time.monotonic() >= deadline:
                    raise TimeoutError(f"Timed out waiting for native runner; inspect {result_path} and {log_path}")
                time.sleep(0.25)
            try:
                process.wait(timeout=20)
            except subprocess.TimeoutExpired:
                print("Runner completed; isolated editor process is still shutting down.", flush=True)
            if process.poll() not in (None, 0):
                return 1
            return 0 if result and result.get("ok") else 1
        except KeyboardInterrupt:
            finish_marker.write_text("controller interrupted\n", encoding="utf-8")
            print(f"Requested graceful completion via {finish_marker}", flush=True)
            return 130
        except Exception as error:
            finish_marker.write_text("controller failure\n", encoding="utf-8")
            print(str(error), file=sys.stderr, flush=True)
            return 1


if __name__ == "__main__":
    raise SystemExit(main())
