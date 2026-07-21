// openMarine Stereo control service — drives the RTL-SDR as an FM receiver.
// No dependencies (Node built-ins only). Plays FM out the Pi aux, taps the audio
// for a live spectrum (streamed over SSE), and exposes tuner controls + settings.
const http = require('http')
const fs = require('fs')
const { spawn, execSync } = require('child_process')

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

const DEFAULT_PRESETS = [88.5, 93.7, 101.5, 104.3, 107.9]
function loadPresets() {
  try {
    const p = JSON.parse(fs.readFileSync(PRESETS_FILE, 'utf8'))
    return Array.isArray(p) ? p.filter((n) => typeof n === 'number') : DEFAULT_PRESETS
  } catch (e) { return DEFAULT_PRESETS }
}
function savePresets() { try { fs.writeFileSync(PRESETS_FILE, JSON.stringify(state.fm.presets)) } catch (e) {} }

const state = {
  connected: true,
  power: false,
  source: 'FM',
  volume: 12,
  muted: false,
  fm: { freq: 101.5, presets: [] },
  nowPlaying: { title: 'FM Radio', artist: '' },
  settings: { gain: Number(RTL_GAIN) || 40, deemp: true, squelch: 0, ppm: 0, filter: true }, // gain<0 = auto
  bluetooth: { available: false, connected: null, devices: [], track: null }, // A2DP sink — backend TBD
}
state.fm.presets = loadPresets()
let spectrum = new Array(NBANDS).fill(0)

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

function applyVolume() {
  let pct = 0
  if (!state.muted && state.volume > 0) {
    pct = Math.round(VOL_FLOOR_PCT + ((state.volume - 1) / (30 - 1)) * (100 - VOL_FLOOR_PCT))
  }
  spawn('amixer', ['-c', MIXER_CARD, 'sset', MIXER_CTL, `${pct}%`], { stdio: 'ignore' })
}

// US stations scroll ad/song text through the 8-char PS field, so a single PS frame
// is a fragment ("rneys.7"). Keep the frame that recurs as a stable station name
// (title), and reassemble the scrolling segments into a full message (artist).
let psFreq = {}, psBuilding = [], psComplete = '', rtText = ''
function rdsMessage() { return rtText || psComplete || psBuilding.join(' ') }
function resetRds() { psFreq = {}; psBuilding = []; psComplete = ''; rtText = ''; rdsBuf = '' }
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
    } catch (e) {}
  }
}

function killPipeline() {
  for (const p of [rtlProc, redseaProc, soxProc, aplayProc]) { try { if (p) p.kill('SIGTERM') } catch (e) {} }
  rtlProc = aplayProc = soxProc = redseaProc = null; rdsBuf = ''
  // backstop by exact process name (-x never self-matches the shell running it)
  try { execSync('pkill -x rtl_fm; pkill -x redsea; pkill -x sox; pkill -x aplay; true', { stdio: 'ignore' }) } catch (e) {}
  clearSpectrum()
}

function scheduleStart() {
  killPipeline()
  clearTimeout(restartTimer)
  if (!state.power || state.source !== 'FM') return
  restartTimer = setTimeout(() => {
    if (!state.power || state.source !== 'FM') return
    const st = state.settings, f = state.fm.freq.toFixed(1)
    state.nowPlaying = { title: '', artist: '' } // clear RDS from the previous station
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
    aplayProc = spawn('aplay', ['-q', '-r', String(RATE), '-f', 'S16_LE', '-t', 'raw', '-c', '1', '-D', AUDIO_DEV], { stdio: ['pipe', 'ignore', 'ignore'] })
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
function stopRadio() { clearTimeout(restartTimer); killPipeline(); state.nowPlaying = { title: 'FM Radio', artist: '' } }

// ---- Bluetooth (A2DP sink via BlueZ; PipeWire routes the audio) ----
let btctl = null, btPairTimer = null
function btEnsureAgent() {
  if (btctl && btctl.exitCode === null) return
  btctl = spawn('bluetoothctl', [], { stdio: ['pipe', 'ignore', 'ignore'] })
  btctl.on('exit', () => { btctl = null })
  btctl.stdin.on('error', () => {})
  // NoInputNoOutput => "just works" pairing (no PIN) for phones
  try { btctl.stdin.write('power on\nagent NoInputNoOutput\ndefault-agent\n') } catch (e) {}
}
function btWrite(cmds) { btEnsureAgent(); try { btctl.stdin.write(cmds + '\n') } catch (e) {} }
function btInfo(mac) { try { return execSync(`bluetoothctl info ${mac} 2>/dev/null`, { encoding: 'utf8' }) } catch (e) { return '' } }
function btScan() {
  try {
    const out = execSync('bluetoothctl devices Paired 2>/dev/null', { encoding: 'utf8' })
    const devs = out.split('\n').filter((l) => l.startsWith('Device ')).map((l) => {
      const mac = l.split(' ')[1]
      return { mac, name: l.slice(8 + mac.length).trim() || mac }
    })
    let connected = null
    for (const d of devs) {
      const info = btInfo(d.mac)
      d.connected = /Connected: yes/.test(info)
      if (d.connected) { connected = { name: d.name, mac: d.mac }; btWrite(`trust ${d.mac}`) }
    }
    state.bluetooth.available = true
    state.bluetooth.devices = devs
    state.bluetooth.connected = connected
  } catch (e) { state.bluetooth.available = true }
}
setInterval(() => { if (state.source === 'Bluetooth' || state.bluetooth.pairing) btScan() }, 4000)

const clampFm = (f) => { f = Math.round(f * 10) / 10; if (f > 107.9) return 87.5; if (f < 87.5) return 107.9; return f }

const actions = {
  power: (b) => { state.power = !!b.on; state.power ? scheduleStart() : stopRadio() },
  source: (b) => { if (b.source) state.source = b.source; scheduleStart() },
  tune: (b) => { state.fm.freq = clampFm(Number(b.freq)); if (state.power) scheduleStart() },
  seek: (b) => { state.fm.freq = clampFm(state.fm.freq + (b.dir > 0 ? 0.2 : -0.2)); if (state.power) scheduleStart() },
  preset: (b) => { const p = state.fm.presets[b.i]; if (p != null) { state.fm.freq = p; if (state.power) scheduleStart() } },
  savePreset: (b) => {
    const f = clampFm(Number(b.freq != null ? b.freq : state.fm.freq))
    if (!state.fm.presets.some((p) => Math.abs(p - f) < 0.05)) {
      state.fm.presets = [...state.fm.presets, f].sort((a, b) => a - b); savePresets()
    }
  },
  removePreset: (b) => { if (b.i >= 0 && b.i < state.fm.presets.length) { state.fm.presets.splice(b.i, 1); savePresets() } },
  volume: (b) => { state.volume = Math.max(0, Math.min(30, Math.round(Number(b.volume)))); state.muted = false; applyVolume() },
  mute: (b) => { state.muted = !!b.muted; applyVolume() },
  settings: (b) => {
    const s = state.settings
    if (b.gain !== undefined) s.gain = Math.max(-1, Math.min(49.6, Number(b.gain)))
    if (b.deemp !== undefined) s.deemp = !!b.deemp
    if (b.filter !== undefined) s.filter = !!b.filter
    if (b.squelch !== undefined) s.squelch = Math.max(0, Math.round(Number(b.squelch)))
    if (b.ppm !== undefined) s.ppm = Math.round(Number(b.ppm))
    if (state.power) scheduleStart()
  },
  btPair: () => {
    btWrite('discoverable on\npairable on')
    state.bluetooth.pairing = true
    clearTimeout(btPairTimer)
    btPairTimer = setTimeout(() => { btWrite('discoverable off'); state.bluetooth.pairing = false }, 120000)
    btScan()
  },
  btConnect: (b) => { if (b.mac) { btWrite(`connect ${b.mac}`); setTimeout(btScan, 2500) } },
  btDisconnect: () => { if (state.bluetooth.connected) { btWrite(`disconnect ${state.bluetooth.connected.mac}`); setTimeout(btScan, 1500) } },
}

// ---- HTTP + SSE ----
const sseClients = new Set()
const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }

  const path = new URL(req.url, 'http://x').pathname
  if (req.method === 'GET' && path === '/api/spectrum') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*' })
    res.write(': ok\n\n')
    sseClients.add(res)
    req.on('close', () => sseClients.delete(res))
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
server.listen(PORT, () => console.log('stereo-service listening on', PORT))
process.on('SIGTERM', () => { stopRadio(); process.exit(0) })
process.on('SIGINT', () => { stopRadio(); process.exit(0) })
