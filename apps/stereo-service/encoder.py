#!/usr/bin/env python3
"""Read a quadrature rotary encoder wired to the MCP23017 (0x20) and report it, one
status line per emit:

  "ENC a=<0|1> b=<0|1> pos=<n> det=<n> dir=<-1|0|1> inv=<n> edges=<n> hz=<n> pa=<hex> pb=<hex>"

Why a separate process: imu.py samples the expander about once a second, which is fine
for buttons and hopeless for a knob — a detent is a handful of milliseconds and you'd
miss most of them. This polls fast enough to catch every state change, decodes proper
quadrature, and counts the transitions that *shouldn't* happen.

That invalid-transition count is the point of the test interface. Both bits changing at
once means a state was missed — either polling too slowly, contact bounce, or logic
levels that aren't reaching the expander's thresholds cleanly. It's the number that tells
you whether running the encoder at 3V is genuinely fine or merely fine on the bench.

Wiring (Oak Grigsby 4-wire: + A - B):
  +  -> 3V        A -> GPA0 (bit 0)
  -  -> GND       B -> GPA1 (bit 1)
Both phases on the same port so one register read captures them in the same instant;
split across ports, the skew between two I2C transactions invents counts of its own.

Env: ENC_ADDR (0x20), ENC_BUS (1), ENC_PIN_A (0), ENC_PIN_B (1), ENC_PORT (A),
ENC_PULLUP (0 - the Oak Grigsby drives its own outputs), ENC_HZ (400 poll rate),
ENC_EMIT_HZ (20).
"""
import os
import sys
import time

try:
    import smbus2 as smbus
except ImportError:
    try:
        import smbus
    except ImportError:
        sys.stdout.write("DEAD no-smbus\n"); sys.stdout.flush(); sys.exit(1)

ADDR = int(os.environ.get("ENC_ADDR", "0x20"), 16)
BUS = int(os.environ.get("ENC_BUS", "1"))
PIN_A = int(os.environ.get("ENC_PIN_A", "0"))
PIN_B = int(os.environ.get("ENC_PIN_B", "1"))
PORT = os.environ.get("ENC_PORT", "A").upper()
PULLUP = os.environ.get("ENC_PULLUP", "0") == "1"
# Softkeys share the port with the encoder. GPPU is per-pin, which is what makes that
# work: pull-ups on the button bits only, because the encoder drives its own outputs and
# must not be pulled. Buttons are passive switches to ground, so they read inverted.
BTN_PINS = [int(x) for x in os.environ.get("ENC_BTN_PINS", "2,3,4,5").split(",") if x != ""]
DEBOUNCE = float(os.environ.get("ENC_DEBOUNCE", "0.05"))
LONG_PRESS = float(os.environ.get("ENC_LONG_PRESS", "0.6"))
IDLE_HZ = float(os.environ.get("ENC_IDLE_HZ", "120"))   # rate while nothing is moving
EMIT_HZ = float(os.environ.get("ENC_EMIT_HZ", "50"))

# MCP23017 registers (IOCON.BANK=0, the reset default)
IODIRA, IODIRB = 0x00, 0x01
GPPUA, GPPUB = 0x0C, 0x0D
GPIOA, GPIOB = 0x12, 0x13
DIR_REG = IODIRA if PORT == "A" else IODIRB
GPIO_REG = GPIOA if PORT == "A" else GPIOB
PU_REG = GPPUA if PORT == "A" else GPPUB

# Standard quadrature table indexed by (prev << 2) | cur. Zeros on the diagonal are
# "no change"; the four impossible entries (both bits flipped at once) are counted as
# invalid rather than silently treated as no movement.
TABLE = [0, -1, 1, 0, 1, 0, 0, -1, -1, 0, 0, 1, 0, 1, -1, 0]
INVALID = {0b0011, 0b0110, 0b1001, 0b1100}


def main():
    try:
        bus = smbus.SMBus(BUS)
        bus.read_byte_data(ADDR, IODIRA)          # probe
        bus.write_byte_data(ADDR, DIR_REG, 0xFF)  # whole port to inputs
        pu = 0xFF if PULLUP else 0x00
        for bp in BTN_PINS:
            pu |= (1 << bp)                       # pull-ups on the softkeys only
        bus.write_byte_data(ADDR, PU_REG, pu)
    except Exception as e:
        sys.stdout.write("DEAD %s\n" % e); sys.stdout.flush(); return 1

    pos = 0          # quadrature counts (4 per detent on most encoders)
    inv = 0          # impossible transitions - the signal-quality tell
    edges = 0        # any change at all
    direction = 0
    prev = None
    pa = pb = 0
    idle_period = 1.0 / IDLE_HZ
    emit_every = 1.0 / EMIT_HZ
    last_emit = 0.0
    edge_window = []                              # timestamps, for an edges/sec figure
    loops = 0
    loop_t0 = time.time()
    poll_hz = 0
    # Per-button: stable level, when it last changed, when it went down, whether the
    # long-press has already fired (so holding doesn't repeat).
    btn = {bp: {"lvl": 1, "raw": 1, "t": 0.0, "down": 0.0, "long": False} for bp in BTN_PINS}
    sys.stdout.write("READY\n"); sys.stdout.flush()

    while True:
        now = time.time()
        try:
            # Read ONLY the port carrying the encoder. Reading both doubled the I2C
            # traffic and halved the sample rate, which showed up as "invalid"
            # transitions on fast spins - missed states, not bad signals. The other
            # port is for the diagnostic view and can lag; it is fetched at emit rate.
            src = bus.read_byte_data(ADDR, GPIO_REG)
            if PORT == "A":
                pa = src
            else:
                pb = src
            a = (src >> PIN_A) & 1
            b = (src >> PIN_B) & 1
            cur = (a << 1) | b
            if prev is None:
                prev = cur
            elif cur != prev:
                edges += 1
                edge_window.append(now)
                idx = (prev << 2) | cur
                if idx in INVALID:
                    inv += 1
                else:
                    step = TABLE[idx]
                    if step:
                        pos += step
                        direction = step
                prev = cur

            # Softkeys, from the same register read the encoder just used.
            for bp, st in btn.items():
                raw = (src >> bp) & 1            # pulled up: 1 = released, 0 = pressed
                if raw != st["raw"]:
                    st["raw"] = raw
                    st["t"] = now                # start the debounce timer
                elif raw != st["lvl"] and now - st["t"] >= DEBOUNCE:
                    st["lvl"] = raw
                    if raw == 0:
                        st["down"] = now
                        st["long"] = False
                        # Fire on press-down, not on release. Waiting for release meant
                        # the button responded only when you let go, which reads as lag.
                        # A held key still emits "long" later; the view treats that as an
                        # additional action rather than a replacement.
                        sys.stdout.write("BTN %d press\n" % bp); sys.stdout.flush()
                if st["lvl"] == 0 and not st["long"] and now - st["down"] >= LONG_PRESS:
                    st["long"] = True            # fire on hold, not on release
                    sys.stdout.write("BTN %d long\n" % bp); sys.stdout.flush()
        except Exception as e:
            sys.stderr.write("enc read error: %s\n" % e); sys.stderr.flush()
            time.sleep(0.25)

        loops += 1
        if now - last_emit >= emit_every:
            poll_hz = int(loops / max(1e-6, now - loop_t0))
            loops = 0; loop_t0 = now
            try:
                pbo = bus.read_byte_data(ADDR, GPIOB if PORT == "A" else GPIOA)
                if PORT == "A": pb = pbo
                else: pa = pbo
            except Exception:
                pass
            last_emit = now
            while edge_window and now - edge_window[0] > 1.0:
                edge_window.pop(0)
            sys.stdout.write("ENC a=%d b=%d pos=%d det=%d dir=%d inv=%d edges=%d hz=%d poll=%d pa=0x%02x pb=0x%02x\n" % (
                (prev >> 1) & 1 if prev is not None else 0, prev & 1 if prev is not None else 0,
                pos, pos // 4, direction, inv, edges, len(edge_window), poll_hz, pa, pb))
            sys.stdout.flush()
        # Adaptive pacing. With the bus at 400 kHz a read costs ~75us, so the sleep
        # became the limit: anything under ~1ms is below Linux timer granularity and
        # rounds up, capping the loop near 1 kHz. While the knob is actually turning we
        # yield instead of sleeping (full speed, one busy core for a second or two);
        # when idle we back off so the Pi isn't burning CPU to watch a stationary knob.
        if edge_window and now - edge_window[-1] < 0.25:
            time.sleep(0)          # active: yield only
        else:
            time.sleep(idle_period)


if __name__ == "__main__":
    sys.exit(main())
