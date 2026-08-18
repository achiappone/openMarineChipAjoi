// Everything installation-specific lives here. Nothing below this file should
// need editing when the hardware or the bank changes.
#pragma once

// ---------------------------------------------------------------- shunt ----
// 500 A / 50 mV shunt => 50mV / 500A = 100 microohm.
//
// NOT 0.0001f, however much it wants to be. The INA228 library guards with
// `if (shunt < 0.0001) return -2;` -- comparing the float parameter against a
// DOUBLE literal. 0.0001f stored as a float is 9.999999747e-05, which really is
// less than 0.0001, so the exact value is rejected and the chip silently runs
// uncalibrated. Nudging to the next representable step clears the guard at a
// 0.01% error -- roughly 25x smaller than the shunt's own tolerance.
#define SHUNT_OHMS          0.00010001f
#define SHUNT_MAX_AMPS      500.0f

// Which way round the shunt is wired decides the sign of the reading. NMEA 2000
// wants current POSITIVE WHEN CHARGING (flowing into the bank). Watch the first
// serial output with a known load on: if a discharge reads positive, flip this
// to -1.0f. Guessing the wiring from a desk is not possible, so this is a knob.
#define CURRENT_SIGN        1.0f

// ------------------------------------------------------------------ bank ----
// TODO(anthony): set to the real house bank capacity. Only affects the SOC and
// time-remaining estimates in PGN 127506/127513 -- volts and amps are unaffected.
#define BANK_CAPACITY_AH    300.0f
#define BANK_CHEMISTRY      N2kDCbc_LeadAcid
#define BANK_NOMINAL_VOLTS  N2kDCbnv_12v

// Coulomb counting drifts, so it is re-synced to 100% whenever the bank sits
// above FULL_VOLTS while accepting less than FULL_TAIL_AMPS for FULL_HOLD_MS.
// These are absorption/float numbers for a 12 V lead-acid bank; an LFP bank
// wants something more like 13.6 V and a smaller tail.
#define FULL_VOLTS          13.4f
#define FULL_TAIL_AMPS      2.0f
#define FULL_HOLD_MS        120000UL

// ------------------------------------------------------------------ pins ----
// ESP32-S3. Avoid GPIO 19/20 (native USB) and 26-37 (flash + octal PSRAM).
#define I2C_SDA_PIN         8
#define I2C_SCL_PIN         9
#define CAN_TX_PIN          GPIO_NUM_5
#define CAN_RX_PIN          GPIO_NUM_4

// Both chips power up at 0x40, so exactly one of them has to move. The INA226
// board stays stock at its default and the INA228 is the one strapped: A0 -> VS
// puts it at 0x41. The boot-time I2C scan names whatever actually answered.
//
// Do NOT power both boards until the INA228 is strapped -- two chips sharing
// 0x40 is a bus collision, and the readings you get back are meaningless.
#define INA228_ADDR         0x41   // A1 -> GND, A0 -> VS   (strapped)
#define INA226_ADDR         0x40   // A1 -> GND, A0 -> GND  (stock, untouched)

// -------------------------------------------------------------- NMEA 2000 ----
#define N2K_BATTERY_INSTANCE 0
#define N2K_SOURCE_ADDRESS   22
// Must be unique per device on the bus; the low 21 bits of the ESP32 MAC are used
// at runtime, so this is only the fallback.
#define N2K_UNIQUE_NUMBER    1
#define N2K_MANUFACTURER     2046   // "reserved / self-assigned"

// ---------------------------------------------------------------- timing ----
#define TX_BATTERY_STATUS_MS 1500   // PGN 127508, NMEA 2000 standard rate
#define TX_DC_STATUS_MS      1500   // PGN 127506
#define TX_BAT_CONF_MS       5000   // PGN 127513
#define SOC_SAVE_MS          60000  // how often SOC is written to NVS
#define DEBUG_PRINT_MS       1000

// --------------------------------------------------------------- network ----
// Credentials live in secrets.h (gitignored). Copy secrets.h.example first.
#define WIFI_CONNECT_TIMEOUT_MS  15000UL   // then give up and run offline
#define OTA_HOSTNAME             "battmon"

// The Pi moves around on DHCP, so it is resolved by mDNS name, not IP.
#define SIGNALK_HOST             "openplotter"
#define SIGNALK_UDP_PORT         10113
#define SIGNALK_SOURCE           "battery-monitor"
#define SIGNALK_PUBLISH_MS       1000

// ------------------------------------------------------------------- BLE ----
// BLE passkeys are always SIX digits and the phone prompt wants all six, so a
// short number would be entered with leading zeros (6969 -> 006969). Use a full
// six digits to avoid that -- some pairing dialogs handle leading zeros badly.
#define BLE_PASSKEY          696969
#define BLE_NOTIFY_MS        1000   // phone-visible update rate
