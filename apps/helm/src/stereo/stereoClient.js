// Talks to the stereo-service on the Pi (RTL-SDR FM). Same host the helm app is
// served from, port 8082 — works both in the Pi kiosk (localhost) and from a
// laptop browser (openplotter.local). Drop-in replacement for createMockStereo:
// same state shape and method names, so StereoView is unchanged otherwise.
const BASE = `http://${location.hostname}:8082/api`

const OFFLINE = {
  connected: false, power: false, source: 'FM', volume: 0, muted: false,
  fm: { freq: 101.5, presets: [] }, nowPlaying: { title: '', artist: '' },
}

export function createRadioClient(onChange) {
  let state = null
  // After a local volume/mute change, hold the local value briefly so a 2s poll
  // that's still carrying the server's older value can't snap the slider back.
  let holdUntil = 0, holdVol = null, holdMuted = null
  const apply = (s) => {
    if (s && Date.now() < holdUntil) {
      s = { ...s }
      if (holdVol != null) s.volume = holdVol
      if (holdMuted != null) s.muted = holdMuted
    }
    state = s; onChange(s)
  }

  const refresh = () =>
    fetch(`${BASE}/state`).then((r) => r.json()).then(apply).catch(() => apply(OFFLINE))

  const post = (name, body) =>
    fetch(`${BASE}/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then((r) => r.json()).then(apply).catch(() => apply(OFFLINE))

  refresh()
  const poll = setInterval(refresh, 2000)

  // Optimistic frequency update so the display/slider move instantly on tap,
  // instead of waiting for the POST round-trip.
  const clampFm = (f) => { f = Math.round(f * 10) / 10; if (f > 107.9) return 87.5; if (f < 87.5) return 107.9; return f }
  const optimisticFreq = (f) => { if (state && state.fm) { state = { ...state, fm: { ...state.fm, freq: clampFm(f) } }; onChange(state) } }
  const optimisticVol = (v, muted) => {
    if (!state) return
    const patch = {}
    if (v != null) { patch.volume = Math.max(0, Math.min(30, Math.round(v))); patch.muted = false; holdVol = patch.volume; holdMuted = false }
    if (muted != null) { patch.muted = muted; holdMuted = muted }
    holdUntil = Date.now() + 1500
    state = { ...state, ...patch }; onChange(state)
  }
  // Throttle mixer POSTs to ~8/sec (leading + trailing) so dragging stays smooth.
  let volT = null, volLast = null
  const sendVol = (v) => {
    volLast = v
    if (volT) return
    post('volume', { volume: v })
    volT = setTimeout(() => { volT = null; if (volLast !== v) post('volume', { volume: volLast }) }, 120)
  }

  return {
    getState: () => state,
    setPower: (v) => post('power', { on: v }),
    setSource: (s) => post('source', { source: s }),
    setVolume: (v) => { optimisticVol(v); sendVol(Math.round(v)) },
    toggleMute: () => { const m = !(state && state.muted); optimisticVol(null, m); return post('mute', { muted: m }) },
    setMuted: (m) => { optimisticVol(null, !!m); return post('mute', { muted: !!m }) },
    tune: (freq) => { optimisticFreq(freq); return post('tune', { freq }) },
    seek: (dir) => { if (state && state.fm) optimisticFreq(state.fm.freq + dir * 0.2); return post('seek', { dir }) },
    selectPreset: (i) => { if (state && state.fm && state.fm.presets[i] != null) optimisticFreq(state.fm.presets[i]); return post('preset', { i }) },
    savePreset: (freq) => post('savePreset', freq != null ? { freq } : {}),
    removePreset: (i) => post('removePreset', { i }),
    renamePreset: (i, name) => post('renamePreset', { i, name }),
    setSettings: (patch) => post('settings', patch),
    btPair: () => post('btPair', {}),
    btConnect: (mac) => post('btConnect', { mac }),
    btForget: (mac) => post('btForget', { mac }),
    btDisconnect: () => post('btDisconnect', {}),
    btCancelPair: () => post('btCancelPair', {}),
    btPlayPause: () => post('btPlayPause', {}),
    btNext: () => post('btNext', {}),
    btPrev: () => post('btPrev', {}),
    btShuffle: () => post('btShuffle', {}),
    btRepeat: () => post('btRepeat', {}),
    btSeek: (sec) => post('btSeek', { sec }),
    // Library browse: these return their own JSON (not the shared state), so they
    // bypass `post`/`apply` — the caller handles the result itself.
    btBrowse: (p) => fetch(`${BASE}/btbrowse?path=${encodeURIComponent(p || 'root')}`)
      .then((r) => r.json()).catch(() => ({ ok: false, reason: 'offline' })),
    btPlayItem: (p) => fetch(`${BASE}/btplay`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: p }),
    }).then((r) => r.json()).catch(() => ({ ok: false })),
    stop: () => clearInterval(poll),
  }
}
