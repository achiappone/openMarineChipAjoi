import { useState, useEffect, useRef } from 'react'
import { Box, Tabs, Tab, Chip, Stack, Typography, Button, ToggleButton, ToggleButtonGroup, Slider, IconButton } from '@mui/material'
import VolumeUpIcon from '@mui/icons-material/VolumeUp'
import VolumeOffIcon from '@mui/icons-material/VolumeOff'
import SettingsIcon from '@mui/icons-material/Settings'
import EmbeddedApp from './components/EmbeddedApp'
import StereoView, { SettingsDialog } from './views/StereoView'
import StereoCompact from './views/StereoCompact'
import Instruments from './views/Instruments'
import { createRadioClient } from './stereo/stereoClient'
import { VOL_MAX } from './stereo/stereoControl'
import useSignalKStatus from './hooks/useSignalKStatus'
import SoftkeyRail, { SoftkeyProvider, useSoftkeyInput, loadSoftkeyGeom } from './components/Softkeys'
import ControlCards, { CARD_W, CARD_H } from './components/ControlCards'
import { useLiveControls } from './lib/liveControls'

// Root-absolute so it works both on the Pi (same origin :3000) and via the Vite
// dev proxy on the laptop.
const FREEBOARD = '/@signalk/freeboard-sk/'
const SVC = `http://${location.hostname}:8082`

// Volume slider whose track IS a live audio level meter (fed by the stereo
// spectrum feed): the coloured fill reacts to the music while the fader thumb
// still sets the volume. Green→amber→red with a peak-hold marker.
// Subscribes on its own so a knob detent re-renders one <span>, not the app.
function LiveVolumeNumber({ polled }) {
  const live = useLiveControls()
  return <>{live.volume != null ? live.volume : polled}</>
}

function VolumeSlider({ value, muted, onCommit }) {
  const maskRef = useRef(null), peakRef = useRef(null)
  const levelRef = useRef(0), pkRef = useRef(0), mutedRef = useRef(muted)
  mutedRef.current = muted
  // Dragging is purely frontend/instant (local state, no backend, no app re-render);
  // the volume is pushed to the backend only once, when the finger lifts.
  const [dragVal, setDragVal] = useState(null)
  const live = useLiveControls()
  // Priority: your finger, then the knob, then the polled state.
  const base = live.volume != null ? live.volume : value
  const shown = dragVal != null ? dragVal : (muted ? 0 : base)
  const handleCommit = (_, v) => { onCommit(v); setDragVal(null) }
  useEffect(() => {
    let es
    try {
      es = new EventSource(`${SVC}/api/spectrum`)
      es.onmessage = (e) => {
        try { const spec = JSON.parse(e.data); let s = 0; for (let i = 0; i < spec.length; i++) { const x = spec[i] || 0; s += x * x } levelRef.current = Math.sqrt(s / (spec.length || 1)) } catch (x) {}
      }
    } catch (x) {}
    return () => es && es.close()
  }, [])
  useEffect(() => {
    // This meter is always on screen (bottom bar), so keep it cheap: cap to 20fps
    // and only touch the DOM when the level/peak actually moved. Writing .style
    // every frame forces layout+paint in the renderer — the app's biggest cost.
    let raf, last = 0, prevL = -1, prevP = -1
    const FRAME_MS = 1000 / 20
    const loop = (now) => {
      raf = requestAnimationFrame(loop)
      if (now - last < FRAME_MS) return
      last = now
      let lvl = (levelRef.current - 0.12) * 2.4; lvl = lvl < 0 ? 0 : lvl > 1 ? 1 : lvl
      if (mutedRef.current) lvl = 0
      pkRef.current = Math.max(lvl, pkRef.current - 0.015)
      const lr = Math.round(lvl * 200), pr = Math.round(pkRef.current * 200) // ~0.5% steps
      if (lr !== prevL && maskRef.current) { maskRef.current.style.left = `${lvl * 100}%`; prevL = lr }
      if (pr !== prevP && peakRef.current) {
        peakRef.current.style.left = `${pkRef.current * 100}%`
        peakRef.current.style.opacity = pkRef.current > 0.03 ? '0.85' : '0'
        prevP = pr
      }
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])
  return (
    <Box sx={{ flex: 1, position: 'relative', display: 'flex', alignItems: 'center', height: 40 }}>
      {/* reactive level track: full-width gradient revealed up to the live level */}
      <Box sx={{ position: 'absolute', left: 0, right: 0, top: '50%', transform: 'translateY(-50%)', height: 16, borderRadius: 8, overflow: 'hidden', pointerEvents: 'none' }}>
        <Box sx={{ position: 'absolute', inset: 0, background: 'linear-gradient(90deg,#3ddc84 0%,#3ddc84 52%,#f5a623 78%,#ff4033 100%)' }} />
        {/* light-gray covers the portion above the current level */}
        <Box ref={maskRef} sx={{ position: 'absolute', top: 0, bottom: 0, right: 0, left: '0%', bgcolor: '#9aa5af' }} />
      </Box>
      <Box ref={peakRef} sx={{ position: 'absolute', top: '50%', left: '0%', transform: 'translate(-50%,-50%)', width: 3, height: 20, bgcolor: '#fff', opacity: 0, pointerEvents: 'none', borderRadius: 1 }} />
      {/* fader thumb sets the volume; rail/track hidden so the meter shows through */}
      <Slider value={shown} min={0} max={VOL_MAX} step={1} onChange={(_, v) => setDragVal(v)} onChangeCommitted={handleCommit} valueLabelDisplay="auto"
        sx={{ flex: 1, position: 'relative', zIndex: 2, py: 1.5,
          '& .MuiSlider-rail': { opacity: 0 },
          '& .MuiSlider-track': { opacity: 0, border: 'none' },
          '& .MuiSlider-thumb': { width: 18, height: 30, borderRadius: 1, bgcolor: '#fff', boxShadow: '0 0 4px rgba(0,0,0,0.6), 0 0 0 1px rgba(0,0,0,0.4)', '&:hover, &.Mui-focusVisible': { boxShadow: '0 0 0 8px rgba(255,255,255,0.16)' } } }} />
    </Box>
  )
}


// The plotter is an iframe (Freeboard-SK, same origin), so we can reach into it. It
// renders with OpenLayers, which zooms on wheel events over the map viewport — that's a
// more robust hook than guessing at internal APIs that change between releases.
function zoomPlotter(dir) {
  try {
    const f = document.querySelector('iframe[title^="Plotter"]')
    const doc = f && (f.contentDocument || (f.contentWindow && f.contentWindow.document))
    if (!doc) return
    const el = doc.querySelector('.ol-viewport') || doc.querySelector('canvas') || doc.body
    const r = el.getBoundingClientRect()
    el.dispatchEvent(new WheelEvent('wheel', {
      deltaY: dir > 0 ? -120 : 120, clientX: r.width / 2, clientY: r.height / 2,
      bubbles: true, cancelable: true, view: f.contentWindow,
    }))
  } catch (e) { /* cross-origin or not loaded yet */ }
}

// Presets, not tracks: on the stereo screens these keys step through the saved FM
// presets and wrap around, which is what a car head unit does with the same buttons.
function stepPreset(dir, st) {
  try {
    if (!st) return
    const presets = (st.fm && st.fm.presets) || []
    if (!presets.length) return
    const cur = presets.findIndex((p) => Math.abs(p.freq - st.fm.freq) < 0.05)
    const next = cur < 0 ? (dir > 0 ? 0 : presets.length - 1)
      : (cur + dir + presets.length) % presets.length
    fetch(`${SVC}/api/preset`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ i: next }),
    })
  } catch (e) { /* service down */ }
}

const TABS = [
  { id: 'plotter', label: 'Plotter' },
  { id: 'instruments', label: 'Instruments' },
  { id: 'stereo', label: 'Stereo' },
  { id: 'all', label: 'All' },
  { id: 'split', label: 'Split' },
]

// Surfaces the Split view can place in either pane.
const SPLIT_CHOICES = [
  { id: 'plotter', label: 'Plotter' },
  { id: 'instruments', label: 'Instruments' },
  { id: 'stereo', label: 'Stereo' },
]
const SEL_BAR = 8 // % of the surface area reserved at bottom for the pane selectors

// Split view: each selected surface fills its half above the selector bar. Stereo
// uses the compact section (StereoCompact), which scales to fill the pane.
function splitLayout(left, right) {
  const key = (ch) => (ch === 'stereo' ? 'stereoCompact' : ch)
  const L = {}
  L[key(left)] = { top: 0, left: 0, width: 50, height: 100 - SEL_BAR }
  L[key(right)] = { top: 0, left: 50, width: 50, height: 100 - SEL_BAR }
  return L
}

const FULL = { top: 0, left: 0, width: 100, height: 100 }

// For each tab, where each surface sits (in %). A surface absent from the map is
// hidden for that tab. Surfaces never unmount — only their rect/visibility changes —
// so Freeboard and KIP keep their state across tab switches.
function layoutFor(tabId) {
  switch (tabId) {
    case 'plotter': return { plotter: FULL }
    case 'instruments': return { instruments: FULL }
    case 'stereo': return { stereo: FULL }
    // Plotter on the left; instruments over the compact stereo section on the right.
    // The All view uses its own StereoCompact section (not the full StereoView).
    case 'all': return {
      plotter: { top: 0, left: 0, width: 55, height: 100 },
      instruments: { top: 0, left: 55, width: 45, height: 52 },
      stereoCompact: { top: 52, left: 55, width: 45, height: 48 },
    }
    default: return {}
  }
}

function Surface({ rect, children }) {
  const shown = !!rect
  const r = rect || FULL
  return (
    <Box
      sx={{
        position: 'absolute',
        top: `${r.top}%`, left: `${r.left}%`, width: `${r.width}%`, height: `${r.height}%`,
        display: shown ? 'block' : 'none',
        overflow: 'hidden',
        borderLeft: r.left > 0 ? '1px solid rgba(255,255,255,0.12)' : 0,
        borderTop: r.top > 0 ? '1px solid rgba(255,255,255,0.12)' : 0,
        transition: 'top .18s, left .18s, width .18s, height .18s',
      }}
    >
      {children}
    </Box>
  )
}

const validTab = (id) => (TABS.some((t) => t.id === id) ? id : 'plotter')

function AppShell() {
  // Initial tab from the URL hash (e.g. #all), so a view is deep-linkable and the
  // boot kiosk can open straight into a chosen page.
  const [tab, setTabState] = useState(() => validTab(location.hash.replace('#', '')))
  const setTab = (id) => { setTabState(id); history.replaceState(null, '', `#${id}`) }
  const sk = useSignalKStatus()

  // Split view: which surface each pane shows. Picking a surface already on the
  // other side swaps them (a single iframe can't live in two places at once).
  const [splitLeft, setSplitLeft] = useState('plotter')
  const [splitRight, setSplitRight] = useState('instruments')
  const setSide = (side, v) => {
    if (side === 'left') { if (v === splitRight) setSplitRight(splitLeft); setSplitLeft(v) }
    else { if (v === splitLeft) setSplitLeft(splitRight); setSplitRight(v) }
  }
  const L = tab === 'split' ? splitLayout(splitLeft, splitRight) : layoutFor(tab)

  // Lightweight stereo client so MUTE lives in the global page bar (always
  // reachable, whatever tab is open). The Stereo views keep their own clients.
  const [stereo, setStereo] = useState(null)
  const stereoCtl = useRef(null)
  useEffect(() => {
    stereoCtl.current = createRadioClient(setStereo)
    return () => { stereoCtl.current && stereoCtl.current.stop && stereoCtl.current.stop() }
  }, [])
  // Local optimistic mute so the button flips the instant it's tapped, regardless
  // of client/poll timing; hands back to server truth after a short window.
  // Settings is a global interface (stereo, system, …), so it lives in the bottom
  // toolbar rather than inside the stereo view.
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [settingsTab, setSettingsTab] = useState('bluetooth')
  const [localMute, setLocalMute] = useState(null)
  const localMuteT = useRef(null)
  const muted = localMute != null ? localMute : !!(stereo && stereo.muted)
  const toggleGlobalMute = () => {
    const m = !muted
    setLocalMute(m)
    clearTimeout(localMuteT.current)
    localMuteT.current = setTimeout(() => setLocalMute(null), 1500)
    stereoCtl.current && stereoCtl.current.setMuted(m)
  }

  // Physical softkeys: top key always cycles screens (long-press goes home) unless the
  // active view has claimed it. Everything else is per-view.
  const tabRef = useRef(tab)
  tabRef.current = tab
  const stereoRef = useRef(null)
  stereoRef.current = stereo
  const { flash, mode } = useSoftkeyInput({
    onScreenCycle: () => setTab((t) => TABS[(TABS.findIndex((x) => x.id === t) + 1) % TABS.length].id),
    onHome: () => setTab('instruments'),
    onKey: (idx) => {
      // Global fallbacks for slots 2 and 3 while no view has claimed them.
      const t = tabRef.current
      if (idx !== 1 && idx !== 2) return
      if (t === 'plotter') return zoomPlotter(idx === 1 ? 1 : -1)
      if (t === 'stereo' || t === 'all' || t === 'split') return stepPreset(idx === 1 ? 1 : -1, stereoRef.current)
    },
  })

  const [geom, setGeom] = useState(loadSoftkeyGeom)
  // Per-screen defaults so the rail is never blank. A view can override any slot by
  // registering its own with useSoftkeys(); these are what show until it does.
  const KNOB = { volume: 'VOLUME', tune: 'FM TUNE', nav: 'NAVIGATE', value: 'ADJUST' }
  // screen moves, and the label it replaces is the one describing that very knob.
  const skOverrides = []
  const skDefaults = (
    tab === 'plotter' ? [{ label: 'VIEW', sub: 'hold = home' }, { label: 'ZOOM +' }, { label: 'ZOOM −' }]
      : tab === 'stereo' || tab === 'all' || tab === 'split' ? [{ label: 'VIEW', sub: 'hold = home' }, { label: 'NEXT' }, { label: 'PREV' }]
        : [{ label: 'VIEW', sub: 'hold = home' }, { label: '—' }, { label: '—' }]
  )
  useEffect(() => {
    const on = (e) => setGeom(e.detail || loadSoftkeyGeom())
    window.addEventListener('helm-softkeys-geom', on)
    return () => window.removeEventListener('helm-softkeys-geom', on)
  }, [])

  // One number owns the right edge. The softkey labels and the knob cards used to be
  // independent fixed-position overlays, each hoping the content had padded enough for it
  // — so the cards, being the wider of the two, sat on top of the GPS row and the task
  // bar. Now the shell is a grid with a real rail column, and everything in it is sized
  // from RAIL_W. Content can't run under the rail because the grid won't let it.
  const RAIL_W = Math.max(geom.enabled ? geom.width : 0, CARD_W)

  return (
    <Box sx={{ height: '100%', display: 'grid', gridTemplateColumns: `1fr ${RAIL_W}px`, gridTemplateRows: '1fr auto' }}>
      {/* Surfaces — all mounted, positioned per tab */}
      <Box sx={{ gridColumn: 1, gridRow: 1, position: 'relative', minHeight: 0, minWidth: 0, overflow: 'hidden' }}>
        <Surface rect={L.plotter}><EmbeddedApp src={FREEBOARD} title="Plotter (Freeboard-SK)" /></Surface>
        {/* Native instruments (replaces the heavy embedded KIP app): reads SignalK
            deltas directly and is far lighter on the renderer. */}
        <Surface rect={L.instruments}><Instruments active={tab === 'instruments' || tab === 'all' || tab === 'split'} /></Surface>
        <Surface rect={L.stereo}><StereoView big={tab === 'stereo'} /></Surface>
        {/* Dedicated compact stereo section — used by the All view and Split panes. */}
        {(tab === 'all' || tab === 'split') && <Surface rect={L.stereoCompact}><StereoCompact /></Surface>}
        {/* Split view: a source selector bar at the bottom of each half. */}
        {tab === 'split' && ['left', 'right'].map((side) => (
          <Box key={side} sx={{
            position: 'absolute', bottom: 0, left: side === 'left' ? 0 : '50%', width: '50%', height: `${SEL_BAR}%`, minHeight: 46,
            display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 5,
            bgcolor: 'background.paper', borderTop: '1px solid rgba(255,255,255,0.12)',
            borderLeft: side === 'right' ? '1px solid rgba(255,255,255,0.12)' : 0,
          }}>
            <ToggleButtonGroup exclusive size="small" value={side === 'left' ? splitLeft : splitRight}
              onChange={(_, v) => v && setSide(side, v)}
              sx={{ '& .MuiToggleButton-root': { px: 3, py: 0.6, fontSize: '1.05rem', fontWeight: 700 } }}>
              {SPLIT_CHOICES.map((ch) => <ToggleButton key={ch.id} value={ch.id}>{ch.label}</ToggleButton>)}
            </ToggleButtonGroup>
          </Box>
        ))}
      </Box>

      {/* The right rail: softkey labels up top against the bezel buttons, knob cards at
          the bottom. Spans both rows so the labels' vertical percentages still line up
          with the physical keys, and so the cards sit beside the task bar, not over it. */}
      <Box sx={{ gridColumn: 2, gridRow: '1 / 3', position: 'relative', minWidth: 0 }}>
        <SoftkeyRail geom={geom} flash={flash} defaults={skDefaults} overrides={skOverrides} />
        <ControlCards />
      </Box>

      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)}

        settings={stereo ? stereo.settings : null} onChange={(patch) => stereoCtl.current && stereoCtl.current.setSettings(patch)}

        tab={settingsTab} onTabChange={setSettingsTab} bt={(stereo && stereo.bluetooth) || {}} c={stereoCtl.current} />


      {/* Page buttons — bottom bar, right-aligned; global MUTE centered. Styled as a card
          the same height as the VOLUME card beside it, so the bottom edge reads as one row
          of cards rather than a bar with something floating next to it. */}
      <Box sx={{ gridColumn: 1, gridRow: 2, minWidth: 0, height: CARD_H, ml: 1, mb: 1, mr: '5px',
        bgcolor: 'rgba(4,7,11,0.86)', border: '2px solid rgba(255,255,255,0.14)', borderRadius: 2.5,
        overflow: 'hidden' }}>
        <Stack direction="row" alignItems="center" sx={{ height: '100%' }}>
          {/* Global volume — wide, filling the left up to the MUTE button. */}
          <Stack direction="row" alignItems="center" spacing={1.5} sx={{ flex: 1, minWidth: 0, pl: 3, pr: 2 }}>
            {muted ? <VolumeOffIcon sx={{ color: 'error.main' }} /> : <VolumeUpIcon sx={{ opacity: 0.7 }} />}
            <VolumeSlider value={stereo ? stereo.volume : 0} muted={muted}
              onCommit={(v) => stereoCtl.current && stereoCtl.current.setVolume(v)} />
            <Typography sx={{ width: 30, textAlign: 'right', fontWeight: 700, fontSize: '1.1rem', fontVariantNumeric: 'tabular-nums' }}>
              {muted ? 'M' : <LiveVolumeNumber polled={stereo ? stereo.volume : 0} />}
            </Typography>
          </Stack>
          {/* MUTE button */}
          <Button
            onClick={toggleGlobalMute}
            variant={muted ? 'contained' : 'outlined'} color={muted ? 'error' : 'inherit'}
            startIcon={muted ? <VolumeOffIcon sx={{ fontSize: '2rem !important' }} /> : <VolumeUpIcon sx={{ fontSize: '2rem !important' }} />}
            sx={{ flexShrink: 0, minWidth: 160, py: 1, fontSize: '1.2rem', fontWeight: 800, borderWidth: 2,
              borderColor: muted ? 'error.main' : 'rgba(255,255,255,0.35)', '&:hover': { borderWidth: 2 } }}
          >
            {muted ? 'MUTED' : 'MUTE'}
          </Button>
          <Box sx={{ flex: 1 }} />
          {/* SK status — tucked just left of the Plotter tab. */}
          <Chip
            size="small"
            color={sk.connected ? (sk.deltas > 0 ? 'success' : 'info') : 'default'}
            variant={sk.connected ? 'filled' : 'outlined'}
            label={sk.connected ? (sk.deltas > 0 ? 'SK · live data' : 'SK · connected') : 'SK · offline'}
            sx={{ mr: 1.5, flexShrink: 0 }}
          />
          <Tabs
            value={tab} onChange={(_, v) => setTab(v)} variant="scrollable" scrollButtons={false}
            sx={{ minHeight: 0, height: '100%', '& .MuiTabs-flexContainer': { height: '100%' },
              '& .MuiTab-root': { minHeight: 0, height: '100%', px: 3, py: 0, fontSize: '1.3rem', fontWeight: 800 } }}
          >
            {TABS.map((t) => <Tab key={t.id} value={t.id} label={t.label} />)}
          </Tabs>
          {/* Settings lives at the far right of the task bar — it's global
              (stereo, system, …), not part of any one page. */}
          <IconButton onClick={() => setSettingsOpen(true)} title="Settings"
            sx={{ mx: 1.5, flexShrink: 0, border: '2px solid rgba(255,255,255,0.35)', borderRadius: 2, p: 1 }}>
            <SettingsIcon sx={{ fontSize: '2rem' }} />
          </IconButton>
        </Stack>
      </Box>
    </Box>
  )
}


// Provider wraps the shell so any view can register its four key labels.
export default function App() {
  return (
    <SoftkeyProvider>
      <AppShell />
    </SoftkeyProvider>
  )
}
