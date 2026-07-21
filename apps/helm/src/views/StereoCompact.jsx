import { useEffect, useRef, useState } from 'react'
import {
  Box, Stack, Typography, ToggleButton, ToggleButtonGroup, Slider, IconButton,
  Button, Chip, Paper, Dialog, TextField,
} from '@mui/material'
import PlayArrowIcon from '@mui/icons-material/PlayArrow'
import PauseIcon from '@mui/icons-material/Pause'
import SkipNextIcon from '@mui/icons-material/SkipNext'
import SkipPreviousIcon from '@mui/icons-material/SkipPrevious'
import FastRewindIcon from '@mui/icons-material/FastRewind'
import FastForwardIcon from '@mui/icons-material/FastForward'
import SaveIcon from '@mui/icons-material/Save'
import SettingsIcon from '@mui/icons-material/Settings'
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
import { SettingsDialog } from './StereoView'

// Dedicated, self-contained compact stereo section for the "All" dashboard tab.
// Separate from StereoView on purpose: the All-view band is short (~48% height),
// so this is a touch-first, no-scroll layout tuned for that space, and editing it
// can never disturb the full Stereo tab.
const SVC = `http://${location.hostname}:8082`

// Big, finger-friendly frequency preset chip (tap to tune, long-press to edit/remove).
function CompactPreset({ preset, active, onSelect, onDelete }) {
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
        px: 2, minWidth: 96, height: 68, flexShrink: 0,
        display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
        '&:hover': { borderColor: 'primary.main' },
      }}>
      <Typography sx={{ fontWeight: 800, lineHeight: 1, fontSize: '1.6rem' }}>{preset.freq.toFixed(1)}</Typography>
      {(preset.name || preset.pty) && (
        <Typography noWrap sx={{ fontSize: '0.8rem', fontWeight: 600, opacity: active ? 0.85 : 0.7, mt: 0.25, maxWidth: 120 }}>
          {preset.name || preset.pty}
        </Typography>
      )}
    </Paper>
  )
}

// Simple live-spectrum bars — an at-a-glance "music is playing" indicator driven
// by the same audio-output spectrum feed the full view uses. Flat when nothing
// plays (or muted); dances when audio flows, whatever the source.
function CompactViz() {
  const wrapRef = useRef(null), canvasRef = useRef(null)
  const specRef = useRef(new Array(32).fill(0))
  useEffect(() => {
    let es
    try { es = new EventSource(`${SVC}/api/spectrum`); es.onmessage = (e) => { try { specRef.current = JSON.parse(e.data) } catch (x) {} } } catch (x) {}
    return () => es && es.close()
  }, [])
  useEffect(() => {
    let raf
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
        const spec = specRef.current, n = spec.length || 32, bw = W / n
        for (let i = 0; i < n; i++) {
          const bh = Math.max(2, (spec[i] || 0) * H), t = i / n
          ctx.fillStyle = `rgb(${Math.round(31 + 30 * t)},${Math.round(111 + 109 * t)},${Math.round(235 - 103 * t)})`
          ctx.fillRect(i * bw + bw * 0.15, H - bh, bw * 0.7, bh)
        }
      }
      raf = requestAnimationFrame(loop)
    }
    raf = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(raf)
  }, [])
  return (
    <Box ref={wrapRef} sx={{ flex: 1, minWidth: 0, height: 40, opacity: 0.9 }}>
      <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
    </Box>
  )
}

export default function StereoCompact() {
  const [s, setS] = useState(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [btDevOpen, setBtDevOpen] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState(null)
  const ctl = useRef(null)
  const posRef = useRef({ pos: 0, at: 0, key: '' })
  const renameRef = useRef(null)
  const swipeX = useRef(0)
  const dragging = useRef(false)
  const [drag, setDrag] = useState({ x: 0, anim: false }) // live album-swipe offset
  const [, setTick] = useState(0)
  useEffect(() => {
    ctl.current = createRadioClient(setS)
    const t = setInterval(() => setTick((x) => x + 1), 1000) // ticks the BT progress bar between polls
    return () => { ctl.current && ctl.current.stop && ctl.current.stop(); clearInterval(t) }
  }, [])
  if (!s) return null

  const c = ctl.current
  const isFM = s.source === 'FM'
  const bt = s.bluetooth || {}
  const iconBtnSx = { border: '2px solid rgba(255,255,255,0.22)', borderRadius: 2, p: 1, '&:hover': { borderColor: 'primary.main' } }
  const volStep = (d) => c.setVolume(Math.max(0, Math.min(VOL_MAX, (s.muted ? 0 : s.volume) + d)))

  // Album swipe: content follows the finger; past threshold it slides off, fires
  // next/prev, then the new track slides in from the opposite edge (mobile-style).
  const SWIPE_OUT = 480, SWIPE_MIN = 60
  const onSwipeStart = (e) => { swipeX.current = e.touches[0].clientX; dragging.current = true; setDrag({ x: 0, anim: false }) }
  const onSwipeMove = (e) => { if (dragging.current) setDrag({ x: e.touches[0].clientX - swipeX.current, anim: false }) }
  const slideInFrom = (from) => setTimeout(() => {
    setDrag({ x: from, anim: false })
    requestAnimationFrame(() => requestAnimationFrame(() => setDrag({ x: 0, anim: true })))
  }, 200)
  const onSwipeEnd = (e) => {
    if (!dragging.current) return
    dragging.current = false
    const dx = e.changedTouches[0].clientX - swipeX.current
    if (dx <= -SWIPE_MIN) { setDrag({ x: -SWIPE_OUT, anim: true }); c.btNext(); slideInFrom(SWIPE_OUT) }
    else if (dx >= SWIPE_MIN) { setDrag({ x: SWIPE_OUT, anim: true }); c.btPrev(); slideInFrom(-SWIPE_OUT) }
    else setDrag({ x: 0, anim: true }) // snap back
  }

  // BT track progress, interpolated locally between polls.
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

  // Phone battery icon (rotated so it reads as an upright battery).
  const batLvl = bt.connected ? bt.connected.battery : null
  const batIcon = (() => {
    if (batLvl == null) return null
    const isx = { transform: 'rotate(90deg)', fontSize: 32, color: batLvl <= 15 ? 'error.main' : batLvl <= 30 ? 'warning.main' : 'success.main' }
    if (batLvl <= 15) return <BatteryAlertIcon sx={isx} />
    if (batLvl <= 40) return <Battery20Icon sx={isx} />
    if (batLvl <= 75) return <Battery60Icon sx={isx} />
    return <BatteryFullIcon sx={isx} />
  })()

  // Top row: source selector + phone/status icons.
  const sourceToggle = (
    <ToggleButtonGroup exclusive fullWidth size="large" value={s.source} onChange={(_, v) => v && c.setSource(v)}
      sx={{ flex: 1, '& .MuiToggleButton-root': { py: 1.1, fontSize: '1.15rem', fontWeight: 700 } }}>
      {SOURCES.map((src) => <ToggleButton key={src} value={src}>{src}</ToggleButton>)}
    </ToggleButtonGroup>
  )
  const statusIcons = (
    <Stack direction="row" alignItems="center" spacing={0.5} sx={{ flexShrink: 0 }}>
      {!s.connected && <Chip color="warning" label="no svc" sx={{ '& .MuiChip-label': { fontSize: '0.72rem' } }} />}
      <IconButton onClick={() => setBtDevOpen(true)} title="Bluetooth devices" sx={iconBtnSx}>
        <BluetoothIcon sx={{ fontSize: 30, color: bt.connected ? 'primary.light' : 'text.disabled' }} />
      </IconButton>
      {batLvl != null && (
        <Stack alignItems="center" spacing={0}>
          {batIcon}
          <Typography sx={{ fontSize: '0.78rem', fontWeight: 700, mt: -0.75, lineHeight: 1 }}>{batLvl}%</Typography>
        </Stack>
      )}
      <IconButton onClick={() => setSettingsOpen(true)} title="FM tuner settings" sx={iconBtnSx}>
        <SettingsIcon sx={{ fontSize: 28 }} />
      </IconButton>
    </Stack>
  )

  // FM: freq + RDS station info (left), big preset chips (right).
  const fmMain = (
    <Box sx={{ flex: 1, minHeight: 0, display: 'flex', gap: 1.5 }}>
      <Stack sx={{ width: 210, flexShrink: 0, justifyContent: 'center', minWidth: 0 }} spacing={0.5}>
        <Stack direction="row" alignItems="center" spacing={0.5}>
          <IconButton onClick={() => c.seek(-1)} sx={iconBtnSx}><FastRewindIcon sx={{ fontSize: 28 }} /></IconButton>
          <Typography sx={{ fontWeight: 800, fontVariantNumeric: 'tabular-nums', fontSize: '2.4rem', lineHeight: 1, flex: 1, textAlign: 'center' }}>
            {s.fm.freq.toFixed(1)}
          </Typography>
          <IconButton onClick={() => c.seek(1)} sx={iconBtnSx}><FastForwardIcon sx={{ fontSize: 28 }} /></IconButton>
        </Stack>
        {s.nowPlaying?.title
          ? <Typography noWrap sx={{ fontWeight: 700, color: '#fff', fontSize: '1.2rem', lineHeight: 1.1 }}>{s.nowPlaying.title}</Typography>
          : <Typography sx={{ opacity: 0.4, fontSize: '0.9rem', textAlign: 'center' }}>searching…</Typography>}
        {s.nowPlaying?.artist && (
          <Typography sx={{ opacity: 0.8, fontSize: '0.95rem', lineHeight: 1.2,
            display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
            {s.nowPlaying.artist}
          </Typography>
        )}
      </Stack>
      <Box sx={{ flex: 1, minWidth: 0, overflow: 'hidden', display: 'flex', alignItems: 'center' }}>
        <Stack direction="row" spacing={1} flexWrap="wrap" useFlexGap alignItems="center" sx={{ overflow: 'hidden' }}>
          <IconButton onClick={() => c.savePreset(s.fm.freq)} title={`Save ${s.fm.freq.toFixed(1)}`}
            sx={{ border: '2px solid', borderColor: 'primary.main', borderRadius: 2, color: 'primary.main', p: 1.25 }}>
            <SaveIcon sx={{ fontSize: 28 }} />
          </IconButton>
          {s.fm.presets.map((p, i) => (
            <CompactPreset key={`${p.freq}-${i}`} preset={p} active={Math.abs(p.freq - s.fm.freq) < 0.05}
              onSelect={() => c.selectPreset(i)} onDelete={() => setDeleteConfirm({ i, preset: p })} />
          ))}
          {s.fm.presets.length === 0 && <Typography sx={{ opacity: 0.5, fontSize: '1rem' }}>Tune a station and tap Save</Typography>}
        </Stack>
      </Box>
    </Box>
  )

  // Bluetooth: large album art + track/artist/album, track progress as a time
  // readout to the right of the info (frees the vertical space for taller art),
  // then big transport controls.
  const btMain = (
    <Box sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
      {tr ? (
        <Stack direction="row" spacing={2} alignItems="center" sx={{ minWidth: 0, overflow: 'hidden' }}>
          <Box
            onTouchStart={onSwipeStart} onTouchMove={onSwipeMove} onTouchEnd={onSwipeEnd}
            sx={{ display: 'flex', alignItems: 'center', gap: 2, flex: 1, minWidth: 0,
              transform: `translateX(${drag.x}px)`, opacity: Math.max(0.15, 1 - Math.abs(drag.x) / 520),
              transition: drag.anim ? 'transform 0.2s ease, opacity 0.2s ease' : 'none',
              touchAction: 'pan-y', userSelect: 'none' }}>
            {tr.artKey && (
              <Box component="img" src={`${SVC}/api/art?k=${encodeURIComponent(tr.artKey)}`} alt="" draggable={false}
                sx={{ width: 172, height: 172, borderRadius: 2, flexShrink: 0, objectFit: 'cover', pointerEvents: 'none' }} />
            )}
            <Box sx={{ minWidth: 0, flex: 1 }}>
              <Typography noWrap sx={{ fontWeight: 800, color: '#fff', fontSize: '1.6rem', lineHeight: 1.15 }}>{tr.title || '—'}</Typography>
              {tr.artist && <Typography noWrap sx={{ color: 'primary.light', fontWeight: 700, fontSize: '1.15rem', mt: 0.25 }}>{tr.artist}</Typography>}
              {tr.album && <Typography noWrap sx={{ opacity: 0.65, fontSize: '0.95rem', mt: 0.25 }}>{tr.album}</Typography>}
            </Box>
            {dur > 0 && (
              <Box sx={{ textAlign: 'right', flexShrink: 0, fontVariantNumeric: 'tabular-nums' }}>
                <Typography sx={{ fontWeight: 800, fontSize: '1.5rem', lineHeight: 1.05 }}>{fmtTime(curPos)}</Typography>
                <Typography sx={{ opacity: 0.6, fontSize: '1rem' }}>of {fmtTime(dur)}</Typography>
              </Box>
            )}
          </Box>
          <Stack direction="row" spacing={1} alignItems="center" sx={{ flexShrink: 0 }}>
            <IconButton onClick={() => c.btPrev()} sx={{ border: '2px solid rgba(255,255,255,0.2)', p: 1.25 }}><SkipPreviousIcon sx={{ fontSize: 44 }} /></IconButton>
            <IconButton onClick={() => c.btPlayPause()} sx={{ border: '2px solid', borderColor: 'primary.main', bgcolor: 'rgba(57,160,255,0.15)', p: 1.75 }}>
              {tr.status === 'playing' ? <PauseIcon sx={{ fontSize: 56 }} /> : <PlayArrowIcon sx={{ fontSize: 56 }} />}
            </IconButton>
            <IconButton onClick={() => c.btNext()} sx={{ border: '2px solid rgba(255,255,255,0.2)', p: 1.25 }}><SkipNextIcon sx={{ fontSize: 44 }} /></IconButton>
          </Stack>
        </Stack>
      ) : (
        <Typography sx={{ opacity: 0.6, textAlign: 'center', fontSize: '1.15rem' }}>
          {bt.connected ? 'Play something on your phone' : 'Tap the Bluetooth icon to connect a phone'}
        </Typography>
      )}
    </Box>
  )

  const auxMain = (
    <Box sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center', textAlign: 'center' }}>
      <Typography sx={{ fontWeight: 800, fontSize: '1.6rem' }}>Aux Input</Typography>
      <Typography sx={{ opacity: 0.7, fontSize: '1rem' }}>Line in via the 3.5mm jack</Typography>
    </Box>
  )
  const main = isFM ? fmMain : s.source === 'Bluetooth' ? btMain : auxMain

  // Bottom row: live "now playing" visualizer fills the left; a narrower volume
  // slider with ± buttons is justified to the right. (MUTE now lives in the
  // global bottom page bar.)
  const volume = (
    <Stack direction="row" alignItems="center" spacing={1}>
      <CompactViz />
      <IconButton onClick={() => volStep(-1)} sx={iconBtnSx}><RemoveIcon sx={{ fontSize: 26 }} /></IconButton>
      <Slider value={s.muted ? 0 : s.volume} min={0} max={VOL_MAX} step={1}
        onChange={(_, v) => c.setVolume(v)} valueLabelDisplay="auto"
        sx={{ width: 300, flexGrow: 0, py: 1, '& .MuiSlider-thumb': { width: 30, height: 30 },
          '& .MuiSlider-rail, & .MuiSlider-track': { height: 12, borderRadius: 8 }, '& .MuiSlider-valueLabel': { fontSize: '1rem' } }} />
      <IconButton onClick={() => volStep(1)} sx={iconBtnSx}><AddIcon sx={{ fontSize: 26 }} /></IconButton>
      <Typography sx={{ width: 40, textAlign: 'right', fontVariantNumeric: 'tabular-nums', fontSize: '1.4rem', fontWeight: 700 }}>
        {s.muted ? 'M' : s.volume}
      </Typography>
    </Stack>
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

  return (
    <Box sx={{ height: '100%', overflow: 'hidden', p: 1.25, display: 'flex', flexDirection: 'column' }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ mb: 1 }}>
        {sourceToggle}
        {statusIcons}
      </Stack>
      {main}
      <Box sx={{ mt: 1 }}>{volume}</Box>
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} settings={s.settings} onChange={(patch) => c.setSettings(patch)} />
      {btDevicesModal}
      {deleteDialog}
    </Box>
  )
}
