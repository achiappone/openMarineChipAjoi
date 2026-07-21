// openMarine Stereo control service — drives the RTL-SDR as an FM receiver.
// No dependencies (Node built-ins only). Exposes a small HTTP API that the helm
// StereoView calls; audio plays out the Pi's 3.5mm aux (-> BT transmitter).
const http = require('http')
const { spawn, execSync } = require('child_process')

const PORT = 8082
const AUDIO_DEV = process.env.AUDIO_DEV || 'plughw:CARD=Headphones' // 3.5mm aux
const MIXER_CARD = process.env.MIXER_CARD || 'Headphones'
const MIXER_CTL = process.env.MIXER_CTL || 'PCM'

const state = {
  connected: true,
  power: false,
  source: 'FM',
  volume: 12, // UI scale 0..30
  muted: false,
  fm: { freq: 101.5, presets: [88.5, 93.7, 101.5, 104.3, 107.9] },
  nowPlaying: { title: 'FM Radio', artist: '' },
}

let radio = null // detached bash child running rtl_fm | aplay
let restartTimer = null

function applyVolume() {
  const pct = state.muted ? 0 : Math.round((state.volume / 30) * 90)
  spawn('amixer', ['-c', MIXER_CARD, 'sset', MIXER_CTL, `${pct}%`], { stdio: 'ignore' })
}

// Synchronously kill any FM pipeline. Killing the bash wrapper alone orphans its
// rtl_fm/aplay children (they keep holding the USB tuner), so kill them by name and
// block until done — otherwise the next tune hits "usb_claim_interface error -6".
function killPipeline() {
  try {
    execSync('pkill -f rtl_fm 2>/dev/null; pkill -f "aplay .*Headphones" 2>/dev/null; true', { stdio: 'ignore' })
  } catch (e) {}
  radio = null
}

// Debounced (re)start: kill now to free the tuner, then start once taps settle.
// Rapid retunes/preset taps reset the timer so only one rtl_fm ever claims the device.
function scheduleStart() {
  killPipeline()
  clearTimeout(restartTimer)
  if (!state.power || state.source !== 'FM') return
  restartTimer = setTimeout(() => {
    if (!state.power || state.source !== 'FM') return
    const f = state.fm.freq.toFixed(1)
    const cmd =
      `rtl_fm -f ${f}M -M wbfm -s 200000 -r 48000 -l 0 -E deemp - 2>/dev/null | ` +
      `aplay -q -r 48000 -f S16_LE -t raw -c 1 -D ${AUDIO_DEV}`
    radio = spawn('bash', ['-c', cmd], { detached: true, stdio: 'ignore' })
    radio.unref()
    setTimeout(applyVolume, 500)
  }, 700) // let the USB device release + coalesce rapid taps
}

function stopRadio() { clearTimeout(restartTimer); killPipeline() }

const clampFm = (f) => {
  f = Math.round(f * 10) / 10
  if (f > 107.9) return 87.5
  if (f < 87.5) return 107.9
  return f
}

const actions = {
  power: (b) => { state.power = !!b.on; state.power ? scheduleStart() : stopRadio() },
  source: (b) => { if (b.source) state.source = b.source; scheduleStart() },
  tune: (b) => { state.fm.freq = clampFm(Number(b.freq)); if (state.power) scheduleStart() },
  seek: (b) => { state.fm.freq = clampFm(state.fm.freq + (b.dir > 0 ? 0.2 : -0.2)); if (state.power) scheduleStart() },
  preset: (b) => { const p = state.fm.presets[b.i]; if (p != null) { state.fm.freq = p; if (state.power) scheduleStart() } },
  volume: (b) => { state.volume = Math.max(0, Math.min(30, Math.round(Number(b.volume)))); state.muted = false; applyVolume() },
  mute: (b) => { state.muted = !!b.muted; applyVolume() },
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end() }

  const path = new URL(req.url, 'http://x').pathname
  if (req.method === 'GET' && path === '/api/state') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    return res.end(JSON.stringify(state))
  }
  const name = path.replace('/api/', '')
  if (req.method === 'POST' && actions[name]) {
    let body = ''
    req.on('data', (d) => (body += d))
    req.on('end', () => {
      let b = {}
      try { b = body ? JSON.parse(body) : {} } catch (e) {}
      try { actions[name](b) } catch (e) {}
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(state))
    })
    return
  }
  res.writeHead(404); res.end('not found')
})

killPipeline() // clear any orphaned rtl_fm/aplay from a previous run
server.listen(PORT, () => console.log('stereo-service listening on', PORT))
process.on('SIGTERM', () => { stopRadio(); process.exit(0) })
process.on('SIGINT', () => { stopRadio(); process.exit(0) })
