#include <WiFi.h>
#include <WiFiUdp.h>
#include <ESPmDNS.h>
#include <ArduinoOTA.h>
#include <WebServer.h>
#include <Preferences.h>
#include <esp_system.h>
#include <stdarg.h>

#include "net.h"
#include "config.h"
#include "secrets.h"

BattReading gReading;

static WiFiUDP   udp;
static WebServer server(80);
static IPAddress skHost;
static bool      skHostKnown = false;
static uint32_t  bootCount   = 0;
static uint32_t  deltasSent  = 0;
static uint32_t  wifiDrops   = 0;

// ------------------------------------------------------------- log ring ------
// Fixed slots, overwritten oldest-first. Deliberately not persisted: flash wear
// on a device that runs continuously is not worth the few lines it would save,
// and the boot counter below already answers "did it reset while I was away".
static const int  LOG_LINES = 40;
static const int  LOG_WIDTH = 120;
static char       logRing[LOG_LINES][LOG_WIDTH];
static int        logHead  = 0;
static uint32_t   logCount = 0;

void logf(const char *fmt, ...) {
  char body[LOG_WIDTH - 16];
  va_list ap;
  va_start(ap, fmt);
  vsnprintf(body, sizeof(body), fmt, ap);
  va_end(ap);

  uint32_t s = millis() / 1000;
  snprintf(logRing[logHead], LOG_WIDTH, "[%02lu:%02lu:%02lu] %s",
           (unsigned long)(s / 3600), (unsigned long)((s / 60) % 60),
           (unsigned long)(s % 60), body);
  Serial.println(logRing[logHead]);
  logHead = (logHead + 1) % LOG_LINES;
  logCount++;
}

static const char *resetReasonText() {
  switch (esp_reset_reason()) {
    case ESP_RST_POWERON:  return "power-on";
    case ESP_RST_SW:       return "software";
    case ESP_RST_PANIC:    return "PANIC/exception";
    case ESP_RST_INT_WDT:  return "interrupt watchdog";
    case ESP_RST_TASK_WDT: return "task watchdog";
    case ESP_RST_WDT:      return "other watchdog";
    case ESP_RST_BROWNOUT: return "BROWNOUT";
    case ESP_RST_DEEPSLEEP:return "deep sleep wake";
    // The rest matter on a boat: a power glitch or brownout points at the 12 V
    // supply, not the firmware, and USB/JTAG just means someone had it on a bench.
    case ESP_RST_PWR_GLITCH: return "POWER GLITCH";
    case ESP_RST_CPU_LOCKUP: return "CPU LOCKUP (double exception)";
    case ESP_RST_USB:      return "USB peripheral";
    case ESP_RST_JTAG:     return "JTAG";
    case ESP_RST_SDIO:     return "SDIO";
    case ESP_RST_EFUSE:    return "efuse error";
    default:               return "unknown";
  }
}

// ------------------------------------------------------------ SignalK --------
// The Pi is a DHCP client so its address moves; resolve by name and re-resolve
// whenever a send finds no host. This is why the README says reach it by name.
static void resolveSignalKHost() {
  IPAddress ip = MDNS.queryHost(SIGNALK_HOST, 3000);
  if (ip != IPAddress((uint32_t)0)) {
    skHost = ip;
    skHostKnown = true;
    logf("[sk] %s resolved to %s", SIGNALK_HOST, skHost.toString().c_str());
  } else {
    skHostKnown = false;
    logf("[sk] could not resolve %s.local", SIGNALK_HOST);
  }
}

// Signal K units are strict SI: volts, amps, watts, coulombs, and state of
// charge as a 0..1 ratio rather than a percentage. Getting this wrong shows up
// as a gauge pinned at 100 rather than an obvious error, so it is worth care.
static void buildDelta(char *out, size_t len) {
  float socRatio    = gReading.soc / 100.0f;
  float dischargedC = gReading.consumedAh * 3600.0f;

  // State of charge is omitted rather than guessed until a full charge has been
  // observed. Signal K treats an absent path as "no data", which is the truth;
  // sending 1.0 would put a full battery on the helm display that is not real.
  char socPart[128] = "";
  if (gReading.socKnown) {
    snprintf(socPart, sizeof(socPart),
      "{\"path\":\"electrical.batteries.house.capacity.stateOfCharge\",\"value\":%.4f},"
      "{\"path\":\"electrical.batteries.house.capacity.dischargeSinceFull\",\"value\":%.0f},",
      socRatio, dischargedC);
  }

  snprintf(out, len,
    "{\"updates\":[{\"$source\":\"%s\",\"values\":["
      "{\"path\":\"electrical.batteries.house.voltage\",\"value\":%.3f},"
      "{\"path\":\"electrical.batteries.house.current\",\"value\":%.3f},"
      "{\"path\":\"electrical.batteries.house.power\",\"value\":%.1f},"
      "%s"
      "{\"path\":\"electrical.batteries.house.temperature\",\"value\":%.2f}"
    "]}]}",
    SIGNALK_SOURCE, gReading.volts, gReading.amps, gReading.watts,
    socPart, gReading.dieTempC + 273.15f);
}

void netPublish() {
  static uint32_t last = 0;
  if (!netOnline()) return;
  // Nothing measured, nothing to say.
  if (!gReading.ina228Ok && !gReading.ina226Ok) return;
  if (millis() - last < SIGNALK_PUBLISH_MS) return;
  last = millis();

  if (!skHostKnown) { resolveSignalKHost(); if (!skHostKnown) return; }

  char delta[640];
  buildDelta(delta, sizeof(delta));

  if (udp.beginPacket(skHost, SIGNALK_UDP_PORT) != 1) {
    skHostKnown = false;   // force a re-resolve on the next pass
    return;
  }
  udp.write((const uint8_t *)delta, strlen(delta));
  if (udp.endPacket() == 1) deltasSent++;
}

// ----------------------------------------------------------- web server ------
static String htmlEscape(const char *s) {
  String o;
  for (const char *p = s; *p; p++) {
    if (*p == '<') o += "&lt;"; else if (*p == '>') o += "&gt;";
    else if (*p == '&') o += "&amp;"; else o += *p;
  }
  return o;
}

static void handleStatusJson() {
  char buf[768];
  snprintf(buf, sizeof(buf),
    "{\"volts\":%.3f,\"amps\":%.3f,\"watts\":%.1f,\"soc\":%.1f,"
    "\"consumedAh\":%.2f,\"dieTempC\":%.1f,\"amps226\":%.3f,"
    "\"ina228\":%s,\"ina226\":%s,\"socKnown\":%s,"
    "\"uptimeSec\":%lu,\"bootCount\":%lu,\"resetReason\":\"%s\","
    "\"rssi\":%d,\"ip\":\"%s\",\"deltasSent\":%lu,\"wifiDrops\":%lu,"
    "\"signalkHost\":\"%s\",\"heapFree\":%lu}",
    gReading.volts, gReading.amps, gReading.watts, gReading.soc,
    gReading.consumedAh, gReading.dieTempC, gReading.amps226,
    gReading.ina228Ok ? "true" : "false", gReading.ina226Ok ? "true" : "false",
    gReading.socKnown ? "true" : "false",
    (unsigned long)(millis() / 1000), (unsigned long)bootCount, resetReasonText(),
    WiFi.RSSI(), WiFi.localIP().toString().c_str(),
    (unsigned long)deltasSent, (unsigned long)wifiDrops,
    skHostKnown ? skHost.toString().c_str() : "unresolved",
    (unsigned long)ESP.getFreeHeap());
  server.send(200, "application/json", buf);
}

static void handleLogs() {
  String out;
  out.reserve(LOG_LINES * LOG_WIDTH);
  int start = (logCount > (uint32_t)LOG_LINES) ? logHead : 0;
  int n     = (logCount > (uint32_t)LOG_LINES) ? LOG_LINES : (int)logCount;
  for (int i = 0; i < n; i++) {
    out += logRing[(start + i) % LOG_LINES];
    out += '\n';
  }
  server.send(200, "text/plain", out);
}

static void handleRoot() {
  char socText[16];
  if (!gReading.ina228Ok && !gReading.ina226Ok) snprintf(socText, sizeof(socText), "--");
  else if (!gReading.socKnown)                  snprintf(socText, sizeof(socText), "unknown");
  else snprintf(socText, sizeof(socText), "%.0f %%", gReading.soc);

  char buf[1400];
  snprintf(buf, sizeof(buf),
    "<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width,initial-scale=1'>"
    "<title>Battery Monitor</title>"
    "<style>body{font:16px/1.5 system-ui;margin:0;padding:1.5rem;background:#111;color:#eee}"
    "h1{font-size:1.1rem;color:#8ab4f8;margin:0 0 1rem}"
    "b{display:block;font-size:2.2rem;font-variant-numeric:tabular-nums}"
    "div{background:#1c1c1c;border-radius:8px;padding:.8rem 1rem;margin:.5rem 0}"
    "s{color:#888;text-decoration:none;font-size:.8rem;text-transform:uppercase;letter-spacing:.05em}"
    "a{color:#8ab4f8}</style>"
    "<h1>House bank &middot; %s</h1>"
    "<div><s>Voltage</s><b>%.2f V</b></div>"
    "<div><s>Current</s><b>%+.2f A</b></div>"
    "<div><s>Power</s><b>%+.0f W</b></div>"
    "<div><s>State of charge</s><b>%s</b></div>"
    "<div><s>Consumed</s><b>%.1f Ah</b></div>"
    "<p><a href=/status>/status</a> &middot; <a href=/logs>/logs</a><br>"
    "<s>up %lus &middot; boot #%lu &middot; last reset: %s &middot; rssi %d dBm</s>"
    "<meta http-equiv=refresh content=5>",
    gReading.ina228Ok ? "INA228" : (gReading.ina226Ok ? "INA226 (fallback)" : "NO SENSOR"),
    gReading.volts, gReading.amps, gReading.watts, socText, gReading.consumedAh,
    (unsigned long)(millis() / 1000), (unsigned long)bootCount, resetReasonText(), WiFi.RSSI());
  server.send(200, "text/html", buf);
}

// ---------------------------------------------------------------- setup ------
bool netOnline() { return WiFi.status() == WL_CONNECTED; }

void netSetup() {
  Preferences p;
  p.begin("battmon", false);
  bootCount = p.getUInt("boots", 0) + 1;
  p.putUInt("boots", bootCount);
  p.end();
  logf("[boot] #%lu, last reset: %s", (unsigned long)bootCount, resetReasonText());

  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);
  WiFi.setSleep(true);   // modem sleep: the radio idles between beacons
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  logf("[wifi] connecting to %s", WIFI_SSID);

  // Do not block forever here -- the shunt still needs reading if the boat wifi
  // is down, and NMEA 2000 does not care about the network at all.
  uint32_t t0 = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - t0 < WIFI_CONNECT_TIMEOUT_MS) delay(200);

  if (netOnline()) {
    logf("[wifi] connected, ip %s, rssi %d dBm",
         WiFi.localIP().toString().c_str(), WiFi.RSSI());
    MDNS.begin(OTA_HOSTNAME);
    MDNS.addService("http", "tcp", 80);
    resolveSignalKHost();
  } else {
    logf("[wifi] TIMEOUT after %lu ms -- continuing offline", WIFI_CONNECT_TIMEOUT_MS);
  }

  ArduinoOTA.setHostname(OTA_HOSTNAME);
  ArduinoOTA.setPassword(OTA_PASSWORD);
  ArduinoOTA.onStart([]() { logf("[ota] update starting"); });
  ArduinoOTA.onEnd([]()   { logf("[ota] update done, rebooting"); });
  ArduinoOTA.onError([](ota_error_t e) { logf("[ota] ERROR %u", e); });
  ArduinoOTA.begin();

  server.on("/", handleRoot);
  server.on("/status", handleStatusJson);
  server.on("/logs", handleLogs);
  server.begin();
  logf("[http] serving on http://%s.local/", OTA_HOSTNAME);
}

void netLoop() {
  static uint32_t lastCheck = 0;
  static bool wasOnline = false;

  ArduinoOTA.handle();
  server.handleClient();

  if (millis() - lastCheck >= 10000) {
    lastCheck = millis();
    bool now = netOnline();
    if (wasOnline && !now) { wifiDrops++; logf("[wifi] connection lost"); skHostKnown = false; }
    if (!wasOnline && now) { logf("[wifi] reconnected, ip %s", WiFi.localIP().toString().c_str()); resolveSignalKHost(); }
    wasOnline = now;
  }
}
