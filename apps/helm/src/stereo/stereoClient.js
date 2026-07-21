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
  const apply = (s) => { state = s; onChange(s) }

  const refresh = () =>
    fetch(`${BASE}/state`).then((r) => r.json()).then(apply).catch(() => apply(OFFLINE))

  const post = (name, body) =>
    fetch(`${BASE}/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then((r) => r.json()).then(apply).catch(() => apply(OFFLINE))

  refresh()
  const poll = setInterval(refresh, 5000)

  return {
    getState: () => state,
    setPower: (v) => post('power', { on: v }),
    setSource: (s) => post('source', { source: s }),
    setVolume: (v) => post('volume', { volume: v }),
    toggleMute: () => post('mute', { muted: !(state && state.muted) }),
    tune: (freq) => post('tune', { freq }),
    seek: (dir) => post('seek', { dir }),
    selectPreset: (i) => post('preset', { i }),
    savePreset: (freq) => post('savePreset', freq != null ? { freq } : {}),
    removePreset: (i) => post('removePreset', { i }),
    setSettings: (patch) => post('settings', patch),
    stop: () => clearInterval(poll),
  }
}
