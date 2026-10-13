# Third-party notices

The CH9329 controller and its Android adaptation are supplied under EUPL-1.2; see `LICENSE` and upstream copyright headers.

The source archive also contains the unmodified Gradle 8.9 wrapper (`gradlew`, `gradlew.bat`, `gradle/wrapper/gradle-wrapper.jar`). Gradle is copyright its respective authors and licensed under the Apache License, Version 2.0; the license is included in `licenses/GRADLE-APACHE-2.0.txt`. The wrapper JAR was checked against Gradle's published SHA-256 checksum. The wrapper is a development tool and is not inside the APK.

Android platform APIs are referenced by the application; no Android SDK JAR is redistributed in the APK. The APK includes usb-serial-for-android 3.11.0 (Copyright 2011-2013 Google Inc. and 2013 Mike Wakerly) under the MIT License. The license is included in `licenses/USB-SERIAL-MIT.txt` and inside the APK as `assets/web/USB-SERIAL-LICENSE.txt`. The library JAR was obtained from the project's official 3.11.0 JitPack artifact. The app has no external web dependency. The optional DOM verification tool uses jsdom 26.1.0 as a development dependency installed separately, and does not put it in the APK.
