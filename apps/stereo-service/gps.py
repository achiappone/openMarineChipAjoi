#!/usr/bin/env python3
"""Read raw NMEA from the GPS, forward each sentence to SignalK over UDP, and echo it to
stdout so the stereo-service can buffer the last sentences and parse the acquisition state
for the helm's GPS diagnostic view.

We read the serial here (instead of letting SignalK own it) so the raw acquisition stream
can be shown on screen; SignalK still gets the data via the UDP forward. Same pipe pattern
as imu.py.

Port: the GPS is on **uart5** (GPIO12/13, header pins 32/33) as /dev/gps — a udev symlink
onto the PL011 at fe201a00, because the ttyAMA number is not stable. It is NOT on the
header UART: GPIO15/pin10 is clamped low by something on the Pi side of the header, so
nothing can be received there. /dev/serial0 stays in the candidate list only as a fallback
for a module wired back to pins 8/10 if that ever gets fixed.

Baud is auto-detected — the M10 on this boat runs at 115200 (u-blox M10 variants differ),
by listening on each rate for valid NMEA. Set GPS_BAUD to pin it and skip the
search. Exits with DEAD when nothing is talking, so server.js retries every 5s and the
helm shows the receiver as down rather than "alive" with an empty stream.

Besides NMEA we poll two UBX messages so the helm can show what the receiver actually is
and how its RF front end is doing:
  UBX-MON-VER (once) -> firmware/hardware/protocol version + supported constellations
  UBX-MON-RF  (10s)  -> AGC, noise, jamming indicator, antenna status
Those come back as `#VER ...` / `#RF ...` lines on stdout; server.js parses them and
anything it doesn't recognise is ignored, so the NMEA contract is unchanged.

AGC is the useful one for diagnosing "why no fix": a healthy front end drifts constantly,
while a value pinned at the bottom of its 0..8191 range means a strong in-band carrier is
forcing the gain down and burying the satellites.

Env: GPS_DEV (default: probe /dev/gps then /dev/serial0), GPS_BAUD (default: auto),
GPS_UDP (10111).
"""
import json
import os
import socket
import struct
import subprocess
import sys
import time

try:
    import serial
except ImportError:
    sys.stdout.write("DEAD no-pyserial\n"); sys.stdout.flush(); sys.exit(1)

DEVS = [os.environ.get("GPS_DEV")] if os.environ.get("GPS_DEV") else ["/dev/gps", "/dev/serial0"]
# 115200 first: that's what the M10 on this boat ships at, so a respawn locks on
# immediately instead of walking the list. The rest cover a swapped/replaced module.
BAUDS = [int(os.environ["GPS_BAUD"])] if os.environ.get("GPS_BAUD") else [115200, 9600, 38400, 230400, 4800, 19200, 57600]
UDP = ("127.0.0.1", int(os.environ.get("GPS_UDP", "10111")))
PROBE_SECS = 2.5   # > 1s so at least one full 1Hz sentence burst lands in the window
RF_EVERY = 10.0    # seconds between UBX-MON-RF polls
VER_RETRY = 30.0   # re-poll UBX-MON-VER this often until the module answers
AGC_MAX = 8191     # full scale of the M10's AGC counter

ANT_STATUS = {0: "init", 1: "unknown", 2: "ok", 3: "short", 4: "open"}
ANT_POWER = {0: "off", 1: "on", 2: "unknown"}
JAM_STATE = {0: "unknown", 1: "ok", 2: "warning", 3: "critical"}


def ubx(cls, mid, payload=b""):
    """Frame a UBX message (poll requests are zero-length payloads)."""
    body = bytes([cls, mid, len(payload) & 0xFF, len(payload) >> 8]) + payload
    a = b = 0
    for ch in body:
        a = (a + ch) & 0xFF
        b = (b + a) & 0xFF
    return b"\xb5\x62" + body + bytes([a, b])


POLL_VER = ubx(0x0A, 0x04)
POLL_RF = ubx(0x0A, 0x38)

# ---- Startup aiding (UBX-MGA-INI) -------------------------------------------------
# A cold start with no almanac is the hardest thing this receiver does: it has to search
# every satellite against every plausible Doppler shift and code phase. Telling it the
# time and roughly where it is collapses most of that search, cutting time-to-first-fix
# and buying real acquisition sensitivity — the phone's A-GNSS trick, minus the network.
#
# Position comes from the last fix we saw (persisted) or GPS_HOME; ±100 km is plenty, so
# a marina coordinate works all season. Time comes from the Pi — but ONLY when the clock
# is actually NTP-synced. The Pi has no RTC, so after a cold boot with no tether its
# clock can be wildly wrong, and a bad time hurts more than no time at all.
STATE = os.environ.get("GPS_STATE", os.path.join(os.path.dirname(os.path.abspath(__file__)), "gpsfix.json"))
HOME = os.environ.get("GPS_HOME")  # "lat,lon" fallback when no fix has ever been stored
# Written by server.js's Wi-Fi geolocation fallback; better than GPS_HOME, worse than a fix.
WIFI_POS = os.environ.get("GPS_WIFI_POS", os.path.join(os.path.dirname(os.path.abspath(__file__)), "wifipos.json"))
SAVE_EVERY = 300.0  # persist the position at most this often


def clock_synced():
    """True only when something authoritative has set the clock."""
    try:
        r = subprocess.run(["timedatectl", "show", "-p", "NTPSynchronized", "--value"],
                           capture_output=True, text=True, timeout=3)
        if r.returncode == 0:
            return r.stdout.strip() == "yes"
    except Exception:
        pass
    return os.path.exists("/run/systemd/timesync/synchronized")


def mga_ini_time_utc(t=None):
    """UBX-MGA-INI-TIME_UTC. leapSecs = -128 means 'unknown', which is correct here —
    the receiver works it out from the satellites once it has them."""
    tm = time.gmtime(t if t is not None else time.time())
    return ubx(0x13, 0x40, struct.pack(
        "<BBBbHBBBBBBIH2xI",
        0x10, 0x00, 0x00, -128,
        tm.tm_year, tm.tm_mon, tm.tm_mday, tm.tm_hour, tm.tm_min, tm.tm_sec, 0,
        0,          # ns
        2,          # tAccS: claim 2s accuracy, honest for an NTP-synced host
        0))         # tAccNs


def mga_ini_pos_llh(lat, lon, alt_m=0.0, acc_m=100000.0):
    """UBX-MGA-INI-POS_LLH. Accuracy defaults to 100 km — deliberately loose, since a
    stale marina position must never be treated as a real fix."""
    return ubx(0x13, 0x40, struct.pack(
        "<BB2xiiiI", 0x01, 0x00,
        int(round(lat * 1e7)), int(round(lon * 1e7)),
        int(round(alt_m * 100)), int(round(acc_m * 100))))


def load_position():
    """Best available seed, in order of trust: a real GPS fix we stored, then the coarse
    Wi-Fi position the stereo-service looks up while unfixed, then the static GPS_HOME.
    All three are declared to the receiver at +/-100 km, so even the worst is safe."""
    try:
        with open(STATE) as fh:
            d = json.load(fh)
        return float(d["lat"]), float(d["lon"]), max(0.0, time.time() - float(d.get("t", 0))), "last-fix"
    except Exception:
        pass
    try:
        with open(WIFI_POS) as fh:
            d = json.load(fh)
        age = max(0.0, time.time() - float(d.get("ts", 0)) / 1000.0)
        if age < 30 * 86400:   # a month-old Wi-Fi hit still beats nothing for a seed
            return float(d["lat"]), float(d["lon"]), age, "wifi"
    except Exception:
        pass
    if HOME:
        try:
            lat, lon = [float(x) for x in HOME.split(",")]
            return lat, lon, None, "GPS_HOME"
        except Exception:
            pass
    return None


def save_position(lat, lon):
    tmp = STATE + ".tmp"
    try:
        with open(tmp, "w") as fh:
            json.dump({"lat": lat, "lon": lon, "t": time.time()}, fh)
        os.replace(tmp, STATE)   # atomic, so a crash can't leave a half-written file
    except Exception as e:
        sys.stderr.write("gps state save failed: %s\n" % e)


def nmea_latlon(val, hemi):
    """NMEA packs degrees and minutes as DDMM.MMMM — unpack to decimal degrees."""
    if not val or not hemi:
        return None
    try:
        v = float(val)
    except ValueError:
        return None
    deg = int(v // 100)
    dec = deg + (v - deg * 100) / 60.0
    return -dec if hemi in ("S", "W") else dec


def looks_like_nmea(chunk):
    """True when the bytes contain a plausible sentence. Deliberately loose — a wrong baud
    yields framing garbage that almost never carries both a '$' and a trailing '*'."""
    for line in chunk.split(b"\n"):
        line = line.strip()
        if line.startswith(b"$") and b"*" in line and len(line) > 10:
            return True
    return False


def find_port():
    """Return (open port, dev, baud) for whatever is producing NMEA, or (None, None, None)."""
    for dev in DEVS:
        if not os.path.exists(dev):
            continue
        for baud in BAUDS:
            try:
                s = serial.Serial(dev, baud, timeout=0.3)
            except Exception:
                break  # can't open the device at all — try the next device
            buf = b""
            t = time.time()
            while time.time() - t < PROBE_SECS:
                buf += s.read(512)
                if looks_like_nmea(buf):
                    return s, dev, baud
            s.close()
    return None, None, None


def emit(line):
    sys.stdout.write(line + "\n")
    sys.stdout.flush()


def parse_mon_ver(pl):
    """UBX-MON-VER: 30-byte swVersion, 10-byte hwVersion, then 30-byte extension strings."""
    if len(pl) < 40:
        return None
    txt = lambda b: b.split(b"\x00")[0].decode("ascii", "replace").strip()
    out = {"sw": txt(pl[0:30]), "hw": txt(pl[30:40]), "prot": "", "gnss": [], "mod": ""}
    for k in range(40, len(pl), 30):
        ext = txt(pl[k:k + 30])
        if not ext:
            continue
        if ext.startswith("PROTVER="):
            out["prot"] = ext[8:]
        elif ext.startswith("FWVER="):
            out["sw"] = ext[6:] or out["sw"]
        elif ext.startswith("MOD="):
            out["mod"] = ext[4:]
        elif ";" in ext and not ext.startswith("ROM"):
            # constellation lists arrive as "GPS;GLO;GAL;BDS" and "SBAS;QZSS"
            out["gnss"].extend(p for p in ext.replace(",", ";").split(";") if p)
    # hwVersion is the only reliable generation marker on this module (MOD= is absent).
    out["model"] = out["mod"] or {"000A0000": "u-blox M10", "00190000": "u-blox M8",
                                  "00080000": "u-blox M8"}.get(out["hw"], "u-blox")
    return out


def parse_mon_rf(pl):
    """UBX-MON-RF: header then 24-byte blocks; block 0 is the L1 front end."""
    if len(pl) < 4 + 24:
        return None
    blk = pl[4:28]
    noise, agc = struct.unpack("<HH", blk[12:16])
    return {
        "ant": ANT_STATUS.get(blk[2], str(blk[2])),
        "antPwr": ANT_POWER.get(blk[3], str(blk[3])),
        "jam": JAM_STATE.get(blk[1] & 0x03, "?"),
        "jamInd": blk[16],
        "noise": noise,
        "agc": agc,
        "agcMax": AGC_MAX,
    }


def kv(prefix, d):
    """Serialise a dict as `#TAG k=v|k=v` — '|' separated so values may contain spaces."""
    return prefix + " " + "|".join("%s=%s" % (k, v) for k, v in d.items())


# ---- AssistNow Offline (UBX-MGA-ANO) ----------------------------------------------
# Predicted orbits, good for days to weeks from a single download. Built for exactly this
# boat's situation: tether at the dock, then cruise the ICW with no connectivity and
# still warm-start. The file lives on the Pi (the MAX-M10S has no flash to hold it), and
# each startup we send only the records dated for today.
#
# Needs a free u-blox AssistNow token in GPS_ASSIST_TOKEN. Without one this whole layer
# quietly no-ops — the MGA-INI time/position aiding above still runs.
# u-blox retired AssistNow Online/Offline (end of support 31 May 2026). The replacement
# is AssistNow Predictive Orbits — free on Gen9/Gen10 receivers, which includes this M10 —
# authenticated by a per-device "chipcode" from the one-time ZTP device registration
# rather than the old account token. The payload is still UBX-MGA-ANO, so everything
# below this point is unchanged.
ASSIST_TOKEN = os.environ.get("GPS_ASSIST_CHIPCODE") or os.environ.get("GPS_ASSIST_TOKEN")
ASSIST_URL = os.environ.get(
    "GPS_ASSIST_URL",
    # uporb_14 = 14 days of predicted orbits, the longest this profile allows: download
    # once on the dock's tether and every startup for a fortnight is aided. `ualm` adds
    # the almanac. Deliberately NOT requesting `utime` — time assistance is only valid
    # at the moment it is fetched, and this file gets replayed for days; we inject time
    # ourselves from the Pi's clock instead.
    "https://assistnow.services.u-blox.com/GetAssistNowData.ashx"
    "?chipcode={token}&gnss=gps,gal,bds,glo&data=uporb_14,ualm")
OFFLINE_FILE = os.environ.get("GPS_OFFLINE_FILE", os.path.join(os.path.dirname(os.path.abspath(__file__)), "mga-offline.ubx"))
OFFLINE_MAX_AGE = float(os.environ.get("GPS_OFFLINE_MAX_AGE", 5 * 86400))  # refresh when older


def ubx_frames(blob):
    """Yield (cls, mid, payload, whole_frame) for every valid UBX message in a blob."""
    i = 0
    while True:
        i = blob.find(b"\xb5\x62", i)
        if i < 0 or i + 8 > len(blob):
            return
        ln = struct.unpack("<H", blob[i + 4:i + 6])[0]
        end = i + 6 + ln + 2
        if end > len(blob):
            return
        yield blob[i + 2], blob[i + 3], blob[i + 6:i + 6 + ln], blob[i:end]
        i = end


def fetch_offline():
    """Download predicted-orbit data. Runs on a thread — never block the NMEA loop."""
    if not ASSIST_TOKEN:
        return None
    try:
        import urllib.request
        age = time.time() - os.path.getmtime(OFFLINE_FILE) if os.path.exists(OFFLINE_FILE) else None
        if age is not None and age < OFFLINE_MAX_AGE:
            return None  # current enough; don't spend the tether on it
        url = ASSIST_URL.format(token=ASSIST_TOKEN)
        with urllib.request.urlopen(url, timeout=45) as r:
            blob = r.read()
        if len(blob) < 100 or not blob.startswith(b"\xb5\x62"):
            sys.stderr.write("assistnow: unexpected response (%d bytes)\n" % len(blob))
            return None
        tmp = OFFLINE_FILE + ".tmp"
        with open(tmp, "wb") as fh:
            fh.write(blob)
        os.replace(tmp, OFFLINE_FILE)
        sys.stderr.write("assistnow: stored %d bytes\n" % len(blob))
        return len(blob)
    except Exception as e:
        sys.stderr.write("assistnow fetch failed (no tether?): %s\n" % e)
        return None


def offline_frames_for_today():
    """MGA-ANO records carry the day they describe; send only today's."""
    try:
        with open(OFFLINE_FILE, "rb") as fh:
            blob = fh.read()
    except Exception:
        return [], None
    now = time.gmtime()
    want = (now.tm_year % 100, now.tm_mon, now.tm_mday)
    out = []
    for cls, mid, pl, frame in ubx_frames(blob):
        if (cls, mid) != (0x13, 0x20) or len(pl) < 8:
            continue
        if (pl[4], pl[5], pl[6]) == want:
            out.append(frame)
    age = None
    try:
        age = time.time() - os.path.getmtime(OFFLINE_FILE)
    except Exception:
        pass
    return out, age


def send_paced(port, frames, gap=0.012):
    """u-blox wants aiding fed gently; a small gap is enough at 115200 and avoids
    needing the ACK handshake."""
    n = 0
    for f in frames:
        try:
            port.write(f)
            port.flush()
            time.sleep(gap)
            n += 1
        except Exception as e:
            sys.stderr.write("aiding write failed: %s\n" % e)
            break
    return n


def main():
    s, dev, baud = find_port()
    if s is None:
        emit("DEAD no-nmea (%s)" % ",".join(DEVS))
        return 1
    s.timeout = 0.3
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    emit(kv("#PORT", {"dev": dev, "baud": baud}))

    # ---- Aiding, cheapest first. Order matters: time and position before orbits, so the
    # receiver can immediately judge which predicted orbits are relevant. ----
    aid = {"time": 0, "pos": 0, "ano": 0, "src": "none"}
    synced = clock_synced()
    if synced:
        s.write(mga_ini_time_utc()); s.flush(); time.sleep(0.05)
        aid["time"] = 1
    else:
        sys.stderr.write("clock not NTP-synced — skipping time aiding (a wrong time is worse than none)\n")
    known = load_position()
    if known:
        lat, lon, age, src = known
        s.write(mga_ini_pos_llh(lat, lon)); s.flush(); time.sleep(0.05)
        aid["pos"] = 1
        aid["src"] = src
        if age is not None:
            aid["posAgeH"] = "%.1f" % (age / 3600.0)
    frames, ano_age = offline_frames_for_today()
    if frames:
        aid["ano"] = send_paced(s, frames)
        if ano_age is not None:
            aid["anoAgeD"] = "%.1f" % (ano_age / 86400.0)
    emit(kv("#AID", aid))
    # Refresh the offline data in the background if a tether happens to be up; the fetch
    # is slow and unreliable afloat, so it must never delay the receiver coming online.
    if ASSIST_TOKEN:
        try:
            import threading
            threading.Thread(target=fetch_offline, daemon=True).start()
        except Exception:
            pass

    emit("READY")

    last_save = 0.0
    buf = b""
    have_ver = False
    quiet_since = time.time()
    last_rf = last_ver = 0.0

    while True:
        try:
            now = time.time()
            if now - last_rf > RF_EVERY:
                s.write(POLL_RF); last_rf = now
            if not have_ver and now - last_ver > VER_RETRY:
                s.write(POLL_VER); last_ver = now

            chunk = s.read(4096)
            if chunk:
                quiet_since = now
                buf += chunk
            elif now - quiet_since > 30:
                # Receiver went quiet — exit so server.js respawns us and the baud/port
                # search runs again (covers a module that was replaced or re-configured).
                emit("DEAD went-quiet")
                return 1

            # One buffer carries both protocols: pull whichever comes first, so a UBX
            # reply landing mid-sentence can't swallow the NMEA around it.
            while True:
                u = buf.find(b"\xb5\x62")
                n = buf.find(b"\n")
                if u >= 0 and (n < 0 or u < n):
                    if len(buf) < u + 6:
                        break
                    ln = struct.unpack("<H", buf[u + 4:u + 6])[0]
                    if len(buf) < u + 6 + ln + 2:
                        break  # frame still arriving
                    cls, mid = buf[u + 2], buf[u + 3]
                    pl = buf[u + 6:u + 6 + ln]
                    buf = buf[u + 6 + ln + 2:]
                    if (cls, mid) == (0x0A, 0x04):
                        v = parse_mon_ver(pl)
                        if v:
                            have_ver = True
                            v["gnss"] = ";".join(v.pop("gnss"))
                            emit(kv("#VER", v))
                    elif (cls, mid) == (0x0A, 0x38):
                        r = parse_mon_rf(pl)
                        if r:
                            emit(kv("#RF", r))
                    continue
                if n < 0:
                    break
                line = buf[:n].decode("ascii", "ignore").strip()
                buf = buf[n + 1:]
                if not line.startswith("$"):
                    continue
                try:
                    sock.sendto((line + "\r\n").encode(), UDP)  # forward to SignalK
                except Exception:
                    pass
                emit(line)
                # Remember where we were, so the next cold start can be aided. Only from
                # a GGA that actually claims a fix — a blank sentence must never
                # overwrite a good stored position with nothing.
                if line[3:6] == "GGA" and now - last_save > SAVE_EVERY:
                    g = line.split("*")[0].split(",")
                    if len(g) > 6 and g[6] not in ("", "0"):
                        la, lo = nmea_latlon(g[2], g[3]), nmea_latlon(g[4], g[5])
                        if la is not None and lo is not None:
                            save_position(la, lo)
                            last_save = now
            if len(buf) > 8192:
                buf = buf[-2048:]  # never let a garbage stream grow without bound
        except Exception as e:
            sys.stderr.write("gps err %s\n" % e); sys.stderr.flush(); time.sleep(0.5)


if __name__ == "__main__":
    sys.exit(main())
