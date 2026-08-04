import { createContext, useContext, useEffect, useState, useRef, useCallback } from 'react'
import { Box, Typography } from '@mui/material'

// Softkeys: physical buttons down the right edge of the bezel, with their labels drawn
// on screen right next to them. The labels are context-sensitive — each view says what
// its keys do — so four buttons cover the whole boat without a legend to memorise.
//
// Geometry is adjustable and persisted, because "aligned with the buttons" depends on
// the bracket, the bezel and where the display ends up sitting. Settings -> Config has
// the alignment controls with guides.

const KEY_COUNT = 4        // physical keys
const LABEL_COUNT = 3      // key 4 (mode) needs no label: the corner dial shows it
const GEOM_KEY = 'helm.softkeys'
const DEFAULT_GEOM = { top: 12, spacing: 22, width: 96, enabled: true, knobRight: 4, knobTop: 86, knobSize: 260, knobPopup: true }

export function loadSoftkeyGeom() {
  try { return { ...DEFAULT_GEOM, ...(JSON.parse(localStorage.getItem(GEOM_KEY)) || {}) } } catch (e) { return { ...DEFAULT_GEOM } }
}
export function saveSoftkeyGeom(g) {
  try { localStorage.setItem(GEOM_KEY, JSON.stringify(g)) } catch (e) { /* private mode */ }
  try { window.dispatchEvent(new CustomEvent('helm-softkeys-geom', { detail: g })) } catch (e) { /* SSR */ }
}

const SoftkeyContext = createContext({ setKeys: () => {}, keys: [] })

export function SoftkeyProvider({ children }) {
  const [keys, setKeys] = useState([])
  return <SoftkeyContext.Provider value={{ keys, setKeys }}>{children}</SoftkeyContext.Provider>
}

// A view calls this with its four key definitions: { label, sub, onPress, onLong }.
// Pass null for an unused slot — it renders dimmed rather than disappearing, so the
// physical buttons never appear to move.
export function useSoftkeys(defs, deps = []) {
  const { setKeys } = useContext(SoftkeyContext)
  useEffect(() => {
    setKeys(defs || [])
    return () => setKeys([])
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}

export function useSoftkeyDispatch() {
  return useContext(SoftkeyContext).keys
}

// The on-screen rail. Slots are positioned by percentage of viewport height so they can
// be lined up against real buttons on the bezel.
export default function SoftkeyRail({ geom, flash, defaults = [], overrides = [] }) {
  const { keys } = useContext(SoftkeyContext)
  if (!geom.enabled) return null
  return (
    // Fills the shell's rail column. The labels stay hard against the right edge at their
    // calibrated size, because they have to line up with real buttons on the bezel — the
    // column being wider than they are is what keeps the page content clear of them.
    <Box sx={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0, pointerEvents: 'none', zIndex: 1200 }}>
      {Array.from({ length: LABEL_COUNT }).map((_, i) => {
        const k = keys[i] || defaults[i] || null
        const topPct = geom.top + i * geom.spacing
        const lit = flash === i
        return (
          <Box key={i} sx={{
            position: 'absolute', right: 6, top: `${topPct}%`, width: geom.width - 12,
            transform: 'translateY(-50%)',
            display: 'flex', flexDirection: 'column', alignItems: 'center',
            opacity: k ? 1 : 0.35,
          }}>
            {overrides[i] || (
              <>
                {/* Round, because the physical keys are 12mm round push buttons — the
                    label should look like the thing your finger is about to press. */}
                <Box sx={{
                  width: geom.width - 22, height: geom.width - 22, borderRadius: '50%',
                  display: 'flex', alignItems: 'center', justifyContent: 'center',
                  bgcolor: lit ? 'rgba(57,198,216,0.45)' : 'rgba(0,0,0,0.62)',
                  border: '2px solid', borderColor: lit ? '#39c6d8' : 'rgba(255,255,255,0.30)',
                  boxShadow: lit ? '0 0 14px rgba(57,198,216,0.55)' : 'none',
                  transition: 'background-color 90ms linear, box-shadow 90ms linear',
                }}>
                  <Typography noWrap sx={{
                    fontWeight: 800, lineHeight: 1.1, textAlign: 'center', px: 0.5,
                    fontSize: (k && k.label && k.label.length > 4) ? '0.82rem' : '1.05rem',
                    color: k ? '#fff' : 'rgba(255,255,255,0.6)',
                  }}>
                    {k ? k.label : '—'}
                  </Typography>
                </Box>
                {k && k.sub ? (
                  <Typography noWrap sx={{ fontSize: '0.66rem', opacity: 0.7, mt: 0.35, maxWidth: '100%' }}>
                    {k.sub}
                  </Typography>
                ) : null}
              </>
            )}
          </Box>
        )
      })}
    </Box>
  )
}

// Subscribes to the service's input stream and fires the registered handlers. Kept at
// app level so it survives view changes, and so a press always lands somewhere even if
// the current view registered nothing.
export function useSoftkeyInput({ onScreenCycle, onHome, onMode, onKey, onVolume, onTune, onDelta }) {
  const { keys } = useContext(SoftkeyContext)
  const keysRef = useRef(keys)
  keysRef.current = keys
  const [flash, setFlash] = useState(null)
  const [mode, setMode] = useState('volume')
  const hRef = useRef({ onScreenCycle, onHome, onMode, onKey, onVolume, onTune, onDelta })
  hRef.current = { onScreenCycle, onHome, onMode, onKey, onVolume, onTune, onDelta }

  const fire = useCallback((idx, long) => {
    setFlash(idx); setTimeout(() => setFlash((f) => (f === idx ? null : f)), 160)
    const k = keysRef.current[idx]
    if (long && k && k.onLong) return k.onLong()
    if (!long && k && k.onPress) return k.onPress()
    // Nothing registered for this slot: fall back to the global meanings so the top
    // key always cycles screens, whatever is on screen.
    if (idx === 0) return long ? hRef.current.onHome && hRef.current.onHome() : hRef.current.onScreenCycle && hRef.current.onScreenCycle()
    if (hRef.current.onKey) return hRef.current.onKey(idx, long)
  }, [])

  useEffect(() => {
    let es
    const SVC = `http://${location.hostname}:8082`
    try {
      es = new EventSource(`${SVC}/api/input`)
      es.onmessage = (e) => {
        let d
        try { d = JSON.parse(e.data) } catch (x) { return }
        if (d.type === 'volume') { if (hRef.current.onVolume) hRef.current.onVolume(d.value); return }
        if (d.type === 'tune') { if (hRef.current.onTune) hRef.current.onTune(d.value); return }
        if ((d.type === 'nav' || d.type === 'value') && hRef.current.onDelta) { hRef.current.onDelta(d.delta); return }
        if (d.type === 'mode') { setMode(d.value); if (hRef.current.onMode) hRef.current.onMode(d.value); return }
        if (d.type === 'button') {
          // GPA2..GPA5 -> slots 0..3
          const idx = d.pin - 2
          if (idx >= 0 && idx < KEY_COUNT) fire(idx, d.press === 'long')
        }
      }
    } catch (x) { /* no service: on-screen only */ }
    return () => es && es.close()
  }, [fire])

  return { flash, mode, fire }
}
