// Lightweight SVG marine gauges. No chart library — plain SVG, updated at the
// SignalK hook's ~4Hz, so they cost a fraction of the KIP webapp they replace.
// All are theme-dark and render a graceful empty state (needle at min / "—").

// Suzuki SMIS palette: monochrome white scale/needle on black, red only for the
// redline zone and warnings, amber caution, green for good/charging.
const BLUE = '#eef4f8' // "primary" is near-white on this instrument
const GREEN = '#39d98a'
const AMBER = '#ffb52e'
const RED = '#ff3b30'
const TEAL = '#39c6d8' // Suzuki dial's cyan square block markers
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
// Suzuki warning-lamp glyphs (24x24, filled white). check=engine block, oil=oil can,
// water=water-in-fuel drop; temp (thermometer + coolant waves) is drawn separately.
const TACH_ICON = {
  check: 'M7,4V6H10V8H8A2,2 0 0,0 6,10V13H4V10H2V18H4V15H6V18A2,2 0 0,0 8,20H14V18H16L18.29,20.29L19.71,18.87L17.41,16.59L19,15H21V13H22V10H20V8H21V6H23V4H16V6H13V4H7Z',
  oil: 'M11,7H15V9H11V7M20,10.14V11H18V13H15V11H13.28C13.03,11.86 12.22,12.5 11.25,12.5C10.08,12.5 9.13,11.55 9.13,10.38C9.13,9.79 9.37,9.26 9.75,8.88L8,7.13V6H6V4H10L12,6H15V4H17V6H19.5C19.78,6 20,6.22 20,6.5V10.14M18,15H20V17.5C20,18.33 19.33,19 18.5,19H4.5C3.67,19 3,18.33 3,17.5V13.5C3,12.67 3.67,12 4.5,12H6V14H4.5V17.5H18.5V15H18M11.25,9.5A0.88,0.88 0 0,0 10.38,10.38A0.88,0.88 0 0,0 11.25,11.25A0.88,0.88 0 0,0 12.13,10.38A0.88,0.88 0 0,0 11.25,9.5Z',
  water: 'M12,20A6,6 0 0,1 6,14C6,10 12,3.25 12,3.25C12,3.25 18,10 18,14A6,6 0 0,1 12,20Z',
}
function LampGlyph({ k, color }) {
  if (k === 'temp') {
    return (
      <g>
        <path d="M12 3 a2.2 2.2 0 0 0 -2.2 2.2 V13 a3.4 3.4 0 1 0 4.4 0 V5.2 A2.2 2.2 0 0 0 12 3 Z" fill={color} />
        <path d="M3.5 20.5 q1.6 -1.7 3.2 0 t3.2 0 t3.2 0 t3.2 0" fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" />
      </g>
    )
  }
  return <path d={TACH_ICON[k]} fill={color} />
}

// Suzuki-style analog tach: cyan square block markers at each 1000-rpm major, thin
// minor ticks, a red needle, "×1000 r/min" under the hub, a digital readout, and a row
// of engine warning lamps (check / temp / oil / water-in-fuel) with the engine temp
// shown under the temp lamp. `indicators`: { check, temp, oil, water } each false | 'warn' | 'alarm'.
export function TachGauge({ value, min = 0, max = 7000, redline = 0.857, label = 'r/min', indicators, engTempF, onTempClick }) {
  const START = 135, SWEEP = 270
  const has = value != null && isFinite(value)
  const frac = has ? clamp01((value - min) / (max - min)) : 0
  const hot = frac >= redline
  const cx = 110, cy = 98, r = 86
  const majors = Math.round(max / 1000)   // one numbered tick per 1000 rpm
  const steps = majors * 5                // 5 minor ticks between majors

  const tk = []
  for (let i = 0; i <= steps; i++) {
    const f = i / steps
    const a = START + SWEEP * f
    const major = i % 5 === 0
    const past = f > redline + 0.002
    if (major) {
      const [bx, by] = polar(cx, cy, r - 5, a)
      tk.push(<rect key={`b${i}`} x={bx - 5} y={by - 5} width={10} height={10} rx={1.5}
        transform={`rotate(${a + 90} ${bx} ${by})`} fill={past ? RED : TEAL} />)
      const [lx, ly] = polar(cx, cy, r - 30, a)
      tk.push(<text key={`n${i}`} x={lx} y={ly + 6} textAnchor="middle" fontSize="19" fontWeight="700" fill={past ? RED : TXT} fontFamily="inherit">{Math.round((max * f) / 1000)}</text>)
    } else {
      const [x1, y1] = polar(cx, cy, r, a)
      const [x2, y2] = polar(cx, cy, r - 9, a)
      tk.push(<line key={`t${i}`} x1={x1} y1={y1} x2={x2} y2={y2} stroke={past ? RED : DIM} strokeWidth={2} strokeLinecap="round" />)
    }
  }
  const nAng = START + SWEEP * frac
  const [nx, ny] = polar(cx, cy, r - 12, nAng)
  const [tx, ty] = polar(cx, cy, 20, nAng + 180)

  const LAMPS = ['check', 'temp', 'oil', 'water']
  const litColor = (v) => (v === 'alarm' ? RED : v === 'warn' ? AMBER : null)
  const xs = [59, 93, 127, 161]
  const lampCy = 222

  return (
    <svg viewBox="0 0 220 258" preserveAspectRatio="xMidYMid meet" style={{ width: '100%', height: '100%', display: 'block' }}>
      {tk}
      {/* red needle + hub */}
      {has && <line x1={tx} y1={ty} x2={nx} y2={ny} stroke={RED} strokeWidth={5} strokeLinecap="round" />}
      <circle cx={cx} cy={cy} r={9} fill="#111" stroke={has ? TXT : DIM} strokeWidth={2} />
      {/* digital readout below the dial (clear of the 0/7 scale labels) + scale label */}
      <text x={cx} y={cy + 74} textAnchor="middle" fontSize="30" fontWeight="800" fill={hot ? RED : TXT} fontFamily="inherit">{has ? Math.round(value) : '—'}</text>
      <text x={cx} y={cy + 92} textAnchor="middle" fontSize="12" fontWeight="700" letterSpacing="0.5" fill={DIM} fontFamily="inherit">×1000 {label}</text>
      {/* engine warning lamps (Suzuki icons), lit red/amber when active */}
      {LAMPS.map((k, i) => {
        const c = litColor(indicators ? indicators[k] : false)
        const on = !!c
        return (
          <g key={k}>
            <rect x={xs[i] - 14} y={lampCy - 14} width={28} height={28} rx={6} fill={on ? c : 'rgba(255,255,255,0.06)'} stroke={on ? 'none' : TRACK} strokeWidth={1} />
            <g transform={`translate(${xs[i] - 9} ${lampCy - 9}) scale(0.75)`}><LampGlyph k={k} color={on ? '#fff' : DIM} /></g>
          </g>
        )
      })}
      {/* engine temperature under the TEMP lamp — tap to enlarge the engine-temp gauge */}
      {engTempF != null && <text x={xs[1]} y={lampCy + 27} textAnchor="middle" fontSize="12" fontWeight="700" fill={onTempClick ? TEAL : DIM} fontFamily="inherit">{Math.round(engTempF)}°F</text>}
      {onTempClick && <rect x={xs[1] - 22} y={lampCy - 18} width={44} height={56} fill="transparent" pointerEvents="all" style={{ cursor: 'pointer' }} onClick={onTempClick} />}
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

// Inclinometer / artificial horizon from the ADXL345: heel (roll) tilts the horizon,
// trim (pitch) shifts it up/down. Fixed boat reference in the centre; numbers below.
export function InclinometerGauge({ roll, pitch, label = 'HEEL / TRIM' }) {
  const has = roll != null && isFinite(roll)
  const r = has ? roll : 0
  const p = has ? (pitch || 0) : 0
  const cx = 100, cy = 96, R = 78
  const off = Math.max(-64, Math.min(64, p * 2.4)) // px offset for pitch
  const SKY = '#1e5f80', SEA = '#0a1c14', HLINE = '#e8eef2'
  const heelColor = Math.abs(r) >= 25 ? RED : Math.abs(r) >= 15 ? AMBER : GREEN
  const tick = []
  for (let a = -40; a <= 40; a += 10) {
    const rad = (a - 90) * Math.PI / 180
    const [x1, y1] = [cx + R * Math.cos(rad), cy + R * Math.sin(rad)]
    const [x2, y2] = [cx + (R - (a % 20 === 0 ? 12 : 7)) * Math.cos(rad), cy + (R - (a % 20 === 0 ? 12 : 7)) * Math.sin(rad)]
    tick.push(<line key={a} x1={x1} y1={y1} x2={x2} y2={y2} stroke={DIM} strokeWidth={a === 0 ? 3 : 1.8} />)
  }
  return (
    <svg viewBox="0 0 200 210" preserveAspectRatio="xMidYMid meet" style={{ width: '100%', height: '100%', display: 'block' }}>
      <defs><clipPath id="inclinoClip"><circle cx={cx} cy={cy} r={R} /></clipPath></defs>
      <g clipPath="url(#inclinoClip)">
        {has ? (
          <g transform={`rotate(${-r} ${cx} ${cy}) translate(0 ${off})`}>
            <rect x={cx - 240} y={cy - 300} width={480} height={300} fill={SKY} />
            <rect x={cx - 240} y={cy} width={480} height={300} fill={SEA} />
            <line x1={cx - 240} y1={cy} x2={cx + 240} y2={cy} stroke={HLINE} strokeWidth={2.5} />
            {[-20, -10, 10, 20].map((pl) => (
              <line key={pl} x1={cx - 16} y1={cy - pl * 2.4} x2={cx + 16} y2={cy - pl * 2.4} stroke="rgba(255,255,255,0.5)" strokeWidth={1.5} />
            ))}
          </g>
        ) : <rect x={cx - R} y={cy - R} width={R * 2} height={R * 2} fill="rgba(255,255,255,0.04)" />}
      </g>
      <circle cx={cx} cy={cy} r={R} fill="none" stroke={TRACK} strokeWidth={2.5} />
      {tick}
      {/* roll pointer at the top */}
      <polygon points={`${cx},${cy - R + 2} ${cx - 7},${cy - R + 14} ${cx + 7},${cy - R + 14}`} fill={heelColor} />
      {/* fixed boat reference */}
      <line x1={cx - 26} y1={cy} x2={cx - 10} y2={cy} stroke={AMBER} strokeWidth={3.5} />
      <line x1={cx + 10} y1={cy} x2={cx + 26} y2={cy} stroke={AMBER} strokeWidth={3.5} />
      <circle cx={cx} cy={cy} r={3.5} fill={AMBER} />
      <text x={cx} y={cy + R + 30} textAnchor="middle" fontSize="26" fontWeight="800" fill={heelColor} fontFamily="inherit">{has ? `${Math.abs(Math.round(r))}°` : '—'}</text>
      <text x={cx} y={cy + R + 30} dx="-58" textAnchor="middle" fontSize="12" fill={DIM} fontFamily="inherit">HEEL{has ? (r < 0 ? ' P' : ' S') : ''}</text>
      <text x={cx} y={cy + R + 30} dx="58" textAnchor="middle" fontSize="15" fontWeight="700" fill={TXT} fontFamily="inherit">{has ? `${p >= 0 ? '+' : ''}${Math.round(p)}°` : ''}</text>
      <text x={cx} y={cy + R + 30} dx="58" dy="14" textAnchor="middle" fontSize="11" fill={DIM} fontFamily="inherit">TRIM</text>
    </svg>
  )
}

export const GAUGE_COLORS = { BLUE, GREEN, AMBER, RED }
