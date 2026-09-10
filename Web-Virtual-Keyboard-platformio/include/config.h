#ifndef CONFIG_H
#define CONFIG_H

#define MASTER_USER     "user"  // your master username here
#define MASTER_PASS     "password" // your master password here

// USB device identity shown by the host operating system.
#define USB_PRODUCT_NAME "Keyboard"

// ---------- Wi-Fi ----------
// These two are the *factory defaults*: they seed the saved settings on the
// first boot only. From then on whatever was saved from the web UI wins, and
// it survives firmware updates (see wifi_manager.cpp).
#define WIFI_SSID       "ssid" // your wifi ssid here
#define WIFI_PASS       "password" // your wifi password here
#define WIFI_STA_TIMEOUT_MS 20000

// Built-in access point: used when the AP mode is selected, and as the
// fallback when the saved network does not connect in AUTO mode. It serves the
// same UI at 192.168.4.1.
#define AP_SSID_PREFIX  "WVK-" // the MAC's last two bytes are appended
// Leave empty to have a per-device password generated on the first boot and
// shown on the display / UART. Set a literal (>= AP_PASS_MIN_LEN chars) to pin
// a known one, which is what a display-less build needs.
#define AP_PASS_DEFAULT ""
#define AP_PASS_MIN_LEN 8   // WPA2 minimum; an open AP is never allowed
#define AP_MAX_CLIENTS  4
#define AP_CHANNEL      1

// Hold BOOT for this long while the firmware is running to force the access
// point up (the escape hatch when the saved network is unreachable).
#define ENABLE_RECOVERY_BUTTON  true
#define RECOVERY_HOLD_MS        3000

// Grace period between answering POST /wifi and rebooting into the new mode.
#define WIFI_RESTART_DELAY_MS   1200

#define TYPE_DELAY_MS   40
#define CHORD_PRESS_MS  12  // how long a special key / chord is held before release
#define DEFAULT_CHAR_DELAY_MS       5
#define MAX_CHAR_DELAY_MS         100
#define MAX_TRANSFER_CHUNK_CHARS 2048
#define MAX_TRANSFER_FILENAME      128
#define MAX_TRANSFER_CHUNKS     999999
#define MAX_QUICK_TYPE_CHARS      2048
// Longest queued message is a WVK1 chunk line plus its framing and END marker.
#define HID_TYPE_BUFFER_CHARS \
	(MAX_TRANSFER_CHUNK_CHARS + 64)
#define UART_RX_PIN     44
#define UART_TX_PIN     43
#define UART_BAUD       115200
#define HOSTNAME        "web-virtual-keyboard"

#define FW_VERSION          "1.3.2"
#define STORAGE_VERSION     "2.0"

#define MAX_PRESET_LENGTH   64
#define MAX_VALUE_LENGTH    512  // a preset value (literal text + <TOKEN> keys)
#define MAX_JSON_SIZE       16384 // holds all the presets, adjust accordingly

#define SERVER_PORT     80
#define UART_NUMBER     0

#define ENABLE_DISPLAY  true

#endif
