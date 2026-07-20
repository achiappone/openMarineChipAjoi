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
export default function StereoView() {
  const [s, setS] = useState(null)
  const ctl = useRef(null)
  useEffect(() => { ctl.current = createMockStereo(setS) }, [])
  if (!s) return null

  const off = !s.power
  return (
    <Box sx={{ height: '100%', overflow: 'auto', p: 2 }}>
      <Stack spacing={2} sx={{ maxWidth: 720, mx: 'auto' }}>
        <Stack direction="row" alignItems="center" spacing={1.5}>
          <Typography variant="h5" sx={{ fontWeight: 800, flex: 1 }}>Stereo</Typography>
          <Chip
            size="small"
            color={s.connected ? 'success' : 'warning'}
            label={s.connected ? 'connected' : 'mock — hardware TBD'}
          />
          <ToggleButton
            value="power" selected={s.power} onChange={() => ctl.current.setPower(!s.power)}
            color="success" sx={{ px: 2 }}
          >
            <PowerSettingsNewIcon sx={{ mr: 1 }} /> {s.power ? 'On' : 'Off'}
          </ToggleButton>
        </Stack>

        <Paper sx={{ p: 2, opacity: off ? 0.45 : 1, pointerEvents: off ? 'none' : 'auto', transition: '0.2s' }}>
          <Stack spacing={2.5}>
            {/* Source */}
            <ToggleButtonGroup
              exclusive fullWidth value={s.source}
              onChange={(_, v) => v && ctl.current.setSource(v)}
            >
              {SOURCES.map((src) => (
                <ToggleButton key={src} value={src} sx={{ py: 1.2 }}>{src}</ToggleButton>
              ))}
            </ToggleButtonGroup>

            {/* FM tuner (only meaningful on FM) */}
            {s.source === 'FM' && (
              <Box>
                <Stack direction="row" alignItems="center" justifyContent="center" spacing={2}>
                  <IconButton size="large" onClick={() => ctl.current.seek(-1)}><FastRewindIcon fontSize="large" /></IconButton>
                  <Typography variant="h2" sx={{ fontWeight: 800, fontVariantNumeric: 'tabular-nums', minWidth: 200, textAlign: 'center' }}>
                    {s.fm.freq.toFixed(1)}
                    <Typography component="span" variant="h6" sx={{ ml: 1, opacity: 0.6 }}>FM</Typography>
                  </Typography>
                  <IconButton size="large" onClick={() => ctl.current.seek(1)}><FastForwardIcon fontSize="large" /></IconButton>
                </Stack>
                <Slider
                  value={s.fm.freq} min={FM_MIN} max={FM_MAX} step={0.1}
                  onChange={(_, v) => ctl.current.tune(v)}
                  valueLabelDisplay="auto"
                />
                <Stack direction="row" spacing={1} justifyContent="center" flexWrap="wrap" useFlexGap>
                  {s.fm.presets.map((p, i) => (
                    <Button
                      key={i} variant={Math.abs(p - s.fm.freq) < 0.05 ? 'contained' : 'outlined'}
                      onClick={() => ctl.current.selectPreset(i)} sx={{ minWidth: 76 }}
                    >
                      {p.toFixed(1)}
                    </Button>
                  ))}
                </Stack>
              </Box>
            )}

            {s.source !== 'FM' && (
              <Typography align="center" sx={{ py: 3, opacity: 0.7 }}>
                {s.source}: {s.nowPlaying.title}{s.nowPlaying.artist ? ` — ${s.nowPlaying.artist}` : ''}
              </Typography>
            )}

            {/* Volume */}
            <Stack direction="row" alignItems="center" spacing={2}>
              <IconButton onClick={() => ctl.current.toggleMute()}>
                {s.muted ? <VolumeOffIcon /> : <VolumeUpIcon />}
              </IconButton>
              <Slider
                value={s.muted ? 0 : s.volume} min={0} max={VOL_MAX}
                onChange={(_, v) => ctl.current.setVolume(v)}
                valueLabelDisplay="auto" sx={{ flex: 1 }}
              />
              <Typography sx={{ width: 36, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                {s.muted ? 'M' : s.volume}
              </Typography>
            </Stack>
          </Stack>
        </Paper>
      </Stack>
    </Box>
  )
}
