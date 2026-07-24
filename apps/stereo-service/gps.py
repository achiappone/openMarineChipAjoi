#!/usr/bin/env python3
"""Read raw NMEA from the GPS (/dev/serial0), forward each sentence to SignalK over UDP,
and echo it to stdout so the stereo-service can buffer the last sentences and parse the
acquisition state for the helm's GPS diagnostic view.

We read the serial here (instead of letting SignalK own it) so the raw acquisition stream
can be shown on screen; SignalK still gets the data via the UDP forward. Same pipe pattern
as imu.py.

Env: GPS_DEV (/dev/serial0), GPS_BAUD (9600), GPS_UDP (10111).
"""
import os
import socket
import sys
import time

try:
    import serial
except ImportError:
    sys.stdout.write("DEAD no-pyserial\n"); sys.stdout.flush(); sys.exit(1)

DEV = os.environ.get("GPS_DEV", "/dev/serial0")
BAUD = int(os.environ.get("GPS_BAUD", "9600"))
UDP = ("127.0.0.1", int(os.environ.get("GPS_UDP", "10111")))


def main():
    try:
        s = serial.Serial(DEV, BAUD, timeout=2)
    except Exception as e:
        sys.stdout.write("DEAD %s\n" % e); sys.stdout.flush(); return 1
    sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    sys.stdout.write("READY\n"); sys.stdout.flush()
    while True:
        try:
            line = s.readline().decode("ascii", "ignore").strip()
            if not line:
                continue
            try:
                sock.sendto((line + "\r\n").encode(), UDP)  # forward to SignalK
            except Exception:
                pass
            sys.stdout.write(line + "\n"); sys.stdout.flush()
        except Exception as e:
            sys.stderr.write("gps err %s\n" % e); sys.stderr.flush(); time.sleep(0.5)


if __name__ == "__main__":
    sys.exit(main())
