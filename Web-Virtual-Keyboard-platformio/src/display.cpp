#include "display.h"
#include "pinout.h"
#include <Adafruit_GFX.h>
#include <Adafruit_ST7735.h>
#include <SPI.h>
#include "config.h"
#include "globals.h"
#include "storage.h"

SPIClass spi_lcd(FSPI);
Adafruit_ST7735 tft(&spi_lcd, TFT_CS, TFT_DC, TFT_RST);

// Characters drawn by the previous call on each line, per alignment, so both
// the label and the value can be rewritten at runtime (the Wi-Fi rows swap
// between station and access point wording).
static uint8_t chars_to_delete[2][MAX_LINES] = {{0}};

void display_write_word(uint16_t color, Align align, uint32_t line, const char *word)
{
    if (line + 1 > MAX_LINES)
    {
        return;
    }

    const int16_t  y        = DISPLAY_TOP_HW_OFFSET + (BORDER_OFFSET + (line * NEW_LINE_OFFSET));
    const uint8_t  length   = (uint8_t)strlen(word);
    const uint8_t  side     = (align == Align::LEFT) ? 0U : 1U;
    uint8_t       &previous = chars_to_delete[side][line];

    if (previous != 0)
    {
        const int16_t clear_x = (align == Align::LEFT)
            ? BORDER_OFFSET
            : (int16_t)(DISPLAY_WIDTH - (BORDER_OFFSET + (previous * CHARACTER_WIDTH)));

        tft.fillRect(
            clear_x,
            y,
            BORDER_OFFSET + (previous * CHARACTER_WIDTH),
            NEW_LINE_OFFSET,
            COLOR_BACKGROUND
        );
    }

    previous = length;

    const int16_t x = (align == Align::LEFT)
        ? BORDER_OFFSET
        : (int16_t)(DISPLAY_WIDTH - (BORDER_OFFSET + (length * CHARACTER_WIDTH)));

    tft.setTextColor(color);
    tft.setCursor(x, y);
    tft.print(word);
}

void display_init()
{
    pinMode(TFT_BL, OUTPUT);
    digitalWrite(TFT_BL, LOW);

    spi_lcd.begin(TFT_SCLK, -1, TFT_MOSI, TFT_CS);

    tft.initR(INITR_GREENTAB);
    tft.invertDisplay(true);
    tft.setRotation(3); 
    tft.fillScreen(COLOR_BACKGROUND);
    tft.setTextSize(1); 
    
    display_write_word(COLOR_THEME, Align::LEFT, 0, "FW version");
    display_write_word(COLOR_THEME, Align::LEFT, 1, "Storage version");
    display_write_word(COLOR_THEME, Align::LEFT, 2, "Groups");
    display_write_word(COLOR_THEME, Align::LEFT, 3, "Presets");
    display_write_word(COLOR_THEME, Align::LEFT, 4, "SSID");
    display_write_word(COLOR_THEME, Align::LEFT, 5, "Wi-Fi");

    display_write_word(COLOR_WHITE, Align::RIGHT, 0, FW_VERSION);
    display_write_word(COLOR_WHITE, Align::RIGHT, 1, STORAGE_VERSION);
    
    char groups_string[8] = "";
    sprintf(groups_string, "%d", getGroupsCount());
    display_write_word(COLOR_WHITE, Align::RIGHT, 2, groups_string);

    char temp_string[8] = "";
    sprintf(temp_string, "%d", getPresetsCount());
    display_write_word(COLOR_WHITE, Align::RIGHT, 3, temp_string);

    // Rows 4 and 5 hold the network state and are filled in by wifiInit(): the
    // SSID is a runtime setting now, and the wording differs per mode.
    display_write_word(COLOR_WHITE, Align::RIGHT, 5, "Connecting");
}