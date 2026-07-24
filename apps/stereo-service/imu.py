#!/usr/bin/env python3
"""Read the helm's I2C sensors and emit one line per sample: "roll pitch temp htuT hum".

- ADXL345 accelerometer (0x53): gravity vector -> heel (roll) and trim (pitch).
- MCP9808 temperature sensor (0x18): ambient temperature in degrees C.
- HTU31D temp + humidity sensor (0x40): ambient temp (C) and relative humidity (%).

Every sensor is optional and read independently: a missing one emits "nan" for its
field and the others keep working. Only if ALL are missing do we print DEAD and exit.
The Node stereo-service reads this over a pipe (same pattern as bipart.py). Heavy EMA
smoothing on attitude because a boat bounces; the temp/humidity sensors are slow, so
they're sampled ~1 Hz.

Env: IMU_ADDR (0x53), MCP_ADDR (0x18), HTU_ADDR (0x40), IMU_BUS (1), IMU_HZ (10).
"""
import math
import os
import struct
import sys
import time

try:
    import smbus
except ImportError:  # pragma: no cover
    try:
        import smbus2 as smbus
    except ImportError:
        sys.stdout.write("DEAD no-smbus\n"); sys.stdout.flush(); sys.exit(1)

ADDR = int(os.environ.get("IMU_ADDR", "0x53"), 16)
MCP = int(os.environ.get("MCP_ADDR", "0x18"), 16)
# HTU31D can sit at 0x40 or 0x41 (ADDR pad). Try both; the resolved address is stored
# in HTU by init_htu. A TI INA power monitor sharing one of these is skipped.
HTU_CANDS = [int(x, 16) for x in os.environ.get("HTU_ADDR", "0x41,0x40").split(",")]
HTU = None
BUS = int(os.environ.get("IMU_BUS", "1"))
HZ = float(os.environ.get("IMU_HZ", "10"))
A = 0.12  # EMA factor: lower = smoother/slower


def init_adxl(bus):
    if bus.read_byte_data(ADDR, 0x00) != 0xE5:  # DEVID
        raise OSError("wrong-devid")
    bus.write_byte_data(ADDR, 0x2D, 0x08)  # POWER_CTL: measure
    bus.write_byte_data(ADDR, 0x31, 0x08)  # DATA_FORMAT: full-res (+/-2g, 3.9 mg/LSB)


def init_mcp(bus):
    raw = bus.read_word_data(MCP, 0x06)  # manufacturer ID reg, big-endian 0x0054
    if (((raw & 0xFF) << 8) | (raw >> 8)) != 0x0054:
        raise OSError("wrong-manuf")


def read_mcp(bus):
    d = bus.read_i2c_block_data(MCP, 0x05, 2)  # ambient temp: 13-bit, 0.0625 C/LSB
    t = (d[0] & 0x0F) * 16.0 + d[1] / 16.0
    if d[0] & 0x10:
        t -= 256.0
    return t


def _htu_crc(b0, b1):
    # HTU31D CRC-8: poly 0x31, init 0x00, MSB-first, over the two data bytes.
    crc = 0x00
    for byte in (b0, b1):
        crc ^= byte
        for _ in range(8):
            crc = ((crc << 1) ^ 0x31) & 0xFF if (crc & 0x80) else (crc << 1) & 0xFF
    return crc


def _is_ti_ina(bus, a):
    # A TI INA2xx answers its manufacturer-ID register (0x3E) with 0x5449 ('TI').
    try:
        v = bus.read_word_data(a, 0x3E)
        return (((v & 0xFF) << 8) | (v >> 8)) == 0x5449
    except Exception:
        return False


def init_htu(bus):
    # Auto-find the HTU31D among the candidate addresses: skip any that answer as a TI
    # INA power monitor, then confirm with a CRC-checked trial read. Sets global HTU.
    global HTU
    for a in HTU_CANDS:
        if _is_ti_ina(bus, a):
            continue
        try:
            bus.write_byte(a, 0x1E); time.sleep(0.02)   # soft reset
            bus.write_byte(a, 0x40); time.sleep(0.02)   # trial conversion
            d = bus.read_i2c_block_data(a, 0x00, 6)
            if _htu_crc(d[0], d[1]) == d[2] and _htu_crc(d[3], d[4]) == d[5]:
                HTU = a
                return
        except Exception:
            continue
    raise OSError("no-htu")


def htu_trigger(bus):
    bus.write_byte(HTU, 0x40)  # start conversion (default OSR)


def htu_read(bus):
    # Read T+RH: [Tmsb, Tlsb, Tcrc, Hmsb, Hlsb, Hcrc]. Trigger must precede by ~20ms.
    d = bus.read_i2c_block_data(HTU, 0x00, 6)
    # CRC-check both words; a wrong CRC means a bad/colliding read — reject it.
    if _htu_crc(d[0], d[1]) != d[2] or _htu_crc(d[3], d[4]) != d[5]:
        raise ValueError("htu-crc")
    rawT = (d[0] << 8) | d[1]
    rawH = (d[3] << 8) | d[4]
    t = -40.0 + 165.0 * rawT / 65535.0
    rh = 100.0 * rawH / 65535.0
    return t, max(0.0, min(100.0, rh))


def main():
    try:
        bus = smbus.SMBus(BUS)
    except Exception as e:
        sys.stdout.write("DEAD bus %s\n" % e); sys.stdout.flush(); return 1

    have_adxl = have_mcp = have_htu = False
    for fn, name in ((init_adxl, "adxl"), (init_mcp, "mcp"), (init_htu, "htu")):
        try:
            fn(bus)
            if name == "adxl": have_adxl = True
            elif name == "mcp": have_mcp = True
            else: have_htu = True
        except Exception as e:
            sys.stderr.write("%s absent: %s\n" % (name, e))

    if not (have_adxl or have_mcp or have_htu):
        sys.stdout.write("DEAD no-sensors\n"); sys.stdout.flush(); return 1

    sys.stdout.write("READY\n"); sys.stdout.flush()
    rf = pf = None
    tempC = htuC = hum = float("nan")
    period = 1.0 / HZ
    slow = max(1, int(round(HZ)))  # sample the slow temp/RH sensors ~1 Hz
    i = 0
    while True:
        try:
            if have_adxl:
                d = bus.read_i2c_block_data(ADDR, 0x32, 6)
                x, y, z = struct.unpack("<hhh", bytes(d))
                gx, gy, gz = x * 0.0039, y * 0.0039, z * 0.0039
                roll = math.degrees(math.atan2(gy, gz))
                pitch = math.degrees(math.atan2(-gx, math.sqrt(gy * gy + gz * gz)))
                rf = roll if rf is None else rf + A * (roll - rf)
                pf = pitch if pf is None else pf + A * (pitch - pf)
            if i % slow == 0:
                if have_htu:
                    try:
                        htu_trigger(bus)          # conversion; MCP read below covers the wait
                    except Exception as e:
                        sys.stderr.write("htu trigger error: %s\n" % e)
                if have_mcp:
                    try:
                        tempC = read_mcp(bus)
                    except Exception as e:
                        sys.stderr.write("mcp read error: %s\n" % e)
                if have_htu:
                    try:
                        time.sleep(0.02)
                        htuC, hum = htu_read(bus)
                    except Exception as e:
                        sys.stderr.write("htu read error: %s\n" % e)
            i += 1
            f = lambda v: "nan" if (v is None or v != v) else "%.2f" % v
            sys.stdout.write("%s %s %s %s %s\n" % (f(rf), f(pf), f(tempC), f(htuC), f(hum)))
            sys.stdout.flush()
        except Exception as e:
            sys.stderr.write("imu read error: %s\n" % e); sys.stderr.flush()
            time.sleep(0.5)
        time.sleep(period)


if __name__ == "__main__":
    sys.exit(main())
