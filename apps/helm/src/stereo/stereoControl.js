// The control contract the Stereo view speaks to.
//
// The DIY FM receiver (an FM tuner IC — e.g. RDA5807M / Si4703 — driven by an ESP32
// or the Pi) will implement this SAME shape later, over HTTP/WebSocket. Today it's a
// local mock so the whole UI is buildable before the hardware exists. When the real
// unit lands, swap createMockStereo() for a client that talks to it; the view doesn't
// change.

export const SOURCES = ['FM', 'Bluetooth', 'Aux']

export const FM_MIN = 87.5
export const FM_MAX = 107.9
export const VOL_MAX = 30

const round1 = (f) => Math.round(f * 10) / 10
const clampFm = (f) => (f > FM_MAX ? FM_MIN : f < FM_MIN ? FM_MAX : round1(f))

export function createMockStereo(onChange) {
  const state = {
    connected: false, // real hardware not present yet
    power: false,
    source: 'FM',
    volume: 12,
    muted: false,
    fm: { freq: 101.5, presets: [88.5, 93.7, 101.5, 104.3, 107.9] },
    nowPlaying: { title: '—', artist: '' },
  }

  const emit = () =>
    onChange({
      ...state,
      fm: { ...state.fm, presets: [...state.fm.presets] },
      nowPlaying: { ...state.nowPlaying },
    })

  const api = {
    getState: () => state,
    setPower: (v) => ((state.power = v), emit()),
    setSource: (s) => ((state.source = s), emit()),
    setVolume: (v) => ((state.volume = Math.max(0, Math.min(VOL_MAX, Math.round(v))), (state.muted = false)), emit()),
    toggleMute: () => ((state.muted = !state.muted), emit()),
    tune: (freq) => ((state.fm.freq = clampFm(freq)), emit()),
    seek: (dir) => ((state.fm.freq = clampFm(state.fm.freq + dir * 0.2)), emit()),
    selectPreset: (i) => ((state.fm.freq = state.fm.presets[i] ?? state.fm.freq), emit()),
  }

  emit()
  return api
}
