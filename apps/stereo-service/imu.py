#!/usr/bin/env python3
"""Read an ADXL345 accelerometer (I2C 0x53) and emit smoothed roll/pitch degrees.

Boat use: gravity vector → heel (roll) and trim (pitch). Output is one line per
sample, "roll pitch" in degrees, so the Node stereo-service can read it over a pipe
(same pattern as bipart.py). Heavy EMA smoothing because a boat bounces.

Env: IMU_ADDR (default 0x53), IMU_BUS (default 1), IMU_HZ (default 10).
Prints "READY" once configured; "DEAD <reason>" and exits if the sensor is absent.
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
BUS = int(os.environ.get("IMU_BUS", "1"))
HZ = float(os.environ.get("IMU_HZ", "10"))
A = 0.12  # EMA factor: lower = smoother/slower


def main():
    try:
        bus = smbus.SMBus(BUS)
        if bus.read_byte_data(ADDR, 0x00) != 0xE5:  # DEVID
            sys.stdout.write("DEAD wrong-devid\n"); sys.stdout.flush(); return 1
        bus.write_byte_data(ADDR, 0x2D, 0x08)  # POWER_CTL: measure
        bus.write_byte_data(ADDR, 0x31, 0x08)  # DATA_FORMAT: full-res (±2g, 3.9 mg/LSB)
    except Exception as e:
        sys.stdout.write("DEAD init %s\n" % e); sys.stdout.flush(); return 1

    sys.stdout.write("READY\n"); sys.stdout.flush()
    rf = pf = None
    period = 1.0 / HZ
    while True:
        try:
            d = bus.read_i2c_block_data(ADDR, 0x32, 6)
            x, y, z = struct.unpack("<hhh", bytes(d))
            gx, gy, gz = x * 0.0039, y * 0.0039, z * 0.0039
            roll = math.degrees(math.atan2(gy, gz))
            pitch = math.degrees(math.atan2(-gx, math.sqrt(gy * gy + gz * gz)))
            rf = roll if rf is None else rf + A * (roll - rf)
            pf = pitch if pf is None else pf + A * (pitch - pf)
            sys.stdout.write("%.2f %.2f\n" % (rf, pf))
            sys.stdout.flush()
        except Exception as e:
            sys.stderr.write("imu read error: %s\n" % e); sys.stderr.flush()
            time.sleep(0.5)
        time.sleep(period)


if __name__ == "__main__":
    sys.exit(main())
