#!/usr/bin/env python3
"""Hold an AVRCP cover-art (BIP over OBEX) session open and fetch images on demand.

Why this exists: obexd ties a client session to the D-Bus connection that created
it, so a one-shot `busctl call CreateSession` is useless — the session dies the
instant the CLI exits, and the phone's Track metadata only carries ImgHandle while
a session is actually connected. Node has no D-Bus library here (the service is
dependency-free), so this tiny helper owns the connection and stays alive.

Protocol (line based, so Node can drive it over a pipe):
  stdin :  "<img_handle> <output_path>"
  stdout:  "READY"              session established
           "OK <output_path>"   image written
           "ERR <reason>"       this fetch failed
           "DEAD <reason>"      session is gone; parent should respawn us

Usage: bipart.py <mac> <psm>
"""
import os
import sys
import time
import dbus


def out(msg):
    sys.stdout.write(msg + "\n")
    sys.stdout.flush()


def main():
    if len(sys.argv) < 3:
        out("DEAD usage")
        return 1
    mac, psm = sys.argv[1], int(sys.argv[2])

    bus = dbus.SessionBus()
    client = dbus.Interface(
        bus.get_object("org.bluez.obex", "/org/bluez/obex"), "org.bluez.obex.Client1"
    )
    try:
        session_path = client.CreateSession(
            mac, {"Target": "bip-avrcp", "PSM": dbus.UInt16(psm)}
        )
    except dbus.DBusException as e:
        out("DEAD create-session %s" % e.get_dbus_name())
        return 1

    image = dbus.Interface(
        bus.get_object("org.bluez.obex", session_path), "org.bluez.obex.Image1"
    )
    out("READY")

    # readline(), not `for line in sys.stdin`: iterating a pipe uses block-buffered
    # read-ahead, so requests would sit unseen until the buffer filled.
    while True:
        line = sys.stdin.readline()
        if not line:
            break  # parent closed the pipe
        line = line.strip()
        if not line:
            continue
        try:
            handle, path = line.split(" ", 1)
        except ValueError:
            out("ERR bad-request")
            continue
        try:
            # BIP needs a real image descriptor — an empty one makes obexd start a
            # transfer that the phone drops instantly. Ask the phone what it has and
            # request its native (best) form, falling back to the fixed thumbnail.
            desc = native_descriptor(image, handle)
            transfer = None
            if desc:
                try:
                    transfer, _ = image.Get(path, handle, dbus.Dictionary(desc, signature="sv"))
                except dbus.DBusException:
                    transfer = None
            if transfer is None:
                transfer, _ = image.GetThumbnail(path, handle)
            wait_transfer(bus, transfer)
            # The transfer object disappears the moment it finishes, so the file
            # itself is the only trustworthy evidence of success.
            if os.path.exists(path) and os.path.getsize(path) > 0:
                out("OK %s" % path)
            else:
                out("ERR transfer-failed")
        except dbus.DBusException as e:
            name = e.get_dbus_name() or ""
            # A dropped session can't be recovered here — the parent respawns us.
            if "NoReply" in name or "ServiceUnknown" in name or "NotConnected" in name:
                out("DEAD %s" % name)
                return 1
            out("ERR %s" % name)
    return 0


def native_descriptor(image, handle):
    """Pick the phone's best offered form: {encoding, pixel} of its native image."""
    try:
        props = image.Properties(handle)
    except dbus.DBusException:
        return None
    best = None
    for entry in props:
        d = {str(k): str(v) for k, v in entry.items()}
        if "encoding" not in d or "pixel" not in d:
            continue
        if d.get("type") == "native":
            return {"encoding": d["encoding"], "pixel": d["pixel"]}
        if best is None:
            best = {"encoding": d["encoding"], "pixel": d["pixel"]}
    return best


def wait_transfer(bus, path, timeout=20.0):
    """Poll the transfer's Status until it settles. Returns True on completion."""
    props = dbus.Interface(
        bus.get_object("org.bluez.obex", path), "org.freedesktop.DBus.Properties"
    )
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            status = props.Get("org.bluez.obex.Transfer1", "Status")
        except dbus.DBusException:
            # Object vanished: obexd drops completed transfers, so treat a
            # disappearance as done and let the caller verify the file.
            return True
        if status == "complete":
            return True
        if status == "error":
            return False
        time.sleep(0.15)
    return False


if __name__ == "__main__":
    sys.exit(main())
