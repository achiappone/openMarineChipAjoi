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

// Live audio-spectrum bars, fed by the service's FFT of the demodulated audio.
function Visualizer({ big }) {
  const [spec, setSpec] = useState([])
  useEffect(() => {
    let es
    try {
      es = new EventSource(`${SVC}/api/spectrum`)
      es.onmessage = (e) => { try { setSpec(JSON.parse(e.data)) } catch (err) {} }
    } catch (err) {}
    return () => es && es.close()
  }, [])
  const data = spec.length ? spec : new Array(32).fill(0)
  return (
    <Box sx={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
      gap: big ? '4px' : '2px', height: big ? 150 : 44, width: '100%' }}>
      {data.map((v, i) => (
        <Box key={i} sx={{ flex: 1, maxWidth: big ? 16 : 7, height: `${Math.max(2, v * 100)}%`,
          borderRadius: '3px 3px 0 0', background: 'linear-gradient(to top,#1f6feb,#3ddc84)',
          transition: 'height 70ms linear' }} />
      ))}
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
        {s.muted ? <VolumeOffIcon sx={{ fontSize: big ? 36 : 24 }} /> : <VolumeUpIcon sx={{ fontSize: big ? 36 : 24 }} />}
      </IconButton>
      <Slider value={s.muted ? 0 : s.volume} min={0} max={VOL_MAX} onChange={(_, v) => c.setVolume(v)} valueLabelDisplay="auto" sx={{ flex: 1 }} />
      <Typography sx={{ width: big ? 48 : 30, textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontSize: big ? '1.5rem' : undefined }}>
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
