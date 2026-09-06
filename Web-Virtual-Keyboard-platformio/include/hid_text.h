#pragma once

#include <stddef.h>
#include <stdint.h>

inline bool hidTextIsAscii(const char* text, size_t length)
{
    for (size_t i = 0; i < length; ++i)
    {
        const uint8_t c = (uint8_t)text[i];
        if (c != '\t' && c != '\r' && c != '\n' && (c < 0x20 || c > 0x7E))
        {
            return false;
        }
    }
    return true;
}
