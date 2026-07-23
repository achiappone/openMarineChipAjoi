import { useEffect, useRef, useState, memo } from 'react'
import {
  Box, Stack, Typography, ToggleButton, ToggleButtonGroup, Slider, IconButton,
  Button, Chip, Paper, Dialog, TextField, CircularProgress,
} from '@mui/material'
import PlayArrowIcon from '@mui/icons-material/PlayArrow'
import PauseIcon from '@mui/icons-material/Pause'
import SkipNextIcon from '@mui/icons-material/SkipNext'
import SkipPreviousIcon from '@mui/icons-material/SkipPrevious'
import ShuffleIcon from '@mui/icons-material/Shuffle'
import RepeatIcon from '@mui/icons-material/Repeat'
import RepeatOneIcon from '@mui/icons-material/RepeatOne'
import FastRewindIcon from '@mui/icons-material/FastRewind'
import FastForwardIcon from '@mui/icons-material/FastForward'
import SaveIcon from '@mui/icons-material/Save'
import MusicNoteIcon from '@mui/icons-material/MusicNote'
import CableIcon from '@mui/icons-material/Cable'
import RadioIcon from '@mui/icons-material/Radio'
import AddIcon from '@mui/icons-material/Add'
import RemoveIcon from '@mui/icons-material/Remove'
import BluetoothIcon from '@mui/icons-material/Bluetooth'
import BluetoothSearchingIcon from '@mui/icons-material/BluetoothSearching'
import CheckCircleIcon from '@mui/icons-material/CheckCircle'
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline'
import BatteryFullIcon from '@mui/icons-material/BatteryFull'
import Battery60Icon from '@mui/icons-material/Battery60'
import Battery20Icon from '@mui/icons-material/Battery20'
import BatteryAlertIcon from '@mui/icons-material/BatteryAlert'
import LibraryMusicIcon from '@mui/icons-material/LibraryMusic'
import { SOURCES, FM_MIN, FM_MAX, VOL_MAX } from '../stereo/stereoControl'
import { createRadioClient } from '../stereo/stereoClient'
import { Visualizer, BrowseLibraryDialog } from './StereoView'

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

function StereoCompact() {
  const [s, setS] = useState(null)

  const [btDevOpen, setBtDevOpen] = useState(false)
  const [browseOpen, setBrowseOpen] = useState(false) // music-library browser
  const [deleteConfirm, setDeleteConfirm] = useState(null)
  const [forgetAsk, setForgetAsk] = useState(null) // device pending forget confirmation
  const ctl = useRef(null)
  const posRef = useRef({ pos: 0, at: 0, key: '' })
  const renameRef = useRef(null)
  const swipeX = useRef(0)
  const dragging = useRef(false)
  const cardRef = useRef(null) // the swipeable album card (transform written directly)
  const [pending, setPending] = useState(false) // just swiped: show placeholder until the new track lands
  const pendKeyRef = useRef(''), trackKeyRef = useRef(''), pendTimer = useRef(null)
  const pendDirRef = useRef('next') // which way the pending track change went
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

  // Album swipe: the card follows the finger by writing transform straight to the
  // DOM node (no React re-render per frame — that was silently dropping the
  // animation). Past threshold it slides off, fires next/prev, then the new track
  // slides in from the opposite edge. Pointer events + capture + touch-action:none
  // so the browser can't steal the gesture.
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
  // On swipe, show the placeholder until a *different* track lands (or a timeout).
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

  // BT track progress, interpolated locally between polls.
  const fmtTime = (ms) => { const sec = Math.max(0, Math.floor(ms / 1000)); return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}` }
  const tr = bt.track
  // Two most-recently-connected phones (paired list as the fallback before any
  // connection history exists), for the one-tap reconnect buttons.
  const cx = bt.connecting // { mac, status: connecting|ok|fail, error }
  const recentPhones = ((bt.recent && bt.recent.length ? bt.recent
    : (bt.devices || []).filter((d) => !d.icon || d.icon === 'phone')) // skip keyboards etc.
    .filter((d) => !bt.connected || d.mac !== bt.connected.mac)).slice(0, 2)
  const trackKey = tr ? `${tr.title}|${tr.artKey || ''}` : ''
  trackKeyRef.current = trackKey
  // loadingNext: just swiped, the new track hasn't landed yet (blank the text so
  // stale metadata doesn't flash). showArtPlaceholder also covers art-less tracks.
  const loadingNext = !!(pending && trackKey === pendKeyRef.current)
  // Stepping back: show the remembered track straight away rather than blanking,
  // since we already know exactly what's coming (service keeps the last 3).
  const backTo = loadingNext && pendDirRef.current === 'prev' ? (bt.history || [])[0] : null
  const showArtPlaceholder = tr && !(backTo && backTo.artKey) && (!tr.artKey || loadingNext)
  let curPos = 0, dur = 0
  if (tr) {
    dur = tr.duration || 0
    const key = `${tr.title}|${tr.position}`
    if (posRef.current.key !== key) posRef.current = { pos: tr.position || 0, at: performance.now(), key }
    curPos = posRef.current.pos + (tr.status === 'playing' ? performance.now() - posRef.current.at : 0)
    if (dur) curPos = Math.min(curPos, dur)
  }

  // Phone battery glyph (rotated so it reads as an upright battery), sized to fit.
  const batLvl = bt.connected ? bt.connected.battery : null
  const batGlyph = (size) => {
    if (batLvl == null) return null
    const isx = { transform: 'rotate(90deg)', fontSize: size, color: batLvl <= 15 ? 'error.main' : batLvl <= 30 ? 'warning.main' : 'success.main' }
    if (batLvl <= 15) return <BatteryAlertIcon sx={isx} />
    if (batLvl <= 40) return <Battery20Icon sx={isx} />
    if (batLvl <= 75) return <Battery60Icon sx={isx} />
    return <BatteryFullIcon sx={isx} />
  }

  // Top row: source selector (RTL-SDR shown inside FM, battery inside Bluetooth) + device/settings icons.
  const sourceToggle = (
    <ToggleButtonGroup exclusive fullWidth size="large" value={s.source} onChange={(_, v) => v && c.setSource(v)}
      sx={{ flex: 1, '& .MuiToggleButton-root': { py: 1.1, fontSize: '1.3rem', fontWeight: 700, gap: 0.85 } }}>
      {SOURCES.map((src) => (
        <ToggleButton key={src} value={src}>
          {src === 'FM' ? <RadioIcon sx={{ fontSize: 22 }} /> : src === 'Bluetooth' ? <BluetoothIcon sx={{ fontSize: 22 }} /> : <CableIcon sx={{ fontSize: 22 }} />}
          {src}
          {src === 'FM' && (
            <Chip size="small" color={s.connected ? 'success' : 'warning'} label={s.connected ? 'RTL-SDR' : 'no svc'}
              sx={{ opacity: 0.6, height: 16, '& .MuiChip-label': { px: 0.5, fontSize: '0.52rem', fontWeight: 700, letterSpacing: 0.2 } }} />
          )}
          {src === 'Bluetooth' && batLvl != null && (
            <Stack direction="row" alignItems="center" spacing={0.25}>
              {batGlyph(22)}
              <Typography sx={{ fontSize: '0.72rem', fontWeight: 700 }}>{batLvl}%</Typography>
            </Stack>
          )}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  )
  const statusIcons = (
    <Stack direction="row" alignItems="center" spacing={0.5} sx={{ flexShrink: 0 }}>
      {bt.browsable && (
        <IconButton onClick={() => setBrowseOpen(true)} title="Browse library" sx={iconBtnSx}>
          <LibraryMusicIcon sx={{ fontSize: 30, color: 'primary.light' }} />
        </IconButton>
      )}
      <IconButton onClick={() => setBtDevOpen(true)} title="Bluetooth devices" sx={iconBtnSx}>
        <BluetoothIcon sx={{ fontSize: 30, color: bt.connected ? 'primary.light' : 'text.disabled' }} />
      </IconButton>
    </Stack>
  )

  // FM: left column = 2x-size manual seek buttons + freq/RDS + a tall visualizer;
  // right column = scrollable presets list.
  const seekBtnSx = { border: '2px solid rgba(255,255,255,0.22)', p: 1.5, '&:hover': { borderColor: 'primary.main' } }
  const fmMain = (
    <Box sx={{ flex: 1, minHeight: 0, display: 'flex', gap: 1.5 }}>
      <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 0.5 }}>
        <Stack direction="row" alignItems="center" spacing={1.25} justifyContent="flex-start" sx={{ flexShrink: 0 }}>
          <IconButton onClick={() => c.seek(-1)} sx={seekBtnSx}><SkipPreviousIcon sx={{ fontSize: 40 }} /></IconButton>
          <IconButton onClick={() => c.seek(1)} sx={seekBtnSx}><SkipNextIcon sx={{ fontSize: 40 }} /></IconButton>
          <Box sx={{ minWidth: 0, ml: 0.5 }}>
            <Typography sx={{ fontWeight: 800, fontVariantNumeric: 'tabular-nums', fontSize: '2.4rem', lineHeight: 1 }}>
              {s.fm.freq.toFixed(1)}
            </Typography>
            {s.nowPlaying?.title
              ? <Typography noWrap sx={{ fontWeight: 700, color: '#fff', fontSize: '1.05rem', lineHeight: 1.1 }}>{s.nowPlaying.title}</Typography>
              : <Typography sx={{ opacity: 0.4, fontSize: '0.85rem' }}>searching…</Typography>}
            {s.nowPlaying?.artist && <Typography noWrap sx={{ opacity: 0.75, fontSize: '0.85rem' }}>{s.nowPlaying.artist}</Typography>}
          </Box>
        </Stack>
        <Box sx={{ flex: 1, minHeight: 44 }}><Visualizer big={false} height="100%" /></Box>
      </Box>
      <Box sx={{ width: 296, flexShrink: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <Stack direction="row" alignItems="center" sx={{ mb: 0.5, flexShrink: 0 }}>
          <Typography sx={{ flex: 1, fontWeight: 700, opacity: 0.6, fontSize: '0.78rem', letterSpacing: 1 }}>PRESETS</Typography>
          <IconButton onClick={() => c.savePreset(s.fm.freq)} title={`Save ${s.fm.freq.toFixed(1)}`}
            sx={{ border: '2px solid', borderColor: 'primary.main', borderRadius: 1.5, color: 'primary.main', p: 0.5 }}>
            <SaveIcon sx={{ fontSize: 22 }} />
          </IconButton>
        </Stack>
        <Box sx={{ flex: 1, minHeight: 0, overflowY: 'auto', pr: 0.5,
          scrollbarWidth: 'thin', scrollbarColor: 'rgba(255,255,255,0.22) transparent',
          '&::-webkit-scrollbar': { width: 6 },
          '&::-webkit-scrollbar-track': { background: 'transparent' },
          '&::-webkit-scrollbar-thumb': { background: 'rgba(255,255,255,0.22)', borderRadius: 3 },
          '&::-webkit-scrollbar-button': { display: 'none', height: 0, width: 0 } }}>
          <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 0.75 }}>
            {s.fm.presets.map((p, i) => (
              <CompactPreset key={`${p.freq}-${i}`} preset={p} active={Math.abs(p.freq - s.fm.freq) < 0.05}
                onSelect={() => c.selectPreset(i)} onDelete={() => setDeleteConfirm({ i, preset: p })} />
            ))}
            {s.fm.presets.length === 0 && <Typography sx={{ gridColumn: '1 / -1', opacity: 0.5, fontSize: '0.9rem', px: 1 }}>Tune a station and tap Save</Typography>}
          </Box>
        </Box>
      </Box>
    </Box>
  )

  // Bluetooth: large album art + track/artist/album, track progress as a time
  // readout to the right of the info (frees the vertical space for taller art),
  // then big transport controls.
  // Transport controls are always on screen so the layout never jumps; they simply
  // grey out with no phone connected. Metadata-less phones still get working
  // buttons via the service's legacy MediaControl1 path.
  const btCtlOn = !!bt.connected
  const dimSx = { '&.Mui-disabled': { color: 'rgba(255,255,255,0.22)', borderColor: 'rgba(255,255,255,0.10)' } }
  const btTransport = (
    <Stack direction="row" spacing={0.5} alignItems="center" justifyContent="center" sx={{ flexShrink: 0 }}>
      <IconButton disabled={!btCtlOn} onClick={() => c.btShuffle()} title="Shuffle"
        sx={{ color: bt.shuffle && bt.shuffle !== 'off' ? 'primary.light' : 'text.disabled', ...dimSx }}>
        <ShuffleIcon sx={{ fontSize: 26 }} />
      </IconButton>
      <IconButton disabled={!btCtlOn} onClick={() => { c.btPrev(); markPending('prev') }} sx={{ border: '2px solid rgba(255,255,255,0.2)', p: 1.25, ...dimSx }}><SkipPreviousIcon sx={{ fontSize: 44 }} /></IconButton>
      <IconButton disabled={!btCtlOn} onClick={() => c.btSeek(-15)} title="Back 15s" sx={{ border: '2px solid rgba(255,255,255,0.2)', p: 1, ...dimSx }}>
        <Typography sx={{ fontWeight: 800, fontSize: '1rem', lineHeight: 1 }}>−15</Typography>
      </IconButton>
      <IconButton disabled={!btCtlOn} onClick={() => c.btPlayPause()} sx={{ border: '2px solid', borderColor: 'primary.main', bgcolor: 'rgba(57,160,255,0.15)', p: 1.75, ...dimSx }}>
        {/* Combined glyph when there's no Status to reflect (MUI has no play/pause icon). */}
        {!tr && bt.control === 'legacy' ? (
          <Box sx={{ display: 'flex', alignItems: 'center' }}>
            <PlayArrowIcon sx={{ fontSize: 40, mr: -0.6 }} />
            <PauseIcon sx={{ fontSize: 40 }} />
          </Box>
        ) : tr && tr.status === 'playing' ? <PauseIcon sx={{ fontSize: 56 }} /> : <PlayArrowIcon sx={{ fontSize: 56 }} />}
      </IconButton>
      <IconButton disabled={!btCtlOn} onClick={() => c.btSeek(30)} title="Forward 30s" sx={{ border: '2px solid rgba(255,255,255,0.2)', p: 1, ...dimSx }}>
        <Typography sx={{ fontWeight: 800, fontSize: '1rem', lineHeight: 1 }}>+30</Typography>
      </IconButton>
      <IconButton disabled={!btCtlOn} onClick={() => { c.btNext(); markPending('next') }} sx={{ border: '2px solid rgba(255,255,255,0.2)', p: 1.25, ...dimSx }}><SkipNextIcon sx={{ fontSize: 44 }} /></IconButton>
      <IconButton disabled={!btCtlOn} onClick={() => c.btRepeat()} title="Repeat"
        sx={{ color: bt.repeat && bt.repeat !== 'off' ? 'primary.light' : 'text.disabled', ...dimSx }}>
        {bt.repeat === 'singletrack' ? <RepeatOneIcon sx={{ fontSize: 26 }} /> : <RepeatIcon sx={{ fontSize: 26 }} />}
      </IconButton>
    </Stack>
  )
  const btMain = (
    <Box sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', justifyContent: 'center' }}>
      {tr ? (
        <Stack direction="row" spacing={2} alignItems="center" sx={{ minWidth: 0, overflow: 'hidden' }}>
          <Box
            ref={cardRef}
            onPointerDown={onSwipeStart} onPointerMove={onSwipeMove} onPointerUp={onSwipeEnd} onPointerCancel={onSwipeEnd}
            sx={{ display: 'flex', alignItems: 'center', gap: 2, flex: 1, minWidth: 0,
              touchAction: 'none', userSelect: 'none', cursor: 'grab', willChange: 'transform' }}>
            {/* Art box is always this exact size so the info column never resizes. */}
            {showArtPlaceholder ? (
              <Box sx={{ width: 172, height: 172, borderRadius: 2, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', bgcolor: 'rgba(255,255,255,0.06)', pointerEvents: 'none' }}>
                <MusicNoteIcon sx={{ fontSize: 84, opacity: 0.3 }} />
              </Box>
            ) : (
              <Box component="img" src={`${SVC}/api/art?k=${encodeURIComponent((backTo && backTo.artKey) || tr.artKey)}`} alt="" draggable={false}
                sx={{ width: 172, height: 172, borderRadius: 2, flexShrink: 0, objectFit: 'cover', pointerEvents: 'none' }} />
            )}
            {/* Fixed line heights + always-rendered lines so title/artist/album never move. */}
            <Box sx={{ minWidth: 0, flex: 1 }}>
              <Typography noWrap sx={{ fontWeight: 800, color: '#fff', fontSize: '1.6rem', lineHeight: 1.25, height: '2rem' }}>
                {loadingNext ? ' ' : (tr.title || ' ')}
              </Typography>
              <Typography noWrap sx={{ color: 'primary.light', fontWeight: 700, fontSize: '1.15rem', lineHeight: 1.35, height: '1.55rem', mt: 0.5 }}>
                {loadingNext ? ' ' : (tr.artist || ' ')}
              </Typography>
              <Typography noWrap sx={{ opacity: 0.65, fontSize: '0.95rem', lineHeight: 1.35, height: '1.3rem', mt: 0.5 }}>
                {loadingNext ? ' ' : (tr.album || ' ')}
              </Typography>
            </Box>
          </Box>
          {/* Times sit above the transport row (not beside the text), which also
              hands the title/artist/album lines ~90px more width. */}
          <Stack spacing={0.5} alignItems="center" sx={{ flexShrink: 0 }}>
            <Stack direction="row" spacing={1} alignItems="baseline" sx={{ fontVariantNumeric: 'tabular-nums' }}>
              <Typography sx={{ fontWeight: 800, fontSize: '1.35rem', lineHeight: 1.05 }}>{loadingNext || !dur ? ' ' : fmtTime(curPos)}</Typography>
              <Typography sx={{ opacity: 0.6, fontSize: '0.95rem' }}>{loadingNext || !dur ? ' ' : `of ${fmtTime(dur)}`}</Typography>
            </Stack>
            {btTransport}
          </Stack>
        </Stack>
      ) : bt.connected ? (
        <Stack spacing={1.5} alignItems="center">
          <Typography sx={{ opacity: 0.6, textAlign: 'center', fontSize: '1.15rem' }}>
            {bt.control === 'legacy' ? 'Connected — this phone doesn\u2019t share track info' : 'Play something on your phone'}
          </Typography>
          {btTransport}
        </Stack>
      ) : (
        // Same one-tap reconnect / pair affordance as the full view.
        <Stack spacing={0.75} sx={{ alignItems: 'center' }}>
          <Typography sx={{ opacity: 0.6, textAlign: 'center', fontSize: '1.05rem' }}>No phone connected</Typography>
          {recentPhones.map((d) => {
            const st = cx && cx.mac === d.mac ? cx.status : ''
            return (
              <Button key={d.mac} variant="outlined" disabled={st === 'connecting'}
                color={st === 'ok' ? 'success' : st === 'fail' ? 'error' : 'primary'}
                startIcon={st === 'connecting' ? <CircularProgress size={18} color="inherit" />
                  : st === 'ok' ? <CheckCircleIcon /> : st === 'fail' ? <ErrorOutlineIcon /> : <BluetoothIcon />}
                onClick={() => c.btConnect(d.mac)}
                sx={{ py: 0.9, width: 260, maxWidth: '100%', fontWeight: 700,
                  '&.Mui-disabled': { color: 'primary.light', borderColor: 'primary.light' } }}>
                {st === 'connecting' ? 'Connecting…' : st === 'ok' ? 'Connected' : st === 'fail' ? (cx.error || 'Failed') : d.name}
              </Button>
            )
          })}
          {/* Padding, not margin — Stack's spacing sets margin-top on children. */}
          <Box sx={{ pt: 2.5, width: 260, maxWidth: '100%' }}>
            <Button fullWidth variant="contained" startIcon={<BluetoothSearchingIcon />} onClick={() => c.btPair()}
              sx={{ py: 0.9, fontWeight: 700 }}>Pair New Phone</Button>
          </Box>
          <Box sx={{ pt: 1 }}>{btTransport}</Box>
        </Stack>
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

  // Bottom row: for Bluetooth/Aux, a live spectrum strip (tap to cycle). FM shows
  // its own tall visualizer in the content area. Volume now lives in the global
  // bottom page bar, so it isn't repeated here.
  // No spectrum strip in the All view: the band is short and the space is worth
  // more to the track info. (The full Stereo tab still has its visualizer.)
  const bottomViz = null

  // Pairing wizard — same as the full view: names the device the phone will see.
  const pairLeft = bt.pairUntil ? Math.max(0, Math.ceil((bt.pairUntil - Date.now()) / 1000)) : 0
  const pairWizard = (
    <Dialog open={!!bt.pairing} onClose={() => c.btCancelPair()} maxWidth="xs" fullWidth>
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
            <Button variant="contained" onClick={() => c.btCancelPair()}>Done</Button>
          </>
        ) : (
          <>
            <CircularProgress size={44} sx={{ mb: 2 }} />
            <Typography sx={{ fontWeight: 800, fontSize: '1.3rem', mb: 1 }}>Ready to pair</Typography>
            <Typography sx={{ opacity: 0.85, mb: 1 }}>On your phone, open Bluetooth settings and tap:</Typography>
            <Typography sx={{ fontWeight: 800, fontSize: '1.5rem', color: 'primary.light', mb: 2 }}>{bt.name || 'this device'}</Typography>
            <Typography sx={{ opacity: 0.6, fontSize: '0.9rem', mb: 2 }}>
              {pairLeft ? `Discoverable for ${pairLeft}s` : 'Discoverable'}
            </Typography>
            <Button onClick={() => c.btCancelPair()}>Cancel</Button>
          </>
        )}
      </Box>
    </Dialog>
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
            {/* Touch targets: these get pressed on a moving boat. */}
            <Stack direction="row" spacing={1.5} sx={{ mt: 2 }}>
              <Button variant="outlined" size="large" onClick={() => c.btDisconnect()}
                sx={{ flex: 1, py: 1.5, fontSize: '1.1rem', fontWeight: 700 }}>Disconnect</Button>
              <Button variant="outlined" size="large" color="error" onClick={() => setForgetAsk(bt.connected)}
                sx={{ py: 1.5, px: 3, fontSize: '1.1rem', fontWeight: 700 }}>Forget</Button>
            </Stack>
          </Paper>
        ) : <Typography sx={{ opacity: 0.6, mb: 2 }}>No phone connected</Typography>}
        <Button variant="contained" size="large" fullWidth startIcon={<BluetoothSearchingIcon />}
          onClick={() => c.btPair()} sx={{ py: 1.5, mb: 2 }}>Pair New Phone</Button>
        {(bt.devices || []).filter((d) => !d.connected).map((d) => (
          <Stack key={d.mac} direction="row" spacing={1} alignItems="center" sx={{ mb: 1 }}>
            <Button variant="outlined" sx={{ flex: 1, justifyContent: 'flex-start', py: 1 }}
              onClick={() => c.btConnect(d.mac)}>{d.name}</Button>
            <Button color="error" sx={{ flexShrink: 0 }} onClick={() => setForgetAsk(d)}>Forget</Button>
          </Stack>
        ))}
        <Stack direction="row" justifyContent="flex-end" sx={{ mt: 2 }}>
          <Button size="large" onClick={() => setBtDevOpen(false)}>Close</Button>
        </Stack>
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
                onClick={() => { c.btForget(forgetAsk.mac); setForgetAsk(null) }}>Forget</Button>
            </Stack>
          </Box>
        </Dialog>
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
      {bottomViz && <Box sx={{ mt: 1 }}>{bottomViz}</Box>}
      {btDevicesModal}
      {pairWizard}
      <BrowseLibraryDialog open={browseOpen} onClose={() => setBrowseOpen(false)} c={c} browsable={bt.browsable} deviceKey={bt.connected && bt.connected.mac} />
      {deleteDialog}
    </Box>
  )
}

export default memo(StereoCompact)
