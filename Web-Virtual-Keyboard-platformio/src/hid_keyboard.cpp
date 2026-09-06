#include "hid_keyboard.h"

#include <USBHID.h>

namespace
{
    USBHID transport;
    hid_keyboard_report_t report = {};
    bool releasePending = false;
    const uint8_t asciiKeys[128][2] = { HID_ASCII_TO_KEYCODE };

    bool sendReport()
    {
        if (transport.ready() &&
            transport.SendReport(HID_REPORT_ID_KEYBOARD, &report, sizeof(report)))
        {
            return true;
        }
        // A timeout can mean that key-down reached the host. Never replay the
        // character; clear held keys as soon as the USB endpoint recovers.
        report = {};
        releasePending = true;
        return false;
    }
}

bool hidKeyboardReleaseAll()
{
    report = {};
    const bool ok = sendReport();
    releasePending = !ok;
    return ok;
}

void hidKeyboardService()
{
    if (releasePending && transport.ready())
    {
        hidKeyboardReleaseAll();
    }
}

bool hidKeyboardPressRaw(uint8_t usage)
{
    if (releasePending && !hidKeyboardReleaseAll()) { return false; }
    if (usage >= 0xE0 && usage <= 0xE7)
    {
        report.modifier |= 1U << (usage - 0xE0);
    }
    else
    {
        if (usage == 0 || usage >= 0xA5) { return false; }
        bool added = false;
        for (uint8_t& key : report.keycode)
        {
            if (key == usage || key == 0)
            {
                key = usage;
                added = true;
                break;
            }
        }
        if (!added) { return false; }
    }
    return sendReport();
}

bool hidKeyboardPressAscii(uint8_t character)
{
    if (character >= 128 || asciiKeys[character][1] == 0) { return false; }
    if (releasePending && !hidKeyboardReleaseAll()) { return false; }
    if (asciiKeys[character][0]) { report.modifier |= 0x02; }
    return hidKeyboardPressRaw(asciiKeys[character][1]);
}

bool hidKeyboardWrite(uint8_t character)
{
    const bool pressed = hidKeyboardPressAscii(character);
    const bool released = hidKeyboardReleaseAll();
    return pressed && released;
}
