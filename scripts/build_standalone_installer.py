#!/usr/bin/env python3
"""docs/index.html 과 펌웨어를 합쳐 더블클릭 가능한 단일 HTML을 만든다.

로컬 파일 fetch는 file:// 에서 차단되므로, manifest와 펌웨어를 HTML 안에
넣어두고 런타임에 blob URL로 바꿔 esp-web-tools에 넘긴다.
"""

from pathlib import Path
import base64
import json
import sys

REPOSITORY_DIR = Path(__file__).resolve().parent.parent
DOCS_DIR = REPOSITORY_DIR / "docs"
TEMPLATE = DOCS_DIR / "index.html"
FIRMWARE_DIR = DOCS_DIR / "firmware"
OUTPUT = DOCS_DIR / "wvk-flash-standalone.html"

MANIFEST_ANCHOR = '<script type="application/json" id="embedded-manifest"></script>'
FIRMWARE_ANCHOR = '<script type="text/plain" id="embedded-firmware"></script>'


def main() -> int:
    manifest = json.loads((FIRMWARE_DIR / "manifest.json").read_text(encoding="utf-8"))
    firmware_names = {
        part["path"] for build in manifest["builds"] for part in build["parts"]
    }
    if len(firmware_names) != 1:
        raise SystemExit(f"단일 파일 배포는 파트가 1개일 때만 가능합니다: {firmware_names}")

    binary = (FIRMWARE_DIR / firmware_names.pop()).read_bytes()
    encoded = base64.b64encode(binary).decode("ascii")

    html = TEMPLATE.read_text(encoding="utf-8")
    for anchor in (MANIFEST_ANCHOR, FIRMWARE_ANCHOR):
        if anchor not in html:
            raise SystemExit(f"docs/index.html 에서 자리표시자를 찾지 못했습니다: {anchor}")

    html = html.replace(
        MANIFEST_ANCHOR,
        '<script type="application/json" id="embedded-manifest">'
        + json.dumps(manifest)
        + "</script>",
    )
    html = html.replace(
        FIRMWARE_ANCHOR,
        '<script type="text/plain" id="embedded-firmware">' + encoded + "</script>",
    )

    OUTPUT.write_text(html, encoding="utf-8")
    print(
        f"[standalone] v{manifest['version']} · 펌웨어 {len(binary):,}B → "
        f"{OUTPUT.relative_to(REPOSITORY_DIR)} ({OUTPUT.stat().st_size:,}B)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
