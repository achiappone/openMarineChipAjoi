import { useEffect, useRef, useState, memo } from 'react'
import {
  Box, Stack, Typography, ToggleButton, ToggleButtonGroup, Slider, IconButton,
  Button, Chip, Paper, Dialog, AppBar, Toolbar, Switch, FormControlLabel, Divider, LinearProgress, TextField, Tabs, Tab, CircularProgress,
} from '@mui/material'
import CloseIcon from '@mui/icons-material/Close'
import PlayArrowIcon from '@mui/icons-material/PlayArrow'
import PauseIcon from '@mui/icons-material/Pause'
import SkipNextIcon from '@mui/icons-material/SkipNext'
import SkipPreviousIcon from '@mui/icons-material/SkipPrevious'
import ShuffleIcon from '@mui/icons-material/Shuffle'
import RepeatIcon from '@mui/icons-material/Repeat'
import RepeatOneIcon from '@mui/icons-material/RepeatOne'
import PowerSettingsNewIcon from '@mui/icons-material/PowerSettingsNew'
import VolumeUpIcon from '@mui/icons-material/VolumeUp'
import VolumeOffIcon from '@mui/icons-material/VolumeOff'
import FastRewindIcon from '@mui/icons-material/FastRewind'
import FastForwardIcon from '@mui/icons-material/FastForward'
import BookmarkAddIcon from '@mui/icons-material/BookmarkAdd'
import SaveIcon from '@mui/icons-material/Save'
import MusicNoteIcon from '@mui/icons-material/MusicNote'
import RadioIcon from '@mui/icons-material/Radio'
import CableIcon from '@mui/icons-material/Cable'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import ChevronRightIcon from '@mui/icons-material/ChevronRight'
import AddIcon from '@mui/icons-material/Add'
import RemoveIcon from '@mui/icons-material/Remove'
import BluetoothIcon from '@mui/icons-material/Bluetooth'
import BluetoothSearchingIcon from '@mui/icons-material/BluetoothSearching'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import WifiIcon from '@mui/icons-material/Wifi'
import SettingsEthernetIcon from '@mui/icons-material/SettingsEthernet'
import LockIcon from '@mui/icons-material/Lock'
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline'
import BatteryFullIcon from '@mui/icons-material/BatteryFull'
import Battery60Icon from '@mui/icons-material/Battery60'
import Battery20Icon from '@mui/icons-material/Battery20'
import BatteryAlertIcon from '@mui/icons-material/BatteryAlert'
import LibraryMusicIcon from '@mui/icons-material/LibraryMusic'
import FolderIcon from '@mui/icons-material/Folder'
import AlbumIcon from '@mui/icons-material/Album'
import PersonIcon from '@mui/icons-material/Person'
import PlaylistPlayIcon from '@mui/icons-material/PlaylistPlay'
import { SOURCES, FM_MIN, FM_MAX, VOL_MAX } from '../stereo/stereoControl'
import { createRadioClient } from '../stereo/stereoClient'

const SVC = `http://${location.hostname}:8082`

// ---- Visualizations: 10 canvas modes driven by the live audio spectrum ----
const VIS_MODES = ['Bars', 'Mirror', 'Orbit', 'Wave', 'Radial', 'LED Blocks', 'Area', 'Dots', 'Bloom']

function mixColor(t) { // blue #1f6feb -> green #3ddc84
  const a = [31, 111, 235], b = [61, 220, 132]
  return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(',')})`
}

// Colour by spectrum position (blue -> green) but shift toward hot orange/red as
// the bar's intensity (v, 0..1) rises, so louder bands read warmer.
function barColor(t, v) {
  const br = 31 + 30 * t, bg = 111 + 109 * t, bb = 235 - 103 * t // blue -> green by position
  const k = Math.max(0, Math.min(1, v)) ** 1.4 // emphasize the peaks
  return `rgb(${Math.round(br + (255 - br) * k)},${Math.round(bg + (90 - bg) * k)},${Math.round(bb + (60 - bb) * k)})`
}

function drawVis(mode, ctx, W, H, spec, peaks, t, rot = 0) {
  const n = spec.length || 32
  let avg = 0; for (let i = 0; i < n; i++) avg += spec[i] || 0; avg /= n || 1
  const bw = W / n
  // Noise-gate + expand: silence maps to 0 (bars truly hit the floor), and the
  // usable band above the noise floor is stretched to 0..1 for a punchy response.
  const P = (v) => { v = ((v || 0) - 0.15) * 1.9; return v <= 0 ? 0 : v > 1 ? 1 : v }
  const sx = W / Math.min(W, H) // horizontal stretch so round modes fill the wide panel
  switch (mode) {
    // Bars: gain-gated bars with a fast peak-hold cap (merged old Bars + Peak Bars).
    case 0: for (let i = 0; i < n; i++) { const bh = P(spec[i]) * H; ctx.fillStyle = barColor(i / n, spec[i] || 0); if (bh > 0) ctx.fillRect(i * bw + bw * 0.15, H - bh, bw * 0.7, bh); const pk = P(peaks[i]); if (pk > 0) { ctx.fillStyle = '#fff'; ctx.fillRect(i * bw + bw * 0.15, H - pk * H - 1, bw * 0.7, 3) } } break
    // Mirror: extreme mirrored bars + a bass-driven glow layer + peak-hold marks.
    case 1: { let bass = 0; for (let i = 0; i < 6; i++) bass += spec[i] || 0; bass = P(bass / 6); if (bass > 0) { const gr = ctx.createRadialGradient(W / 2, H / 2, 0, W / 2, H / 2, Math.max(W, H) / 2); gr.addColorStop(0, `rgba(255,90,60,${0.06 + bass * 0.32})`); gr.addColorStop(1, 'rgba(255,90,60,0)'); ctx.fillStyle = gr; ctx.fillRect(0, 0, W, H) } for (let i = 0; i < n; i++) { const bh = P(spec[i]) * H * 0.5; ctx.fillStyle = barColor(i / n, spec[i] || 0); if (bh > 0) ctx.fillRect(i * bw + bw * 0.15, H / 2 - bh, bw * 0.7, bh * 2); const pk = P(peaks[i]) * H * 0.5; if (pk > 0) { ctx.globalAlpha = 0.6; ctx.fillStyle = '#fff'; ctx.fillRect(i * bw + bw * 0.15, H / 2 - pk - 1, bw * 0.7, 2); ctx.fillRect(i * bw + bw * 0.15, H / 2 + pk - 1, bw * 0.7, 2); ctx.globalAlpha = 1 } } break }
    // Orbit: dots orbiting the centre; radius by band, size/brightness by intensity, spin tracks the music.
    case 2: { const cx = W / 2, cy = H / 2, mr = Math.min(W, H) / 2; for (let i = 0; i < n; i++) { const v = P(spec[i]); const ang = (i / n) * 6.2832 + rot * (0.5 + i / n); const rad = mr * (0.22 + (i / n) * 0.72) * (0.55 + v * 0.7); const x = cx + Math.cos(ang) * rad * sx, y = cy + Math.sin(ang) * rad; ctx.fillStyle = barColor(i / n, spec[i] || 0); ctx.globalAlpha = 0.3 + v * 0.7; ctx.beginPath(); ctx.arc(x, y, 2 + v * 9, 0, 6.2832); ctx.fill() } ctx.globalAlpha = 1; break }
    // Wave: per-segment coloured oscilloscope line.
    case 3: { ctx.lineWidth = 4; ctx.lineJoin = 'round'; for (let i = 1; i < n; i++) { const y0 = H - P(spec[i - 1]) * H, y1 = H - P(spec[i]) * H; ctx.strokeStyle = barColor(i / n, Math.max(spec[i - 1] || 0, spec[i] || 0)); ctx.beginPath(); ctx.moveTo((i - 1) / (n - 1) * W, y0); ctx.lineTo(i / (n - 1) * W, y1); ctx.stroke() } break }
    // Radial: elliptical rays reaching the panel edges, spinning with the music.
    case 4: { const cx = W / 2, cy = H / 2, r0 = Math.min(W, H) * 0.08, mlx = W * 0.66, mly = H * 0.62; ctx.lineWidth = 4; for (let i = 0; i < n; i++) { const a = (i / n) * 6.2832 - 1.5708 + rot, v = P(spec[i]); ctx.strokeStyle = barColor(i / n, spec[i] || 0); ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); ctx.lineTo(cx + Math.cos(a) * (r0 + v * mlx), cy + Math.sin(a) * (r0 + v * mly)); ctx.stroke() } break }
    case 5: { const seg = 10, gap = 2, sh = (H - seg * gap) / seg; for (let i = 0; i < n; i++) { const lit = Math.round(P(spec[i]) * seg); for (let s = 0; s < lit; s++) { ctx.fillStyle = barColor(i / n, (s + 1) / seg); ctx.fillRect(i * bw + bw * 0.15, H - (s + 1) * (sh + gap), bw * 0.7, sh) } } break }
    case 6: { ctx.beginPath(); ctx.moveTo(0, H); for (let i = 0; i < n; i++) ctx.lineTo((i / (n - 1)) * W, H - P(spec[i]) * H); ctx.lineTo(W, H); ctx.closePath(); const g = ctx.createLinearGradient(0, H, 0, 0); g.addColorStop(0, 'rgba(31,111,235,0.30)'); g.addColorStop(1, barColor(0.55, Math.min(1, avg * 3))); ctx.fillStyle = g; ctx.fill(); break }
    // Dots: position AND size track intensity live.
    case 7: for (let i = 0; i < n; i++) { const v = P(spec[i]); if (v <= 0) continue; ctx.fillStyle = barColor(i / n, spec[i] || 0); ctx.beginPath(); ctx.arc(i * bw + bw / 2, H - v * H, 2.5 + v * 7, 0, 6.2832); ctx.fill() } break
    // Bloom: layered spiky radial blobs that pulse and rotate with the music.
    case 8: { const cx = W / 2, cy = H / 2, r0 = Math.min(W, H) * 0.13, amp = Math.min(W, H) * 0.4; let bass = 0; for (let i = 0; i < 6; i++) bass += spec[i] || 0; bass = P(bass / 6);
      // Layer 1: outer blob (filled + stroked)
      ctx.beginPath(); for (let i = 0; i <= n; i++) { const idx = i % n, v = P(spec[idx]); const a = (i / n) * 6.2832 + rot; const rr = r0 + v * amp; const x = cx + Math.cos(a) * rr * sx, y = cy + Math.sin(a) * rr; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y) } ctx.closePath(); const g = ctx.createRadialGradient(cx, cy, r0, cx, cy, r0 + amp); g.addColorStop(0, barColor(0.25, 0.12)); g.addColorStop(1, barColor(0.75, Math.min(1, bass + 0.35))); ctx.fillStyle = g; ctx.globalAlpha = 0.85; ctx.fill(); ctx.globalAlpha = 1; ctx.lineWidth = 2.5; ctx.strokeStyle = barColor(0.85, Math.min(1, bass + 0.2)); ctx.stroke();
      // Layer 2: inner counter-rotating blob (offset bands) for depth
      ctx.beginPath(); for (let i = 0; i <= n; i++) { const idx = (i + (n >> 1)) % n, v = P(spec[idx]); const a = (i / n) * 6.2832 - rot * 1.4; const rr = r0 * 0.65 + v * amp * 0.5; const x = cx + Math.cos(a) * rr * sx, y = cy + Math.sin(a) * rr; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y) } ctx.closePath(); ctx.globalAlpha = 0.55; ctx.fillStyle = barColor(0.4, Math.min(1, bass + 0.45)); ctx.fill(); ctx.globalAlpha = 1;
      // Layer 3: white sparkle dots riding the outer peaks
      for (let i = 0; i < n; i += 2) { const v = P(spec[i]); if (v < 0.25) continue; const a = (i / n) * 6.2832 + rot; const rr = r0 + v * amp; ctx.globalAlpha = v; ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(cx + Math.cos(a) * rr * sx, cy + Math.sin(a) * rr, 1 + v * 3, 0, 6.2832); ctx.fill() } ctx.globalAlpha = 1;
      break }
    default: break
  }
}

// Global "suspend the visualizers" signal — full-screen dialogs (Settings, Browse)
// fully occlude the canvas, so it's pure waste to keep painting behind them.
let visSuspend = 0
const visSubs = new Set()
export function suspendVisualizers(on) {
  visSuspend = Math.max(0, visSuspend + (on ? 1 : -1))
  visSubs.forEach((fn) => fn(visSuspend > 0))
}

// Live audio-spectrum canvas. Tap to cycle through 10 visualizations (persisted).
// `height` overrides the default (e.g. '100%' to fill a flex container).
export function Visualizer({ big, height }) {
  const wrapRef = useRef(null), canvasRef = useRef(null)
  const specRef = useRef(new Array(32).fill(0))
  const peaksRef = useRef(new Array(32).fill(0))
  const rotRef = useRef(0) // accumulated rotation for the radial mode (speed tracks the music)
  const [mode, setMode] = useState(() => (Number(localStorage.getItem('helm.vis') || 0) || 0) % VIS_MODES.length)
  const [flash, setFlash] = useState('')
  // Canvas animation is the helm's biggest CPU cost, so only run it when this
  // visualizer is actually on screen. IntersectionObserver drives `visible`.
  const [visible, setVisible] = useState(true)
  const [suspended, setSuspended] = useState(visSuspend > 0)
  const visibleRef = useRef(true)
  // Active only when on-screen AND not hidden behind a full-screen dialog.
  visibleRef.current = visible && !suspended

  useEffect(() => {
    const el = wrapRef.current
    if (!el || typeof IntersectionObserver === 'undefined') return
    let onScreen = true
    const apply = () => setVisible(onScreen && !document.hidden)
    const io = new IntersectionObserver((ents) => { onScreen = ents[0].isIntersecting; apply() }, { threshold: 0.01 })
    io.observe(el)
    document.addEventListener('visibilitychange', apply)
    visSubs.add(setSuspended); setSuspended(visSuspend > 0)
    return () => { io.disconnect(); document.removeEventListener('visibilitychange', apply); visSubs.delete(setSuspended) }
  }, [])

  // Only hold the spectrum SSE open while visible — a hidden strip shouldn't keep
  // parsing the feed. Reconnects instantly when it comes back on screen.
  useEffect(() => {
    if (!visible) return
    let es
    try { es = new EventSource(`${SVC}/api/spectrum`); es.onmessage = (e) => { try { specRef.current = JSON.parse(e.data) } catch (x) {} } } catch (x) {}
    return () => es && es.close()
  }, [visible])

  useEffect(() => {
    let raf, t = 0, last = 0
    // Aggressive caps to keep the renderer light: the small strip is peripheral so
    // 15fps is plenty; the big panel gets 24fps. Both are smooth enough for a
    // spectrum and roughly a third of the cost of an uncapped 60fps loop.
    const FRAME_MS = 1000 / (big ? 24 : 15)
    // Cap the backing resolution hard: bars/blobs don't need full 1920px pixels, so
    // render into a small buffer (CSS scales it up). This is the biggest CPU saver.
    const MAX_W = big ? 720 : 420
    const loop = (now) => {
      raf = requestAnimationFrame(loop)
      if (!visibleRef.current) return          // off-screen or behind a dialog: skip the paint entirely
      if (now - last < FRAME_MS) return         // frame-rate cap
      last = now
      const cv = canvasRef.current, wrap = wrapRef.current
      if (cv && wrap && wrap.clientWidth) {
        const scale = Math.min(1, MAX_W / wrap.clientWidth) // downscale the backing buffer
        const W = wrap.clientWidth, H = wrap.clientHeight
        const bw = Math.round(W * scale), bh = Math.round(H * scale)
        if (cv.width !== bw) cv.width = bw
        if (cv.height !== bh) cv.height = bh
        const ctx = cv.getContext('2d')
        // drawVis works in CSS pixels; map them onto the smaller backing buffer.
        ctx.setTransform(scale, 0, 0, scale, 0, 0)
        ctx.clearRect(0, 0, W, H)
        const spec = specRef.current, peaks = peaksRef.current
        let e = 0
        for (let i = 0; i < spec.length; i++) { peaks[i] = Math.max(spec[i] || 0, (peaks[i] || 0) - 0.03); e += spec[i] || 0 }
        e /= spec.length || 1
        const ge = e > 0.15 ? e - 0.15 : 0 // energy above the noise floor
        rotRef.current += 0.0015 + ge * 0.06 // gentle spin; speeds up with the music, barely drifts in silence
        drawVis(mode, ctx, W, H, spec, peaks, t, rotRef.current)
        t++
      }
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [mode])

  const cycle = () => {
    const m = (mode + 1) % VIS_MODES.length
    setMode(m); localStorage.setItem('helm.vis', String(m))
    setFlash(VIS_MODES[m]); setTimeout(() => setFlash(''), 1200)
  }

  return (
    <Box ref={wrapRef} onClick={cycle} sx={{ position: 'relative', width: '100%', height: height || (big ? 118 : 44), cursor: 'pointer' }}>
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
      {(big || flash) && (
        <Typography sx={{ position: 'absolute', top: 4, right: 10, fontSize: big ? '0.8rem' : '0.72rem', fontWeight: 700,
          opacity: flash ? 0.95 : 0.35, transition: 'opacity .3s', pointerEvents: 'none', textShadow: '0 1px 3px rgba(0,0,0,0.85)' }}>
          {flash || (big ? `${VIS_MODES[mode]} · tap to change` : '')}
        </Typography>
      )}
    </Box>
  )
}

// Card-style preset: tap to tune, long-press (650ms) to remove.
function PresetCard({ preset, active, onSelect, onDelete, big }) {
  const t = useRef(null), held = useRef(false)
  const start = () => { held.current = false; t.current = setTimeout(() => { held.current = true; onDelete() }, 650) }
  const end = () => { if (t.current) { clearTimeout(t.current); t.current = null; if (!held.current) onSelect() } }
  const cancel = () => { if (t.current) { clearTimeout(t.current); t.current = null } }
  return (
    <Paper elevation={0}
      onMouseDown={start} onMouseUp={end} onMouseLeave={cancel}
      onTouchStart={start} onTouchEnd={(e) => { e.preventDefault(); end() }}
      sx={{
        border: '2px solid', borderColor: active ? 'primary.main' : 'rgba(255,255,255,0.20)',
        bgcolor: active ? 'primary.main' : 'transparent', color: active ? '#001322' : 'text.primary',
        borderRadius: 2, cursor: 'pointer', userSelect: 'none', textAlign: 'center', transition: '0.15s',
        px: big ? 3 : 1.25, py: big ? 2 : 0.6, minWidth: big ? 185 : 66, maxWidth: big ? 250 : 'none',
        '&:hover': { borderColor: 'primary.main' },
      }}>
      <Typography sx={{ fontWeight: 800, lineHeight: 1, fontSize: big ? '2.4rem' : '0.95rem' }}>{preset.freq.toFixed(1)}</Typography>
      {big && (preset.name || preset.pty) && (
        <Typography noWrap sx={{ fontSize: '0.95rem', fontWeight: 600, opacity: active ? 0.85 : 0.7, mt: 0.5, maxWidth: 210 }}>
          {preset.name || preset.pty}
        </Typography>
      )}
    </Paper>
  )
}

// Card-style navigation (seek) button.
function NavCard({ onClick, big, children }) {
  return (
    <Paper elevation={0} onClick={onClick}
      sx={{ border: '2px solid rgba(255,255,255,0.20)', borderRadius: 2, cursor: 'pointer',
        display: 'flex', alignItems: 'center', justifyContent: 'center', transition: '0.15s',
        width: big ? 92 : 46, height: big ? 92 : 46, '&:hover': { borderColor: 'primary.main' } }}>
      {children}
    </Paper>
  )
}


// ---- System tab: live Pi health, polled only while the tab is open ----
const fmtBytes = (n) => {
  if (!n) return '0 B'
  const u = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(u.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
  return `${(n / Math.pow(1024, i)).toFixed(i ? 1 : 0)} ${u[i]}`
}
const fmtUptime = (s) => {
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60)
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`
}
// Green until it matters, amber when worth noticing, red when it's a real problem.
const gauge = (pct) => (pct >= 90 ? 'error' : pct >= 75 ? 'warning' : 'primary')

function StatBar({ label, value, detail, color }) {
  return (
    <Box sx={{ mb: 1.5 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="baseline">
        <Typography sx={{ fontWeight: 700 }}>{label}</Typography>
        <Typography sx={{ fontVariantNumeric: 'tabular-nums', opacity: 0.85 }}>{detail}</Typography>
      </Stack>
      <LinearProgress variant="determinate" value={Math.max(0, Math.min(100, value))}
        color={color || gauge(value)} sx={{ height: 10, borderRadius: 5, mt: 0.5 }} />
    </Box>
  )
}

// Engine settings — stores engine hours (off the dashboard) and room for more.
function EnginePanel() {
  const [hrs, setHrs] = useState(() => { const v = Number(localStorage.getItem('helm.engineHours')); return isFinite(v) && v > 0 ? v : null })
  useEffect(() => { const t = setInterval(() => { const v = Number(localStorage.getItem('helm.engineHours')); if (isFinite(v) && v > 0) setHrs(v) }, 2000); return () => clearInterval(t) }, [])
  return (
    <Stack spacing={2}>
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Typography sx={{ opacity: 0.6, fontSize: '0.85rem', letterSpacing: 1, fontWeight: 700 }}>ENGINE HOURS</Typography>
        <Typography sx={{ fontWeight: 800, fontSize: '2.4rem' }}>{hrs == null ? '—' : hrs.toFixed(1)}<Typography component="span" sx={{ opacity: 0.6, fontSize: '1.1rem', ml: 1 }}>h</Typography></Typography>
        <Typography sx={{ opacity: 0.5, fontSize: '0.85rem' }}>Reported by the engine over NMEA 2000 (propulsion.*.runTime).</Typography>
      </Paper>
      <Typography sx={{ opacity: 0.5, fontSize: '0.9rem' }}>More engine settings can live here later (service reminders, redline, fuel-tank size, calibration).</Typography>
    </Stack>
  )
}

// Trip: distance/duration/max speed since last reset, and the reset control.
function TripPanel({ active }) {
  const read = () => { try { return JSON.parse(localStorage.getItem('helm.trip')) || {} } catch (e) { return {} } }
  const [trip, setTrip] = useState(read)
  useEffect(() => { if (!active) return undefined; const t = setInterval(() => setTrip(read()), 1000); return () => clearInterval(t) }, [active])
  const dur = trip.start ? Math.max(0, Date.now() - trip.start) : 0
  const h = Math.floor(dur / 3600000), m = Math.floor((dur % 3600000) / 60000)
  const avg = trip.distance && dur > 0 ? (trip.distance / (dur / 3600000)) : null
  const reset = () => { try { localStorage.removeItem('helm.trip') } catch (e) {} window.dispatchEvent(new Event('helm.trip.reset')); setTrip({}) }
  const Row = ({ k, v }) => (
    <Stack direction="row" justifyContent="space-between" sx={{ py: 1, borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
      <Typography sx={{ opacity: 0.7 }}>{k}</Typography><Typography sx={{ fontWeight: 800 }}>{v}</Typography>
    </Stack>
  )
  return (
    <Stack spacing={2}>
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Row k="Distance" v={`${(trip.distance || 0).toFixed(2)} nm`} />
        <Row k="Duration" v={`${h}h ${m}m`} />
        <Row k="Max speed" v={`${(trip.maxSog || 0).toFixed(1)} kn`} />
        <Row k="Avg speed" v={avg == null ? '—' : `${avg.toFixed(1)} kn`} />
      </Paper>
      <Button variant="contained" color="error" size="large" onClick={reset} sx={{ py: 1.5 }}>Reset Trip</Button>
    </Stack>
  )
}

function SystemPanel({ active }) {
  const [sys, setSys] = useState(null)
  const [err, setErr] = useState(false)
  useEffect(() => {
    if (!active) return
    let alive = true
    const poll = () => fetch(`${SVC}/api/system`).then((r) => r.json())
      .then((d) => { if (alive) { setSys(d); setErr(false) } })
      .catch(() => { if (alive) setErr(true) })
    poll()
    const t = setInterval(poll, 2000)
    return () => { alive = false; clearInterval(t) }
  }, [active])

  if (err && !sys) return <Typography sx={{ opacity: 0.6 }}>Can't reach the stereo service.</Typography>
  if (!sys) return <Typography sx={{ opacity: 0.6 }}>Reading system health…</Typography>

  const memUsed = sys.mem.total - sys.mem.available
  const memPct = sys.mem.total ? (memUsed / sys.mem.total) * 100 : 0
  const diskPct = sys.disk.total ? (sys.disk.used / sys.disk.total) * 100 : 0
  // The Pi throttles hard around 80-85C; 70 is worth watching on a hot day.
  const tempPct = Math.min(100, (sys.temp / 85) * 100)
  const th = sys.throttle || { ok: true, now: {}, since: {} }
  const warn = []
  if (th.now.underVoltage) warn.push('Under-voltage NOW — check the supply')
  else if (th.since.underVoltage) warn.push('Under-voltage has occurred since boot')
  if (th.now.throttled) warn.push('CPU throttling NOW — too hot')
  else if (th.since.throttled) warn.push('CPU has throttled since boot')
  if (th.now.freqCapped || th.since.freqCapped) warn.push('Clock has been capped')

  return (
    <Stack spacing={1}>
      <Stack direction="row" spacing={1} sx={{ mb: 0.5 }}>
        <Chip size="small" label={sys.host} />
        <Chip size="small" label={`up ${fmtUptime(sys.uptime)}`} />
        <Chip size="small" label={`load ${sys.load.map((n) => n.toFixed(2)).join(' ')}`} />
      </Stack>

      {warn.length > 0 && (
        <Paper variant="outlined" sx={{ p: 1.5, borderColor: 'warning.main', bgcolor: 'rgba(255,167,38,0.08)' }}>
          {warn.map((w) => (
            <Stack key={w} direction="row" spacing={1} alignItems="center">
              <ErrorOutlineIcon color="warning" fontSize="small" />
              <Typography sx={{ fontSize: '0.9rem' }}>{w}</Typography>
            </Stack>
          ))}
        </Paper>
      )}

      <StatBar label="CPU" value={sys.cpu.total} detail={`${sys.cpu.total}%  ·  ${sys.cores} cores`} />
      {sys.cpu.cores && sys.cpu.cores.length > 0 && (
        <Stack direction="row" spacing={1} sx={{ mb: 1.5, mt: -0.5 }}>
          {sys.cpu.cores.map((c, i) => (
            <Box key={i} sx={{ flex: 1 }}>
              <LinearProgress variant="determinate" value={c} color={gauge(c)} sx={{ height: 6, borderRadius: 3 }} />
              <Typography sx={{ fontSize: '0.7rem', opacity: 0.55, textAlign: 'center' }}>{c}%</Typography>
            </Box>
          ))}
        </Stack>
      )}
      <StatBar label="Temperature" value={tempPct} color={sys.temp >= 80 ? 'error' : sys.temp >= 70 ? 'warning' : 'primary'}
        detail={`${sys.temp.toFixed(1)} °C`} />
      <StatBar label="Memory" value={memPct}
        detail={`${fmtBytes(memUsed)} of ${fmtBytes(sys.mem.total)}  ·  ${fmtBytes(sys.mem.available)} free`} />
      <StatBar label="Storage" value={diskPct}
        detail={`${fmtBytes(sys.disk.used)} of ${fmtBytes(sys.disk.total)}  ·  ${fmtBytes(sys.disk.free)} free`} />

      <Typography sx={{ opacity: 0.6, fontSize: '0.8rem', letterSpacing: 1, mt: 1 }}>TOP PROCESSES</Typography>
      {sys.top.map((p, i) => (
        <Stack key={i} direction="row" spacing={1} justifyContent="space-between">
          <Typography noWrap sx={{ fontSize: '0.9rem', flex: 1, minWidth: 0 }}>{p.name}</Typography>
          <Typography sx={{ fontSize: '0.9rem', fontVariantNumeric: 'tabular-nums', opacity: 0.8 }}>
            {p.cpu.toFixed(0)}% cpu · {p.mem.toFixed(1)}% mem
          </Typography>
        </Stack>
      ))}
    </Stack>
  )
}

// ---- Sensors: live I2C scan + GPS status, °C/°F, humidity, and a temp history graph ----
const cToF = (c) => (c * 9) / 5 + 32
function TempHistoryGraph({ hist }) {
  const W = 600, H = 120, pad = 6
  const series = [{ key: 'htu', label: 'HTU', color: '#39c6d8' }, { key: 'mcp', label: 'MCP', color: '#39d98a' }, { key: 'cpu', label: 'CPU', color: '#ffb52e' }]
  const all = hist.flatMap((p) => series.map((s) => p[s.key]).filter((v) => v != null))
  if (all.length < 2) return <Typography sx={{ opacity: 0.5, fontSize: '0.8rem' }}>Collecting history…</Typography>
  const lo = Math.min(...all) - 2, hi = Math.max(...all) + 2, rng = (hi - lo) || 1
  const x = (i) => pad + (i / Math.max(1, hist.length - 1)) * (W - 2 * pad)
  const y = (v) => H - pad - ((v - lo) / rng) * (H - 2 * pad)
  return (
    <Box>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', height: 120, display: 'block' }}>
        {series.map((s) => {
          const pts = hist.map((p, i) => (p[s.key] != null ? `${x(i).toFixed(1)},${y(p[s.key]).toFixed(1)}` : null)).filter(Boolean).join(' ')
          return pts ? <polyline key={s.key} points={pts} fill="none" stroke={s.color} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" /> : null
        })}
      </svg>
      <Stack direction="row" spacing={2} sx={{ mt: 0.75 }}>
        {series.map((s) => (
          <Stack key={s.key} direction="row" spacing={0.5} alignItems="center">
            <Box sx={{ width: 14, height: 3, bgcolor: s.color, borderRadius: 1 }} /><Typography sx={{ fontSize: '0.75rem', opacity: 0.7 }}>{s.label}</Typography>
          </Stack>
        ))}
        <Box sx={{ flex: 1 }} />
        <Typography sx={{ fontSize: '0.72rem', opacity: 0.5 }}>{lo.toFixed(0)}–{hi.toFixed(0)}°C · last {hist.length}</Typography>
      </Stack>
    </Box>
  )
}
function SensorsPanel({ active }) {
  const [data, setData] = useState(null)
  const [gps, setGps] = useState(null)
  const [gpsd, setGpsd] = useState(null)
  const [err, setErr] = useState(false)
  const histRef = useRef([])
  const [, force] = useState(0)
  const load = async () => {
    try {
      const [i2c, sys, nav, raw] = await Promise.all([
        fetch(`${SVC}/api/i2c`).then((r) => r.json()),
        fetch(`${SVC}/api/system`).then((r) => r.json()).catch(() => null),
        fetch('/signalk/v1/api/vessels/self/navigation').then((r) => (r.ok ? r.json() : null)).catch(() => null),
        fetch(`${SVC}/api/gps`).then((r) => r.json()).catch(() => null),
      ])
      setData(i2c); setGps(nav); setGpsd(raw); setErr(false)
      const byName = Object.fromEntries((i2c.devices || []).map((d) => [d.name, d]))
      histRef.current = [...histRef.current, { htu: byName.HTU31D?.tempC ?? null, mcp: byName.MCP9808?.tempC ?? null, cpu: sys?.temp ?? null }].slice(-90)
      force((n) => n + 1)
    } catch (e) { setErr(true) }
  }
  useEffect(() => {
    if (!active) return
    load(); const t = setInterval(load, 3000)
    return () => clearInterval(t)
  }, [active])
  if (err && !data) return <Typography sx={{ opacity: 0.6 }}>Can't reach the stereo service.</Typography>
  if (!data) return <Typography sx={{ opacity: 0.6 }}>Scanning I²C bus…</Typography>
  const devices = data.devices || []
  const pos = gps?.position?.value
  const fix = !!(pos && typeof pos.latitude === 'number')
  const satsIV = gps?.gnss?.satellitesInView?.value?.count ?? gps?.gnss?.satellitesInView?.count ?? null
  const satsUsed = gps?.gnss?.satellites?.value ?? null
  const tempStr = (d) => (d.tempC != null ? `${d.tempC.toFixed(1)}°C · ${cToF(d.tempC).toFixed(0)}°F${d.humidity != null ? `  ·  ${Math.round(d.humidity)}% RH` : ''}` : d.value)
  return (
    <Stack spacing={1.5}>
      <Typography sx={{ opacity: 0.6, fontSize: '0.85rem' }}>Live sensors — I²C bus + GPS.</Typography>
      <Paper variant="outlined" sx={{ p: 1.75, display: 'flex', alignItems: 'center', gap: 2 }}>
        <Chip label="UART" size="small" sx={{ fontFamily: 'monospace', fontWeight: 700 }} />
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography sx={{ fontWeight: 700 }}>ATGM336H GPS</Typography>
          <Typography sx={{ fontSize: '0.85rem', opacity: 0.7 }}>position · /dev/serial0 @ 9600{satsIV != null ? `  ·  ${satsIV} sats in view${satsUsed != null ? `, ${satsUsed} used` : ''}` : ''}</Typography>
        </Box>
        {fix ? <Typography sx={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700, fontSize: '0.9rem' }}>{Math.abs(pos.latitude).toFixed(4)}°{pos.latitude >= 0 ? 'N' : 'S'} {Math.abs(pos.longitude).toFixed(4)}°{pos.longitude >= 0 ? 'E' : 'W'}</Typography> : null}
        <Chip size="small" label={fix ? 'fix' : gps ? 'acquiring' : 'no data'} color={fix ? 'success' : gps ? 'warning' : 'default'} variant={fix ? 'filled' : 'outlined'} />
      </Paper>
      {gpsd && (
        <Paper variant="outlined" sx={{ p: 1.75 }}>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
            <Typography sx={{ opacity: 0.6, fontSize: '0.8rem', letterSpacing: 1, fontWeight: 700 }}>GPS ACQUISITION</Typography>
            <Box sx={{ flex: 1 }} />
            <Chip size="small" label={gpsd.fix >= 1 ? 'FIX' : gpsd.alive ? 'searching' : 'no data'} color={gpsd.fix >= 1 ? 'success' : gpsd.alive ? 'warning' : 'default'} variant={gpsd.fix >= 1 ? 'filled' : 'outlined'} />
          </Stack>
          <Stack direction="row" spacing={3} sx={{ mb: 1.5, flexWrap: 'wrap', rowGap: 1 }}>
            {[['In view', gpsd.satsInView], ['Used', gpsd.satsUsed], ['HDOP', gpsd.hdop ?? '—'], ['Antenna', gpsd.antenna || '—']].map(([l, v]) => (
              <Box key={l}><Typography sx={{ fontSize: '0.6rem', opacity: 0.5, letterSpacing: 1, fontWeight: 700 }}>{l}</Typography><Typography sx={{ fontWeight: 800, fontSize: '1.1rem' }}>{v}</Typography></Box>
            ))}
          </Stack>
          {gpsd.sats && gpsd.sats.filter((s) => s.snr).length > 0 ? (
            <Box sx={{ display: 'flex', alignItems: 'flex-end', gap: 0.5, height: 64, mb: 1 }}>
              {gpsd.sats.filter((s) => s.snr).sort((a, b) => b.snr - a.snr).map((s, i) => (
                <Box key={i} sx={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', height: '100%' }}>
                  <Box sx={{ width: '80%', height: `${Math.min(100, (s.snr / 50) * 100)}%`, minHeight: 2, bgcolor: s.snr >= 30 ? '#39d98a' : s.snr >= 20 ? '#ffb52e' : '#ff3b30', borderRadius: 0.5 }} />
                  <Typography sx={{ fontSize: '0.55rem', opacity: 0.6, mt: 0.25 }}>{s.id}</Typography>
                </Box>
              ))}
            </Box>
          ) : (
            <Typography sx={{ opacity: 0.55, fontSize: '0.85rem', mb: 1 }}>No satellite signal yet — the module is healthy (raw NMEA streaming below), but the antenna isn't receiving. It needs a clear view of the sky, away from the Pi/screen/SDR.</Typography>
          )}
          <Box sx={{ bgcolor: 'rgba(0,0,0,0.45)', borderRadius: 1, p: 1, fontFamily: 'monospace', fontSize: '0.72rem', lineHeight: 1.5, maxHeight: 150, overflowY: 'auto', color: 'rgba(150,220,150,0.9)' }}>
            {(gpsd.raw || []).map((l, i) => <Box key={i} sx={{ whiteSpace: 'nowrap' }}>{l}</Box>)}
            {(!gpsd.raw || gpsd.raw.length === 0) && <Box sx={{ opacity: 0.5 }}>waiting for NMEA…</Box>}
          </Box>
        </Paper>
      )}
      {devices.map((d) => (
        <Paper key={d.addr} variant="outlined" sx={{ p: 1.75, display: 'flex', alignItems: 'center', gap: 2 }}>
          <Chip label={d.addr} size="small" sx={{ fontFamily: 'monospace', fontWeight: 700 }} />
          <Box sx={{ flex: 1, minWidth: 0 }}>
            <Typography sx={{ fontWeight: 700 }}>{d.name}{d.extra ? <Box component="span" sx={{ opacity: 0.5, fontWeight: 400, ml: 1, fontSize: '0.85rem' }}>{d.extra}</Box> : null}</Typography>
            <Typography sx={{ fontSize: '0.85rem', opacity: 0.7 }}>{d.role || '—'}</Typography>
          </Box>
          {(d.tempC != null || d.value) ? <Typography sx={{ fontVariantNumeric: 'tabular-nums', fontWeight: 700, opacity: 0.9, fontSize: '0.9rem' }}>{tempStr(d)}</Typography> : null}
          <Chip size="small" label={d.running ? 'running' : d.name === 'unknown' ? 'detected' : 'idle'}
            color={d.running ? 'success' : d.name === 'unknown' ? 'default' : 'warning'} variant={d.running ? 'filled' : 'outlined'} />
        </Paper>
      ))}
      <Paper variant="outlined" sx={{ p: 1.75 }}>
        <Typography sx={{ opacity: 0.6, fontSize: '0.8rem', letterSpacing: 1, fontWeight: 700, mb: 1 }}>TEMPERATURE HISTORY</Typography>
        <TempHistoryGraph hist={histRef.current} />
      </Paper>
      <Typography sx={{ opacity: 0.45, fontSize: '0.78rem' }}>"running" = actively read. "idle" = on the bus, not wired to a reader yet.</Typography>
    </Stack>
  )
}

// ---- Network settings: DHCP/static IP per interface + Wi-Fi scan/connect ----
// Talks to the stereo-service /api/network* endpoints, which drive NetworkManager.
function IfaceCard({ iface, onApply }) {
  const cur = iface.addresses && iface.addresses[0] ? iface.addresses[0] : ''
  const [method, setMethod] = useState(iface.method === 'manual' ? 'manual' : 'auto')
  const [ip, setIp] = useState(cur ? cur.split('/')[0] : '')
  const [prefix, setPrefix] = useState(cur && cur.includes('/') ? cur.split('/')[1] : '24')
  const [gw, setGw] = useState(iface.gateway || '')
  const [dns, setDns] = useState((iface.dns || []).join(' '))
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const connected = iface.state === 'connected'
  const submit = async () => {
    setBusy(true); setMsg(null)
    const body = method === 'manual'
      ? { device: iface.device, method: 'manual', address: ip, prefix, gateway: gw, dns }
      : { device: iface.device, method: 'auto' }
    const r = await onApply(body)
    setBusy(false)
    setMsg(r && r.ok ? { ok: true, t: 'Applied.' } : { ok: false, t: `Failed: ${(r && r.reason) || 'error'}` })
  }
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
        {iface.type === 'wifi' ? <WifiIcon fontSize="small" /> : <SettingsEthernetIcon fontSize="small" />}
        <Typography sx={{ fontWeight: 700 }}>{iface.label}</Typography>
        <Chip size="small" label={iface.state} color={connected ? 'success' : 'default'} />
        <Box sx={{ flex: 1 }} />
        {iface.type === 'wifi' && iface.ssid ? <Chip size="small" variant="outlined" label={iface.ssid} /> : null}
      </Stack>
      <Typography sx={{ fontSize: '0.85rem', opacity: 0.7, mb: 1.25 }}>
        {cur || 'no address'}{iface.gateway ? `  ·  gw ${iface.gateway}` : ''}{iface.dns && iface.dns.length ? `  ·  dns ${iface.dns.join(', ')}` : ''}
      </Typography>
      <ToggleButtonGroup exclusive size="small" value={method} onChange={(_, v) => v && setMethod(v)} sx={{ mb: method === 'manual' ? 1.25 : 1 }}>
        <ToggleButton value="auto">DHCP (auto)</ToggleButton>
        <ToggleButton value="manual">Static</ToggleButton>
      </ToggleButtonGroup>
      {method === 'manual' && (
        <Stack spacing={1.25} sx={{ mb: 1.25 }}>
          <Stack direction="row" spacing={1}>
            <TextField size="small" label="IP address" placeholder="192.168.1.50" value={ip} onChange={(e) => setIp(e.target.value)} sx={{ flex: 2 }} />
            <TextField size="small" label="Prefix" placeholder="24" value={prefix} onChange={(e) => setPrefix(e.target.value)} sx={{ flex: 1 }} />
          </Stack>
          <TextField size="small" label="Gateway" placeholder="192.168.1.1" value={gw} onChange={(e) => setGw(e.target.value)} />
          <TextField size="small" label="DNS (space-separated)" placeholder="192.168.1.1 8.8.8.8" value={dns} onChange={(e) => setDns(e.target.value)} />
        </Stack>
      )}
      {connected && (
        <Typography sx={{ fontSize: '0.78rem', color: 'warning.main', mb: 1 }}>
          ⚠ Changing this interface's address may drop the connection you're using right now.
        </Typography>
      )}
      <Stack direction="row" spacing={1.5} alignItems="center">
        <Button variant="contained" size="small" onClick={submit} disabled={busy}>{busy ? 'Applying…' : 'Apply'}</Button>
        {msg && <Typography sx={{ fontSize: '0.85rem', color: msg.ok ? 'success.main' : 'error.main' }}>{msg.t}</Typography>}
      </Stack>
    </Paper>
  )
}

function WifiConnect({ onChanged }) {
  const [nets, setNets] = useState(null)
  const [busy, setBusy] = useState(false)
  const [sel, setSel] = useState(null)
  const [pw, setPw] = useState('')
  const [msg, setMsg] = useState(null)
  const scan = async () => {
    setBusy(true); setNets(null); setMsg(null); setSel(null)
    const r = await fetch(`${SVC}/api/network/wifi`).then((x) => x.json()).catch(() => ({ networks: [] }))
    setNets(r.networks || []); setBusy(false)
  }
  const connect = async (ssid) => {
    setMsg({ t: `Connecting to ${ssid}…` })
    const r = await fetch(`${SVC}/api/network/wifi/connect`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ssid, password: pw }) })
      .then((x) => x.json()).catch(() => ({ ok: false }))
    setMsg(r.ok ? { ok: true, t: `Connected to ${ssid}` } : { ok: false, t: `Failed: ${r.reason || 'error'}` })
    if (r.ok) { setSel(null); setPw(''); onChanged && onChanged() }
  }
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
        <WifiIcon fontSize="small" />
        <Typography sx={{ fontWeight: 700, flex: 1 }}>Join a Wi-Fi network</Typography>
        <Button size="small" variant="outlined" onClick={scan} disabled={busy}>{busy ? 'Scanning…' : 'Scan'}</Button>
      </Stack>
      {msg && <Typography sx={{ fontSize: '0.85rem', mb: 1, color: msg.ok ? 'success.main' : msg.ok === false ? 'error.main' : 'text.secondary' }}>{msg.t}</Typography>}
      {nets && nets.length === 0 && <Typography sx={{ opacity: 0.6, fontSize: '0.85rem' }}>No networks found.</Typography>}
      <Stack spacing={0.5}>
        {(nets || []).map((n) => (
          <Box key={n.ssid}>
            <Stack direction="row" spacing={1} alignItems="center" sx={{ py: 0.5, cursor: 'pointer' }} onClick={() => setSel(sel === n.ssid ? null : n.ssid)}>
              <WifiIcon fontSize="small" sx={{ opacity: 0.4 + Math.min(0.6, n.signal / 100 * 0.6) }} />
              <Typography sx={{ flex: 1, fontWeight: n.inUse ? 700 : 400 }}>{n.ssid}{n.inUse ? '  ✓' : ''}</Typography>
              {n.security && n.security !== '--' ? <LockIcon sx={{ fontSize: 15, opacity: 0.5 }} /> : null}
              <Typography sx={{ fontSize: '0.8rem', opacity: 0.55, width: 34, textAlign: 'right' }}>{n.signal}%</Typography>
            </Stack>
            {sel === n.ssid && !n.inUse && (
              <Stack direction="row" spacing={1} alignItems="center" sx={{ py: 0.5, pl: 4 }}>
                {n.security && n.security !== '--'
                  ? <TextField size="small" type="password" label="Password" value={pw} onChange={(e) => setPw(e.target.value)} sx={{ flex: 1 }} />
                  : <Typography sx={{ flex: 1, fontSize: '0.85rem', opacity: 0.6 }}>Open network</Typography>}
                <Button size="small" variant="contained" onClick={() => connect(n.ssid)}>Connect</Button>
              </Stack>
            )}
          </Box>
        ))}
      </Stack>
    </Paper>
  )
}

function NetworkPanel({ active }) {
  const [net, setNet] = useState(null)
  const [err, setErr] = useState(false)
  const load = () => fetch(`${SVC}/api/network`).then((r) => r.json())
    .then((d) => { setNet(d); setErr(false) }).catch(() => setErr(true))
  useEffect(() => { if (active) load() }, [active])
  const apply = async (body) => {
    const r = await fetch(`${SVC}/api/network/ipv4`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then((x) => x.json()).catch(() => ({ ok: false, reason: 'error' }))
    setTimeout(load, 1500) // refresh after NetworkManager settles
    return r
  }
  if (err && !net) return <Typography sx={{ opacity: 0.6 }}>Can't reach the stereo service.</Typography>
  if (!net) return <Typography sx={{ opacity: 0.6 }}>Reading network…</Typography>
  return (
    <Stack spacing={1.5}>
      {(net.interfaces || []).map((iface) => <IfaceCard key={iface.device} iface={iface} onApply={apply} />)}
      <WifiConnect onChanged={() => setTimeout(load, 1500)} />
    </Stack>
  )
}

// ---- Music-library browser (AVRCP Filesystem via the service's btBrowse) ----
// Shared by the full and compact views (imported like Visualizer). Folders push
// onto a nav stack so the back arrow returns to the parent; tapping a track plays
// it and closes. Only shown when bt.browsable, so it's invisible until the backend
// (and the phone) actually support library browsing.
const FOLDER_LABEL = { albums: 'Albums', artists: 'Artists', genres: 'Genres', playlists: 'Playlists', titles: 'Songs', mixed: 'Library' }
function folderIconFor(ft) {
  if (ft === 'albums') return <AlbumIcon />
  if (ft === 'artists') return <PersonIcon />
  if (ft === 'playlists') return <PlaylistPlayIcon />
  if (ft === 'genres' || ft === 'titles') return <LibraryMusicIcon />
  return <FolderIcon />
}
// Module-level cache of folder contents (path -> items), persists across opens so
// revisiting a folder is instant. Cleared when the connected device changes.
const browseCache = new Map()
let browseCacheKey = '' // device mac the cache belongs to

// Shared browse logic (nav stack + persistent cache + background prefetch), used by
// both the full-screen dialog and the inline right-column panel. `active` triggers
// a reset-to-root (dialog: while open; inline: while browsable).
function useLibraryBrowse({ c, browsable, deviceKey, active }) {
  const [stack, setStack] = useState([{ path: 'root', title: 'Library' }])
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(false)
  const [unavailable, setUnavailable] = useState(false)
  const reqRef = useRef(0)
  const prefetchRef = useRef({ cancelled: true })

  if (deviceKey && deviceKey !== browseCacheKey) { browseCache.clear(); browseCacheKey = deviceKey }

  const prefetchChildren = (children) => {
    prefetchRef.current.cancelled = true
    const token = { cancelled: false }
    prefetchRef.current = token
    const folders = (children || []).filter((x) => x.type === 'folder' && !browseCache.has(x.path)).slice(0, 16)
    ;(async () => {
      for (const f of folders) {
        if (token.cancelled) return
        if (browseCache.has(f.path)) continue
        try { const r = await c.btBrowse(f.path); if (r && r.ok) browseCache.set(f.path, r.items || []) } catch (e) {}
      }
    })()
  }
  const applyItems = (path, its) => { browseCache.set(path, its); setItems(its); prefetchChildren(its) }
  const load = (entry) => {
    const id = ++reqRef.current
    setUnavailable(false)
    if (browseCache.has(entry.path)) {
      setLoading(false); setItems(browseCache.get(entry.path)); prefetchChildren(browseCache.get(entry.path))
      c.btBrowse(entry.path).then((r) => { if (id === reqRef.current && r && r.ok) applyItems(entry.path, r.items || []) })
      return
    }
    setLoading(true)
    c.btBrowse(entry.path).then((r) => {
      if (id !== reqRef.current) return
      if (r && r.ok) applyItems(entry.path, r.items || [])
      else { setItems([]); setUnavailable(true) }
      setLoading(false)
    })
  }

  // Warm the root as soon as browsing is available (before it's even shown).
  useEffect(() => {
    if (!browsable || browseCache.has('root')) return
    c.btBrowse('root').then((r) => { if (r && r.ok) { browseCache.set('root', r.items || []); prefetchChildren(r.items || []) } })
  }, [browsable, deviceKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // Reset to root when (re)activated / device changes.
  useEffect(() => {
    if (!active) return
    const root = [{ path: 'root', title: 'Library' }]
    setStack(root); load(root[0])
    return () => { prefetchRef.current.cancelled = true }
  }, [active, deviceKey]) // eslint-disable-line react-hooks/exhaustive-deps

  const cur = stack[stack.length - 1]
  const openFolder = (item) => { const entry = { path: item.path, title: item.name || 'Folder' }; setStack((s) => [...s, entry]); load(entry) }
  const goBack = () => { if (stack.length <= 1) return; const ns = stack.slice(0, -1); setStack(ns); load(ns[ns.length - 1]) }
  return { items, loading, unavailable, cur, openFolder, goBack, canBack: stack.length > 1 }
}

// Presentational library list. `dense` shrinks it for the inline right-column panel;
// `header` is an optional trailing header element (e.g. the dialog's close button).
function BrowseList({ browse, dense, onPlay, header }) {
  const { items, loading, unavailable, cur, openFolder, goBack, canBack } = browse
  const hdrBtn = { border: '2px solid rgba(255,255,255,0.25)', borderRadius: 2, p: dense ? 0.75 : 1.25, '&.Mui-disabled': { borderColor: 'rgba(255,255,255,0.08)' } }
  const emptyPy = dense ? 5 : 10
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      <Stack direction="row" alignItems="center" spacing={1.25} sx={{ flexShrink: 0, pb: 1, borderBottom: '1px solid rgba(255,255,255,0.12)' }}>
        <IconButton disabled={!canBack} onClick={goBack} sx={hdrBtn}><ArrowBackIcon sx={{ fontSize: dense ? 24 : 32 }} /></IconButton>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography sx={{ opacity: 0.5, fontSize: '0.7rem', letterSpacing: 1, lineHeight: 1 }}>LIBRARY</Typography>
          <Typography noWrap sx={{ fontWeight: 800, fontSize: dense ? '1.2rem' : '1.7rem', lineHeight: 1.2 }}>{cur.title}</Typography>
        </Box>
        {header}
      </Stack>
      <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', WebkitOverflowScrolling: 'touch',
        scrollbarWidth: 'none', msOverflowStyle: 'none', '&::-webkit-scrollbar': { display: 'none' } }}>
        {loading ? (
          <Stack alignItems="center" justifyContent="center" sx={{ py: emptyPy }}><CircularProgress size={dense ? 34 : 48} /></Stack>
        ) : unavailable ? (
          <Typography sx={{ opacity: 0.6, textAlign: 'center', py: emptyPy, fontSize: dense ? '1rem' : '1.3rem' }}>Library browsing not available</Typography>
        ) : items.length === 0 ? (
          <Typography sx={{ opacity: 0.6, textAlign: 'center', py: emptyPy, fontSize: dense ? '1rem' : '1.3rem' }}>Empty folder</Typography>
        ) : items.map((it) => (
          <Stack key={it.path} direction="row" alignItems="center" spacing={dense ? 1.5 : 2.5}
            onClick={() => (it.type === 'folder' ? openFolder(it) : onPlay(it))}
            sx={{ px: dense ? 1.25 : 3, py: dense ? 1.25 : 2.25, cursor: 'pointer', userSelect: 'none', borderBottom: '1px solid rgba(255,255,255,0.07)',
              transition: 'background 0.1s', '&:active': { bgcolor: 'rgba(57,160,255,0.18)' }, '&:hover': { bgcolor: 'rgba(57,160,255,0.08)' } }}>
            <Box sx={{ color: it.type === 'folder' ? 'primary.light' : 'text.secondary', display: 'flex', flexShrink: 0, '& svg': { fontSize: dense ? 28 : 38 } }}>
              {it.type === 'folder' ? folderIconFor(it.folderType) : <MusicNoteIcon />}
            </Box>
            <Box sx={{ minWidth: 0, flex: 1 }}>
              <Typography noWrap sx={{ fontWeight: 700, fontSize: dense ? '1.05rem' : '1.35rem', lineHeight: 1.25 }}>{it.name || it.title || 'Unknown'}</Typography>
              {it.type !== 'folder' && it.artist ? (
                <Typography noWrap sx={{ opacity: 0.7, fontSize: dense ? '0.8rem' : '1rem' }}>{it.artist}</Typography>
              ) : it.type === 'folder' && FOLDER_LABEL[it.folderType] ? (
                <Typography noWrap sx={{ opacity: 0.55, fontSize: dense ? '0.75rem' : '0.95rem' }}>{FOLDER_LABEL[it.folderType]}</Typography>
              ) : null}
            </Box>
            {it.type === 'folder'
              ? <ChevronRightIcon sx={{ fontSize: dense ? 26 : 34, opacity: 0.4, flexShrink: 0 }} />
              : <PlayArrowIcon sx={{ fontSize: dense ? 24 : 32, opacity: 0.35, flexShrink: 0 }} />}
          </Stack>
        ))}
      </Box>
    </Box>
  )
}

// Inline library for the big Stereo view's right column (above the transport controls).
export function InlineLibrary({ c, browsable, deviceKey }) {
  const browse = useLibraryBrowse({ c, browsable, deviceKey, active: browsable })
  return <BrowseList browse={browse} dense onPlay={(it) => c.btPlayItem(it.path)} />
}

export function BrowseLibraryDialog({ open, onClose, c, browsable, deviceKey }) {
  const browse = useLibraryBrowse({ c, browsable, deviceKey, active: open })
  // Freeze the visualizers while this full-screen dialog covers them.
  useEffect(() => { if (!open) return undefined; suspendVisualizers(true); return () => suspendVisualizers(false) }, [open])
  return (
    <Dialog open={open} onClose={onClose} maxWidth="md" fullWidth
      PaperProps={{ sx: { height: '90vh', maxHeight: 'none', display: 'flex', flexDirection: 'column' } }}>
      <Box sx={{ p: 2, height: '100%', minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <BrowseList browse={browse} onPlay={(it) => { c.btPlayItem(it.path); onClose() }}
          header={<IconButton onClick={onClose} sx={{ border: '2px solid rgba(255,255,255,0.25)', borderRadius: 2, p: 1.25 }}><CloseIcon sx={{ fontSize: 32 }} /></IconButton>} />
      </Box>
    </Dialog>
  )
}

// Settings modal, tabbed by source: Bluetooth (pairing/devices), FM (tuner), Aux.
// Touchscreen on-screen keyboard: appears when a text field is focused (there's no
// physical keyboard on the helm). Types via the native value setter so MUI onChange fires.
function OnScreenKeyboard() {
  const [target, setTarget] = useState(null)
  const [shift, setShift] = useState(false)
  useEffect(() => {
    const isText = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') && !['checkbox', 'radio', 'range', 'button', 'submit', 'file'].includes(el.type)
    const onIn = (e) => { if (isText(e.target)) setTarget(e.target) }
    const onOut = () => setTimeout(() => { if (!isText(document.activeElement)) setTarget(null) }, 120)
    document.addEventListener('focusin', onIn)
    document.addEventListener('focusout', onOut)
    return () => { document.removeEventListener('focusin', onIn); document.removeEventListener('focusout', onOut) }
  }, [])
  if (!target) return null
  const setVal = (v) => {
    const proto = target.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value').set
    setter.call(target, v); target.dispatchEvent(new Event('input', { bubbles: true }))
  }
  const press = (k) => {
    if (k === 'del') setVal(target.value.slice(0, -1))
    else if (k === 'space') setVal(target.value + ' ')
    else setVal(target.value + (shift ? k.toUpperCase() : k))
  }
  const key = (label, onClick, flex = 1) => (
    <Button key={label} onMouseDown={(e) => e.preventDefault()} onClick={onClick} variant="outlined"
      sx={{ minWidth: 0, flex, py: 1.1, fontSize: '1.15rem', lineHeight: 1, color: 'text.primary', borderColor: 'rgba(255,255,255,0.22)' }}>{label}</Button>
  )
  return (
    <Box onMouseDown={(e) => e.preventDefault()} sx={{ position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 4000,
      bgcolor: 'rgba(8,12,18,0.98)', borderTop: '1px solid rgba(255,255,255,0.2)', p: 1, boxShadow: '0 -8px 24px rgba(0,0,0,0.55)' }}>
      {['1234567890', 'qwertyuiop', 'asdfghjkl', 'zxcvbnm.-'].map((row) => (
        <Stack key={row} direction="row" spacing={0.5} justifyContent="center" sx={{ mb: 0.5 }}>
          {row.split('').map((c) => key(shift ? c.toUpperCase() : c, () => press(c)))}
        </Stack>
      ))}
      <Stack direction="row" spacing={0.5} justifyContent="center">
        {key(shift ? '⬆' : '⇧', () => setShift((s) => !s), 1.4)}
        {key('space', () => press('space'), 5)}
        {key('⌫', () => press('del'), 1.4)}
        {key('Done', () => target.blur(), 1.6)}
      </Stack>
    </Box>
  )
}
export function SettingsDialog({ open, onClose, settings, onChange, tab = 'fm', onTabChange, bt = {}, c }) {
  const st = settings || {}
  const auto = st.gain < 0
  // Local slider state so dragging stays smooth; only commit (which restarts the
  // tuner) when the finger lifts, via onChangeCommitted.
  const [gain, setGain] = useState(st.gain)
  const [squelch, setSquelch] = useState(st.squelch || 0)
  const [forgetAsk, setForgetAsk] = useState(null) // device pending forget confirmation
  useEffect(() => { setGain(st.gain) }, [st.gain])
  useEffect(() => { setSquelch(st.squelch || 0) }, [st.squelch])
  // Freeze the visualizers while Settings is open (full-screen, covers them).
  useEffect(() => { if (!open) return undefined; suspendVisualizers(true); return () => suspendVisualizers(false) }, [open])
  const faderSx = { py: 2, '& .MuiSlider-thumb': { width: 34, height: 34 }, '& .MuiSlider-rail, & .MuiSlider-track': { height: 12, borderRadius: 8 } }
  const conn = bt.connected
  return (
    // Fixed height so the dialog never resizes (and so its top edge never moves)
    // when switching between the Bluetooth/FM/Aux tabs — the body scrolls instead.
    <Dialog open={open} onClose={onClose} maxWidth="lg" fullWidth
      PaperProps={{ sx: { height: 'min(80vh, 680px)', display: 'flex', flexDirection: 'column', position: 'relative' } }}>
      <Stack direction="row" alignItems="center" sx={{ px: 2, pt: 1.5, flexShrink: 0 }}>
        <Typography variant="h6" sx={{ flex: 1, fontWeight: 800 }}>Settings</Typography>
        <IconButton onClick={onClose}><CloseIcon /></IconButton>
      </Stack>
      <Tabs value={tab} onChange={(_, v) => onTabChange && onTabChange(v)} variant="fullWidth"
        sx={{ borderBottom: '1px solid rgba(255,255,255,0.12)', flexShrink: 0 }}>
        <Tab value="bluetooth" label="Bluetooth" />
        <Tab value="fm" label="FM" />
        <Tab value="aux" label="Aux" />
        <Tab value="engine" label="Engine" />
        <Tab value="trip" label="Trip" />
        <Tab value="network" label="Network" />
        <Tab value="sensors" label="Sensors" />
        <Tab value="system" label="System" />
      </Tabs>
      {/* Scrolls by drag/flick, but no visible scrollbar — it's a touchscreen, and
          Chromium's default bar looks like a relic. */}
      <Box sx={{ p: 3, flex: 1, minHeight: 0, overflowY: 'auto', WebkitOverflowScrolling: 'touch',
        scrollbarWidth: 'none', msOverflowStyle: 'none', '&::-webkit-scrollbar': { display: 'none' } }}>
        {tab === 'bluetooth' && (
          <Stack spacing={2}>
            {conn ? (
              <Paper variant="outlined" sx={{ p: 2 }}>
                <Typography sx={{ fontWeight: 700, fontSize: '1.3rem' }}>{conn.name}</Typography>
                <Typography sx={{ color: 'success.main' }}>
                  Connected{conn.battery != null ? ` · Battery ${conn.battery}%` : ''}
                </Typography>
                {/* Touch targets: these get pressed on a moving boat. */}
                <Stack direction="row" spacing={1.5} sx={{ mt: 2 }}>
                  <Button variant="outlined" size="large" onClick={() => c && c.btDisconnect()}
                    sx={{ flex: 1, py: 1.5, fontSize: '1.1rem', fontWeight: 700 }}>Disconnect</Button>
                  <Button variant="outlined" size="large" color="error" onClick={() => setForgetAsk(conn)}
                    sx={{ py: 1.5, px: 3, fontSize: '1.1rem', fontWeight: 700 }}>Forget</Button>
                </Stack>
              </Paper>
            ) : <Typography sx={{ opacity: 0.6 }}>No phone connected.</Typography>}
            <Button variant="contained" size="large" fullWidth startIcon={<BluetoothSearchingIcon />}
              onClick={() => c && c.btPair()} sx={{ py: 1.5 }}>Pair New Phone</Button>
            {bt.pairing && (
              <Typography sx={{ opacity: 0.75, textAlign: 'center', fontSize: '0.9rem' }}>
                Discoverable — open Bluetooth on your phone and select this device…
              </Typography>
            )}
            <Dialog open={!!forgetAsk} onClose={() => setForgetAsk(null)} maxWidth="xs" fullWidth>
              <Box sx={{ p: 3 }}>
                <Typography sx={{ fontWeight: 800, fontSize: '1.2rem', mb: 1 }}>Forget {forgetAsk && forgetAsk.name}?</Typography>
                <Typography sx={{ opacity: 0.8, fontSize: '0.95rem', mb: 2 }}>
                  This removes the pairing on the boat. Also tap “Forget This Device” on the
                  phone, or it won't be able to pair again.
                </Typography>
                <Stack direction="row" spacing={1} justifyContent="flex-end">
                  <Button onClick={() => setForgetAsk(null)}>Cancel</Button>
                  <Button color="error" variant="contained"
                    onClick={() => { c && c.btForget(forgetAsk.mac); setForgetAsk(null) }}>Forget</Button>
                </Stack>
              </Box>
            </Dialog>
            {(bt.devices || []).filter((d) => !d.connected).length > 0 && (
              <Typography sx={{ opacity: 0.6, fontSize: '0.8rem', letterSpacing: 1, mt: 1 }}>PAIRED DEVICES</Typography>
            )}
            {(bt.devices || []).filter((d) => !d.connected).map((d) => (
              <Stack key={d.mac} direction="row" spacing={1} alignItems="center">
                <Button variant="outlined" sx={{ flex: 1, justifyContent: 'flex-start', py: 1 }}
                  onClick={() => c && c.btConnect(d.mac)}>{d.name}</Button>
                {/* Removing the key here isn't enough on its own — the phone has to
                    forget this device too, hence the hint in the confirm. */}
                <Button color="error" sx={{ flexShrink: 0 }}
                  onClick={() => setForgetAsk(d)}>Forget</Button>
              </Stack>
            ))}
          </Stack>
        )}
        {tab === 'fm' && (
          <Stack spacing={3}>
            <Box>
              <Stack direction="row" alignItems="center">
                <Typography sx={{ flex: 1, fontWeight: 700 }}>Tuner gain</Typography>
                <FormControlLabel
                  control={<Switch checked={auto} onChange={(e) => onChange({ gain: e.target.checked ? -1 : 30 })} />}
                  label="Auto" />
              </Stack>
              <Slider disabled={auto} value={auto ? 49.6 : gain} min={0} max={49.6} step={0.1}
                onChange={(_, v) => setGain(v)} onChangeCommitted={(_, v) => onChange({ gain: v })}
                valueLabelDisplay="auto" sx={faderSx} />
              <Typography sx={{ opacity: 0.55, fontSize: '0.85rem' }}>
                Higher pulls weak signals up; too high overloads a strong station into hiss.
              </Typography>
            </Box>
            <Divider />
            <FormControlLabel
              control={<Switch checked={!!st.deemp} onChange={(e) => onChange({ deemp: e.target.checked })} />}
              label="De-emphasis (75µs, US broadcast)" />
            <FormControlLabel
              control={<Switch checked={!!st.filter} onChange={(e) => onChange({ filter: e.target.checked })} />}
              label="Quality downsample filter (-F 9)" />
            <Divider />
            <Box>
              <Typography sx={{ fontWeight: 700, mb: 1 }}>Squelch</Typography>
              <Slider value={squelch} min={0} max={80} step={1}
                onChange={(_, v) => setSquelch(v)} onChangeCommitted={(_, v) => onChange({ squelch: v })}
                valueLabelDisplay="auto" sx={faderSx} />
              <Typography sx={{ opacity: 0.55, fontSize: '0.85rem' }}>Mutes weak/noisy signals below the threshold (0 = off).</Typography>
            </Box>
            <Box>
              <Typography sx={{ fontWeight: 700, mb: 1 }}>Frequency correction (PPM)</Typography>
              <Stack direction="row" alignItems="center" spacing={2}>
                <IconButton onClick={() => onChange({ ppm: (st.ppm || 0) - 1 })}><RemoveIcon /></IconButton>
                <Typography sx={{ minWidth: 60, textAlign: 'center', fontVariantNumeric: 'tabular-nums', fontSize: '1.4rem' }}>{st.ppm || 0}</Typography>
                <IconButton onClick={() => onChange({ ppm: (st.ppm || 0) + 1 })}><AddIcon /></IconButton>
              </Stack>
              <Typography sx={{ opacity: 0.55, fontSize: '0.85rem' }}>Your TCXO dongle should need ~0.</Typography>
            </Box>
          </Stack>
        )}
        {tab === 'engine' && <EnginePanel />}
        {tab === 'trip' && <TripPanel active={tab === 'trip'} />}
        {tab === 'network' && <NetworkPanel active={tab === 'network'} />}
        {tab === 'sensors' && <SensorsPanel active={tab === 'sensors'} />}
        {tab === 'system' && <SystemPanel active={tab === 'system'} />}
        {tab === 'aux' && (
          <Stack spacing={2.5}>
            <Typography sx={{ opacity: 0.7 }}>Line input via the 3.5mm aux jack.</Typography>
            <Box>
              <Typography sx={{ fontWeight: 700, mb: 1 }}>Input channels</Typography>
              <ToggleButtonGroup exclusive value={st.auxChannels || 'stereo'} onChange={(_, v) => v && onChange({ auxChannels: v })}>
                <ToggleButton value="stereo" sx={{ px: 4, py: 1, fontWeight: 700 }}>Stereo</ToggleButton>
                <ToggleButton value="mono" sx={{ px: 4, py: 1, fontWeight: 700 }}>Mono</ToggleButton>
              </ToggleButtonGroup>
              <Typography sx={{ opacity: 0.55, fontSize: '0.85rem', mt: 1 }}>
                Mono sums both channels — use it for a single line-level source.
              </Typography>
            </Box>
          </Stack>
        )}
      </Box>
      <OnScreenKeyboard />
    </Dialog>
  )
}

function StereoView({ big = false }) {
  const [s, setS] = useState(null)

  const [btDevOpen, setBtDevOpen] = useState(false)
  const [browseOpen, setBrowseOpen] = useState(false) // music-library browser
  const [deleteConfirm, setDeleteConfirm] = useState(null) // { i, preset } pending removal
  const ctl = useRef(null)
  const posRef = useRef({ pos: 0, at: 0, key: '' })
  const renameRef = useRef(null)
  const swipeX = useRef(0)
  const dragging = useRef(false)
  const cardRef = useRef(null) // swipeable album card (transform written directly to the DOM)
  const [pending, setPending] = useState(false) // just changed track: blank info + placeholder until new track lands
  const pendKeyRef = useRef(''), trackKeyRef = useRef(''), pendTimer = useRef(null)
  const pendDirRef = useRef('next') // which way the pending track change went
  const [, setTick] = useState(0)
  useEffect(() => {
    ctl.current = createRadioClient(setS)
    const t = setInterval(() => setTick((x) => x + 1), 1000) // ticks the progress bar between polls
    return () => { ctl.current && ctl.current.stop && ctl.current.stop(); clearInterval(t) }
  }, [])
  if (!s) return null

  const c = ctl.current
  const off = !s.power

  // Album swipe: the card follows the finger via direct DOM writes, then slides
  // off and the next track slides in (mobile-style). Pointer events + capture +
  // touch-action:none so the browser can't steal the gesture.
  const SWIPE_OUT = 480, SWIPE_MIN = 55
  const setCard = (x, animate) => {
    const el = cardRef.current
    if (!el) return
    el.style.transition = animate ? 'transform 0.24s ease, opacity 0.24s ease' : 'none'
    el.style.transform = `translateX(${x}px)`
    el.style.opacity = String(Math.max(0.12, 1 - Math.abs(x) / 520))
  }
  const onSwipeStart = (e) => {
    swipeX.current = e.clientX; dragging.current = true; setCard(0, false)
    try { e.currentTarget.setPointerCapture(e.pointerId) } catch (x) {}
  }
  const onSwipeMove = (e) => { if (dragging.current) setCard(e.clientX - swipeX.current, false) }
  const slideInFrom = (from) => setTimeout(() => {
    setCard(from, false)
    requestAnimationFrame(() => requestAnimationFrame(() => setCard(0, true)))
  }, 210)
  const markPending = (dir) => {
    pendDirRef.current = dir || 'next'
    pendKeyRef.current = trackKeyRef.current; setPending(true)
    clearTimeout(pendTimer.current); pendTimer.current = setTimeout(() => setPending(false), 5000)
  }
  const onSwipeEnd = (e) => {
    if (!dragging.current) return
    dragging.current = false
    const dx = e.clientX - swipeX.current
    if (dx <= -SWIPE_MIN) { setCard(-SWIPE_OUT, true); c.btNext(); slideInFrom(SWIPE_OUT); markPending('next') }
    else if (dx >= SWIPE_MIN) { setCard(SWIPE_OUT, true); c.btPrev(); slideInFrom(-SWIPE_OUT); markPending('prev') }
    else setCard(0, true) // snap back
  }

  // Bluetooth connection + phone battery (shown inside the Bluetooth source button).
  const bt = s.bluetooth || {}
  const batLvl = bt.connected ? bt.connected.battery : null
  const batGlyph = (size) => {
    if (batLvl == null) return null
    const isx = { transform: 'rotate(90deg)', fontSize: size, color: batLvl <= 15 ? 'error.main' : batLvl <= 30 ? 'warning.main' : 'success.main' }
    if (batLvl <= 15) return <BatteryAlertIcon sx={isx} />
    if (batLvl <= 40) return <Battery20Icon sx={isx} />
    if (batLvl <= 75) return <Battery60Icon sx={isx} />
    return <BatteryFullIcon sx={isx} />
  }
  const sourceToggle = (
    <Box>
      {/* Label row: SOURCE (left) + the settings cog (right, above the AUX button). */}
      <Stack direction="row" alignItems="center" sx={{ mb: 0.75 }}>
        <Typography sx={{ flex: 1, fontSize: big ? '0.9rem' : '0.68rem', opacity: 0.5, fontWeight: 700, letterSpacing: 1.5 }}>SOURCE</Typography>
      </Stack>
      <ToggleButtonGroup exclusive fullWidth size={big ? 'large' : 'small'} value={s.source}
        onChange={(_, v) => v && c.setSource(v)}>
        {SOURCES.map((src) => (
          <ToggleButton key={src} value={src} sx={{ py: big ? 1.4 : 0.75, fontSize: big ? '1.45rem' : '0.95rem', fontWeight: 700, gap: big ? 1.25 : 0.75 }}>
            {src === 'FM' ? <RadioIcon sx={{ fontSize: big ? 26 : 20 }} /> : src === 'Bluetooth' ? <BluetoothIcon sx={{ fontSize: big ? 26 : 20 }} /> : <CableIcon sx={{ fontSize: big ? 26 : 20 }} />}
            {src}
            {src === 'FM' && (
              <Chip size="small" color={s.connected ? 'success' : 'warning'} label={s.connected ? 'RTL-SDR' : 'no svc'}
                sx={{ opacity: 0.6, height: big ? 18 : 15, '& .MuiChip-label': { px: 0.5, fontSize: big ? '0.6rem' : '0.5rem', fontWeight: 700, letterSpacing: 0.2 } }} />
            )}
            {src === 'Bluetooth' && batLvl != null && (
              <Stack direction="row" alignItems="center" spacing={0.25}>
                {batGlyph(big ? 26 : 22)}
                <Typography sx={{ fontSize: big ? '0.85rem' : '0.7rem', fontWeight: 700 }}>{batLvl}%</Typography>
              </Stack>
            )}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
    </Box>
  )

  const tuner = s.source === 'FM' ? (
    <Box>
      <Stack direction="row" alignItems="center" justifyContent="center" spacing={big ? 3 : 1.25}>
        <IconButton onClick={() => c.seek(-1)} sx={{ border: '2px solid rgba(255,255,255,0.2)', p: big ? 2 : 1, '&:hover': { borderColor: 'primary.main' } }}>
          <SkipPreviousIcon sx={{ fontSize: big ? 52 : 26 }} />
        </IconButton>
        <Typography sx={{ fontWeight: 800, lineHeight: 1, fontVariantNumeric: 'tabular-nums',
          fontSize: big ? '6rem' : '2.4rem', minWidth: big ? 340 : 150, textAlign: 'center' }}>
          {s.fm.freq.toFixed(1)}
          <Typography component="span" sx={{ ml: 1, opacity: 0.55, fontSize: big ? '1.8rem' : '1rem' }}>FM</Typography>
        </Typography>
        <IconButton onClick={() => c.seek(1)} sx={{ border: '2px solid rgba(255,255,255,0.2)', p: big ? 2 : 1, '&:hover': { borderColor: 'primary.main' } }}>
          <SkipNextIcon sx={{ fontSize: big ? 52 : 26 }} />
        </IconButton>
      </Stack>
      {/* RDS station info decoded over the air — same card treatment as the BT now-playing. */}
      <Box sx={{ textAlign: 'center', minHeight: big ? 96 : 44, mt: big ? 1.5 : 0.5,
        display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: big ? 0.5 : 0.25,
        bgcolor: 'rgba(57,160,255,0.12)', border: '1px solid rgba(57,160,255,0.4)', borderRadius: 2, p: big ? 2.5 : 1.5 }}>
        {s.nowPlaying?.title ? (
          <Typography noWrap sx={{ fontWeight: 800, color: '#fff', lineHeight: 1.05, fontSize: big ? '3.2rem' : '1.3rem' }}>
            {s.nowPlaying.title}
          </Typography>
        ) : s.power ? (
          <Typography sx={{ opacity: 0.4, fontSize: big ? '1.3rem' : '0.85rem' }}>searching for station info…</Typography>
        ) : null}
        {s.nowPlaying?.artist && (
          <Typography sx={{ opacity: 0.85, fontSize: big ? '1.5rem' : '0.9rem', lineHeight: 1.3,
            display: '-webkit-box', WebkitLineClamp: big ? 4 : 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
            {s.nowPlaying.artist}
          </Typography>
        )}
      </Box>
      <Slider size={big ? 'medium' : 'small'} value={s.fm.freq} min={FM_MIN} max={FM_MAX} step={0.1}
        onChange={(_, v) => c.tune(v)} valueLabelDisplay="auto" sx={{ mt: big ? 1 : 0 }} />
    </Box>
  ) : (
    <Typography align="center" sx={{ py: big ? 6 : 1.5, opacity: 0.7, fontSize: big ? '1.4rem' : undefined }}>
      {s.source}: {s.nowPlaying.title}{s.nowPlaying.artist ? ` — ${s.nowPlaying.artist}` : ''}
    </Typography>
  )

  const presets = (
    <Box>
      <Stack direction="row" alignItems="center" sx={{ mb: 1.5 }}>
        <Typography sx={{ flex: 1, fontWeight: 700, opacity: 0.85, fontSize: big ? '1.2rem' : '0.9rem' }}>Presets</Typography>
        <IconButton onClick={() => c.savePreset(s.fm.freq)} title={`Save ${s.fm.freq.toFixed(1)}`}
          sx={{ border: '2px solid', borderColor: 'primary.main', borderRadius: 2, color: 'primary.main', p: big ? 1.25 : 0.5 }}>
          <SaveIcon sx={{ fontSize: big ? 32 : 22 }} />
        </IconButton>
      </Stack>
      <Stack direction="row" spacing={big ? 1.5 : 0.75} justifyContent={big ? 'flex-start' : 'center'} flexWrap="wrap" useFlexGap>
        {s.fm.presets.map((p, i) => (
          <PresetCard key={`${p.freq}-${i}`} preset={p} big={big} active={Math.abs(p.freq - s.fm.freq) < 0.05}
            onSelect={() => c.selectPreset(i)} onDelete={() => setDeleteConfirm({ i, preset: p })} />
        ))}
        {s.fm.presets.length === 0 && <Typography sx={{ opacity: 0.5 }}>No presets — tune a station and tap Save</Typography>}
      </Stack>
      {big && <Typography sx={{ mt: 1.5, opacity: 0.4, fontSize: '0.85rem' }}>Long-press a preset card to remove it</Typography>}
    </Box>
  )

  const volStep = (d) => c.setVolume(Math.max(0, Math.min(VOL_MAX, (s.muted ? 0 : s.volume) + d)))
  const volBtnSx = { border: '2px solid rgba(255,255,255,0.22)', borderRadius: 2, p: big ? 1.2 : 0.4, '&:hover': { borderColor: 'primary.main' } }
  const volume = (
    <Stack direction="row" alignItems="center" spacing={big ? 1.5 : 0.75}>
      <IconButton size={big ? 'large' : 'small'} onClick={() => c.toggleMute()}>
        {s.muted ? <VolumeOffIcon sx={{ fontSize: big ? 40 : 24 }} /> : <VolumeUpIcon sx={{ fontSize: big ? 40 : 24 }} />}
      </IconButton>
      <IconButton onClick={() => volStep(-1)} sx={volBtnSx}><RemoveIcon sx={{ fontSize: big ? 34 : 20 }} /></IconButton>
      <Slider
        value={s.muted ? 0 : s.volume} min={0} max={VOL_MAX} step={1}
        onChange={(_, v) => c.setVolume(v)} valueLabelDisplay="auto"
        sx={{
          flex: 1,
          py: big ? 2.5 : 1.25, // bigger vertical touch target
          '& .MuiSlider-thumb': {
            width: big ? 44 : 24, height: big ? 44 : 24,
            '&:hover, &.Mui-focusVisible': { boxShadow: '0 0 0 10px rgba(57,160,255,0.16)' },
          },
          '& .MuiSlider-rail, & .MuiSlider-track': { height: big ? 18 : 9, borderRadius: 10 },
          '& .MuiSlider-valueLabel': { fontSize: big ? '1.1rem' : undefined },
        }}
      />
      <IconButton onClick={() => volStep(1)} sx={volBtnSx}><AddIcon sx={{ fontSize: big ? 34 : 20 }} /></IconButton>
      <Typography sx={{ width: big ? 56 : 30, textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontSize: big ? '1.7rem' : undefined, fontWeight: big ? 700 : 400 }}>
        {s.muted ? 'M' : s.volume}
      </Typography>
    </Stack>
  )

  // Vertical volume column for the big layout (+ on top, − on bottom).
  const volumeVertical = (
    <>
      <IconButton onClick={() => c.toggleMute()}>
        {s.muted ? <VolumeOffIcon sx={{ fontSize: 34 }} /> : <VolumeUpIcon sx={{ fontSize: 34 }} />}
      </IconButton>
      <IconButton onClick={() => volStep(1)} sx={volBtnSx}><AddIcon sx={{ fontSize: 32 }} /></IconButton>
      <Slider orientation="vertical" value={s.muted ? 0 : s.volume} min={0} max={VOL_MAX} step={1}
        onChange={(_, v) => c.setVolume(v)} valueLabelDisplay="auto"
        sx={{ flex: 1, my: 1, '& .MuiSlider-thumb': { width: 42, height: 42 }, '& .MuiSlider-rail, & .MuiSlider-track': { width: 18, borderRadius: 10 } }} />
      <IconButton onClick={() => volStep(-1)} sx={volBtnSx}><RemoveIcon sx={{ fontSize: 32 }} /></IconButton>
      <Typography sx={{ fontSize: '1.7rem', fontWeight: 700, fontVariantNumeric: 'tabular-nums' }}>{s.muted ? 'M' : s.volume}</Typography>
    </>
  )

  // ---- source-aware content (FM tuner+presets, Bluetooth device mgmt, Aux) ----
  const isFM = s.source === 'FM'
  // BT track progress, interpolated locally between polls
  const fmtTime = (ms) => { const sec = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}` }
  const tr = bt.track
  let curPos = 0, dur = 0
  if (tr) {
    dur = tr.duration || 0
    const key = `${tr.title}|${tr.position}`
    if (posRef.current.key !== key) posRef.current = { pos: tr.position || 0, at: performance.now(), key }
    curPos = posRef.current.pos + (tr.status === 'playing' ? performance.now() - posRef.current.at : 0)
    if (dur) curPos = Math.min(curPos, dur)
  }
  const trackKey = tr ? `${tr.title}|${tr.artKey || ''}` : ''
  trackKeyRef.current = trackKey
  const loadingNext = !!(pending && trackKey === pendKeyRef.current)
  // Stepping back: show the remembered track straight away rather than blanking,
  // since we already know exactly what's coming (service keeps the last 3).
  const backTo = loadingNext && pendDirRef.current === 'prev' ? (bt.history || [])[0] : null
  const showArtPlaceholder = tr && !(backTo && backTo.artKey) && (!tr.artKey || loadingNext)
  const artSize = big ? 150 : 60
  // The two phones that most recently connected here. Before any history exists
  // (fresh install) fall back to the paired list so the buttons aren't empty.
  // Pairing wizard: modal so it can't be missed, names the device the phone will
  // see, and counts down the discoverable window BlueZ actually enforces.
  const pairLeft = bt.pairUntil ? Math.max(0, Math.ceil((bt.pairUntil - Date.now()) / 1000)) : 0
  const pairWizard = (
    <Dialog open={!!bt.pairing} onClose={() => c && c.btCancelPair()} maxWidth="xs" fullWidth>
      <Box sx={{ p: 3, textAlign: 'center' }}>
        {bt.pairedNew ? (
          <>
            <CheckCircleIcon color="success" sx={{ fontSize: 56, mb: 1 }} />
            <Typography sx={{ fontWeight: 800, fontSize: '1.3rem', mb: 1 }}>Paired</Typography>
            <Typography sx={{ opacity: 0.8, mb: 2 }}>
              {bt.connected && bt.connected.mac === bt.pairedNew.mac
                ? `${bt.pairedNew.name} is connected.`
                : `${bt.pairedNew.name} paired — starting audio may take a moment.`}
            </Typography>
            <Button variant="contained" onClick={() => c && c.btCancelPair()}>Done</Button>
          </>
        ) : (
          <>
            <CircularProgress size={44} sx={{ mb: 2 }} />
            <Typography sx={{ fontWeight: 800, fontSize: '1.3rem', mb: 1 }}>Ready to pair</Typography>
            <Typography sx={{ opacity: 0.85, mb: 1 }}>
              On your phone, open Bluetooth settings and tap:
            </Typography>
            <Typography sx={{ fontWeight: 800, fontSize: '1.5rem', color: 'primary.light', mb: 2 }}>
              {bt.name || 'this device'}
            </Typography>
            <Typography sx={{ opacity: 0.6, fontSize: '0.9rem', mb: 2 }}>
              {pairLeft ? `Discoverable for ${pairLeft}s` : 'Discoverable'}
            </Typography>
            <Button onClick={() => c && c.btCancelPair()}>Cancel</Button>
          </>
        )}
      </Box>
    </Dialog>
  )
  const cx = bt.connecting // { mac, status: connecting|ok|fail, error }
  const recentPhones = ((bt.recent && bt.recent.length ? bt.recent
    : (bt.devices || []).filter((d) => !d.icon || d.icon === 'phone')) // skip keyboards etc.
    .filter((d) => !bt.connected || d.mac !== bt.connected.mac)).slice(0, 2)
  const btNowPlaying = (
    <Box sx={{ textAlign: 'center' }}>
      {bt.track ? (
        <Box
          onPointerDown={onSwipeStart} onPointerMove={onSwipeMove} onPointerUp={onSwipeEnd} onPointerCancel={onSwipeEnd}
          sx={{ bgcolor: 'rgba(57,160,255,0.12)', border: '1px solid rgba(57,160,255,0.4)', borderRadius: 2, p: big ? 2.5 : 1.5,
            touchAction: 'none', userSelect: 'none', overflow: 'hidden' }}>
          <Box ref={cardRef} sx={{ display: 'flex', alignItems: 'center', gap: big ? 3 : 1.5, minWidth: 0, willChange: 'transform' }}>
            {/* Art box is always this size so the card never resizes when there's no cover. */}
            {showArtPlaceholder ? (
              <Box sx={{ width: artSize, height: artSize, borderRadius: 1.5, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', bgcolor: 'rgba(255,255,255,0.06)', pointerEvents: 'none' }}>
                <MusicNoteIcon sx={{ fontSize: big ? 72 : 30, opacity: 0.3 }} />
              </Box>
            ) : (
              <Box component="img" src={`${SVC}/api/art?k=${encodeURIComponent((backTo && backTo.artKey) || tr.artKey)}`} alt="" draggable={false}
                sx={{ width: artSize, height: artSize, borderRadius: 1.5, flexShrink: 0, objectFit: 'cover', pointerEvents: 'none' }} />
            )}
            {/* Always-rendered, fixed-height lines so title/artist/album never move. */}
            <Box sx={{ minWidth: 0, flex: 1, textAlign: 'left' }}>
              <Typography noWrap sx={{ fontWeight: 800, color: '#fff', lineHeight: 1.2, fontSize: big ? '2.4rem' : '1.3rem', height: big ? '2.9rem' : '1.6rem' }}>
                {backTo ? backTo.title : (loadingNext ? ' ' : (tr.title || ' '))}
              </Typography>
              <Typography noWrap sx={{ color: 'primary.light', fontWeight: 700, mt: 0.5, fontSize: big ? '1.6rem' : '1rem', lineHeight: 1.3, height: big ? '2.1rem' : '1.35rem' }}>
                {backTo ? (backTo.artist || ' ') : (loadingNext ? ' ' : (tr.artist || ' '))}
              </Typography>
              <Typography noWrap sx={{ opacity: 0.7, fontSize: big ? '1.2rem' : '0.85rem', mt: 0.25, lineHeight: 1.3, height: big ? '1.6rem' : '1.15rem' }}>
                {backTo ? (backTo.album || ' ') : (loadingNext ? ' ' : (tr.album || ' '))}
              </Typography>
            </Box>
          </Box>
        </Box>
      ) : bt.connected ? (
        <Typography sx={{ opacity: 0.6, fontSize: big ? '1.5rem' : '1rem', py: big ? 4 : 2 }}>
          {bt.control === 'legacy' ? 'Connected \u2014 this phone doesn\u2019t share track info' : 'Play something on your phone'}
        </Typography>
      ) : (
        // Nothing connected: offer one tap to reconnect a phone that's been here
        // before, and pairing for one that hasn't — no digging through Devices.
        // Buttons are centred and width-capped rather than stretched, and pairing
        // sits well clear of the reconnect buttons so it isn't hit by mistake.
        <Stack spacing={big ? 1.5 : 1} sx={{ py: big ? 3 : 1.5, alignItems: 'center' }}>
          <Typography sx={{ opacity: 0.6, fontSize: big ? '1.3rem' : '0.95rem' }}>No phone connected</Typography>
          {recentPhones.map((d) => {
            const st = cx && cx.mac === d.mac ? cx.status : ''
            return (
              <Button key={d.mac} variant="outlined" size="large" disabled={st === 'connecting'}
                color={st === 'ok' ? 'success' : st === 'fail' ? 'error' : 'primary'}
                startIcon={st === 'connecting' ? <CircularProgress size={big ? 22 : 18} color="inherit" />
                  : st === 'ok' ? <CheckCircleIcon /> : st === 'fail' ? <ErrorOutlineIcon /> : <BluetoothIcon />}
                onClick={() => c.btConnect(d.mac)}
                sx={{ py: big ? 1.4 : 0.9, width: big ? 340 : 230, maxWidth: '100%', fontSize: big ? '1.2rem' : '0.95rem', fontWeight: 700,
                  '&.Mui-disabled': { color: 'primary.light', borderColor: 'primary.light' } }}>
                {st === 'connecting' ? 'Connecting…' : st === 'ok' ? 'Connected' : st === 'fail' ? (cx.error || 'Failed') : d.name}
              </Button>
            )
          })}
          {/* Padding, not margin: Stack's spacing rule sets margin-top on every
              child and would override an mt here. */}
          <Box sx={{ pt: big ? 4 : 2.5, width: big ? 340 : 230, maxWidth: '100%' }}>
            <Button fullWidth variant="contained" size="large" startIcon={<BluetoothSearchingIcon />}
              onClick={() => c.btPair()}
              sx={{ py: big ? 1.4 : 0.9, fontSize: big ? '1.2rem' : '0.95rem', fontWeight: 700 }}>Pair New Phone</Button>
          </Box>
        </Stack>
      )}
    </Box>
  )
  const auxMain = (
    <Box sx={{ textAlign: 'center', py: big ? 6 : 2 }}>
      <Typography sx={{ fontWeight: 800, fontSize: big ? '2.4rem' : '1.2rem' }}>Aux Input</Typography>
      <Typography sx={{ opacity: 0.7 }}>Line in via the 3.5mm jack</Typography>
    </Box>
  )
  // Compact current-device strip; full device list/pairing lives in a modal.
  const btDeviceStrip = (
    <Stack direction="row" alignItems="center" spacing={big ? 1.5 : 0.75} sx={{ mb: big ? 2 : 1 }}>
      <BluetoothIcon sx={{ color: bt.connected ? 'primary.light' : 'text.disabled' }} />
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography noWrap sx={{ fontWeight: 700, fontSize: big ? '1.3rem' : '1rem' }}>
          {bt.connected ? bt.connected.name : ((bt.devices || [])[0]?.name || 'No device')}
        </Typography>
        <Typography sx={{ fontSize: big ? '1rem' : '0.8rem', opacity: 0.7 }}>
          {bt.connected ? 'Connected' : 'Not connected'}
        </Typography>
      </Box>
      {bt.browsable && (
        <Button variant="outlined" size="large" startIcon={<LibraryMusicIcon />} onClick={() => setBrowseOpen(true)}
          sx={{ py: big ? 1.4 : 1, px: big ? 3 : 2.25, fontSize: big ? '1.2rem' : '1rem', fontWeight: 700, flexShrink: 0 }}>Browse</Button>
      )}
      <Button variant="outlined" size="large" startIcon={<BluetoothSearchingIcon />} onClick={() => setBtDevOpen(true)}
        sx={{ py: big ? 1.4 : 1, px: big ? 3 : 2.25, fontSize: big ? '1.2rem' : '1rem', fontWeight: 700, flexShrink: 0 }}>Devices</Button>
    </Stack>
  )
  // Transport controls live outside the "has metadata" branch so they're always on
  // screen — greyed out with no phone connected. Phones that never publish
  // metadata (iOS here) still drive fine via the service's legacy control path.
  const btCtlOn = !!bt.connected
  const dimSx = { '&.Mui-disabled': { color: 'rgba(255,255,255,0.22)', borderColor: 'rgba(255,255,255,0.10)' } }
  const btTransport = (
    <>
      <Stack direction="row" justifyContent="center" alignItems="center" spacing={big ? 2.5 : 1.25}>
        <IconButton disabled={!btCtlOn} onClick={() => c.btShuffle()} title="Shuffle"
          sx={{ color: bt.shuffle && bt.shuffle !== 'off' ? 'primary.light' : 'text.disabled', ...dimSx }}>
          <ShuffleIcon sx={{ fontSize: big ? 34 : 22 }} />
        </IconButton>
        <IconButton disabled={!btCtlOn} onClick={() => { c.btPrev(); markPending('prev') }} sx={{ border: '2px solid rgba(255,255,255,0.2)', ...dimSx }}><SkipPreviousIcon sx={{ fontSize: big ? 46 : 28 }} /></IconButton>
        <IconButton disabled={!btCtlOn} onClick={() => c.btPlayPause()} sx={{ border: '2px solid', borderColor: 'primary.main', bgcolor: 'rgba(57,160,255,0.15)', p: big ? 2 : 1, ...dimSx }}>
          {/* No metadata means no Status to read, so the button can't claim a state —
              show a combined play/pause glyph (MUI has no such icon). */}
          {!tr && bt.control === 'legacy' ? (
            <Box sx={{ display: 'flex', alignItems: 'center' }}>
              <PlayArrowIcon sx={{ fontSize: big ? 44 : 26, mr: big ? -0.75 : -0.4 }} />
              <PauseIcon sx={{ fontSize: big ? 44 : 26 }} />
            </Box>
          ) : tr && tr.status === 'playing' ? <PauseIcon sx={{ fontSize: big ? 60 : 34 }} /> : <PlayArrowIcon sx={{ fontSize: big ? 60 : 34 }} />}
        </IconButton>
        <IconButton disabled={!btCtlOn} onClick={() => { c.btNext(); markPending('next') }} sx={{ border: '2px solid rgba(255,255,255,0.2)', ...dimSx }}><SkipNextIcon sx={{ fontSize: big ? 46 : 28 }} /></IconButton>
        <IconButton disabled={!btCtlOn} onClick={() => c.btRepeat()} title="Repeat"
          sx={{ color: bt.repeat && bt.repeat !== 'off' ? 'primary.light' : 'text.disabled', ...dimSx }}>
          {bt.repeat === 'singletrack' ? <RepeatOneIcon sx={{ fontSize: big ? 34 : 22 }} /> : <RepeatIcon sx={{ fontSize: big ? 34 : 22 }} />}
        </IconButton>
      </Stack>
      <Stack direction="row" justifyContent="center" alignItems="center" spacing={big ? 3 : 1.5} sx={{ mt: big ? 3 : 1.5 }}>
        <IconButton disabled={!btCtlOn} onClick={() => c.btSeek(-15)} title="Back 15s" sx={{ border: '2px solid rgba(255,255,255,0.2)', ...dimSx }}>
          <Typography sx={{ fontWeight: 800, fontSize: big ? '1.15rem' : '0.8rem', lineHeight: 1 }}>−15</Typography>
        </IconButton>
        <IconButton disabled={!btCtlOn} onClick={() => c.btSeek(30)} title="Forward 30s" sx={{ border: '2px solid rgba(255,255,255,0.2)', ...dimSx }}>
          <Typography sx={{ fontWeight: 800, fontSize: big ? '1.15rem' : '0.8rem', lineHeight: 1 }}>+30</Typography>
        </IconButton>
      </Stack>
    </>
  )
  const btProgress = (
    <Box>
      <LinearProgress variant="determinate" value={loadingNext || !dur ? 0 : Math.min(100, (curPos / dur) * 100)} sx={{ height: big ? 8 : 5, borderRadius: 4 }} />
      <Stack direction="row" justifyContent="space-between" sx={{ mt: 0.5 }}>
        <Typography sx={{ fontSize: big ? '1.4rem' : '1rem', fontWeight: 700, opacity: 0.85, fontVariantNumeric: 'tabular-nums' }}>{loadingNext || !dur ? ' ' : fmtTime(curPos)}</Typography>
        <Typography sx={{ fontSize: big ? '1.4rem' : '1rem', fontWeight: 700, opacity: 0.85, fontVariantNumeric: 'tabular-nums' }}>{loadingNext || !dur ? ' ' : fmtTime(dur)}</Typography>
      </Stack>
    </Box>
  )
  const btControlsPanel = (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}>
      {btDeviceStrip}
      {big && bt.browsable ? (
        // Library on the right: browser fills the column; progress + transport pinned below.
        <>
          <Box sx={{ flex: 1, minHeight: 0, my: 1.5 }}>
            <InlineLibrary c={c} browsable={bt.browsable} deviceKey={bt.connected && bt.connected.mac} />
          </Box>
          <Box sx={{ flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
            {tr ? btProgress : null}
            {btTransport}
          </Box>
        </>
      ) : tr ? (
        <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: big ? 3 : 1.5 }}>
          {btProgress}
          {btTransport}
        </Box>
      ) : (
        <Box sx={{ mt: 4 }}>
          <Typography sx={{ opacity: 0.6, textAlign: 'center', mb: 2, fontSize: big ? '1.3rem' : '1rem' }}>
            {!bt.connected ? 'Tap Devices to connect a phone'
              : bt.control === 'legacy' ? 'Connected \u2014 this phone doesn\u2019t share track info'
              : 'Play something on your phone'}
          </Typography>
          {btTransport}
        </Box>
      )}
    </Box>
  )
  const btDevicesModal = (
    <Dialog open={btDevOpen} onClose={() => setBtDevOpen(false)} maxWidth="sm" fullWidth>
      <Box sx={{ p: 3 }}>
        <Typography variant="h5" sx={{ fontWeight: 800, mb: 2 }}>Bluetooth Devices</Typography>
        {bt.connected ? (
          <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
            <Typography sx={{ fontWeight: 700, fontSize: '1.3rem' }}>{bt.connected.name}</Typography>
            <Typography sx={{ color: 'success.main' }}>
              Connected{bt.connected.battery != null ? ` · Battery ${bt.connected.battery}%` : ''}
            </Typography>
            <Button sx={{ mt: 1 }} onClick={() => c.btDisconnect()}>Disconnect</Button>
          </Paper>
        ) : <Typography sx={{ opacity: 0.6, mb: 2 }}>No phone connected</Typography>}
        <Button variant="contained" size="large" fullWidth startIcon={<BluetoothSearchingIcon />}
          onClick={() => c.btPair()} sx={{ py: 1.5, mb: 2 }}>Pair New Phone</Button>
        {(bt.devices || []).filter((d) => !d.connected).map((d) => (
          <Button key={d.mac} variant="outlined" fullWidth sx={{ justifyContent: 'flex-start', mb: 1, py: 1 }}
            onClick={() => c.btConnect(d.mac)}>{d.name}</Button>
        ))}
        <Stack direction="row" justifyContent="flex-end" sx={{ mt: 2 }}>
          <Button size="large" onClick={() => setBtDevOpen(false)}>Close</Button>
        </Stack>
      </Box>
    </Dialog>
  )
  const leftMain = isFM ? tuner : s.source === 'Bluetooth' ? btNowPlaying : auxMain
  const middlePanel = isFM ? presets : s.source === 'Bluetooth' ? btControlsPanel : (
    <Box sx={{ opacity: 0.5, p: 2 }}>No presets for {s.source}.</Box>
  )
  const deleteDialog = (
    <Dialog open={!!deleteConfirm} onClose={() => setDeleteConfirm(null)} maxWidth="xs" fullWidth
      key={deleteConfirm ? deleteConfirm.i : 'none'}>
      <Box sx={{ p: 3 }}>
        <Typography variant="h6" sx={{ fontWeight: 800, mb: 2, textAlign: 'center' }}>
          {deleteConfirm ? `${deleteConfirm.preset.freq.toFixed(1)} FM` : ''}
        </Typography>
        <TextField fullWidth label="Station name" inputRef={renameRef}
          defaultValue={deleteConfirm ? deleteConfirm.preset.name || '' : ''} sx={{ mb: 3 }}
          placeholder="e.g. Y100" />
        <Stack direction="row" justifyContent="space-between" alignItems="center">
          <Button variant="outlined" color="error" onClick={() => { c.removePreset(deleteConfirm.i); setDeleteConfirm(null) }}>Remove</Button>
          <Stack direction="row" spacing={1.5}>
            <Button onClick={() => setDeleteConfirm(null)}>Cancel</Button>
            <Button variant="contained" onClick={() => { c.renamePreset(deleteConfirm.i, renameRef.current ? renameRef.current.value : ''); setDeleteConfirm(null) }}>Save</Button>
          </Stack>
        </Stack>
      </Box>
    </Dialog>
  )

  if (!big) {
    return (
      <Box sx={{ height: '100%', overflow: 'auto', p: 1.25 }}>
        <Stack spacing={1.25} sx={{ maxWidth: 640, mx: 'auto' }}>
          <Paper sx={{ p: 1.25, opacity: off ? 0.45 : 1, pointerEvents: off ? 'none' : 'auto', transition: '0.2s' }}>
            <Stack spacing={1.5}>{sourceToggle}{leftMain}{middlePanel}</Stack>
          </Paper>
        </Stack>
        {pairWizard}
        {btDevicesModal}
        <BrowseLibraryDialog open={browseOpen} onClose={() => setBrowseOpen(false)} c={c} browsable={bt.browsable} deviceKey={bt.connected && bt.connected.mac} />
        {deleteDialog}
      </Box>
    )
  }

  return (
    <Box sx={{ height: '100%', overflow: 'hidden', p: 2.5 }}>
      <Stack spacing={2} sx={{ maxWidth: '100%', height: '100%' }}>
        <Box sx={{ flex: 1, display: 'grid', gridTemplateColumns: '1.3fr 1fr', gap: 2, minHeight: 0 }}>
          <Paper sx={{ p: 2.5, minHeight: 0, overflow: 'hidden', opacity: off ? 0.5 : 1, pointerEvents: off ? 'none' : 'auto', transition: '0.2s',
            display: 'flex', flexDirection: 'column', justifyContent: 'flex-start', gap: 2 }}>
            {sourceToggle}{leftMain}
            <Box sx={{ flex: 1, minHeight: 0 }}><Visualizer big height="100%" /></Box>
          </Paper>
          <Paper sx={{ p: 2.5, minHeight: 0, opacity: off ? 0.5 : 1, pointerEvents: off ? 'none' : 'auto', transition: '0.2s',
            display: 'flex', flexDirection: 'column' }}>
            <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto', display: 'flex', flexDirection: 'column', justifyContent: 'flex-start' }}>{middlePanel}</Box>
          </Paper>
        </Box>
      </Stack>
      {pairWizard}
      {btDevicesModal}
      <BrowseLibraryDialog open={browseOpen} onClose={() => setBrowseOpen(false)} c={c} browsable={bt.browsable} deviceKey={bt.connected && bt.connected.mac} />
      {deleteDialog}
    </Box>
  )
}

export default memo(StereoView)
