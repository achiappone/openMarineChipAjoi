import { useEffect, useState } from 'react'

// Lightweight SignalK connection indicator. Opens the delta WebSocket (same origin
// in production, proxied to the Pi in dev) and reports connected state + whether
// data is actually flowing. Not a full client — just enough to show a status chip.
export default function useSignalKStatus() {
  const [status, setStatus] = useState({ connected: false, deltas: 0 })

  useEffect(() => {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws'
    const url = `${proto}://${location.host}/signalk/v1/stream?subscribe=self`
    let ws, retry, deltas = 0, closed = false

    const connect = () => {
      ws = new WebSocket(url)
      ws.onopen = () => setStatus((s) => ({ ...s, connected: true }))
      ws.onmessage = (e) => {
        try {
          const m = JSON.parse(e.data)
          if (m.updates) { deltas += 1; setStatus({ connected: true, deltas }) }
        } catch { /* ignore non-JSON frames */ }
      }
      ws.onclose = () => {
        setStatus((s) => ({ ...s, connected: false }))
        if (!closed) retry = setTimeout(connect, 3000)
      }
      ws.onerror = () => ws.close()
    }
    connect()
    return () => { closed = true; clearTimeout(retry); ws && ws.close() }
  }, [])

  return status
}
