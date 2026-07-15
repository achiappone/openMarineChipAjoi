# boat-config

Configuration for the OpenPlotter Raspberry Pi, version controlled on the Mac and
deployed to the Pi over SSH.

## The Pi

| | |
|---|---|
| Host | `openplotter` (see `~/.ssh/config`) — resolves via mDNS to `openplotter.local` |
| Hardware | Raspberry Pi 4 Model B Rev 1.5, 4GB |
| OS | Raspberry Pi OS Bookworm (Debian 12), kernel 6.6.31 aarch64 |
| OpenPlotter | 4.1/4.2 |
| Signal K | 2.8.2, running as `signalk.service` |
| HAT | PiCAN-M (NMEA 2000 + NMEA 0183), MCP2515 over SPI |
| Display | ILI touchscreen over USB |

The Pi is a DHCP client on wifi, so its address moves. Reach it by name, not IP.

## Layout

Paths under `pi/` mirror absolute paths on the Pi, so `pi/boot/firmware/config.txt`
deploys to `/boot/firmware/config.txt`.

## Workflow

```sh
./scripts/pull.sh            # copy live config off the Pi into the repo
git diff                     # see what changed on the Pi
./scripts/deploy.sh          # diff repo against Pi, write nothing
./scripts/deploy.sh --apply  # write to the Pi, backing up each file first
```

Run `pull.sh` after making changes through the OpenPlotter GUI, otherwise the repo
drifts from reality and `deploy.sh` will happily revert the GUI's work.

## PiCAN-M

The MCP2515 is invisible to the OS until a device tree overlay declares it. Per the
manufacturer's guide the board uses a **16 MHz oscillator** with its interrupt on
**GPIO 25**:

```
dtoverlay=mcp2515-can0,oscillator=16000000,interrupt=25
```

The `mcp2515-can0` overlay enables `spi0` itself, so a separate `dtparam=spi=on` is
not required — which is why OpenPlotter's own CAN app does not write one.

NMEA 2000 runs at **250000 bps**. OpenPlotter sets this in
`/etc/network/interfaces.d/can0` rather than in `config.txt`.

### Bus notes

- The Pi is a **drop** off the backbone, so the PiCAN-M's 120Ω terminator jumper
  stays **off**. A NMEA 2000 bus needs exactly two terminators, at the two ends of
  the backbone. A third causes intermittent, hard-to-diagnose faults.
- The MCP2515 and its transceiver are powered from the Pi, so `can0` will come up
  even with the bus unpowered — it just sees no traffic, because bus-powered
  devices are not transmitting.

## Known open items

- Signal K has no users defined, with `allow_readonly` and `allowNewUserRegistration`
  both true, listening on `*:3000`. The admin UI is unauthenticated on the network.
- SSH allows password auth and `pi` still has the default password.
- Signal K has no `defaults.json`, so vessel identity (name, MMSI, dimensions) is unset.
- `pipedProviders` is empty: no data sources are wired into Signal K yet.
