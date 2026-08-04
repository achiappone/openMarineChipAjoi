import { useSyncExternalStore } from 'react'

// Live control values (volume, tuned frequency, knob mode), delivered from the service
// over SSE the instant a detent lands.
//
// This is a module-level store rather than state in the app shell, and that distinction
// is the whole point. Held in the shell, every event re-rendered the entire tree — all
// views stay mounted by design, so a knob spin at 50 events/second re-rendered the
// plotter, the instruments and the stereo view too. As a store, only the components that
// actually subscribe re-render, and the rest never hear about it.
//
// The polled /api/state remains authoritative; these are display overrides that expire
// as soon as it agrees.

const SVC = `http://${location.hostname}:8082`

let snapshot = { volume: null, freq: null, mode: 'volume', dir: 0, turning: false, at: 0 }
const listeners = new Set()
let source = null
let idleTimer = null

function emit(next) {
  snapshot = { ...snapshot, ...next }
  for (const l of listeners) l()
}

function connect() {
  if (source) return
  try {
    source = new EventSource(`${SVC}/api/input`)
    source.onmessage = (e) => {
      let d
      try { d = JSON.parse(e.data) } catch (x) { return }
      if (d.type === 'mode') return emit({ mode: d.value })
      if (d.type === 'volume' || d.type === 'tune') {
        const key = d.type === 'volume' ? 'volume' : 'freq'
        const prev = snapshot[key]
        emit({
          [key]: d.value,
          dir: prev == null ? 0 : Math.sign(d.value - prev),
          turning: true,
          at: Date.now(),
        })
        clearTimeout(idleTimer)
        idleTimer = setTimeout(() => emit({ turning: false, dir: 0 }), 900)
      }
    }
    source.onerror = () => { /* EventSource reconnects on its own */ }
  } catch (e) { /* no service: views fall back to polled values */ }
}

function subscribe(fn) {
  connect()
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
    // Deliberately keep the connection open: the helm is a kiosk that runs for weeks,
    // and churning an SSE socket on every view switch costs more than holding one.
  }
}

const getSnapshot = () => snapshot

export function useLiveControls() {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

// Ask the service to point the knob at something. The service is authoritative for the
// mode; we do not set it locally and hope, we wait for the echo on the stream.
export function setKnobMode(mode) {
  fetch(`${SVC}/api/encoder/mode?mode=${encodeURIComponent(mode)}`, { method: 'POST' }).catch(() => {})
}

export function knobService() { return SVC }
