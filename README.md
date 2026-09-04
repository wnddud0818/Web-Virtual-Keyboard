# Web Virtual Keyboard

Web Virtual Keyboard turns a [LILYGO T-Dongle-S3](https://lilygo.cc/products/t-dongle-s3) into a Wi-Fi-controlled USB keyboard. From a browser on the local network, it can type free-form text, reusable presets, text files, or a checked text representation of any binary file into another computer.

The normal firmware exposes **USB HID keyboard only**. It does not expose a USB serial, mass-storage, or network interface to the target computer. Diagnostic output remains available on the T-Dongle-S3's external UART connector.

> **IMPORTANT - security**
>
> - **All text and file chunks travel over the local network in plaintext.** The web UI is protected only by HTTP Basic authentication (`MASTER_USER` / `MASTER_PASS`), not by TLS.
> - **Use this device only on trusted local networks and computers you own or are authorised to operate.** Anything sent to the device becomes keyboard input on the focused target application.
> - Preset values marked *Hidden* are never returned to the browser, but they are still stored in plaintext in the device's flash.
> - **The built-in access point is a way onto the target computer's keyboard.** It is always WPA2-protected and an open access point is refused, but treat its password like the administrator password: anyone in radio range who has it can type on the target. The default password is generated per device on the first boot and shown on the display.

## Architecture

```text
Controller browser                 T-Dongle-S3                    Target computer
file / text / presets  --Wi-Fi-->  bounded chunk buffer  --USB--> focused editor or Chrome
CRC32 + SHA-256                    native HID keyboard            offline decoder.html
```

File encoding and checksums are calculated in the controller browser. Chunks are sent sequentially, and the dongle keeps only the currently queued chunk in RAM while its non-blocking typing engine emits one key at a time. The total file is never stored in the dongle's RAM, flash, or TF card.

The included board definition targets the original **T-Dongle-S3 with 16 MB QSPI flash and no PSRAM**. T-Display-S3 is a different board. Other ESP32-S3 boards need an appropriate PlatformIO board definition and matching display/UART pins.

## Features

- **Free-text typing** - enter text in the textarea and send it. `Enter` sends, `Shift+Enter` inserts a newline; an optional trailing CRLF can be added. US-ASCII only: HID types keycodes, not characters, so non-ASCII text is rejected before it reaches the device.
- **Chunked file typing** - choose Auto, Raw text, or WVK1/Base64 mode, set the source-byte chunk size and per-key delay, and follow progress in the browser.
- **WVK1 text transfer** - paste any UTF-8 text, including Korean and other non-ASCII scripts, and send it through the WVK1 envelope. Only Base64 is ever typed, so the decoder reproduces the original characters exactly. See [Sending non-ASCII text](#sending-non-ascii-text).
- **Offline decoder** - the firmware serves a self-contained `decoder.html`, and can type its source into an offline target computer during first-time setup. No compiler, Python, PowerShell, or external JavaScript library is required on the target. Anything that decodes to valid UTF-8 text is displayed in the decoder rather than downloaded.
- **Presets** - save reusable snippets and send them with one click.
    - **Groups** - organise presets into collapsible groups. A name must be unique within a group but may repeat across different groups.
    - **Per-preset visibility**:
        - *Plaintext* - value is shown in the UI.
        - *Masked* - value is shown as `••••`.
        - *Hidden* - value never leaves the device; it is typed straight from flash and never sent to the browser.
    - **Special keys / chords** - preset values can embed `<TOKEN>` keys that plain text cannot produce. A visual special-key builder inserts them for you.
- **Two network modes** - **Auto** joins the saved network and falls back to the device's own access point when it cannot; **Access point only** always runs the device's own network. The mode, the network credentials, and the access point name/password are set from the web UI and stored on the device, so changing networks no longer means rebuilding the firmware.
- **On-device status** - the display and external UART log show the SSID and IP address in station mode, or the access point's name and password when the access point is up. The web footer shows firmware and storage-layout versions from `/info`.

## Target-computer prerequisites

Before typing text or files, prepare the target computer:

1. Select the **English (US)** keyboard layout.
2. Turn the IME/input method off and make sure **Caps Lock is off**. The typed WVK1 stream and Base64 payload are case-sensitive.
3. Focus an empty plain-text editor for Raw mode, or the data textarea in `decoder.html` for WVK1 mode.
4. Keep that window focused and do not use the target keyboard until the transfer finishes.

For source-code files, use a plain editor or disable automatic indentation. An editor that inserts its own indentation after Enter can add extra tabs or spaces on top of the characters being typed.

## File-transfer modes

### Auto

Auto selects **Raw text** only when every source byte is printable US-ASCII or a tab/CR/LF character. If any other byte is present, including UTF-8 text, it selects **WVK1/Base64**. The selected mode is shown before transfer starts.

### Raw text

Raw mode types the original ASCII bytes directly. CRLF and lone CR line endings are normalised to Enter, and tabs are sent as Tab keypresses.

Use it for ASCII-only `.txt`, `.c`, `.cpp`, `.h`, `.py`, `.html`, `.css`, `.json`, and similar files when the target editor is ready to save the result. Raw mode has no checksum envelope: a focus change, dropped keystroke, cancellation, or partial transfer requires clearing the target document and starting again.

### WVK1 / Base64

WVK1 works with text or binary files. The browser divides the original bytes into chunks, Base64-encodes each chunk, calculates a CRC32 for each original chunk, and calculates SHA-256 for the complete original file. The dongle types a stream such as:

```text
WVK1
NAME=weather_clock.zip
SIZE=12345
CHUNKS=3
SHA256=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef

C|000001|A1B2C3D4|<base64 for original chunk 1>
C|000002|11223344|<base64 for original chunk 2>
C|000003|55667788|<base64 for original chunk 3>
END
```

Chunk numbers in the typed document are one-based. CRC32 is calculated over each decoded original-byte chunk, not over its Base64 characters. Filenames are reduced to a safe printable-ASCII basename before being placed in the header.

The offline decoder checks the WVK1 header, chunk order and count, every chunk CRC32, declared file size, and the SHA-256 emitted by the normal sender before downloading the reconstructed Blob. It reports corruption instead of silently producing an unchecked file. It can also decode a plain Base64 string with a user-supplied filename, but that form has no WVK1 integrity metadata.

## Sending non-ASCII text

USB HID transports keycodes, not characters, and the HID keycode table has no entry for Hangul or any other non-ASCII script. The free-text box and Raw mode therefore accept US-ASCII only.

WVK1 sidesteps this entirely, because the characters themselves are never typed:

1. The browser encodes the text as UTF-8 bytes and Base64-encodes them.
2. The dongle types only the Base64 envelope, which is pure US-ASCII.
3. `decoder.html` verifies CRC32 and SHA-256, then rebuilds the original bytes.

To send text this way, paste it into **Or send text as WVK1** in the transfer card and press **Send text as WVK1**. It is always sent as WVK1 regardless of the Transfer mode setting, and arrives as `message.txt`.

The decoder decides what to do with any verified payload by content, not by filename: if the bytes are valid UTF-8 with no NUL or stray control bytes, the original text is shown in **Decoded text** with **Copy text** and **Download as file** actions. Everything else downloads as before. A truncated multi-byte character fails the strict UTF-8 check, so a half-received transfer is reported as binary instead of being shown as mojibake.

Two limits remain:

- **Filenames are still ASCII.** The `NAME` header is reduced to printable ASCII, so `보고서.txt` is typed as `_____.txt`. The file contents are unaffected.
- **Typing Korean directly into an application is not supported.** That would require driving the target's IME by sending 두벌식 jamo keys (`한` as `gks`) and toggling Han/English mode, and the device cannot observe the target's current IME state.

## First-time `decoder.html` setup

Use this workflow when the target computer has Chrome but cannot open the dongle's web page:

1. On the target computer, open a new, empty document in a plain-text editor. Confirm US layout, IME off, Caps Lock off, and focus the document.
2. On the controller browser, open the dongle UI and click **Type decoder source**.
3. Wait until the transfer reports complete. Save the target document as exactly `decoder.html`. In Windows Notepad, choose **All files** if necessary so it does not become `decoder.html.txt`.
4. Open the saved `decoder.html` in Chrome and focus its data box.
5. Back on the controller, choose a file and send it in WVK1 mode.
6. When typing finishes, use the decoder's validation/download action to reconstruct the original file.

If the target computer can reach the dongle over Wi-Fi, it may instead open `http://DEVICE_IP/decoder.html` directly and optionally save a local copy.

## Transfer reliability and speed

- The default browser settings use 768 original bytes per chunk; the allowed range is 96-1536 bytes. A Base64 payload sent to the dongle is capped at 2048 characters. The key delay is configurable from 0-100 ms (5 ms by default).
- The browser waits for the device's zero-based `next` counter before sending another chunk. Repeating an already accepted chunk is idempotent, so an uncertain HTTP response does not type that chunk twice. **Retry / Resume** recovers a paused controller-to-dongle session; Stop cancels the current typing job.
- Progress means the dongle has emitted the HID key reports. A keyboard protocol has no per-character acknowledgement from the target editor, so it cannot prove that the focused application retained every character. WVK1 CRC/SHA validation happens afterwards on the target.
- Base64 adds about 33% more typed characters. As a rough lower bound, 100 KiB takes about 4.6 minutes at 2 ms/key or 11.4 minutes at 5 ms/key; 1 MiB takes about 47 or 117 minutes respectively. HTTP and application overhead add more time. Larger chunks reduce request overhead but do not reduce the number of keystrokes.
- If the decoder reports damage, clear its data box and resend. There is no reverse channel from `decoder.html` to request a damaged chunk automatically.

## HTTP endpoints

All functional endpoints require the same HTTP Basic authentication as the web UI.

| Method | Endpoint | Purpose |
| --- | --- | --- |
| `GET` | `/` | Main controller UI |
| `GET` | `/decoder`, `/decoder.html` | Self-contained offline decoder source |
| `POST` | `/transfer/start` | Start a Raw or WVK1 session and return its transfer ID |
| `POST` | `/transfer/chunk` | Queue the next indexed chunk; duplicate completed indexes are acknowledged without retyping |
| `GET` | `/transfer/status` | Return state, next expected index, progress, limits, and errors |
| `POST` | `/transfer/cancel`, `/transfer/stop` | Cancel the active typing session |
| `POST` | `/type`, `/send` | Type free-form text or a stored preset |
| `GET/POST/DELETE` | `/presets` | Read, save, or remove presets |
| `GET` | `/info` | Firmware and storage-layout versions |
| `GET/POST` | `/wifi` | Read the network mode and current link, or save new settings and reboot |
| `POST` | `/wifi/scan` | Start an asynchronous scan for nearby networks |
| `GET` | `/wifi/scan` | Poll the scan: `idle`, `running`, or `done` with the network list |

## Special keys (tokens)

Inside a **preset value**, wrap a key name in `< >` to send a raw key instead of literal text. Token names are case-insensitive.

Special keys use a **chord model**: each `<TOKEN>` is pressed and held as it is read, and the next typed character (if any) is pressed together with all held keys, then the whole chord is released at once. A token with no following character is pressed and released on its own.

| Preset value | Result |
| --- | --- |
| `<CTRL>c` | Ctrl + C |
| `<CTRL><ALT><DEL>` | Ctrl + Alt + Del (pressed together) |
| `<WIN>r` | Win + R (Run dialog) |
| `<F5>` | F5 on its own |
| `password<ENTER>` | types `password`, then Enter |

Supported tokens:

- **Modifiers:** `CTRL` / `CONTROL`, `SHIFT`, `ALT`, `WIN` / `GUI` / `WINDOWS` / `META`
- **Editing / whitespace:** `ENTER` / `RETURN`, `ESC` / `ESCAPE`, `BKSP` / `BACKSPACE` / `BS`, `TAB`, `SPACE` / `SPC`
- **Locks / system:** `CAPS` / `CAPSLOCK`, `PRTSC` / `PRINTSCREEN` / `PRTSCR`, `SCRLK` / `SCROLLLOCK`, `PAUSE` / `BREAK`, `NUMLK` / `NUMLOCK`, `MENU` / `APP` / `APPLICATION`
- **Navigation:** `INS` / `INSERT`, `HOME`, `PGUP` / `PAGEUP`, `DEL` / `DELETE`, `END`, `PGDN` / `PAGEDOWN`, `LEFT`, `RIGHT`, `UP`, `DOWN`
- **Function keys:** `F1`-`F12`

> Tokens are only parsed for **presets**. The quick *Type text* box sends everything literally, so `<CTRL>` there types the characters `<CTRL>`.

## Network modes

The mode and credentials live in the device's own NVS namespace, so they survive a reboot, a different host computer, and a firmware update. `WIFI_SSID` / `WIFI_PASS` in `include/config.h` are only the factory defaults that seed them on the very first boot.

| Mode | Behaviour |
| --- | --- |
| **Auto** (default) | Joins the saved network. If it does not connect within `WIFI_STA_TIMEOUT_MS`, the access point comes up instead so the device is still reachable. |
| **Access point only** | Never touches the station side. The device always runs its own network, which is what a target computer with no router needs. |

Change either from the **Wi-Fi** card in the web UI: pick the mode, optionally **Scan** for nearby networks, then *Save & reboot*. Passwords left blank keep the stored ones, so the UI never has to echo a secret back to the browser.

### Reaching the access point

The access point is named `WVK-XXXX` (the last two bytes of the device MAC) and serves the same UI at `http://192.168.4.1`. Its password is generated per device on the first boot and shown on the display next to `AP pass`; set your own from the web UI, or pin one at build time with `AP_PASS_DEFAULT` in `include/config.h` (required for a build with `ENABLE_DISPLAY false`, which has no way to show a generated one).

While attached to the access point, the controller phone or computer has no internet over that interface. That is why **Auto** is the better everyday mode and **Access point only** is for the router-less case.

### If the device is unreachable

Hold the **BOOT** button for 3 seconds *while the firmware is running*. The station link is dropped, the access point comes up immediately, and the display shows its name and password. BOOT cannot be held from power-on for this - that selects the ROM bootloader - so plug the device in first, then press and hold.

A scan needs the station interface, so running one from the access point puts the radio into AP+STA for a moment and can stall connected clients. The scan is asynchronous and the UI polls for its result, which keeps the request from outliving the connection that made it.

## Hardware requirements

- LILYGO T-Dongle-S3, or another ESP32-S3 board configured for native USB device mode
- A controller phone/computer with a browser on the dongle's Wi-Fi network
- A target computer that receives USB keystrokes
- Chrome or another modern browser on the target for WVK1 decoding
- Optional external USB-UART adapter for logs

## Build and flash

1. Install PlatformIO, then open `Web-Virtual-Keyboard-platformio` as the project directory.
2. Edit `include/config.h` and set `MASTER_USER` and `MASTER_PASS`. `WIFI_SSID` / `WIFI_PASS` are optional here: they seed the saved settings on the first boot, and can be left alone if you intend to provision the network from the access point instead.
3. Build from the repository root:

   ```sh
   pio run -d Web-Virtual-Keyboard-platformio
   ```

4. Put the dongle in download mode if necessary, then upload:

   ```sh
   pio run -d Web-Virtual-Keyboard-platformio -t upload
   ```

5. Reconnect the dongle to the target computer normally. Its display and external UART show the assigned IP address, or the access point's name and password when no network was joined. Open `http://DEVICE_IP` (or `http://192.168.4.1` over the access point) from the controller browser and sign in.

The build hook converts every `web/*.html` file into generated `src/html.cpp` and `include/html.h` PROGMEM assets. Those generated files are intentionally ignored by Git.

### Browser firmware installer

`docs/index.html` installs the same release from desktop Chrome or Edge through Web Serial. It is a single dependency-free page that loads ESP Web Tools from a CDN, so it needs no build step. Every PlatformIO build runs `scripts/package_web_installer.py`, which merges the ESP32-S3 bootloader, partition table, boot application, and firmware into:

```text
docs/firmware/web-virtual-keyboard.bin
```

It also regenerates the ESP Web Tools `manifest.json` and a `release.json` containing the version, byte size, and SHA-256. The page reads `release.json` at runtime, so the displayed version is never hardcoded. Serve it locally with:

```sh
cd docs
python3 -m http.server 8777
```

Open `http://localhost:8777` in desktop Chrome or Edge. Web Serial is restricted to secure contexts, so a deployed installer must use HTTPS — pointing GitHub Pages at `main /docs` satisfies this without extra hosting.

### Double-clickable single-file installer

Web Serial also works from `file://`, but the browser blocks `fetch` of local files, so the page cannot read `firmware/manifest.json` from disk. `scripts/build_standalone_installer.py` works around this by embedding the manifest and the firmware into one HTML file and handing them to ESP Web Tools as blob URLs:

```sh
python3 scripts/build_standalone_installer.py
```

The result, `docs/wvk-flash-standalone.html` (~1.3 MB), can be opened by double-clicking it in Chrome or Edge — no server required. It is generated on demand and therefore ignored by Git; attach it to a GitHub Release when distributing. An internet connection is still needed because ESP Web Tools lazy-loads its install dialog from the CDN.

> Do not publish a firmware image containing private administrator credentials to a public installer. `MASTER_USER` / `MASTER_PASS` are still compile-time values in `include/config.h`, so a public build hands everyone the same sign-in. Wi-Fi no longer has this problem: leave `WIFI_SSID` / `WIFI_PASS` at their placeholders and whoever installs the image provisions their own network over the access point.

### HID-only upload recovery

The application uses native USB OTG in HID-only mode, so USB CDC is unavailable after normal startup. If PlatformIO cannot discover or upload to the device:

1. Unplug the T-Dongle-S3.
2. Hold its **BOOT** button while plugging it into the development computer.
3. Release BOOT after the ROM download port appears, then run the upload command.
4. When upload completes, unplug and reconnect without holding BOOT.

Bootloader/download mode may temporarily enumerate differently; the flashed application itself exposes only the HID keyboard interface.

## Notes

- Presets are stored in ESP32 NVS. If `STORAGE_VERSION` changes, the firmware deliberately wipes and reinitialises incompatible preset data. A firmware-only version bump does not require changing the storage version.
- The network settings deliberately live in a separate NVS namespace (`wifi`) from the presets (`cfg`). A `STORAGE_VERSION` bump wipes the preset namespace only, so a firmware update cannot strand the device on a network it can no longer be told about.
- Saving from the **Wi-Fi** card reboots the device after answering the request, and is refused with `409` while a transfer or typing job is still running.
- The firmware assumes US keyboard mapping. Unicode text should be transferred through WVK1 and reconstructed by `decoder.html`, not typed directly.

<img width="1913" height="901" alt="Snímka obrazovky 2026-07-18 193737" src="https://github.com/user-attachments/assets/b00a74c1-281e-4d7b-8bfa-7963000330d7" />
<img width="1912" height="905" alt="Snímka obrazovky 2026-07-18 193820" src="https://github.com/user-attachments/assets/b4d9b5ee-2c45-49b2-99a7-318fe79e4955" />
<img width="2576" height="1932" alt="20260719_023159" src="https://github.com/user-attachments/assets/98dcf398-3484-4ea2-9967-dc914521dc36" />
