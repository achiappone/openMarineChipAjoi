// House-bank monitor: INA228 + INA226 across a 500 A / 50 mV shunt, reporting
// on NMEA 2000 (PGN 127506/127508/127513) and over BLE.
//
// The INA228 is the primary: 20-bit, ~0.95 mA resolution on this shunt. The
// INA226 sits on the same shunt as a sanity check at ~15 mA resolution -- if the
// two ever disagree by more than CROSSCHECK_TOLERANCE_A something is wrong with
// a connection, and that is worth knowing about on a boat.
//
// Target: ESP32-S3, Arduino-ESP32 core 3.x (ESP-IDF 5.x / FreeRTOS).
// Build:  see README.md -- the INA226 needs a -D flag or it refuses this shunt.

#include <Wire.h>
#include <Preferences.h>
#include <esp_mac.h>
#include <INA228.h>
#include <INA226.h>

#include <NMEA2000_esp32_twai.h>
#include <N2kMessages.h>

#include <BLEDevice.h>
#include <BLEServer.h>
#include <BLEUtils.h>
#include <BLE2902.h>
#include <BLE2901.h>
#include <BLESecurity.h>

#include "config.h"
#include "net.h"

// Disagreement beyond this between the two chips is reported, not hidden. The
// INA226 quantises at ~15 mA and both have offset error, so a small delta is
// normal; 2 A means a real fault.
static const float CROSSCHECK_TOLERANCE_A = 2.0f;

INA228 ina228(INA228_ADDR);
INA226 ina226(INA226_ADDR);
Preferences prefs;

NMEA2000_esp32_twai NMEA2000(CAN_TX_PIN, CAN_RX_PIN);

// ------------------------------------------------------------------ state ----
static bool     ina228Ok      = false;
static bool     ina226Ok      = false;
static float    busVolts      = 0.0f;
static float    amps          = 0.0f;   // + = charging, per CURRENT_SIGN
static float    watts         = 0.0f;
static float    dieTempC      = 0.0f;
static float    amps226       = 0.0f;
static float    consumedAh    = 0.0f;   // 0.0 = full, counts up as it discharges
static uint32_t fullSince     = 0;      // millis() when the full-charge test started
// Coulomb counting only knows where it is once it has SEEN a full charge. Until
// then the count is an assumption, not a measurement, and is reported as unknown
// rather than as a confident 100%. Persisted so it survives a reboot.
static bool     socKnown      = false;

// ----------------------------------------------------------------- BLE ------
// 0x180F/0x2A19 are the standard Battery Service so a generic phone app shows
// state of charge with no custom decoding. The 0xB0A7 service is ours.
#define BLE_DEVICE_NAME       "BoatBattery"
#define SVC_BATTERY_UUID      (uint16_t)0x180F
#define CHR_BATTERY_LEVEL     (uint16_t)0x2A19
#define SVC_DETAIL_UUID       "b0a70001-5c8f-4f2a-9a1d-7e3c9d4f6b21"
#define CHR_TEXT_UUID         "b0a70002-5c8f-4f2a-9a1d-7e3c9d4f6b21"
#define CHR_VOLTS_UUID        "b0a70003-5c8f-4f2a-9a1d-7e3c9d4f6b21"
#define CHR_AMPS_UUID         "b0a70004-5c8f-4f2a-9a1d-7e3c9d4f6b21"
#define CHR_CONSUMED_AH_UUID  "b0a70005-5c8f-4f2a-9a1d-7e3c9d4f6b21"
#define CHR_WATTS_UUID        "b0a70006-5c8f-4f2a-9a1d-7e3c9d4f6b21"

// Device Information Service -- so the phone shows what it has connected to
// rather than an anonymous UUID. Left unencrypted so it is readable before pairing.
#define SVC_DEVINFO_UUID      (uint16_t)0x180A
#define CHR_MANUFACTURER      (uint16_t)0x2A29
#define CHR_MODEL             (uint16_t)0x2A24
#define CHR_FIRMWARE          (uint16_t)0x2A26

static BLECharacteristic *chrLevel, *chrText, *chrVolts, *chrAmps, *chrWatts, *chrAh;
static bool bleConnected = false;

class ConnCallbacks : public BLEServerCallbacks {
  void onConnect(BLEServer *s) override { bleConnected = true; }
  void onDisconnect(BLEServer *s) override {
    bleConnected = false;
    s->startAdvertising();  // otherwise it goes silent after the first client leaves
  }
};

// ------------------------------------------------------------------ SOC ------
// True only when a calibrated chip is actually answering. Everything downstream
// gates on this: a battery monitor with no sensor must report "unknown", never a
// confident number. Publishing 0.0 V on the backbone would be worse than silence
// -- it can trip a low-voltage alarm on a chartplotter.
static bool sensorOk() { return ina228Ok || ina226Ok; }

static float stateOfCharge() {
  float soc = (BANK_CAPACITY_AH - consumedAh) / BANK_CAPACITY_AH * 100.0f;
  return constrain(soc, 0.0f, 100.0f);
}

// Seconds of run time left at the current draw, or N2kDoubleNA while charging.
// PGN 127506 encodes this as two bytes at 60 s resolution, so anything past
// ~45 days is unrepresentable -- and at a 100 mA parasitic draw a 300 Ah bank
// computes to ~125 days. Report NA rather than letting it wrap to a lie.
static const double TIME_REMAINING_MAX_S = 65534.0 * 60.0;

static double timeRemaining() {
  if (amps >= -0.1f) return N2kDoubleNA;
  float remainingAh = BANK_CAPACITY_AH - consumedAh;
  double seconds = (remainingAh / -amps) * 3600.0;
  return (seconds > TIME_REMAINING_MAX_S) ? N2kDoubleNA : seconds;
}

// Coulomb counting drifts, so re-zero it whenever the bank looks genuinely full:
// above FULL_VOLTS and accepting only a trickle, held for FULL_HOLD_MS.
static void syncIfFull() {
  bool looksFull = (busVolts > FULL_VOLTS) && (amps > 0.0f) && (amps < FULL_TAIL_AMPS);
  if (!looksFull) { fullSince = 0; return; }
  if (fullSince == 0) { fullSince = millis(); return; }
  if (millis() - fullSince >= FULL_HOLD_MS && consumedAh != 0.0f) {
    logf("[soc] bank full (%.2f V, %.2f A held %lu s) -- resetting to 100%%",
                  busVolts, amps, FULL_HOLD_MS / 1000UL);
    consumedAh = 0.0f;
    socKnown = true;
    prefs.putFloat("consumedAh", consumedAh);
    prefs.putBool("socKnown", true);
  }
}

// ------------------------------------------------------------- sensors ------
// Naming what answered beats "device at 0x40": these two chips are near-identical
// on the bus and the whole class of address mix-ups is invisible otherwise. The
// die ID registers differ (INA228 0x0228, INA226 0x2260), so ask.
static void scanI2C() {
  logf("[i2c] scanning...");
  for (uint8_t a = 0x08; a < 0x78; a++) {
    Wire.beginTransmission(a);
    if (Wire.endTransmission() != 0) continue;

    INA228 p228(a);
    INA226 p226(a);
    if (p228.getDieID() == 0x0228)      logf("[i2c]   0x%02X  INA228", a);
    else if (p226.getDieID() == 0x2260) logf("[i2c]   0x%02X  INA226", a);
    else                                logf("[i2c]   0x%02X  unrecognised device", a);
  }
}

static void setupSensors() {
  Wire.begin(I2C_SDA_PIN, I2C_SCL_PIN);
  Wire.setClock(400000);
  scanI2C();

  // begin() on both libraries only checks that SOMETHING acknowledges the
  // address -- it never reads the ID register. An INA226 left at its default
  // 0x40 therefore passes as an INA228, gets configured with INA228 registers,
  // and reports confident nonsense. Check the die ID before believing it.
  ina228Ok = ina228.begin() && ina228.getDieID() == 0x0228;
  if (!ina228Ok && ina228.isConnected()) {
    logf("[ina228] WRONG CHIP at 0x%02X: die ID 0x%04X, expected 0x0228",
         INA228_ADDR, ina228.getDieID());
  }
  // The likely failure now is an unstrapped INA228 still sitting on the INA226's
  // address. Say so plainly -- that state is also a bus collision.
  if (!ina228Ok) {
    INA228 stock(INA226_ADDR);
    if (stock.isConnected() && stock.getDieID() == 0x0228)
      logf("[ina228]   an INA228 is answering at 0x%02X -- strap its A0 to VS for 0x%02X",
           INA226_ADDR, INA228_ADDR);
  }
  if (ina228Ok) {
    // ADCRANGE=0 (+/-163.84 mV) keeps the full 500 A in range. CURRENT_LSB works
    // out to 953.7 uA and SHUNT_CAL to exactly 1250 for this shunt.
    ina228.setADCRange(false);
    int rc = ina228.setMaxCurrentShunt(SHUNT_MAX_AMPS, SHUNT_OHMS);
    ina228.setMode(0x0F);   // continuous: shunt + bus + temperature
    ina228.setAverage(3);   // 64 samples -- ~200 ms per cycle, kills alternator hash
    logf("[ina228] ok, cal rc=%d, current LSB %.4f mA",
                  rc, ina228.getCurrentLSB() * 1e3);
    if (rc != 0) { logf("[ina228] CALIBRATION FAILED - readings invalid"); ina228Ok = false; }
  } else if (!ina228.isConnected()) {
    logf("[ina228] NOT FOUND at 0x%02X", INA228_ADDR);
  }

  ina226Ok = ina226.begin() && ina226.getDieID() == 0x2260;
  if (!ina226Ok && ina226.isConnected())
    logf("[ina226] WRONG CHIP at 0x%02X: die ID 0x%04X, expected 0x2260",
         INA226_ADDR, ina226.getDieID());
  if (ina226Ok) {
    // normalize=false is required: the library's LSB normaliser only reaches
    // 5 mA/bit and this shunt needs 15.26 mA/bit, so it would bail out and
    // silently leave the chip uncalibrated (getCurrent() would return 0).
    int rc = ina226.setMaxCurrentShunt(SHUNT_MAX_AMPS, SHUNT_OHMS, false);
    ina226.setAverage(3);
    ina226.setModeShuntBusContinuous();
    logf("[ina226] ok, cal rc=0x%04X, current LSB %.4f mA",
                  rc, ina226.getCurrentLSB_mA());
    if (rc != INA226_ERR_NONE) {
      logf("[ina226] CALIBRATION FAILED - check the -DINA226_MINIMAL_SHUNT_OHM build flag");
      ina226Ok = false;
    }
  } else if (!ina226.isConnected()) {
    logf("[ina226] NOT FOUND at 0x%02X", INA226_ADDR);
  }
}

static void readSensors(float dtSeconds) {
  if (ina228Ok) {
    busVolts = ina228.getBusVoltage();
    amps     = ina228.getCurrent() * CURRENT_SIGN;
    watts    = busVolts * amps;
    dieTempC = ina228.getTemperature();
  } else if (ina226Ok) {
    // Fall back to the INA226 rather than reporting nothing.
    busVolts = ina226.getBusVoltage();
    amps     = ina226.getCurrent() * CURRENT_SIGN;
    watts    = busVolts * amps;
  }

  if (ina226Ok) amps226 = ina226.getCurrent() * CURRENT_SIGN;

  // Integrate in software rather than using the INA228 CHARGE register: the
  // accumulator's reset semantics make the full-charge re-sync awkward, and at
  // this sample rate the integration error is far below the shunt's own tolerance.
  if (ina228Ok || ina226Ok) {
    consumedAh -= (amps * dtSeconds) / 3600.0f;
    consumedAh = constrain(consumedAh, 0.0f, BANK_CAPACITY_AH);
    syncIfFull();
  }
}

// ------------------------------------------------------------- NMEA 2000 ----
static void setupN2K() {
  // A unique-number collision on the bus causes address-claim fights, so derive
  // it from the MAC instead of a constant.
  uint8_t mac[6];
  esp_read_mac(mac, ESP_MAC_WIFI_STA);
  uint32_t unique = ((uint32_t)mac[3] << 16 | (uint32_t)mac[4] << 8 | mac[5]) & 0x1FFFFF;

  NMEA2000.SetProductInformation("BOATBATT-1", 100, "Shunt Battery Monitor",
                                 "1.0.0", "ESP32-S3 INA228/226");
  NMEA2000.SetDeviceInformation(unique,
                                170,   // function: Battery
                                35,    // class: Electrical Generation
                                N2K_MANUFACTURER);

  NMEA2000.SetMode(tNMEA2000::N2km_NodeOnly, N2K_SOURCE_ADDRESS);
  NMEA2000.EnableForward(false);   // no need to echo bus traffic to serial

  static const unsigned long txPGNs[] = { 127506L, 127508L, 127513L, 0 };
  NMEA2000.ExtendTransmitMessages(txPGNs);

  if (!NMEA2000.Open()) logf("[n2k] Open() FAILED - check transceiver wiring");
  else logf("[n2k] open, unique number %lu, source address %d",
                     (unsigned long)unique, N2K_SOURCE_ADDRESS);
}

static void sendN2K() {
  static uint32_t tStatus = 0, tDC = 0, tConf = 0;
  uint32_t now = millis();
  tN2kMsg msg;

  // With no working sensor these carry no information, so say nothing. An absent
  // PGN reads as "no data" to every consumer; a fabricated 0.0 V reads as a flat
  // battery and can raise alarms on other devices on the backbone.
  if (sensorOk() && now - tStatus >= TX_BATTERY_STATUS_MS) {
    tStatus = now;
    // Battery temperature is left NA on purpose: the INA228 die temperature is
    // the chip's own temperature next to the shunt, not the bank's.
    SetN2kDCBatStatus(msg, N2K_BATTERY_INSTANCE, busVolts, amps, N2kDoubleNA, 0xff);
    NMEA2000.SendMsg(msg);
  }

  if (sensorOk() && now - tDC >= TX_DC_STATUS_MS) {
    tDC = now;
    SetN2kDCStatus(msg, 0xff, N2K_BATTERY_INSTANCE, N2kDCt_Battery,
                   socKnown ? (unsigned char)lroundf(stateOfCharge()) : N2kUInt8NA,
                   N2kUInt8NA,                 // state of health: not measured
                   timeRemaining(),
                   N2kDoubleNA,                // ripple voltage: not measured
                   AhToCoulomb(BANK_CAPACITY_AH));
    NMEA2000.SendMsg(msg);
  }

  if (now - tConf >= TX_BAT_CONF_MS) {
    tConf = now;
    SetN2kBatConf(msg, N2K_BATTERY_INSTANCE, N2kDCbt_Flooded, N2kDCES_No,
                  BANK_NOMINAL_VOLTS, BANK_CHEMISTRY, AhToCoulomb(BANK_CAPACITY_AH),
                  0,      // temperature coefficient %/K, unknown
                  1.251,  // Peukert exponent, typical lead-acid default
                  100);   // charge efficiency %
    NMEA2000.SendMsg(msg);
  }

  NMEA2000.ParseMessages();   // must run every loop: address claim lives here
}

// ------------------------------------------------------------------ BLE ------
// Every characteristic gets a 0x2901 User Description. Without it a phone shows
// four anonymous UUIDs and you cannot tell volts from amps -- which makes the
// whole thing useless as a monitor.
static BLECharacteristic *addChr(BLEService *svc, const char *uuid, const char *label) {
  BLECharacteristic *c = svc->createCharacteristic(
      uuid, BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  c->setAccessPermissions(ESP_GATT_PERM_READ_ENCRYPTED);

  BLE2902 *cccd = new BLE2902();
  cccd->setAccessPermissions(ESP_GATT_PERM_READ_ENCRYPTED | ESP_GATT_PERM_WRITE_ENCRYPTED);
  c->addDescriptor(cccd);

  BLE2901 *name = new BLE2901();
  name->setDescription(label);
  name->setAccessPermissions(ESP_GATT_PERM_READ_ENCRYPTED);
  c->addDescriptor(name);
  return c;
}

static void addInfoChr(BLEService *svc, uint16_t uuid, const char *value) {
  BLECharacteristic *c =
      svc->createCharacteristic(BLEUUID(uuid), BLECharacteristic::PROPERTY_READ);
  c->setValue((uint8_t *)value, strlen(value));
}

static void setupBLE() {
  BLEDevice::init(BLE_DEVICE_NAME);

  // Static passkey, display-only capability: the phone prompts and you type the
  // code. Readings are then encrypted, so a neighbour in the marina cannot sit
  // in the anchorage reading your bank state.
  BLESecurity::setPassKey(true, BLE_PASSKEY);
  BLESecurity::setAuthenticationMode(ESP_LE_AUTH_REQ_SC_MITM_BOND);
  BLESecurity::setCapability(ESP_IO_CAP_OUT);
  BLESecurity::setInitEncryptionKey(ESP_BLE_ENC_KEY_MASK | ESP_BLE_ID_KEY_MASK);
  BLESecurity::setRespEncryptionKey(ESP_BLE_ENC_KEY_MASK | ESP_BLE_ID_KEY_MASK);

  BLEServer *server = BLEDevice::createServer();
  server->setCallbacks(new ConnCallbacks());

  BLEService *info = server->createService(BLEUUID(SVC_DEVINFO_UUID));
  addInfoChr(info, CHR_MANUFACTURER, "boat-config");
  addInfoChr(info, CHR_MODEL, "ESP32-S3 INA228/226 shunt monitor");
  addInfoChr(info, CHR_FIRMWARE, "1.0.0");
  info->start();

  BLEService *bas = server->createService(BLEUUID(SVC_BATTERY_UUID));
  chrLevel = bas->createCharacteristic(
      BLEUUID(CHR_BATTERY_LEVEL),
      BLECharacteristic::PROPERTY_READ | BLECharacteristic::PROPERTY_NOTIFY);
  chrLevel->setAccessPermissions(ESP_GATT_PERM_READ_ENCRYPTED);
  BLE2902 *lvlCccd = new BLE2902();
  lvlCccd->setAccessPermissions(ESP_GATT_PERM_READ_ENCRYPTED | ESP_GATT_PERM_WRITE_ENCRYPTED);
  chrLevel->addDescriptor(lvlCccd);
  bas->start();

  // 1 service + 5 characteristics x (value + 2 descriptors) needs 21 handles.
  // The default is 15, which would silently truncate the service.
  BLEService *detail = server->createService(BLEUUID(SVC_DETAIL_UUID), 32);
  chrText  = addChr(detail, CHR_TEXT_UUID,        "Summary");
  chrVolts = addChr(detail, CHR_VOLTS_UUID,       "Voltage (V)");
  chrAmps  = addChr(detail, CHR_AMPS_UUID,        "Current (A, + = charging)");
  chrWatts = addChr(detail, CHR_WATTS_UUID,       "Power (W)");
  chrAh    = addChr(detail, CHR_CONSUMED_AH_UUID, "Consumed since full (Ah)");
  detail->start();

  BLEAdvertising *adv = BLEDevice::getAdvertising();
  adv->addServiceUUID(BLEUUID(SVC_BATTERY_UUID));
  adv->addServiceUUID(SVC_DETAIL_UUID);
  adv->setScanResponse(true);
  BLEDevice::startAdvertising();
  logf("[ble] advertising as \"%s\", passkey %06u", BLE_DEVICE_NAME, (unsigned)BLE_PASSKEY);
}

static void notifyBLE() {
  // The sensor loop runs at 4 Hz, but pushing six characteristics that fast is
  // pointless radio time for a human reading a phone screen.
  static uint32_t last = 0;
  if (millis() - last < BLE_NOTIFY_MS) return;
  last = millis();

  // 0xFF is the conventional "unknown" for Battery Level. It is outside the
  // 0-100 the profile defines, which is the point: an app showing something
  // obviously wrong is far safer than one showing a plausible, invented 100%.
  uint8_t level = (sensorOk() && socKnown) ? (uint8_t)lroundf(stateOfCharge()) : 0xFF;
  chrLevel->setValue(&level, 1);

  char line[96];
  if (!sensorOk()) {
    snprintf(line, sizeof(line), "NO SENSOR - INA228/INA226 not responding on I2C");
  } else if (!socKnown) {
    snprintf(line, sizeof(line), "%.2fV %.2fA %.0fW SOC unknown %.1fAh since boot",
             busVolts, amps, watts, consumedAh);
  } else {
    snprintf(line, sizeof(line), "%.2fV %.2fA %.0fW %u%% %.1fAh used",
             busVolts, amps, watts, level, consumedAh);
  }
  chrText->setValue((uint8_t *)line, strlen(line));

  chrVolts->setValue(busVolts);
  chrAmps->setValue(amps);
  chrWatts->setValue(watts);
  chrAh->setValue(consumedAh);

  if (bleConnected) {
    chrLevel->notify();
    chrText->notify();
    chrVolts->notify();
    chrAmps->notify();
    chrWatts->notify();
    chrAh->notify();
  }
}

// ----------------------------------------------------------------- main ------
void setup() {
  Serial.begin(115200);
  delay(300);
  Serial.println("\n=== boat battery monitor ===");

  prefs.begin("battmon", false);
  consumedAh = prefs.getFloat("consumedAh", 0.0f);
  socKnown   = prefs.getBool("socKnown", false);
  if (socKnown) logf("[soc] restored %.2f Ah consumed (%.0f%%)", consumedAh, stateOfCharge());
  else          logf("[soc] UNKNOWN until the bank is seen full (>%.1f V, <%.1f A held %lu s)",
                     (float)FULL_VOLTS, (float)FULL_TAIL_AMPS, FULL_HOLD_MS / 1000UL);

  setupSensors();
  setupN2K();
  setupBLE();
  netSetup();
}

// Hand the latest readings to the network layer, which only ever reads them.
static void publishState() {
  gReading.volts      = busVolts;
  gReading.amps       = amps;
  gReading.watts      = watts;
  gReading.soc        = stateOfCharge();
  gReading.consumedAh = consumedAh;
  gReading.dieTempC   = dieTempC;
  gReading.amps226    = amps226;
  gReading.ina228Ok   = ina228Ok;
  gReading.ina226Ok   = ina226Ok;
  gReading.socKnown   = socKnown;
}

void loop() {
  static uint32_t lastRead = 0, lastDebug = 0, lastSave = 0;
  uint32_t now = millis();

  if (now - lastRead >= 250) {
    readSensors((now - lastRead) / 1000.0f);
    lastRead = now;
    publishState();
    notifyBLE();
  }

  // NMEA 2000 first: it is the primary path and must not be starved by the
  // network layer if the boat wifi is misbehaving.
  sendN2K();
  netLoop();
  netPublish();

  if (now - lastSave >= SOC_SAVE_MS) {
    lastSave = now;
    prefs.putFloat("consumedAh", consumedAh);
    prefs.putBool("socKnown", socKnown);
  }

  if (now - lastDebug >= DEBUG_PRINT_MS) {
    lastDebug = now;
    Serial.printf("%.3f V  %+.3f A  %+.1f W  %.1f Ah used  %.0f%%  die %.1fC",
                  busVolts, amps, watts, consumedAh, stateOfCharge(), dieTempC);
    if (ina228Ok && ina226Ok) {
      float delta = fabsf(amps - amps226);
      Serial.printf("  | ina226 %+.3f A", amps226);
      if (delta > CROSSCHECK_TOLERANCE_A) Serial.printf("  <-- MISMATCH %.2f A", delta);
    }
    Serial.println();
  }
}
