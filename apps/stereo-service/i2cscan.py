#!/usr/bin/env python3
"""Scan I2C bus 1 and identify known helm sensors. Prints JSON: {"devices":[...]}.

Identification is by each chip's signature register(s) so we can tell apart devices
that share the default 0x40 address (HTU31D vs INA228/INA226). Used by the stereo
service's /api/i2c endpoint to show sensor status on the helm settings screen.
"""
import json
import sys
import time

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


def _sht_crc(b0, b1):
    # SHT4x CRC-8: poly 0x31, init 0xFF, MSB-first (note: init differs from the HTU31D).
    crc = 0xFF
    for byte in (b0, b1):
        crc ^= byte
        for _ in range(8):
            crc = ((crc << 1) ^ 0x31) & 0xFF if (crc & 0x80) else (crc << 1) & 0xFF
    return crc


def present(b, a):
    # Two probes, because no single one finds every part: most chips answer a bare read,
    # but the SHT4x NACKs one (it only talks after a command) and needs the zero-length
    # write that i2cdetect uses. Read first so we don't poke devices that don't need it.
    try:
        b.read_byte(a)
        return True
    except Exception:
        pass
    try:
        b.write_quick(a)
        return True
    except Exception:
        return False


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
    try:  # ICM20948: WHO_AM_I (bank 0 reg 0x00) == 0xEA. AD0 picks 0x68 or 0x69.
        if a in (0x68, 0x69) and b.read_byte_data(a, 0x00) == 0xEA:
            return "ICM20948", "tilt (heel/trim)", "9-DoF"
    except Exception:
        pass
    try:  # SHT4x: no ID register, so confirm with a CRC-checked serial-number read.
        if a in (0x44, 0x45):
            b.i2c_rdwr(smbus.i2c_msg.write(a, [0x89]))
            time.sleep(0.02)
            m = smbus.i2c_msg.read(a, 6)
            b.i2c_rdwr(m)
            d = list(m)
            if _sht_crc(d[0], d[1]) == d[2] and _sht_crc(d[3], d[4]) == d[5]:
                return "SHT41", "temp + humidity", "sn 0x%02x%02x%02x%02x" % (d[0], d[1], d[3], d[4])
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
    try:  # MCP23017 GPIO expander: A2A1A0 select 0x20-0x27. IOCON's unimplemented bit 0
        # always reads 0, and both IODIR ports read 0xFF from reset — enough with the
        # address range to name it without writing anything.
        if 0x20 <= a <= 0x27 and b.read_byte_data(a, 0x00) is not None:
            io = b.read_byte_data(a, 0x0A)
            if not (io & 0x01):
                return "MCP23017", "16-bit GPIO expander", "A%d%d%d" % ((a >> 2) & 1, (a >> 1) & 1, a & 1)
    except Exception:
        pass
    try:  # AK09916 magnetometer inside the ICM20948, visible at 0x0C once bypass is on.
        if a == 0x0C and b.read_byte_data(a, 0x01) == 0x09:  # WIA2 == 0x09
            return "AK09916", "magnetometer (in ICM20948)", "heading"
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
        if not present(b, a):
            continue
        name, role, extra = identify(b, a)
        devices.append({"addr": "0x%02x" % a, "name": name, "role": role, "extra": extra})
    print(json.dumps({"devices": devices}))


if __name__ == "__main__":
    main()
