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
import { createMockStereo, SOURCES, FM_MIN, FM_MAX, VOL_MAX } from '../stereo/stereoControl'

// Custom control panel for the DIY marine stereo. Backed by a mock today; the same
// UI drives the real FM receiver once its firmware implements the control contract.
// Laid out to fit a short 720px-tall column and to scroll if a panel is narrower.
export default function StereoView() {
  const [s, setS] = useState(null)
  const ctl = useRef(null)
  useEffect(() => { ctl.current = createMockStereo(setS) }, [])
  if (!s) return null

  const off = !s.power
  return (
    <Box sx={{ height: '100%', overflow: 'auto', p: 1.25 }}>
      <Stack spacing={1.25} sx={{ maxWidth: 640, mx: 'auto' }}>
        <Stack direction="row" alignItems="center" spacing={1}>
          <Typography variant="h6" sx={{ fontWeight: 800, flex: 1 }}>Stereo</Typography>
          <Chip
            size="small"
            color={s.connected ? 'success' : 'warning'}
            label={s.connected ? 'connected' : 'mock'}
          />
          <ToggleButton
            value="power" selected={s.power} onChange={() => ctl.current.setPower(!s.power)}
            color="success" size="small" sx={{ px: 1.5 }}
          >
            <PowerSettingsNewIcon fontSize="small" sx={{ mr: 0.75 }} /> {s.power ? 'On' : 'Off'}
          </ToggleButton>
        </Stack>

        <Paper sx={{ p: 1.25, opacity: off ? 0.45 : 1, pointerEvents: off ? 'none' : 'auto', transition: '0.2s' }}>
          <Stack spacing={1.5}>
            {/* Source */}
            <ToggleButtonGroup
              exclusive fullWidth size="small" value={s.source}
              onChange={(_, v) => v && ctl.current.setSource(v)}
            >
              {SOURCES.map((src) => (
                <ToggleButton key={src} value={src} sx={{ py: 0.75 }}>{src}</ToggleButton>
              ))}
            </ToggleButtonGroup>

            {/* FM tuner (only meaningful on FM) */}
            {s.source === 'FM' && (
              <Box>
                <Stack direction="row" alignItems="center" justifyContent="center" spacing={1.5}>
                  <IconButton onClick={() => ctl.current.seek(-1)}><FastRewindIcon /></IconButton>
                  <Typography sx={{ fontWeight: 800, fontSize: '2.4rem', lineHeight: 1, fontVariantNumeric: 'tabular-nums', minWidth: 150, textAlign: 'center' }}>
                    {s.fm.freq.toFixed(1)}
                    <Typography component="span" sx={{ ml: 0.75, opacity: 0.6, fontSize: '1rem' }}>FM</Typography>
                  </Typography>
                  <IconButton onClick={() => ctl.current.seek(1)}><FastForwardIcon /></IconButton>
                </Stack>
                <Slider
                  size="small" value={s.fm.freq} min={FM_MIN} max={FM_MAX} step={0.1}
                  onChange={(_, v) => ctl.current.tune(v)} valueLabelDisplay="auto"
                />
                <Stack direction="row" spacing={0.75} justifyContent="center" flexWrap="wrap" useFlexGap>
                  {s.fm.presets.map((p, i) => (
                    <Button
                      key={i} size="small" variant={Math.abs(p - s.fm.freq) < 0.05 ? 'contained' : 'outlined'}
                      onClick={() => ctl.current.selectPreset(i)} sx={{ minWidth: 64 }}
                    >
                      {p.toFixed(1)}
                    </Button>
                  ))}
                </Stack>
              </Box>
            )}

            {s.source !== 'FM' && (
              <Typography align="center" sx={{ py: 1.5, opacity: 0.7 }}>
                {s.source}: {s.nowPlaying.title}{s.nowPlaying.artist ? ` — ${s.nowPlaying.artist}` : ''}
              </Typography>
            )}

            {/* Volume */}
            <Stack direction="row" alignItems="center" spacing={1.5}>
              <IconButton size="small" onClick={() => ctl.current.toggleMute()}>
                {s.muted ? <VolumeOffIcon /> : <VolumeUpIcon />}
              </IconButton>
              <Slider
                value={s.muted ? 0 : s.volume} min={0} max={VOL_MAX}
                onChange={(_, v) => ctl.current.setVolume(v)} valueLabelDisplay="auto" sx={{ flex: 1 }}
              />
              <Typography sx={{ width: 30, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                {s.muted ? 'M' : s.volume}
              </Typography>
            </Stack>
          </Stack>
        </Paper>
      </Stack>
    </Box>
  )
}
