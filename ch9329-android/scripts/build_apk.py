#!/usr/bin/env python3
"""Build and debug-sign the offline APK with JDK 17 + official Android SDK 35.
Runtime dependency JARs are bundled under app/libs; no Gradle is required.
"""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import zipfile
import xml.etree.ElementTree as ET

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser()
parser.add_argument('--jdk', type=Path, default=Path(os.environ.get('JAVA_HOME', '/usr/lib/jvm/java-17-openjdk-amd64')))
parser.add_argument('--sdk', type=Path, default=Path(os.environ.get('ANDROID_HOME', os.environ.get('ANDROID_SDK_ROOT', str(Path.home() / 'Android/Sdk')))))
parser.add_argument('--build-tools', type=Path)
parser.add_argument('--android-jar', type=Path)
args = parser.parse_args()
jdk = args.jdk.resolve()
tools = (args.build_tools or args.sdk / 'build-tools/35.0.0').resolve()
platform = (args.android_jar or args.sdk / 'platforms/android-35/android.jar').resolve()
env = os.environ.copy()
env['JAVA_HOME'] = str(jdk)
env['PATH'] = str(jdk / 'bin') + os.pathsep + env.get('PATH', '')
env['LD_LIBRARY_PATH'] = os.pathsep.join([str(jdk / 'lib'), str(jdk / 'lib/server'), str(tools / 'lib64'), env.get('LD_LIBRARY_PATH', '')])

def run(*command):
    subprocess.run([str(part) for part in command], check=True, env=env, cwd=root)

for p in (jdk / 'bin/javac', tools / 'aapt2', tools / 'd8', tools / 'zipalign', tools / 'apksigner', platform):
    if not p.exists():
        raise SystemExit(f'Missing tool: {p}. Install JDK 17, Android SDK Platform 35, and Build Tools 35.0.0.')

run('python3', root / 'scripts/prepare_assets.py')
build = root / 'build'
build.mkdir(exist_ok=True)
for name in ('classes', 'dex', 'gen'):
    target = build / name
    if target.exists(): shutil.rmtree(target)
    target.mkdir()
run(tools / 'aapt2', 'compile', '--dir', root / 'app/src/main/res', '-o', build / 'resources.zip')
ET.register_namespace('android', 'http://schemas.android.com/apk/res/android')
manifest = ET.parse(root / 'app/src/main/AndroidManifest.xml')
manifest.getroot().set('package', 'com.wnddud.hiddesk')
manifest.write(build / 'AndroidManifest.xml', encoding='utf-8', xml_declaration=True)
run(tools / 'aapt2', 'link', '-I', platform, '--manifest', build / 'AndroidManifest.xml',
    '-A', root / 'app/src/main/assets', '--java', build / 'gen', '-o', build / 'resources.apk', build / 'resources.zip')
sources = list((root / 'app/src/main/java').rglob('*.java')) + list((build / 'gen').rglob('*.java'))
dependencies = sorted((root / 'app/libs').glob('*.jar'))
classpath = os.pathsep.join(str(p) for p in [platform, *dependencies])
run(jdk / 'bin/javac', '--release', '8', '-encoding', 'UTF-8', '-classpath', classpath, '-d', build / 'classes', *sources)
run(tools / 'd8', '--lib', platform, '--min-api', '26', '--output', build / 'dex', *sorted((build / 'classes').rglob('*.class')), *dependencies)
shutil.copy2(build / 'resources.apk', build / 'unsigned.apk')
with zipfile.ZipFile(build / 'unsigned.apk', 'a', compression=zipfile.ZIP_DEFLATED) as apk:
    for dex in (build / 'dex').glob('*.dex'): apk.write(dex, dex.name)
run(tools / 'zipalign', '-f', '-p', '4', build / 'unsigned.apk', build / 'aligned.apk')
key = root / 'debug.keystore'
if not key.exists():
    run(jdk / 'bin/keytool', '-genkeypair', '-keystore', key, '-storepass', 'android', '-keypass', 'android',
        '-alias', 'androiddebugkey', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000',
        '-dname', 'CN=HID Desk Development,O=Local Development,C=KR')
version = manifest.getroot().get('{http://schemas.android.com/apk/res/android}versionName')
output = build / f'HID-Desk-Android-{version}.apk'
run(tools / 'apksigner', 'sign', '--ks', key, '--ks-key-alias', 'androiddebugkey', '--ks-pass', 'pass:android',
    '--key-pass', 'pass:android', '--out', output, build / 'aligned.apk')
run(tools / 'apksigner', 'verify', '--verbose', output)
run(tools / 'zipalign', '-c', '-p', '4', output)
print(f'APK: {output}')
