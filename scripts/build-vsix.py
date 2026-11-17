#!/usr/bin/env python3
"""Build JetBrains-style Changes VSIX and source migration ZIP using only Python's standard library."""
from pathlib import Path
import hashlib
import json
import re
import zipfile
import xml.etree.ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
NLS = json.loads((ROOT / "package.nls.json").read_text(encoding="utf-8")) if (ROOT / "package.nls.json").is_file() else {}
DIST = ROOT / "dist"
VERSION = PACKAGE["version"]
VSIX = DIST / f"jetbrains-style-changes-{VERSION}.vsix"
SOURCE = DIST / f"jetbrains-style-changes-{VERSION}-source.zip"
STAMP = (2026, 11, 16, 0, 0, 0)


def write(archive, name, data):
    info = zipfile.ZipInfo(name, date_time=STAMP)
    info.compress_type = zipfile.ZIP_DEFLATED
    info.external_attr = 0o100644 << 16
    archive.writestr(info, data)


def make_manifest():
    namespace = "http://schemas.microsoft.com/developer/vsx-schema/2011"
    ET.register_namespace("", namespace)
    tag = lambda name: f"{{{namespace}}}{name}"
    root = ET.Element(tag("PackageManifest"), {"Version": "2.0.0"})
    metadata = ET.SubElement(root, tag("Metadata"))
    ET.SubElement(metadata, tag("Identity"), {
        "Language": "en-US", "Id": PACKAGE["name"], "Version": VERSION,
        "Publisher": PACKAGE["publisher"]
    })
    for name, value in [("DisplayName", PACKAGE["displayName"]), ("Description", PACKAGE["description"]),
                        ("Tags", ",".join(PACKAGE.get("keywords", []))),
                        ("Categories", ",".join(PACKAGE.get("categories", [])))]:
        if isinstance(value, str) and value.startswith("%") and value.endswith("%"):
            value = NLS.get(value[1:-1], value)
        ET.SubElement(metadata, tag(name)).text = value
    properties = ET.SubElement(metadata, tag("Properties"))
    for key, value in {
        "Microsoft.VisualStudio.Code.Engine": PACKAGE["engines"]["vscode"],
        "Microsoft.VisualStudio.Code.ExtensionDependencies": ",".join(PACKAGE["extensionDependencies"]),
        "Microsoft.VisualStudio.Code.ExtensionKind": "workspace",
        "Microsoft.VisualStudio.Code.ExecutesCode": "true",
        "Microsoft.VisualStudio.Services.Content.Pricing": "Free"
    }.items():
        ET.SubElement(properties, tag("Property"), {"Id": key, "Value": value})
    ET.SubElement(metadata, tag("License")).text = "extension/LICENSE.txt"
    ET.SubElement(metadata, tag("Icon")).text = f"extension/{PACKAGE['icon']}"
    target = ET.SubElement(root, tag("Installation"))
    ET.SubElement(target, tag("InstallationTarget"), {"Id": "Microsoft.VisualStudio.Code"})
    ET.SubElement(root, tag("Dependencies"))
    assets = ET.SubElement(root, tag("Assets"))
    for kind, name in [
        ("Microsoft.VisualStudio.Code.Manifest", "package.json"),
        ("Microsoft.VisualStudio.Services.Content.Details", "README.md"),
        ("Microsoft.VisualStudio.Services.Content.Changelog", "CHANGELOG.md"),
        ("Microsoft.VisualStudio.Services.Content.License", "LICENSE.txt"),
        ("Microsoft.VisualStudio.Services.Icons.Default", PACKAGE["icon"]),
        ("Microsoft.VisualStudio.Services.Screenshots.1", "assets/overview.png")
    ]:
        ET.SubElement(assets, tag("Asset"), {"Type": kind, "Path": f"extension/{name}", "Addressable": "true"})
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


def content_types():
    namespace = "http://schemas.openxmlformats.org/package/2006/content-types"
    ET.register_namespace("", namespace)
    root = ET.Element(f"{{{namespace}}}Types")
    for suffix, mime in {"json": "application/json", "js": "application/javascript",
                         "md": "text/markdown", "txt": "text/plain", "png": "image/png", "vsixmanifest": "text/xml"}.items():
        ET.SubElement(root, f"{{{namespace}}}Default", {"Extension": suffix, "ContentType": mime})
    return ET.tostring(root, encoding="utf-8", xml_declaration=True)


if __name__ == "__main__":
    DIST.mkdir(exist_ok=True)
    screenshot_url = (f"https://{PACKAGE['publisher']}.gallery.vsassets.io/_apis/public/gallery/publisher/{PACKAGE['publisher']}"
                      f"/extension/{PACKAGE['name']}/{PACKAGE.get('galleryScreenshotVersion', VERSION)}/assetbyname/Microsoft.VisualStudio.Services.Screenshots.1")
    readme = ROOT / "README.md"
    readme.write_text(re.sub(r"https://[^/]+\.gallery\.vsassets\.io/_apis/public/gallery/publisher/[^/]+/extension/[^/]+/[^/]+/assetbyname/Microsoft\.VisualStudio\.Services\.Screenshots\.1",
                            screenshot_url, readme.read_text(encoding="utf-8")), encoding="utf-8")
    runtime = {name: ROOT / name for name in ["package.json", "README.md", "CHANGELOG.md"]}
    runtime.update({path.name: path for path in sorted(ROOT.glob("package.nls*.json"))})
    runtime["LICENSE.txt"] = ROOT / "LICENSE"
    runtime[PACKAGE["icon"]] = ROOT / PACKAGE["icon"]
    runtime["assets/overview.png"] = ROOT / "assets/overview.png"
    runtime.update({path.relative_to(ROOT).as_posix(): path for path in sorted((ROOT / "src").glob("*.js"))})
    with zipfile.ZipFile(VSIX, "w") as archive:
        write(archive, "extension.vsixmanifest", make_manifest())
        write(archive, "[Content_Types].xml", content_types())
        for name, path in runtime.items():
            write(archive, f"extension/{name}", path.read_bytes())
    with zipfile.ZipFile(VSIX) as archive:
        assert archive.testzip() is None
        assert json.loads(archive.read("extension/package.json"))["name"] == PACKAGE["name"]
        assert archive.read("extension/src/extension.js") == (ROOT / "src/extension.js").read_bytes()
    source_files = [ROOT / name for name in ["package.json", "README.md", "CHANGELOG.md", "DESIGN.md", "LICENSE"]]
    source_files.extend(sorted(ROOT.glob("package.nls*.json")))
    source_files.extend([ROOT / ".vscodeignore", ROOT / PACKAGE["icon"], ROOT / "assets/overview.png"])
    for folder, suffixes in [("src", {".js"}), ("tests", {".cjs"}), ("scripts", {".py", ".cjs"}),
                             ("workspace-config", {".json"})]:
        source_files.extend(path for path in sorted((ROOT / folder).rglob("*"))
                            if path.is_file() and path.suffix in suffixes)
    if (ROOT / "INSTALL-CHECKS.md").is_file():
        source_files.append(ROOT / "INSTALL-CHECKS.md")
    source_files.append(VSIX)
    with zipfile.ZipFile(SOURCE, "w") as archive:
        for path in source_files:
            write(archive, f"jetbrains-style-changes/{path.relative_to(ROOT).as_posix()}", path.read_bytes())
    with zipfile.ZipFile(SOURCE) as archive:
        assert archive.testzip() is None
    (DIST / "SHA256SUMS").write_text("".join(
        f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n" for path in [VSIX, SOURCE]
    ), encoding="utf-8")
    print(json.dumps({"vsix": VSIX.name, "vsixBytes": VSIX.stat().st_size,
                      "source": SOURCE.name, "sourceBytes": SOURCE.stat().st_size,
                      "extensionId": f"{PACKAGE['publisher']}.{PACKAGE['name']}"}, ensure_ascii=False))
