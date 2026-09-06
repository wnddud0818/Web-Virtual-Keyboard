#pragma once
#include <cstdint>
#include <cstddef>
#include <deque>
#include <vector>
#include <cassert>
struct hid_keyboard_report_t { uint8_t modifier, reserved, keycode[6]; };
constexpr uint8_t HID_REPORT_ID_KEYBOARD = 1;
struct USBHID {
    inline static bool connected = true;
    inline static std::deque<bool> results;
    inline static std::vector<hid_keyboard_report_t> attempts;
    bool ready() { return connected; }
    bool SendReport(uint8_t id, const void* data, size_t length, uint32_t = 100) {
        assert(id == HID_REPORT_ID_KEYBOARD && length == sizeof(hid_keyboard_report_t));
        attempts.push_back(*static_cast<const hid_keyboard_report_t*>(data));
        if (results.empty()) { return true; }
        const bool result = results.front(); results.pop_front(); return result;
    }
};
#define HID_ASCII_TO_KEYCODE \
    {0, 0}, \
    {0, 0}, \
    {0, 0}, \
    {0, 0}, \
    {0, 0}, \
    {0, 0}, \
    {0, 0}, \
    {0, 0}, \
    {0, 0}, \
    {0, 43}, \
    {0, 40}, \
    {0, 0}, \
    {0, 0}, \
    {0, 0}, \
    {0, 0}, \
    {0, 0}, \
    {0, 0}, \
    {0, 0}, \
    {0, 0}, \
    {0, 0}, \
    {0, 0}, \
    {0, 0}, \
    {0, 0}, \
    {0, 0}, \
    {0, 0}, \
    {0, 0}, \
    {0, 0}, \
    {0, 0}, \
    {0, 0}, \
    {0, 0}, \
    {0, 0}, \
    {0, 0}, \
    {0, 44}, \
    {1, 30}, \
    {1, 52}, \
    {1, 32}, \
    {1, 33}, \
    {1, 34}, \
    {1, 36}, \
    {0, 52}, \
    {1, 38}, \
    {1, 39}, \
    {1, 37}, \
    {1, 46}, \
    {0, 54}, \
    {0, 45}, \
    {0, 55}, \
    {0, 56}, \
    {0, 39}, \
    {0, 30}, \
    {0, 31}, \
    {0, 32}, \
    {0, 33}, \
    {0, 34}, \
    {0, 35}, \
    {0, 36}, \
    {0, 37}, \
    {0, 38}, \
    {1, 51}, \
    {0, 51}, \
    {1, 54}, \
    {0, 46}, \
    {1, 55}, \
    {1, 56}, \
    {1, 31}, \
    {1, 4}, \
    {1, 5}, \
    {1, 6}, \
    {1, 7}, \
    {1, 8}, \
    {1, 9}, \
    {1, 10}, \
    {1, 11}, \
    {1, 12}, \
    {1, 13}, \
    {1, 14}, \
    {1, 15}, \
    {1, 16}, \
    {1, 17}, \
    {1, 18}, \
    {1, 19}, \
    {1, 20}, \
    {1, 21}, \
    {1, 22}, \
    {1, 23}, \
    {1, 24}, \
    {1, 25}, \
    {1, 26}, \
    {1, 27}, \
    {1, 28}, \
    {1, 29}, \
    {0, 47}, \
    {0, 49}, \
    {0, 48}, \
    {1, 35}, \
    {1, 45}, \
    {0, 53}, \
    {0, 4}, \
    {0, 5}, \
    {0, 6}, \
    {0, 7}, \
    {0, 8}, \
    {0, 9}, \
    {0, 10}, \
    {0, 11}, \
    {0, 12}, \
    {0, 13}, \
    {0, 14}, \
    {0, 15}, \
    {0, 16}, \
    {0, 17}, \
    {0, 18}, \
    {0, 19}, \
    {0, 20}, \
    {0, 21}, \
    {0, 22}, \
    {0, 23}, \
    {0, 24}, \
    {0, 25}, \
    {0, 26}, \
    {0, 27}, \
    {0, 28}, \
    {0, 29}, \
    {1, 47}, \
    {1, 49}, \
    {1, 48}, \
    {1, 53}, \
    {0, 0}
