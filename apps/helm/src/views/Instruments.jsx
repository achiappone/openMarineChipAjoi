import { useState, useEffect, useRef } from 'react'
import { Box, Paper, Stack, Typography, Chip } from '@mui/material'
import WbSunnyIcon from '@mui/icons-material/WbSunny'
import AcUnitIcon from '@mui/icons-material/AcUnit'
import ThermostatIcon from '@mui/icons-material/Thermostat'
import useSignalKData, { skCelsius, skValue, skDeg, skMeters, skKnots, M_TO_FT } from '../hooks/useSignalKData'
import { ArcGauge, TachGauge, CompassGauge, StatusGauge, Sparkline, GAUGE_COLORS, GAUGE_BG } from './gauges'

const M3S_TO_GPH = 951019.39 // m³/s → US gallons/hour
const CARD16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
const cardinal = (d) => (d == null ? '' : CARD16[Math.round(d / 22.5) % 16])
const fmt = (v, d = 1) => (v == null ? '—' : v.toFixed(d))
const findPath = (values, re) => Object.keys(values).find((p) => re.test(p))
const numAt = (values, p) => { const e = p && values[p]; return e && typeof e.value === 'number' && isFinite(e.value) ? e.value : null }

// Trip odometer: accumulate GPS distance (nm), max speed, start time; persist so it
// survives reloads. Reset by clearing localStorage 'helm.trip'.
function useTrip(pos, sogKn) {
  const [trip, setTrip] = useState(() => { try { return JSON.parse(localStorage.getItem('helm.trip')) || {} } catch (e) { return {} } })
  const last = useRef(null)
  useEffect(() => {
    if (!pos || typeof pos.latitude !== 'number') return
    const prev = last.current; last.current = pos
    if (!prev) return
    const toRad = (d) => (d * Math.PI) / 180
    const dLat = toRad(pos.latitude - prev.latitude), dLon = toRad(pos.longitude - prev.longitude)
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(prev.latitude)) * Math.cos(toRad(pos.latitude)) * Math.sin(dLon / 2) ** 2
    const d = 2 * 3440.065 * Math.asin(Math.min(1, Math.sqrt(a))) // nautical miles
    if (d > 0.0003 && d < 2) {
      setTrip((p) => { const nt = { distance: (p.distance || 0) + d, start: p.start || Date.now(), maxSog: Math.max(p.maxSog || 0, sogKn || 0) }; try { localStorage.setItem('helm.trip', JSON.stringify(nt)) } catch (e) {} return nt })
    }
  }, [pos]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onReset = () => { last.current = null; setTrip({}) }
    window.addEventListener('helm.trip.reset', onReset)
    return () => window.removeEventListener('helm.trip.reset', onReset)
  }, [])
  return trip
}

// Sample the latest value once a second into a rolling window, for the sparklines.
function useHistory(value, n = 60, everyMs = 1000) {
  const [hist, setHist] = useState([])
  const v = useRef(value); v.current = value
  useEffect(() => {
    const t = setInterval(() => setHist((h) => [...h, v.current].slice(-n)), everyMs)
    return () => clearInterval(t)
  }, [n, everyMs])
  return hist
}

// Demo: synthesize animated SignalK values so the gauges move with no live data.
function useDemoValues(active) {
  const [vals, setVals] = useState({})
  useEffect(() => {
    if (!active) { setVals({}); return undefined }
    const start = performance.now()
    let timer
    const tick = () => {
      const t = (performance.now() - start) / 1000
      const s = (period, lo, hi, ph = 0) => lo + (hi - lo) * (0.5 + 0.5 * Math.sin((t * 2 * Math.PI) / period + ph))
      const phase = Math.floor(t / 6) % 3
      const m = {
        'propulsion.main.revolutions': { value: s(9, 700, 6100) / 60 },
        'propulsion.main.coolantTemperature': { value: s(20, 62, 104) + 273.15 },
        'propulsion.main.fuel.rate': { value: s(17, 3, 38) / M3S_TO_GPH },
        'tanks.fuel.0.currentLevel': { value: s(120, 0.22, 0.85) },
        'electrical.batteries.house.voltage': { value: s(15, 11.8, 14.4) },
        'electrical.batteries.house.current': { value: s(11, -22, 45, 1) },
        'environment.outside.temperature': { value: s(30, 19, 27) + 273.15 },
        'environment.depth.belowTransducer': { value: s(13, 1.8, 44) },
        'navigation.headingMagnetic': { value: (((t * 14) % 360) * Math.PI) / 180 },
        'navigation.courseOverGroundTrue': { value: ((((t * 14) + 9) % 360) * Math.PI) / 180 },
        'navigation.speedOverGround': { value: s(20, 0, 42) / 1.94384 },
        'propulsion.main.transmission.gear': { value: ['neutral', 'forward', 'forward', 'reverse'][Math.floor(t / 7) % 4] },
        'propulsion.main.runTime': { value: 1234620 + t },
        'navigation.position': { value: { latitude: 27.9506 + 0.006 * Math.sin(t / 4), longitude: -82.4572 + 0.006 * Math.cos(t / 4) } },
      }
      if (phase === 1) m['notifications.propulsion.main.oil'] = { value: { state: 'warn', message: 'Low oil pressure' } }
      if (phase === 2) m['notifications.propulsion.main.temp'] = { value: { state: 'alarm', message: 'Engine overheat' } }
      setVals(m)
      timer = setTimeout(tick, 200)
    }
    tick()
    return () => clearTimeout(timer)
  }, [active])
  return vals
}

function engineStatus(values) {
  const rank = { normal: 0, nominal: 0, alert: 1, warn: 2, alarm: 3, emergency: 4 }
  let level = null, msg = ''
  for (const p of Object.keys(values)) {
    if (!p.startsWith('notifications.')) continue
    const v = values[p].value
    const st = v && v.state ? v.state : ''
    const r = rank[st] != null ? rank[st] : (st ? 1 : 0)
    if (level == null || r > level) { level = r; if (v && v.message && r >= 1) msg = v.message }
  }
  if (level == null) return { level: 'ok', detail: 'ENGINE' }
  if (level >= 3) return { level: 'alarm', detail: msg.slice(0, 22) || 'ALARM' }
  if (level >= 1) return { level: 'warn', detail: msg.slice(0, 22) || 'CHECK' }
  return { level: 'ok', detail: 'ENGINE' }
}

// Suzuki-style F / N / R gear indicator — overlaid on the tach. Only shown when the
// engine actually reports gear (PGN 127493); most mechanical-shift outboards don't.
function GearIndicator({ gear }) {
  const rows = [['F', GAUGE_COLORS.GREEN], ['N', '#ffffff'], ['R', GAUGE_COLORS.AMBER]]
  return (
    <Box sx={{ position: 'absolute', top: 18, left: 18, display: 'flex', flexDirection: 'column', gap: 0.5,
      bgcolor: 'rgba(0,0,0,0.5)', borderRadius: 2, px: 2, py: 1, border: '1px solid rgba(255,255,255,0.22)' }}>
      {rows.map(([g, c]) => (
        <Typography key={g} sx={{ fontWeight: 900, fontSize: '2.6rem', lineHeight: 1.02, color: gear === g ? c : 'rgba(255,255,255,0.18)' }}>{g}</Typography>
      ))}
    </Box>
  )
}
function GaugeCard({ children, sx }) {
  return (
    <Paper sx={{ p: 1.25, bgcolor: GAUGE_BG, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', ...sx }}>
      <Box sx={{ width: '100%', height: '100%', minHeight: 0 }}>{children}</Box>
    </Paper>
  )
}
function Tile({ label, value, unit, sub, accent, icon, children, sx, valueSize }) {
  return (
    <Paper sx={{ p: 1.75, bgcolor: GAUGE_BG, display: 'flex', flexDirection: 'column', justifyContent: 'center', minHeight: 0, overflow: 'hidden', ...sx }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between">
        <Typography noWrap sx={{ opacity: 0.55, fontSize: '0.78rem', letterSpacing: 1.5, fontWeight: 700 }}>{label}</Typography>
        {icon ? <Box sx={{ color: accent || 'text.secondary', display: 'flex', '& svg': { fontSize: 24 } }}>{icon}</Box> : null}
      </Stack>
      <Stack direction="row" alignItems="baseline" spacing={0.75} sx={{ minWidth: 0 }}>
        <Typography noWrap sx={{ fontWeight: 800, fontSize: valueSize || '2.1rem', lineHeight: 1.15, color: accent || 'text.primary' }}>{value}</Typography>
        {unit ? <Typography sx={{ opacity: 0.6, fontSize: '1rem', fontWeight: 600 }}>{unit}</Typography> : null}
      </Stack>
      {sub ? <Typography noWrap sx={{ opacity: 0.5, fontSize: '0.78rem' }}>{sub}</Typography> : null}
      {children}
    </Paper>
  )
}
// Horizontal fuel-level bar (E → F), Suzuki-style. Only rendered when a tank sensor exists.
function FuelLevelTile({ pct }) {
  const has = pct != null
  const low = has && pct <= 0.15
  return (
    <Paper sx={{ p: 1.75, bgcolor: GAUGE_BG, display: 'flex', flexDirection: 'column', justifyContent: 'center', minHeight: 0 }}>
      <Stack direction="row" justifyContent="space-between" sx={{ mb: 0.5 }}>
        <Typography sx={{ opacity: 0.55, fontSize: '0.78rem', letterSpacing: 1.5, fontWeight: 700 }}>FUEL</Typography>
        <Typography sx={{ fontWeight: 800, fontSize: '1.1rem', color: low ? GAUGE_COLORS.RED : 'text.primary' }}>{has ? `${Math.round(pct * 100)}%` : '—'}</Typography>
      </Stack>
      <Stack direction="row" alignItems="center" spacing={1}>
        <Typography sx={{ opacity: 0.6, fontWeight: 700 }}>E</Typography>
        <Box sx={{ flex: 1, height: 16, borderRadius: 1, bgcolor: 'rgba(255,255,255,0.14)', overflow: 'hidden' }}>
          <Box sx={{ height: '100%', width: `${(has ? pct : 0) * 100}%`, bgcolor: low ? GAUGE_COLORS.RED : pct <= 0.25 ? GAUGE_COLORS.AMBER : GAUGE_COLORS.GREEN, transition: 'width .3s' }} />
        </Box>
        <Typography sx={{ opacity: 0.6, fontWeight: 700 }}>F</Typography>
      </Stack>
    </Paper>
  )
}

// Combined battery readout: voltage + current together, with a voltage sparkline.
function BatteryTile({ v, a, hist }) {
  const acc = v == null ? undefined : v < 11.9 ? GAUGE_COLORS.RED : v < 12.4 ? GAUGE_COLORS.AMBER : GAUGE_COLORS.GREEN
  return (
    <Paper sx={{ p: 1.5, bgcolor: GAUGE_BG, flex: 1.5, display: 'flex', flexDirection: 'column', justifyContent: 'center', minHeight: 0, overflow: 'hidden' }}>
      <Typography sx={{ opacity: 0.55, fontSize: '0.78rem', letterSpacing: 1.5, fontWeight: 700 }}>BATTERY</Typography>
      <Stack direction="row" alignItems="baseline" spacing={2} sx={{ minWidth: 0 }}>
        <Stack direction="row" alignItems="baseline" spacing={0.5}>
          <Typography sx={{ fontWeight: 800, fontSize: '2rem', lineHeight: 1.1, color: acc || 'text.primary' }}>{v == null ? '—' : v.toFixed(2)}</Typography>
          <Typography sx={{ opacity: 0.6, fontSize: '0.95rem', fontWeight: 600 }}>V</Typography>
        </Stack>
        <Stack direction="row" alignItems="baseline" spacing={0.5}>
          <Typography sx={{ fontWeight: 800, fontSize: '1.5rem', lineHeight: 1.1, color: a == null ? 'text.primary' : a < 0 ? GAUGE_COLORS.AMBER : GAUGE_COLORS.GREEN }}>{a == null ? '—' : `${a >= 0 ? '+' : ''}${a.toFixed(0)}`}</Typography>
          <Typography sx={{ opacity: 0.6, fontSize: '0.9rem', fontWeight: 600 }}>A {a == null ? '' : a < 0 ? 'draw' : 'chg'}</Typography>
        </Stack>
      </Stack>
      <Box sx={{ mt: 0.25 }}><Sparkline data={hist} color={GAUGE_COLORS.GREEN} min={11} max={15} height={30} /></Box>
    </Paper>
  )
}

export default function Instruments() {
  const [demo, setDemo] = useState(true)
  const live = useSignalKData()
  const demoVals = useDemoValues(demo)
  const connected = demo ? true : live.connected
  const values = demo ? demoVals : live.values

  const rpmHz = numAt(values, findPath(values, /^propulsion\..+\.revolutions$/))
  const rpm = rpmHz == null ? null : rpmHz * 60
  const engTemp = (() => { const v = numAt(values, findPath(values, /^propulsion\..+\.(coolantTemperature|temperature)$/)); return v == null ? null : v - 273.15 })()
  const fuelRate = (() => { const v = numAt(values, findPath(values, /^propulsion\..+\.fuel\.rate$/)); return v == null ? null : v * M3S_TO_GPH })()
  const fuelLevel = numAt(values, findPath(values, /^tanks\.fuel\..+\.currentLevel$/))
  const engStatus = engineStatus(values)
  const battV = numAt(values, findPath(values, /^electrical\.batteries\..+\.voltage$/))
  const battA = numAt(values, findPath(values, /^electrical\.batteries\..+\.current$/))
  const airT = skCelsius(values, 'environment.outside.temperature')
  const depth = skMeters(values, 'environment.depth.belowTransducer')
  const hdg = skDeg(values, 'navigation.headingTrue')
  const hdgM = skDeg(values, 'navigation.headingMagnetic')
  const heading = hdg != null ? hdg : hdgM
  const cog = skDeg(values, 'navigation.courseOverGroundTrue')
  const sog = skKnots(values, 'navigation.speedOverGround')
  const engHours = (() => { const v = numAt(values, findPath(values, /^propulsion\..+\.runTime$/)); return v == null ? null : v / 3600 })()
  const gear = (() => {
    const gp = findPath(values, /^propulsion\..+\.(transmission\.)?gear$/)
    const gv = gp && values[gp] ? String(values[gp].value).toLowerCase() : null
    if (gv == null) return null
    if (gv.includes('forward') || gv === '1') return 'F'
    if (gv.includes('reverse') || gv === '-1' || gv === '2') return 'R'
    if (gv.includes('neutral') || gv === '0') return 'N'
    return null
  })()
  const pos = skValue(values, 'navigation.position')

  const trip = useTrip(pos, sog)
  useEffect(() => { if (engHours != null) { try { localStorage.setItem('helm.engineHours', String(engHours)) } catch (e) {} } }, [engHours])
  const battHist = useHistory(battV)
  const fuelHist = useHistory(fuelRate)

  const posStr = pos && typeof pos.latitude === 'number'
    ? `${Math.abs(pos.latitude).toFixed(5)}° ${pos.latitude >= 0 ? 'N' : 'S'}   ${Math.abs(pos.longitude).toFixed(5)}° ${pos.longitude >= 0 ? 'E' : 'W'}`
    : null

  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', p: 1.5, gap: 1.5, overflow: 'hidden' }}>
      <Stack direction="row" alignItems="center" spacing={1.5} sx={{ flexShrink: 0 }}>
        <Typography sx={{ fontWeight: 800, fontSize: '1.5rem' }}>Instruments</Typography>
        <Chip size="small" color={demo ? 'info' : connected ? 'success' : 'default'} variant="filled" label={demo ? 'demo' : connected ? 'live' : 'offline'} />
        <Box sx={{ flex: 1 }} />
        <Chip size="small" clickable onClick={() => setDemo((d) => !d)} color={demo ? 'primary' : 'default'} variant={demo ? 'filled' : 'outlined'} label={demo ? 'Demo ON — tap to stop' : 'Demo'} />
      </Stack>

      {/* Main area — RPM dead centre, full height; gauges fill left & right. */}
      <Box sx={{ flex: 1, minHeight: 0, display: 'flex', gap: 1.5 }}>
        <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          <GaugeCard sx={{ flex: 1 }}><ArcGauge label="SPEED kn" value={sog} unit="kn" min={0} max={50} decimals={1} ticks={5} color={GAUGE_COLORS.BLUE} /></GaugeCard>
          <GaugeCard sx={{ flex: 1 }}><ArcGauge label="ENGINE °C" value={engTemp} unit="°C" min={0} max={120} decimals={0} ticks={6} redline={0.83} zones={[{ from: 0.66, to: 0.83, color: GAUGE_COLORS.AMBER }]} color={GAUGE_COLORS.BLUE} /></GaugeCard>
        </Box>

        <Box sx={{ flex: 1.5, minWidth: 0, position: 'relative' }}>
          <GaugeCard sx={{ height: '100%' }}><TachGauge value={rpm} min={0} max={7000} redline={0.857} /></GaugeCard>
          {gear ? <GearIndicator gear={gear} /> : null}
        </Box>

        <Box sx={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 1.5 }}>
          <GaugeCard sx={{ flex: 1.3 }}><CompassGauge heading={heading} cog={cog} /></GaugeCard>
          <GaugeCard sx={{ flex: 1 }}><StatusGauge label="ENGINE" level={engStatus.level} detail={engStatus.detail} /></GaugeCard>
        </Box>
      </Box>

      {/* Bottom strip — combined battery, fuel, depth number, ambient, position. */}
      <Box sx={{ flexShrink: 0, display: 'flex', gap: 1.5, height: 132 }}>
        <BatteryTile v={battV} a={battA} hist={battHist} />
        <Tile label="FUEL FLOW" value={fmt(fuelRate, 1)} unit={fuelRate == null ? '' : 'gph'} sx={{ flex: 1.4 }} accent={GAUGE_COLORS.BLUE}>
          <Box sx={{ mt: 0.25 }}><Sparkline data={fuelHist} color={GAUGE_COLORS.BLUE} min={0} height={30} /></Box>
        </Tile>
        {fuelLevel != null ? <Box sx={{ flex: 1.2, display: 'flex' }}><FuelLevelTile pct={fuelLevel} /></Box> : null}
        <Tile label="DEPTH" value={depth == null ? '—' : fmt(depth * M_TO_FT, 0)} unit={depth == null ? '' : 'ft'} sx={{ flex: 0.9 }} accent={GAUGE_COLORS.BLUE} />
        <Tile label="AMBIENT" value={airT == null ? '—' : fmt(airT, 1)} unit={airT == null ? '' : '°C'} sx={{ flex: 0.9 }}
          icon={airT == null ? <ThermostatIcon /> : airT < 10 ? <AcUnitIcon /> : airT > 25 ? <WbSunnyIcon /> : <ThermostatIcon />}
          accent={airT == null ? undefined : airT < 10 ? GAUGE_COLORS.BLUE : airT > 25 ? GAUGE_COLORS.AMBER : undefined} />
        <Tile label="TRIP" value={trip.distance ? trip.distance.toFixed(1) : '0.0'} unit="nm" sx={{ flex: 0.9 }} accent={GAUGE_COLORS.BLUE} />
        <Tile label="POSITION" value={posStr || '—'} valueSize="1.35rem" sx={{ flex: 2 }} accent={GAUGE_COLORS.BLUE} />
      </Box>
    </Box>
  )
}
