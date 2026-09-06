#pragma once
#include <cstdint>
#include <cstddef>
#include <cstring>
#include <string>
#include <algorithm>
#include <cctype>

extern uint32_t fakeMillis;
inline uint32_t millis() { return fakeMillis; }
inline void delay(uint32_t ms) { fakeMillis += ms; }
class String : public std::string {
public:
    using std::string::string;
    using std::string::operator=;
    String(const std::string& value) : std::string(value) {}
    size_t write(uint8_t c) { push_back(char(c)); return 1; }
    size_t write(const uint8_t* data, size_t n) { append(reinterpret_cast<const char*>(data), n); return n; }
    bool reserve(size_t n) { std::string::reserve(n); return true; }
    bool equals(const char* other) const { return *this == other; }
    int indexOf(char c, size_t from = 0) const { auto i = find(c, from); return i == npos ? -1 : int(i); }
    String substring(size_t from, size_t to) const { return substr(from, to - from); }
    void trim() {
        auto first = find_first_not_of(" \t\r\n"), last = find_last_not_of(" \t\r\n");
        *this = first == npos ? "" : substr(first, last - first + 1);
    }
    void toUpperCase() { for (char& c : *this) { c = std::toupper((unsigned char)c); } }
    void replace(const char* from, const char* to) {
        size_t pos = 0;
        while ((pos = find(from, pos)) != npos) { std::string::replace(pos, strlen(from), to); pos += strlen(to); }
    }
    void replace(char from, char to) { std::replace(begin(), end(), from, to); }
};
