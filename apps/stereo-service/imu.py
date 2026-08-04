#!/usr/bin/env python3
"""Read the helm's I2C sensors, one line per sample:
"roll pitch temp htuT hum shtT shtH hdg src ioA ioB".

- ICM20948 9-DoF IMU (0x69/0x68): gravity vector -> heel (roll) and trim (pitch).
- AK09916 magnetometer (inside the ICM20948, reached at 0x0C once bypass is on):
  tilt-compensated magnetic heading, also pushed to SignalK as an NMEA $HCHDM
  sentence over UDP so navigation.headingMagnetic gets a real source.
- ADXL345 accelerometer (0x53): same, used only as a fallback when no ICM20948.
- MCP9808 temperature sensor (0x18): ambient temperature in degrees C.
- HTU31D temp + humidity sensor (0x40): ambient temp (C) and relative humidity (%).
- SHT41 temp + humidity sensor (0x44): same, and the tightest-tolerance of the three.

Attitude comes from whichever accelerometer is present, ICM20948 first — it's the
better part (lower noise, and it carries a gyro + magnetometer we can use later).
The trailing "src" field names the sensor actually driving attitude ("icm"/"adxl"/
"none") so the helm can show which one is live.

Every sensor is optional and read independently: a missing one emits "nan" for its
field and the others keep working. Only if ALL are missing do we print DEAD and exit.
The Node stereo-service reads this over a pipe (same pattern as bipart.py). Heavy EMA
smoothing on attitude because a boat bounces; the temp/humidity sensors are slow, so
they're sampled ~1 Hz.

Heading needs a one-time calibration to be worth anything:
    python3 imu.py --calibrate-mag [--seconds=90]
Rotate the sensor through as many orientations as you can while it runs; it writes
magcal.json next to this script. Without that file heading still emits, but the
hard-iron offset from nearby steel and wiring can put it tens of degrees off.

Env: ICM_ADDR (0x69,0x68), IMU_ADDR (0x53), MCP_ADDR (0x18), HTU_ADDR (0x40),
SHT_ADDR (0x44,0x45), IMU_BUS (1), IMU_HZ (10), MAG_CAL (magcal.json),
MAG_UDP (10111), MAG_NMEA (1), MAG_DEV (0 deg offset), MAG_REVERSE (0).
"""
import json
import math
import os
import socket
import struct
import sys
import time

# smbus2 first: the SHT41 needs raw i2c_rdwr transfers (it takes a bare command byte
# and a bare read, with no register in between), which python-smbus can't express.
# The other sensors work identically under either module.
try:
    import smbus2 as smbus
except ImportError:  # pragma: no cover
    try:
        import smbus
    except ImportError:
        sys.stdout.write("DEAD no-smbus\n"); sys.stdout.flush(); sys.exit(1)

ADDR = int(os.environ.get("IMU_ADDR", "0x53"), 16)
MCP = int(os.environ.get("MCP_ADDR", "0x18"), 16)
# HTU31D can sit at 0x40 or 0x41 (ADDR pad). Try both; the resolved address is stored
# in HTU by init_htu. A TI INA power monitor sharing one of these is skipped.
HTU_CANDS = [int(x, 16) for x in os.environ.get("HTU_ADDR", "0x41,0x40").split(",")]
HTU = None
# ICM20948 sits at 0x69 or 0x68 depending on the board's AD0 pull. Ours is 0x69, but
# probe both; the resolved address is stored in ICM by init_icm.
ICM_CANDS = [int(x, 16) for x in os.environ.get("ICM_ADDR", "0x69,0x68").split(",")]
ICM = None
# SHT41 sits at 0x44 (or 0x45 on the -B variant). Resolved address stored in SHT.
IO = int(os.environ.get("IO_ADDR", "0x20"), 16)  # MCP23017 GPIO expander
# Below this much gravity in the Y/Z plane (i.e. past ~81 deg of pitch) roll is degenerate.
# 0.15 g keeps a healthy margin over the ~0.002 g noise floor measured on this part.
ROLL_MIN_HORIZ = float(os.environ.get("IMU_ROLL_MIN_HORIZ", "0.15"))
# Mounting calibration, written by the helm (Sensors -> ICM20948 -> Calibrate) and read
# here at startup. Runtime state, not repo content — same caveat as magcal.json.
#   upAxis      which accelerometer axis points up/down as mounted. The chip on this
#               board is rotated 90 deg from the usual convention: lying flat, gravity
#               lands on X, not Z (measured 2026-08-03: X=+1.003 Y=+0.004 Z=-0.017).
#   rollOffset  attitude with the boat at rest, subtracted so the gauge reads real heel
#   pitchOffset and trim rather than however the bracket happens to sit.
IMU_CONFIG = os.environ.get("IMU_CONFIG", os.path.join(os.path.dirname(os.path.abspath(__file__)), "imuconfig.json"))


def load_imu_config():
    cfg = {"upAxis": os.environ.get("IMU_UP_AXIS", "X").upper(), "rollOffset": 0.0,
           "pitchOffset": 0.0, "frame": None}
    try:
        with open(IMU_CONFIG) as fh:
            d = json.load(fh)
        if str(d.get("upAxis", "")).upper() in ("X", "Y", "Z"):
            cfg["upAxis"] = d["upAxis"].upper()
        cfg["rollOffset"] = float(d.get("rollOffset", 0.0))
        cfg["pitchOffset"] = float(d.get("pitchOffset", 0.0))
        fr = d.get("frame")
        if fr and all(k in fr and len(fr[k]) == 3 for k in ("up", "fore", "stbd")):
            cfg["frame"] = {k: [float(x) for x in fr[k]] for k in ("up", "fore", "stbd")}
    except Exception:
        pass
    return cfg


CFG = load_imu_config()
UP_AXIS = CFG["upAxis"]
ROLL_OFF, PITCH_OFF = CFG["rollOffset"], CFG["pitchOffset"]
FRAME = CFG["frame"]
_cfg_mtime = None


def ema_angle(prev, new, a):
    """Exponential smoothing along the shortest arc. A plain EMA across the +/-180 wrap
    walks the long way round and lands somewhere impossible — that is where a roll of
    342 deg comes from. Same treatment the heading filter already uses."""
    if prev is None:
        return new
    d = ((new - prev + 180.0) % 360.0) - 180.0
    v = prev + a * d
    return ((v + 180.0) % 360.0) - 180.0


def attitude_from_frame(g, frame):
    """Heel and trim from a taught frame. The measured vector points at the sky, so its
    component along 'fore' is negative when the bow is up — hence the minus signs.
    asin (rather than atan2) keeps this well-behaved at any mounting angle: there is no
    axis pair that can both approach zero, so no gimbal lock to guard against."""
    n = math.sqrt(g[0] * g[0] + g[1] * g[1] + g[2] * g[2]) or 1.0
    m = (g[0] / n, g[1] / n, g[2] / n)
    dot = lambda a, b: a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
    clamp = lambda v: max(-1.0, min(1.0, v))
    pitch = math.degrees(math.asin(clamp(-dot(m, frame["fore"]))))   # bow up positive
    roll = math.degrees(math.asin(clamp(-dot(m, frame["stbd"]))))    # starboard down positive
    return roll, pitch


def reload_imu_config():
    """Pick up calibration changes while running, so the helm can adjust the mounting
    axis or re-zero the gauge with the boat in the water and watch it take effect —
    no restart, no dropped attitude, nothing to remember to do afterwards."""
    global UP_AXIS, ROLL_OFF, PITCH_OFF, FRAME, _cfg_mtime
    try:
        m = os.path.getmtime(IMU_CONFIG)
    except OSError:
        return
    if m == _cfg_mtime:
        return
    _cfg_mtime = m
    c = load_imu_config()
    if (c["upAxis"], c["rollOffset"], c["pitchOffset"]) != (UP_AXIS, ROLL_OFF, PITCH_OFF):
        sys.stderr.write("imu config: up=%s roll_off=%.2f pitch_off=%.2f\n"
                         % (c["upAxis"], c["rollOffset"], c["pitchOffset"]))
    changed = (c["upAxis"], c["frame"]) != (UP_AXIS, FRAME)
    UP_AXIS, ROLL_OFF, PITCH_OFF, FRAME = c["upAxis"], c["rollOffset"], c["pitchOffset"], c["frame"]
    # A new frame means the old smoothed value is meaningless. Without this the EMA
    # slides from the old orientation to the new one over several seconds, and a
    # calibration captured during that slide reads as "the boat is moving".
    return changed


def orient(gx, gy, gz):
    """Reorder the gravity vector so the first component is the vertical axis, which is
    what the roll/pitch formulas below assume."""
    if UP_AXIS == "X":
        return gy, gz, gx
    if UP_AXIS == "Y":
        return gz, gx, gy
    return gx, gy, gz
SHT_CANDS = [int(x, 16) for x in os.environ.get("SHT_ADDR", "0x44,0x45").split(",")]
SHT = None
# AK09916 magnetometer inside the ICM20948. It hangs off the ICM's auxiliary I2C bus
# and is invisible to the Pi until init_mag turns on the ICM's bypass mode, which
# bridges it onto the main bus at this fixed address.
AK = 0x0C
_HERE = os.path.dirname(os.path.abspath(__file__))
MAG_CAL_PATH = os.environ.get("MAG_CAL", os.path.join(_HERE, "magcal.json"))
MAG_UDP = ("127.0.0.1", int(os.environ.get("MAG_UDP", "10111")))  # SignalK NMEA0183 in
MAG_NMEA = os.environ.get("MAG_NMEA", "1") != "0"   # emit $HCHDM to SignalK
MAG_DEV = float(os.environ.get("MAG_DEV", "0"))     # constant offset added, degrees
MAG_REVERSE = os.environ.get("MAG_REVERSE", "0") == "1"  # flip rotation sense
MAGCAL = None  # {"off": [x,y,z], "scale": [x,y,z]} once loaded
BUS = int(os.environ.get("IMU_BUS", "1"))
HZ = float(os.environ.get("IMU_HZ", "10"))
A = 0.12  # EMA factor: lower = smoother/slower


def init_adxl(bus):
    if bus.read_byte_data(ADDR, 0x00) != 0xE5:  # DEVID
        raise OSError("wrong-devid")
    bus.write_byte_data(ADDR, 0x2D, 0x08)  # POWER_CTL: measure
    bus.write_byte_data(ADDR, 0x31, 0x08)  # DATA_FORMAT: full-res (+/-2g, 3.9 mg/LSB)


def init_icm(bus):
    # Auto-find the ICM20948 among the candidate addresses by WHO_AM_I, then reset and
    # wake it. Sets global ICM. Bank 0 holds WHO_AM_I/PWR_MGMT/accel data, and we never
    # leave it, so ACCEL_CONFIG (bank 2) keeps its reset default of +/-2g = 16384 LSB/g.
    global ICM
    for a in ICM_CANDS:
        try:
            if bus.read_byte_data(a, 0x00) != 0xEA:  # WHO_AM_I
                continue
            bus.write_byte_data(a, 0x7F, 0x00)  # REG_BANK_SEL -> bank 0
            bus.write_byte_data(a, 0x06, 0x80)  # PWR_MGMT_1: device reset
            time.sleep(0.05)
            bus.write_byte_data(a, 0x7F, 0x00)  # reset clears the bank, but be explicit
            bus.write_byte_data(a, 0x06, 0x01)  # PWR_MGMT_1: wake, auto clock source
            bus.write_byte_data(a, 0x07, 0x00)  # PWR_MGMT_2: accel + gyro enabled
            time.sleep(0.03)
            if bus.read_byte_data(a, 0x06) & 0x40:  # SLEEP bit must be clear
                continue
            ICM = a
            return
        except Exception:
            continue
    raise OSError("no-icm")


def read_icm(bus):
    # ACCEL_XOUT_H..ZOUT_L, big-endian (the opposite of the ADXL345's little-endian).
    d = bus.read_i2c_block_data(ICM, 0x2D, 6)
    x, y, z = struct.unpack(">hhh", bytes(d))
    return x / 16384.0, y / 16384.0, z / 16384.0


def init_mag(bus):
    # Expose the AK09916 on the main bus: drop the ICM's own I2C master (USER_CTRL
    # I2C_MST_EN) and set BYPASS_EN in INT_PIN_CFG, which ties the aux bus through to
    # the primary one. Requires init_icm to have run — there's no magnetometer without
    # the ICM20948 in front of it.
    if ICM is None:
        raise OSError("no-icm")
    bus.write_byte_data(ICM, 0x7F, 0x00)  # bank 0
    bus.write_byte_data(ICM, 0x03, 0x00)  # USER_CTRL: I2C_MST_EN off
    bus.write_byte_data(ICM, 0x0F, 0x02)  # INT_PIN_CFG: BYPASS_EN on
    time.sleep(0.02)
    if bus.read_byte_data(AK, 0x00) != 0x48 or bus.read_byte_data(AK, 0x01) != 0x09:
        raise OSError("wrong-ak-id")     # WIA1/WIA2 identify the AK09916
    bus.write_byte_data(AK, 0x32, 0x01)  # CNTL3: soft reset
    time.sleep(0.05)
    bus.write_byte_data(AK, 0x31, 0x06)  # CNTL2: continuous mode 3 (50 Hz)
    time.sleep(0.02)
    load_magcal()


def load_magcal():
    # Hard/soft-iron correction from the calibration file. Absent file = identity, which
    # still yields a heading — just an uncorrected, likely badly skewed one.
    global MAGCAL
    try:
        with open(MAG_CAL_PATH) as fh:
            d = json.load(fh)
        off, scale = [float(v) for v in d["off"]], [float(v) for v in d["scale"]]
        if len(off) == 3 and len(scale) == 3 and all(s > 0 for s in scale):
            MAGCAL = {"off": off, "scale": scale}
            sys.stderr.write("magcal loaded from %s\n" % MAG_CAL_PATH)
            return
    except Exception as e:
        sys.stderr.write("magcal absent (%s): heading UNCALIBRATED\n" % e)
    MAGCAL = None


def read_mag_raw(bus):
    # ST1 bit0 = DRDY. Returns raw counts in the ICM's accel/gyro frame, or None if no
    # fresh sample. ST2 must be read to release the measurement, even when discarding.
    if not (bus.read_byte_data(AK, 0x10) & 0x01):
        return None
    d = bus.read_i2c_block_data(AK, 0x11, 6)   # HXL..HZH, little-endian (unlike the ICM)
    st2 = bus.read_byte_data(AK, 0x18)
    if st2 & 0x08:                             # HOFL: magnetic overflow, data invalid
        return None
    x, y, z = struct.unpack("<hhh", bytes(d))
    # The AK09916 die is mounted rotated inside the ICM20948: its X/Y are swapped and Z
    # inverted relative to the accel/gyro axes. Remap so mag and gravity share a frame,
    # which tilt compensation below depends on.
    return float(y), float(x), float(-z)


def read_mag(bus):
    # Calibrated field in microtesla (0.15 uT/LSB), or None when no fresh sample.
    raw = read_mag_raw(bus)
    if raw is None:
        return None
    v = [c * 0.15 for c in raw]
    if MAGCAL:
        v = [(v[i] - MAGCAL["off"][i]) * MAGCAL["scale"][i] for i in range(3)]
    return v


def mag_to_attitude_frame(mag):
    """Put the magnetometer in whatever frame roll/pitch are currently computed in.
    Tilt compensation mixes the two, so a mismatch tilts the correction the wrong way and
    the heading swings with heel — the exact failure compensation exists to prevent.
    read_mag() has already mapped the die into the accelerometer's axes; this handles the
    mounting on top of that."""
    if FRAME:
        dot = lambda a, b: a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
        # Same convention the attitude uses: forward, starboard, up.
        return (dot(mag, FRAME["fore"]), dot(mag, FRAME["stbd"]), dot(mag, FRAME["up"]))
    return orient(*mag)          # legacy path: same reordering the accel gets


def tilt_heading(mag, roll_deg, pitch_deg):
    # Tilt-compensated magnetic heading. Projecting the field onto the horizontal plane
    # using the gravity vector matters a lot on a boat: an uncompensated heading swings
    # wildly with heel, which is exactly when you're least able to ignore it.
    r, p = math.radians(roll_deg), math.radians(pitch_deg)
    mx, my, mz = mag
    xh = mx * math.cos(p) + mz * math.sin(p)
    yh = mx * math.sin(r) * math.sin(p) + my * math.cos(r) - mz * math.sin(r) * math.cos(p)
    h = math.degrees(math.atan2(yh, xh))
    if MAG_REVERSE:
        h = -h
    return (h + MAG_DEV + 360.0) % 360.0


def nmea_hdm(deg):
    body = "HCHDM,%.1f,M" % deg
    c = 0
    for ch in body:
        c ^= ord(ch)
    return ("$%s*%02X\r\n" % (body, c)).encode()


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


def init_io(bus):
    """MCP23017 16-bit GPIO expander (0x20). Left in its reset state — all 16 pins are
    inputs — so reading it is passive and can't disturb whatever gets wired to it. The
    write/read check on OLATA proves it's a real part rather than a phantom ack."""
    bus.read_byte_data(IO, 0x00)          # IODIRA must be readable
    old = bus.read_byte_data(IO, 0x14)    # OLATA
    bus.write_byte_data(IO, 0x14, 0xA5)
    if bus.read_byte_data(IO, 0x14) != 0xA5:
        raise OSError("no-readback")
    bus.write_byte_data(IO, 0x14, old)


def read_io(bus):
    """Both input ports as one pair of bytes (GPIOA 0x12, GPIOB 0x13)."""
    d = bus.read_i2c_block_data(IO, 0x12, 2)
    return d[0], d[1]


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


def _sht_crc(b0, b1):
    # SHT4x CRC-8: poly 0x31, init 0xFF, MSB-first. Note the init differs from the
    # HTU31D's 0x00 above — same polynomial, different seed.
    crc = 0xFF
    for byte in (b0, b1):
        crc ^= byte
        for _ in range(8):
            crc = ((crc << 1) ^ 0x31) & 0xFF if (crc & 0x80) else (crc << 1) & 0xFF
    return crc


def _sht_xfer(bus, a, cmd, delay):
    # The SHT4x takes a bare command byte then answers a bare read — no register byte
    # anywhere, so this has to go out as two raw transfers rather than smbus block ops.
    bus.i2c_rdwr(smbus.i2c_msg.write(a, [cmd]))
    time.sleep(delay)
    m = smbus.i2c_msg.read(a, 6)
    bus.i2c_rdwr(m)
    d = list(m)
    if _sht_crc(d[0], d[1]) != d[2] or _sht_crc(d[3], d[4]) != d[5]:
        raise ValueError("sht-crc")
    return d


def init_sht(bus):
    # Confirm with a CRC-checked serial-number read (cmd 0x89) — the SHT4x has no ID
    # register, so the CRC is what proves it's really an SHT4x and not a stray ACK.
    global SHT
    for a in SHT_CANDS:
        try:
            _sht_xfer(bus, a, 0x89, 0.02)
            SHT = a
            return
        except Exception:
            continue
    raise OSError("no-sht")


def sht_read(bus):
    # Cmd 0xFD = high-precision T+RH, ~8.2 ms conversion. Returns (degC, %RH).
    d = _sht_xfer(bus, SHT, 0xFD, 0.02)
    t = -45.0 + 175.0 * ((d[0] << 8) | d[1]) / 65535.0
    rh = -6.0 + 125.0 * ((d[3] << 8) | d[4]) / 65535.0
    return t, max(0.0, min(100.0, rh))


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


def calibrate_mag(seconds=90):
    # Min/max hard+soft-iron calibration. Rotate the sensor through as much of a sphere
    # as you can while this runs; every axis needs to see both its extremes or that
    # axis's centre is guesswork. Writes MAG_CAL_PATH. Progress goes to stderr so it
    # stays readable when stdout is piped.
    try:
        bus = smbus.SMBus(BUS)
        init_icm(bus)
        init_mag(bus)
    except Exception as e:
        sys.stderr.write("calibration: cannot start (%s)\n" % e)
        return 1
    lo = [1e9] * 3
    hi = [-1e9] * 3
    pts = []          # kept so the fit can be scored afterwards, MotionCal-style
    t0 = time.time()
    n = 0
    sys.stderr.write("Calibrating for %ds - rotate through every orientation you can.\n" % seconds)
    while time.time() - t0 < seconds:
        raw = read_mag_raw(bus)
        if raw is not None:
            v = [c * 0.15 for c in raw]
            for i in range(3):
                lo[i] = min(lo[i], v[i]); hi[i] = max(hi[i], v[i])
            pts.append(v)
            n += 1
            if n % 25 == 0:
                span = [hi[i] - lo[i] for i in range(3)]
                sys.stderr.write("  %3ds  n=%-5d span uT  X %6.1f  Y %6.1f  Z %6.1f\n" % (
                    int(time.time() - t0), n, span[0], span[1], span[2]))
                sys.stderr.flush()
        time.sleep(0.02)
    span = [hi[i] - lo[i] for i in range(3)]
    if n < 100:
        sys.stderr.write("\nFAILED: only %d samples. Is the magnetometer reading?\n" % n)
        return 1
    # X and Y are non-negotiable: they carry the horizontal field that heading is built
    # from. Z is a different story - a boat turning circles stays level, so Z sees almost
    # no change and its centre can't be found. That's the normal afloat case, not an
    # error, so fall back to a 2D fit and say so.
    if min(span[0], span[1]) < 5.0:
        sys.stderr.write("\nFAILED: X/Y spans %.1f/%.1f uT are too small to locate the\n"
                         "centre. Turn through a FULL circle (ideally two) and re-run.\n"
                         % (span[0], span[1]))
        return 1
    planar = span[2] < 5.0
    off = [(hi[i] + lo[i]) / 2.0 for i in range(3)]          # hard-iron: recentre
    radius = [s / 2.0 for s in span]
    if planar:
        # Z never swung, so its midpoint is meaningless - leave the axis untouched
        # rather than baking in a bogus offset that would skew heading under heel.
        off[2] = 0.0
        avg = (radius[0] + radius[1]) / 2.0
        scale = [avg / radius[0], avg / radius[1], 1.0]
    else:
        avg = sum(radius) / 3.0
        scale = [avg / r for r in radius]                    # soft-iron: equalise axes
    # Score the fit the way MotionCal does: a good calibration turns the sample cloud
    # into a sphere of constant radius, and covers enough of that sphere to have located
    # the centre. Residual spread is the "is it a sphere" test; coverage is the "Gaps"
    # test. Both matter — a tight residual over one small patch of sky means nothing.
    mags = []
    cells = set()
    for v in pts:
        c = [(v[i] - off[i]) * scale[i] for i in range(3)]
        m = math.sqrt(c[0] * c[0] + c[1] * c[1] + c[2] * c[2])
        if m < 1e-6:
            continue
        mags.append(m)
        az = int(((math.degrees(math.atan2(c[1], c[0])) + 360) % 360) // 45)   # 8 sectors
        el = int((math.degrees(math.asin(max(-1.0, min(1.0, c[2] / m)))) + 90) // 60)  # 3 bands
        cells.add((az, el))
    field = sum(mags) / len(mags) if mags else 0.0
    resid = (sum((m - field) ** 2 for m in mags) / len(mags)) ** 0.5 if mags else 0.0
    resid_pct = (resid / field * 100.0) if field else 0.0
    coverage = len(cells) / 24.0 * 100.0        # 8 azimuth x 3 elevation cells
    with open(MAG_CAL_PATH, "w") as fh:
        json.dump({"off": off, "scale": scale, "samples": n, "span": span,
                   "seconds": seconds, "planar": planar,
                   "field": round(field, 2), "residualPct": round(resid_pct, 1),
                   "coveragePct": round(coverage, 1)}, fh, indent=1)
    sys.stderr.write("\n  field strength %.1f uT   residual %.1f%%   sphere coverage %.0f%%\n"
                     % (field, resid_pct, coverage))
    # South Florida sits around 44-46 uT; anything wildly outside 25-65 means the scaling
    # or the sensor is wrong, not just the calibration.
    if field and not (25.0 <= field <= 65.0):
        sys.stderr.write("WARNING: %.1f uT is outside the plausible range for Earth's field.\n" % field)
    if resid_pct > 8.0:
        sys.stderr.write("WARNING: residual %.1f%% - the cloud isn't a sphere. Expect heading error.\n" % resid_pct)
    if coverage < 40.0 and not planar:
        sys.stderr.write("WARNING: only %.0f%% of orientations sampled - rotate through more of a\n"
                         "figure-eight next time so the centre is properly located.\n" % coverage)
    sys.stderr.write("\nWrote %s  (%s fit)\n"
                     "  offsets uT  X %+7.2f  Y %+7.2f  Z %+7.2f\n"
                     "  scales      X %6.3f  Y %6.3f  Z %6.3f\n"
                     "  samples %d, spans X %.1f Y %.1f Z %.1f uT\n" % (
                         MAG_CAL_PATH, "2D planar" if planar else "3D sphere",
                         off[0], off[1], off[2], scale[0], scale[1], scale[2],
                         n, span[0], span[1], span[2]))
    if planar:
        sys.stderr.write("NOTE: 2D fit (Z span %.1f uT). Correct for a boat turning circles.\n"
                         "Heading is accurate while near level; expect drift at large heel.\n"
                         "For a full 3D fit, calibrate the sensor on the bench - but only if\n"
                         "you then keep it in the same magnetic surroundings.\n" % span[2])
    if max(scale) / min(scale) > 2.0:
        sys.stderr.write("WARNING: axis scales differ by >2x - heavy soft-iron distortion,\n"
                         "or the turn wasn't even. Heading accuracy will suffer.\n")
    return 0


def main():
    if "--calibrate-mag" in sys.argv:
        secs = 90
        for a in sys.argv:
            if a.startswith("--seconds="):
                secs = int(a.split("=", 1)[1])
        return calibrate_mag(secs)
    try:
        bus = smbus.SMBus(BUS)
    except Exception as e:
        sys.stdout.write("DEAD bus %s\n" % e); sys.stdout.flush(); return 1

    have = {"icm": False, "mag": False, "adxl": False, "mcp": False, "htu": False, "sht": False, "io": False}
    # init_mag must follow init_icm — the magnetometer only appears once the ICM is
    # awake and bypass is on.
    for fn, name in ((init_icm, "icm"), (init_mag, "mag"), (init_adxl, "adxl"),
                     (init_mcp, "mcp"), (init_htu, "htu"), (init_sht, "sht"), (init_io, "io")):
        try:
            fn(bus)
            have[name] = True
        except Exception as e:
            sys.stderr.write("%s absent: %s\n" % (name, e))

    if not any(have.values()):
        sys.stdout.write("DEAD no-sensors\n"); sys.stdout.flush(); return 1

    # The ICM20948 wins when both accelerometers are on the bus; "none" means neither.
    src = "icm" if have["icm"] else ("adxl" if have["adxl"] else "none")
    sys.stderr.write("attitude source: %s\n" % src)
    have_mcp, have_htu, have_sht, have_io = have["mcp"], have["htu"], have["sht"], have["io"]
    # Heading needs both the field and the gravity vector to tilt-compensate against.
    have_mag = have["mag"] and src != "none"
    if have["mag"] and not have_mag:
        sys.stderr.write("mag present but no accelerometer: heading disabled\n")
    if have_mag and MAGCAL is None:
        sys.stderr.write("heading is UNCALIBRATED - run: python3 imu.py --calibrate-mag\n")
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM) if (have_mag and MAG_NMEA) else None

    sys.stdout.write("READY\n"); sys.stdout.flush()
    rf = pf = None
    hf = None  # smoothed heading, degrees
    tempC = htuC = hum = shtC = shtH = float("nan")
    ioA = ioB = None  # MCP23017 input ports, None when the expander is absent
    period = 1.0 / HZ
    slow = max(1, int(round(HZ)))  # sample the slow temp/RH sensors ~1 Hz
    i = 0
    while True:
        try:
            if src != "none":
                if src == "icm":
                    gx, gy, gz = read_icm(bus)
                else:
                    d = bus.read_i2c_block_data(ADDR, 0x32, 6)
                    x, y, z = struct.unpack("<hhh", bytes(d))
                    gx, gy, gz = x * 0.0039, y * 0.0039, z * 0.0039
                # Roll is atan2(gy, gz): near-vertical mounting drives both toward zero and
                # the angle becomes the ratio of two noise values — gimbal lock. With this
                # part's ~0.002 g noise, a board on its edge yields tens of degrees of pure
                # jitter that looks exactly like a moving boat. Report nothing instead of
                # noise; the horizontal component tells us when the answer is meaningful.
                rawx, rawy, rawz = gx, gy, gz    # pre-orientation, for the calibration UI
                if FRAME:
                    # Taught frame: heel and trim come straight out with correct signs,
                    # and no orientation is degenerate.
                    roll, pitch = attitude_from_frame((gx, gy, gz), FRAME)
                    rf = ema_angle(rf, roll, A)
                    pf = ema_angle(pf, pitch, A)
                else:
                    # Legacy path: a single "which axis is up" choice. Roll is degenerate
                    # when the board is near vertical, so it is withheld rather than
                    # reported as the noise between two near-zero components.
                    gx, gy, gz = orient(gx, gy, gz)
                    horiz = math.sqrt(gy * gy + gz * gz)
                    pitch = math.degrees(math.atan2(-gx, horiz))
                    pf = ema_angle(pf, pitch, A)
                    if horiz < ROLL_MIN_HORIZ:
                        roll, rf = None, None
                    else:
                        roll = math.degrees(math.atan2(gy, gz))
                        rf = ema_angle(rf, roll, A)
            if have_mag and rf is not None:
                try:
                    mag = read_mag(bus)
                    if mag is not None:
                        h = tilt_heading(mag_to_attitude_frame(mag), rf, pf)
                        # Smooth along the shortest arc, not the raw number: a plain EMA
                        # across the 359->0 wrap would swing the long way round and park
                        # the heading at 180 off.
                        if hf is None:
                            hf = h
                        else:
                            hf = (hf + A * (((h - hf + 180.0) % 360.0) - 180.0)) % 360.0
                except Exception as e:
                    sys.stderr.write("mag read error: %s\n" % e)
            if i % slow == 0:
                if reload_imu_config():   # cheap stat(); picks up live calibration edits
                    rf = pf = hf = None   # re-seed the filters on an orientation change
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
                if have_sht:
                    try:
                        shtC, shtH = sht_read(bus)
                    except Exception as e:
                        sys.stderr.write("sht read error: %s\n" % e)
                if have_io:
                    try:
                        ioA, ioB = read_io(bus)
                    except Exception as e:
                        sys.stderr.write("io read error: %s\n" % e)
            # ~5 Hz to SignalK at the default 10 Hz sample rate; plenty for a compass
            # rose and gentler on the UDP path than every sample.
            if sock is not None and hf is not None and i % 2 == 0:
                try:
                    sock.sendto(nmea_hdm(hf), MAG_UDP)
                except Exception:
                    pass
            i += 1
            f = lambda v: "nan" if (v is None or v != v) else "%.2f" % v
            b = lambda v: "nan" if v is None else "%d" % v
            # Raw gravity rides along so the helm's calibration dialog can show which
            # axis is actually vertical, and preview each choice, without a terminal.
            # Wrap after applying the zero: rf is already bounded to +/-180, but
            # subtracting a large offset can push the result past it (a 179 deg zero
            # turned a 169 deg roll into 348 deg on screen).
            wrap = lambda v: ((v + 180.0) % 360.0) - 180.0
            sys.stdout.write("%s %s %s %s %s %s %s %s %s %s %s %s %s %s\n" % (
                f(None if rf is None else wrap(rf - ROLL_OFF)),
                f(None if pf is None else wrap(pf - PITCH_OFF)),
                f(tempC), f(htuC), f(hum), f(shtC), f(shtH), f(hf), src,
                b(ioA), b(ioB), f(rawx), f(rawy), f(rawz)))
            sys.stdout.flush()
        except Exception as e:
            sys.stderr.write("imu read error: %s\n" % e); sys.stderr.flush()
            time.sleep(0.5)
        time.sleep(period)


if __name__ == "__main__":
    sys.exit(main())
