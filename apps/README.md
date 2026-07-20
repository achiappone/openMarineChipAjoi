# apps/

Code that **runs on the Pi** (SignalK plugins, webapps, standalone services).
Deployed with **Ansible**, driven by npm scripts — the same pattern as the
WELLCOM_SERVER project.

System config files (`/boot`, `/etc`) still go through `scripts/deploy.sh`; this
directory is for things that *run* on the Pi.

## How it works

- `ansible/hosts` — the Pi inventory (uses the `openplotter` ssh alias).
- `ansible/config.yml` — the declarative manifest: one entry per app under
  `apps:`, saying where it lands on the Pi and how to install / run / restart it.
- `ansible/deploy_app.yml` — rsyncs `apps/<app>/` to the Pi, installs deps
  **on the Pi** (node 18, native modules build there), then runs/activates.

## Deploy an app

```sh
npm run deploy:health            # deploy the pi-health scaffold
npm run deploy:app -- -e app=<name>   # deploy any app declared in config.yml
npm run ping                     # ansible connectivity check
```

## Add a new app

1. Put the code in `apps/<name>/`.
2. Add an entry under `apps:` in `ansible/config.yml`:

```yaml
apps:
  my-plugin:
    remote: "{{ signalk_home }}/node_modules/my-plugin"
    install: "npm install --omit=dev"
    run: "systemctl restart signalk"
    become: true          # systemctl needs sudo
```

3. `npm run deploy:app -- -e app=my-plugin`.

Dependencies never sync from the Mac (`node_modules` is excluded) — they install
on the Pi where they'll actually run.
