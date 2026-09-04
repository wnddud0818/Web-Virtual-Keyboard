#ifndef HTTPHANDLERS_H
#define HTTPHANDLERS_H

#include <ArduinoJson.h>

void handleRoot();
void handleDecoder();
void handleType();
void handleTypingStatus();
void handleTransferStart();
void handleTransferChunk();
void handleTransferStatus();
void handleTransferCancel();
void serviceHttpJobs();
void handleGetInfo();
void handleGetPresets();
void handlePostPreset();
void handleDeletePreset();
void handleSendPreset();
void handleGetWifi();
void handlePostWifi();
void handleWifiScanStart();
void handleWifiScanResult();

#endif
