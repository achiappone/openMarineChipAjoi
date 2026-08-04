import { useEffect, useState } from 'react'
import { Box, Typography } from '@mui/material'
import { useLiveControls, setKnobMode, knobService } from '../lib/liveControls'

// The two things the knob controls, shown as cards in the bottom-right corner.
//
// These replace the corner dial, which only told you anything while your hand was on it.
// Cards are useful at rest — station and volume are always readable — and they double as
// the mode indicator: whichever card is lit is what the knob turns. Tapping a card claims
// the knob, so the mode is selectable on screen as well as by the physical key.
//
// The component subscribes to the live store directly instead of receiving props from the
// app shell, so knob events re-render these two cards and nothing else on the helm.

const FM_MIN = 87.9, FM_MAX = 107.9
const ACCENT = '#39c6d8'

// The cards are the widest thing on the right edge, so they set the rail width for the
// whole shell — App imports this rather than guessing a padding that has to be kept in
// sync by hand.
export const CARD_W = 236
// The VOLUME card sets the height of the bottom task bar too, so the two line up along
// the bottom edge. Exported for the same reason CARD_W is: one number, no hand-syncing.
export const CARD_H = 84

function Card({ active, onTap, label, children, dim, height }) {
  return (
    <Box
      onClick={onTap}
      sx={{
        position: 'relative', cursor: 'pointer', userSelect: 'none',
        bgcolor: active ? 'rgba(10,26,32,0.94)' : 'rgba(4,7,11,0.86)',
        border: '2px solid', borderColor: active ? ACCENT : 'rgba(255,255,255,0.14)',
        boxShadow: active ? `0 0 16px rgba(57,198,216,0.30)` : 'none',
        borderRadius: 2.5, px: 1.75, py: 1.25, width: '100%',
        ...(height ? { height, display: 'flex', flexDirection: 'column', justifyContent: 'center' } : null),
        transition: 'border-color 140ms linear, background-color 140ms linear, box-shadow 140ms linear',
        opacity: dim ? 0.75 : 1,
      }}
    >
      <Typography sx={{
        fontSize: '0.62rem', letterSpacing: 1.5, fontWeight: 800,
        color: active ? ACCENT : 'rgba(255,255,255,0.5)',
      }}>
        {label}{active ? ' · KNOB' : ''}
      </Typography>
      {children}
    </Box>
  )
}

export default function ControlCards() {
  const live = useLiveControls()
  const [st, setSt] = useState(null)

  // One slow poll for the things that change on their own — station name, presets, mute.
  // Everything a hand moves arrives on the stream instead.
  useEffect(() => {
    let alive = true
    const load = () => fetch(`${knobService()}/api/state`).then((r) => r.json())
      .then((d) => { if (alive) setSt(d) }).catch(() => {})
    load()
    const t = setInterval(load, 2000)
    return () => { alive = false; clearInterval(t) }
  }, [])

  const tuneActive = live.mode === 'tune'
  const volActive = live.mode === 'volume'
  const freq = live.freq != null ? live.freq : (st && st.fm ? st.fm.freq : null)
  const vol = live.volume != null ? live.volume : (st ? st.volume : null)
  const muted = !!(st && st.muted)
  const presets = (st && st.fm && st.fm.presets) || []
  const station = st && st.nowPlaying && st.nowPlaying.title && st.nowPlaying.title !== 'FM Radio'
    ? st.nowPlaying.title : null
  const pct = freq == null ? 0 : Math.max(0, Math.min(1, (freq - FM_MIN) / (FM_MAX - FM_MIN)))
  const volPct = vol == null ? 0 : Math.max(0, Math.min(1, vol / 30))

  return (
    <Box sx={{
      // Anchored to the bottom of the rail column, not to the viewport — so widening the
      // rail moves the cards and the content together instead of letting them drift apart.
      position: 'absolute', left: 5, right: 5, bottom: 8, zIndex: 1500,
      display: 'flex', flexDirection: 'column', gap: 1,
    }}>
      <Card label="FM" active={tuneActive} onTap={() => setKnobMode('tune')}>
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1 }}>
          <Typography sx={{ fontWeight: 800, fontSize: '1.9rem', lineHeight: 1.1, fontVariantNumeric: 'tabular-nums' }}>
            {freq == null ? '—' : freq.toFixed(1)}
          </Typography>
          <Typography noWrap sx={{ fontSize: '0.9rem', opacity: 0.75, maxWidth: 120 }}>
            {station || 'FM'}
          </Typography>
        </Box>
        {/* Band strip: the whole 88-108 range with your presets marked, so you can see
            what's coming as you sweep rather than watching a number change. */}
        <Box sx={{ position: 'relative', height: 16, mt: 0.5 }}>
          <Box sx={{ position: 'absolute', left: 0, right: 0, top: 7, height: 2, bgcolor: 'rgba(255,255,255,0.18)' }} />
          {presets.map((p, i) => {
            const x = Math.max(0, Math.min(1, (p.freq - FM_MIN) / (FM_MAX - FM_MIN)))
            const near = freq != null && Math.abs(p.freq - freq) < 0.05
            return (
              <Box key={i} sx={{
                position: 'absolute', left: `${x * 100}%`, top: near ? 3 : 5,
                width: near ? 5 : 3, height: near ? 10 : 6, borderRadius: 1,
                transform: 'translateX(-50%)',
                bgcolor: near ? '#39d98a' : ACCENT, opacity: near ? 1 : 0.7,
              }} />
            )
          })}
          <Box sx={{
            position: 'absolute', left: `${pct * 100}%`, top: 0, width: 2, height: 16,
            bgcolor: '#fff', transform: 'translateX(-50%)',
            transition: 'left 90ms linear',   // glide between detents like the dial did
          }} />
        </Box>
      </Card>

      <Card label="VOLUME" active={volActive} onTap={() => setKnobMode('volume')} height={CARD_H}>
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1 }}>
          <Typography sx={{
            fontWeight: 800, fontSize: '1.9rem', lineHeight: 1.1, fontVariantNumeric: 'tabular-nums',
            color: muted ? '#ff3b30' : 'inherit',
          }}>
            {muted ? 'MUTE' : vol == null ? '—' : vol}
          </Typography>
          {live.turning && volActive && live.dir ? (
            <Typography sx={{ fontSize: '1rem', color: '#39d98a', fontWeight: 800 }}>
              {live.dir > 0 ? '▲' : '▼'}
            </Typography>
          ) : null}
        </Box>
        <Box sx={{ height: 8, mt: 0.75, borderRadius: 4, bgcolor: 'rgba(255,255,255,0.14)', overflow: 'hidden' }}>
          <Box sx={{
            width: `${(muted ? 0 : volPct) * 100}%`, height: '100%', bgcolor: muted ? '#ff3b30' : ACCENT,
            transition: 'width 90ms linear',
          }} />
        </Box>
      </Card>
    </Box>
  )
}
