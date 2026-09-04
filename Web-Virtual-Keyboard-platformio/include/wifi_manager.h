#ifndef WIFI_MANAGER_H
#define WIFI_MANAGER_H

#include <Arduino.h>

// Persisted operating mode.
//   AUTO: join the saved network, fall back to the built-in access point.
//   AP:   never touch the station side, always run the access point.
enum class WifiMode : uint8_t
{
	AUTO = 0,
	AP   = 1
};

// What the radio ended up doing after the mode was applied.
enum class WifiState : uint8_t
{
	DOWN,
	STA,
	AP
};

struct WifiSettings
{
	WifiMode mode = WifiMode::AUTO;
	String   staSsid;
	String   staPass;
	String   apSsid;
	String   apPass;
};

// Loads the settings from NVS (seeding them from config.h on the very first
// boot) and brings the radio up. Call once at boot, after display_init().
void wifiInit();

// Services the recovery button and the deferred restart. Call from loop().
void wifiService();

WifiState wifiState();
const WifiSettings& wifiSettings();

// SSID / IP of whatever interface is currently serving, for the display and
// the /wifi endpoint.
String wifiActiveSsid();
String wifiActiveIp();

// Persists the settings without applying them; the caller reboots afterwards.
bool wifiSave(const WifiSettings& next);

// Reboots once the pending HTTP response has been flushed.
void wifiRequestRestart(uint32_t delayMs);

// Asynchronous scan. wifiScanState() mirrors WiFi.scanComplete():
// -2 idle / failed, -1 running, >= 0 networks found.
void wifiScanStart();
int  wifiScanState();

#endif
