import { useState, useEffect, useRef } from 'react'
import { Box, Tabs, Tab, Chip, Stack, Typography, Button } from '@mui/material'
import VolumeUpIcon from '@mui/icons-material/VolumeUp'
import VolumeOffIcon from '@mui/icons-material/VolumeOff'
import EmbeddedApp from './components/EmbeddedApp'
import StereoView from './views/StereoView'
import StereoCompact from './views/StereoCompact'
import { createRadioClient } from './stereo/stereoClient'
import useSignalKStatus from './hooks/useSignalKStatus'

// Root-absolute so it works both on the Pi (same origin :3000) and via the Vite
// dev proxy on the laptop.
const FREEBOARD = '/@signalk/freeboard-sk/'
const KIP = '/@mxtommy/kip/'

const TABS = [
  { id: 'plotter', label: 'Plotter' },
  { id: 'instruments', label: 'Instruments' },
  { id: 'stereo', label: 'Stereo' },
  { id: 'instr-stereo', label: 'Instr + Stereo' },
  { id: 'all', label: 'All' },
]

const FULL = { top: 0, left: 0, width: 100, height: 100 }

// For each tab, where each surface sits (in %). A surface absent from the map is
// hidden for that tab. Surfaces never unmount — only their rect/visibility changes —
// so Freeboard and KIP keep their state across tab switches.
function layoutFor(tabId) {
  switch (tabId) {
    case 'plotter': return { plotter: FULL }
    case 'instruments': return { instruments: FULL }
    case 'stereo': return { stereo: FULL }
    // Instruments on the left, stereo on the right (side-by-side).
    case 'instr-stereo': return {
      instruments: { top: 0, left: 0, width: 50, height: 100 },
      stereo: { top: 0, left: 50, width: 50, height: 100 },
    }
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

export default function App() {
  // Initial tab from the URL hash (e.g. #all), so a view is deep-linkable and the
  // boot kiosk can open straight into a chosen page.
  const [tab, setTabState] = useState(() => validTab(location.hash.replace('#', '')))
  const setTab = (id) => { setTabState(id); history.replaceState(null, '', `#${id}`) }
  const sk = useSignalKStatus()
  const L = layoutFor(tab)

  // Lightweight stereo client so MUTE lives in the global page bar (always
  // reachable, whatever tab is open). The Stereo views keep their own clients.
  const [stereo, setStereo] = useState(null)
  const stereoCtl = useRef(null)
  useEffect(() => {
    stereoCtl.current = createRadioClient(setStereo)
    return () => { stereoCtl.current && stereoCtl.current.stop && stereoCtl.current.stop() }
  }, [])
  const muted = !!(stereo && stereo.muted)

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Surfaces — all mounted, positioned per tab */}
      <Box sx={{ position: 'relative', flex: 1, minHeight: 0, overflow: 'hidden' }}>
        <Surface rect={L.plotter}><EmbeddedApp src={FREEBOARD} title="Plotter (Freeboard-SK)" /></Surface>
        <Surface rect={L.instruments}><EmbeddedApp src={KIP} title="Instruments (KIP)" /></Surface>
        <Surface rect={L.stereo}><StereoView big={tab === 'stereo'} /></Surface>
        {/* Dedicated compact stereo section, only mounted for the All view. */}
        {tab === 'all' && <Surface rect={L.stereoCompact}><StereoCompact /></Surface>}
      </Box>

      {/* Page buttons — bottom bar, right-aligned; global MUTE centered. */}
      <Box sx={{ position: 'relative', flexShrink: 0, bgcolor: 'background.paper', borderTop: '1px solid rgba(255,255,255,0.12)' }}>
        <Stack direction="row" alignItems="center">
          <Chip
            size="small"
            color={sk.connected ? (sk.deltas > 0 ? 'success' : 'info') : 'default'}
            variant={sk.connected ? 'filled' : 'outlined'}
            label={sk.connected ? (sk.deltas > 0 ? 'SK · live data' : 'SK · connected') : 'SK · offline'}
            sx={{ mx: 2 }}
          />
          <Box sx={{ flex: 1 }} />
          <Tabs
            value={tab} onChange={(_, v) => setTab(v)} variant="scrollable" scrollButtons={false}
            sx={{ minHeight: 68, '& .MuiTab-root': { minHeight: 68, px: 3.5, py: 0, fontSize: '1.35rem', fontWeight: 800 } }}
          >
            {TABS.map((t) => <Tab key={t.id} value={t.id} label={t.label} />)}
          </Tabs>
        </Stack>
        {/* Absolutely centered so it stays put regardless of the side widths. */}
        <Box sx={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', pointerEvents: 'none' }}>
          <Button
            onClick={() => stereoCtl.current && stereoCtl.current.toggleMute()}
            variant={muted ? 'contained' : 'outlined'} color={muted ? 'error' : 'inherit'}
            startIcon={muted ? <VolumeOffIcon /> : <VolumeUpIcon />}
            sx={{ pointerEvents: 'auto', minWidth: 160, py: 1, fontSize: '1.2rem', fontWeight: 800, borderWidth: 2,
              borderColor: muted ? 'error.main' : 'rgba(255,255,255,0.35)', '&:hover': { borderWidth: 2 } }}
          >
            {muted ? 'MUTED' : 'MUTE'}
          </Button>
        </Box>
      </Box>
    </Box>
  )
}
