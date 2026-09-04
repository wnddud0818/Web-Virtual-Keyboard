#include "wifi_manager.h"

#include <WiFi.h>
#include <Preferences.h>

#if __has_include(<esp_random.h>)
	#include <esp_random.h>
#else
	#include <esp_system.h>
#endif

#include "config.h"
#include "pinout.h"
#include "globals.h"
#include "display.h"

// Deliberately NOT the preset namespace: storageInit() wipes "cfg" whenever
// STORAGE_VERSION changes, and the network settings have to survive that or a
// firmware update would strand the device on an unreachable network.
static const char* WIFI_NS    = "wifi";
static const char* K_MODE     = "mode";
static const char* K_STA_SSID = "ssid";
static const char* K_STA_PASS = "pass";
static const char* K_AP_SSID  = "apssid";
static const char* K_AP_PASS  = "appass";

#define AP_PASS_GEN_LEN 10

static WifiSettings settings;
static WifiState    activeState     = WifiState::DOWN;
static bool         restartPending  = false;
static uint32_t     restartAt       = 0;
static uint32_t     buttonDownSince = 0;

// ---------- Defaults ----------

// The MAC's last two bytes keep two dongles on the same desk apart. This is
// not a secret: it is also the AP's BSSID.
static String defaultApSsid()
{
	uint8_t mac[6] = { 0 };
	WiFi.macAddress(mac);

	char ssid[32] = { 0 };
	snprintf(ssid, sizeof(ssid), AP_SSID_PREFIX "%02X%02X", mac[4], mac[5]);

	return String(ssid);
}

// Unambiguous alphabet (no 0/O/1/l/I) so the generated password can be read
// off the 160x80 display without guessing.
static String randomApPass()
{
	static const char ALPHABET[] = "abcdefghijkmnopqrstuvwxyz23456789";
	const uint32_t span = (uint32_t)(sizeof(ALPHABET) - 1U);

	String out;
	out.reserve(AP_PASS_GEN_LEN);

	for (uint8_t i = 0; i < AP_PASS_GEN_LEN; i++)
	{
		out += ALPHABET[esp_random() % span];
	}

	return out;
}

// ---------- NVS ----------

static void seedDefaults()
{
	settings.mode    = WifiMode::AUTO;
	settings.staSsid = WIFI_SSID;
	settings.staPass = WIFI_PASS;
	settings.apSsid  = defaultApSsid();
	settings.apPass  = AP_PASS_DEFAULT;
}

static void loadSettings()
{
	Preferences p;

	// A read-only begin() fails outright when the namespace does not exist yet,
	// which is exactly the first-boot case.
	if (!p.begin(WIFI_NS, true) || !p.isKey(K_MODE))
	{
		p.end();

		// First boot on this firmware: seed from config.h so an existing build
		// keeps connecting exactly as it did before.
		LogSerial.print("[WiFi] no saved settings -> seeding from config.h\r\n");
		seedDefaults();
		wifiSave(settings);
		return;
	}

	settings.mode    = (p.getUChar(K_MODE, 0) == 1U) ? WifiMode::AP : WifiMode::AUTO;
	settings.staSsid = p.getString(K_STA_SSID, "");
	settings.staPass = p.getString(K_STA_PASS, "");
	settings.apSsid  = p.getString(K_AP_SSID, "");
	settings.apPass  = p.getString(K_AP_PASS, "");
	p.end();

	if (settings.apSsid.length() == 0U)
	{
		settings.apSsid = defaultApSsid();
	}

	LogSerial.printf("[WiFi] loaded settings (mode=%s, ssid=\"%s\")\r\n",
		settings.mode == WifiMode::AP ? "ap" : "auto", settings.staSsid.c_str());
}

bool wifiSave(const WifiSettings& next)
{
	Preferences p;

	if (!p.begin(WIFI_NS, false))
	{
		LogSerial.print("[WiFi] NVS begin() failed\r\n");
		return false;
	}

	bool ok = true;
	ok &= p.putUChar(K_MODE, next.mode == WifiMode::AP ? 1U : 0U) > 0;
	ok &= p.putString(K_STA_SSID, next.staSsid) == next.staSsid.length();
	ok &= p.putString(K_STA_PASS, next.staPass) == next.staPass.length();
	ok &= p.putString(K_AP_SSID,  next.apSsid)  == next.apSsid.length();
	ok &= p.putString(K_AP_PASS,  next.apPass)  == next.apPass.length();
	p.end();

	if (ok)
	{
		settings = next;
	}
	else
	{
		LogSerial.print("[WiFi] NVS write failed\r\n");
	}

	return ok;
}

// ---------- Display ----------

#if ENABLE_DISPLAY
// Right-aligned values are drawn from their own length, so an over-long SSID
// would run off the left edge and into the label.
static String fitRight(const String& value, uint8_t labelChars)
{
	const int budget = (DISPLAY_WIDTH / CHARACTER_WIDTH) - (int)labelChars - 2;

	if (budget <= 0 || (int)value.length() <= budget)
	{
		return value;
	}

	return value.substring(0, (unsigned int)budget);
}

static void paintDisplay()
{
	if (activeState == WifiState::AP)
	{
		display_write_word(COLOR_THEME, Align::LEFT,  4, "AP SSID");
		display_write_word(COLOR_WHITE, Align::RIGHT, 4, fitRight(settings.apSsid, 7).c_str());
		display_write_word(COLOR_THEME, Align::LEFT,  5, "AP pass");
		display_write_word(COLOR_OK,    Align::RIGHT, 5, fitRight(settings.apPass, 7).c_str());
		return;
	}

	display_write_word(COLOR_THEME, Align::LEFT,  4, "SSID");
	display_write_word(COLOR_WHITE, Align::RIGHT, 4, fitRight(settings.staSsid, 4).c_str());
	display_write_word(COLOR_THEME, Align::LEFT,  5, "Wi-Fi");

	if (activeState == WifiState::STA)
	{
		display_write_word(COLOR_OK, Align::RIGHT, 5, WiFi.localIP().toString().c_str());
	}
	else
	{
		display_write_word(COLOR_ERROR, Align::RIGHT, 5, "Disconnected");
	}
}
#else
static void paintDisplay() {}
#endif

// ---------- Bring-up ----------

static bool connectSta()
{
	if (settings.staSsid.length() == 0U)
	{
		LogSerial.print("[WiFi] no station SSID saved\r\n");
		return false;
	}

	LogSerial.printf("[WiFi] Connecting to \"%s\"...", settings.staSsid.c_str());

	WiFi.setHostname(HOSTNAME);
	WiFi.mode(WIFI_MODE_STA);
	WiFi.begin(settings.staSsid.c_str(), settings.staPass.c_str());

	const uint32_t start = millis();

	while (WiFi.status() != WL_CONNECTED && (millis() - start) < WIFI_STA_TIMEOUT_MS)
	{
		delay(250);
		LogSerial.print('.');
	}

	LogSerial.print("\r\n");

	if (WiFi.status() == WL_CONNECTED)
	{
		activeState = WifiState::STA;
		LogSerial.printf("[WiFi] OK: %s\r\n", WiFi.localIP().toString().c_str());
		return true;
	}

	LogSerial.print("[WiFi] FAILED (timeout).\r\n");
	WiFi.disconnect(true);
	return false;
}

static bool startAp()
{
	if (settings.apSsid.length() == 0U)
	{
		settings.apSsid = defaultApSsid();
	}

	WiFi.mode(WIFI_MODE_AP);

	const bool ok = WiFi.softAP(settings.apSsid.c_str(), settings.apPass.c_str(),
								AP_CHANNEL, 0 /* not hidden */, AP_MAX_CLIENTS);

	if (!ok)
	{
		activeState = WifiState::DOWN;
		LogSerial.print("[WiFi] softAP() FAILED.\r\n");
		return false;
	}

	activeState = WifiState::AP;
	LogSerial.printf("[WiFi] AP \"%s\" up at %s (password: %s)\r\n",
		settings.apSsid.c_str(), WiFi.softAPIP().toString().c_str(),
		settings.apPass.c_str());

	return true;
}

void wifiInit()
{
	loadSettings();

#if ENABLE_RECOVERY_BUTTON
	pinMode(PIN_RECOVERY_BUTTON, INPUT_PULLUP);
#endif

	// esp_random() only yields real entropy once the RF subsystem runs, so the
	// radio is started before any password is generated.
	WiFi.mode(WIFI_MODE_STA);

	if (settings.apPass.length() < AP_PASS_MIN_LEN)
	{
		// An open access point would let anyone in radio range type on the host
		// computer, so a per-device password is generated instead. It is shown
		// on the display and logged here; change it from the web UI.
		settings.apPass = randomApPass();
		LogSerial.printf("[WiFi] generated AP password: %s\r\n", settings.apPass.c_str());
		wifiSave(settings);
	}

	if (settings.mode == WifiMode::AP)
	{
		LogSerial.print("[WiFi] mode: access point only\r\n");
		startAp();
	}
	else if (!connectSta())
	{
		LogSerial.print("[WiFi] falling back to the access point\r\n");
		startAp();
	}

	paintDisplay();
}

// ---------- Runtime ----------

void wifiService()
{
	if (restartPending && (int32_t)(millis() - restartAt) >= 0)
	{
		restartPending = false;
		LogSerial.print("[WiFi] restarting to apply the new settings\r\n");
		LogSerial.flush();
		delay(50);
		ESP.restart();
	}

#if ENABLE_RECOVERY_BUTTON
	// Hold BOOT while the firmware is running to force the access point up.
	// GPIO0 is a strapping pin, so it cannot be held from power-on (that enters
	// the ROM bootloader) - press it after the device has booted.
	if (digitalRead(PIN_RECOVERY_BUTTON) == LOW)
	{
		if (buttonDownSince == 0U)
		{
			buttonDownSince = millis();
		}
		else if (activeState != WifiState::AP &&
				 (millis() - buttonDownSince) >= RECOVERY_HOLD_MS)
		{
			buttonDownSince = 0U;
			LogSerial.print("[WiFi] recovery button: forcing the access point\r\n");
			WiFi.disconnect(true);
			startAp();
			paintDisplay();
		}
	}
	else
	{
		buttonDownSince = 0U;
	}
#endif
}

void wifiRequestRestart(uint32_t delayMs)
{
	restartAt      = millis() + delayMs;
	restartPending = true;
}

WifiState wifiState()
{
	return activeState;
}

const WifiSettings& wifiSettings()
{
	return settings;
}

String wifiActiveSsid()
{
	return (activeState == WifiState::AP) ? settings.apSsid : settings.staSsid;
}

String wifiActiveIp()
{
	if (activeState == WifiState::AP)
	{
		return WiFi.softAPIP().toString();
	}

	if (activeState == WifiState::STA)
	{
		return WiFi.localIP().toString();
	}

	return String("0.0.0.0");
}

// ---------- Scan ----------

void wifiScanStart()
{
	// Scanning needs the station interface. In AP-only mode this temporarily
	// puts the radio into AP+STA and can stall connected clients for a second
	// or two, which is why the scan is asynchronous and the caller polls.
	WiFi.scanDelete();
	WiFi.scanNetworks(true /* async */, false /* hidden */);
}

int wifiScanState()
{
	return (int)WiFi.scanComplete();
}
