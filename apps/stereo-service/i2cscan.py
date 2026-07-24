#!/usr/bin/env python3
"""Scan I2C bus 1 and identify known helm sensors. Prints JSON: {"devices":[...]}.

Identification is by each chip's signature register(s) so we can tell apart devices
that share the default 0x40 address (HTU31D vs INA228/INA226). Used by the stereo
service's /api/i2c endpoint to show sensor status on the helm settings screen.
"""
import json
import sys

try:
    import smbus2 as smbus
except ImportError:
    try:
        import smbus
    except ImportError:
        print(json.dumps({"error": "no-smbus", "devices": []})); sys.exit(0)


def rd16(b, a, r):
    v = b.read_word_data(a, r)
    return ((v & 0xFF) << 8) | (v >> 8)  # INA/TI regs are big-endian


def identify(b, a):
    # Returns (name, role, extra). Order matters: check strong signatures first.
    try:
        if a == 0x18 and rd16(b, a, 0x06) == 0x0054:
            return "MCP9808", "ambient temp", ""
    except Exception:
        pass
    try:
        if a == 0x53 and b.read_byte_data(a, 0x00) == 0xE5:
            return "ADXL345", "tilt (heel/trim)", ""
    except Exception:
        pass
    try:  # INA228: manufacturer ID at 0x3E == 0x5449 ('TI'), device ID at 0x3F
        if rd16(b, a, 0x3E) == 0x5449:
            d = rd16(b, a, 0x3F)
            return "INA228", "power monitor", "id 0x%04x" % d
    except Exception:
        pass
    try:  # INA226: manufacturer ID at 0xFE == 0x5449, die ID at 0xFF top12 == 0x226
        if rd16(b, a, 0xFE) == 0x5449:
            d = rd16(b, a, 0xFF)
            if (d >> 4) == 0x226:
                return "INA226", "power monitor", "die 0x%04x" % d
    except Exception:
        pass
    if a in (0x40, 0x41):  # a non-TI device here is almost certainly the HTU31D
        return "HTU31D", "temp + humidity", ""
    return "unknown", "", ""


def main():
    try:
        b = smbus.SMBus(1)
    except Exception as e:
        print(json.dumps({"error": str(e), "devices": []})); return
    devices = []
    for a in range(0x03, 0x78):
        try:
            b.read_byte(a)
        except Exception:
            continue
        name, role, extra = identify(b, a)
        devices.append({"addr": "0x%02x" % a, "name": name, "role": role, "extra": extra})
    print(json.dumps({"devices": devices}))


if __name__ == "__main__":
    main()
