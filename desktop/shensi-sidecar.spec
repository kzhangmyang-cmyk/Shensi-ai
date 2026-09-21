from pathlib import Path

from PyInstaller.utils.hooks import (
    collect_data_files,
    collect_submodules,
    copy_metadata,
)


desktop_root = Path(SPECPATH).resolve()
repository_root = desktop_root.parent
service_root = repository_root / "services" / "media-crawler"
entrypoint = desktop_root / "scripts" / "frozen-sidecar-entrypoint.py"

datas = [
    (str(service_root / "LICENSE"), "."),
    (str(service_root / "libs" / "stealth.min.js"), "libs"),
    (str(service_root / "libs" / "douyin.js"), "libs"),
    (
        str(service_root / "shensi_adapter" / "vendor" / "douyin_spider" / "utils" / "mstoken_profile.json"),
        "shensi_adapter/vendor/douyin_spider/utils",
    ),
    (
        str(service_root / "shensi_adapter" / "vendor" / "douyin_spider" / "utils" / "mstoken_common_profile.json"),
        "shensi_adapter/vendor/douyin_spider/utils",
    ),
]
datas += collect_data_files("playwright")
datas += copy_metadata("playwright")
datas += collect_data_files("certifi")
datas += copy_metadata("certifi")

hiddenimports = []
for package in (
    "playwright",
    "shensi_adapter",
    "media_platform.douyin",
    "store.douyin",
    "tools",
    "base",
):
    hiddenimports += collect_submodules(package)

a = Analysis(
    [str(entrypoint)],
    pathex=[str(service_root)],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    noarchive=False,
    optimize=0,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="shensi-sidecar",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,
)
coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="shensi-sidecar",
)
