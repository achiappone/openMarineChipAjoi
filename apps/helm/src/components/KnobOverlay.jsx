import { Box, Typography } from '@mui/material'

// What the knob is doing, drawn where the knob physically is.
//
// Two pieces: a persistent readout that always says what the knob would change, and a
// circular popup that appears only while you're turning. The popup exists because a knob
// gives no feedback of its own — you need to see the value move as your hand moves, not
// read a number somewhere else on a busy screen.

const RANGES = {
  volume: { min: 0, max: 30, label: 'VOLUME', fmt: (v) => `${Math.round(v)}` },
  tune: { min: 87.9, max: 107.9, label: 'FM', fmt: (v) => `${Number(v).toFixed(1)}` },
  nav: { min: 0, max: 1, label: 'NAVIGATE', fmt: () => '—' },
  value: { min: 0, max: 1, label: 'ADJUST', fmt: (v) => `${v}` },
}

export function knobRange(mode) { return RANGES[mode] || RANGES.value }

// Persistent strip: sits under the softkeys so the knob always has a caption.
export function KnobReadout({ mode, value, sub, width }) {
  const r = knobRange(mode)
  return (
    <Box sx={{ width: width - 12, borderRadius: 1.5, px: 1, py: 0.75, textAlign: 'right',
      bgcolor: 'rgba(0,0,0,0.55)', border: '1px solid rgba(255,255,255,0.18)' }}>
      <Typography noWrap sx={{ fontSize: '0.62rem', letterSpacing: 1, fontWeight: 800, opacity: 0.6 }}>KNOB</Typography>
      <Typography noWrap sx={{ fontWeight: 800, fontSize: '1.25rem', lineHeight: 1.15, color: '#39c6d8' }}>
        {value == null ? r.label : r.fmt(value)}
      </Typography>
      <Typography noWrap sx={{ fontSize: '0.68rem', opacity: 0.7 }}>{sub || r.label}</Typography>
    </Box>
  )
}

// The dial itself, sized by its container. Rendered inside the fourth softkey slot
// while the knob is turning: the label says what the knob does, and the moment you
// touch it the same space shows what it's doing. No extra furniture on screen.
export function KnobDial({ mode, value, dir, sub, presets = [], corner = true }) {
  const r = knobRange(mode)
  const span = r.max - r.min || 1
  const frac = value == null ? 0 : Math.max(0, Math.min(1, (Number(value) - r.min) / span))

  // Sunk into the corner, only the left half of the circle is on screen. So everything
  // lives in that half: the scale spans the visible semicircle (90deg at the bottom,
  // through 180deg at the left, to 270deg at the top) and the text sits left of centre
  // rather than at it. Centred text would be sliced in half by the screen edge.
  const CX = 60, CY = 60
  const TX = corner ? 30 : 60                    // text anchor within the visible half
  const START = corner ? 90 : 130
  const ARC = corner ? 180 : 280
  const pol = (deg, rad) => {
    const a = (deg * Math.PI) / 180
    return [CX + rad * Math.cos(a), CY + rad * Math.sin(a)]
  }
  const arcPath = (rad, from, to) => {
    const [x0, y0] = pol(from, rad)
    const [x1, y1] = pol(to, rad)
    return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${rad} ${rad} 0 ${Math.abs(to - from) > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`
  }
  const ang = (f) => START + ARC * Math.max(0, Math.min(1, (f - r.min) / span))

  if (mode === 'tune') {
    const ticks = []
    for (let f = Math.ceil(r.min); f <= r.max; f += 1) {
      const major = Math.abs(f % 5) < 0.01
      const [x1, y1] = pol(ang(f), 54)
      const [x2, y2] = pol(ang(f), major ? 44 : 49)
      ticks.push(<line key={f} x1={x1} y1={y1} x2={x2} y2={y2}
        stroke={major ? 'rgba(255,255,255,0.8)' : 'rgba(255,255,255,0.35)'} strokeWidth={major ? 2 : 1} />)
    }
    const [nx, ny] = pol(ang(Number(value) || r.min), 42)
    return (
      <svg viewBox="0 0 120 120" style={{ width: '100%', height: 'auto', display: 'block' }}>
        <circle cx={CX} cy={CY} r="58" fill="rgba(4,7,11,0.9)" stroke="rgba(57,198,216,0.55)" strokeWidth="1.5" />
        {ticks}
        {presets.map((p, i) => {
          const [px, py] = pol(ang(p.freq), 54)
          const near = value != null && Math.abs(p.freq - value) < 0.05
          return <circle key={i} cx={px} cy={py} r={near ? 3.6 : 2.3} fill={near ? '#39d98a' : '#39c6d8'} opacity={near ? 1 : 0.8} />
        })}
        <line x1={CX} y1={CY} x2={nx} y2={ny} stroke="#fff" strokeWidth="2.5" strokeLinecap="round"
          style={{ transition: 'all 90ms linear' }} />
        <circle cx={CX} cy={CY} r="3.5" fill="#fff" />
        <text x={TX} y={CY - 2} textAnchor="middle" fontSize="26" fontWeight="800" fill="#fff" fontFamily="inherit">
          {value == null ? '—' : Number(value).toFixed(1)}
        </text>
        <text x={TX} y={CY + 13} textAnchor="middle" fontSize="10" letterSpacing="1" fontWeight="700"
          fill="rgba(255,255,255,0.75)" fontFamily="inherit">{sub || 'FM'}</text>
      </svg>
    )
  }

  return (
    <svg viewBox="0 0 120 120" style={{ width: '100%', height: 'auto', display: 'block' }}>
      <circle cx={CX} cy={CY} r="58" fill="rgba(4,7,11,0.9)" stroke="rgba(57,198,216,0.55)" strokeWidth="1.5" />
      <path d={arcPath(46, START, START + ARC)} fill="none" stroke="rgba(255,255,255,0.16)" strokeWidth="9" strokeLinecap="round" />
      {frac > 0.001 ? (
        <path d={arcPath(46, START, START + ARC * frac)} fill="none" stroke="#39c6d8" strokeWidth="9" strokeLinecap="round"
          style={{ transition: 'd 90ms linear' }} />
      ) : null}
      {dir ? (() => {
        const [ax, ay] = pol(START + ARC * frac, 46)
        return (
          <g transform={`translate(${ax} ${ay}) rotate(${dir > 0 ? -90 : 90})`}>
            <path d="M -7 5 L 0 -5 L 7 5" fill="none" stroke="#39d98a" strokeWidth="3.5"
              strokeLinecap="round" strokeLinejoin="round" />
          </g>
        )
      })() : null}
      <text x={TX} y={CY + 4} textAnchor="middle" fontSize="34" fontWeight="800" fill="#fff" fontFamily="inherit">
        {value == null ? '—' : r.fmt(value)}
      </text>
      <text x={TX} y={CY + 20} textAnchor="middle" fontSize="11" letterSpacing="1" fontWeight="700"
        fill="rgba(255,255,255,0.75)" fontFamily="inherit">{sub || r.label}</text>
    </svg>
  )
}

export default function KnobOverlay({ mode, value, dir, visible, geom, sub }) {
  const r = knobRange(mode)
  const span = r.max - r.min || 1
  const frac = value == null ? 0 : Math.max(0, Math.min(1, (Number(value) - r.min) / span))
  const size = geom.knobSize
  const R = 46, C = 2 * Math.PI * R
  return (
    <Box sx={{
      position: 'fixed', right: `${geom.knobRight}%`, top: `${geom.knobTop}%`,
      width: size, height: size, transform: 'translate(50%, -50%)',
      pointerEvents: 'none', zIndex: 1400,
      opacity: visible ? 1 : 0,
      transition: visible ? 'opacity 60ms linear' : 'opacity 420ms ease-out',
    }}>
      <svg viewBox="0 0 120 120" style={{ width: '100%', height: '100%', display: 'block' }}>
        <circle cx="60" cy="60" r="56" fill="rgba(4,7,11,0.88)" stroke="rgba(255,255,255,0.2)" strokeWidth="1.5" />
        {/* value ring */}
        <circle cx="60" cy="60" r={R} fill="none" stroke="rgba(255,255,255,0.14)" strokeWidth="7" />
        <circle cx="60" cy="60" r={R} fill="none" stroke="#39c6d8" strokeWidth="7" strokeLinecap="round"
          strokeDasharray={`${(frac * C).toFixed(1)} ${C.toFixed(1)}`} transform="rotate(-90 60 60)" />
        {/* direction chevron: which way the value is going, not which way the shaft spun */}
        {dir ? (
          <g transform={`translate(60 ${dir > 0 ? 26 : 94}) ${dir > 0 ? '' : 'rotate(180)'}`}>
            <path d="M -9 5 L 0 -5 L 9 5" fill="none" stroke="#39d98a" strokeWidth="3.5"
              strokeLinecap="round" strokeLinejoin="round" />
          </g>
        ) : null}
        <text x="60" y="66" textAnchor="middle" fontSize="30" fontWeight="800" fill="#fff" fontFamily="inherit">
          {value == null ? '—' : r.fmt(value)}
        </text>
        <text x="60" y="84" textAnchor="middle" fontSize="11" letterSpacing="1.5" fontWeight="700"
          fill="rgba(255,255,255,0.65)" fontFamily="inherit">
          {sub || r.label}
        </text>
      </svg>
    </Box>
  )
}
