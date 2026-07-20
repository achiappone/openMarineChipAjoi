#!/usr/bin/env node
// pi-health — a read-only snapshot of the Pi, printed to stdout.
// Its only job is to prove the edit -> sync -> run loop works end to end.
// Safe to run anytime: it reads state and writes nothing.

const os = require('os');
const { execSync } = require('child_process');

const sh = (cmd) => {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  } catch {
    return '(unavailable)';
  }
};

const line = (label, value) => console.log(`  ${label.padEnd(16)} ${value}`);

console.log('=== pi-health ===');
line('host', os.hostname());
line('node', process.version);
line('uptime', `${Math.floor(os.uptime() / 3600)}h ${Math.floor((os.uptime() % 3600) / 60)}m`);
line('load', os.loadavg().map((n) => n.toFixed(2)).join('  '));
line('mem free', `${(os.freemem() / 1e6).toFixed(0)} / ${(os.totalmem() / 1e6).toFixed(0)} MB`);

// CAN bus (PiCAN-M) — up? at what bitrate? any frames seen yet?
const can = sh("ip -details -statistics link show can0 2>/dev/null | head -3");
line('can0', can.includes('can0') ? can.replace(/\s+/g, ' ') : 'not present');

// SignalK service state
line('signalk', sh('systemctl is-active signalk'));

console.log('=================');
