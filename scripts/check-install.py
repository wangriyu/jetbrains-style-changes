#!/usr/bin/env python3
"""Verify VSIX installation in disposable editor directories, without activation."""
from pathlib import Path
import argparse
import hashlib
import json
import subprocess
import tempfile
import zipfile


parser = argparse.ArgumentParser()
parser.add_argument("--cli", required=True, help="Path to the editor CLI")
parser.add_argument("--vsix", required=True, type=Path)
args = parser.parse_args()
with zipfile.ZipFile(args.vsix) as archive:
    expected = json.loads(archive.read("extension/package.json"))
    main = expected["main"].removeprefix("./")
    expected_files = {name.removeprefix("extension/"): hashlib.sha256(archive.read(name)).hexdigest()
                      for name in archive.namelist()
                      if (name.startswith("extension/src/") and name.endswith(".js"))
                      or (name.startswith("extension/package.nls") and name.endswith(".json"))}
    expected_files[main] = hashlib.sha256(archive.read(f"extension/{main}")).hexdigest()
    english = json.loads(archive.read('extension/package.nls.json'))
identifier = f"{expected['publisher']}.{expected['name']}@{expected['version']}"

with tempfile.TemporaryDirectory(prefix="repolens-vsix-check-") as temp:
    base = Path(temp)
    extensions = base / "extensions"
    common = [args.cli, "--extensions-dir", str(extensions), "--user-data-dir", str(base / "user-data")]
    result = subprocess.run(common + ["--install-extension", str(args.vsix.resolve()), "--force"],
                            capture_output=True, text=True, timeout=60)
    if result.returncode:
        raise SystemExit(f"Install failed: {result.stdout}\n{result.stderr}")
    listing = subprocess.run(common + ["--list-extensions", "--show-versions"],
                             capture_output=True, text=True, timeout=60)
    if listing.returncode or identifier not in listing.stdout.splitlines():
        raise SystemExit(f"Installed extension not listed: {listing.stdout}\n{listing.stderr}")
    installed = []
    for manifest in extensions.glob("*/package.json"):
        data = json.loads(manifest.read_text(encoding="utf-8"))
        if f"{data.get('publisher')}.{data.get('name')}@{data.get('version')}" == identifier:
            installed.append(manifest.parent)
    assert len(installed) == 1, f"Expected one installed extension, found {len(installed)}"
    for name, expected_hash in expected_files.items():
        actual_hash = hashlib.sha256((installed[0] / name).read_bytes()).hexdigest()
        assert actual_hash == expected_hash, f"Installed runtime differs from VSIX: {name}"
    print(json.dumps({"result": "PASS", "extension": identifier,
                      "displayName": english.get(expected["displayName"].strip('%'), expected["displayName"]), "isolatedInstall": True,
                      "runtimeHashMatches": True, "runtimeFiles": len(expected_files)}, ensure_ascii=False))
