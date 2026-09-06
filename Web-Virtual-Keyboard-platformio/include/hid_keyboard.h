#pragma once

#include <stdint.h>

// Keep the Arduino keyboard's descriptor, but send reports through USBHID's
// checked API: USBHIDKeyboard::write() does not report transport failures.
bool hidKeyboardPressRaw(uint8_t usage);
bool hidKeyboardPressAscii(uint8_t character);
bool hidKeyboardReleaseAll();
bool hidKeyboardWrite(uint8_t character);
void hidKeyboardService();
