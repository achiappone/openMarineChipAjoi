// openMarine Stereo control service — drives the RTL-SDR as an FM receiver.
// No dependencies (Node built-ins only). Plays FM out the Pi aux, taps the audio
// for a live spectrum (streamed over SSE), and exposes tuner controls + settings.
const http = require('http')
const https = require('https')
const fs = require('fs')
const crypto = require('crypto')
const { spawn, execSync, exec, execFile } = require('child_process')
// Async shell helper — never blocks the event loop (which serves the spectrum SSE).
const execP = (cmd) => new Promise((resolve) => exec(cmd, { encoding: 'utf8', maxBuffer: 1 << 20 }, (e, stdout) => resolve(stdout || '')))
// execFile with an args array — no shell, so user-supplied SSID/password/IP can't inject.
const execFileP = (file, args) => new Promise((resolve) => execFile(file, args, { encoding: 'utf8', maxBuffer: 1 << 20 }, (e, stdout, stderr) => resolve({ ok: !e, out: stdout || '', err: (stderr || '') + (e ? ' ' + e.message : '') })))

const PORT = 8082
const AUDIO_DEV = process.env.AUDIO_DEV || 'plughw:CARD=Headphones' // 3.5mm aux
const MIXER_CARD = process.env.MIXER_CARD || 'Headphones'
const MIXER_CTL = process.env.MIXER_CTL || 'PCM'
const RTL_GAIN = process.env.RTL_GAIN || '40'
// The bcm2835 analog out is logarithmic; below ~this % it's inaudible (and the BT
// transmitter has its own floor). Map the whole 1..30 slider into the usable band.
const VOL_FLOOR_PCT = Number(process.env.VOL_FLOOR_PCT || 70)
// How long taps must settle before the tuner actually retunes (ms). Higher = tap
// through several stations and it only tunes once you stop; the display is instant.
const RETUNE_DELAY = Number(process.env.RETUNE_DELAY || 900)
const PRESETS_FILE = `${__dirname}/presets.json`
const RATE = 48000
const FFT_SIZE = 1024
const NBANDS = 32
const MPX_RATE = 171000 // rtl_fm -M fm output; wide enough for the 57 kHz RDS subcarrier
const REDSEA = process.env.REDSEA || '/home/pi/build/redsea/build/redsea'

// Presets are objects { freq, name, pty } — name = RDS station name, pty = genre.
const DEFAULT_PRESETS = [88.5, 93.7, 101.5, 104.3, 107.9].map((f) => ({ freq: f, name: '', pty: '' }))
function loadPresets() {
  try {
    const p = JSON.parse(fs.readFileSync(PRESETS_FILE, 'utf8'))
    if (!Array.isArray(p)) return DEFAULT_PRESETS
    return p.map((x) => (typeof x === 'number' ? { freq: x, name: '', pty: '' } : { freq: Number(x.freq), name: x.name || '', pty: x.pty || '' }))
      .filter((x) => typeof x.freq === 'number' && !isNaN(x.freq))
  } catch (e) { return DEFAULT_PRESETS }
}
function savePresets() { try { fs.writeFileSync(PRESETS_FILE, JSON.stringify(state.fm.presets)) } catch (e) {} }
// Keep the preset for the current station fresh with the latest decoded RDS info.
function updatePresetInfo() {
  const p = state.fm.presets.find((x) => Math.abs(x.freq - state.fm.freq) < 0.05)
  if (!p || p.manual) return // don't overwrite a name the user set by hand
  let changed = false
  if (state.nowPlaying.title && p.name !== state.nowPlaying.title) { p.name = state.nowPlaying.title; changed = true }
  if (state.nowPlaying.pty && p.pty !== state.nowPlaying.pty) { p.pty = state.nowPlaying.pty; changed = true }
  if (changed) savePresets()
}

const state = {
  connected: true,
  power: false,
  source: 'FM',
  volume: 12,
  muted: false,
  fm: { freq: 101.5, presets: [] },
  nowPlaying: { title: 'FM Radio', artist: '', pty: '' },
  settings: { gain: Number(RTL_GAIN) || 40, deemp: true, squelch: 0, ppm: 0, filter: true, auxChannels: 'stereo' }, // gain<0 = auto
  // recent = phones that have actually connected, newest first, so the helm can
  // offer one-tap reconnect without making you hunt through the paired list.
  // name = what the phone sees in its Bluetooth list (the adapter's Alias).
  bluetooth: { available: false, name: '', connected: null, devices: [], recent: [], connecting: null, pairing: false, pairUntil: 0, control: 'none', track: null, browsable: false,
    // Last 3 tracks played (newest first) so stepping back shows instantly instead
    // of blanking while AVRCP catches up. Covers are already on disk, so artKey
    // stays valid — this only needs the text plus the key.
    history: [] },
}
state.fm.presets = loadPresets()
let spectrum = new Array(NBANDS).fill(0)

// Persist the stereo state so a service restart/deploy resumes instead of resetting
// (power, source, volume, station, tuner settings survive).
const STATE_FILE = `${__dirname}/state.json`
let saveTimer = null
function saveState() {
  clearTimeout(saveTimer)
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(STATE_FILE, JSON.stringify({ power: state.power, source: state.source, volume: state.volume, muted: state.muted, freq: state.fm.freq, settings: state.settings, recent: state.bluetooth.recent })) } catch (e) {}
  }, 500)
}
try {
  const p = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  if (p.source) state.source = p.source
  if (p.volume != null) state.volume = p.volume
  state.muted = !!p.muted
  if (p.freq) state.fm.freq = p.freq
  if (p.settings) Object.assign(state.settings, p.settings)
  if (Array.isArray(p.recent)) state.bluetooth.recent = p.recent.slice(0, 4)
  state.power = !!p.power
} catch (e) {}

// ---- audio spectrum (FFT of the demodulated audio we play) ----
function fft(re, im) {
  const n = re.length
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1
    for (; j & bit; bit >>= 1) j ^= bit
    j ^= bit
    if (i < j) { const tr = re[i]; re[i] = re[j]; re[j] = tr; const ti = im[i]; im[i] = im[j]; im[j] = ti }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0
      for (let k = 0; k < len / 2; k++) {
        const ar = re[i + k], ai = im[i + k]
        const br = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci
        const bi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr
        re[i + k] = ar + br; im[i + k] = ai + bi
        re[i + k + len / 2] = ar - br; im[i + k + len / 2] = ai - bi
        const ncr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = ncr
      }
    }
  }
}

let samples = []
let lastFft = 0
function pushAudio(buf) {
  for (let i = 0; i + 1 < buf.length; i += 2) samples.push(buf.readInt16LE(i) / 32768)
  if (samples.length > FFT_SIZE * 3) samples = samples.slice(-FFT_SIZE)
  const now = Date.now()
  if (samples.length >= FFT_SIZE && now - lastFft >= 55) { lastFft = now; computeSpectrum() }
}
function computeSpectrum() {
  const re = new Float64Array(FFT_SIZE), im = new Float64Array(FFT_SIZE)
  const off = samples.length - FFT_SIZE
  for (let i = 0; i < FFT_SIZE; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1)) // Hann
    re[i] = samples[off + i] * w
  }
  fft(re, im)
  const nyq = RATE / 2, half = FFT_SIZE / 2, fmin = 40, fmax = 16000
  const out = new Array(NBANDS)
  for (let b = 0; b < NBANDS; b++) {
    const f0 = fmin * Math.pow(fmax / fmin, b / NBANDS)
    const f1 = fmin * Math.pow(fmax / fmin, (b + 1) / NBANDS)
    let k0 = Math.max(1, Math.floor((f0 / nyq) * half))
    let k1 = Math.min(half - 1, Math.max(k0, Math.ceil((f1 / nyq) * half)))
    let m = 0
    for (let k = k0; k <= k1; k++) { const mag = Math.hypot(re[k], im[k]); if (mag > m) m = mag }
    // normalize to ~full-scale peak bin (N/4 for a Hann-windowed tone), then dB.
    const mn = m / (FFT_SIZE / 4)
    let v = (20 * Math.log10(mn + 1e-5) + 55) / 55 // ~ -55..0 dB -> 0..1
    v = Math.max(0, Math.min(1, v))
    // smooth with previous frame for a nicer look
    out[b] = spectrum[b] != null ? spectrum[b] * 0.4 + v * 0.6 : v
  }
  spectrum = out
}
function clearSpectrum() { spectrum = new Array(NBANDS).fill(0); samples = [] }

// ---- FM pipeline: rtl_fm (-M fm MPX) -> tee -> { redsea (RDS), sox (deemph+resample) -> aplay } ----
let rtlProc = null, aplayProc = null, soxProc = null, redseaProc = null, restartTimer = null, rdsBuf = ''

let volTimer = null, volPending = false
function applyVolume() {
  // Coalesced: rapid changes (a knob spin) collapse into one spawn per ~60ms window,
  // always with the newest value. Spawning amixer per detent backed up the queue and
  // made the volume lurch to the final position seconds later.
  volPending = true
  if (volTimer) return
  volTimer = setTimeout(() => { volTimer = null; if (volPending) { volPending = false; applyVolumeNow() } }, 60)
  applyVolumeNow()
}
function applyVolumeNow() {
  volPending = false
  let pct = 0
  if (!state.muted && state.volume > 0) {
    pct = Math.round(VOL_FLOOR_PCT + ((state.volume - 1) / (30 - 1)) * (100 - VOL_FLOOR_PCT))
  }
  spawn('amixer', ['-c', MIXER_CARD, 'sset', MIXER_CTL, `${pct}%`], { stdio: 'ignore' })
}

// US stations scroll ad/song text through the 8-char PS field, so a single PS frame
// is a fragment ("rneys.7"). Keep the frame that recurs as a stable station name
// (title), and reassemble the scrolling segments into a full message (artist).
let psFreq = {}, psBuilding = [], psComplete = '', rtText = '', ptyFreq = {}
function rdsMessage() { return rtText || psComplete || psBuilding.join(' ') }
function resetRds() { psFreq = {}; psBuilding = []; psComplete = ''; rtText = ''; ptyFreq = {}; rdsBuf = '' }
function notePs(raw) {
  const t = String(raw).replace(/\s+/g, ' ').trim()
  if (!t) return
  psFreq[t] = (psFreq[t] || 0) + 1
  let best = null, n = 1 // most-frequent frame = the call sign (scroll fragments are transient)
  for (const k in psFreq) if (psFreq[k] > n) { n = psFreq[k]; best = k }
  state.nowPlaying.title = best || t
  // reassemble scrolling segments in order; a full cycle completes when it loops
  const last = psBuilding[psBuilding.length - 1]
  if (t !== last) {
    if (psBuilding.length >= 2 && t === psBuilding[0]) { psComplete = psBuilding.join(' '); psBuilding = [t] }
    else { psBuilding.push(t); if (psBuilding.length > 24) { psComplete = psBuilding.join(' '); psBuilding = [t] } }
  }
  state.nowPlaying.artist = rdsMessage()
  updatePresetInfo()
}

// Parse redsea's JSON lines; pull the station name (ps) and radio text.
function parseRds(d) {
  rdsBuf += d.toString()
  let nl
  while ((nl = rdsBuf.indexOf('\n')) >= 0) {
    const line = rdsBuf.slice(0, nl).trim(); rdsBuf = rdsBuf.slice(nl + 1)
    if (!line) continue
    try {
      const j = JSON.parse(line)
      if (j.ps) notePs(j.ps)
      if (j.radiotext && j.radiotext.trim()) { rtText = j.radiotext.trim(); state.nowPlaying.artist = rdsMessage() }
      if (j.prog_type && j.prog_type !== 'None') {
        ptyFreq[j.prog_type] = (ptyFreq[j.prog_type] || 0) + 1
        let best = null, n = 2 // need >=3 consistent hits so a single glitched frame can't stick
        for (const k in ptyFreq) if (ptyFreq[k] > n) { n = ptyFreq[k]; best = k }
        if (best) { state.nowPlaying.pty = best; updatePresetInfo() }
      }
    } catch (e) {}
  }
}

function killPipeline() {
  // SIGKILL, not SIGTERM. sox blocks in read() as soon as rtl_fm goes away and only
  // checks its termination flag after the read returns — which never happens — so a
  // polite signal leaves it running forever. Every retune used to strand one, and a
  // handful of them fighting over the audio device is what makes playback skip.
  // There is nothing to flush in an audio pipeline, so a graceful stop buys nothing.
  for (const p of [rtlProc, redseaProc, soxProc, aplayProc]) { try { if (p) p.kill('SIGKILL') } catch (e) {} }
  rtlProc = aplayProc = soxProc = redseaProc = null; rdsBuf = ''
  // backstop by exact process name (-x never self-matches the shell running it)
  try { execSync('pkill -9 -x rtl_fm; pkill -9 -x redsea; pkill -9 -x sox; pkill -9 -x aplay; true', { stdio: 'ignore' }) } catch (e) {}
  clearSpectrum()
}

function scheduleStart() {
  killPipeline()
  clearTimeout(restartTimer)
  if (!state.power || state.source !== 'FM') return
  restartTimer = setTimeout(() => {
    if (!state.power || state.source !== 'FM') return
    const st = state.settings, f = state.fm.freq.toFixed(1)
    state.nowPlaying = { title: '', artist: '', pty: '' } // clear RDS from the previous station
    resetRds()
    // rtl_fm -M fm @171k = raw FM multiplex (audio 0-15k + RDS subcarrier @57k)
    const args = ['-f', `${f}M`, '-M', 'fm', '-l', String(st.squelch || 0), '-A', 'std', '-p', String(st.ppm || 0), '-s', String(MPX_RATE)]
    if (st.filter) args.push('-F', '9')
    if (st.gain >= 0) args.push('-g', String(st.gain))
    args.push('-')
    rtlProc = spawn('rtl_fm', args, { stdio: ['ignore', 'pipe', 'ignore'] })
    // RDS decoder reads the raw MPX
    redseaProc = spawn(REDSEA, ['-r', String(MPX_RATE)], { stdio: ['pipe', 'pipe', 'ignore'] })
    redseaProc.stdout.on('data', parseRds)
    redseaProc.stdin.on('error', () => {}); redseaProc.on('error', () => {})
    // audio: 75us de-emphasis (1-pole @2122Hz) + 16k lowpass + resample 171k->48k
    const deemp = st.deemp ? ['lowpass', '-1', '2122'] : []
    soxProc = spawn('sox', ['-t', 'raw', '-r', String(MPX_RATE), '-e', 'signed', '-b', '16', '-c', '1', '-',
      '-t', 'raw', '-r', String(RATE), '-e', 'signed', '-b', '16', '-c', '1', '-',
      ...deemp, 'lowpass', '16000', 'gain', '4'], { stdio: ['pipe', 'pipe', 'ignore'] })
    soxProc.stdin.on('error', () => {}); soxProc.on('error', () => {})
    aplayProc = spawn('aplay', ['-q', '-r', String(RATE), '-f', 'S16_LE', '-t', 'raw', '-c', '1',
      // Ride out CPU spikes from the browser rather than underrunning. Volume is applied
      // by the hardware mixer, so this costs nothing in control responsiveness.
      '--buffer-time', String(Number(process.env.AUDIO_BUFFER_US || 250000)),
      '--period-time', String(Number(process.env.AUDIO_PERIOD_US || 50000)),
      '-D', AUDIO_DEV], { stdio: ['pipe', 'ignore', 'ignore'] })
    soxProc.stdout.pipe(aplayProc.stdin)
    soxProc.stdout.on('data', pushAudio) // FFT tap on clean 48k audio
    aplayProc.stdin.on('error', () => {}); aplayProc.on('error', () => {})
    // tee the MPX to both consumers
    rtlProc.stdout.on('data', (chunk) => {
      if (redseaProc && redseaProc.stdin.writable) { try { redseaProc.stdin.write(chunk) } catch (e) {} }
      if (soxProc && soxProc.stdin.writable) { try { soxProc.stdin.write(chunk) } catch (e) {} }
    })
    rtlProc.on('error', () => {})
    setTimeout(applyVolume, 500)
  }, RETUNE_DELAY)
}
function stopRadio() { clearTimeout(restartTimer); killPipeline(); state.nowPlaying = { title: 'FM Radio', artist: '', pty: '' } }

// ---- Non-FM spectrum: tap the PipeWire output-sink monitor so the visualizer
// reacts to Bluetooth/Aux audio too. FM keeps its own tap on the sox stream (it
// plays via aplay, bypassing PipeWire), so the two never feed the FFT at once. ----
const MONITOR_SRC = process.env.MONITOR_SRC || 'alsa_output.platform-bcm2835_audio.3.stereo-fallback.monitor'
let monProc = null
function startMonitorTap() {
  if (monProc) return
  try {
    // --latency-msec keeps parec's buffering small so the visualizer tracks the
    // audio closely (Bluetooth still has some inherent A2DP codec latency).
    monProc = spawn('parec', ['--device=' + MONITOR_SRC, '--format=s16le', '--rate=' + RATE, '--channels=1', '--latency-msec=40'],
      { stdio: ['ignore', 'pipe', 'ignore'], env: { ...process.env, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR || '/run/user/1000' } })
    monProc.stdout.on('data', pushAudio)
    monProc.on('error', () => {})
    monProc.on('exit', () => { monProc = null })
  } catch (e) { monProc = null }
}
function stopMonitorTap() {
  if (monProc) { try { monProc.kill('SIGTERM') } catch (e) {} monProc = null }
  try { execSync('pkill -x parec; true', { stdio: 'ignore' }) } catch (e) {}
}
// Start/stop the monitor tap to match the current source: on for non-FM while
// powered, off (and spectrum cleared) otherwise.
function applyAudioTaps() {
  if (state.power && state.source !== 'FM') startMonitorTap()
  else { stopMonitorTap(); if (state.source !== 'FM') clearSpectrum() }
}

// ---- Bluetooth (A2DP sink via BlueZ; PipeWire routes the audio) ----
let btPairTimer = null
// Everything here drives BlueZ over D-Bus. bluetoothctl is deliberately NOT used:
// from 5.8x it produces no output and registers nothing when driven from a pipe,
// which silently cost us both the device list and the pairing agent. The
// "just works" (NoInputNoOutput) agent is now the bt-agent.service daemon.
const ADAPTER = '/org/bluez/hci0'
const setAdapterProp = (prop, sig, val) => execP(`busctl --system set-property org.bluez ${ADAPTER} org.bluez.Adapter1 ${prop} ${sig} ${val} 2>/dev/null`)
// Discoverable window for pairing (s). BlueZ turns discoverability off by itself
// after this, so the UI countdown and the adapter agree.
const PAIR_WINDOW = 120
// Macs known when pairing started, so a newly-paired phone can be spotted even if
// it doesn't immediately connect (the wizard shouldn't spin forever after success).
let pairBaseline = new Set()
// Device inventory comes straight off BlueZ's D-Bus objects, not `bluetoothctl
// devices` / `bluetoothctl info`: from 5.8x those print nothing when run
// non-interactively (they exit before the object list arrives), and spawning one
// per device per tick also flooded bluetoothd with connect/disconnect churn.
// bluetoothctl is still used interactively for the agent + pairing (btWrite).
// Fully async so nothing blocks the event loop (a blocking scan was stalling the
// spectrum SSE and freezing the visualizers).
let btScanning = false
let btBrowsableAt = 0 // last time we introspected the player for MediaFolder1 (throttle)
async function btScan() {
  if (btScanning) return
  btScanning = true
  try {
    {
      const am = /^s "([^"]*)"/m.exec(await execP(`busctl --system get-property org.bluez ${ADAPTER} org.bluez.Adapter1 Alias 2>/dev/null`))
      if (am) state.bluetooth.name = busUnescape(am[1])
    }
    const tree = await execP('busctl --system tree org.bluez 2>/dev/null')
    const paths = [...new Set(tree.match(/\/org\/bluez\/hci\d+\/dev_[0-9A-Fa-f_]+/g) || [])]
    const devs = []
    for (const p of paths) {
      // One call, four properties — busctl prints them in the order requested.
      // Icon ("phone", "input-keyboard", "audio-headset"…) lets the helm offer
      // only real phones as reconnect targets.
      const lines = (await execP(`busctl --system get-property org.bluez ${p} org.bluez.Device1 Alias Paired Connected Icon 2>/dev/null`)).trim().split('\n')
      if (lines.length < 3) continue
      if (!/^b true/.test(lines[1])) continue // unpaired leftovers from scanning
      const mac = p.split('dev_')[1].replace(/_/g, ':')
      const nm = /^s "((?:\\.|[^"\\])*)"/.exec(lines[0])
      const ic = lines[3] ? /^s "([^"]*)"/.exec(lines[3]) : null
      devs.push({ mac, name: (nm ? busUnescape(nm[1]) : '') || mac, connected: /^b true/.test(lines[2]), icon: ic ? ic[1] : '' })
    }
    // More than one phone can be connected at once (e.g. a passenger's phone still
    // paired from earlier). Prefer whichever one actually exposes an AVRCP player,
    // since that's the one playing music — otherwise we'd track a silent handset
    // and show no metadata at all.
    const playerOf = (d) => {
      const m = tree.match(new RegExp('/org/bluez/hci[0-9]+/dev_' + d.mac.replace(/:/g, '_') + '(?:/avrcp)?/player[0-9]+'))
      return m ? m[0] : ''
    }
    const withPlayer = devs.filter((d) => d.connected && playerOf(d))
    let preferred = withPlayer.length ? withPlayer[0].mac : null
    if (withPlayer.length > 1) {
      // Two phones with players: follow whichever is actually playing, so picking
      // up your phone and hitting play switches the helm to it.
      for (const d of withPlayer) {
        const st = (await execP(`busctl --system get-property org.bluez ${playerOf(d)} org.bluez.MediaPlayer1 Status 2>/dev/null`)).replace(/.*"(.*)".*/, '$1').trim()
        if (st === 'playing') { preferred = d.mac; break }
      }
    }
    let connected = null
    for (const d of devs) {
      if (d.connected && (!preferred || d.mac === preferred)) {
        connected = { name: d.name, mac: d.mac }
        const bp = '/org/bluez/hci0/dev_' + d.mac.replace(/:/g, '_')
        execP(`busctl --system set-property org.bluez ${bp} org.bluez.Device1 Trusted b true 2>/dev/null`)
        // Remember it as most-recent (dedup by mac, keep the newest 4).
        const r = state.bluetooth.recent
        if (!r[0] || r[0].mac !== d.mac) {
          state.bluetooth.recent = [{ mac: d.mac, name: d.name }, ...r.filter((x) => x.mac !== d.mac)].slice(0, 4)
          saveState()
        } else if (r[0].name !== d.name) { r[0].name = d.name; saveState() } // name changed on the phone
        const bm = /y\s+(\d+)/.exec(await execP(`busctl --system get-property org.bluez ${bp} org.bluez.Battery1 Percentage 2>/dev/null`))
        if (bm) connected.battery = Number(bm[1])
      }
    }
    state.bluetooth.available = true
    state.bluetooth.devices = devs
    state.bluetooth.connected = connected
    // Music-library browsing is only offered when the connected player exposes
    // MediaFolder1. One introspect call, throttled to a couple seconds so this
    // stays cheap on the 1.5s scan tick.
    if (connected && Date.now() - btBrowsableAt >= 2000) {
      btBrowsableAt = Date.now()
      const pp = playerOf(connected)
      state.bluetooth.browsable = pp ? /MediaFolder1/.test(await execP(`busctl --system introspect org.bluez ${pp} 2>/dev/null`)) : false
    } else if (!connected) { state.bluetooth.browsable = false; btBrowsableAt = 0 }
    if (state.bluetooth.pairing && !state.bluetooth.pairedNew) {
      const fresh = devs.find((d) => !pairBaseline.has(d.mac))
      if (fresh) state.bluetooth.pairedNew = { mac: fresh.mac, name: fresh.name }
    }
  } catch (e) {
    // Don't swallow this silently again — an exception here empties the device
    // list and the UI just shows "no phone" with no clue why.
    state.bluetooth.available = true
    console.error('btScan failed:', e && e.message)
  } finally { btScanning = false }
}
// Connect on demand (the helm's one-tap reconnect buttons) and report how it went,
// so the UI can spin while it works and then say connected / failed instead of
// leaving you guessing. Uses Device1.Connect rather than `bluetoothctl connect`
// because that gives us an actual result to act on.
// state.bluetooth.connecting = { mac, status: 'connecting'|'ok'|'fail', error }
let btConnClear = null
const execX = (cmd) => new Promise((resolve) => exec(cmd, { encoding: 'utf8', maxBuffer: 1 << 20 }, (e, so, se) => resolve({ ok: !e, out: `${so || ''}${se || ''}`.trim() })))
function btConnError(out) {
  if (/page-timeout|Page Timeout|Host is down/i.test(out)) return 'Phone not responding'
  if (/refused|rejected|Connection refused/i.test(out)) return 'Phone refused the connection'
  if (/Unknown object|does not exist|not available/i.test(out)) return 'Phone not paired'
  if (/in progress|Already/i.test(out)) return 'Already connecting'
  return 'Connection failed'
}
async function btDoConnect(mac) {
  clearTimeout(btConnClear)
  state.bluetooth.connecting = { mac, status: 'connecting', error: '' }
  const p = '/org/bluez/hci0/dev_' + mac.replace(/:/g, '_')
  // 30s cap — BlueZ's own connect attempt can hang longer than anyone will watch a spinner.
  const r = await execX(`timeout 30 busctl --system call org.bluez ${p} org.bluez.Device1 Connect`)
  // Confirm against the device's own Connected property (don't trust the call's
  // exit alone, and don't race the periodic scan's throttle).
  let ok = false
  for (let i = 0; i < 8 && !ok; i++) {
    ok = /b true/.test(await execP(`busctl --system get-property org.bluez ${p} org.bluez.Device1 Connected 2>/dev/null`))
    if (!ok) await new Promise((res) => setTimeout(res, 400))
  }
  await btScan()
  state.bluetooth.connecting = { mac, status: ok ? 'ok' : 'fail', error: ok ? '' : btConnError(r.out) }
  // Leave the result up long enough to read, then drop back to the normal buttons.
  btConnClear = setTimeout(() => { state.bluetooth.connecting = null }, ok ? 4000 : 7000) // > the helm's 2s poll
}

// Forget a phone: drop the link key on this side (Adapter1.RemoveDevice) and clear
// it from the recent list. The phone keeps its own stale key, so it must also
// "Forget This Device" before pairing again — otherwise the next connect fails
// with br-connection-key-missing.
async function btForget(mac) {
  const p = '/org/bluez/hci0/dev_' + mac.replace(/:/g, '_')
  await execX(`busctl --system call org.bluez ${p} org.bluez.Device1 Disconnect`)
  await execX(`busctl --system call org.bluez /org/bluez/hci0 org.bluez.Adapter1 RemoveDevice o ${p}`)
  state.bluetooth.recent = state.bluetooth.recent.filter((x) => x.mac !== mac)
  saveState()
  await btScan()
}

// Album art. Best source is the phone itself (AVRCP 1.6 cover art, see the BIP
// block below) — it works offline and matches whatever app is playing. When that
// isn't available we fall back to looking the cover up from artist+title via the
// iTunes Search API. Force IPv4 (the Pi's IPv6 stalls), DOWNLOAD the image here,
// and serve it from localhost so the Pi's browser never hits the slow CDN.
const artCache = {} // key -> art key string (ready) | false (none) | null (pending)
let currentArt = { key: '', buf: null, type: 'image/jpeg' }
// Persistent on-disk cover cache: any track ever played loads instantly, forever.
// ART_DIR is configurable so it can point at external storage later.
const ART_DIR = process.env.ART_DIR || `${__dirname}/artcache`
try { fs.mkdirSync(ART_DIR, { recursive: true }) } catch (e) {}
const artFile = (key) => `${ART_DIR}/${crypto.createHash('md5').update(key).digest('hex')}.img`
function getBuf(url, cb) {
  const req = https.get(url, { family: 4, timeout: 9000 }, (res) => {
    const chunks = []
    res.on('data', (c) => chunks.push(c))
    res.on('end', () => cb(null, Buffer.concat(chunks), res.headers['content-type']))
  })
  req.on('error', () => cb(new Error('err')))
  req.on('timeout', () => { req.destroy(); cb(new Error('timeout')) })
}
// Kill switch for the internet lookup. ART_ONLINE=0 → never touch iTunes; art comes
// only from the on-disk cache (i.e. what the boat looks like with no connectivity).
// ART_CACHE=0 additionally ignores the disk cache, for a true "no art at all" test.
const ART_ONLINE = process.env.ART_ONLINE !== '0'
const ART_CACHE = process.env.ART_CACHE !== '0'
function fetchArt(artist, title) {
  const key = `${artist}|${title}`.toLowerCase()
  if (key in artCache) return
  // Already on disk (previous play or session) → mark ready instantly, no download.
  if (ART_CACHE) { try { if (fs.statSync(artFile(key)).size > 0) { artCache[key] = key; return } } catch (e) {} }
  if (!ART_ONLINE) { artCache[key] = false; return } // offline mode: no lookup, no art
  artCache[key] = null // pending
  const api = `https://itunes.apple.com/search?term=${encodeURIComponent(`${artist} ${title}`)}&media=music&entity=song&limit=1`
  const req = https.get(api, { family: 4, timeout: 9000 }, (res) => {
    let d = ''
    res.on('data', (c) => (d += c))
    res.on('end', () => {
      try {
        const r = JSON.parse(d).results
        let art = r && r[0] && r[0].artworkUrl100
        if (!art) { artCache[key] = false; return }
        art = art.replace('100x100bb', '300x300bb') // smaller = faster
        getBuf(art, (err, buf, type) => {
          if (err || !buf || !buf.length) { artCache[key] = false; return }
          try { fs.writeFileSync(artFile(key), buf) } catch (e) {} // persist to disk
          currentArt = { key, buf, type: type || 'image/jpeg' }
          artCache[key] = key
        })
      } catch (e) { artCache[key] = false }
    })
  })
  req.on('error', () => { artCache[key] = false })
  req.on('timeout', () => { req.destroy(); artCache[key] = false })
}

// ---- Cover art straight off the phone: AVRCP 1.6 cover art (BIP over OBEX) ----
// The iPhone ships the real artwork with the track, so this needs no internet and
// works for any app (Music, Spotify, podcasts). Mechanics: bluetoothd advertises
// the phone's cover-art PSM as MediaPlayer1.ObexPort; we open an OBEX session to
// it with Target=bip-avrcp, and from then on each Track dict carries an ImgHandle
// we can pull with org.bluez.obex.Image1. The handle is only valid while that
// session is up, so we keep it open for as long as the phone is connected.
//
// REQUIRES BlueZ >= 5.79 (the obexd BIP client) built with, and running with,
// experimental interfaces — Bookworm's 5.66 has neither ObexPort nor Image1.
// Everything here is feature-detected: on an old BlueZ ObexPort is simply absent,
// bipAvailable stays false, and we fall back to the iTunes lookup as before.
const BT_ART = process.env.BT_ART !== '0'
const OBEX_UID = process.env.OBEX_UID || '1000'
const BIP_HELPER = `${__dirname}/bipart.py`
// The session must be held open by a live D-Bus connection: obexd destroys it the
// moment the creating connection drops, and the phone only publishes ImgHandle
// while a session is connected. A one-shot `busctl call` therefore cannot work —
// hence bipart.py, a small python3-dbus helper that owns the connection and
// fetches images on request over a pipe.
let bipProc = null       // the running helper
let bipReady = false     // helper answered READY (session established)
let bipAvailable = null  // null = not probed, false = no cover art on this phone/BlueZ
let bipQueue = []        // pending fetches: { handle, key, tmp }
let bipLastMiss = ''     // last track logged as having no cover-art handle
let bipBusy = null       // the fetch currently in flight

function bipKill() {
  if (bipProc) { try { bipProc.kill('SIGTERM') } catch (e) {} }
  bipProc = null; bipReady = false; bipBusy = null; bipQueue = []
}
function bipReset() { bipKill(); bipAvailable = null }

// Start the helper for the connected phone (idempotent).
// Caveat worth knowing: BlueZ fetches a track's metadata when the phone connects,
// which is before this session exists, so the very first track after connecting
// can lack ImgHandle. It appears from the next track change onward.
async function bipEnsureSession() {
  if (!BT_ART || !btPlayerPath || !state.bluetooth.connected) return false
  if (bipProc) return bipReady
  if (bipAvailable === false) return false
  const pm = /q\s+(\d+)/.exec(await execP(`busctl --system get-property org.bluez ${btPlayerPath} org.bluez.MediaPlayer1 ObexPort 2>/dev/null`))
  const psm = pm ? Number(pm[1]) : 0
  if (!psm) { bipAvailable = false; return false } // old BlueZ, or no cover art on this player
  bipProc = spawn('python3', [BIP_HELPER, state.bluetooth.connected.mac, String(psm)], {
    stdio: ['pipe', 'pipe', 'pipe'], // keep stderr: python tracebacks are the only clue when a fetch stalls
    env: { ...process.env, XDG_RUNTIME_DIR: `/run/user/${OBEX_UID}`, DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${OBEX_UID}/bus` },
  })
  bipProc.stderr.on('data', (d) => console.error('bip helper stderr:', d.toString().trim()))
  bipProc.on('error', () => bipKill())
  bipProc.on('exit', () => { bipProc = null; bipReady = false; bipBusy = null })
  bipProc.stdin.on('error', () => {})
  let buf = ''
  bipProc.stdout.on('data', (d) => {
    buf += d.toString()
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
      if (!line) continue
      if (line === 'READY') { bipReady = true; bipAvailable = true; console.error('bip: session ready'); bipNext(); continue }
      if (line.startsWith('DEAD')) { console.error('bip helper:', line); bipKill(); continue }
      const done = bipBusy
      bipBusy = null
      if (done && line.startsWith('OK ')) bipStore(done)
      else if (line.startsWith('ERR')) console.error('bip fetch:', line, done ? done.handle : '')
      bipNext()
    }
  })
  return false // not ready yet; the next poll picks it up
}

// Move a completed transfer into the persistent cover cache.
function bipStore({ key, tmp }) {
  try {
    const b = fs.readFileSync(tmp)
    if (b.length) {
      fs.writeFileSync(artFile(key), b)
      artCache[key] = key
      currentArt = { key, buf: b, type: 'image/jpeg' }
    }
  } catch (e) {} finally { try { fs.unlinkSync(tmp) } catch (e) {} }
}

// One transfer at a time — AVRCP cover art over an OBEX channel is not something
// to run concurrently, and there's only ever one track on screen.
function bipNext() {
  if (!bipProc || !bipReady || bipBusy || !bipQueue.length) return
  bipBusy = bipQueue.shift()
  try { bipProc.stdin.write(`${bipBusy.handle} ${bipBusy.tmp}\n`) } catch (e) { bipBusy = null }
}

// Opportunistic look-ahead. Neither phone tested here exposes more than the current
// track in its browsable NowPlaying folder (the iPhone has no MediaFolder1 at all),
// so AVRCP gives no way to know the next track before it starts. Where a device
// *does* list upcoming items, their covers are pulled in the background so the art
// is already cached when the track flips. Capability is probed once per player.
let bipBrowse = null // null = unprobed, false = no queue on this phone
async function bipPrefetch() {
  if (!BT_ART || bipBrowse === false || !btPlayerPath || bipBusy || bipQueue.length) return
  const items = (await execP(`busctl --system tree org.bluez 2>/dev/null`))
    .match(new RegExp(btPlayerPath.replace(/\//g, '\\/') + '/NowPlaying/item[0-9]+', 'g')) || []
  if (items.length < 2) { if (bipBrowse === null) bipBrowse = items.length > 0; return }
  bipBrowse = true
  const cur = state.bluetooth.track
  for (const it of items.slice(0, 3)) {
    const md = await execP(`busctl --system get-property org.bluez ${it} org.bluez.MediaItem1 Metadata 2>/dev/null`)
    const title = btField(md, 'Title'), artist = btField(md, 'Artist'), img = btField(md, 'ImgHandle')
    if (!title || !img) continue
    if (cur && cur.title === title && cur.artist === artist) continue // that's the one playing
    const k = `${artist}|${title}`.toLowerCase()
    if (artCache[k] !== k) bipFetch(img, k)
  }
}

// Queue a fetch of one image handle into the cover cache under `key`.
function bipFetch(handle, key) {
  if (!BT_ART) return
  if (bipBusy && bipBusy.handle === handle) return
  if (bipQueue.some((q) => q.handle === handle)) return

  bipQueue.push({ handle, key, tmp: `${ART_DIR}/.bip-${crypto.createHash('md5').update(key).digest('hex')}` })
  if (bipQueue.length > 4) bipQueue = bipQueue.slice(-4) // only the recent tracks matter
  bipNext()
}

// AVRCP track metadata from BlueZ's system D-Bus (no extra deps).
let btPlayerPath = ''
let btControlPath = '' // device path when only the legacy MediaControl1 is available
let btLegacyPlaying = true // assumed play/pause state when there's no Status to read
// busctl escapes special chars as \c and non-ASCII bytes as octal \NNN; rebuild
// the byte sequence then decode UTF-8 (so apostrophes/accents come out right).
function busUnescape(s) {
  const bytes = []
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') {
      const n = s[i + 1]
      if (n >= '0' && n <= '7') { bytes.push(parseInt(s.substr(i + 1, 3), 8) & 0xff); i += 3 }
      else { bytes.push(n.charCodeAt(0)); i += 1 }
    } else bytes.push(s.charCodeAt(i) & 0xff)
  }
  return Buffer.from(bytes).toString('utf8')
}
// Pull one string entry out of a busctl-printed dict (e.g. the AVRCP Track dict).
function btField(out, key) {
  const m = new RegExp('"' + key + '" s "((?:\\\\.|[^"\\\\])*)"').exec(out)
  return m ? busUnescape(m[1]) : ''
}
let btTracking = false
async function btTrack() {
  if (btTracking) return
  btTracking = true
  try {
    if (!state.bluetooth.connected) { state.bluetooth.track = null; btPlayerPath = ''; bipReset(); return }
    if (!btPlayerPath) {
      const dev = 'dev_' + state.bluetooth.connected.mac.replace(/:/g, '_')
      const tree = await execP('busctl --system tree org.bluez 2>/dev/null')
      // 5.66 exposed .../dev_X/player0; 5.8x nests it under .../dev_X/avrcp/player0.
      // Match both so the service works on either BlueZ.
      const m = tree.match(new RegExp('/org/bluez/hci[0-9]+/' + dev + '(?:/avrcp)?/player[0-9]+'))
      btPlayerPath = m ? m[0] : ''
    }
    if (!btPlayerPath) {
      // Some phones (notably iOS here) keep the AVRCP control channel up without
      // BlueZ ever creating a MediaPlayer1 — no metadata, but the deprecated
      // MediaControl1 still drives play/pause/next/prev, so keep the buttons live.
      const devPath = '/org/bluez/hci0/dev_' + state.bluetooth.connected.mac.replace(/:/g, '_')
      const ctl = /b true/.test(await execP(`busctl --system get-property org.bluez ${devPath} org.bluez.MediaControl1 Connected 2>/dev/null`))
      btControlPath = ctl ? devPath : ''
      state.bluetooth.control = ctl ? 'legacy' : 'none'
      state.bluetooth.track = null
      return
    }
    btControlPath = ''
    state.bluetooth.control = 'full'
    // Open the cover-art channel *before* reading Track: ImgHandle only appears in
    // the metadata while the BIP session is up.
    await bipEnsureSession()
    const out = await execP(`busctl --system get-property org.bluez ${btPlayerPath} org.bluez.MediaPlayer1 Track 2>/dev/null`)
    if (!out) { btPlayerPath = ''; state.bluetooth.track = null; bipReset(); return }
    const title = btField(out, 'Title'), artist = btField(out, 'Artist'), album = btField(out, 'Album')
    const durM = /"Duration" u (\d+)/.exec(out); const duration = durM ? Number(durM[1]) : 0
    const status = (await execP(`busctl --system get-property org.bluez ${btPlayerPath} org.bluez.MediaPlayer1 Status 2>/dev/null`)).replace(/.*"(.*)".*/, '$1').trim()
    const pm = /u\s+(\d+)/.exec(await execP(`busctl --system get-property org.bluez ${btPlayerPath} org.bluez.MediaPlayer1 Position 2>/dev/null`))
    const position = pm ? Number(pm[1]) : 0
    state.bluetooth.shuffle = (await execP(`busctl --system get-property org.bluez ${btPlayerPath} org.bluez.MediaPlayer1 Shuffle 2>/dev/null`)).replace(/.*"(.*)".*/, '$1').trim() || 'off'
    state.bluetooth.repeat = (await execP(`busctl --system get-property org.bluez ${btPlayerPath} org.bluez.MediaPlayer1 Repeat 2>/dev/null`)).replace(/.*"(.*)".*/, '$1').trim() || 'off'
    if (title || artist) {
      const key = `${artist}|${title}`.toLowerCase()
      // The cover-art handle is usually NOT on the Track dict — it lives on the
      // browsable NowPlaying item, which Track points at via its "Item" path.
      // Only fetched when we don't already have this cover on disk.
      let img = btField(out, 'ImgHandle')
      if (!img && artCache[key] !== key) {
        const im = /"Item" o "([^"]+)"/.exec(out)
        if (im) img = btField(await execP(`busctl --system get-property org.bluez ${im[1]} org.bluez.MediaItem1 Metadata 2>/dev/null`), 'ImgHandle')
      }
      // Phone-supplied art wins; only fall back to the online lookup when the
      // phone offers no handle (or BlueZ is too old to expose one).
      if (!img && bipLastMiss !== key) { bipLastMiss = key; console.error('bip: no ImgHandle for', key) } // once per track, not per poll
      if (img && !(artCache[key] === key)) bipFetch(img, key)
      else if (!img && !(key in artCache)) fetchArt(artist, title)
      const artKey = typeof artCache[key] === 'string' ? artCache[key] : null
      const prev = state.bluetooth.track
      if (prev && prev.title && (prev.title !== title || prev.artist !== artist)) {
        const same = (x) => x.title === prev.title && x.artist === prev.artist
        state.bluetooth.history = [{ title: prev.title, artist: prev.artist, album: prev.album, artKey: prev.artKey },
          ...state.bluetooth.history.filter((x) => !same(x))].slice(0, 3)
      }
      // A cover that arrived after the track was first seen still belongs to it.
      const liveKey = typeof artCache[key] === 'string' ? artCache[key] : null
      state.bluetooth.track = { title, artist, album, status, artKey: liveKey || artKey, duration, position }
      if (liveKey) {
        const h = state.bluetooth.history.find((x) => x.title === title && x.artist === artist)
        if (h && !h.artKey) h.artKey = liveKey
      }
      bipPrefetch()
    } else state.bluetooth.track = null
  } catch (e) { btPlayerPath = ''; state.bluetooth.track = null } finally { btTracking = false }
}
// Scan the BT connection + battery on every tick regardless of source, so the
// Bluetooth source button reflects a phone connecting while you're on FM/Aux.
// Track (now-playing) metadata only matters while Bluetooth is the active source.
// Browse the phone's AVRCP "Now Playing" queue (if the phone exposes it) to show
// an up-next list. Fully async; heavier, so on a slower cadence.
let btQueueing = false
async function btQueue() {
  if (btQueueing || !btPlayerPath) return
  btQueueing = true
  try {
    const np = btPlayerPath + '/NowPlaying'
    await execP(`busctl --system call org.bluez ${np} org.bluez.MediaFolder1 ListItems a{sv} 0 2>/dev/null`)
    const tree = await execP('busctl --system tree org.bluez 2>/dev/null')
    const re = new RegExp(np.replace(/\//g, '\\/') + '/item[0-9]+', 'g')
    const items = [...new Set(tree.match(re) || [])]
      .sort((a, b) => Number(a.match(/item(\d+)/)[1]) - Number(b.match(/item(\d+)/)[1])).slice(0, 16)
    const q = []
    for (const it of items) {
      const md = await execP(`busctl --system get-property org.bluez ${it} org.bluez.MediaItem1 Metadata 2>/dev/null`)
      const title = btField(md, 'Title'), artist = btField(md, 'Artist')
      if (title) q.push({ title, artist })
    }
    state.bluetooth.queue = q
  } catch (e) {} finally { btQueueing = false }
}
// ---- Music-library browse (AVRCP Filesystem via MediaFolder1) ----
// The connected player's browsable folder tree lives under <PLAYER>/Filesystem.
// We ChangeFolder into the requested folder, ListItems to make BlueZ fetch them,
// then read each child MediaItem1. Requires the phone/app to expose MediaFolder1
// (state.bluetooth.browsable); iOS Music, notably, does not.
// Resolve the connected player's object path (reuse btTrack's derivation).
async function btResolvePlayer() {
  if (btPlayerPath) return btPlayerPath
  if (!state.bluetooth.connected) return ''
  const dev = 'dev_' + state.bluetooth.connected.mac.replace(/:/g, '_')
  const tree = await execP('busctl --system tree org.bluez 2>/dev/null')
  const m = tree.match(new RegExp('/org/bluez/hci[0-9]+/' + dev + '(?:/avrcp)?/player[0-9]+'))
  return m ? m[0] : ''
}
let btBrowsing = false // single-flight, like the other scanners
async function btBrowse(pathParam) {
  if (btBrowsing) return { ok: false, reason: 'busy' }
  // Sanitize: only 'root' or a BlueZ object path is ever shelled out.
  if (pathParam !== 'root' && !/^\/org\/bluez\/[A-Za-z0-9_/]+$/.test(pathParam || '')) pathParam = 'root'
  btBrowsing = true
  try {
    const player = await btResolvePlayer()
    if (!player) return { ok: false, reason: 'not-browsable' }
    if (!/MediaFolder1/.test(await execP(`busctl --system introspect org.bluez ${player} 2>/dev/null`))) return { ok: false, reason: 'not-browsable' }
    const target = pathParam === 'root' ? `${player}/Filesystem` : pathParam
    // Navigate + trigger the fetch (both no-ops / harmless if already there).
    await execP(`busctl --system call org.bluez ${player} org.bluez.MediaFolder1 ChangeFolder o ${target} 2>/dev/null`)
    await execP(`busctl --system call org.bluez ${player} org.bluez.MediaFolder1 ListItems a{sv} 0 2>/dev/null`)
    await new Promise((r) => setTimeout(r, 800)) // let BlueZ populate the child objects
    // Direct children of the target folder: <target>/itemN (not deeper nestings).
    const tree = await execP('busctl --system tree org.bluez 2>/dev/null')
    const childRe = new RegExp('^' + target.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/item[0-9]+$')
    const paths = []
    for (const line of tree.split('\n')) {
      const m = line.match(/\/org\/bluez\/\S+/)
      if (m && childRe.test(m[0]) && !paths.includes(m[0])) paths.push(m[0])
    }
    paths.sort((a, b) => Number(a.match(/item(\d+)$/)[1]) - Number(b.match(/item(\d+)$/)[1]))
    const items = []
    for (const it of paths) {
      // One call, five properties — busctl prints them in the requested order.
      const out = await execP(`busctl --system get-property org.bluez ${it} org.bluez.MediaItem1 Name Type FolderType Metadata Playable 2>/dev/null`)
      const lines = out.split('\n').filter((l) => l.trim())
      // The three bare strings come back in order: Name, Type, FolderType.
      const strs = lines.filter((l) => /^s /.test(l)).map((l) => { const m = /^s "((?:\\.|[^"\\])*)"/.exec(l); return m ? busUnescape(m[1]) : '' })
      const rawType = strs[1] || 'audio'
      const type = rawType === 'folder' || rawType === 'video' ? rawType : 'audio'
      const md = lines.find((l) => /^a\{sv\}/.test(l)) || '' // Metadata dict → Title/Artist
      // Folder names arrive as the full virtual path ("/Filesystem/YouTube
      // Music/Home"); show just the leaf. Leaf/track names have no slash.
      const rawName = strs[0] || ''
      const name = rawName.startsWith('/') ? rawName.slice(rawName.lastIndexOf('/') + 1) : rawName
      items.push({
        path: it, name, type, folderType: strs[2] || '',
        artist: btField(md, 'Artist'), title: btField(md, 'Title'),
        playable: /^b true/.test(lines.find((l) => /^b /.test(l)) || ''),
      })
    }
    return { ok: true, path: target, items }
  } catch (e) { return { ok: false, reason: 'error' } } finally { btBrowsing = false }
}

setInterval(() => { btScan(); if (state.source === 'Bluetooth' || state.bluetooth.pairing) btTrack() }, 1500)
// NOTE: btQueue() disabled — this phone/app only exposes the *current* track in
// its browsable NowPlaying folder, not upcoming tracks, so there's no up-next list
// to show. Re-enable if a device that exposes a full queue is used.

// AVRCP transport control (Play/Pause/Next/Previous) via BlueZ system D-Bus. Async
// so a transport tap never blocks the event loop / spectrum feed.
function btPlayerCmd(method) {
  if (btPlayerPath) {
    exec(`busctl --system call org.bluez ${btPlayerPath} org.bluez.MediaPlayer1 ${method} 2>/dev/null`, () => {})
  } else if (btControlPath) {
    // MediaControl1 has no Status/metadata, but Play/Pause/Next/Previous work.
    exec(`busctl --system call org.bluez ${btControlPath} org.bluez.MediaControl1 ${method} 2>/dev/null`, () => {})
  } else return
  setTimeout(btTrack, 500)
}
// Set an AVRCP MediaPlayer1 property (Shuffle/Repeat). Optimistic + async.
function btPlayerSet(prop, val) {
  if (!btPlayerPath) return
  if (prop === 'Shuffle') state.bluetooth.shuffle = val
  if (prop === 'Repeat') state.bluetooth.repeat = val
  exec(`busctl --system set-property org.bluez ${btPlayerPath} org.bluez.MediaPlayer1 ${prop} s "${val}" 2>/dev/null`, () => {})
  setTimeout(btTrack, 600)
}
// Relative seek by N seconds. AVRCP has no set-position, so we FastForward/Rewind
// (the only in-track movement) and Release once Position crosses the target — a
// closed loop, so it's accurate regardless of the app's fast-forward speed.
let btSeeking = false
async function btSeek(sec) {
  const tr = state.bluetooth.track
  if (btSeeking || !btPlayerPath || !tr) return
  btSeeking = true
  try {
    const start = tr.position || 0, dur = tr.duration || 0
    let target = start + sec * 1000
    if (target < 0) target = 0
    if (dur && target > dur - 1500) target = dur - 1500
    const method = sec >= 0 ? 'FastForward' : 'Rewind'
    await execP(`busctl --system call org.bluez ${btPlayerPath} org.bluez.MediaPlayer1 ${method} 2>/dev/null`)
    const deadline = Date.now() + 20000 // safety cap if FF is very slow / stalls
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 150))
      const pm = /u\s+(\d+)/.exec(await execP(`busctl --system get-property org.bluez ${btPlayerPath} org.bluez.MediaPlayer1 Position 2>/dev/null`))
      if (!pm) break
      const pos = Number(pm[1])
      if (sec >= 0 ? pos >= target : pos <= target) break
    }
    await execP(`busctl --system call org.bluez ${btPlayerPath} org.bluez.MediaPlayer1 Release 2>/dev/null`)
    setTimeout(btTrack, 300)
  } catch (e) {} finally { btSeeking = false }
}

const clampFm = (f) => { f = Math.round(f * 10) / 10; if (f > 107.9) return 87.5; if (f < 87.5) return 107.9; return f }

const actions = {
  power: (b) => { state.power = !!b.on; state.power ? scheduleStart() : stopRadio(); applyAudioTaps() },
  source: (b) => {
    const prev = state.source
    if (b.source) state.source = b.source
    state.power = true // no power button anymore: picking a source powers on
    // Leaving Bluetooth -> pause the phone so it doesn't keep streaming into the aux.
    if (prev === 'Bluetooth' && state.source !== 'Bluetooth' && state.bluetooth.track && state.bluetooth.track.status === 'playing') btPlayerCmd('Pause')
    // Returning to Bluetooth -> resume the phone so music starts again.
    if (prev !== 'Bluetooth' && state.source === 'Bluetooth' && state.bluetooth.connected) btPlayerCmd('Play')
    scheduleStart()
    applyAudioTaps()
  },
  tune: (b) => { state.fm.freq = clampFm(Number(b.freq)); if (state.power) scheduleStart() },
  seek: (b) => { state.fm.freq = clampFm(state.fm.freq + (b.dir > 0 ? 0.2 : -0.2)); if (state.power) scheduleStart() },
  preset: (b) => { const p = state.fm.presets[b.i]; if (p) { state.fm.freq = p.freq; if (state.power) scheduleStart() } },
  savePreset: (b) => {
    const f = clampFm(Number(b.freq != null ? b.freq : state.fm.freq))
    if (!state.fm.presets.some((p) => Math.abs(p.freq - f) < 0.05)) {
      state.fm.presets = [...state.fm.presets, { freq: f, name: state.nowPlaying.title || '', pty: state.nowPlaying.pty || '' }].sort((a, b) => a.freq - b.freq); savePresets()
    }
  },
  removePreset: (b) => { if (b.i >= 0 && b.i < state.fm.presets.length) { state.fm.presets.splice(b.i, 1); savePresets() } },
  renamePreset: (b) => {
    const p = state.fm.presets[b.i]
    if (p) { const nm = String(b.name || '').slice(0, 24).trim(); p.name = nm; p.manual = !!nm; savePresets() }
  },
  volume: (b) => { state.volume = Math.max(0, Math.min(30, Math.round(Number(b.volume)))); state.muted = false; applyVolume() },
  mute: (b) => { state.muted = !!b.muted; applyVolume() },
  settings: (b) => {
    const s = state.settings
    if (b.gain !== undefined) s.gain = Math.max(-1, Math.min(49.6, Number(b.gain)))
    if (b.deemp !== undefined) s.deemp = !!b.deemp
    if (b.filter !== undefined) s.filter = !!b.filter
    if (b.squelch !== undefined) s.squelch = Math.max(0, Math.round(Number(b.squelch)))
    if (b.ppm !== undefined) s.ppm = Math.round(Number(b.ppm))
    if (b.auxChannels !== undefined) s.auxChannels = b.auxChannels === 'mono' ? 'mono' : 'stereo'
    if (b.gain !== undefined || b.deemp !== undefined || b.filter !== undefined || b.squelch !== undefined || b.ppm !== undefined) { if (state.power) scheduleStart() }
  },
  btPair: async () => {
    await setAdapterProp('DiscoverableTimeout', 'u', String(PAIR_WINDOW))
    await setAdapterProp('Pairable', 'b', 'true')
    await setAdapterProp('Discoverable', 'b', 'true')
    state.bluetooth.pairing = true
    clearTimeout(btPairTimer)
    state.bluetooth.pairUntil = Date.now() + PAIR_WINDOW * 1000 // lets the helm count down
    state.bluetooth.pairedNew = null
    pairBaseline = new Set((state.bluetooth.devices || []).map((d) => d.mac))
    btPairTimer = setTimeout(() => { setAdapterProp('Discoverable', 'b', 'false'); state.bluetooth.pairing = false; state.bluetooth.pairUntil = 0 }, PAIR_WINDOW * 1000)
    btScan()
  },
  btConnect: (b) => { if (b.mac) btDoConnect(b.mac) },
  btForget: (b) => { if (b.mac) btForget(b.mac) },
  btDisconnect: () => {
    if (!state.bluetooth.connected) return
    const p = '/org/bluez/hci0/dev_' + state.bluetooth.connected.mac.replace(/:/g, '_')
    execX(`busctl --system call org.bluez ${p} org.bluez.Device1 Disconnect`).then(() => btScan())
  },
  btCancelPair: () => { setAdapterProp('Discoverable', 'b', 'false'); state.bluetooth.pairing = false; state.bluetooth.pairUntil = 0; state.bluetooth.pairedNew = null; clearTimeout(btPairTimer) },
  btPlayPause: () => {
    const t = state.bluetooth.track
    // No metadata (legacy control) means no Status to read; assume playing, since
    // that's when someone reaches for the button.
    if (!t && btControlPath) return btPlayerCmd(btLegacyPlaying ? 'Pause' : 'Play') || (btLegacyPlaying = !btLegacyPlaying)
    btPlayerCmd(t && t.status === 'playing' ? 'Pause' : 'Play')
  },
  btNext: () => btPlayerCmd('Next'),
  btPrev: () => btPlayerCmd('Previous'),
  btShuffle: () => btPlayerSet('Shuffle', (state.bluetooth.shuffle && state.bluetooth.shuffle !== 'off') ? 'off' : 'alltracks'),
  // Toggle off <-> repeat-one. (Many phone apps time out on "alltracks" over AVRCP
  // and that failure jams the next command, so we avoid it.)
  btRepeat: () => btPlayerSet('Repeat', (state.bluetooth.repeat && state.bluetooth.repeat !== 'off') ? 'off' : 'singletrack'),
  btSeek: (b) => btSeek(Number(b.sec) || 0), // relative seek in seconds (-15 / +30)
}


// ---- system health (the helm's System settings tab) ----
// Everything here is read from /proc + /sys, which is cheap enough to serve on
// demand; only the throttling flags need a vcgencmd, so they're cached.
let cpuPrev = null, throttleCache = { at: 0, raw: '' }
function cpuSnapshot() {
  try {
    const cores = []
    for (const line of fs.readFileSync('/proc/stat', 'utf8').split('\n')) {
      if (!/^cpu[0-9]* /.test(line)) continue
      const n = line.trim().split(/\s+/).slice(1).map(Number)
      const idle = n[3] + (n[4] || 0), total = n.reduce((a, b) => a + b, 0)
      cores.push({ idle, total })
    }
    return cores
  } catch (e) { return [] }
}
// CPU % is a delta between calls, so the first poll after a restart reads 0.
function cpuPercent() {
  const now = cpuSnapshot()
  const prev = cpuPrev
  cpuPrev = now
  if (!prev || prev.length !== now.length) return { total: 0, cores: [] }
  const pct = now.map((c, i) => {
    const dt = c.total - prev[i].total, di = c.idle - prev[i].idle
    return dt <= 0 ? 0 : Math.max(0, Math.min(100, Math.round((1 - di / dt) * 100)))
  })
  return { total: pct[0] || 0, cores: pct.slice(1) }
}
function meminfo() {
  const m = {}
  try {
    for (const line of fs.readFileSync('/proc/meminfo', 'utf8').split('\n')) {
      const x = /^(\w+):\s+(\d+)/.exec(line)
      if (x) m[x[1]] = Number(x[2]) * 1024
    }
  } catch (e) {}
  return { total: m.MemTotal || 0, available: m.MemAvailable || 0, free: m.MemFree || 0,
    cached: (m.Cached || 0) + (m.Buffers || 0), swapTotal: m.SwapTotal || 0, swapFree: m.SwapFree || 0 }
}
function cpuTemp() {
  try { return Math.round(Number(fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8')) / 100) / 10 } catch (e) { return 0 }
}
// vcgencmd get_throttled is a bitmask: low bits = happening now, bits 16+ = has
// happened since boot. Under-voltage on a boat usually means the supply, so it's
// worth surfacing rather than hiding.
function decodeThrottle(raw) {
  const v = parseInt((raw.split('=')[1] || '0x0').trim(), 16) || 0
  return {
    raw: v, ok: v === 0,
    now: { underVoltage: !!(v & 0x1), freqCapped: !!(v & 0x2), throttled: !!(v & 0x4), softTempLimit: !!(v & 0x8) },
    since: { underVoltage: !!(v & 0x10000), freqCapped: !!(v & 0x20000), throttled: !!(v & 0x40000), softTempLimit: !!(v & 0x80000) },
  }
}
async function systemInfo() {
  const [dfOut, procOut] = await Promise.all([
    execP('df -P -k / 2>/dev/null'),
    execP('ps -eo pcpu,pmem,comm --sort=-pcpu --no-headers 2>/dev/null | head -6'),
  ])
  if (Date.now() - throttleCache.at > 15000) {
    throttleCache = { at: Date.now(), raw: await execP('vcgencmd get_throttled 2>/dev/null') }
  }
  const d = (dfOut.split('\n')[1] || '').trim().split(/\s+/)
  const disk = d.length >= 4
    ? { total: Number(d[1]) * 1024, used: Number(d[2]) * 1024, free: Number(d[3]) * 1024 }
    : { total: 0, used: 0, free: 0 }
  const top = procOut.split('\n').filter(Boolean).map((l) => {
    const m = l.trim().match(/^([\d.]+)\s+([\d.]+)\s+(.+)$/)
    return m ? { cpu: Number(m[1]), mem: Number(m[2]), name: m[3] } : null
  }).filter(Boolean)
  let loads = [0, 0, 0]
  try { loads = fs.readFileSync('/proc/loadavg', 'utf8').split(' ').slice(0, 3).map(Number) } catch (e) {}
  return {
    cpu: cpuPercent(), load: loads, cores: require('os').cpus().length,
    mem: meminfo(), disk, temp: cpuTemp(), throttle: decodeThrottle(throttleCache.raw),
    uptime: Math.floor(require('os').uptime()), host: require('os').hostname(), top,
  }
}

// ---- Network: view/adjust IPv4 (DHCP vs static) and Wi-Fi via NetworkManager. ----
// eth0 = LAN, wlan0 = Wi-Fi. can0 is the NMEA2000 bus and is intentionally ignored.
const NET_IFACES = [
  { device: 'eth0', label: 'LAN', type: 'ethernet', nmType: '802-3-ethernet' },
  { device: 'wlan0', label: 'Wi-Fi', type: 'wifi', nmType: '802-11-wireless' },
]
const IP_RE = /^\d{1,3}(\.\d{1,3}){3}$/

// nmcli -t escapes ':' inside values as '\:'; join fields back on the FIRST ':' only.
function nmSplit1(line) { const i = line.indexOf(':'); return i < 0 ? [line, ''] : [line.slice(0, i), line.slice(i + 1).replace(/\\:/g, ':')] }

async function resolveConn(dev, nmType) {
  const active = (await execP(`nmcli -t -g GENERAL.CONNECTION device show ${dev} 2>/dev/null`)).trim()
  if (active && active !== '--') return active
  const out = await execP('nmcli -t -f NAME,TYPE,DEVICE connection show 2>/dev/null')
  const rows = out.split('\n').filter(Boolean).map((l) => l.split(':'))
  const byDev = rows.find((r) => r[2] === dev)
  if (byDev) return byDev[0]
  const byType = rows.find((r) => r[1] === nmType)
  return byType ? byType[0] : ''
}

async function ifaceDetail({ device, label, type, nmType }) {
  const show = await execP(`nmcli -t -f GENERAL.STATE,GENERAL.CONNECTION,GENERAL.HWADDR,IP4.ADDRESS,IP4.GATEWAY,IP4.DNS device show ${device} 2>/dev/null`)
  const lines = show.split('\n').filter(Boolean).map(nmSplit1)
  const g = (k) => { const m = lines.find(([kk]) => kk === k); return m ? m[1] : '' }
  const multi = (k) => lines.filter(([kk]) => kk.startsWith(k + '[')).map(([, v]) => v)
  const conn = g('GENERAL.CONNECTION')
  let method = 'auto'
  if (conn && conn !== '--') { const m = (await execP(`nmcli -t -g ipv4.method connection show "${conn}" 2>/dev/null`)).trim(); if (m) method = m }
  const stateRaw = g('GENERAL.STATE') // e.g. "100 (connected)"
  return {
    device, label, type,
    connection: conn && conn !== '--' ? conn : '',
    state: (stateRaw.match(/\(([^)]+)\)/) || [, stateRaw || 'unknown'])[1],
    mac: g('GENERAL.HWADDR'),
    method,
    addresses: multi('IP4.ADDRESS'),
    gateway: g('IP4.GATEWAY'),
    dns: multi('IP4.DNS'),
    ssid: type === 'wifi' && conn && conn !== '--' ? conn : '',
  }
}

async function networkInfo() {
  const interfaces = await Promise.all(NET_IFACES.map(ifaceDetail))
  return { interfaces }
}

async function setIpv4(b) {
  const dev = String(b.device || '')
  const spec = NET_IFACES.find((i) => i.device === dev)
  if (!spec) return { ok: false, reason: 'bad-device' }
  const method = b.method === 'manual' ? 'manual' : 'auto'
  let conn = await resolveConn(dev, spec.nmType)
  if (!conn) {
    if (spec.type === 'ethernet') { await execFileP('sudo', ['nmcli', 'connection', 'add', 'type', 'ethernet', 'ifname', 'eth0', 'con-name', 'LAN']); conn = 'LAN' }
    else return { ok: false, reason: 'no-connection' }
  }
  const args = ['nmcli', 'connection', 'modify', conn]
  if (method === 'manual') {
    const ip = String(b.address || ''); const prefix = String(b.prefix || '24'); const gw = String(b.gateway || ''); const dns = String(b.dns || '').trim()
    if (!IP_RE.test(ip)) return { ok: false, reason: 'bad-ip' }
    if (!/^\d{1,2}$/.test(prefix) || Number(prefix) > 32) return { ok: false, reason: 'bad-prefix' }
    if (gw && !IP_RE.test(gw)) return { ok: false, reason: 'bad-gateway' }
    const dnsList = dns.split(/[\s,]+/).filter(Boolean)
    if (dnsList.some((d) => !IP_RE.test(d))) return { ok: false, reason: 'bad-dns' }
    args.push('ipv4.method', 'manual', 'ipv4.addresses', `${ip}/${prefix}`, 'ipv4.gateway', gw, 'ipv4.dns', dnsList.join(' '))
  } else {
    args.push('ipv4.method', 'auto', 'ipv4.addresses', '', 'ipv4.gateway', '', 'ipv4.dns', '')
  }
  const mod = await execFileP('sudo', args)
  if (!mod.ok) return { ok: false, reason: 'modify-failed', err: mod.err.slice(0, 300) }
  const up = await execFileP('sudo', ['nmcli', 'connection', 'up', conn])
  return { ok: up.ok, reason: up.ok ? '' : 'apply-failed', err: up.ok ? '' : up.err.slice(0, 300) }
}

async function wifiScan() {
  await execP('nmcli device wifi rescan 2>/dev/null').catch(() => {})
  const out = await execP('nmcli -t -f IN-USE,SSID,SIGNAL,SECURITY device wifi list 2>/dev/null')
  const seen = new Map()
  for (const line of out.split('\n').filter(Boolean)) {
    // fields: IN-USE:SSID:SIGNAL:SECURITY  (SSID may contain escaped ':')
    const parts = line.split(':')
    const inUse = parts[0] === '*'
    const security = parts[parts.length - 1]
    const signal = Number(parts[parts.length - 2])
    const ssid = parts.slice(1, parts.length - 2).join(':').replace(/\\:/g, ':')
    if (!ssid) continue
    const prev = seen.get(ssid)
    if (!prev || signal > prev.signal) seen.set(ssid, { ssid, signal, security, inUse: inUse || (prev && prev.inUse) })
  }
  return { networks: [...seen.values()].sort((a, b) => b.signal - a.signal) }
}

// ---- Wi-Fi positioning: a coarse fallback for when the GPS has no fix -------------
// Looks up nearby access points by BSSID in a public geolocation database. Accuracy is
// 20-150 m near shore and it returns nothing offshore where there are no APs, so it is
// deliberately NOT published to SignalK as navigation.position — a coarse estimate that
// looks authoritative would corrupt the plotter, the trip log and any anchor alarm.
// It is used for exactly two things: showing an approximate position on screen while
// acquiring, and seeding GPS startup aiding (where +/-100 m is far better than a static
// home coordinate).
//
// Privacy: this sends the MAC addresses of nearby access points to a third party. It runs
// only while there is no GPS fix, at most every WIFI_LOC_EVERY seconds. Set WIFI_LOC=0 to
// disable entirely.
const WIFI_LOC_ON = process.env.WIFI_LOC !== '0'
const WIFI_LOC_URL = process.env.WIFI_LOC_URL || 'https://api.beacondb.net/v1/geolocate'
const WIFI_LOC_EVERY = Number(process.env.WIFI_LOC_EVERY || 300) * 1000
const WIFI_POS_FILE = `${__dirname}/wifipos.json`
let wifiFix = null      // { lat, lon, accuracy, ts, aps }
let wifiLastTry = 0
let wifiLastError = null

// Scan without --rescan: a forced rescan briefly drops the link this Pi is reachable on.
// NetworkManager refreshes its cache on its own, which is plenty for a 5-minute cadence.
async function wifiAccessPoints(allowRescan = true) {
  let out = await execP('nmcli -t -f BSSID,SIGNAL device wifi list 2>/dev/null')
  // A cached scan often holds only the connected AP, which is useless for triangulation.
  // Force a rescan only in that case: it briefly interrupts wlan0, which matters when
  // that link is a phone tether. The helm itself talks to localhost, so the display is
  // unaffected either way. Rate-limited by the 5-minute caller cadence.
  if (allowRescan && (out.match(/\n/g) || []).length < 3) {
    // sudo is load-bearing: an unprivileged rescan is refused by polkit and fails
    // silently, leaving the stale single-AP cache that made this look like a dead radio.
    await execP('sudo nmcli device wifi rescan 2>/dev/null').catch(() => {})
    await new Promise((r) => setTimeout(r, 5000))
    out = await execP('nmcli -t -f BSSID,SIGNAL device wifi list 2>/dev/null')
  }
  const aps = []
  for (const line of out.split('\n').filter(Boolean)) {
    // nmcli escapes the MAC's colons as "\:" in terse output.
    const m = line.match(/^((?:[0-9A-Fa-f]{2}\\?:){5}[0-9A-Fa-f]{2}):(\d+)\s*$/)
    if (!m) continue
    const mac = m[1].replace(/\\/g, '').toUpperCase()
    if (/^00:00:00/.test(mac)) continue
    // nmcli reports 0-100%; the geolocation API wants dBm.
    const dbm = Math.round(Number(m[2]) / 2 - 100)
    aps.push({ macAddress: mac, signalStrength: dbm })
  }
  return aps
}

async function wifiLocate() {
  const aps = await wifiAccessPoints()
  // Two is the practical minimum: one AP gives the provider nothing to triangulate with,
  // and single-AP answers are wrong often enough to be dangerous on the water.
  if (aps.length < 2) { wifiLastError = `only ${aps.length} access points visible`; return null }
  const body = JSON.stringify({ considerIp: false, wifiAccessPoints: aps })
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 12000)
    const r = await fetch(WIFI_LOC_URL, {
      method: 'POST', signal: ctrl.signal, body,
      // beaconDB asks clients to identify themselves rather than carry an API key.
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'openMarine-helm/1.0 (boat navigation fallback)' },
    })
    clearTimeout(t)
    if (!r.ok) {
      // In the MLS/Ichnaea API a 404 is not a failure — it means the database has no
      // entry for these access points. Distinguish it, because "nobody has mapped this
      // marina" needs a different response than "the service is down".
      wifiLastError = r.status === 404
        ? `no coverage: the database doesn't know these ${aps.length} access points`
        : `provider HTTP ${r.status}`
      return null
    }
    const j = await r.json()
    const lat = j && j.location && Number(j.location.lat)
    const lon = j && j.location && Number(j.location.lng)
    if (!isFinite(lat) || !isFinite(lon)) { wifiLastError = 'no location in response'; return null }
    wifiLastError = null
    wifiFix = { lat, lon, accuracy: Number(j.accuracy) || null, ts: Date.now(), aps: aps.length }
    // Hand it to gps.py for startup aiding. Written atomically so a crash mid-write
    // can't leave a truncated file that would seed the receiver with nonsense.
    try {
      fs.writeFileSync(`${WIFI_POS_FILE}.tmp`, JSON.stringify(wifiFix))
      fs.renameSync(`${WIFI_POS_FILE}.tmp`, WIFI_POS_FILE)
    } catch (e) { /* non-fatal */ }
    return wifiFix
  } catch (e) {
    wifiLastError = e && e.name === 'AbortError' ? 'provider timeout (no internet?)' : String(e.message || e)
    return null
  }
}

// Only while the GPS has nothing. The moment it fixes, this stops running entirely.
setInterval(() => {
  if (!WIFI_LOC_ON) return
  if ((gpsState.fix || 0) >= 1) return
  if (Date.now() - wifiLastTry < WIFI_LOC_EVERY) return
  wifiLastTry = Date.now()
  wifiLocate().catch(() => {})
}, 30000)

// ---- AssistNow orbit refresh, run from the boat ----------------------------------
// Mirrors ansible/maintenance.yml so the helm can do it without a laptop. Validates
// before overwriting: a marina captive portal answers HTTP 200 with a login page, and
// silently replacing good aiding data with HTML is exactly the failure you'd only
// discover on a cold morning with no fix.
const ORBIT_FILE = `${__dirname}/mga-offline.ubx`
const ASSIST_CREDS = process.env.GPS_ASSIST_CREDS || '/home/pi/assistnow-credentials.json'
// The free Predictive Orbits tier is quota-limited (403003). Each file already covers 14
// days, so re-downloading a fresh one buys nothing and can lock you out right when you
// need it. Skip unless the data is genuinely aging, or the caller insists.
const ORBIT_MIN_AGE_MS = 12 * 3600 * 1000
function orbitFileInfo() {
  try {
    const st = fs.statSync(ORBIT_FILE)
    return { exists: true, ageMs: Date.now() - st.mtimeMs, bytes: st.size }
  } catch (e) { return { exists: false, ageMs: Infinity, bytes: 0 } }
}
async function refreshOrbits(force = false) {
  let chip = process.env.GPS_ASSIST_CHIPCODE || null
  try { chip = JSON.parse(fs.readFileSync(ASSIST_CREDS, 'utf8')).chipcode || chip } catch (e) { /* env may still have it */ }
  if (!chip) return { ok: false, error: 'no AssistNow chipcode configured' }
  const info = orbitFileInfo()
  if (!force && info.exists && info.ageMs < ORBIT_MIN_AGE_MS) {
    return {
      ok: true, skipped: true, ageH: Math.round(info.ageMs / 3600000),
      error: null, note: 'current data is recent — skipped to preserve the free download quota',
    }
  }
  const url = 'https://assistnow.services.u-blox.com/GetAssistNowData.ashx'
    + `?chipcode=${encodeURIComponent(chip)}&gnss=gps,gal,bds,glo&data=uporb_14,ualm`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 60000)
  let buf
  try {
    const r = await fetch(url, { signal: ctrl.signal })
    clearTimeout(timer)
    if (!r.ok) {
      // u-blox returns a JSON error body; 403003 is the free-tier quota, which is a
      // "come back later" rather than anything broken.
      let detail = `HTTP ${r.status}`
      try {
        const j = JSON.parse(await r.text())
        if (j && j.Message) detail = j.ErrorCode === 403003 ? 'download quota reached — try again tomorrow; existing data is still valid' : j.Message
      } catch (e) { /* keep the status */ }
      return { ok: false, error: detail }
    }
    buf = Buffer.from(await r.arrayBuffer())
  } catch (e) {
    clearTimeout(timer)
    return { ok: false, error: e && e.name === 'AbortError' ? 'timed out — no internet?' : String(e.message || e) }
  }
  if (buf.length < 10000 || buf[0] !== 0xb5 || buf[1] !== 0x62) {
    return { ok: false, error: `not UBX data (${buf.length} bytes) — captive portal?` }
  }
  const days = new Map()
  for (let i = 0; i + 8 <= buf.length;) {
    if (buf[i] !== 0xb5 || buf[i + 1] !== 0x62) { i++; continue }
    const ln = buf.readUInt16LE(i + 4)
    if (i + 6 + ln + 2 > buf.length) break
    if (buf[i + 2] === 0x13 && buf[i + 3] === 0x20 && ln >= 8) {
      const p = buf.subarray(i + 6, i + 6 + ln)
      const key = `20${String(p[4]).padStart(2, '0')}-${String(p[5]).padStart(2, '0')}-${String(p[6]).padStart(2, '0')}`
      days.set(key, (days.get(key) || 0) + 1)
    }
    i += 6 + ln + 2
  }
  if (!days.size) return { ok: false, error: 'no orbit records in the download' }
  try {
    fs.writeFileSync(`${ORBIT_FILE}.tmp`, buf)
    fs.renameSync(`${ORBIT_FILE}.tmp`, ORBIT_FILE)
  } catch (e) {
    return { ok: false, error: `could not save: ${e.message}` }
  }
  // Bounce just the GPS helper so it injects today's records; the stereo keeps playing.
  try { if (gpsProc) gpsProc.kill() } catch (e) { /* respawns on its own */ }
  const sorted = [...days.keys()].sort()
  return {
    ok: true, bytes: buf.length, days: days.size,
    records: [...days.values()].reduce((a, b) => a + b, 0),
    from: sorted[0], to: sorted[sorted.length - 1],
  }
}

async function wifiConnect(b) {
  const ssid = String(b.ssid || '')
  const pw = String(b.password || '')
  if (!ssid) return { ok: false, reason: 'no-ssid' }
  const args = ['nmcli', 'device', 'wifi', 'connect', ssid]
  if (pw) args.push('password', pw)
  const r = await execFileP('sudo', args)
  return { ok: r.ok, reason: r.ok ? '' : 'connect-failed', err: r.ok ? '' : r.err.slice(0, 300) }
}

// ---- HTTP + SSE ----
const sseClients = new Set()
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }

  const path = new URL(req.url, 'http://x').pathname
  // Album art pushed from the phone over local wifi (offline-friendly): a phone
  // automation POSTs the current MediaSession artwork here as the raw image body,
  // with ?artist=&title=. Stored in the same on-disk cover cache the helm reads.
  if (req.method === 'POST' && path === '/api/pushart') {
    const u = new URL(req.url, 'http://x')
    const artist = u.searchParams.get('artist') || ''
    const title = u.searchParams.get('title') || ''
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const buf = Buffer.concat(chunks)
      if (title && buf.length > 200) {
        const key = `${artist}|${title}`.toLowerCase()
        try { fs.writeFileSync(artFile(key), buf) } catch (e) {}
        artCache[key] = key
        currentArt = { key, buf, type: 'image/jpeg' }
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok')
    })
    req.on('error', () => { res.writeHead(400); res.end('err') })
    return
  }
  if (req.method === 'GET' && path === '/api/spectrum') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' })
    res.write(': ok\n\n')
    sseClients.add(res)
    req.on('close', () => sseClients.delete(res))
    return
  }
  if (req.method === 'GET' && path === '/api/art') {
    const k = decodeURIComponent((req.url.split('k=')[1] || '').split('&')[0] || '')
    // Serve the requested cover from the persistent disk cache.
    if (k) { try { const buf = fs.readFileSync(artFile(k)); if (buf.length) { res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=604800' }); return res.end(buf) } } catch (e) {} }
    if (currentArt.buf && (!k || currentArt.key === k)) { res.writeHead(200, { 'Content-Type': currentArt.type, 'Cache-Control': 'public, max-age=86400' }); return res.end(currentArt.buf) }
    res.writeHead(404); return res.end('no art')
  }
  if (req.method === 'GET' && path === '/api/imu') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ...(attitude || {}), tempC: ambientC, htuC, humidity, shtC, shtHumidity, headingMag }))
    return
  }
  // Sensor history for the helm's charts. ?minutes=N trims the window (default 60).
  // Returns whole samples so every series shares one timebase — the client just picks
  // the keys it wants to plot.
  if (req.method === 'GET' && path === '/api/history') {
    const mins = Math.max(1, Math.min(360, Number(new URL(req.url, 'http://x').searchParams.get('minutes')) || 60))
    const since = Date.now() - mins * 60000
    const rows = sensorHist.filter((s) => s.t >= since)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ stepMs: HIST_STEP_MS, minutes: mins, samples: rows }))
    return
  }
  // Refresh AssistNow predictive orbits from the boat itself — same job as
  // `npm run maintain -- --tags gps-orbits`, but runnable from the helm with no laptop.
  if (req.method === 'POST' && path === '/api/orbits/refresh') {
    const force = new URL(req.url, 'http://x').searchParams.get('force') === '1'
    refreshOrbits(force).then((r) => {
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(r))
    }).catch((e) => {
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: String(e.message || e) }))
    })
    return
  }
  // Screen off. DPMS wakes on any touch, so there's no "wake" endpoint to get wrong —
  // and no way to end up with a dark screen you can't recover without a keyboard.
  if (req.method === 'POST' && path === '/api/system/sleep') {
    execP('DISPLAY=:0 XAUTHORITY=/home/pi/.Xauthority xset dpms force off 2>&1')
      .then(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}') })
    return
  }
  if (req.method === 'POST' && path === '/api/system/reboot') {
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}')
    // Answer first, then go down — otherwise the helm never sees the acknowledgement.
    setTimeout(() => { execP('sudo systemctl reboot') }, 600)
    return
  }
  // Magnetometer (compass) calibration, driven from the helm instead of over SSH. Runs
  // imu.py's --calibrate-mag as a child; the main imu.py keeps running and both read the
  // bus — the kernel serialises I2C, so they coexist.
  if (req.method === 'POST' && path === '/api/imu/calibrate-mag') {
    if (magCal.running) {
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'already running' }))
      return
    }
    const secs = Math.max(20, Math.min(180, Number(new URL(req.url, 'http://x').searchParams.get('seconds')) || 90))
    startMagCal(secs)
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, seconds: secs }))
    return
  }
  if (req.method === 'GET' && path === '/api/imu/calibrate-mag') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      ...magCal,
      elapsed: magCal.startedAt ? Math.round((Date.now() - magCal.startedAt) / 1000) : 0,
      calibration: readMagCal(),
    }))
    return
  }
  // Live input events for the helm: button presses, knob deltas in UI modes, and mode
  // changes. SSE rather than polling — a button press that arrives 200ms late feels broken.
  if (req.method === 'GET' && path === '/api/input') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' })
    res.write(`data: ${JSON.stringify({ type: 'mode', value: encMode, t: Date.now() })}\n\n`)
    inputClients.add(res)
    req.on('close', () => inputClients.delete(res))
    return
  }
  if (req.method === 'POST' && path === '/api/encoder/mode') {
    const m = new URL(req.url, 'http://x').searchParams.get('mode')
    if (ENC_MODES.includes(m)) { encMode = m; pushInput({ type: 'mode', value: encMode }) }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true, mode: encMode }))
    return
  }
  if (req.method === 'GET' && path === '/api/encoder/volcfg') {
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ...volCfg, perStep: Number(volPerStep().toFixed(2)) }))
    return
  }
  if (req.method === 'POST' && path === '/api/encoder/volcfg') {
    const q = new URL(req.url, 'http://x').searchParams
    if (q.get('turns')) volCfg.turns = Math.max(0.5, Math.min(8, Number(q.get('turns')) || 2))
    if (q.get('detentsPerRev')) volCfg.detentsPerRev = Math.max(8, Math.min(96, Number(q.get('detentsPerRev')) || 24))
    if (q.get('accel') != null) volCfg.accel = q.get('accel') === '1'
    volAccum = 0
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ...volCfg, perStep: Number(volPerStep().toFixed(2)) }))
    return
  }
  if (req.method === 'GET' && path === '/api/encoder') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ...encoder, mode: encMode, modes: ENC_MODES, buttons: btnStats, ageMs: encoder.updated ? Date.now() - encoder.updated : null }))
    return
  }
  if (req.method === 'POST' && path === '/api/encoder/reset') {
    for (const k of Object.keys(btnStats)) delete btnStats[k]
    // Zero the display without restarting the reader, so a test run starts clean.
    if (encoder.raw) encZero = { pos: encoder.raw.pos, invalid: encoder.raw.invalid, edges: encoder.raw.edges }
    res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":true}')
    return
  }
  if (req.method === 'GET' && path === '/api/imu/orient') {
    const cfg = readImuConfig()
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ...cfg, gravity, preview: orientPreview(gravity), attitude, headingMag }))
    return
  }
  // Manual trim of the zero, in degrees, applied as a delta so the buttons can just
  // nudge. imu.py re-reads the config as it runs, so the gauge moves as you press.
  if (req.method === 'POST' && path === '/api/imu/offset') {
    const p = new URL(req.url, 'http://x').searchParams
    const cfg = readImuConfig()
    const dR = Number(p.get('dRoll')) || 0
    const dP = Number(p.get('dPitch')) || 0
    const next = p.get('reset') === '1'
      ? { ...cfg, rollOffset: 0, pitchOffset: 0 }
      : {
        ...cfg,
        // Offsets are subtracted from the reading, so nudging the displayed value up
        // means moving the offset down — negate here rather than inverting the labels.
        rollOffset: Number(((cfg.rollOffset || 0) - dR).toFixed(3)),
        pitchOffset: Number(((cfg.pitchOffset || 0) - dP).toFixed(3)),
      }
    let ok = true
    try { writeImuConfig(next) } catch (e) { ok = false }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok, rollOffset: next.rollOffset, pitchOffset: next.pitchOffset }))
    return
  }
  if (req.method === 'POST' && path === '/api/imu/orient') {
    const axis = String(new URL(req.url, 'http://x').searchParams.get('axis') || '').toUpperCase()
    if (!['X', 'Y', 'Z'].includes(axis)) {
      res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"ok":false,"error":"axis must be X, Y or Z"}')
      return
    }
    // Changing the frame invalidates the old zero — keeping it would silently bias the
    // new axis by an offset measured in a different orientation.
    try { writeImuConfig({ ...readImuConfig(), upAxis: axis, rollOffset: 0, pitchOffset: 0 }) } catch (e) { /* reported below */ }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, upAxis: axis, note: 'zero offsets cleared — re-level after changing axis' }))
    return
  }
  // Average the attitude over a window so wave motion cancels instead of being baked in
  // as the zero. Reports the spread, so a capture taken in a rolling anchorage is
  // visibly untrustworthy rather than quietly wrong.
  // Guided two-step orientation capture. Averages briefly so a hand resting on the
  // bracket doesn't skew the frame.
  if (req.method === 'POST' && path === '/api/imu/teach') {
    const step = new URL(req.url, 'http://x').searchParams.get('step')
    if (!['level', 'bow'].includes(step)) {
      res.writeHead(400, { 'Content-Type': 'application/json' }); res.end('{"ok":false,"error":"step must be level or bow"}')
      return
    }
    const samples = []
    const iv = setInterval(() => { if (gravity) samples.push([gravity.x, gravity.y, gravity.z]) }, 100)
    setTimeout(() => {
      clearInterval(iv)
      if (samples.length < 5) {
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":false,"error":"no sensor data"}')
        return
      }
      const avg = [0, 1, 2].map((k) => samples.reduce((s, v) => s + v[k], 0) / samples.length)
      const cfg = readImuConfig()
      if (step === 'level') {
        // Keep it aside until the bow capture completes; a half-finished teach must not
        // disturb a working frame.
        try { writeImuConfig({ ...cfg, teachLevel: avg }) } catch (e) { /* reported below */ }
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true, step, vector: avg.map((v) => Number(v.toFixed(3))) }))
        return
      }
      if (!cfg.teachLevel) {
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":false,"error":"capture the level position first"}')
        return
      }
      const fr = frameFromCaptures(cfg.teachLevel, avg)
      if (fr.error) {
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: fr.error }))
        return
      }
      // A new frame invalidates any previous zero.
      try {
        writeImuConfig({ upAxis: cfg.upAxis || 'X', rollOffset: 0, pitchOffset: 0, frame: { up: fr.up, fore: fr.fore, stbd: fr.stbd } })
      } catch (e) { /* reported below */ }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, step, tiltDeg: fr.tiltDeg, frame: fr }))
    }, 2000)
    return
  }
  if (req.method === 'POST' && path === '/api/imu/level') {
    const q = new URL(req.url, 'http://x').searchParams
    // Two jobs that look alike but aren't. At rest, motion is error: a few seconds is
    // plenty and movement means the reading is contaminated, so we refuse rather than
    // bake in a wave. Under way, motion is expected: the capture must span many wave
    // periods so the roll averages to the true mean, and high spread is normal.
    const mode = q.get('mode') === 'moving' ? 'moving' : 'still'
    const dflt = mode === 'moving' ? 60 : 2
    const lo = mode === 'moving' ? 20 : 1   // at rest there is nothing to average out
    const secs = Math.max(lo, Math.min(180, Number(q.get('seconds')) || dflt))
    const rolls = [], pitches = []
    const iv = setInterval(() => {
      if (attitude && attitude.pitch != null) {
        if (attitude.roll != null) rolls.push(attitude.roll)
        pitches.push(attitude.pitch)
      }
    }, 100)
    setTimeout(() => {
      clearInterval(iv)
      if (!pitches.length) {
        res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"ok":false,"error":"no attitude data during the capture"}')
        return
      }
      const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length
      const sd = (a) => (a.length < 2 ? 0 : Math.sqrt(a.reduce((s, v) => s + (v - mean(a)) ** 2, 0) / a.length))
      const cfg = readImuConfig()
      const mr = rolls.length ? mean(rolls) : 0
      const mp = mean(pitches)
      const sdr = sd(rolls), sdp = sd(pitches)
      const worst = Math.max(sdr, sdp)
      const reply = {
        seconds: secs, mode, samples: pitches.length,
        movement: { roll: Number(sdr.toFixed(2)), pitch: Number(sdp.toFixed(2)) },
      }
      // A still calibration contaminated by movement is worse than none — it silently
      // biases every later reading. Refuse it and point at the right mode.
      if (mode === 'still' && worst > 1.0) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({
          ...reply, ok: false,
          error: `the boat moved ±${worst.toFixed(1)}° during the capture — too much for a still calibration. `
            + 'Wait for calm water, or use Under way mode, which averages the motion out over a longer window.',
        }))
        return
      }
      // Measured values already have the current offset applied, so accumulate.
      const next = {
        ...cfg,
        rollOffset: Number(((cfg.rollOffset || 0) + mr).toFixed(3)),
        pitchOffset: Number(((cfg.pitchOffset || 0) + mp).toFixed(3)),
      }
      let saved = true
      try { writeImuConfig(next) } catch (e) { saved = false }
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({
        ...reply, ok: saved,
        rollOffset: next.rollOffset, pitchOffset: next.pitchOffset,
        // A sane mounting needs a small zero. A huge one means the up-axis choice is
        // wrong and we are cancelling the wrong thing — say so rather than let the
        // gauge read plausibly while being fundamentally misconfigured.
        warning: Math.abs(mr) > 45 || Math.abs(mp) > 45
          ? `zero of ${mr.toFixed(0)}° heel / ${mp.toFixed(0)}° trim is very large — the up-axis is probably wrong. Run the guided setup instead.`
          : null,
        quality: mode === 'moving'
          ? (secs >= 45 && worst > 0.5
            ? `averaged ${secs}s of motion (±${worst.toFixed(1)}°) — the mean should be close to true level`
            : worst <= 0.5 ? 'barely moving — a still calibration would be just as good'
              : `only ${secs}s of a moving boat — run 60s or more so the waves average out properly`)
          : worst < 0.3 ? 'rock steady — this zero is solid'
            : 'slight motion, within tolerance for a still calibration',
      }))
    }, secs * 1000)
    return
  }
  if (req.method === 'GET' && path === '/api/system') {
    systemInfo().then((info) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(info))
    }).catch(() => { res.writeHead(500); res.end('{}') })
    return
  }
  if (req.method === 'GET' && path === '/api/btbrowse') {
    const p = new URL(req.url, 'http://x').searchParams.get('path') || 'root'
    btBrowse(p)
      .then((r) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(r)) })
      .catch(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, reason: 'error' })) })
    return
  }
  if (req.method === 'POST' && path === '/api/btplay') {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      let b = {}; try { b = body ? JSON.parse(body) : {} } catch (e) {}
      const p = String(b.path || '')
      // Only a real BlueZ MediaItem1 path is ever shelled out.
      if (/^\/org\/bluez\/[A-Za-z0-9_/]+$/.test(p)) execP(`busctl --system call org.bluez ${p} org.bluez.MediaItem1 Play 2>/dev/null`)
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: true }))
    })
    return
  }
  // Coarse Wi-Fi position. Separate endpoint and separate field name from anything the
  // navigation stack reads — it must never be mistaken for a fix.
  if (req.method === 'GET' && path === '/api/wifiloc') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      enabled: WIFI_LOC_ON,
      approx: wifiFix ? { ...wifiFix, ageS: Math.round((Date.now() - wifiFix.ts) / 1000) } : null,
      error: wifiLastError, provider: WIFI_LOC_URL,
    }))
    return
  }
  if (req.method === 'GET' && path === '/api/gps') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    // `approx` rides along for the helm's benefit but is a distinct field from the fix
    // data — nothing merges the two.
    res.end(JSON.stringify({
      ...gpsState,
      raw: gpsRaw.slice(-24),
      approx: wifiFix && (gpsState.fix || 0) < 1
        ? { ...wifiFix, ageS: Math.round((Date.now() - wifiFix.ts) / 1000), source: 'wifi' } : null,
    }))
    return
  }
  if (req.method === 'GET' && path === '/api/i2c') {
    execFileP('python3', [`${__dirname}/i2cscan.py`]).then((r) => {
      let scan = { devices: [] }; try { scan = JSON.parse(r.out) } catch (e) {}
      // Merge the raw scan with whether the service is actually getting data from each.
      const runningVal = {
        MCP9808: ambientC != null ? `${ambientC.toFixed(1)} C` : null,
        HTU31D: htuC != null ? `${htuC.toFixed(1)} C${humidity != null ? ` / ${Math.round(humidity)}% RH` : ''}` : null,
        SHT41: shtC != null ? `${shtC.toFixed(1)} C${shtHumidity != null ? ` / ${Math.round(shtHumidity)}% RH` : ''}` : null,
        // Only the accelerometer actually driving attitude reports a live heel value;
        // the other one is present on the bus but idle.
        ICM20948: attitude && attitude.source === 'icm'
          ? `${attitude.roll != null ? `${attitude.roll.toFixed(0)} deg heel` : 'heel n/a (vertical)'}`
            + `${attitude.pitch != null ? ` / ${attitude.pitch.toFixed(0)} deg trim` : ''}`
            + `${headingMag != null ? ` / ${Math.round(headingMag)} deg mag` : ''}` : null,
        ADXL345: attitude && attitude.source === 'adxl' && attitude.roll != null ? `${attitude.roll.toFixed(0)} deg heel` : null,
        // Expander pins read as inputs; show both ports so wiring shows up live.
        MCP23017: ioPorts ? `A 0x${ioPorts.a.toString(16).padStart(2, '0')} · B 0x${ioPorts.b.toString(16).padStart(2, '0')}` : null,
      }
      const tempByName = { MCP9808: ambientC, HTU31D: htuC, SHT41: shtC }
      const humByName = { HTU31D: humidity, SHT41: shtHumidity }
      const devices = (scan.devices || []).map((d) => ({
        ...d, running: !!runningVal[d.name], value: runningVal[d.name] || null,
        tempC: typeof tempByName[d.name] === 'number' ? tempByName[d.name] : null,
        humidity: typeof humByName[d.name] === 'number' ? humByName[d.name] : null,
      }))
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ devices, error: scan.error || null }))
    }).catch(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"devices":[]}') })
    return
  }
  if (req.method === 'GET' && path === '/api/network') {
    networkInfo().then((r) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(r)) })
      .catch(() => { res.writeHead(500); res.end('{}') })
    return
  }
  if (req.method === 'GET' && path === '/api/network/wifi') {
    wifiScan().then((r) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(r)) })
      .catch(() => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end('{"networks":[]}') })
    return
  }
  if (req.method === 'POST' && (path === '/api/network/ipv4' || path === '/api/network/wifi/connect')) {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      let b = {}; try { b = body ? JSON.parse(body) : {} } catch (e) {}
      const fn = path === '/api/network/ipv4' ? setIpv4 : wifiConnect
      fn(b).then((r) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(r)) })
        .catch((e) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ok: false, reason: 'error', err: String(e).slice(0, 200) })) })
    })
    return
  }
  if (req.method === 'GET' && path === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(state))
  }
  const name = path.replace('/api/', '')
  if (req.method === 'POST' && actions[name]) {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      let b = {}; try { b = body ? JSON.parse(body) : {} } catch (e) {}
      try { actions[name](b) } catch (e) {}
      saveState()
      res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(state))
    })
    return
  }
  res.writeHead(404); res.end('not found')
})

// push spectrum frames to SSE subscribers (~16 fps)
setInterval(() => {
  if (!sseClients.size) return
  const data = `data: ${JSON.stringify(spectrum.map((v) => Math.round(v * 100) / 100))}\n\n`
  for (const r of sseClients) { try { r.write(data) } catch (e) {} }
}, 60)

killPipeline()
// Resume persisted state so a deploy/restart doesn't turn the stereo off.
// ---- IMU: ICM20948 (preferred) or ADXL345 tilt (heel/trim) via the imu.py helper
// (same pipe pattern as bipart.py). attitude stays null when no sensor is present. ----
let imuProc = null
let attitude = null // { roll, pitch, source } degrees + 'icm'|'adxl', or null when neither
let ambientC = null // MCP9808 ambient temp (°C), or null when absent
let htuC = null     // HTU31D ambient temp (°C), or null when absent
let humidity = null // HTU31D relative humidity (%), or null when absent
let shtC = null     // SHT41 ambient temp (°C), or null when absent
let shtHumidity = null // SHT41 relative humidity (%), or null when absent
// AK09916 tilt-compensated magnetic heading (deg). imu.py also pushes this straight to
// SignalK as $HCHDM, so the compass gauge reads it via navigation.headingMagnetic —
// this copy is for the Sensors diagnostic screen.
let headingMag = null
// MCP23017 (0x20) input ports as {a,b} bytes, or null when the expander is absent.
// Nothing is wired to it yet, so these read as constants until the knob/buttons land.
let ioPorts = null
// Raw gravity vector, pre-orientation — feeds the helm's mounting-calibration dialog.
let gravity = null

// ---- IMU mounting calibration -----------------------------------------------------
// Which axis is vertical depends on how the board is bolted in, and the zero depends on
// how the boat sits. Both are adjustable from the helm and take effect live: imu.py
// re-reads this file as it runs, so the gauge responds while you're holding the bracket.
const IMU_CONFIG = `${__dirname}/imuconfig.json`
function readImuConfig() {
  try { return JSON.parse(fs.readFileSync(IMU_CONFIG, 'utf8')) } catch (e) { return { upAxis: 'X', rollOffset: 0, pitchOffset: 0 } }
}
function writeImuConfig(cfg) {
  fs.writeFileSync(`${IMU_CONFIG}.tmp`, JSON.stringify(cfg, null, 2))
  fs.renameSync(`${IMU_CONFIG}.tmp`, IMU_CONFIG)
}
// Guided orientation: derive the full sensor frame from two physical captures instead of
// asking which chip axis is "up" — a question nobody can answer by looking at a PCB.
//   step 1 (level)  : the measured vector points at the sky, so it IS the up axis
//   step 2 (bow up) : lifting the bow rotates that sky-vector toward the stern, and the
//                     change identifies the fore-aft axis *and* its sign
// Starboard falls out as the cross product, giving a complete right-handed frame with
// correct signs — no guessing, and no way to get heel and trim swapped.
function normalize(v) {
  const n = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / n, v[1] / n, v[2] / n]
}
const dot3 = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross3 = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]

function frameFromCaptures(level, bow) {
  const u = normalize(level)
  // Component of the change perpendicular to up; bow-up tilts the sky-vector sternward,
  // so forward is the negative of that.
  const d = [bow[0] - level[0], bow[1] - level[1], bow[2] - level[2]]
  const perp = [d[0] - dot3(d, u) * u[0], d[1] - dot3(d, u) * u[1], d[2] - dot3(d, u) * u[2]]
  const mag = Math.hypot(perp[0], perp[1], perp[2])
  if (mag < 0.08) return { error: 'not enough tilt between the two captures — lift the bow end further (about 15° is plenty)' }
  const f = normalize([-perp[0], -perp[1], -perp[2]])
  const s = cross3(u, f)                    // starboard
  return { up: u, fore: f, stbd: normalize(s), tiltDeg: Number((Math.asin(Math.min(1, mag)) * 180 / Math.PI).toFixed(1)) }
}

// ---- Magnetometer calibration runner ----------------------------------------------
// Hard/soft-iron correction has to be redone whenever the module moves, so it belongs on
// the helm rather than behind an SSH session. Progress comes from the script's stderr.
const magCal = { running: false, startedAt: 0, seconds: 0, lines: [], exit: null }
function readMagCal() {
  try { return JSON.parse(fs.readFileSync(`${__dirname}/magcal.json`, 'utf8')) } catch (e) { return null }
}
function startMagCal(secs) {
  magCal.running = true; magCal.startedAt = Date.now(); magCal.seconds = secs
  magCal.lines = []; magCal.exit = null
  const p = spawn('python3', [`${__dirname}/imu.py`, '--calibrate-mag', `--seconds=${secs}`],
    { stdio: ['ignore', 'ignore', 'pipe'] })
  let buf = ''
  p.stderr.on('data', (d) => {
    buf += d.toString()
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).replace(/\s+$/, ''); buf = buf.slice(nl + 1)
      if (line) { magCal.lines.push(line); while (magCal.lines.length > 40) magCal.lines.shift() }
    }
  })
  p.on('error', (e) => { magCal.running = false; magCal.exit = -1; magCal.lines.push(`failed to start: ${e.message}`) })
  p.on('exit', (code) => { magCal.running = false; magCal.exit = code })
}

// What roll/pitch would read under each possible mounting, so the dialog can show the
// consequence of each choice instead of asking the user to guess.
function orientPreview(g) {
  if (!g) return []
  const deg = (r) => (r * 180) / Math.PI
  const forms = { X: [g.y, g.z, g.x], Y: [g.z, g.x, g.y], Z: [g.x, g.y, g.z] }
  return Object.entries(forms).map(([axis, [ax, ay, az]]) => {
    const horiz = Math.sqrt(ay * ay + az * az)
    return {
      axis,
      roll: horiz < 0.15 ? null : Number(deg(Math.atan2(ay, az)).toFixed(1)),
      pitch: Number(deg(Math.atan2(-ax, horiz)).toFixed(1)),
      horiz: Number(horiz.toFixed(3)),
      usable: horiz >= 0.15,
    }
  })
}

// ---- Sensor history: one sample every 10s, kept in memory for the helm's history
// charts. 6h at 10s = 2160 points (~250 KB), which is plenty to see a trend without
// paying for a database. It starts empty on a service restart — deliberately, since
// this is a diagnostic view, not a log. ----
const HIST_STEP_MS = 10000
const HIST_MAX = 2160
const sensorHist = []
// Straight from sysfs rather than systemInfo() — that shells out to ps/vcgencmd, which
// is far too heavy to run on a 10s sampling loop.
function cpuTempC() {
  try { return Math.round(Number(fs.readFileSync('/sys/class/thermal/thermal_zone0/temp', 'utf8')) / 100) / 10 } catch (e) { return null }
}
setInterval(() => {
  sensorHist.push({
    t: Date.now(), cpu: cpuTempC(),
    mcp: ambientC, htuT: htuC, htuH: humidity, shtT: shtC, shtH: shtHumidity,
    roll: attitude ? attitude.roll : null, pitch: attitude ? attitude.pitch : null,
    hdg: headingMag, ioA: ioPorts ? ioPorts.a : null, ioB: ioPorts ? ioPorts.b : null,
  })
  while (sensorHist.length > HIST_MAX) sensorHist.shift()
}, HIST_STEP_MS)

// ---- Rotary encoder on the MCP23017 -----------------------------------------------
// Its own process because it has to poll far faster than the sensor loop. `invalid` is
// the number worth watching: impossible quadrature transitions mean states are being
// missed, which is what marginal logic levels or contact bounce look like.
let encProc = null
let encoder = { alive: false, a: 0, b: 0, pos: 0, det: 0, dir: 0, invalid: 0, edges: 0, hz: 0, portA: 0, portB: 0, updated: 0 }
let encZero = { pos: 0, invalid: 0, edges: 0 }

// ---- Physical control surface -----------------------------------------------------
// What the knob does depends on the mode; button 4 cycles it. Volume and FM tuning are
// applied HERE rather than in the helm: the knob then works instantly, and keeps working
// if the screen is asleep or the browser has wandered off. Modes that move a cursor
// around the UI have to be sent to the helm, since only it knows what's on screen.
const ENC_MODES = ['volume', 'tune', 'nav', 'value']
let encMode = 'volume'
let encRemainder = 0            // leftover quadrature counts between detents
let encPrevRaw = null
const inputClients = new Set()  // SSE subscribers (the helm)
function pushInput(ev) {
  const line = `data: ${JSON.stringify({ ...ev, mode: encMode, t: Date.now() })}\n\n`
  for (const r of inputClients) { try { r.write(line) } catch (e) { /* dropped below */ } }
}
// Volume sensitivity. The encoder gives ~24 detents per revolution against a 0-30
// range, so one detent per step made a single turn sweep the entire range. Two detents
// per step gives ~2.5 turns end to end for normal use, and a speed-based multiplier
// keeps a fast spin quick — fine control when you're easing it, coarse when you mean it.
// Tunable from the helm (Settings -> Config), because how a knob should feel is a matter
// of taste rather than something to hard-code. perStep = detents per volume step; accel
// adds at most a doubling for a genuinely fast spin. The earlier 4x multiplier meant half
// a turn crossed the whole range, which is why it felt uncontrollable.
// Expressed as "turns to cross the whole range", which is how it actually gets judged.
// detentsPerRev is the encoder's mechanical detent count (24 is typical); the divisor is
// derived, so changing either keeps the feel honest.
const volCfg = {
  turns: Number(process.env.VOL_TURNS || 2),
  detentsPerRev: Number(process.env.VOL_DETENTS_PER_REV || 24),
  accel: process.env.VOL_ACCEL !== '0',
}
const volPerStep = () => Math.max(0.2, (volCfg.turns * volCfg.detentsPerRev) / 30)
let volAccum = 0, lastDetentAt = 0, tuneTimer = null
function volumeSteps(detents, now) {
  const dt = Math.max(0.02, (now - lastDetentAt) / 1000)
  lastDetentAt = now
  const rate = Math.abs(detents) / dt                 // detents per second
  const accel = volCfg.accel && rate > 30 ? 2 : 1
  volAccum += (detents * accel) / volPerStep()
  const steps = Math.trunc(volAccum)                  // fractional part carries, so slow
  volAccum -= steps                                   // turns are never swallowed
  return steps
}
function applyEncoder(detents) {
  if (!detents) return
  if (encMode === 'volume') {
    const steps = volumeSteps(detents, Date.now())
    if (!steps) return
    const v = Math.max(0, Math.min(30, (state.volume || 0) + steps))
    try { actions.volume({ volume: v }) } catch (e) { /* ignore */ }
    pushInput({ type: 'volume', value: v })
  } else if (encMode === 'tune') {
    // Live scroll across the FM band, 0.2 MHz per detent (US channel spacing).
    //
    // Retuning restarts the whole rtl_fm pipeline, so calling tune() per detent queued a
    // kill+respawn for every click and the knob felt dead. Move the displayed frequency
    // immediately and defer the actual retune until you pause — the band scrolls
    // smoothly under your hand and the radio retunes once, where you stopped.
    const f = Math.round(((state.fm && state.fm.freq ? state.fm.freq : 88.1) + detents * 0.2) * 10) / 10
    const clamped = Math.max(87.9, Math.min(107.9, f))   // stop at the band edges
    state.fm.freq = Math.round(clamped * 10) / 10
    pushInput({ type: 'tune', value: state.fm.freq })
    clearTimeout(tuneTimer)
    tuneTimer = setTimeout(() => { if (state.power && state.source === 'FM') scheduleStart() }, 320)
  } else {
    pushInput({ type: encMode, delta: detents })   // 'nav' / 'value' -> the helm decides
  }
}
const btnStats = {}      // pin -> { presses, longs, last, lastAt }
function onButton(pin, kind) {
  const b = btnStats[pin] || (btnStats[pin] = { presses: 0, longs: 0, last: null, lastAt: 0 })
  if (kind === 'long') b.longs++; else b.presses++
  b.last = kind; b.lastAt = Date.now()
  // Button 4 (GPA5) owns the knob's mode; everything else is context and belongs to the
  // helm, which knows which view is showing.
  if (pin === 5 && kind === 'press') {
    encMode = ENC_MODES[(ENC_MODES.indexOf(encMode) + 1) % ENC_MODES.length]
    pushInput({ type: 'mode', value: encMode })
    // Still emit the button event: without it the helm gets no acknowledgement and the
    // key looks dead, even though the mode changed.
    pushInput({ type: 'button', pin, press: kind })
    return
  }
  pushInput({ type: 'button', pin, press: kind })
}
function startEncoder() {
  const p = `${__dirname}/encoder.py`
  try { if (!fs.existsSync(p)) return } catch (e) { return }
  encProc = spawn('python3', [p], { stdio: ['ignore', 'pipe', 'ignore'] })
  let buf = ''
  encProc.stdout.on('data', (d) => {
    buf += d.toString(); let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
      if (!line) continue
      if (line === 'READY') { encoder.alive = true; continue }
      if (line.startsWith('DEAD')) { encoder.alive = false; continue }
      if (line.startsWith('BTN ')) {
        const [, pin, kind] = line.split(' ')
        try { onButton(Number(pin), kind) } catch (e) { /* keep reading */ }
        continue
      }
      if (!line.startsWith('ENC ')) continue
      const f = {}
      for (const kv of line.slice(4).split(' ')) {
        const eq = kv.indexOf('=')
        if (eq > 0) f[kv.slice(0, eq)] = kv.slice(eq + 1)
      }
      const n = (k) => (f[k] != null ? Number(f[k]) : 0)
      encoder = {
        alive: true, a: n('a'), b: n('b'),
        pos: n('pos') - encZero.pos, det: Math.trunc((n('pos') - encZero.pos) / 4),
        dir: n('dir'), invalid: n('inv') - encZero.invalid, edges: n('edges') - encZero.edges,
        hz: n('hz'), poll: n('poll'), portA: parseInt(f.pa, 16) || 0, portB: parseInt(f.pb, 16) || 0,
        raw: { pos: n('pos'), invalid: n('inv'), edges: n('edges') },
        updated: Date.now(),
      }
      // Act on movement in whole detents; the remainder carries so slow turns aren't lost.
      const prevPos = encPrevRaw
      encPrevRaw = encoder.raw.pos
      if (prevPos != null) {
        encRemainder += encoder.raw.pos - prevPos
        const detents = Math.trunc(encRemainder / 4)
        if (detents) { encRemainder -= detents * 4; try { applyEncoder(detents) } catch (e) { /* ignore */ } }
      }
    }
  })
  encProc.on('error', () => { encProc = null; encoder.alive = false })
  encProc.on('exit', () => { encProc = null; encoder.alive = false; setTimeout(startEncoder, 5000) })
}
startEncoder()

function startImu() {
  const imuPath = `${__dirname}/imu.py`
  try { if (!fs.existsSync(imuPath)) return } catch (e) { return }
  // stderr was 'ignore', which threw away every diagnostic imu.py writes — sensor init
  // failures, magcal status, stalled-magnetometer warnings. A frozen compass sat on
  // screen for hours reporting a stale heading with nothing in the log to say so.
  imuProc = spawn('python3', [imuPath], { stdio: ['ignore', 'pipe', 'pipe'] })
  imuProc.stderr.on('data', (d) => {
    const t = d.toString().trim()
    if (t) console.error(`[imu] ${t}`)
  })
  let buf = ''
  imuProc.stdout.on('data', (d) => {
    buf += d.toString()
    let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
      if (!line) continue
      if (line === 'READY') continue
      if (line.startsWith('DEAD')) { attitude = null; ambientC = null; htuC = null; humidity = null; shtC = null; shtHumidity = null; headingMag = null; continue }
      // "roll pitch temp htuT hum shtT shtH hdg src ioA ioB" — any numeric field may be
      // "nan" if that sensor is absent. src names the accelerometer driving attitude; an
      // older imu.py sends fewer fields, which parse to NaN/undefined and land as null.
      const m = line.split(' ')
      const roll = Number(m[0]), pitch = Number(m[1]), temp = Number(m[2]), ht = Number(m[3]), hu = Number(m[4])
      const st = Number(m[5]), sh = Number(m[6]), hd = Number(m[7])
      const src = m[8] && m[8] !== 'none' ? m[8] : null
      const ia = Number(m[9]), ib = Number(m[10])
      ioPorts = (isFinite(ia) && isFinite(ib)) ? { a: ia, b: ib } : null
      const rx = Number(m[11]), ry = Number(m[12]), rz = Number(m[13])
      gravity = (isFinite(rx) && isFinite(ry) && isFinite(rz)) ? { x: rx, y: ry, z: rz } : null
      // Roll and pitch are independently valid: mounted near-vertical, roll is degenerate
      // (gimbal lock) while pitch stays solid, so a missing roll must not suppress pitch.
      attitude = isFinite(pitch) ? { roll: isFinite(roll) ? roll : null, pitch, source: src } : null
      ambientC = isFinite(temp) ? temp : null
      htuC = isFinite(ht) ? ht : null
      humidity = isFinite(hu) ? hu : null
      shtC = isFinite(st) ? st : null
      shtHumidity = isFinite(sh) ? sh : null
      headingMag = isFinite(hd) ? hd : null
    }
  })
  const clearImu = () => { imuProc = null; attitude = null; ambientC = null; htuC = null; humidity = null; shtC = null; shtHumidity = null; headingMag = null }
  imuProc.on('error', clearImu)
  imuProc.on('exit', () => { clearImu(); setTimeout(startImu, 5000) })
}
startImu()

// ---- GPS: raw NMEA via gps.py (also UDP-forwarded to SignalK). Buffers recent
// sentences and parses the acquisition state for the helm's GPS diagnostic view. ----
let gpsProc = null
const gpsRaw = []
// module/rf/port are filled from gps.py's UBX polls (#VER/#RF/#PORT); they stay null on a
// receiver that speaks NMEA only, and the helm just omits those rows.
const gpsState = { alive: false, fix: 0, rmcValid: false, satsUsed: 0, satsInView: 0, hdop: null, antenna: null, sats: [], updated: 0, module: null, rf: null, port: null, aiding: null }
let gsvAccum = {}
// "#TAG k=v|k=v" — '|' separated because values (firmware strings) contain spaces.
function parseGpsMeta(line) {
  const sp = line.indexOf(' ')
  if (sp < 0) return
  const tag = line.slice(0, sp)
  const d = {}
  for (const pair of line.slice(sp + 1).split('|')) {
    const eq = pair.indexOf('=')
    if (eq > 0) d[pair.slice(0, eq)] = pair.slice(eq + 1)
  }
  const num = (v) => (v != null && v !== '' && isFinite(Number(v)) ? Number(v) : null)
  if (tag === '#VER') {
    gpsState.module = { model: d.model || null, sw: d.sw || null, hw: d.hw || null, prot: d.prot || null, gnss: d.gnss ? d.gnss.split(';').filter(Boolean) : [] }
  } else if (tag === '#RF') {
    gpsState.rf = {
      agc: num(d.agc), agcMax: num(d.agcMax) || 8191, noise: num(d.noise),
      jam: d.jam || null, jamInd: num(d.jamInd), ant: d.ant || null, antPwr: d.antPwr || null,
      updated: Date.now(),
    }
    // The antenna row in the acquisition block preferred the old ATGM336H's $GPTXT;
    // UBX antenna status is better data when the module reports it.
    if (d.ant && d.ant !== 'unknown') gpsState.antenna = d.ant
  } else if (tag === '#PORT') {
    gpsState.port = { dev: d.dev || null, baud: num(d.baud) }
  } else if (tag === '#AID') {
    // What startup aiding actually got injected — time, rough position, predicted orbits.
    gpsState.aiding = {
      time: d.time === '1', pos: d.pos === '1', ano: num(d.ano) || 0,
      src: d.src && d.src !== 'none' ? d.src : null,
      posAgeH: num(d.posAgeH), anoAgeD: num(d.anoAgeD),
    }
  }
}
function parseGps(line) {
  gpsRaw.push(line); while (gpsRaw.length > 40) gpsRaw.shift()
  const f = line.split('*')[0].split(',')
  const t = f[0] || ''
  if (/GGA$/.test(t)) {
    gpsState.fix = Number(f[6]) || 0
    gpsState.satsUsed = Number(f[7]) || 0
    gpsState.hdop = f[8] ? Number(f[8]) : null
    gpsState.updated = Date.now()
  } else if (/RMC$/.test(t)) {
    gpsState.rmcValid = f[2] === 'A'
  } else if (/GSV$/.test(t)) {
    const talker = t.slice(1, 3) // GP/BD/GL/GA
    if ((Number(f[2]) || 1) === 1) gsvAccum[talker] = []
    for (let i = 4; i + 3 < f.length; i += 4) {
      if (f[i]) (gsvAccum[talker] = gsvAccum[talker] || []).push({ id: Number(f[i]), el: Number(f[i + 1]) || null, az: Number(f[i + 2]) || null, snr: f[i + 3] ? Number(f[i + 3]) : null })
    }
    const all = [].concat(...Object.values(gsvAccum))
    gpsState.sats = all
    gpsState.satsInView = all.length
  } else if (/TXT$/.test(t) && /ANTENNA/i.test(line)) {
    gpsState.antenna = f[4] || null
  }
}
function startGps() {
  const p = `${__dirname}/gps.py`
  try { if (!fs.existsSync(p)) return } catch (e) { return }
  gpsProc = spawn('python3', [p], { stdio: ['ignore', 'pipe', 'ignore'] })
  let buf = ''
  gpsProc.stdout.on('data', (d) => {
    buf += d.toString(); let nl
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
      if (!line) continue
      if (line === 'READY') { gpsState.alive = true; continue }
      if (line.startsWith('DEAD')) { gpsState.alive = false; gpsState.rf = null; continue }
      if (line.startsWith('#')) { try { parseGpsMeta(line) } catch (e) {} continue }
      if (line.startsWith('$')) { gpsState.alive = true; try { parseGps(line) } catch (e) {} }
    }
  })
  gpsProc.on('error', () => { gpsProc = null })
  gpsProc.on('exit', () => { gpsProc = null; gpsState.alive = false; setTimeout(startGps, 5000) })
}
startGps()

setTimeout(() => { state.power = true; applyVolume(); if (state.source === 'FM') scheduleStart(); applyAudioTaps() }, 800)
server.listen(PORT, () => console.log('stereo-service listening on', PORT))
process.on('SIGTERM', () => { stopRadio(); process.exit(0) })
process.on('SIGINT', () => { stopRadio(); process.exit(0) })
