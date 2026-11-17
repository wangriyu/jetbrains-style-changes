#!/usr/bin/env python3
"""Register the bundled overview as a Marketplace-addressable screenshot asset.

Run this after `vsce package`; only extension.vsixmanifest is changed. The
Marketplace serves the image by asset type, so README links use Screenshots.1.
"""
from pathlib import Path
import argparse
import hashlib
import json
import os
import tempfile
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parents[1]
ASSET_TYPE = "Microsoft.VisualStudio.Services.Screenshots.1"
ASSET_PATH = "extension/assets/overview.png"
NAMESPACE = "http://schemas.microsoft.com/developer/vsx-schema/2011"


def gallery_url(package):
    publisher = package["publisher"]
    return (f"https://{publisher}.gallery.vsassets.io/_apis/public/gallery/publisher/{publisher}"
            f"/extension/{package['name']}/{package.get('galleryScreenshotVersion', package['version'])}/assetbyname/{ASSET_TYPE}")


def register(vsix):
    with zipfile.ZipFile(vsix) as archive:
        entries = archive.infolist()
        files = {entry.filename: archive.read(entry.filename) for entry in entries}
    package = json.loads(files["extension/package.json"])
    expected_url = gallery_url(package)
    readme = next(files[name].decode("utf-8") for name in ["extension/readme.md", "extension/README.md"] if name in files)
    if expected_url not in readme:
        raise ValueError(f"README must reference the configured published screenshot asset URL: {expected_url}")
    if files.get(ASSET_PATH) != (ROOT / "assets/overview.png").read_bytes():
        raise ValueError("The bundled overview differs from assets/overview.png")
    ET.register_namespace("", NAMESPACE)
    ET.register_namespace("d", "http://schemas.microsoft.com/developer/vsx-schema-design/2011")
    root = ET.fromstring(files["extension.vsixmanifest"])
    assets = root.find(f"{{{NAMESPACE}}}Assets")
    if assets is None:
        raise ValueError("The VSIX manifest has no Assets element")
    existing = [item for item in assets if item.attrib.get("Type") == ASSET_TYPE]
    desired = {"Type": ASSET_TYPE, "Path": ASSET_PATH, "Addressable": "true"}
    if len(existing) == 1 and existing[0].attrib == desired:
        changed = False
    else:
        for item in existing:
            assets.remove(item)
        ET.SubElement(assets, f"{{{NAMESPACE}}}Asset", desired)
        files["extension.vsixmanifest"] = ET.tostring(root, encoding="utf-8", xml_declaration=True)
        handle, temporary = tempfile.mkstemp(prefix=".marketplace-screenshot-", suffix=".vsix", dir=vsix.parent)
        os.close(handle)
        try:
            with zipfile.ZipFile(temporary, "w") as archive:
                for entry in entries:
                    archive.writestr(entry, files[entry.filename])
            with zipfile.ZipFile(temporary) as archive:
                if archive.testzip() is not None:
                    raise ValueError("VSIX integrity check failed")
                for entry in entries:
                    if archive.read(entry.filename) != files[entry.filename]:
                        raise ValueError(f"VSIX entry changed unexpectedly: {entry.filename}")
            os.replace(temporary, vsix)
        finally:
            if os.path.exists(temporary):
                os.unlink(temporary)
        changed = True
    return {"vsix": str(vsix.resolve()), "changed": changed, "screenshotUrl": expected_url,
            "screenshotSha256": hashlib.sha256(files[ASSET_PATH]).hexdigest(),
            "sha256": hashlib.sha256(vsix.read_bytes()).hexdigest()}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("vsix", type=Path)
    args = parser.parse_args()
    print(json.dumps(register(args.vsix), ensure_ascii=False))
