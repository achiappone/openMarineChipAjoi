# apps/

Code that **runs on the Pi** (SignalK plugins, webapps, standalone services).
Deployed with `scripts/dev.sh`, not `deploy.sh` (that one is for `/boot` + `/etc`
config files).

Each app is a folder here with a `deploy.env` describing where it lands on the
Pi and how to activate it:

```sh
REMOTE_DIR="/home/pi/apps/<name>"      # required
INSTALL="npm install --omit=dev"       # optional: run in REMOTE_DIR after sync
RUN="node index.js"                    # optional: activate the new code
LOGS="journalctl -u signalk -n 60 -f"  # optional: follow output
```

Workflow:

```sh
./scripts/dev.sh <name>          # dry run — see what would change
./scripts/dev.sh <name> --push   # sync files only
./scripts/dev.sh <name> --run    # sync + install + run/restart
./scripts/dev.sh <name> --logs   # tail its logs
```

Dependencies install **on the Pi** (node 18, native modules must build there),
so `node_modules` is never synced from the Mac.

## Deploy targets by app type

- **Standalone script/service** → `REMOTE_DIR=/home/pi/apps/<name>`, `RUN="node index.js"`.
- **SignalK plugin** → `REMOTE_DIR=/home/pi/.signalk/node_modules/<name>`,
  `INSTALL="npm install --omit=dev"`, `RUN="sudo systemctl restart signalk"`.
  Then enable it in the SignalK admin UI (Server → Plugin Config).
