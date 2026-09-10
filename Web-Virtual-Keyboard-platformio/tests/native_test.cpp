#include "Arduino.h"
#include <ArduinoJson.h>
#include <map>
#include <iostream>
#include "USBHID.h"
#include "config.h"
#include "hid_keyboard.h"
#include "hid_text.h"
#include "typing_engine.h"

uint32_t fakeMillis = 0;
uint32_t esp_random() { return 1234; }
struct { template<class... T> void printf(const char*, T...) {} } LogSerial;
JsonDocument doc;
String storedPresets = "[]";
String loadPresetsJson() { return storedPresets; }
bool savePresetsJson(const String& value) { storedPresets = value; return true; }
struct FakeServer {
    std::map<std::string, String> args;
    int status = 0;
    String body;
    bool authenticate(const char*, const char*) { return true; }
    void requestAuthentication() { status = 401; }
    bool hasArg(const char* key) { return args.count(key); }
    String arg(const char* key) { return args[key]; }
    void send(int code, const char*, const String& value) { status = code; body = value; }
} server;
#include "handlers.inc"

void request(std::initializer_list<std::pair<const std::string, String>> args) {
    server.args = args; server.status = 0; server.body.clear();
}
void reset() {
    USBHID::connected = true; USBHID::results.clear();
    hidTypingCancel();
    transfer = TransferContext(); cancelledStartId[0] = 0;
    USBHID::attempts.clear();
}
void start(const char* id, const char* mode = "raw") {
    request({{"id", id}, {"mode", mode}, {"filename", "test.txt"}, {"size", "3"}, {"chunks", "1"}, {"delayMs", "0"}});
    handleTransferStart();
}
void finishTyping() { while (hidTypingBusy()) { serviceHttpJobs(); fakeMillis += 100; } }

std::string typedText() {
    const uint8_t keys[128][2] = { HID_ASCII_TO_KEYCODE };
    std::string text;
    for (const auto& report : USBHID::attempts) {
        if (!report.keycode[0]) continue;
        bool found = false;
        for (size_t c = 0; c < 128; ++c) {
            if (keys[c][1] == report.keycode[0] && report.modifier == (keys[c][0] ? 2 : 0)) {
                text += static_cast<char>(c); found = true; break;
            }
        }
        assert(found);
    }
    return text;
}

int main() {
    const char* id = "0123456789abcdef0123456789abcdef";
    const char* other = "fedcba9876543210fedcba9876543210";
    reset();
    assert(hidTextIsAscii("<CTRL>c\r\n\t", strlen("<CTRL>c\r\n\t")));
    assert(!hidTextIsAscii("한", strlen("한")));
    assert(!hidTextIsAscii("\x7f", 1));
    assert(!hidTextIsAscii("\0", 1));
    String error;
    assert(!setPreset("한글 이름", "", "", "", false, "한", true, "plain", &error));
    assert(storedPresets == "[]");
    assert(setPreset("한글 이름", "", "", "", false, "<CTRL>c", true, "plain", &error));
    request({{"name", "한글 이름"}}); handleSendPreset();
    assert(server.status == 200);
    bool sawChord = false;
    for (const auto& r : USBHID::attempts) { if (r.modifier == 1 && r.keycode[0] == 6) sawChord = true; }
    assert(sawChord);
    // An old stored Unicode preset must be rejected before any key report.
    storedPresets = R"([{"name":"old","group":"","value":"한","vis":"hidden"}])";
    USBHID::attempts.clear();
    request({{"name", "old"}}); handleSendPreset();
    assert(server.status == 400 && USBHID::attempts.empty());

    reset();
    start(id, "wvk1"); assert(server.status == 202);
    const size_t remaining = hidTypingRemaining(), reports = USBHID::attempts.size();
    start(id, "wvk1"); assert(server.status == 200);
    assert(hidTypingRemaining() == remaining && USBHID::attempts.size() == reports);
    finishTyping(); assert(transfer.state == TransferState::READY);
    start(other); assert(server.status == 409); // another ID cannot replace a live job
    request({{"id", id}, {"index", "0"}, {"data", "YWJj"}, {"crc32", "352441C2"}});
    handleTransferChunk(); assert(server.status == 202);
    handleTransferChunk(); assert(server.status == 202); // in-flight duplicate
    finishTyping(); assert(transfer.next == 1 && transfer.state == TransferState::COMPLETE);
    const size_t finishedReports = USBHID::attempts.size();
    start(id, "wvk1"); assert(server.status == 200);
    assert(USBHID::attempts.size() == finishedReports); // lost final response cannot replay

    // WVK2 requires both hashes and original size before any USB reports.
    const char* sha = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
    for (const char* missing : {"sha256", "originalSize", "originalSha256"}) {
        reset();
        request({{"id", id}, {"mode", "wvk2"}, {"filename", "test.txt"}, {"size", "3"}, {"chunks", "1"},
                 {"sha256", sha}, {"originalSize", "100"}, {"originalSha256", sha}});
        server.args.erase(missing);
        handleTransferStart();
        assert(server.status == 400 && USBHID::attempts.empty());
    }
    reset();
    request({{"id", id}, {"mode", "wvk2"}, {"filename", "test.txt"}, {"size", "3"}, {"chunks", "1"},
             {"sha256", sha}, {"originalSize", "100"}, {"originalSha256", sha}, {"delayMs", "0"}});
    handleTransferStart(); assert(server.status == 202);
    assert(transfer.mode == TransferMode::WVK2);
    assert(server.body.find("wvk2") != std::string::npos);
    const size_t compressedHeaderChars = hidTypingRemaining();
    handleTransferStart(); assert(server.status == 200);
    assert(hidTypingRemaining() == compressedHeaderChars);
    finishTyping();
    std::string expectedHeader = std::string("WVK2\nNAME=test.txt\nSIZE=3\nCHUNKS=1\nSHA256=") + sha +
        "\nENCODING=gzip\nORIGINAL_SIZE=100\nORIGINAL_SHA256=" + sha + "\n\n";
    assert(typedText() == expectedHeader);
    request({{"id", id}, {"index", "0"}, {"data", "YWJj"}, {"crc32", "352441C2"}});
    handleTransferChunk(); assert(server.status == 202);
    finishTyping();
    assert(typedText() == expectedHeader + "C|000001|352441C2|YWJj\nEND\n");
    assert(transfer.state == TransferState::COMPLETE && transfer.next == 1);

    // A cancel delivered before its start prevents the late start from typing.
    reset(); request({{"id", id}}); handleTransferCancel(); assert(server.status == 200);
    start(id, "wvk1"); assert(server.status == 409 && USBHID::attempts.empty());
    // Cancelling an unrelated ID never cancels someone else's live transfer.
    start(other); assert(server.status == 202);
    request({{"id", id}}); handleTransferCancel();
    assert(transfer.state == TransferState::READY && String(transfer.id) == other);

    reset(); start(id);
    request({{"id", id}, {"index", "0"}, {"data", "abc"}}); handleTransferChunk();
    USBHID::results = {true, false}; // key-down succeeds, key-up times out
    serviceHttpJobs();
    assert(hidTypingFailed() && !hidTypingBusy());
    assert(transfer.state == TransferState::ERROR_STATE && transfer.next == 0);
    size_t afterFailure = USBHID::attempts.size();
    serviceHttpJobs(); // recovery sends only release-all, never repeats key-down
    assert(USBHID::attempts.size() == afterFailure + 1);
    assert(USBHID::attempts.back().keycode[0] == 0);
    serviceHttpJobs(); assert(USBHID::attempts.size() == afterFailure + 1);
    request({{"id", id}}); handleTransferCancel(); assert(transfer.state == TransferState::CANCELLED);

    // Unready USB is rejected at admission, and mid-transfer disconnect fails.
    reset(); USBHID::connected = false; start(id); assert(server.status == 503);
    assert(transfer.state == TransferState::IDLE);
    USBHID::connected = true; start(id); assert(server.status == 202);
    request({{"id", id}, {"index", "0"}, {"data", "abc"}}); handleTransferChunk();
    USBHID::connected = false; serviceHttpJobs();
    assert(transfer.state == TransferState::ERROR_STATE && transfer.next == 0);

    // Quick typing must report failure rather than busy=false success.
    reset(); request({{"text", "abc"}}); handleType(); assert(server.status == 202);
    USBHID::results = {false, true}; serviceHttpJobs();
    request({}); handleTypingStatus(); assert(server.status == 503);
    // A fresh queued job resets the failure and normal ASCII still works.
    request({{"text", "A\r\n\t"}}); handleType(); assert(server.status == 202);
    finishTyping(); request({}); handleTypingStatus(); assert(server.status == 200);
    assert(!hidTypingFailed());
    std::cout << "native HID and HTTP recovery tests passed\n";
}
