import { useEffect, useRef, useState } from 'react'
import {
  Box, Stack, Typography, ToggleButton, ToggleButtonGroup, Slider, IconButton,
  Button, Chip, Paper, Dialog, AppBar, Toolbar, Switch, FormControlLabel, Divider,
} from '@mui/material'
import PowerSettingsNewIcon from '@mui/icons-material/PowerSettingsNew'
import VolumeUpIcon from '@mui/icons-material/VolumeUp'
import VolumeOffIcon from '@mui/icons-material/VolumeOff'
import FastRewindIcon from '@mui/icons-material/FastRewind'
import FastForwardIcon from '@mui/icons-material/FastForward'
import BookmarkAddIcon from '@mui/icons-material/BookmarkAdd'
import SettingsIcon from '@mui/icons-material/Settings'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import AddIcon from '@mui/icons-material/Add'
import RemoveIcon from '@mui/icons-material/Remove'
import { SOURCES, FM_MIN, FM_MAX, VOL_MAX } from '../stereo/stereoControl'
import { createRadioClient } from '../stereo/stereoClient'

const SVC = `http://${location.hostname}:8082`

// ---- Visualizations: 10 canvas modes driven by the live audio spectrum ----
const VIS_MODES = ['Bars', 'Mirror', 'Tunnel', 'Wave', 'Radial', 'LED Blocks', 'Area', 'Dots', 'Ripple', 'Peak Bars']

function mixColor(t) { // blue #1f6feb -> green #3ddc84
  const a = [31, 111, 235], b = [61, 220, 132]
  return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * t)).join(',')})`
}

function drawVis(mode, ctx, W, H, spec, peaks, t) {
  const n = spec.length || 32
  let avg = 0; for (let i = 0; i < n; i++) avg += spec[i] || 0; avg /= n || 1
  const bw = W / n
  switch (mode) {
    case 0: for (let i = 0; i < n; i++) { const bh = Math.max(2, (spec[i] || 0) * H); ctx.fillStyle = mixColor(i / n); ctx.fillRect(i * bw + bw * 0.15, H - bh, bw * 0.7, bh) } break
    case 1: for (let i = 0; i < n; i++) { const bh = Math.max(1, (spec[i] || 0) * H * 0.5); ctx.fillStyle = mixColor(i / n); ctx.fillRect(i * bw + bw * 0.15, H / 2 - bh, bw * 0.7, bh * 2) } break
    case 2: { const cx = W / 2, cy = H / 2, mr = Math.min(W, H) / 2; ctx.lineWidth = 2; for (let i = n - 1; i >= 0; i--) { const v = spec[i] || 0; const r = (((i / n) * mr + v * mr * 0.35 + (t % 40) / 40 * (mr / n))) % mr; ctx.strokeStyle = mixColor(1 - i / n); ctx.globalAlpha = 0.25 + v * 0.75; ctx.beginPath(); ctx.arc(cx, cy, r, 0, 6.2832); ctx.stroke() } ctx.globalAlpha = 1; break }
    case 3: { ctx.beginPath(); for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * W, y = H - (spec[i] || 0) * H; i ? ctx.lineTo(x, y) : ctx.moveTo(x, y) } ctx.strokeStyle = mixColor(0.5); ctx.lineWidth = 3; ctx.stroke(); break }
    case 4: { const cx = W / 2, cy = H / 2, r0 = Math.min(W, H) * 0.13, ml = Math.min(W, H) * 0.35; ctx.lineWidth = 3; for (let i = 0; i < n; i++) { const a = (i / n) * 6.2832 - 1.5708, v = spec[i] || 0; ctx.strokeStyle = mixColor(i / n); ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); ctx.lineTo(cx + Math.cos(a) * (r0 + v * ml), cy + Math.sin(a) * (r0 + v * ml)); ctx.stroke() } break }
    case 5: { const seg = 10, gap = 2, sh = (H - seg * gap) / seg; for (let i = 0; i < n; i++) { const lit = Math.round((spec[i] || 0) * seg); for (let s = 0; s < lit; s++) { ctx.fillStyle = mixColor(s / seg); ctx.fillRect(i * bw + bw * 0.15, H - (s + 1) * (sh + gap), bw * 0.7, sh) } } break }
    case 6: { ctx.beginPath(); ctx.moveTo(0, H); for (let i = 0; i < n; i++) ctx.lineTo((i / (n - 1)) * W, H - (spec[i] || 0) * H); ctx.lineTo(W, H); ctx.closePath(); const g = ctx.createLinearGradient(0, H, 0, 0); g.addColorStop(0, 'rgba(31,111,235,0.25)'); g.addColorStop(1, 'rgba(61,220,132,0.9)'); ctx.fillStyle = g; ctx.fill(); break }
    case 7: for (let i = 0; i < n; i++) { const v = spec[i] || 0; ctx.fillStyle = mixColor(i / n); ctx.beginPath(); ctx.arc(i * bw + bw / 2, H - v * H, 4, 0, 6.2832); ctx.fill() } break
    case 8: { const cx = W / 2, cy = H / 2, mr = Math.min(W, H) / 2; ctx.lineWidth = 3; for (let k = 0; k < 6; k++) { const ph = ((t + k * 10) % 60) / 60; ctx.strokeStyle = mixColor(k / 6); ctx.globalAlpha = (1 - ph) * (0.25 + avg); ctx.beginPath(); ctx.arc(cx, cy, ph * mr * (0.5 + avg * 1.2), 0, 6.2832); ctx.stroke() } ctx.globalAlpha = 1; break }
    case 9: for (let i = 0; i < n; i++) { const bh = Math.max(2, (spec[i] || 0) * H); ctx.fillStyle = mixColor(i / n); ctx.globalAlpha = 0.85; ctx.fillRect(i * bw + bw * 0.15, H - bh, bw * 0.7, bh); ctx.globalAlpha = 1; ctx.fillStyle = '#fff'; ctx.fillRect(i * bw + bw * 0.15, H - (peaks[i] || 0) * H, bw * 0.7, 2) } break
    default: break
  }
}

// Live audio-spectrum canvas. Tap to cycle through 10 visualizations (persisted).
function Visualizer({ big }) {
  const wrapRef = useRef(null), canvasRef = useRef(null)
  const specRef = useRef(new Array(32).fill(0))
  const peaksRef = useRef(new Array(32).fill(0))
  const [mode, setMode] = useState(() => (Number(localStorage.getItem('helm.vis') || 0) || 0) % VIS_MODES.length)
  const [flash, setFlash] = useState('')

  useEffect(() => {
    let es
    try { es = new EventSource(`${SVC}/api/spectrum`); es.onmessage = (e) => { try { specRef.current = JSON.parse(e.data) } catch (x) {} } } catch (x) {}
    return () => es && es.close()
  }, [])

  useEffect(() => {
    let raf, t = 0
    const loop = () => {
      const cv = canvasRef.current, wrap = wrapRef.current
      if (cv && wrap && wrap.clientWidth) {
        const dpr = window.devicePixelRatio || 1
        const W = wrap.clientWidth, H = wrap.clientHeight
        if (cv.width !== Math.round(W * dpr)) cv.width = Math.round(W * dpr)
        if (cv.height !== Math.round(H * dpr)) cv.height = Math.round(H * dpr)
        const ctx = cv.getContext('2d')
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
        ctx.clearRect(0, 0, W, H)
        const spec = specRef.current, peaks = peaksRef.current
        for (let i = 0; i < spec.length; i++) peaks[i] = Math.max(spec[i] || 0, (peaks[i] || 0) - 0.012)
        drawVis(mode, ctx, W, H, spec, peaks, t)
        t++
      }
      raf = requestAnimationFrame(loop)
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
    <Box ref={wrapRef} onClick={cycle} sx={{ position: 'relative', width: '100%', height: big ? 170 : 44, cursor: 'pointer' }}>
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
      {big && (
        <Typography sx={{ position: 'absolute', top: 4, right: 10, fontSize: '0.8rem',
          opacity: flash ? 0.95 : 0.35, transition: 'opacity .3s', pointerEvents: 'none' }}>
          {flash || `${VIS_MODES[mode]} · tap to change`}
        </Typography>
      )}
    </Box>
  )
}

// Card-style preset: tap to tune, long-press (650ms) to remove.
function PresetCard({ freq, active, onSelect, onDelete, big }) {
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
        px: big ? 3 : 1.25, py: big ? 1.75 : 0.6, minWidth: big ? 150 : 66,
        '&:hover': { borderColor: 'primary.main' },
      }}>
      <Typography sx={{ fontWeight: 800, lineHeight: 1, fontSize: big ? '2rem' : '0.95rem' }}>{freq.toFixed(1)}</Typography>
      {big && <Typography sx={{ fontSize: '0.72rem', opacity: 0.65, mt: 0.3 }}>FM</Typography>}
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

function SettingsDialog({ open, onClose, settings, onChange }) {
  const st = settings || {}
  const auto = st.gain < 0
  return (
    <Dialog fullScreen open={open} onClose={onClose}>
      <AppBar sx={{ position: 'relative', bgcolor: 'background.paper' }} elevation={0}>
        <Toolbar>
          <IconButton edge="start" color="inherit" onClick={onClose}><ArrowBackIcon /></IconButton>
          <Typography variant="h6" sx={{ ml: 1, fontWeight: 700 }}>FM Tuner Settings</Typography>
        </Toolbar>
      </AppBar>
      <Box sx={{ p: 4, maxWidth: 720, mx: 'auto', width: '100%' }}>
        <Stack spacing={3.5}>
          <Box>
            <Stack direction="row" alignItems="center">
              <Typography sx={{ flex: 1, fontWeight: 700 }}>Tuner gain</Typography>
              <FormControlLabel
                control={<Switch checked={auto} onChange={(e) => onChange({ gain: e.target.checked ? -1 : 30 })} />}
                label="Auto" />
            </Stack>
            <Slider disabled={auto} value={auto ? 49.6 : st.gain} min={0} max={49.6} step={0.1}
              onChange={(_, v) => onChange({ gain: v })} valueLabelDisplay="auto" />
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
            <Slider value={st.squelch || 0} min={0} max={80} step={1}
              onChange={(_, v) => onChange({ squelch: v })} valueLabelDisplay="auto" />
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
          <Typography sx={{ opacity: 0.5, fontSize: '0.85rem' }}>Changes apply on the fly to the running station.</Typography>
        </Stack>
      </Box>
    </Dialog>
  )
}

export default function StereoView({ big = false }) {
  const [s, setS] = useState(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const ctl = useRef(null)
  useEffect(() => {
    ctl.current = createRadioClient(setS)
    return () => ctl.current && ctl.current.stop && ctl.current.stop()
  }, [])
  if (!s) return null

  const c = ctl.current
  const off = !s.power

  const header = (
    <Stack direction="row" alignItems="center" spacing={big ? 1.5 : 1}>
      <Typography variant={big ? 'h4' : 'h6'} sx={{ fontWeight: 800, flex: 1 }}>Stereo</Typography>
      <Chip size={big ? 'medium' : 'small'} color={s.connected ? 'success' : 'warning'}
        label={s.connected ? 'RTL-SDR' : 'no service'} />
      <IconButton size={big ? 'large' : 'small'} onClick={() => setSettingsOpen(true)} title="FM tuner settings">
        <SettingsIcon fontSize={big ? 'medium' : 'small'} />
      </IconButton>
      <ToggleButton value="power" selected={s.power} onChange={() => c.setPower(!s.power)}
        color="success" size={big ? 'large' : 'small'} sx={{ px: big ? 2.5 : 1.5 }}>
        <PowerSettingsNewIcon fontSize={big ? 'medium' : 'small'} sx={{ mr: 0.75 }} /> {s.power ? 'On' : 'Off'}
      </ToggleButton>
    </Stack>
  )

  const sourceToggle = (
    <ToggleButtonGroup exclusive fullWidth size={big ? 'large' : 'small'} value={s.source}
      onChange={(_, v) => v && c.setSource(v)}>
      {SOURCES.map((src) => <ToggleButton key={src} value={src} sx={{ py: big ? 1.4 : 0.75, fontSize: big ? '1.15rem' : undefined }}>{src}</ToggleButton>)}
    </ToggleButtonGroup>
  )

  const tuner = s.source === 'FM' ? (
    <Box>
      <Stack direction="row" alignItems="center" justifyContent="center" spacing={big ? 3 : 1.25}>
        <NavCard onClick={() => c.seek(-1)} big><FastRewindIcon sx={{ fontSize: big ? 44 : 22 }} /></NavCard>
        <Typography sx={{ fontWeight: 800, lineHeight: 1, fontVariantNumeric: 'tabular-nums',
          fontSize: big ? '6rem' : '2.4rem', minWidth: big ? 340 : 150, textAlign: 'center' }}>
          {s.fm.freq.toFixed(1)}
          <Typography component="span" sx={{ ml: 1, opacity: 0.55, fontSize: big ? '1.8rem' : '1rem' }}>FM</Typography>
        </Typography>
        <NavCard onClick={() => c.seek(1)} big><FastForwardIcon sx={{ fontSize: big ? 44 : 22 }} /></NavCard>
      </Stack>
      <Slider size={big ? 'medium' : 'small'} value={s.fm.freq} min={FM_MIN} max={FM_MAX} step={0.1}
        onChange={(_, v) => c.tune(v)} valueLabelDisplay="auto" sx={{ mt: big ? 1.5 : 0 }} />
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
        <Button size={big ? 'large' : 'small'} startIcon={<BookmarkAddIcon />} variant="outlined"
          onClick={() => c.savePreset(s.fm.freq)}>Save {s.fm.freq.toFixed(1)}</Button>
      </Stack>
      <Stack direction="row" spacing={big ? 1.5 : 0.75} justifyContent={big ? 'flex-start' : 'center'} flexWrap="wrap" useFlexGap>
        {s.fm.presets.map((p, i) => (
          <PresetCard key={`${p}-${i}`} freq={p} big={big} active={Math.abs(p - s.fm.freq) < 0.05}
            onSelect={() => c.selectPreset(i)} onDelete={() => c.removePreset(i)} />
        ))}
        {s.fm.presets.length === 0 && <Typography sx={{ opacity: 0.5 }}>No presets — tune a station and tap Save</Typography>}
      </Stack>
      {big && <Typography sx={{ mt: 1.5, opacity: 0.4, fontSize: '0.85rem' }}>Long-press a preset card to remove it</Typography>}
    </Box>
  )

  const volume = (
    <Stack direction="row" alignItems="center" spacing={big ? 2.5 : 1.5}>
      <IconButton size={big ? 'large' : 'small'} onClick={() => c.toggleMute()}>
        {s.muted ? <VolumeOffIcon sx={{ fontSize: big ? 40 : 24 }} /> : <VolumeUpIcon sx={{ fontSize: big ? 40 : 24 }} />}
      </IconButton>
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
      <Typography sx={{ width: big ? 56 : 30, textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontSize: big ? '1.7rem' : undefined, fontWeight: big ? 700 : 400 }}>
        {s.muted ? 'M' : s.volume}
      </Typography>
    </Stack>
  )

  const dialog = <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)}
    settings={s.settings} onChange={(patch) => c.setSettings(patch)} />

  if (!big) {
    return (
      <Box sx={{ height: '100%', overflow: 'auto', p: 1.25 }}>
        <Stack spacing={1.25} sx={{ maxWidth: 640, mx: 'auto' }}>
          {header}
          <Paper sx={{ p: 1.25, opacity: off ? 0.45 : 1, pointerEvents: off ? 'none' : 'auto', transition: '0.2s' }}>
            <Stack spacing={1.5}>{sourceToggle}{tuner}{presets}{volume}</Stack>
          </Paper>
        </Stack>
        {dialog}
      </Box>
    )
  }

  return (
    <Box sx={{ height: '100%', overflow: 'auto', p: 3 }}>
      <Stack spacing={2.5} sx={{ maxWidth: 1500, mx: 'auto', height: '100%' }}>
        {header}
        <Box sx={{ flex: 1, display: 'grid', gridTemplateColumns: '1.15fr 1fr', gap: 3, minHeight: 0 }}>
          <Paper sx={{ p: 3, opacity: off ? 0.5 : 1, pointerEvents: off ? 'none' : 'auto', transition: '0.2s',
            display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 3 }}>
            {sourceToggle}{tuner}<Visualizer big />
          </Paper>
          <Paper sx={{ p: 3, opacity: off ? 0.5 : 1, pointerEvents: off ? 'none' : 'auto', transition: '0.2s',
            display: 'flex', flexDirection: 'column', gap: 3 }}>
            <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>{presets}</Box>
            {volume}
          </Paper>
        </Box>
      </Stack>
      {dialog}
    </Box>
  )
}
