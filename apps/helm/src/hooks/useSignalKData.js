import { useEffect, useRef, useState } from 'react'

// Full SignalK delta client: opens the self stream and keeps the latest value for
// every path in a map, so a native instruments panel can render without embedding
// KIP. Batches updates into ~4/s React state pushes (the deltas arrive far faster
// than the screen needs) to keep re-renders — and CPU — low.
//
// Returns { connected, values } where values is { [path]: { value, ts } }. Use the
// `sk*` helpers below to pull converted numbers out of it.
export default function useSignalKData() {
  const [state, setState] = useState({ connected: false, values: {} })
  const store = useRef({})       // live path -> { value, ts }, mutated between flushes
  const dirty = useRef(false)

  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const url = `${proto}://${location.host}/signalk/v1/stream?subscribe=self`
    let ws, retry, closed = false

    // Push accumulated values to React at most ~4x/sec — instruments don't need 60Hz.
    const flush = setInterval(() => {
      if (!dirty.current) return
      dirty.current = false
      setState((s) => ({ connected: s.connected, values: { ...store.current } }))
    }, 250)

    const connect = () => {
      ws = new WebSocket(url)
      ws.onopen = () => setState((s) => ({ ...s, connected: true }))
      ws.onmessage = (e) => {
        let m
        try { m = JSON.parse(e.data) } catch { return }
        if (!m.updates) return
        for (const u of m.updates) {
          const ts = u.timestamp || null
          for (const v of u.values || []) {
            if (!v.path) continue
            store.current[v.path] = { value: v.value, ts }
            dirty.current = true
          }
        }
      }
      ws.onclose = () => {
        setState((s) => ({ ...s, connected: false }))
        if (!closed) retry = setTimeout(connect, 3000)
      }
      ws.onerror = () => ws.close()
    }
    connect()
    return () => { closed = true; clearInterval(flush); clearTimeout(retry); ws && ws.close() }
  }, [])

  return state
}

// ---- unit helpers (SignalK is SI: m/s, radians, metres, kelvin) ----
export const MS_TO_KN = 1.94384
export const M_TO_FT = 3.28084
const num = (values, path) => {
  const e = values[path]
  return e && typeof e.value === 'number' && isFinite(e.value) ? e.value : null
}
export const skKnots = (values, path) => { const v = num(values, path); return v == null ? null : v * MS_TO_KN }
export const skDeg = (values, path) => { const v = num(values, path); return v == null ? null : ((v * 180 / Math.PI) % 360 + 360) % 360 }
// Apparent wind angle is signed (±π, port/starboard); keep the sign as ±180°.
export const skDegSigned = (values, path) => { const v = num(values, path); return v == null ? null : (v * 180 / Math.PI) }
export const skMeters = (values, path) => num(values, path)
export const skCelsius = (values, path) => { const v = num(values, path); return v == null ? null : v - 273.15 }
export const skRaw = (values, path) => num(values, path)
export const skValue = (values, path) => { const e = values[path]; return e ? e.value : null }
