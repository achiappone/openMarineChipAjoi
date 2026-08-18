# Battery monitor — ESP32-S3 → NMEA 2000

House-bank voltage, current, and state of charge from a 500 A / 50 mV shunt,
published on the NMEA 2000 backbone and over BLE.

| | |
|---|---|
| MCU | ESP32-S3 (rev v0.2, 16 MB flash, 8 MB PSRAM), native USB-Serial/JTAG |
| Framework | Arduino-ESP32 3.3.11 → ESP-IDF 5.x → FreeRTOS |
| Primary sensor | INA228 (20-bit) @ I2C `0x41` — A0 strapped to VS |
| Cross-check | INA226 (16-bit) @ I2C `0x40` — stock, unmodified |
| Bus | NMEA 2000, 250 kbit/s, via the ESP32 TWAI controller |
| Consumer | Signal K on the Pi, through the PiCAN-M on `can0` |

## The shunt sets everything

500 A / 50 mV means **100 µΩ**. Every calibration constant falls out of that:

| | INA228 | INA226 |
|---|---|---|
| Shunt ADC range | ±163.84 mV (ADCRANGE=0) | ±81.92 mV |
| Max current on this shunt | 1638 A (register-limited to 500 A) | 819 A |
| `CURRENT_LSB` | 500 / 2¹⁹ = **953.7 µA** | 500 / 2¹⁵ = **15.26 mA** |
| Calibration register | `SHUNT_CAL` = 1250 | `CAL` = 3355 |

The INA228 resolves current **16× finer**. That is why it is primary and the
INA226 is only a sanity check — at 15 mA/bit the INA226 cannot see a small
parasitic draw, which is exactly what you want a battery monitor for overnight.

## Two traps in the INA226 library

Both are handled in the code, but they will bite you if you change the setup:

1. **`INA226_MINIMAL_SHUNT_OHM` is 1 mΩ.** A 100 µΩ shunt is rejected outright
   with `INA226_ERR_SHUNT_LOW`. It is an `#ifndef` guard, but it is read inside
   `INA226.cpp`, so a `#define` in the sketch will not reach it — it has to be a
   compiler flag. That is what `-DINA226_MINIMAL_SHUNT_OHM=0.00005` is for.
2. **`setMaxCurrentShunt()` auto-normalise fails at this scale.** It only walks
   the LSB ladder up to 5 mA/bit and this shunt needs 15.26 mA/bit, so it returns
   `INA226_ERR_NORMALIZE_FAILED` *and zeroes the LSB* — `getCurrent()` then
   silently returns 0.0 A forever. Hence `normalize=false`.

The INA228 has neither problem: its minimum is exactly 0.0001 Ω, which this
shunt just clears.

## Wiring

### Shunt

Both chips sit across the same shunt, `IN+` on the battery side and `IN−` on the
load side. They are differential and draw microamps, so paralleling them is fine.

    battery − ──┬── shunt ──┬── boat DC negative bus
                │           │
              IN+         IN−   (both INA228 and INA226)

### I2C

Both chips boot at `0x40`, so exactly one has to move. The INA226 board stays
**stock** and the INA228 is the one strapped: **A0 to VS** puts it at `0x41`.

**Do not power both boards until the INA228 is strapped.** Two chips sharing
`0x40` is a bus collision and the readings mean nothing.

The boot scan reads each device's ID register and names it (`0x40  INA226`)
rather than just listing addresses — neither library's `begin()` verifies what it
is talking to, so an address mix-up is otherwise invisible until the numbers look
wrong.

| Signal | GPIO |
|---|---|
| SDA | 8 |
| SCL | 9 |
| CAN TX | 5 |
| CAN RX | 4 |

GPIO 19/20 are the native USB pins and 26–37 are flash/PSRAM — do not reuse them.

### ⚠ Ground loop — read this before connecting the backbone

This is the one that quietly ruins the measurement. **Every DC return on the boat
is supposed to flow through the shunt.** The NMEA 2000 backbone has its own ground,
which is bonded to battery negative on the *battery* side of the shunt. If the
ESP32 is powered from the *load* side and also grounded through the N2K connector,
its ground wire bridges the shunt — some unknown fraction of the boat's return
current now bypasses the shunt, and every reading is wrong by that amount. In the
worst case that thin ground wire carries real current.

Two ways out:

- **Use an isolated CAN transceiver** (ISO1050, ADM3053, or any module with an
  isolated DC-DC). This is what commercial shunt monitors do — Maretron's DCM100
  N2K side is isolated — and it makes the question go away entirely.
- **Or** power the ESP32 from the N2K bus itself, so its ground and the backbone
  ground are the same point and nothing bridges the shunt. Budget ~1–2 LEN.

A plain SN65HVD230 breakout is *not* isolated. If that is what you have, take the
second option and make sure nothing else grounds the ESP32.

## Build and flash

The `-D` flag is not optional — without it the INA226 never calibrates.

```sh
BOARD="esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=disabled,CDCOnBoot=cdc"
FLAGS="compiler.cpp.extra_flags=-DINA226_MINIMAL_SHUNT_OHM=0.00005"

arduino-cli compile -b "$BOARD" --build-property "$FLAGS" firmware/battery-monitor
arduino-cli upload  -b "$BOARD" -p /dev/cu.usbmodem2112101 firmware/battery-monitor
arduino-cli monitor -p /dev/cu.usbmodem2112101 -c baudrate=115200
```

One-time library setup (they are not all in the Arduino index):

```sh
arduino-cli core install esp32:esp32
arduino-cli lib install INA228 INA226
cd ~/Documents/Arduino/libraries
git clone https://github.com/ttlappalainen/NMEA2000.git
git clone https://github.com/sergei/NMEA2000_esp32_twai.git   # TWAI driver: S3-capable
```

`NMEA2000_esp32` (the commonly-referenced one) is **not** usable here — it drives
the classic ESP32's CAN registers directly. The S3 needs the ESP-IDF TWAI driver,
which is what `NMEA2000_esp32_twai` wraps.

## Calibrate the sign, then the offset

`CURRENT_SIGN` in `config.h` cannot be determined from a desk — it depends on
which way the shunt is wired. Turn on a known load and watch the serial output:
a discharge must read **negative**. If it reads positive, set `CURRENT_SIGN` to
`-1.0f` and reflash. NMEA 2000 and Signal K both take positive as *charging*.

Then set `BANK_CAPACITY_AH` to the real bank size. It only affects state of
charge and time remaining; volts and amps are unaffected.

## Signal K side

`can0` exists at the OS level but Signal K was not reading it — `pipedProviders`
only had the three NMEA 0183 UDP feeds. An `N2K-CAN0` provider has been added to
`pi/home/pi/.signalk/settings.json`; ship it with `./scripts/deploy.sh --apply`.

**Two providers, two paths.** Signal K names N2K battery paths by *instance
number*, so the NMEA 2000 path lands on `electrical.batteries.0.*` — which does
not match the `electrical.batteries.house.*` that
`apps/helm/src/views/Instruments.jsx` reads.

The WiFi path sidesteps this: it sends Signal K deltas directly, so it can name
`electrical.batteries.house.*` itself and the helm picks it up with no changes.
The `BATTMON-SK` provider on UDP 10113 does exactly that.

That leaves both feeds live, which is deliberate — N2K keeps working when the
wifi is down, and chartplotters on the backbone see the bank regardless. If the
duplicate paths ever bother you, either drop the `N2K-CAN0` ingest for this
instance or point the helm at `.0.` and disable the WiFi publish.

## BLE — reading it from a phone

The device is a **BLE peripheral (GATT server)** advertising as `BoatBattery`.
The S3 has BLE only, no Bluetooth Classic, so there is no serial-port profile —
you connect with a BLE app, not a terminal.

**Pairing: passkey `696969`.** BLE passkeys are always six digits and the phone
prompt wants all six — a shorter number would have to be typed with leading
zeros (`6969` becomes `006969`), which some pairing dialogs handle badly. All
readings require an encrypted, bonded connection; only the Device Information
Service is readable before pairing.

### What you can read

| Service | Characteristic | Type | Shown as |
|---|---|---|---|
| `0x180F` Battery | `0x2A19` Battery Level | uint8 | State of charge, 0–100 % — or **255 = unknown** |
| `0xb0a70001…` | `…0002` Summary | UTF-8 string | `13.42V -18.30A -246W 87% 39.1Ah used` |
| | `…0003` Voltage (V) | float32 LE | Bank voltage |
| | `…0004` Current (A, + = charging) | float32 LE | Signed current |
| | `…0006` Power (W) | float32 LE | Signed power |
| | `…0005` Consumed since full (Ah) | float32 LE | Amp-hours out |
| `0x180A` Device Info | `0x2A29`/`0x2A24`/`0x2A26` | strings | Manufacturer, model, firmware |

Every characteristic supports **read and notify**, and carries a `0x2901` User
Description holding the label in the table above — without those a phone shows
four anonymous UUIDs and you cannot tell volts from amps. Notifications push once
a second.

### Pairing

**Do not look in your phone's Bluetooth settings.** A BLE GATT peripheral like
this is not an audio or HID device — iOS does not list it in Settings at all, and
on Android pairing from Settings usually fails. Pairing happens *inside the BLE
app*, triggered by touching an encrypted characteristic.

1. Flash and power the board. Confirm it is advertising — the serial log prints
   `[ble] advertising as "BoatBattery", passkey 696969`.
2. Install **nRF Connect** or **LightBlue** (both platforms).
3. Scan and find `BoatBattery`. Tap **Connect**.
4. Open the Battery service and tap read (↓) or subscribe on **Battery Level** —
   or any characteristic in the `b0a70001…` service.
5. The read fails with *insufficient authentication* and the phone pops a pairing
   prompt. **This is the expected trigger, not an error.**
6. Enter **`696969`**. The bond is stored on both ends; subsequent connections
   are automatic.

Reading the Device Information service alone will *not* trigger pairing — it is
deliberately left unencrypted so the device can identify itself first.

### When the readings are not real

A battery monitor that invents a number is worse than one that admits ignorance,
so nothing is published unless it was measured:

| State | `0x2A19` | Summary string | NMEA 2000 | Signal K |
|---|---|---|---|---|
| No INA responding | `255` | `NO SENSOR - …` | 127508/127506 not sent at all | nothing published |
| Sensors fine, bank never seen full | `255` | `…V …A …W SOC unknown` | SOC = `N2kUInt8NA`, volts/amps normal | SOC path omitted, volts/amps sent |
| Normal | `0`–`100` | full line | all PGNs | all paths |

**`255` is deliberate and will look wrong in your app — that is the point.** The
Battery Service spec defines `0x2A19` as 0–100 with 101–255 *reserved*; there is
no standard "unknown", and 255 is only a de-facto convention. An obviously
impossible `255 %` cannot be mistaken for a healthy bank, whereas the `100 %`
this used to report absolutely could.

The second row matters more than it looks. Coulomb counting has no idea where the
bank actually sits until it witnesses a full charge — wire this to a bank resting
at 60 % and a naive implementation reports 100 % until the next full cycle. The
`socKnown` flag (persisted in NVS) suppresses state of charge until the sync in
`syncIfFull()` has fired at least once. Voltage and current are unaffected
throughout; they are measured directly and always valid.

A Victron BMV behaves the same way — it needs synchronising before its SOC means
anything. The difference is that this one says so.

### Apps

- **iOS:** LightBlue, or nRF Connect for iOS.
- **Android:** nRF Connect, LightBlue, or BLE Scanner.

### When pairing misbehaves

| Symptom | Cause |
|---|---|
| `BoatBattery` never appears in the scan | Android 12+ needs the **Nearby devices** permission; older Android needs **Location** enabled for BLE scanning. Check the serial log shows the advertising line. |
| No pairing prompt appears | You only read Device Info. Touch an encrypted characteristic instead. |
| Pairs, then immediately drops | Bond mismatch — the ESP32 keeps bonds in NVS. Forget `BoatBattery` on the phone and pair again. |
| Reflashed and now it will not pair | Erasing flash wipes the stored bonds; the phone still holds a stale one. Forget the device and re-pair. |
| Stale or missing characteristics on iOS | iOS caches GATT aggressively. Forget the device, or toggle Bluetooth off and on. |
| Changed `BLE_PASSKEY` and pairing fails | Changing the passkey invalidates existing bonds. Forget and re-pair. |

The **Summary** string is the one to read if you just want a number — it is plain
text and needs no decoding. The float32 characteristics are little-endian IEEE-754;
nRF Connect will show raw hex unless you set the display format to float.

### Honest limitations

- **This does not appear in your phone's battery indicator.** The `0x180F`
  service is what the OS uses for *accessories* like headphones; a generic BLE
  peripheral will not show up in the iOS/Android battery widget. You need a BLE
  app to see it.
- **Range is ~10 m** and worse through a hull or a metal locker. This is a
  helm-and-cabin monitor, not a from-the-dock one. Use the wifi `/status` page
  for anything further away.
- **iOS caches GATT services aggressively.** If you change the service layout and
  the phone shows stale characteristics, forget the device in Bluetooth settings
  or toggle Bluetooth off and on.
- Changing `BLE_PASSKEY` after pairing invalidates the bond — forget the device
  on the phone and pair again.

## State of charge

Coulomb counting integrated in software at 4 Hz, persisted to NVS every 60 s so a
reboot does not lose it. It re-syncs to 100% whenever the bank holds above
`FULL_VOLTS` while accepting less than `FULL_TAIL_AMPS` for `FULL_HOLD_MS` — the
defaults are lead-acid numbers, so an LFP bank wants roughly 13.6 V and a smaller
tail.

## Remote monitoring and logging

The ESP32 runs **FreeRTOS** (via ESP-IDF 5.x under the Arduino core) — that is not
a choice so much as a fact of the platform. It does not limit remote access; the
network layer lives in `net.cpp`, deliberately separate so a wifi fault can never
block a sensor read or an NMEA 2000 transmit.

### Why not ESPHome

ESPHome would give logging, OTA, and dashboards for free in YAML, and it does
support these chips (`ina2xx_i2c` covers the INA228). But its `canbus` component
handles **raw CAN frames only** — no NMEA 2000 address claim, no PGN encoding, no
fast-packet assembly. Getting N2K back would mean reimplementing the whole stack
inside ESPHome. Not worth it when `NMEA2000` already does it.

### On the device

| Endpoint | What it gives you |
|---|---|
| `http://battmon.local/` | Auto-refreshing dashboard: volts, amps, watts, SOC, Ah |
| `http://battmon.local/status` | JSON — the above plus uptime, boot count, reset reason, RSSI, free heap, deltas sent, wifi drops |
| `http://battmon.local/logs` | Last 40 log lines: boot, I2C scan results, calibration, address claim, wifi drops, SOC re-syncs |
| ArduinoOTA on `battmon` | Remote reflash, no USB cable |

The log ring is in RAM and is **not** persisted — flash wear on a device that runs
continuously is not worth it. The boot counter and `esp_reset_reason()` on
`/status` are what answer "did it crash while I was away", and they survive resets
in NVS.

### Getting data off the device

Deltas go out as **UDP JSON on port 10113**, not WebSocket. Fire-and-forget UDP
has no framing, no handshake, and no reconnect state machine to get wrong on an
MCU, and it matches the three NMEA 0183 UDP providers already in `settings.json`.

The Pi is a DHCP client so its address moves — the firmware resolves
`openplotter.local` over mDNS and re-resolves whenever a send fails.

Signal K units are strict SI and are easy to get subtly wrong: state of charge is
a **0–1 ratio, not a percentage**, discharge is in **coulombs**, and temperature
is in **kelvin**. `buildDelta()` does the conversions.

### History: InfluxDB + Grafana

The Pi is the logger, not the ESP32. Logging to ESP32 flash would wear it out and
strand the history behind a device you have to walk to.

Staged in this repo, but **not yet installed or verified** (the Pi was offline):

- `signalk-to-influxdb2` added to `pi/home/pi/.signalk/package.json`
- `pi/etc/grafana/provisioning/datasources/influxdb.yml` — datasource, uid `signalk`
- `pi/etc/grafana/provisioning/dashboards/house-battery.json` — 6 panels
  (SOC gauge, voltage, signed current, power, consumed Ah, temperature)

Still to do on the Pi:

```sh
sudo apt install -y influxdb2 grafana
sudo systemctl enable --now influxdb grafana-server
influx setup --org boat --bucket signalk --username pi   # then create an API token
```

Put the token in the Signal K plugin config *and* in the Grafana datasource
(replace `$INFLUX_TOKEN` — do not commit a real one). Then configure
`signalk-to-influxdb2` in the Signal K admin UI to write the
`electrical.batteries.house.*` paths to the `signalk` bucket.

### Power cost

WiFi and BLE share one radio on the S3. Coexistence works, but both active adds
latency and draw. `WiFi.setSleep(true)` enables modem sleep, which brings an
always-on ESP32-S3 down to roughly 40–60 mA average instead of 80–120 mA — call
it 1 Ah/day. Mildly ironic on a battery monitor, so it is worth knowing before
you leave it on a bank over the winter. If you want it lower, drop the BLE
advertising to on-demand.
