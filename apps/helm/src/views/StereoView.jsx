import { useEffect, useRef, useState } from 'react'
import {
  Box, Stack, Typography, ToggleButton, ToggleButtonGroup, Slider, IconButton,
  Button, Chip, Paper, Dialog, AppBar, Toolbar, Switch, FormControlLabel, Divider, LinearProgress,
} from '@mui/material'
import PlayArrowIcon from '@mui/icons-material/PlayArrow'
import PauseIcon from '@mui/icons-material/Pause'
import SkipNextIcon from '@mui/icons-material/SkipNext'
import SkipPreviousIcon from '@mui/icons-material/SkipPrevious'
import PowerSettingsNewIcon from '@mui/icons-material/PowerSettingsNew'
import VolumeUpIcon from '@mui/icons-material/VolumeUp'
import VolumeOffIcon from '@mui/icons-material/VolumeOff'
import FastRewindIcon from '@mui/icons-material/FastRewind'
import FastForwardIcon from '@mui/icons-material/FastForward'
import BookmarkAddIcon from '@mui/icons-material/BookmarkAdd'
import SaveIcon from '@mui/icons-material/Save'
import SettingsIcon from '@mui/icons-material/Settings'
import ArrowBackIcon from '@mui/icons-material/ArrowBack'
import AddIcon from '@mui/icons-material/Add'
import RemoveIcon from '@mui/icons-material/Remove'
import BluetoothIcon from '@mui/icons-material/Bluetooth'
import BluetoothSearchingIcon from '@mui/icons-material/BluetoothSearching'
import BatteryFullIcon from '@mui/icons-material/BatteryFull'
import Battery60Icon from '@mui/icons-material/Battery60'
import Battery20Icon from '@mui/icons-material/Battery20'
import BatteryAlertIcon from '@mui/icons-material/BatteryAlert'
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
    <Box ref={wrapRef} onClick={cycle} sx={{ position: 'relative', width: '100%', height: big ? 118 : 44, cursor: 'pointer' }}>
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

function SettingsDialog({ open, onClose, settings, onChange }) {
  const st = settings || {}
  const auto = st.gain < 0
  // Local slider state so dragging stays smooth; only commit (which restarts the
  // tuner) when the finger lifts, via onChangeCommitted.
  const [gain, setGain] = useState(st.gain)
  const [squelch, setSquelch] = useState(st.squelch || 0)
  useEffect(() => { setGain(st.gain) }, [st.gain])
  useEffect(() => { setSquelch(st.squelch || 0) }, [st.squelch])
  const faderSx = { py: 2, '& .MuiSlider-thumb': { width: 34, height: 34 }, '& .MuiSlider-rail, & .MuiSlider-track': { height: 12, borderRadius: 8 } }
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
          <Typography sx={{ opacity: 0.5, fontSize: '0.85rem' }}>Changes apply on the fly to the running station.</Typography>
        </Stack>
      </Box>
    </Dialog>
  )
}

export default function StereoView({ big = false }) {
  const [s, setS] = useState(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [btDevOpen, setBtDevOpen] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState(null) // { i, preset } pending removal
  const ctl = useRef(null)
  const posRef = useRef({ pos: 0, at: 0, key: '' })
  const [, setTick] = useState(0)
  useEffect(() => {
    ctl.current = createRadioClient(setS)
    const t = setInterval(() => setTick((x) => x + 1), 1000) // ticks the progress bar between polls
    return () => { ctl.current && ctl.current.stop && ctl.current.stop(); clearInterval(t) }
  }, [])
  if (!s) return null

  const c = ctl.current
  const off = !s.power

  const header = (
    <Stack direction="row" alignItems="center" spacing={big ? 1.5 : 1}>
      <Typography variant={big ? 'h4' : 'h6'} sx={{ fontWeight: 800, flex: 1 }}>Stereo</Typography>
      <Chip size={big ? 'medium' : 'small'} color={s.connected ? 'success' : 'warning'}
        label={s.connected ? 'RTL-SDR' : 'no service'} />
      <IconButton size={big ? 'large' : 'small'} onClick={() => c.toggleMute()} title="Mute"
        sx={{ border: '2px solid', borderColor: s.muted ? 'error.main' : 'rgba(255,255,255,0.25)', borderRadius: 2,
          color: s.muted ? 'error.main' : 'inherit' }}>
        {s.muted ? <VolumeOffIcon fontSize={big ? 'medium' : 'small'} /> : <VolumeUpIcon fontSize={big ? 'medium' : 'small'} />}
      </IconButton>
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
    <Box>
      <Typography sx={{ fontSize: big ? '0.9rem' : '0.68rem', opacity: 0.5, fontWeight: 700, letterSpacing: 1.5, mb: 0.75 }}>SOURCE</Typography>
      <ToggleButtonGroup exclusive fullWidth size={big ? 'large' : 'small'} value={s.source}
        onChange={(_, v) => v && c.setSource(v)}>
        {SOURCES.map((src) => <ToggleButton key={src} value={src} sx={{ py: big ? 1.4 : 0.75, fontSize: big ? '1.15rem' : undefined }}>{src}</ToggleButton>)}
      </ToggleButtonGroup>
    </Box>
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
      {/* RDS station info decoded over the air — station name (1 line) + full message (wraps) */}
      <Box sx={{ textAlign: 'center', minHeight: big ? 74 : 30, mt: big ? 0.5 : 0.25,
        display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: big ? 0.5 : 0.25 }}>
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

  const dialog = <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)}
    settings={s.settings} onChange={(patch) => c.setSettings(patch)} />

  // ---- source-aware content (FM tuner+presets, Bluetooth device mgmt, Aux) ----
  const isFM = s.source === 'FM'
  const bt = s.bluetooth || {}
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
  const btNowPlaying = (
    <Box sx={{ textAlign: 'center' }}>
      {bt.track ? (
        <Stack direction="row" spacing={big ? 3 : 1.5} alignItems="center"
          sx={{ bgcolor: 'rgba(57,160,255,0.12)', border: '1px solid rgba(57,160,255,0.4)', borderRadius: 2, p: big ? 2.5 : 1.5 }}>
          {bt.track.artKey && (
            <Box component="img" src={`${SVC}/api/art?k=${encodeURIComponent(bt.track.artKey)}`} alt=""
              sx={{ width: big ? 150 : 60, height: big ? 150 : 60, borderRadius: 1.5, flexShrink: 0, objectFit: 'cover' }} />
          )}
          <Box sx={{ minWidth: 0, flex: 1, textAlign: bt.track.artUrl ? 'left' : 'center' }}>
            <Typography noWrap sx={{ fontWeight: 800, color: '#fff', lineHeight: 1.1, fontSize: big ? '2.4rem' : '1.3rem' }}>
              {bt.track.title || '—'}
            </Typography>
            {bt.track.artist && (
              <Typography noWrap sx={{ color: 'primary.light', fontWeight: 700, mt: 0.5, fontSize: big ? '1.6rem' : '1rem' }}>
                {bt.track.artist}
              </Typography>
            )}
            {bt.track.album && (
              <Typography noWrap sx={{ opacity: 0.7, fontSize: big ? '1.2rem' : '0.85rem', mt: 0.25 }}>{bt.track.album}</Typography>
            )}
          </Box>
        </Stack>
      ) : (
        <Typography sx={{ opacity: 0.6, fontSize: big ? '1.5rem' : '1rem', py: big ? 4 : 2 }}>
          {bt.connected ? 'Play something on your phone' : 'Tap "Pair New Phone"'}
        </Typography>
      )}
    </Box>
  )
  const auxMain = (
    <Box sx={{ textAlign: 'center', py: big ? 6 : 2 }}>
      <Typography sx={{ fontWeight: 800, fontSize: big ? '2.4rem' : '1.2rem' }}>Aux Input</Typography>
      <Typography sx={{ opacity: 0.7 }}>Line in via the 3.5mm jack</Typography>
    </Box>
  )
  // Compact current-device + battery strip; full device list/pairing lives in a modal.
  const batLvl = bt.connected ? bt.connected.battery : null
  const batIcon = (() => {
    if (batLvl == null) return null
    const isx = { transform: 'rotate(90deg)', fontSize: big ? 28 : 20, color: batLvl <= 15 ? 'error.main' : batLvl <= 30 ? 'warning.main' : 'success.main' }
    if (batLvl <= 15) return <BatteryAlertIcon sx={isx} />
    if (batLvl <= 40) return <Battery20Icon sx={isx} />
    if (batLvl <= 75) return <Battery60Icon sx={isx} />
    return <BatteryFullIcon sx={isx} />
  })()
  const btDeviceStrip = (
    <Stack direction="row" alignItems="center" spacing={big ? 1.25 : 0.75} sx={{ mb: big ? 2 : 1 }}>
      <BluetoothIcon sx={{ color: bt.connected ? 'primary.light' : 'text.disabled' }} />
      {batLvl != null && (
        <Stack direction="row" alignItems="center" spacing={0.25} sx={{ mr: 0.5 }}>
          {batIcon}
          <Typography sx={{ fontSize: big ? '1rem' : '0.8rem', fontWeight: 600 }}>{batLvl}%</Typography>
        </Stack>
      )}
      <Box sx={{ flex: 1, minWidth: 0 }}>
        <Typography noWrap sx={{ fontWeight: 700, fontSize: big ? '1.3rem' : '1rem' }}>
          {bt.connected ? bt.connected.name : ((bt.devices || [])[0]?.name || 'No device')}
        </Typography>
        <Typography sx={{ fontSize: big ? '1rem' : '0.8rem', opacity: 0.7 }}>
          {bt.connected ? 'Connected' : 'Not connected'}
        </Typography>
      </Box>
      <Button variant="outlined" size={big ? 'medium' : 'small'} startIcon={<BluetoothSearchingIcon />} onClick={() => setBtDevOpen(true)}>Devices</Button>
    </Stack>
  )
  const btControlsPanel = (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      {btDeviceStrip}
      {tr ? (
        <Box sx={{ flex: 1, display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: big ? 3 : 1.5 }}>
          {dur > 0 && (
            <Box>
              <LinearProgress variant="determinate" value={Math.min(100, (curPos / dur) * 100)} sx={{ height: big ? 8 : 5, borderRadius: 4 }} />
              <Stack direction="row" justifyContent="space-between" sx={{ mt: 0.5 }}>
                <Typography sx={{ fontSize: big ? '1.1rem' : '0.8rem', opacity: 0.75, fontVariantNumeric: 'tabular-nums' }}>{fmtTime(curPos)}</Typography>
                <Typography sx={{ fontSize: big ? '1.1rem' : '0.8rem', opacity: 0.75, fontVariantNumeric: 'tabular-nums' }}>{fmtTime(dur)}</Typography>
              </Stack>
            </Box>
          )}
          <Stack direction="row" justifyContent="center" alignItems="center" spacing={big ? 4 : 2}>
            <IconButton onClick={() => c.btPrev()} sx={{ border: '2px solid rgba(255,255,255,0.2)' }}><SkipPreviousIcon sx={{ fontSize: big ? 46 : 28 }} /></IconButton>
            <IconButton onClick={() => c.btPlayPause()} sx={{ border: '2px solid', borderColor: 'primary.main', bgcolor: 'rgba(57,160,255,0.15)', p: big ? 2 : 1 }}>
              {tr.status === 'playing' ? <PauseIcon sx={{ fontSize: big ? 60 : 34 }} /> : <PlayArrowIcon sx={{ fontSize: big ? 60 : 34 }} />}
            </IconButton>
            <IconButton onClick={() => c.btNext()} sx={{ border: '2px solid rgba(255,255,255,0.2)' }}><SkipNextIcon sx={{ fontSize: big ? 46 : 28 }} /></IconButton>
          </Stack>
        </Box>
      ) : (
        <Typography sx={{ opacity: 0.6, textAlign: 'center', mt: 4, fontSize: big ? '1.3rem' : '1rem' }}>
          {bt.connected ? 'Play something on your phone' : 'Tap Devices to connect a phone'}
        </Typography>
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
    <Dialog open={!!deleteConfirm} onClose={() => setDeleteConfirm(null)} maxWidth="xs" fullWidth>
      <Box sx={{ p: 3, textAlign: 'center' }}>
        <Typography variant="h6" sx={{ fontWeight: 800, mb: 1 }}>Remove preset?</Typography>
        <Typography sx={{ mb: 3, opacity: 0.85, fontSize: '1.3rem' }}>
          {deleteConfirm ? `${deleteConfirm.preset.freq.toFixed(1)}${deleteConfirm.preset.name ? ' · ' + deleteConfirm.preset.name : ''}` : ''}
        </Typography>
        <Stack direction="row" spacing={2} justifyContent="center">
          <Button size="large" variant="outlined" onClick={() => setDeleteConfirm(null)} sx={{ px: 4, py: 1.5 }}>Cancel</Button>
          <Button size="large" variant="contained" color="error" sx={{ px: 4, py: 1.5 }}
            onClick={() => { c.removePreset(deleteConfirm.i); setDeleteConfirm(null) }}>Remove</Button>
        </Stack>
      </Box>
    </Dialog>
  )

  if (!big) {
    return (
      <Box sx={{ height: '100%', overflow: 'auto', p: 1.25 }}>
        <Stack spacing={1.25} sx={{ maxWidth: 640, mx: 'auto' }}>
          {header}
          <Paper sx={{ p: 1.25, opacity: off ? 0.45 : 1, pointerEvents: off ? 'none' : 'auto', transition: '0.2s' }}>
            <Stack spacing={1.5}>{sourceToggle}{leftMain}{middlePanel}{volume}</Stack>
          </Paper>
        </Stack>
        {dialog}
        {btDevicesModal}
        {deleteDialog}
      </Box>
    )
  }

  return (
    <Box sx={{ height: '100%', overflow: 'hidden', p: 2.5 }}>
      <Stack spacing={2} sx={{ maxWidth: '100%', height: '100%' }}>
        {header}
        <Box sx={{ flex: 1, display: 'grid', gridTemplateColumns: '1.3fr 1fr 128px', gap: 2, minHeight: 0 }}>
          <Paper sx={{ p: 2.5, minHeight: 0, overflow: 'hidden', opacity: off ? 0.5 : 1, pointerEvents: off ? 'none' : 'auto', transition: '0.2s',
            display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 2 }}>
            {sourceToggle}{leftMain}<Visualizer big />
          </Paper>
          <Paper sx={{ p: 2.5, minHeight: 0, opacity: off ? 0.5 : 1, pointerEvents: off ? 'none' : 'auto', transition: '0.2s',
            display: 'flex', flexDirection: 'column' }}>
            <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>{middlePanel}</Box>
          </Paper>
          <Paper sx={{ p: 1.5, minHeight: 0, opacity: off ? 0.5 : 1, pointerEvents: off ? 'none' : 'auto', transition: '0.2s',
            display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
            {volumeVertical}
          </Paper>
        </Box>
      </Stack>
      {dialog}
      {btDevicesModal}
      {deleteDialog}
    </Box>
  )
}
