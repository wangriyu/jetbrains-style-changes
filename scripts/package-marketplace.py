#!/usr/bin/env python3
"""Build with official vsce and register the bundled gallery screenshot asset."""
from pathlib import Path
import json
import re
import runpy
import subprocess

ROOT = Path(__file__).resolve().parents[1]


if __name__ == "__main__":
    package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
    screenshot = runpy.run_path(str(ROOT / "scripts/register-marketplace-screenshot.py"))
    url = screenshot["gallery_url"](package)
    readme = ROOT / "README.md"
    readme.write_text(re.sub(r"https://[^/]+\.gallery\.vsassets\.io/_apis/public/gallery/publisher/[^/]+/extension/[^/]+/[^/]+/assetbyname/Microsoft\.VisualStudio\.Services\.Screenshots\.1",
                            url, readme.read_text(encoding="utf-8")), encoding="utf-8")
    vsix = ROOT / "dist" / f"jetbrains-style-changes-{package['version']}.vsix"
    vsix.parent.mkdir(exist_ok=True)
    subprocess.run(["npx", "--yes", "@vscode/vsce@4.1.1", "package", "--no-dependencies",
                    "--allow-missing-repository", "--out", str(vsix)], cwd=ROOT, check=True)
    print(json.dumps(screenshot["register"](vsix), ensure_ascii=False))
