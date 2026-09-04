from pathlib import Path
import hashlib
import json
import re
import subprocess

Import("env")


PROJECT_DIR = Path(env["PROJECT_DIR"])
REPOSITORY_DIR = PROJECT_DIR.parent
INSTALLER_FIRMWARE_DIR = REPOSITORY_DIR / "docs" / "firmware"


def firmware_version() -> str:
    config_text = (PROJECT_DIR / "include" / "config.h").read_text(encoding="utf-8")
    match = re.search(r'^#define\s+FW_VERSION\s+"([^"]+)"', config_text, re.MULTILINE)
    if not match:
        raise RuntimeError("FW_VERSION was not found in include/config.h")
    return match.group(1)


def package_web_firmware(source, target, env):
    build_dir = Path(env.subst("$BUILD_DIR"))
    framework_dir = Path(
        env.PioPlatform().get_package_dir("framework-arduinoespressif32")
    )
    esptool_dir = Path(env.PioPlatform().get_package_dir("tool-esptoolpy"))

    boot_app = framework_dir / "tools" / "partitions" / "boot_app0.bin"
    esptool = esptool_dir / "esptool.py"
    merged_firmware = INSTALLER_FIRMWARE_DIR / "web-virtual-keyboard.bin"

    required_files = [
        build_dir / "bootloader.bin",
        build_dir / "partitions.bin",
        boot_app,
        build_dir / "firmware.bin",
        esptool,
    ]
    missing_files = [str(path) for path in required_files if not path.is_file()]
    if missing_files:
        raise RuntimeError("Missing web installer inputs: " + ", ".join(missing_files))

    INSTALLER_FIRMWARE_DIR.mkdir(parents=True, exist_ok=True)
    command = [
        env.subst("$PYTHONEXE"),
        str(esptool),
        "--chip",
        "esp32s3",
        "merge_bin",
        "-o",
        str(merged_firmware),
        "--flash_mode",
        "dio",
        "--flash_freq",
        "80m",
        "--flash_size",
        "16MB",
        "0x0",
        str(build_dir / "bootloader.bin"),
        "0x8000",
        str(build_dir / "partitions.bin"),
        "0xe000",
        str(boot_app),
        "0x10000",
        str(build_dir / "firmware.bin"),
    ]
    subprocess.run(command, check=True)

    version = firmware_version()
    manifest = {
        "name": "Web Virtual Keyboard",
        "version": version,
        "new_install_prompt_erase": True,
        "new_install_improv_wait_time": 0,
        "builds": [
            {
                "chipFamily": "ESP32-S3",
                "improv": False,
                "parts": [
                    {"path": "web-virtual-keyboard.bin", "offset": 0},
                ],
            }
        ],
    }
    (INSTALLER_FIRMWARE_DIR / "manifest.json").write_text(
        json.dumps(manifest, indent=2) + "\n", encoding="utf-8"
    )

    binary = merged_firmware.read_bytes()
    release = {
        "board": "LILYGO T-Dongle-S3",
        "chipFamily": "ESP32-S3",
        "version": version,
        "size": len(binary),
        "sha256": hashlib.sha256(binary).hexdigest(),
    }
    (INSTALLER_FIRMWARE_DIR / "release.json").write_text(
        json.dumps(release, indent=2) + "\n", encoding="utf-8"
    )

    print(
        "[web_installer] packaged "
        f"v{version} ({len(binary)} bytes) at {merged_firmware}"
    )


env.AddPostAction("$BUILD_DIR/${PROGNAME}.bin", package_web_firmware)
