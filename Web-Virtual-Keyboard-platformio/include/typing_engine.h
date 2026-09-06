#ifndef TYPING_ENGINE_H
#define TYPING_ENGINE_H

#include <Arduino.h>

// A message is copied into a fixed-size buffer before this function returns.
// This keeps the HTTP request String out of the long-running typing path and
// makes the RAM ceiling independent of the total file size.
struct HidTextSegment
{
	const char* data;
	size_t length;
};

bool hidTypingQueue(const HidTextSegment* segments, size_t segmentCount,
					uint16_t delayMs);
void hidTypingService();
void hidTypingCancel();
bool hidTypingBusy();
bool hidTypingFailed();
size_t hidTypingRemaining();

#endif
