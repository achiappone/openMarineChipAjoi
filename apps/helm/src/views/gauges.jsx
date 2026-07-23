// Lightweight SVG marine gauges. No chart library — plain SVG, updated at the
// SignalK hook's ~4Hz, so they cost a fraction of the KIP webapp they replace.
// All are theme-dark and render a graceful empty state (needle at min / "—").

// Suzuki SMIS palette: monochrome white scale/needle on black, red only for the
// redline zone and warnings, amber caution, green for good/charging.
const BLUE = '#eef4f8' // "primary" is near-white on this instrument
const GREEN = '#39d98a'
const AMBER = '#ffb52e'
const RED = '#ff3b30'
const TRACK = 'rgba(255,255,255,0.16)'
const TXT = '#ffffff'
const DIM = 'rgba(255,255,255,0.55)'
export const GAUGE_BG = '#04070b' // near-black card face

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x)
const polar = (cx, cy, r, deg) => { const a = (deg * Math.PI) / 180; return [cx + r * Math.cos(a), cy + r * Math.sin(a)] }
// SVG arc path between two angles (degrees, SVG convention: 0=right, 90=down).
function arc(cx, cy, r, a0, a1) {
  const [x0, y0] = polar(cx, cy, r, a0)
  const [x1, y1] = polar(cx, cy, r, a1)
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0
  const sweep = a1 > a0 ? 1 : 0
  return `M ${x0.toFixed(2)} ${y0.toFixed(2)} A ${r} ${r} 0 ${large} ${sweep} ${x1.toFixed(2)} ${y1.toFixed(2)}`
}

// 270° arc gauge (gap at the bottom) with tick marks, a needle, and an optional
// redline. `zones`: [{from,to,color}] as fractions 0..1. `ticks`: number of major
// divisions. `redline`: fraction 0..1 that colours the value red past it.
export function ArcGauge({ label, value, unit, min = 0, max = 10, decimals = 1, color = BLUE, zones, ticks = 6, redline }) {
  const START = 135, SWEEP = 270
  const has = value != null && isFinite(value)
  const frac = has ? clamp01((value - min) / (max - min)) : 0
  const hot = redline != null && frac >= redline
  const cx = 100, cy = 100, r = 74, sw = 13
  const fillColor = hot ? RED : color

  const tickEls = []
  for (let i = 0; i <= ticks; i++) {
    const f = i / ticks
    const a = START + SWEEP * f
    const inR = r - sw / 2 - 3
    const [x1, y1] = polar(cx, cy, r + sw / 2 + 2, a)
    const [x2, y2] = polar(cx, cy, inR, a)
    const past = redline != null && f > redline + 0.001
    tickEls.push(<line key={`t${i}`} x1={x1} y1={y1} x2={x2} y2={y2} stroke={past ? RED : DIM} strokeWidth={2} opacity={past ? 0.9 : 0.7} />)
  }

  const nAng = START + SWEEP * frac
  const [nx, ny] = polar(cx, cy, r - 2, nAng)
  const [tailx, taily] = polar(cx, cy, 14, nAng + 180)

  return (
    <svg viewBox="0 0 200 200" style={{ width: '100%', height: '100%', display: 'block' }}>
      <path d={arc(cx, cy, r, START, START + SWEEP)} stroke={TRACK} strokeWidth={sw} fill="none" strokeLinecap="round" />
      {(zones || []).map((z, i) => (
        <path key={i} d={arc(cx, cy, r, START + SWEEP * z.from, START + SWEEP * z.to)} stroke={z.color} strokeWidth={sw} fill="none" strokeLinecap="butt" opacity={0.6} />
      ))}
      {redline != null && (
        <path d={arc(cx, cy, r, START + SWEEP * redline, START + SWEEP)} stroke={RED} strokeWidth={sw} fill="none" strokeLinecap="butt" opacity={0.35} />
      )}
      {has && frac > 0 && (
        <path d={arc(cx, cy, r, START, START + SWEEP * frac)} stroke={fillColor} strokeWidth={sw} fill="none" strokeLinecap="round" />
      )}
      {tickEls}
      {has && (
        <>
          <line x1={tailx} y1={taily} x2={nx} y2={ny} stroke={fillColor} strokeWidth={4} strokeLinecap="round" />
          <circle cx={cx} cy={cy} r={7} fill={TXT} />
        </>
      )}
      <text x={cx} y={cy + 42} textAnchor="middle" fontSize="42" fontWeight="800" fill={hot ? RED : TXT} fontFamily="inherit">
        {has ? value.toFixed(decimals) : '—'}
      </text>
      {unit ? <text x={cx} y={cy + 62} textAnchor="middle" fontSize="15" fill={DIM} fontFamily="inherit">{unit}</text> : null}
      <text x={cx} y={cy + 86} textAnchor="middle" fontSize="15" fontWeight="700" letterSpacing="2" fill={DIM} fontFamily="inherit">{label}</text>
    </svg>
  )
}

// Suzuki SMIS-style analog tachometer: dense white tick marks on black, numbered
// majors (×1000), white needle, red redline zone, "×1000 r/min" centre text, and a
// digital r/min readout in the lower opening. Tall, fills a full-height centre cell.
export function TachGauge({ value, min = 0, max = 7000, redline = 0.857, label = 'r/min' }) {
  const START = 135, SWEEP = 270
  const has = value != null && isFinite(value)
  const frac = has ? clamp01((value - min) / (max - min)) : 0
  const hot = frac >= redline
  const cx = 110, cy = 112, r = 96
  const majors = Math.round(max / 1000)   // one numbered tick per 1000 rpm
  const steps = majors * 5                // 5 minor ticks between majors

  const tk = []
  for (let i = 0; i <= steps; i++) {
    const f = i / steps
    const a = START + SWEEP * f
    const major = i % 5 === 0
    const past = f > redline + 0.002
    const [x1, y1] = polar(cx, cy, r, a)
    const [x2, y2] = polar(cx, cy, r - (major ? 20 : 11), a)
    tk.push(<line key={`t${i}`} x1={x1} y1={y1} x2={x2} y2={y2} stroke={past ? RED : major ? TXT : DIM} strokeWidth={major ? 3.5 : 1.8} strokeLinecap="round" />)
    if (major) {
      const [lx, ly] = polar(cx, cy, r - 36, a)
      tk.push(<text key={`n${i}`} x={lx} y={ly + 6} textAnchor="middle" fontSize="19" fontWeight="700" fill={past ? RED : TXT} fontFamily="inherit">{Math.round((max * f) / 1000)}</text>)
    }
  }
  const nAng = START + SWEEP * frac
  const [nx, ny] = polar(cx, cy, r - 8, nAng)
  const [tx, ty] = polar(cx, cy, 22, nAng + 180)
  return (
    <svg viewBox="0 0 220 250" preserveAspectRatio="xMidYMid meet" style={{ width: '100%', height: '100%', display: 'block' }}>
      {/* redline arc on the outer rim */}
      <path d={arc(cx, cy, r + 5, START + SWEEP * redline, START + SWEEP)} stroke={RED} strokeWidth={5} fill="none" strokeLinecap="round" />
      {tk}
      <text x={cx} y={cy - 26} textAnchor="middle" fontSize="16" fontWeight="700" letterSpacing="1" fill={DIM} fontFamily="inherit">×1000</text>
      <text x={cx} y={cy - 8} textAnchor="middle" fontSize="13" fill={DIM} fontFamily="inherit">{label}</text>
      {has && <><line x1={tx} y1={ty} x2={nx} y2={ny} stroke={TXT} strokeWidth={5} strokeLinecap="round" /><circle cx={cx} cy={cy} r={9} fill={TXT} /></>}
      {/* digital r/min in the clear lower opening, below the 0/7 tick labels */}
      <text x={cx} y={cy + 108} textAnchor="middle" fontSize="44" fontWeight="800" fill={hot ? RED : TXT} fontFamily="inherit">{has ? Math.round(value) : '—'}</text>
      <text x={cx} y={cy + 128} textAnchor="middle" fontSize="14" fontWeight="700" letterSpacing="3" fill={DIM} fontFamily="inherit">RPM</text>
    </svg>
  )
}

// Tiny filled sparkline for a value's recent history. Stretches to fill its box.
export function Sparkline({ data, color = BLUE, min, max, height = 42 }) {
  const pts = (data || []).filter((v) => v != null && isFinite(v))
  const W = 100, H = height
  if (pts.length < 2) return <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height, display: 'block' }} />
  const lo = min != null ? min : Math.min(...pts)
  const hi = max != null ? max : Math.max(...pts)
  const rng = (hi - lo) || 1
  const step = W / (pts.length - 1)
  const line = pts.map((v, i) => `${(i * step).toFixed(1)},${(H - clamp01((v - lo) / rng) * (H - 4) - 2).toFixed(1)}`).join(' ')
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: '100%', height, display: 'block' }}>
      <polygon points={`0,${H} ${line} ${W},${H}`} fill={color} opacity={0.15} />
      <polyline points={line} fill="none" stroke={color} strokeWidth={2} vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  )
}

// Big status light for engine/system health. `level`: 'ok' | 'warn' | 'alarm' | 'unknown'.
export function StatusGauge({ label, level = 'unknown', detail }) {
  const map = {
    ok: { c: GREEN, t: 'OK' }, warn: { c: AMBER, t: 'WARNING' },
    alarm: { c: RED, t: 'ALARM' }, unknown: { c: DIM, t: '—' },
  }
  const s = map[level] || map.unknown
  return (
    <svg viewBox="0 0 200 200" style={{ width: '100%', height: '100%', display: 'block' }}>
      <circle cx="100" cy="86" r="52" fill="none" stroke={TRACK} strokeWidth="10" />
      <circle cx="100" cy="86" r="52" fill={s.c} opacity={level === 'unknown' ? 0.15 : 0.22} />
      <circle cx="100" cy="86" r="34" fill={s.c} opacity={level === 'unknown' ? 0.35 : 1} />
      <text x="100" y="150" textAnchor="middle" fontSize="24" fontWeight="800" fill={s.c} fontFamily="inherit">{s.t}</text>
      <text x="100" y="176" textAnchor="middle" fontSize="15" fontWeight="700" letterSpacing="1.5" fill={DIM} fontFamily="inherit">{detail || label}</text>
    </svg>
  )
}

// Compass: rotating outer card with cardinal ticks, fixed top pointer = heading.
// COG (if present) shown as a secondary tick.
export function CompassGauge({ heading, cog, label = 'HEADING' }) {
  const has = heading != null && isFinite(heading)
  const cx = 100, cy = 100, r = 82
  const rot = has ? -heading : 0 // rotate the card so the heading sits under the top pointer
  const ticks = []
  for (let d = 0; d < 360; d += 30) {
    const [x1, y1] = polar(cx, cy, r, d - 90)
    const [x2, y2] = polar(cx, cy, r - (d % 90 === 0 ? 16 : 9), d - 90)
    ticks.push(<line key={d} x1={x1} y1={y1} x2={x2} y2={y2} stroke={DIM} strokeWidth={d % 90 === 0 ? 2.5 : 1.5} />)
  }
  const card = ['N', 'E', 'S', 'W']
  return (
    <svg viewBox="0 0 200 200" style={{ width: '100%', height: '100%', display: 'block' }}>
      <circle cx={cx} cy={cy} r={r + 6} fill="none" stroke={TRACK} strokeWidth={2} />
      <g transform={`rotate(${rot} ${cx} ${cy})`}>
        {ticks}
        {card.map((c, i) => {
          const [x, y] = polar(cx, cy, r - 30, i * 90 - 90)
          return <text key={c} x={x} y={y + 6} textAnchor="middle" fontSize="18" fontWeight="800" fill={c === 'N' ? RED : DIM} fontFamily="inherit">{c}</text>
        })}
        {cog != null && isFinite(cog) && (() => { const [x, y] = polar(cx, cy, r, cog - 90); return <circle cx={x} cy={y} r={5} fill={GREEN} /> })()}
      </g>
      {/* fixed top pointer */}
      <polygon points={`${cx},${cy - r - 8} ${cx - 8},${cy - r + 8} ${cx + 8},${cy - r + 8}`} fill={BLUE} />
      <text x={cx} y={cy + 4} textAnchor="middle" fontSize="44" fontWeight="800" fill={TXT} fontFamily="inherit">{has ? `${Math.round(heading)}` : '—'}</text>
      <text x={cx} y={cy + 30} textAnchor="middle" fontSize="15" letterSpacing="2" fontWeight="700" fill={DIM} fontFamily="inherit">{label}{cog != null ? ' · COG●' : ''}</text>
    </svg>
  )
}

// Wind dial: boat bow at top; needle points to the wind's bearing relative to bow.
// Apparent wind angle is signed (− port / + starboard); coloured accordingly.
export function WindGauge({ angle, speed, label = 'APP WIND', unit = 'kn' }) {
  const has = angle != null && isFinite(angle)
  const cx = 100, cy = 100, r = 82
  const side = has ? (angle < 0 ? RED : GREEN) : DIM
  const ticks = []
  for (let d = 0; d < 360; d += 30) {
    const [x1, y1] = polar(cx, cy, r, d - 90)
    const [x2, y2] = polar(cx, cy, r - (d % 90 === 0 ? 14 : 8), d - 90)
    ticks.push(<line key={d} x1={x1} y1={y1} x2={x2} y2={y2} stroke={DIM} strokeWidth={d % 90 === 0 ? 2.5 : 1.5} />)
  }
  const needle = has ? polar(cx, cy, r - 12, angle - 90) : null
  return (
    <svg viewBox="0 0 200 200" style={{ width: '100%', height: '100%', display: 'block' }}>
      <circle cx={cx} cy={cy} r={r + 6} fill="none" stroke={TRACK} strokeWidth={2} />
      {ticks}
      {/* bow marker at top */}
      <polygon points={`${cx},${cy - r - 4} ${cx - 7},${cy - r + 12} ${cx + 7},${cy - r + 12}`} fill={DIM} />
      {needle && <line x1={cx} y1={cy} x2={needle[0]} y2={needle[1]} stroke={side} strokeWidth={5} strokeLinecap="round" />}
      {needle && <circle cx={needle[0]} cy={needle[1]} r={7} fill={side} />}
      <circle cx={cx} cy={cy} r={6} fill={TXT} />
      <text x={cx} y={cy - 18} textAnchor="middle" fontSize="40" fontWeight="800" fill={TXT} fontFamily="inherit">{speed != null && isFinite(speed) ? speed.toFixed(1) : '—'}</text>
      <text x={cx} y={cy + 2} textAnchor="middle" fontSize="14" fill={DIM} fontFamily="inherit">{unit}</text>
      <text x={cx} y={cy + 34} textAnchor="middle" fontSize="15" letterSpacing="1.5" fontWeight="700" fill={DIM} fontFamily="inherit">
        {label}{has ? ` · ${Math.round(Math.abs(angle))}°${angle < 0 ? 'P' : 'S'}` : ''}
      </text>
    </svg>
  )
}

export const GAUGE_COLORS = { BLUE, GREEN, AMBER, RED }
