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
const PRESETS_FILE = `${__dirname}/presets.json`
const RATE = 48000
const FFT_SIZE = 1024
const NBANDS = 32

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

// ---- FM pipeline (rtl_fm -> tap -> aplay) ----
let rtlProc = null, aplayProc = null, restartTimer = null

function applyVolume() {
  const pct = state.muted ? 0 : Math.round((state.volume / 30) * 90)
  spawn('amixer', ['-c', MIXER_CARD, 'sset', MIXER_CTL, `${pct}%`], { stdio: 'ignore' })
}

function killPipeline() {
  try { if (rtlProc) rtlProc.kill('SIGTERM') } catch (e) {}
  try { if (aplayProc) aplayProc.kill('SIGTERM') } catch (e) {}
  rtlProc = null; aplayProc = null
  try { execSync('pkill -f rtl_fm 2>/dev/null; pkill -f "aplay .*Headphones" 2>/dev/null; true', { stdio: 'ignore' }) } catch (e) {}
  clearSpectrum()
}

function scheduleStart() {
  killPipeline()
  clearTimeout(restartTimer)
  if (!state.power || state.source !== 'FM') return
  restartTimer = setTimeout(() => {
    if (!state.power || state.source !== 'FM') return
    const st = state.settings, f = state.fm.freq.toFixed(1)
    const args = ['-f', `${f}M`, '-M', 'wbfm', '-s', '200000', '-r', String(RATE)]
    if (st.filter) args.push('-F', '9')
    if (st.deemp) args.push('-E', 'deemp')
    args.push('-l', String(st.squelch || 0), '-p', String(st.ppm || 0))
    if (st.gain >= 0) args.push('-g', String(st.gain))
    args.push('-')
    rtlProc = spawn('rtl_fm', args, { stdio: ['ignore', 'pipe', 'ignore'] })
    aplayProc = spawn('aplay', ['-q', '-r', String(RATE), '-f', 'S16_LE', '-t', 'raw', '-c', '1', '-D', AUDIO_DEV],
      { stdio: ['pipe', 'ignore', 'ignore'] })
    rtlProc.stdout.pipe(aplayProc.stdin)
    rtlProc.stdout.on('data', pushAudio)
    aplayProc.stdin.on('error', () => {})
    rtlProc.on('error', () => {})
    setTimeout(applyVolume, 500)
  }, 700)
}
function stopRadio() { clearTimeout(restartTimer); killPipeline() }

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
