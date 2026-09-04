#include "typing_engine.h"

#include <cstring>

#include "config.h"
#include "globals.h"

namespace
{
	char buffer[HID_TYPE_BUFFER_CHARS + 1U];
	size_t length = 0;
	size_t cursor = 0;
	uint16_t characterDelayMs = 0;
	uint32_t nextCharacterAt = 0;
	bool busy = false;
}

bool hidTypingQueue(const HidTextSegment* segments, size_t segmentCount,
					uint16_t delayMs)
{
	if (busy || segments == nullptr || segmentCount == 0U)
	{
		return false;
	}

	size_t total = 0;
	for (size_t i = 0; i < segmentCount; ++i)
	{
		if (segments[i].data == nullptr && segments[i].length != 0U)
		{
			return false;
		}
		if (segments[i].length > HID_TYPE_BUFFER_CHARS - total)
		{
			return false;
		}
		total += segments[i].length;
	}

	if (total == 0U)
	{
		return false;
	}

	size_t offset = 0;
	for (size_t i = 0; i < segmentCount; ++i)
	{
		if (segments[i].length != 0U)
		{
			memcpy(buffer + offset, segments[i].data, segments[i].length);
			offset += segments[i].length;
		}
	}
	buffer[total] = '\0';

	length = total;
	cursor = 0;
	characterDelayMs = delayMs;
	nextCharacterAt = millis();
	busy = true;
	return true;
}

void hidTypingService()
{
	if (!busy)
	{
		return;
	}

	const uint32_t now = millis();
	if ((int32_t)(now - nextCharacterAt) < 0)
	{
		return;
	}

	// One character per loop keeps WebServer responsive even when delayMs is 0.
	Keyboard.write((uint8_t)buffer[cursor++]);
	if (cursor >= length)
	{
		busy = false;
		length = 0;
		cursor = 0;
		return;
	}

	nextCharacterAt = now + characterDelayMs;
}

void hidTypingCancel()
{
	busy = false;
	length = 0;
	cursor = 0;
	buffer[0] = '\0';
	Keyboard.releaseAll();
}

bool hidTypingBusy()
{
	return busy;
}

size_t hidTypingRemaining()
{
	return busy ? (length - cursor) : 0U;
}
