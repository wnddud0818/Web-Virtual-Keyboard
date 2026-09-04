#include "http_handlers.h"

#include <ArduinoJson.h>
#include <WiFi.h>
#include <esp_system.h>
#include <cstdio>
#include <cstring>
#include "globals.h"
#include "config.h"
#include "storage.h"
#include "html.h" // will be generated automatically when building
#include "wifi_manager.h"
#include "display.h"
#include "typing_engine.h"

// === SPECIAL KEY TABLE ===
// Preset values are literal text with embedded <TOKEN> keys. Each token maps to
// a raw USB HID usage code so we can drive it uniformly through pressRaw() /
// releaseRaw() (the plain KEY_* macros don't cover ScrLk / PrtSc / NumLk / ...).
// Modifiers use usage 0xE0-0xE3 and are held for the *next* key (chord model).
struct KeyDef
{
	const char* name;
	uint8_t     usage;
	bool        isMod;
};

static const KeyDef KEY_DEFS[] =
{
	// modifiers (held for the following key)
	{ "CTRL",        0xE0, true  }, { "CONTROL",     0xE0, true  },
	{ "SHIFT",       0xE1, true  },
	{ "ALT",         0xE2, true  },
	{ "WIN",         0xE3, true  }, { "GUI",         0xE3, true  },
	{ "WINDOWS",     0xE3, true  }, { "META",        0xE3, true  },

	// editing / whitespace
	{ "ENTER",       0x28, false }, { "RETURN",      0x28, false },
	{ "ESC",         0x29, false }, { "ESCAPE",      0x29, false },
	{ "BKSP",        0x2A, false }, { "BACKSPACE",   0x2A, false }, { "BS", 0x2A, false },
	{ "TAB",         0x2B, false },
	{ "SPACE",       0x2C, false }, { "SPC",         0x2C, false },

	// locks / system
	{ "CAPS",        0x39, false }, { "CAPSLOCK",    0x39, false },
	{ "PRTSC",       0x46, false }, { "PRINTSCREEN", 0x46, false }, { "PRTSCR", 0x46, false },
	{ "SCRLK",       0x47, false }, { "SCROLLLOCK",  0x47, false },
	{ "PAUSE",       0x48, false }, { "BREAK",       0x48, false },
	{ "NUMLK",       0x53, false }, { "NUMLOCK",     0x53, false },
	{ "MENU",        0x65, false }, { "APP",         0x65, false }, { "APPLICATION", 0x65, false },

	// navigation
	{ "INS",         0x49, false }, { "INSERT",      0x49, false },
	{ "HOME",        0x4A, false },
	{ "PGUP",        0x4B, false }, { "PAGEUP",      0x4B, false },
	{ "DEL",         0x4C, false }, { "DELETE",      0x4C, false },
	{ "END",         0x4D, false },
	{ "PGDN",        0x4E, false }, { "PAGEDOWN",    0x4E, false },
	{ "RIGHT",       0x4F, false },
	{ "LEFT",        0x50, false },
	{ "DOWN",        0x51, false },
	{ "UP",          0x52, false },

	// function keys
	{ "F1",  0x3A, false }, { "F2",  0x3B, false }, { "F3",  0x3C, false },
	{ "F4",  0x3D, false }, { "F5",  0x3E, false }, { "F6",  0x3F, false },
	{ "F7",  0x40, false }, { "F8",  0x41, false }, { "F9",  0x42, false },
	{ "F10", 0x43, false }, { "F11", 0x44, false }, { "F12", 0x45, false },
};

static const KeyDef* lookupKey(const String& upperName)
{
	for (const KeyDef& kd : KEY_DEFS)
	{
		if (upperName.equals(kd.name))
		{
			return &kd;
		}
	}
	return nullptr;
}

// Types a preset value using a "hold-until-next-literal" chord model: every
// recognised <TOKEN> special key (modifiers *and* keys/navigation/system/
// function) is pressed and held as it is read. Held keys keep accumulating until
// the next normal character, which is pressed together with them and then the
// whole chord is released at once. If the string ends while keys are still held,
// they are pressed and released together. Examples:
//   "<CTRL><ALT><DEL>" -> hold Ctrl+Alt+Del, released together (real Ctrl+Alt+Del)
//   "<CTRL>c"          -> Ctrl+C
//   "<F1><F2>ca"       -> F1+F2+c chord, then "a" typed normally
static void sendValue(const String& v)
{
	uint8_t held[16];   // raw HID usages currently held (modifiers + specials)
	uint8_t nHeld = 0;
	String  lit;        // pending normal text (typed as-is, never part of a chord)

	// Type any pending normal text (only reached when nothing is held).
	auto flushLiteral = [&]()
	{
		if (lit.length() == 0)
		{
			return;
		}
		for (size_t i = 0; i < lit.length(); ++i)
		{
			Keyboard.write((uint8_t)lit[i]);
			if (DEFAULT_CHAR_DELAY_MS != 0U)
			{
				delay(DEFAULT_CHAR_DELAY_MS);
			}
		}
		lit = "";
	};

	// Release the held chord. If triggerChar >= 0 it is pressed together with the
	// held keys (the chord's final key) before everything is released.
	auto releaseHeld = [&](int triggerChar)
	{
		if (nHeld == 0)
		{
			if (triggerChar >= 0) { lit += (char)triggerChar; }
			return;
		}

		for (uint8_t i = 0; i < nHeld; i++)
		{
			Keyboard.pressRaw(held[i]);
		}
		if (triggerChar >= 0)
		{
			Keyboard.press((uint8_t)triggerChar);
		}
		delay(CHORD_PRESS_MS);
		Keyboard.releaseAll();
		nHeld = 0;
		delay(TYPE_DELAY_MS);
	};

	const int n = v.length();
	int i = 0;

	while (i < n)
	{
		const char c = v[i];

		if (c == '<')
		{
			const int close = v.indexOf('>', i + 1);
			if (close > i)
			{
				String name = v.substring(i + 1, close);
				name.trim();
				name.toUpperCase();

				const KeyDef* kd = lookupKey(name);
				if (kd != nullptr)
				{
					// A recognised special key: hold it. Pending normal text is
					// typed first (it is not part of the upcoming chord).
					flushLiteral();
					if (nHeld < (uint8_t)sizeof(held))
					{
						held[nHeld++] = kd->usage;
					}
					i = close + 1;
					continue;
				}
			}
			// Not a recognised <TOKEN>: fall through and treat '<' as literal.
		}

		// A normal character. If keys are held it closes the chord; otherwise it
		// is buffered as plain text.
		if (nHeld > 0)
		{
			releaseHeld((int)(uint8_t)c);
		}
		else
		{
			lit += c;
		}
		i++;
	}

	flushLiteral();

	// Trailing held keys with no following character: press + release together.
	if (nHeld > 0)
	{
		releaseHeld(-1);
	}
}

// === HELPERS ===
static bool validVis(const String& vis)
{
	return vis == "plain" || vis == "mask" || vis == "hidden";
}

// Finds the index of the preset identified by (name, group) in the parsed
// presets array (global `doc`), or -1 if none exists. Presets are keyed by the
// (name, group) pair, so the same name may appear in different groups.
static int findPresetIndex(const String& name, const String& group)
{
	if (!doc.is<JsonArray>())
	{
		return -1;
	}

	JsonArray arr = doc.as<JsonArray>();
	for (size_t i = 0; i < arr.size(); i++)
	{
		JsonObject o = arr[i].as<JsonObject>();
		if (name == (o["name"] | "") && group == (o["group"] | ""))
		{
			return (int)i;
		}
	}
	return -1;
}

// Create or update a preset, identified by (name, group). On edit (isEdit) the
// original identity is (oldName, oldGroup) and the name and/or group may change.
// A blank value on edit keeps the stored value (used for hidden presets, which
// never send their value back from the browser). Names must be unique within a
// group but may repeat across different groups.
bool setPreset(const String& name, const String& group,
               const String& oldName, const String& oldGroup, bool isEdit,
               const String& value, bool hasValue, const String& vis, String* errMsg = nullptr)
{
	if (name.length() == 0U || name.length() > MAX_PRESET_LENGTH)
	{
		if (errMsg != nullptr) { *errMsg = "Bad name"; }
		return false;
	}
	if (hasValue && value.length() > MAX_VALUE_LENGTH)
	{
		if (errMsg != nullptr) { *errMsg = "Value too long"; }
		return false;
	}
	if (group.length() > MAX_PRESET_LENGTH)
	{
		if (errMsg != nullptr) { *errMsg = "Group too long"; }
		return false;
	}
	if (!validVis(vis))
	{
		if (errMsg != nullptr) { *errMsg = "Bad visibility"; }
		return false;
	}

	const String json = loadPresetsJson();

	DeserializationError e = deserializeJson(doc, json);
	if (e)
	{
		if (errMsg != nullptr) { *errMsg = "JSON parse error"; }
		return false;
	}
	if (!doc.is<JsonArray>())
	{
		doc.to<JsonArray>();
	}

	// The preset being edited (if any), by its original identity.
	const int editIdx = isEdit ? findPresetIndex(oldName, oldGroup) : -1;

	// Enforce name uniqueness within a group: reject a target (name, group) that
	// already belongs to a *different* preset.
	const int clashIdx = findPresetIndex(name, group);
	if (clashIdx >= 0 && clashIdx != editIdx)
	{
		if (errMsg != nullptr) { *errMsg = "A preset with this name already exists in this group"; }
		return false;
	}

	JsonObject obj;
	if (editIdx >= 0)
	{
		obj = doc.as<JsonArray>()[editIdx].as<JsonObject>();
	}
	else
	{
		obj = doc.as<JsonArray>().add<JsonObject>();
		obj["value"] = ""; // new preset starts empty unless a value is supplied
	}

	if (hasValue)
	{
		obj["value"] = value;
	}
	obj["name"]  = name;
	obj["group"] = group;
	obj["vis"]   = vis;

	String out;
	serializeJson(doc, out);

	return savePresetsJson(out);
}

bool deletePreset(const String& name, const String& group)
{
	const String json = loadPresetsJson();

	if (deserializeJson(doc, json))
	{
		return false;
	}

	const int idx = findPresetIndex(name, group);
	if (idx < 0)
	{
		return false;
	}

	doc.as<JsonArray>().remove(idx);

	String out;
	serializeJson(doc, out);

	return savePresetsJson(out);
}

static bool requireAuth()
{
    if(server.authenticate(MASTER_USER, MASTER_PASS))
	{
		return true;
	}

    server.requestAuthentication();
    return false;
}

// === BOUNDED BACKGROUND TRANSFER ===
//
// Only the currently typed message lives in the HID engine's fixed buffer. The
// sender must wait until `next` advances before posting another chunk. This is
// intentional back-pressure: file size never determines device RAM usage.
enum class TransferMode : uint8_t
{
	RAW,
	WVK1
};

enum class TransferState : uint8_t
{
	IDLE,
	TYPING,
	READY,
	COMPLETE,
	CANCELLED,
	ERROR_STATE
};

enum class TransferPhase : uint8_t
{
	NONE,
	HEADER,
	CHUNK
};

struct TransferContext
{
	char id[17] = { 0 };
	TransferMode mode = TransferMode::RAW;
	TransferState state = TransferState::IDLE;
	TransferPhase phase = TransferPhase::NONE;
	uint32_t next = 0;  // next expected HTTP chunk index (zero based)
	uint32_t total = 0;
	uint16_t delayMs = DEFAULT_CHAR_DELAY_MS;
	char error[80] = { 0 };
};

static TransferContext transfer;

static const char* transferStateName(TransferState state)
{
	switch (state)
	{
		case TransferState::IDLE:        return "idle";
		case TransferState::TYPING:      return "typing";
		case TransferState::READY:       return "ready";
		case TransferState::COMPLETE:    return "complete";
		case TransferState::CANCELLED:   return "cancelled";
		case TransferState::ERROR_STATE: return "error";
	}
	return "error";
}

static const char* transferModeName(TransferMode mode)
{
	return mode == TransferMode::WVK1 ? "wvk1" : "raw";
}

static bool transferActive()
{
	return transfer.state == TransferState::TYPING ||
		   transfer.state == TransferState::READY;
}

static void sendJsonError(int status, const char* message, int32_t expected = -1)
{
	StaticJsonDocument<256> out;
	out["ok"] = false;
	out["error"] = message;
	if (expected >= 0)
	{
		out["expected"] = expected;
	}
	String json;
	serializeJson(out, json);
	server.send(status, "application/json; charset=utf-8", json);
}

static void sendTransferStatus(int status, bool duplicate = false)
{
	StaticJsonDocument<512> out;
	out["ok"] = true;
	out["id"] = transfer.id;
	out["state"] = transferStateName(transfer.state);
	out["mode"] = transferModeName(transfer.mode);
	out["next"] = transfer.next;
	out["total"] = transfer.total;
	out["lastCompleted"] = transfer.next == 0U ? -1 : (int32_t)(transfer.next - 1U);
	out["delayMs"] = transfer.delayMs;
	out["remainingChars"] = hidTypingRemaining();
	out["maxChunkChars"] = MAX_TRANSFER_CHUNK_CHARS;
	out["accepting"] = transfer.state == TransferState::READY;
	if (transfer.error[0] != '\0')
	{
		out["error"] = transfer.error;
	}
	if (duplicate)
	{
		out["duplicate"] = true;
	}
	String json;
	serializeJson(out, json);
	server.send(status, "application/json; charset=utf-8", json);
}

static bool parseUint32(const String& value, uint32_t maximum, uint32_t& parsed)
{
	if (value.length() == 0U)
	{
		return false;
	}

	uint64_t result = 0;
	for (size_t i = 0; i < value.length(); ++i)
	{
		const char c = value[i];
		if (c < '0' || c > '9')
		{
			return false;
		}
		result = result * 10U + (uint8_t)(c - '0');
		if (result > maximum)
		{
			return false;
		}
	}
	parsed = (uint32_t)result;
	return true;
}

static bool parseUint64(const String& value, uint64_t& parsed)
{
	if (value.length() == 0U)
	{
		return false;
	}

	uint64_t result = 0;
	for (size_t i = 0; i < value.length(); ++i)
	{
		const char c = value[i];
		if (c < '0' || c > '9')
		{
			return false;
		}
		const uint8_t digit = (uint8_t)(c - '0');
		if (result > (UINT64_MAX - digit) / 10U)
		{
			return false;
		}
		result = result * 10U + digit;
	}
	parsed = result;
	return true;
}

static bool isHexString(const String& value, size_t exactLength)
{
	if (value.length() != exactLength)
	{
		return false;
	}
	for (size_t i = 0; i < value.length(); ++i)
	{
		const char c = value[i];
		if (!((c >= '0' && c <= '9') ||
			  (c >= 'a' && c <= 'f') ||
			  (c >= 'A' && c <= 'F')))
		{
			return false;
		}
	}
	return true;
}

static bool isPrintableAscii(const String& value)
{
	for (size_t i = 0; i < value.length(); ++i)
	{
		const uint8_t c = (uint8_t)value[i];
		if (c < 0x20U || c > 0x7EU)
		{
			return false;
		}
	}
	return true;
}

static bool normalizeRawAscii(String& value)
{
	if (value.length() > MAX_TRANSFER_CHUNK_CHARS)
	{
		return false;
	}

	String normalized;
	if (value.length() != 0U && !normalized.reserve(value.length()))
	{
		return false;
	}
	for (size_t i = 0; i < value.length(); ++i)
	{
		const uint8_t c = (uint8_t)value[i];
		if (c == '\r')
		{
			if (i + 1U < value.length() && value[i + 1U] == '\n')
			{
				++i;
			}
			normalized += '\n';
		}
		else if (c == '\n' || c == '\t' || (c >= 0x20U && c <= 0x7EU))
		{
			normalized += (char)c;
		}
		else
		{
			return false;
		}
	}
	value = normalized;
	return value.length() <= MAX_TRANSFER_CHUNK_CHARS;
}

static bool isValidBase64(const String& value)
{
	if (value.length() == 0U ||
		value.length() > MAX_TRANSFER_CHUNK_CHARS ||
		(value.length() % 4U) != 0U)
	{
		return false;
	}

	bool padding = false;
	uint8_t paddingCount = 0;
	for (size_t i = 0; i < value.length(); ++i)
	{
		const char c = value[i];
		if (c == '=')
		{
			padding = true;
			if (++paddingCount > 2U || i + 2U < value.length())
			{
				return false;
			}
		}
		else
		{
			if (padding || !((c >= 'A' && c <= 'Z') ||
							 (c >= 'a' && c <= 'z') ||
							 (c >= '0' && c <= '9') || c == '+' || c == '/'))
			{
				return false;
			}
		}
	}
	return true;
}

static String requestDataArgument()
{
	if (server.hasArg("data"))
	{
		return server.arg("data");
	}
	// ESP32 WebServer exposes a text/plain request body as the `plain` arg.
	if (server.hasArg("plain"))
	{
		return server.arg("plain");
	}
	return String();
}

static bool queueOne(const String& text, uint16_t delayMs)
{
	const HidTextSegment segment = { text.c_str(), text.length() };
	return hidTypingQueue(&segment, 1U, delayMs);
}

static bool queueSegments(const HidTextSegment* segments, size_t count,
						  uint16_t delayMs)
{
	return hidTypingQueue(segments, count, delayMs);
}

// === REST API ===

// GET /
void handleRoot()
{
	if (!requireAuth()) { return; }

	server.send_P(200, "text/html; charset=utf-8", INDEX_HTML);
}

// GET /decoder and /decoder.html
void handleDecoder()
{
	if (!requireAuth()) { return; }

	server.send_P(200, "text/html; charset=utf-8", DECODER_HTML);
}

// POST /type  (form: text=..., newline=0|1|true|on)
// Free-text typing from the main textarea. No token parsing here.
void handleType() {
	if (!requireAuth()) return;
	if (transferActive() || hidTypingBusy()) {
		server.send(409, "text/plain", "A transfer is active");
		return;
	}

	if (!server.hasArg("text")) {
		server.send(400, "text/plain", "Missing 'text'");
		return;
	}

	String text = server.arg("text");
	if (text.length() > MAX_QUICK_TYPE_CHARS || !normalizeRawAscii(text)) {
		sendJsonError(400, "text must be at most 2048 US-ASCII characters");
		return;
	}
	const String nlArg = server.hasArg("newline") ? server.arg("newline") : "0";
	const bool addNL   = (nlArg == "1" || nlArg == "true" || nlArg == "on");

	uint32_t delayValue = DEFAULT_CHAR_DELAY_MS;
	if (server.hasArg("delayMs") &&
		!parseUint32(server.arg("delayMs"), MAX_CHAR_DELAY_MS, delayValue)) {
		sendJsonError(400, "delayMs must be between 0 and 100");
		return;
	}

	LogSerial.printf("[TYPE] queued len=%u addNL=%s delay=%lu ms\r\n",
				 (unsigned)text.length(), addNL ? "yes" : "no",
				 (unsigned long)delayValue);

	Keyboard.releaseAll();
	if (text.length() == 0U && !addNL) {
		server.send(200, "text/plain", "OK");
		return;
	}

	const char newline = '\n';
	const HidTextSegment segments[] = {
		{ text.c_str(), text.length() },
		{ &newline, addNL ? 1U : 0U }
	};
	if (!queueSegments(segments, 2U, (uint16_t)delayValue)) {
		sendJsonError(500, "Could not queue text");
		return;
	}
	server.send(202, "text/plain", "QUEUED");
}

// GET /typing/status -- applies to a queued /type job. Transfer clients should
// continue to use /transfer/status for sequence acknowledgement.
void handleTypingStatus()
{
	if (!requireAuth()) { return; }
	StaticJsonDocument<160> out;
	out["ok"] = true;
	out["busy"] = hidTypingBusy();
	out["remainingChars"] = hidTypingRemaining();
	String json;
	serializeJson(out, json);
	server.send(200, "application/json; charset=utf-8", json);
}

// POST /transfer/start
// application/x-www-form-urlencoded fields:
//   mode=raw|wvk1, filename, size, chunks (or total), sha256?, delayMs?
void handleTransferStart()
{
	if (!requireAuth()) { return; }
	if (transferActive() || hidTypingBusy())
	{
		sendJsonError(409, "A keyboard job is already active");
		return;
	}

	const String modeArg = server.hasArg("mode") ? server.arg("mode") : String("wvk1");
	TransferMode mode;
	if (modeArg == "raw")
	{
		mode = TransferMode::RAW;
	}
	else if (modeArg == "wvk1")
	{
		mode = TransferMode::WVK1;
	}
	else
	{
		sendJsonError(400, "mode must be raw or wvk1");
		return;
	}

	const String filename = server.hasArg("filename") ? server.arg("filename") : String("download.bin");
	if (filename.length() == 0U || filename.length() > MAX_TRANSFER_FILENAME ||
		!isPrintableAscii(filename))
	{
		sendJsonError(400, "filename must be 1-128 printable ASCII characters");
		return;
	}

	uint64_t byteSize = 0;
	if (!server.hasArg("size") || !parseUint64(server.arg("size"), byteSize))
	{
		sendJsonError(400, "size must be an unsigned decimal integer");
		return;
	}

	const String totalArg = server.hasArg("chunks") ? server.arg("chunks") :
		(server.hasArg("total") ? server.arg("total") : String());
	uint32_t total = 0;
	if (!parseUint32(totalArg, MAX_TRANSFER_CHUNKS, total))
	{
		sendJsonError(400, "chunks must be between 0 and 999999");
		return;
	}
	if ((byteSize == 0U) != (total == 0U))
	{
		sendJsonError(400, "empty size and zero chunks must be used together");
		return;
	}

	const String sha256 = server.hasArg("sha256") ? server.arg("sha256") : String();
	if (sha256.length() != 0U && !isHexString(sha256, 64U))
	{
		sendJsonError(400, "sha256 must be empty or 64 hexadecimal characters");
		return;
	}

	uint32_t delayValue = DEFAULT_CHAR_DELAY_MS;
	const String delayArg = server.hasArg("delayMs") ? server.arg("delayMs") :
		(server.hasArg("delay") ? server.arg("delay") : String());
	if (delayArg.length() != 0U && !parseUint32(delayArg, MAX_CHAR_DELAY_MS, delayValue))
	{
		sendJsonError(400, "delayMs must be between 0 and 100");
		return;
	}

	transfer = TransferContext();
	transfer.mode = mode;
	transfer.total = total;
	transfer.delayMs = (uint16_t)delayValue;
	const uint32_t randomPart = esp_random();
	const uint32_t timePart = millis();
	snprintf(transfer.id, sizeof(transfer.id), "%08lX%08lX",
			 (unsigned long)timePart, (unsigned long)randomPart);

	Keyboard.releaseAll();
	if (mode == TransferMode::RAW)
	{
		transfer.state = total == 0U ? TransferState::COMPLETE : TransferState::READY;
		transfer.phase = TransferPhase::NONE;
	}
	else
	{
		char sizeBuffer[24];
		char chunksBuffer[16];
		snprintf(sizeBuffer, sizeof(sizeBuffer), "%llu", (unsigned long long)byteSize);
		snprintf(chunksBuffer, sizeof(chunksBuffer), "%lu", (unsigned long)total);

		String header;
		header.reserve(filename.length() + sha256.length() + 96U);
		header += "WVK1\nNAME=";
		header += filename;
		header += "\nSIZE=";
		header += sizeBuffer;
		header += "\nCHUNKS=";
		header += chunksBuffer;
		header += '\n';
		if (sha256.length() != 0U)
		{
			header += "SHA256=";
			header += sha256;
			header += '\n';
		}
		header += '\n';
		if (total == 0U)
		{
			header += "END\n";
		}

		if (!queueOne(header, transfer.delayMs))
		{
			transfer.state = TransferState::ERROR_STATE;
			strlcpy(transfer.error, "Could not queue WVK1 header", sizeof(transfer.error));
			sendJsonError(500, transfer.error);
			return;
		}
		transfer.state = TransferState::TYPING;
		transfer.phase = TransferPhase::HEADER;
	}

	LogSerial.printf("[TRANSFER] start id=%s mode=%s chunks=%lu delay=%u ms\r\n",
				 transfer.id, transferModeName(transfer.mode),
				 (unsigned long)transfer.total, transfer.delayMs);
	sendTransferStatus(202);
}

// POST /transfer/chunk
// Form fields: id, index (or seq), data, and crc32 for WVK1. A text/plain body
// may be used instead of `data`; the other fields can then be query arguments.
void handleTransferChunk()
{
	if (!requireAuth()) { return; }
	if (!server.hasArg("id") || server.arg("id") != transfer.id || transfer.id[0] == '\0')
	{
		sendJsonError(404, "Unknown transfer id");
		return;
	}

	const String indexArg = server.hasArg("index") ? server.arg("index") :
		(server.hasArg("seq") ? server.arg("seq") : String());
	uint32_t index = 0;
	if (!parseUint32(indexArg, MAX_TRANSFER_CHUNKS - 1U, index))
	{
		sendJsonError(400, "index must be a zero-based unsigned integer");
		return;
	}

	if (index < transfer.next)
	{
		sendTransferStatus(200, true);
		return;
	}
	if (index > transfer.next)
	{
		sendJsonError(409, "Out-of-order chunk", (int32_t)transfer.next);
		return;
	}
	// A lost HTTP response can cause the sender to retry while this exact chunk
	// is still being typed. Treat that retry as accepted without re-queuing it.
	if (transfer.state == TransferState::TYPING && transfer.phase == TransferPhase::CHUNK)
	{
		sendTransferStatus(202, true);
		return;
	}
	if (transfer.state != TransferState::READY || index >= transfer.total)
	{
		sendJsonError(409, "Transfer is not ready for this chunk", (int32_t)transfer.next);
		return;
	}
	if ((!server.hasArg("data") && !server.hasArg("plain")))
	{
		sendJsonError(400, "Missing data");
		return;
	}

	String data = requestDataArgument();
	bool queued = false;
	if (transfer.mode == TransferMode::RAW)
	{
		if (data.length() == 0U || !normalizeRawAscii(data))
		{
			sendJsonError(400, "raw data must be 1-2048 US-ASCII characters");
			return;
		}
		queued = queueOne(data, transfer.delayMs);
	}
	else
	{
		if (!isValidBase64(data))
		{
			sendJsonError(400, "data must be 1-2048 characters of padded Base64");
			return;
		}
		if (!server.hasArg("crc32") || !isHexString(server.arg("crc32"), 8U))
		{
			sendJsonError(400, "crc32 must be 8 hexadecimal characters");
			return;
		}

		String crc32 = server.arg("crc32");
		crc32.toUpperCase();
		char prefix[32];
		const int prefixLength = snprintf(prefix, sizeof(prefix), "C|%06lu|%s|",
									  (unsigned long)(index + 1U), crc32.c_str());
		const char* suffix = (index + 1U == transfer.total) ? "\nEND\n" : "\n";
		const HidTextSegment segments[] =
		{
			{ prefix, (size_t)prefixLength },
			{ data.c_str(), data.length() },
			{ suffix, strlen(suffix) }
		};
		queued = queueSegments(segments, 3U, transfer.delayMs);
	}

	if (!queued)
	{
		transfer.state = TransferState::ERROR_STATE;
		strlcpy(transfer.error, "Could not queue chunk", sizeof(transfer.error));
		sendJsonError(500, transfer.error);
		return;
	}

	transfer.state = TransferState::TYPING;
	transfer.phase = TransferPhase::CHUNK;
	LogSerial.printf("[TRANSFER] id=%s queued chunk=%lu/%lu chars=%u\r\n",
				 transfer.id, (unsigned long)(index + 1U),
				 (unsigned long)transfer.total, (unsigned)data.length());
	sendTransferStatus(202);
}

// GET /transfer/status
void handleTransferStatus()
{
	if (!requireAuth()) { return; }
	sendTransferStatus(200);
}

// POST /transfer/cancel (also registered as /transfer/stop)
void handleTransferCancel()
{
	if (!requireAuth()) { return; }
	if (server.hasArg("id") && server.arg("id") != transfer.id)
	{
		sendJsonError(404, "Unknown transfer id");
		return;
	}

	if (transferActive())
	{
		hidTypingCancel();
		transfer.state = TransferState::CANCELLED;
		transfer.phase = TransferPhase::NONE;
		strlcpy(transfer.error, "Cancelled by user", sizeof(transfer.error));
		LogSerial.printf("[TRANSFER] cancelled id=%s next=%lu\r\n",
					 transfer.id, (unsigned long)transfer.next);
	}
	sendTransferStatus(200);
}

// Called on every main-loop iteration after WebServer processing. It advances
// at most one HID character, then publishes a completed header/chunk atomically
// by changing transfer.state / transfer.next.
void serviceHttpJobs()
{
	hidTypingService();
	if (transfer.state != TransferState::TYPING || hidTypingBusy())
	{
		return;
	}

	if (transfer.phase == TransferPhase::HEADER)
	{
		transfer.state = transfer.total == 0U ? TransferState::COMPLETE : TransferState::READY;
	}
	else if (transfer.phase == TransferPhase::CHUNK)
	{
		++transfer.next;
		transfer.state = transfer.next >= transfer.total ?
			TransferState::COMPLETE : TransferState::READY;
	}
	transfer.phase = TransferPhase::NONE;
}

// GET /info
// Small metadata endpoint so the web UI footer can show the firmware and storage
// layout versions (compiled-in constants, not stored data).
void handleGetInfo()
{
	if (!requireAuth()) { return; }

	String out = "{\"fw\":\"";
	out += FW_VERSION;
	out += "\",\"storage\":\"";
	out += STORAGE_VERSION;
	out += "\"}";

	server.send(200, "application/json; charset=utf-8", out);
}

// === NETWORK SETTINGS ===

// GET /wifi
// Reports the saved mode plus what the radio is actually doing right now.
// Passwords are never sent back: the browser never needs them, and a generated
// access point password is already readable on the device display.
void handleGetWifi()
{
	if (!requireAuth()) { return; }

	const WifiSettings& saved = wifiSettings();
	const WifiState     state = wifiState();

	JsonDocument out;
	out["ok"]        = true;
	out["mode"]      = (saved.mode == WifiMode::AP) ? "ap" : "auto";
	out["sta_ssid"]  = saved.staSsid;
	out["ap_ssid"]   = saved.apSsid;
	out["ssid"]      = wifiActiveSsid();
	out["ip"]        = wifiActiveIp();
	out["ap_min_pass"] = AP_PASS_MIN_LEN;

	switch (state)
	{
		case WifiState::STA:
			out["active"] = "sta";
			out["rssi"]   = WiFi.RSSI();
			break;

		case WifiState::AP:
			out["active"]  = "ap";
			out["clients"] = WiFi.softAPgetStationNum();
			break;

		default:
			out["active"] = "down";
			break;
	}

	String json;
	serializeJson(out, json);
	server.send(200, "application/json; charset=utf-8", json);
}

// POST /wifi (form: mode=auto|ap, [sta_ssid], [sta_pass], [ap_ssid], [ap_pass])
//
// A password field that is absent keeps the stored one, which is how the UI
// saves without ever having to echo a secret back to the browser. Present but
// empty means "no password" and is only accepted for a station network (an
// open access point would hand the host's keyboard to anyone in range).
// The device reboots afterwards: switching the radio mode underneath a live
// HTTP connection is not worth the failure modes.
void handlePostWifi()
{
	if (!requireAuth()) { return; }

	if (transferActive() || hidTypingBusy())
	{
		sendJsonError(409, "busy: a transfer or typing job is still running");
		return;
	}

	const WifiSettings& saved = wifiSettings();
	WifiSettings next = saved;

	const String mode = server.arg("mode");

	if (mode == "ap")
	{
		next.mode = WifiMode::AP;
	}
	else if (mode == "auto")
	{
		next.mode = WifiMode::AUTO;
	}
	else
	{
		sendJsonError(400, "mode must be \"auto\" or \"ap\"");
		return;
	}

	if (server.hasArg("sta_ssid"))
	{
		next.staSsid = server.arg("sta_ssid");
		next.staSsid.trim();
	}

	const bool ssidChanged = next.staSsid != saved.staSsid;

	if (server.hasArg("sta_pass"))
	{
		next.staPass = server.arg("sta_pass");
	}
	else if (ssidChanged)
	{
		// Reusing the old network's password for a new SSID would just fail at
		// boot, so make the caller be explicit (empty = open network).
		sendJsonError(400, "sta_pass is required when sta_ssid changes");
		return;
	}

	if (next.mode == WifiMode::AUTO && next.staSsid.length() == 0U)
	{
		sendJsonError(400, "sta_ssid is required in auto mode");
		return;
	}

	if (next.staSsid.length() > 32U)
	{
		sendJsonError(400, "sta_ssid is too long");
		return;
	}

	if (next.staPass.length() > 63U)
	{
		sendJsonError(400, "sta_pass is too long");
		return;
	}

	if (server.hasArg("ap_ssid"))
	{
		String apSsid = server.arg("ap_ssid");
		apSsid.trim();

		if (apSsid.length() > 32U)
		{
			sendJsonError(400, "ap_ssid is too long");
			return;
		}

		if (apSsid.length() != 0U)
		{
			next.apSsid = apSsid;
		}
	}

	if (server.hasArg("ap_pass"))
	{
		const String apPass = server.arg("ap_pass");

		if (apPass.length() != 0U)
		{
			if (apPass.length() < AP_PASS_MIN_LEN)
			{
				sendJsonError(400, "ap_pass must be at least 8 characters");
				return;
			}

			if (apPass.length() > 63U)
			{
				sendJsonError(400, "ap_pass is too long");
				return;
			}

			next.apPass = apPass;
		}
	}

	if (!wifiSave(next))
	{
		sendJsonError(500, "could not save the network settings");
		return;
	}

	JsonDocument out;
	out["ok"]         = true;
	out["mode"]       = (next.mode == WifiMode::AP) ? "ap" : "auto";
	out["restart_ms"] = WIFI_RESTART_DELAY_MS;

	String json;
	serializeJson(out, json);
	server.send(200, "application/json; charset=utf-8", json);

	wifiRequestRestart(WIFI_RESTART_DELAY_MS);
}

// POST /wifi/scan
// Kicks off an asynchronous scan and returns immediately; a blocking scan
// would outlast the request when the caller is attached to the access point.
void handleWifiScanStart()
{
	if (!requireAuth()) { return; }

	wifiScanStart();
	server.send(202, "application/json; charset=utf-8", "{\"ok\":true,\"state\":\"running\"}");
}

// GET /wifi/scan
// -> { state: "idle" | "running" | "done", nets: [ { ssid, rssi, open } ] }
void handleWifiScanResult()
{
	if (!requireAuth()) { return; }

	const int found = wifiScanState();

	if (found == -1)
	{
		server.send(200, "application/json; charset=utf-8", "{\"ok\":true,\"state\":\"running\"}");
		return;
	}

	if (found < 0)
	{
		server.send(200, "application/json; charset=utf-8", "{\"ok\":true,\"state\":\"idle\"}");
		return;
	}

	JsonDocument out;
	out["ok"]    = true;
	out["state"] = "done";
	JsonArray nets = out["nets"].to<JsonArray>();

	// Results arrive strongest-first, so the first entry for an SSID is the one
	// worth keeping. Mesh networks would otherwise fill the list with repeats.
	String seen;
	uint8_t listed = 0;

	for (int i = 0; i < found && listed < 24U; i++)
	{
		const String ssid = WiFi.SSID(i);

		if (ssid.length() == 0U)
		{
			continue; // hidden network, nothing to offer the user
		}

		String key = "\n";
		key += ssid;
		key += "\n";

		if (seen.indexOf(key) >= 0)
		{
			continue;
		}

		seen += key;
		listed++;

		JsonObject net = nets.add<JsonObject>();
		net["ssid"] = ssid;
		net["rssi"] = WiFi.RSSI(i);
		net["open"] = WiFi.encryptionType(i) == WIFI_AUTH_OPEN;
	}

	String json;
	serializeJson(out, json);
	server.send(200, "application/json; charset=utf-8", json);
}

// GET /presets
// Returns [ { name, group, vis, value? } ]. Values of "hidden" presets are
// stripped so they never reach the browser.
void handleGetPresets()
{
	if (!requireAuth()) { return; }

	const String json = loadPresetsJson();

	if (deserializeJson(doc, json))
	{
		server.send(200, "application/json; charset=utf-8", "[]");
		return;
	}

	DynamicJsonDocument out(MAX_JSON_SIZE);
	JsonArray root = out.to<JsonArray>();

	if (doc.is<JsonArray>())
	{
		for (JsonObject src : doc.as<JsonArray>())
		{
			String vis = src["vis"] | "mask";

			JsonObject dst = root.add<JsonObject>();
			dst["name"]  = src["name"]  | "";
			dst["group"] = src["group"] | "";
			dst["vis"]   = vis;

			if (vis != "hidden")
			{
				dst["value"] = src["value"] | "";
			}
		}
	}

	String outStr;
	serializeJson(out, outStr);
	server.send(200, "application/json; charset=utf-8", outStr);
}

// POST /presets (form: name, group, vis, [value], [oldName, oldGroup])
// Presence of 'oldName' marks an edit; the (oldName, oldGroup) pair identifies
// the preset to update, and name/group may change. If 'value' is omitted the
// existing value is kept (used when editing a hidden preset without retyping it).
void handlePostPreset()
{
	if (!requireAuth()) { return; }

	if (!server.hasArg("name"))
	{
		server.send(400, "text/plain", "Missing 'name'");
		return;
	}

	const String name     = server.arg("name");
	const bool   hasValue = server.hasArg("value");
	const String value    = hasValue ? server.arg("value") : String("");
	const String vis      = server.hasArg("vis") ? server.arg("vis") : String("mask");
	const String group    = server.hasArg("group") ? server.arg("group") : String("");
	const bool   isEdit   = server.hasArg("oldName");
	const String oldName  = isEdit ? server.arg("oldName") : String("");
	const String oldGroup = server.hasArg("oldGroup") ? server.arg("oldGroup") : String("");

	String err;
	if (!setPreset(name, group, oldName, oldGroup, isEdit, value, hasValue, vis, &err))
	{
		server.send(400, "text/plain", err.length() ? err : String("Failed to save preset"));
		return;
	}

	server.send(200, "text/plain", "OK");
}

// DELETE /presets?name=...&group=...
void handleDeletePreset()
{
	if (!requireAuth()) { return; }

	if (!server.hasArg("name"))
	{
		server.send(400, "text/plain", "Missing 'name'");
		return;
	}

	const String name  = server.arg("name");
	const String group = server.hasArg("group") ? server.arg("group") : String("");

	if (!deletePreset(name, group))
	{
		server.send(404, "text/plain", "Not found");
		return;
	}

	server.send(200, "text/plain", "OK");
}

// POST /send (form: name, [group])
// Types a stored preset identified by (name, group). The value (incl. hidden
// ones) never leaves the device; token parsing + chords happen here.
void handleSendPreset()
{
	if (!requireAuth()) { return; }
	if (transferActive() || hidTypingBusy())
	{
		server.send(409, "text/plain", "A keyboard job is already active");
		return;
	}

	if (!server.hasArg("name"))
	{
		server.send(400, "text/plain", "Missing 'name'");
		return;
	}

	const String name  = server.arg("name");
	const String group = server.hasArg("group") ? server.arg("group") : String("");
	const String json  = loadPresetsJson();

	if (deserializeJson(doc, json))
	{
		server.send(500, "text/plain", "JSON parse error");
		return;
	}

	const int idx = findPresetIndex(name, group);
	if (idx < 0)
	{
		server.send(404, "text/plain", "Not found");
		return;
	}

	const String value = doc.as<JsonArray>()[idx]["value"] | "";

	LogSerial.printf("[SEND] preset \"%s\" len=%u\r\n", name.c_str(), (unsigned)value.length());

	Keyboard.releaseAll();
	delay(10);
	sendValue(value);
	delay(TYPE_DELAY_MS);

	server.send(200, "text/plain", "OK");
}
