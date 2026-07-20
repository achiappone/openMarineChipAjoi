import { useState } from 'react'
import { Box, Tabs, Tab, Chip, Stack, Typography } from '@mui/material'
import EmbeddedApp from './components/EmbeddedApp'
import StereoView from './views/StereoView'
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
    // Gauge on top, FM stereo stacked below (the compact stereo panel fits the
    // bottom band on the 720px screen).
    case 'instr-stereo': return {
      instruments: { top: 0, left: 0, width: 100, height: 52 },
      stereo: { top: 52, left: 0, width: 100, height: 48 },
    }
    // Plotter on the left; instruments over stereo stacked on the right.
    case 'all': return {
      plotter: { top: 0, left: 0, width: 55, height: 100 },
      instruments: { top: 0, left: 55, width: 45, height: 52 },
      stereo: { top: 52, left: 55, width: 45, height: 48 },
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

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      {/* Tab / page buttons */}
      <Stack direction="row" alignItems="center" sx={{ bgcolor: 'background.paper', borderBottom: '1px solid rgba(255,255,255,0.12)' }}>
        <Tabs
          value={tab} onChange={(_, v) => setTab(v)} variant="scrollable" scrollButtons={false}
          sx={{ flex: 1, minHeight: 52, '& .MuiTab-root': { minHeight: 52, py: 0, fontSize: '1.02rem', fontWeight: 700 } }}
        >
          {TABS.map((t) => <Tab key={t.id} value={t.id} label={t.label} />)}
        </Tabs>
        <Chip
          size="small"
          color={sk.connected ? (sk.deltas > 0 ? 'success' : 'info') : 'default'}
          variant={sk.connected ? 'filled' : 'outlined'}
          label={sk.connected ? (sk.deltas > 0 ? 'SK · live data' : 'SK · connected') : 'SK · offline'}
          sx={{ mx: 2 }}
        />
      </Stack>

      {/* Surfaces — all mounted, positioned per tab */}
      <Box sx={{ position: 'relative', flex: 1 }}>
        <Surface rect={L.plotter}><EmbeddedApp src={FREEBOARD} title="Plotter (Freeboard-SK)" /></Surface>
        <Surface rect={L.instruments}><EmbeddedApp src={KIP} title="Instruments (KIP)" /></Surface>
        <Surface rect={L.stereo}><StereoView /></Surface>
      </Box>
    </Box>
  )
}
