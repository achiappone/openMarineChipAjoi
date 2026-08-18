// WiFi, mDNS, SignalK delta publishing, OTA, the diagnostics web server, and the
// in-memory log ring. Kept apart from the sketch so the measurement path stays
// readable -- and so a network fault can never block a sensor read.
#pragma once

#include <Arduino.h>

// Latest readings, written by the sketch and read by the network layer. Single
// core writes it and the web handlers only read, so no locking is needed.
struct BattReading {
  float volts      = 0.0f;
  float amps       = 0.0f;   // + = charging
  float watts      = 0.0f;
  float soc        = 0.0f;   // percent
  float consumedAh = 0.0f;
  float dieTempC   = 0.0f;
  float amps226    = 0.0f;
  bool  ina228Ok   = false;
  bool  ina226Ok   = false;
  bool  socKnown   = false;   // has a full charge ever been observed?
};

extern BattReading gReading;

// Timestamped line into the ring buffer AND out to Serial. Same signature as
// printf. Use it for anything you would want to read back after walking away.
void logf(const char *fmt, ...);

void netSetup();
void netLoop();     // call every loop: services OTA, the web server, and reconnects
void netPublish();  // send one SignalK delta from gReading; rate-limited internally

bool netOnline();
