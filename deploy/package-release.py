#!/usr/bin/env python3
"""Create the allowlisted source release using Python 3.11+ standard library only."""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import tempfile
from html.parser import HTMLParser
import zipfile

VERSION = "0.1.0"
PLUGIN_VERSION = "0.1.3"
NAME = f"nf-workbench-{VERSION}"
ROOT = Path(__file__).absolute().parent.parent
MAX_MEMBERS = 192
MAX_FILE = 4 * 1024 * 1024
MAX_TOTAL = 16 * 1024 * 1024
MAX_ARCHIVE = 8 * 1024 * 1024
ZIP_TIME = (2020, 1, 1, 0, 0, 0)
PLUGIN = f"packages/nf-connector/dist/local.nf-hub.connector-{PLUGIN_VERSION}.nfplugin"

# Exact filenames, not a repository walk or a root copy followed by exclusions.
TEXT_GROUPS = {
    "": (
        "package.json", "bun.lock", "tsconfig.json", ".gitignore", ".env.example", ".dockerignore",
    ),
    "apps/server": ("package.json",),
    "apps/server/src": (
        "activity.ts", "app.ts", "auth.ts", "backup.ts", "cli.ts", "config.ts", "connection.ts",
        "connector-routes.ts", "dashboard.ts", "db.ts", "errors.ts", "http-types.ts",
        "instances.ts", "limits.ts", "main.ts", "migrations.ts", "pairing.ts",
        "static.ts", "sync.ts", "web-routes.ts",
    ),
    "apps/server/test": (
        "activity.test.ts", "auth-http.test.ts", "dashboard.test.ts", "fixture.ts", "groups.test.ts", "instances.test.ts",
        "limits.test.ts", "recovery.test.ts", "static.test.ts", "sync.test.ts",
    ),
    "apps/web": ("package.json", "index.html", "tsconfig.json", "vite.config.ts"),
    "apps/web/public": ("theme-init.js",),
    "apps/web/src": ("App.tsx", "main.tsx", "styles.css"),
    "apps/web/src/components": (
        "AppearanceMenu.tsx", "Common.tsx", "ConnectionPathGuide.tsx", "HttpAccessGuide.tsx",
        "Icon.tsx", "InstanceEditor.tsx", "InstanceTabs.tsx", "OverviewCards.tsx", "PairingDialog.tsx",
        "SessionCards.css", "SessionCards.tsx", "httpFrontAddress.ts",
    ),
    "apps/web/src/hooks": ("useAppearance.ts", "useAppState.tsx", "useData.ts", "useTabActivity.ts"),
    "apps/web/src/lib": (
        "api.ts", "errors.ts", "format.ts", "frames.ts", "httpAccessTemplates.ts", "navigation.ts",
        "tabActivity.ts", "tabs.ts", "useInstanceTabs.ts",
    ),
    "apps/web/src/pages": (
        "ConnectionsPage.tsx", "LoginPage.tsx", "SessionsPage.tsx", "WorkbenchPage.tsx",
    ),
    "apps/web/test": (
        "appearance.test.tsx", "components.test.tsx", "format.test.ts", "http-access.test.tsx",
        "instance-tabs.test.tsx", "navigation.test.ts", "security-state.test.ts", "session-cards.test.tsx",
    ),
    "packages/protocol": ("package.json",),
    "packages/protocol/src": ("activity.ts", "connector.ts", "constants.ts", "index.ts", "summary.ts", "url.ts", "web.ts"),
    "packages/protocol/test": ("contract.test.ts", "url.test.ts"),
    "packages/nf-connector": ("package.json", "manifest.json", "tsconfig.json"),
    "packages/nf-connector/src": (
        "activity.ts", "center-trust.ts", "collection.ts", "config.ts", "constants.ts", "controller.ts",
        "errors.ts", "host-rpc.ts", "index.ts", "pem.ts", "runtime.ts", "transport.ts",
    ),
    "packages/nf-connector/ui": ("panel.ts",),
    "packages/nf-connector/scripts": ("build.ts", "check-host-manifest.ts", "package.ts"),
    "packages/nf-connector/test": (
        "activation-read.test.ts", "activity-controller.test.ts", "activity.test.ts", "center-trust.test.ts", "collection.test.ts", "controller.test.ts",
        "ephemeral-pki.ts", "fixtures.ts", "host-transport.test.ts",
    ),
    "deploy": (
        ".env.example", "Caddy.Dockerfile", "Caddyfile", "Caddyfile.nf.example", "compose.public.yaml",
        "compose.yaml", "Dockerfile", "hub.sh", "package-release.py",
    ),
    # Public device-side templates. They are the single source inlined into the web
    # bundle by Vite `?raw`, so the release must carry them verbatim. All three are
    # plain text configuration with no key, token, CA or real environment value.
    "deploy/http-device-https": ("Caddyfile", "compose.yaml", "settings.env.example"),
}
STRICT_SOURCE_ROOTS = (
    "apps/server/src", "apps/server/test", "apps/web/src", "apps/web/test",
    "packages/protocol/src", "packages/protocol/test", "packages/nf-connector/src",
    "packages/nf-connector/ui", "packages/nf-connector/scripts", "packages/nf-connector/test",
    "deploy/http-device-https",
)
TEXT_MEMBERS = tuple(
    f"{folder}/{name}" if folder else name
    for folder, names in TEXT_GROUPS.items() for name in names
)
PRIVATE_KEY = re.compile(
    rb"-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----\s+"
    rb"[A-Za-z0-9+/=\r\n ]{40,}-----END (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----"
)
ASSET = re.compile(r"/assets/[A-Za-z0-9_-]+-[A-Za-z0-9_-]{6,}\.(?:js|css)\Z")


def fail(message: str) -> None:
    raise ValueError(message)


def check_node(path: Path, *, directory: bool = False) -> os.stat_result:
    info = path.lstat()
    reparse = getattr(info, "st_file_attributes", 0) & 0x400
    if stat.S_ISLNK(info.st_mode) or reparse:
        fail(f"Symlink/reparse point refused: {path}")
    if directory:
        if not stat.S_ISDIR(info.st_mode):
            fail(f"Expected a directory: {path}")
    elif not stat.S_ISREG(info.st_mode) or info.st_nlink != 1:
        fail(f"Expected a regular, single-link file: {path}")
    return info


def check_directory(path: Path) -> None:
    # Includes ancestors so a junction in a parent cannot redirect input/output.
    for parent in reversed((path, *path.parents)):
        check_node(parent, directory=True)


def member_path(name: str) -> Path:
    relative = PurePosixPath(name)
    if not name or relative.is_absolute() or relative.as_posix() != name or any(
        p in ("", ".", "..") or ":" in p or "\\" in p for p in relative.parts
    ):
        fail(f"Unexpected archive path: {name}")
    path = ROOT.joinpath(*relative.parts)
    check_directory(path.parent)
    return path


def fingerprint(info: os.stat_result) -> tuple[int, int, int, int]:
    return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns


def read_member(name: str, *, text: bool = True) -> bytes:
    path = member_path(name)
    before = check_node(path)
    if before.st_size > MAX_FILE:
        fail(f"File exceeds {MAX_FILE} bytes: {name}")
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    fd = os.open(path, flags)
    try:
        if fingerprint(os.fstat(fd)) != fingerprint(before):
            fail(f"Input changed before reading: {name}")
        with os.fdopen(fd, "rb", closefd=False) as source:
            data = source.read(MAX_FILE + 1)
        after = os.fstat(fd)
    finally:
        os.close(fd)
    check_directory(path.parent)
    if len(data) > MAX_FILE or fingerprint(after) != fingerprint(before) or fingerprint(check_node(path)) != fingerprint(before):
        fail(f"Input changed while reading: {name}")
    if text:
        decoded = data.decode("utf-8")
        if any(ord(c) < 32 and c not in "\t\r\n" for c in decoded):
            fail(f"Non-text data refused: {name}")
        if PRIVATE_KEY.search(data):
            fail(f"Private key material refused: {name}")
    return data


def check_source_inventory() -> None:
    allowed_files = set(TEXT_MEMBERS)
    allowed_dirs = {str(parent) for name in TEXT_MEMBERS for parent in PurePosixPath(name).parents}
    pending = list(STRICT_SOURCE_ROOTS)
    while pending:
        folder = pending.pop()
        path = ROOT / folder
        check_directory(path)
        with os.scandir(path) as entries:
            for entry in entries:
                name = f"{folder}/{entry.name}"
                if name in allowed_dirs:
                    check_node(Path(entry.path), directory=True)
                    pending.append(name)
                elif name in allowed_files:
                    check_node(Path(entry.path))
                else:
                    fail(f"Unexpected source input; audit and update the explicit allowlist: {name}")


class AssetReferences(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.paths: set[str] = set()

    def handle_starttag(self, tag: str, attributes: list[tuple[str, str | None]]) -> None:
        values = dict(attributes)
        ref = values.get("src") if tag == "script" else values.get("href") if tag == "link" else None
        if ref is not None:
            if not ASSET.fullmatch(ref) and not (tag == "script" and ref == "/theme-init.js"):
                fail(f"Unexpected built asset reference: {ref}")
            self.paths.add("apps/web/dist" + ref)


def web_assets() -> dict[str, bytes]:
    index = "apps/web/dist/index.html"
    result = {index: read_member(index)}
    parser = AssetReferences()
    parser.feed(result[index].decode("utf-8"))
    hashed_paths = {name for name in parser.paths if name.startswith("apps/web/dist/assets/")}
    if not 1 <= len(hashed_paths) <= 16 or not any(name.endswith(".js") for name in hashed_paths):
        fail("Expected a built Vite index with 1..16 local hashed JS/CSS references")
    if "apps/web/dist/theme-init.js" not in parser.paths:
        fail("Expected the exact first-paint script /theme-init.js")
    for folder, expected in (
        ("apps/web/dist", {"index.html", "assets", "theme-init.js"}),
        ("apps/web/dist/assets", {PurePosixPath(name).name for name in hashed_paths}),
    ):
        check_directory(ROOT / folder)
        with os.scandir(ROOT / folder) as entries:
            actual = {entry.name for entry in entries}
        if actual != expected:
            fail(f"Unexpected/missing dist entries in {folder}: {sorted(actual ^ expected)}")
    for name in sorted(parser.paths):
        result[name] = read_member(name)
    if result["apps/web/dist/theme-init.js"] != read_member("apps/web/public/theme-init.js"):
        fail("First-paint script differs from its allowlisted source; rebuild the web app")
    return result


def validate_plugin(data: bytes, source_manifest: bytes) -> None:
    expected = {"manifest.json", "server/index.js", "ui/panel.iife.js"}
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        entries = archive.infolist()
        if len(entries) != 3 or {item.filename for item in entries} != expected:
            fail("Plugin must contain exactly the three audited runtime entries")
        if sum(item.file_size for item in entries) > MAX_FILE:
            fail("Plugin expands beyond the release limit")
        for item in entries:
            if item.is_dir() or item.flag_bits & 1 or stat.S_ISLNK(item.external_attr >> 16):
                fail("Unexpected plugin directory, encryption or symlink")
            raw = archive.read(item)
            raw.decode("utf-8")
            if b"\x00" in raw or PRIVATE_KEY.search(raw):
                fail("Unexpected binary/private key material in plugin")
        manifest = json.loads(archive.read("manifest.json"))
        if manifest != json.loads(source_manifest) or manifest.get("version") != PLUGIN_VERSION:
            fail("Plugin archive/source manifest mismatch or unexpected version")


def collect() -> dict[str, bytes]:
    check_directory(ROOT)
    check_source_inventory()
    files = {name: read_member(name) for name in TEXT_MEMBERS}
    package = json.loads(files["package.json"])
    connector = json.loads(files["packages/nf-connector/package.json"])
    if package.get("version") != VERSION or package.get("packageManager") != "bun@1.3.14" or connector.get("version") != PLUGIN_VERSION:
        fail("Unexpected release version or Bun package manager")
    files.update(web_assets())
    files[PLUGIN] = read_member(PLUGIN, text=False)
    validate_plugin(files[PLUGIN], files["packages/nf-connector/manifest.json"])
    if len(files) != len(TEXT_MEMBERS) + 1 + len([n for n in files if n.startswith("apps/web/dist/")]):
        fail("Duplicate archive member")
    if len(files) > MAX_MEMBERS or sum(map(len, files.values())) > MAX_TOTAL:
        fail("Release exceeds member-count or uncompressed-size limit")
    return dict(sorted(files.items()))


def archive_bytes(files: dict[str, bytes]) -> bytes:
    output = io.BytesIO()
    with zipfile.ZipFile(output, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9, allowZip64=False) as archive:
        for name, data in files.items():
            item = zipfile.ZipInfo(name, ZIP_TIME)
            item.create_system = 3
            mode = 0o755 if name in {"deploy/hub.sh", "deploy/package-release.py"} else 0o644
            item.external_attr = (stat.S_IFREG | mode) << 16
            item.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(item, data, compresslevel=9)
    result = output.getvalue()
    if len(result) > MAX_ARCHIVE:
        fail("Compressed release exceeds size limit")
    return result


def publish(outputs: dict[str, bytes]) -> None:
    destination = ROOT / "artifacts"
    check_directory(ROOT)
    if not destination.exists() and not destination.is_symlink():
        destination.mkdir(mode=0o700)
    check_directory(destination)
    for name in outputs:
        target = destination / name
        if os.path.lexists(target):
            check_node(target)
    pending: list[tuple[Path, Path]] = []
    try:
        for name, content in outputs.items():
            fd, temporary = tempfile.mkstemp(prefix=f".{NAME}.", suffix=".tmp", dir=destination)
            path = Path(temporary)
            pending.append((path, destination / name))
            with os.fdopen(fd, "wb") as target:
                target.write(content)
                target.flush()
                os.fsync(target.fileno())
        check_directory(destination)
        for source, target in pending:
            if os.path.lexists(target):
                check_node(target)
            os.replace(source, target)
    finally:
        for source, _ in pending:
            if os.path.lexists(source):
                check_node(source)
                source.unlink()


def main() -> None:
    parser = argparse.ArgumentParser(
        description=f"Package the explicit source allowlist, existing web dist and connector {PLUGIN_VERSION}; never install or rebuild.",
        epilog="Output: artifacts/nf-workbench-0.1.0.zip, .zip.sha256 and .manifest.json. This is NOT a dependency-free executable: use Bun 1.3.14, bun install --frozen-lockfile, then admin init/start.",
    )
    parser.add_argument("--list", action="store_true", help="Validate inputs and list paths/hashes without creating any outputs")
    args = parser.parse_args()
    files = collect()
    packed = archive_bytes(files)
    digest = hashlib.sha256(packed).hexdigest()
    manifest = {
        "archive": NAME + ".zip", "sha256": digest, "members": len(files),
        "uncompressedBytes": sum(map(len, files.values())), "archiveBytes": len(packed),
        "files": [{"path": name, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()} for name, data in files.items()],
    }
    if not args.list:
        publish({
            NAME + ".zip": packed,
            NAME + ".zip.sha256": f"{digest}  {NAME}.zip\n".encode("ascii"),
            NAME + ".manifest.json": (json.dumps(manifest, ensure_ascii=False, indent=2) + "\n").encode("utf-8"),
        })
    print(json.dumps(manifest, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, zipfile.BadZipFile, zipfile.LargeZipFile) as error:
        print(f"Release refused: {error}", file=sys.stderr)
        raise SystemExit(1)
