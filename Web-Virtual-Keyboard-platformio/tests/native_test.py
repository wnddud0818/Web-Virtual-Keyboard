#!/usr/bin/env python3
"""Compile real HID/typing code and HTTP handlers with a fake USB/NVS/server.
Requires a C++17 compiler and the project's installed ArduinoJson dependency.
"""
from pathlib import Path
import shutil
import subprocess
import tempfile

project = Path(__file__).resolve().parent.parent
compiler = shutil.which("c++")
json_include = project / ".pio/libdeps/t-dongle-s3/ArduinoJson/src"
if not compiler or not json_include.is_dir():
    raise SystemExit("A C++17 compiler and ArduinoJson are required; run pio pkg install first.")
source = (project / "src/http_handlers.cpp").read_text()
# Compile the actual endpoint implementations, excluding board/network setup.
# Markers keep the test aligned with production rather than duplicating logic.
parts = [
    source[source.index("// === SPECIAL KEY TABLE ==="):source.index("// === REST API ===")],
    source[source.index("// POST /type  "):source.index("// GET /info")],
    source[source.index("// GET /presets"):],
]
with tempfile.TemporaryDirectory(prefix="wvk-native-") as output:
    output = Path(output)
    (output / "handlers.inc").write_text("\n".join(parts))
    binary = output / "native_test"
    subprocess.run([
        compiler, "-std=c++17", "-Wno-deprecated-declarations",
        "-I" + str(project / "tests/native"), "-I" + str(output),
        "-I" + str(project / "include"), "-I" + str(json_include),
        str(project / "tests/native_test.cpp"),
        str(project / "src/hid_keyboard.cpp"), str(project / "src/typing_engine.cpp"),
        "-o", str(binary),
    ], check=True)
    subprocess.run([str(binary)], check=True)
