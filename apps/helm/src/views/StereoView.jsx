import { useEffect, useRef, useState } from 'react'
import {
  Box, Stack, Typography, ToggleButton, ToggleButtonGroup, Slider, IconButton,
  Button, Chip, Paper,
} from '@mui/material'
import PowerSettingsNewIcon from '@mui/icons-material/PowerSettingsNew'
import VolumeUpIcon from '@mui/icons-material/VolumeUp'
import VolumeOffIcon from '@mui/icons-material/VolumeOff'
import FastRewindIcon from '@mui/icons-material/FastRewind'
import FastForwardIcon from '@mui/icons-material/FastForward'
import BookmarkAddIcon from '@mui/icons-material/BookmarkAdd'
import { SOURCES, FM_MIN, FM_MAX, VOL_MAX } from '../stereo/stereoControl'
import { createRadioClient } from '../stereo/stereoClient'

// Animated equalizer bars. Decorative (not yet audio-reactive); amplitude scales
// with volume and it only animates while playing.
function Visualizer({ active, volume, big }) {
  const bars = big ? 44 : 22
  const amp = 0.3 + 0.7 * (volume / VOL_MAX)
  return (
    <Box
      style={{ '--amp': active ? amp : 0.1 }}
      sx={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'center',
        gap: big ? '4px' : '2px', height: big ? 130 : 42, width: '100%' }}
    >
      {Array.from({ length: bars }).map((_, i) => (
        <Box key={i} sx={{
          width: big ? 9 : 5, height: '100%', borderRadius: '3px 3px 0 0',
          background: 'linear-gradient(to top, #1f6feb, #3ddc84)',
          transformOrigin: 'bottom',
          transform: active ? undefined : 'scaleY(0.08)',
          opacity: active ? 0.85 : 0.18,
          animation: active ? `eq ${560 + (i % 9) * 70}ms ease-in-out ${(i % 6) * 60}ms infinite alternate` : 'none',
          transition: 'opacity .3s',
        }} />
      ))}
    </Box>
  )
}

// Preset chip: tap to tune, long-press (650ms) to remove.
function PresetButton({ freq, active, onSelect, onDelete, big }) {
  const t = useRef(null)
  const held = useRef(false)
  const start = () => { held.current = false; t.current = setTimeout(() => { held.current = true; onDelete() }, 650) }
  const end = () => { if (t.current) { clearTimeout(t.current); t.current = null; if (!held.current) onSelect() } }
  const cancel = () => { if (t.current) { clearTimeout(t.current); t.current = null } }
  return (
    <Button
      variant={active ? 'contained' : 'outlined'}
      onMouseDown={start} onMouseUp={end} onMouseLeave={cancel}
      onTouchStart={start} onTouchEnd={(e) => { e.preventDefault(); end() }}
      sx={{ minWidth: big ? 104 : 62, fontSize: big ? '1.4rem' : '0.82rem',
        py: big ? 1.1 : 0.25, fontWeight: 700 }}
    >
      {freq.toFixed(1)}
    </Button>
  )
}

export default function StereoView({ big = false }) {
  const [s, setS] = useState(null)
  const ctl = useRef(null)
  useEffect(() => {
    ctl.current = createRadioClient(setS)
    return () => ctl.current && ctl.current.stop && ctl.current.stop()
  }, [])
  if (!s) return null

  const c = ctl.current
  const off = !s.power
  const active = s.power && !s.muted && s.source === 'FM'

  // --- reusable control blocks (sized by `big`) ---
  const header = (
    <Stack direction="row" alignItems="center" spacing={big ? 2 : 1}>
      <Typography variant={big ? 'h4' : 'h6'} sx={{ fontWeight: 800, flex: 1 }}>Stereo</Typography>
      <Chip size={big ? 'medium' : 'small'} color={s.connected ? 'success' : 'warning'}
        label={s.connected ? 'RTL-SDR' : 'no service'} />
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
      <Stack direction="row" alignItems="center" justifyContent="center" spacing={big ? 3 : 1.5}>
        <IconButton size={big ? 'large' : 'medium'} onClick={() => c.seek(-1)}>
          <FastRewindIcon sx={{ fontSize: big ? 46 : 24 }} />
        </IconButton>
        <Typography sx={{ fontWeight: 800, lineHeight: 1, fontVariantNumeric: 'tabular-nums',
          fontSize: big ? '6rem' : '2.4rem', minWidth: big ? 340 : 150, textAlign: 'center' }}>
          {s.fm.freq.toFixed(1)}
          <Typography component="span" sx={{ ml: 1, opacity: 0.55, fontSize: big ? '1.8rem' : '1rem' }}>FM</Typography>
        </Typography>
        <IconButton size={big ? 'large' : 'medium'} onClick={() => c.seek(1)}>
          <FastForwardIcon sx={{ fontSize: big ? 46 : 24 }} />
        </IconButton>
      </Stack>
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
      <Stack direction="row" alignItems="center" sx={{ mb: 1 }}>
        <Typography sx={{ flex: 1, fontWeight: 700, opacity: 0.8, fontSize: big ? '1.15rem' : '0.9rem' }}>
          Presets
        </Typography>
        <Button size={big ? 'medium' : 'small'} startIcon={<BookmarkAddIcon />} variant="outlined"
          onClick={() => c.savePreset(s.fm.freq)} sx={{ fontSize: big ? '1rem' : '0.75rem' }}>
          Save {s.fm.freq.toFixed(1)}
        </Button>
      </Stack>
      <Stack direction="row" spacing={big ? 1.25 : 0.75} justifyContent={big ? 'flex-start' : 'center'}
        flexWrap="wrap" useFlexGap>
        {s.fm.presets.map((p, i) => (
          <PresetButton key={`${p}-${i}`} freq={p} big={big}
            active={Math.abs(p - s.fm.freq) < 0.05}
            onSelect={() => c.selectPreset(i)} onDelete={() => c.removePreset(i)} />
        ))}
        {s.fm.presets.length === 0 && (
          <Typography sx={{ opacity: 0.5 }}>No presets — tune a station and tap Save</Typography>
        )}
      </Stack>
      {big && <Typography sx={{ mt: 1, opacity: 0.4, fontSize: '0.85rem' }}>Long-press a preset to remove it</Typography>}
    </Box>
  )

  const volume = (
    <Stack direction="row" alignItems="center" spacing={big ? 2.5 : 1.5}>
      <IconButton size={big ? 'large' : 'small'} onClick={() => c.toggleMute()}>
        {s.muted ? <VolumeOffIcon sx={{ fontSize: big ? 36 : 24 }} /> : <VolumeUpIcon sx={{ fontSize: big ? 36 : 24 }} />}
      </IconButton>
      <Slider value={s.muted ? 0 : s.volume} min={0} max={VOL_MAX}
        onChange={(_, v) => c.setVolume(v)} valueLabelDisplay="auto" sx={{ flex: 1 }} />
      <Typography sx={{ width: big ? 48 : 30, textAlign: 'right', fontVariantNumeric: 'tabular-nums',
        fontSize: big ? '1.5rem' : undefined }}>
        {s.muted ? 'M' : s.volume}
      </Typography>
    </Stack>
  )

  // --- COMPACT (embedded in combined views) ---
  if (!big) {
    return (
      <Box sx={{ height: '100%', overflow: 'auto', p: 1.25 }}>
        <Stack spacing={1.25} sx={{ maxWidth: 640, mx: 'auto' }}>
          {header}
          <Paper sx={{ p: 1.25, opacity: off ? 0.45 : 1, pointerEvents: off ? 'none' : 'auto', transition: '0.2s' }}>
            <Stack spacing={1.5}>
              {sourceToggle}
              {tuner}
              {presets}
              {volume}
            </Stack>
          </Paper>
        </Stack>
      </Box>
    )
  }

  // --- BIG (dedicated Stereo page) ---
  return (
    <Box sx={{ height: '100%', overflow: 'auto', p: 3 }}>
      <Stack spacing={2.5} sx={{ maxWidth: 1500, mx: 'auto', height: '100%' }}>
        {header}
        <Box sx={{ flex: 1, display: 'grid', gridTemplateColumns: '1.15fr 1fr', gap: 3, minHeight: 0 }}>
          {/* Left: source + tuner + visualizer */}
          <Paper sx={{ p: 3, opacity: off ? 0.5 : 1, pointerEvents: off ? 'none' : 'auto', transition: '0.2s',
            display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 3 }}>
            {sourceToggle}
            {tuner}
            <Visualizer active={active} volume={s.volume} big />
          </Paper>
          {/* Right: presets + volume */}
          <Paper sx={{ p: 3, opacity: off ? 0.5 : 1, pointerEvents: off ? 'none' : 'auto', transition: '0.2s',
            display: 'flex', flexDirection: 'column', gap: 3 }}>
            <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>{presets}</Box>
            {volume}
          </Paper>
        </Box>
      </Stack>
    </Box>
  )
}
