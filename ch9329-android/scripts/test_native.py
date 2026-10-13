#!/usr/bin/env python3
"""Run metadata-only USB driver and baud/release checks; no real Android USB."""
import argparse,os,subprocess
from pathlib import Path
root=Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser()
p.add_argument('--jdk',type=Path,required=True)
p.add_argument('--android-jar',type=Path,required=True)
a=p.parse_args();jdk=a.jdk.resolve();platform=a.android_jar.resolve()
env=os.environ.copy();env['LD_LIBRARY_PATH']=str(jdk/'lib')+os.pathsep+str(jdk/'lib/server')
classes=root/'build/native-test-classes';classes.mkdir(parents=True,exist_ok=True)
dependency=root/'app/libs/usb-serial-for-android-3.11.0.jar'
main=root/'app/src/main/java/com/wnddud/hiddesk'
sources=list((root/'tests/native-stubs').rglob('*.java'))+[main/'Ch340Math.java',main/'Ch340Port.java',main/'SerialUsbPort.java',root/'tests/Ch340MathTest.java',root/'tests/UsbDetectionTest.java']
subprocess.run([str(jdk/'bin/javac'),'--release','8','-encoding','UTF-8','-classpath',os.pathsep.join(map(str,[platform,dependency])),'-d',str(classes),*map(str,sources)],check=True,env=env)
for test in ('Ch340MathTest','UsbDetectionTest'):
    subprocess.run([str(jdk/'bin/java'),'-cp',os.pathsep.join(map(str,[classes,dependency,platform])),test],check=True,env=env)
