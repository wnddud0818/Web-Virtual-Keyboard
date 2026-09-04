#include <Arduino.h>

#include "config.h"
#include "storage.h"
#include "globals.h"
#include "http_handlers.h"
#include "display.h"
#include "wifi_manager.h"

// ---------- Setup / Loop ----------
void setup()
{
	// UART for logging over an external USB-UART adapter (not CDC)
	LogSerial.begin(UART_BAUD, SERIAL_8N1, UART_RX_PIN, UART_TX_PIN);
	delay(100);
	LogSerial.print("\r\n=== Web Keyboard Server ===\r\n");

	Keyboard.begin();
	USB.begin();
	delay(200);
	LogSerial.print("[USB] HID Keyboard ready\r\n");
	delay(200);

	// Check storage version and wipe if incompatible; ensures presets key exists
	storageInit();

#if ENABLE_DISPLAY
	display_init();
#endif

	// Loads the saved mode and credentials and brings the radio up: the saved
	// network in AUTO mode, the built-in access point when that fails or when
	// the AP mode was selected. Also paints the two network rows.
	wifiInit();

	// HTTP routes
	server.on("/", HTTP_GET, handleRoot);
	server.on("/decoder", HTTP_GET, handleDecoder);
	server.on("/decoder.html", HTTP_GET, handleDecoder);
	server.on("/type", HTTP_POST, handleType);
	server.on("/typing/status", HTTP_GET, handleTypingStatus);
	server.on("/transfer/start", HTTP_POST, handleTransferStart);
	server.on("/transfer/chunk", HTTP_POST, handleTransferChunk);
	server.on("/transfer/status", HTTP_GET, handleTransferStatus);
	server.on("/transfer/cancel", HTTP_POST, handleTransferCancel);
	server.on("/transfer/stop", HTTP_POST, handleTransferCancel);
	server.on("/info", HTTP_GET, handleGetInfo);
	server.on("/presets", HTTP_GET, handleGetPresets);
	server.on("/presets", HTTP_POST, handlePostPreset);
	server.on("/presets", HTTP_DELETE, handleDeletePreset);
	server.on("/send", HTTP_POST, handleSendPreset);
	server.on("/wifi", HTTP_GET, handleGetWifi);
	server.on("/wifi", HTTP_POST, handlePostWifi);
	server.on("/wifi/scan", HTTP_GET, handleWifiScanResult);
	server.on("/wifi/scan", HTTP_POST, handleWifiScanStart);

	server.on("/favicon.ico", HTTP_GET, []()
	{
		server.send(204);
	});

	server.begin();
	LogSerial.print("[HTTP] Server started on port ");
	LogSerial.println(SERVER_PORT);
}

void loop()
{
	server.handleClient();
	serviceHttpJobs();
	wifiService();
}
