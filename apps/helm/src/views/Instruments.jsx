import { useState, useEffect, useRef } from 'react'
import { Box, Paper, Stack, Typography, Chip, Dialog } from '@mui/material'
import WbSunnyIcon from '@mui/icons-material/WbSunny'
import AcUnitIcon from '@mui/icons-material/AcUnit'
import ThermostatIcon from '@mui/icons-material/Thermostat'
import MemoryIcon from '@mui/icons-material/Memory'
import WaterDropIcon from '@mui/icons-material/WaterDrop'
import useSignalKData, { skCelsius, skValue, skDeg, skMeters, skKnots, M_TO_FT } from '../hooks/useSignalKData'
import NmeaConsole from '../components/NmeaConsole'
import { gpsSummary } from '../lib/nmea'
import { useDemo } from '../lib/demoMode'
import { ArcGauge, TachGauge, CompassGauge, StatusGauge, InclinometerGauge, AttitudeCompassGauge, Sparkline, GAUGE_COLORS, GAUGE_BG } from './gauges'

const SVC = `http://${location.hostname}:8082`
const M3S_TO_GPH = 951019.39 // m³/s → US gallons/hour

// Poll the accelerometer attitude from the stereo-service — ICM20948 when present,
// ADXL345 otherwise; the payload's `source` says which. Always live (not demo), so the
// physical sensor can be tilt-tested regardless of the demo toggle.
function useAttitude() {
  const [att, setAtt] = useState(null)
  useEffect(() => {
    let alive = true
    const poll = () => fetch(`${SVC}/api/imu`).then((r) => r.json())
      .then((d) => { if (alive) setAtt(d && typeof d === 'object' ? d : null) }).catch(() => {})
    poll(); const t = setInterval(poll, 200)
    return () => { alive = false; clearInterval(t) }
  }, [])
  return att
}

// Poll the Pi's own health (SoC temperature, etc.) from the stereo-service. Always
// live regardless of demo mode — it's real hardware. 5s cadence: /api/system shells
// out to ps/vcgencmd, so don't hammer it.
function useSystem() {
  const [sys, setSys] = useState(null)
  useEffect(() => {
    let alive = true
    const poll = () => fetch(`${SVC}/api/system`).then((r) => r.json())
      .then((d) => { if (alive) setSys(d) }).catch(() => {})
    poll(); const t = setInterval(poll, 5000)
    return () => { alive = false; clearInterval(t) }
  }, [])
  return sys
}
// Poll the GPS receiver's own state from the stereo-service: acquisition, the UBX module
// identity (model/firmware/protocol/constellations) and the RF front end (AGC/noise/
// jamming). Real hardware, so always live regardless of demo mode.
function useGps() {
  const [gps, setGps] = useState(null)
  useEffect(() => {
    let alive = true
    const poll = () => fetch(`${SVC}/api/gps`).then((r) => r.json())
      .then((d) => { if (alive) setGps(d && typeof d === 'object' ? d : null) }).catch(() => {})
    poll(); const t = setInterval(poll, 2000)
    return () => { alive = false; clearInterval(t) }
  }, [])
  return gps
}
const CARD16 = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW']
const cardinal = (d) => (d == null ? '' : CARD16[Math.round(d / 22.5) % 16])
const fmt = (v, d = 1) => (v == null ? '—' : v.toFixed(d))
const toF = (c) => (c == null ? null : c * 9 / 5 + 32) // °C → °F
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
        'propulsion.main.oilPressure': { value: s(9, 22, 62) * 6894.76 }, // Pa, tracks RPM (period 9)
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
      setVals(m)
      timer = setTimeout(tick, 200)
    }
    tick()
    return () => clearTimeout(timer)
  }, [active])
  return vals
}

const SEV = { unknown: -1, ok: 0, warn: 1, alarm: 2 }
const worse = (a, b) => (SEV[b.level] > SEV[a.level] ? b : a)
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
// Compact engine-status badge overlaid in the tach card's bottom-left corner
// (mirrors the F/N/R indicator in the top-left).
function EngineStatusBadge({ status, text, color }) {
  const alarm = status.level === 'alarm', warn = status.level === 'warn'
  const detail = status.detail && status.detail !== 'ENGINE' ? status.detail : ''
  return (
    <Box sx={{ position: 'absolute', bottom: 16, left: 16, minWidth: 82,
      bgcolor: alarm ? 'rgba(255,59,48,0.22)' : warn ? 'rgba(255,181,46,0.16)' : 'rgba(0,0,0,0.5)',
      border: alarm ? '1px solid rgba(255,59,48,0.7)' : warn ? '1px solid rgba(255,181,46,0.5)' : '1px solid rgba(255,255,255,0.18)',
      borderRadius: 2, px: 1.5, py: 0.75 }}>
      <Typography sx={{ fontSize: '0.62rem', opacity: 0.55, letterSpacing: 1.5, fontWeight: 700 }}>ENGINE</Typography>
      <Typography sx={{ fontWeight: 800, fontSize: '1.25rem', lineHeight: 1.1, color: color || 'rgba(255,255,255,0.6)' }}>{text}</Typography>
      {detail ? <Typography sx={{ fontSize: '0.62rem', color: color || 'text.secondary', opacity: 0.9, lineHeight: 1.15, mt: 0.25 }}>{detail}</Typography> : null}
    </Box>
  )
}
// Small labeled readout used in the engine-detail popup.
function InfoStat({ label, value }) {
  return (
    <Box sx={{ bgcolor: 'rgba(255,255,255,0.05)', borderRadius: 1.5, px: 1.5, py: 1 }}>
      <Typography sx={{ fontSize: '0.62rem', opacity: 0.55, letterSpacing: 1, fontWeight: 700 }}>{label}</Typography>
      <Typography sx={{ fontWeight: 800, fontSize: '1.15rem', lineHeight: 1.2 }}>{value}</Typography>
    </Box>
  )
}
// GPS popup (tap the POSITION tile). Built for a glance from the helm, not for study:
// one big verdict, three numbers, and the satellite bars. Diagnostics — RF front end and
// the decoded sentence stream — sit behind a toggle, because they answer "why is it
// broken", which is a different moment from "are we good".
const AGC_PINNED_PCT = 15
// HDOP is satellite geometry, not signal quality: position error ≈ HDOP × ranging error.
// 99.99 is not a terrible score — it's the receiver's "not computed" sentinel, emitted
// whenever there's no fix to evaluate. Showing it as a number invites the reader to
// treat a null as a measurement, so we don't.
function hdopText(gps) {
  const h = gps?.hdop
  if (h == null || h >= 99 || !((gps?.fix || 0) >= 1)) return '—'
  const quality = h < 1 ? 'ideal' : h < 2 ? 'excellent' : h < 5 ? 'good' : h < 10 ? 'moderate' : 'poor'
  return `${h} · ${quality}`
}
function GpsDetailDialog({ open, onClose, gps }) {
  const [details, setDetails] = useState(false)
  const rf = gps?.rf
  const pct = rf && rf.agc != null ? Math.round((rf.agc / (rf.agcMax || 8191)) * 100) : null
  const agcLow = pct != null && pct <= AGC_PINNED_PCT
  const jamBad = rf && (rf.jam === 'warning' || rf.jam === 'critical')
  const rfColor = agcLow || jamBad ? GAUGE_COLORS.RED : GAUGE_COLORS.GREEN
  const sats = (gps?.sats || []).filter((s) => s.snr)
  const fixed = (gps?.fix || 0) >= 1
  const summary = gpsSummary(gps)

  // The verdict, in one word, colour-coded. This is the whole point of the popup.
  const verdict = !gps?.alive ? { text: 'NO DATA', color: GAUGE_COLORS.RED }
    : fixed ? { text: (gps.fix >= 2 ? '3D FIX' : 'FIX'), color: GAUGE_COLORS.GREEN }
      : gps.satsInView > 0 ? { text: 'SEARCHING', color: GAUGE_COLORS.AMBER }
        : { text: 'NO SIGNAL', color: GAUGE_COLORS.AMBER }

  return (
    <Dialog open={open} onClose={onClose} maxWidth={false}
      PaperProps={{ sx: { bgcolor: GAUGE_BG, p: 2, width: '82vw', maxWidth: '82vw', m: 0 } }}>
      {/* Verdict first, big enough to read standing back from the helm. */}
      <Stack direction="row" alignItems="center" spacing={2} sx={{ mb: 1.5 }}>
        <Typography sx={{ fontWeight: 900, fontSize: '2.6rem', lineHeight: 1, color: verdict.color, letterSpacing: 1 }}>
          {verdict.text}
        </Typography>
        <Typography sx={{ flex: 1, fontSize: '0.95rem', opacity: 0.8 }}>{summary.text}</Typography>
      </Stack>

      {/* Coarse Wi-Fi estimate, stated as what it is. Never merged with fix data. */}
      {!fixed && gps?.approx ? (
        <Typography sx={{ mb: 1.5, fontSize: '0.9rem', color: GAUGE_COLORS.AMBER }}>
          ≈ {Math.abs(gps.approx.lat).toFixed(4)}° {gps.approx.lat >= 0 ? 'N' : 'S'}  {Math.abs(gps.approx.lon).toFixed(4)}° {gps.approx.lon >= 0 ? 'E' : 'W'}
          <Box component="span" sx={{ opacity: 0.7 }}>
            {' '}— Wi-Fi estimate ±{Math.round(gps.approx.accuracy || 0)} m, {gps.approx.ageS}s old. Position only, no speed or course. Not a navigation fix.
          </Box>
        </Typography>
      ) : null}

      {/* The three numbers that matter underway. */}
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 1.5 }}>
        {[['SATELLITES', gps?.satsInView ?? '—'], ['USED FOR FIX', gps?.satsUsed ?? '—'],
          ['ACCURACY', hdopText(gps)]].map(([l, v]) => (
          <Box key={l} sx={{ bgcolor: 'rgba(255,255,255,0.05)', borderRadius: 1.5, px: 1.75, py: 1.25 }}>
            <Typography sx={{ fontSize: '0.62rem', opacity: 0.55, letterSpacing: 1, fontWeight: 700 }}>{l}</Typography>
            <Typography sx={{ fontWeight: 800, fontSize: '2rem', lineHeight: 1.15 }}>{v}</Typography>
          </Box>
        ))}
      </Box>

      {/* Signal strength: the fastest read on whether things are improving. */}
      {sats.length ? (
        <Box sx={{ display: 'flex', alignItems: 'flex-end', gap: 0.5, height: 88, mt: 1.75 }}>
          {sats.sort((a, b) => b.snr - a.snr).map((s, i) => (
            <Box key={i} sx={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', height: '100%' }}>
              <Typography sx={{ fontSize: '0.6rem', opacity: 0.7 }}>{s.snr}</Typography>
              <Box sx={{ width: '80%', height: `${Math.min(100, (s.snr / 50) * 100)}%`, minHeight: 2, borderRadius: 0.5,
                bgcolor: s.snr >= 30 ? GAUGE_COLORS.GREEN : s.snr >= 20 ? GAUGE_COLORS.AMBER : GAUGE_COLORS.RED }} />
              <Typography sx={{ fontSize: '0.6rem', opacity: 0.6, mt: 0.25 }}>{s.id}</Typography>
            </Box>
          ))}
        </Box>
      ) : (
        <Typography sx={{ mt: 1.75, fontSize: '0.9rem', opacity: 0.5 }}>
          No satellite signal to show yet — bars appear here as they're heard.
        </Typography>
      )}

      {/* Gain stays on the glance view: it's the number that moves when the antenna
          moves, so it's the live feedback while hunting for a better position. */}
      <Stack direction="row" spacing={2} alignItems="center" sx={{ mt: 1.75 }}>
        {rf && rf.agc != null ? (
          <Stack direction="row" spacing={1.5} alignItems="center" sx={{ minWidth: 320 }}>
            <Typography sx={{ fontSize: '0.75rem', opacity: 0.6, letterSpacing: 1, fontWeight: 700 }}>GAIN</Typography>
            <Typography sx={{ fontWeight: 800, fontSize: '1.9rem', lineHeight: 1, color: rfColor }}>
              {rf.agc}<Box component="span" sx={{ opacity: 0.6, fontSize: '1.1rem', fontWeight: 600 }}> · {pct}%</Box>
            </Typography>
            <Box sx={{ flex: 1, height: 9, borderRadius: 4, bgcolor: 'rgba(255,255,255,0.12)', overflow: 'hidden', minWidth: 110 }}>
              <Box sx={{ width: `${Math.max(2, pct)}%`, height: '100%', bgcolor: rfColor }} />
            </Box>
          </Stack>
        ) : null}
        {agcLow && !gps?.satsInView ? (
          <Typography sx={{ fontSize: '0.8rem', color: '#ff8f85' }}>at minimum — front end saturated or idle</Typography>
        ) : null}
        <Box sx={{ flex: 1 }} />
        <Chip size="small" label={details ? 'Hide RF detail' : 'RF detail'} onClick={() => setDetails(!details)}
          variant={details ? 'filled' : 'outlined'} sx={{ cursor: 'pointer' }} />
      </Stack>

      {details && rf ? (
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 1, mt: 1.25 }}>
          <InfoStat label="NOISE" value={rf.noise ?? '—'} />
          <InfoStat label="JAMMING" value={`${rf.jam || '—'}${rf.jamInd != null ? ` ${rf.jamInd}` : ''}`} />
          <InfoStat label="ANTENNA" value={rf.ant || '—'} />
        </Box>
      ) : null}

      {/* The console stays — reading the receiver's own words is how you tell a quiet
          receiver from a broken link. */}
      <Typography sx={{ fontSize: '0.62rem', opacity: 0.55, letterSpacing: 1, fontWeight: 700, mt: 1.75, mb: 0.5 }}>WHAT THE RECEIVER IS SAYING</Typography>
      <NmeaConsole lines={gps?.raw} maxHeight={220} />
    </Dialog>
  )
}
function GaugeCard({ children, sx }) {
  return (
    <Paper sx={{ p: 1.25, bgcolor: GAUGE_BG, minHeight: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', ...sx }}>
      <Box sx={{ width: '100%', height: '100%', minHeight: 0 }}>{children}</Box>
    </Paper>
  )
}
function Tile({ label, value, unit, sub, accent, icon, children, sx, valueSize, center, onClick }) {
  return (
    <Paper onClick={onClick} sx={{ p: 1.75, bgcolor: GAUGE_BG, display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: center ? 'center' : 'stretch', textAlign: center ? 'center' : 'left', minHeight: 0, overflow: 'hidden', ...(onClick ? { cursor: 'pointer' } : null), ...sx }}>
      <Stack direction="row" alignItems="center" justifyContent={center ? 'center' : 'space-between'} sx={{ width: '100%' }}>
        <Typography noWrap sx={{ opacity: 0.55, fontSize: '0.78rem', letterSpacing: 1.5, fontWeight: 700 }}>{label}</Typography>
        {icon ? <Box sx={{ color: accent || 'text.secondary', display: 'flex', '& svg': { fontSize: 24 } }}>{icon}</Box> : null}
      </Stack>
      <Stack direction="row" alignItems="baseline" justifyContent={center ? 'center' : 'flex-start'} spacing={0.75} sx={{ minWidth: 0 }}>
        <Typography noWrap sx={{ fontWeight: 800, fontSize: valueSize || '2.1rem', lineHeight: 1.15, color: accent || 'text.primary' }}>{value}</Typography>
        {unit ? <Typography sx={{ opacity: 0.6, fontSize: '1rem', fontWeight: 600 }}>{unit}</Typography> : null}
      </Stack>
      {sub ? <Typography noWrap sx={{ opacity: 0.5, fontSize: '0.78rem' }}>{sub}</Typography> : null}
      {children}
    </Paper>
  )
}
// AMBIENT: shows every temperature source — SHT41 and HTU31D (both with humidity),
// MCP9808, and the Pi SoC (CPU) — each labeled. Temps in °F except the CPU (°C by
// convention). The SHT41 leads: it's the tightest-tolerance part of the three, so it
// drives the tile's icon/accent colour and its humidity is the one shown.
function AmbientTile({ shtF, htuF, mcpF, cpuT, shtHumidity, humidity }) {
  const primary = shtF != null ? shtF : htuF != null ? htuF : mcpF
  const icon = primary == null ? <ThermostatIcon /> : primary < 50 ? <AcUnitIcon /> : primary > 77 ? <WbSunnyIcon /> : <ThermostatIcon />
  const accent = primary == null ? 'text.secondary' : primary < 50 ? GAUGE_COLORS.BLUE : primary > 77 ? GAUGE_COLORS.AMBER : 'text.secondary'
  const lbl = { fontSize: '0.64rem', fontWeight: 700, letterSpacing: 0.5, opacity: 0.5, width: 30 }
  const val = { fontWeight: 800, fontSize: '1.4rem', lineHeight: 1.25 }
  return (
    <Paper sx={{ p: 1.5, bgcolor: GAUGE_BG, display: 'flex', flexDirection: 'column', justifyContent: 'center', minHeight: 0, flex: 1.6, overflow: 'hidden' }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between" sx={{ mb: 0.35 }}>
        <Typography sx={{ opacity: 0.55, fontSize: '0.78rem', letterSpacing: 1.5, fontWeight: 700 }}>AMBIENT</Typography>
        <Box sx={{ color: accent, display: 'flex', '& svg': { fontSize: 22 } }}>{icon}</Box>
      </Stack>
      <Stack spacing={0.15}>
        {shtF != null && (
          <Stack direction="row" alignItems="baseline" spacing={0.75}>
            <Typography sx={lbl}>SHT</Typography>
            <Typography sx={{ ...val, color: accent === 'text.secondary' ? 'text.primary' : accent }}>{Math.round(shtF)}°F</Typography>
            {shtHumidity != null && (
              <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.3, fontSize: '1.05rem', fontWeight: 700, opacity: 0.9, ml: 0.5 }}>
                <WaterDropIcon sx={{ fontSize: 17, color: GAUGE_COLORS.BLUE }} />{Math.round(shtHumidity)}%
              </Box>
            )}
          </Stack>
        )}
        {htuF != null && (
          <Stack direction="row" alignItems="baseline" spacing={0.75}>
            <Typography sx={lbl}>HTU</Typography>
            <Typography sx={{ ...val, color: shtF != null ? 'text.primary' : accent === 'text.secondary' ? 'text.primary' : accent }}>{Math.round(htuF)}°F</Typography>
            {humidity != null && shtHumidity == null && (
              <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.3, fontSize: '1.05rem', fontWeight: 700, opacity: 0.9, ml: 0.5 }}>
                <WaterDropIcon sx={{ fontSize: 17, color: GAUGE_COLORS.BLUE }} />{Math.round(humidity)}%
              </Box>
            )}
          </Stack>
        )}
        {mcpF != null && (
          <Stack direction="row" alignItems="baseline" spacing={0.75}>
            <Typography sx={lbl}>MCP</Typography><Typography sx={val}>{Math.round(mcpF)}°F</Typography>
          </Stack>
        )}
        {cpuT != null && (
          <Stack direction="row" alignItems="baseline" spacing={0.75}>
            <Typography sx={lbl}>CPU</Typography>
            <Typography sx={{ ...val, color: cpuT >= 80 ? GAUGE_COLORS.RED : cpuT >= 70 ? GAUGE_COLORS.AMBER : 'text.primary' }}>{Math.round(cpuT)}°C</Typography>
          </Stack>
        )}
      </Stack>
    </Paper>
  )
}
// Fuel flow correlated with RPM: compares actual gph against the flow expected for the
// current RPM, so a sudden shortfall — e.g. a fuel line crimped when the outboard is
// steered hard over — stands out immediately. The expected curve is a rough DF140
// WOT-normalized model; calibrate WOT_GPH/WOT_RPM to your engine for accuracy.
const WOT_RPM = 6000, WOT_GPH = 14
function expectedGph(rpm) {
  if (rpm == null || rpm < 500) return null
  return WOT_GPH * Math.pow(Math.min(rpm, WOT_RPM + 400) / WOT_RPM, 2.2)
}
function FuelFlowTile({ rpm, gph }) {
  const exp = expectedGph(rpm)
  const ratio = exp && gph != null && exp > 0.2 ? gph / exp : null
  // Only flag starvation when the engine is actually loaded (RPM up), else idle noise trips it.
  const flag = ratio != null && rpm >= 2500 ? (ratio < 0.7 ? 'alarm' : ratio < 0.82 ? 'warn' : 'ok') : 'ok'
  const barColor = flag === 'alarm' ? GAUGE_COLORS.RED : flag === 'warn' ? GAUGE_COLORS.AMBER : GAUGE_COLORS.GREEN
  const pct = ratio == null ? 0 : Math.max(0, Math.min(1.2, ratio))
  return (
    <Paper sx={{ p: 1.75, bgcolor: GAUGE_BG, display: 'flex', flexDirection: 'column', justifyContent: 'center', minHeight: 0, overflow: 'hidden', flex: 1.7 }}>
      <Stack direction="row" alignItems="center" justifyContent="space-between">
        <Typography sx={{ opacity: 0.55, fontSize: '0.78rem', letterSpacing: 1.5, fontWeight: 700 }}>FUEL FLOW</Typography>
        {flag !== 'ok' && <Typography sx={{ fontSize: '0.72rem', fontWeight: 800, letterSpacing: 0.5, color: barColor }}>{flag === 'alarm' ? '⚠ LOW FLOW' : 'CHECK'}</Typography>}
      </Stack>
      <Stack direction="row" alignItems="baseline" spacing={0.6}>
        <Typography sx={{ fontWeight: 800, fontSize: '2.1rem', lineHeight: 1.1, color: flag === 'alarm' ? GAUGE_COLORS.RED : 'text.primary' }}>{fmt(gph, 1)}</Typography>
        <Typography sx={{ opacity: 0.6, fontSize: '1rem', fontWeight: 600 }}>{gph == null ? '' : 'gph'}</Typography>
        {exp != null && <Typography sx={{ opacity: 0.5, fontSize: '0.8rem', ml: 0.5 }}>exp {exp.toFixed(1)}</Typography>}
      </Stack>
      {/* delivery bar: actual / expected-for-RPM, with a marker at 100% of expected */}
      <Box sx={{ position: 'relative', height: 11, borderRadius: 1, bgcolor: 'rgba(255,255,255,0.14)', overflow: 'hidden', mt: 0.6 }}>
        <Box sx={{ height: '100%', width: `${(pct / 1.2) * 100}%`, bgcolor: barColor, transition: 'width .3s' }} />
        <Box sx={{ position: 'absolute', top: 0, bottom: 0, left: `${(1 / 1.2) * 100}%`, width: '2px', bgcolor: 'rgba(255,255,255,0.55)' }} />
      </Box>
    </Paper>
  )
}
// Horizontal fuel-level bar (E → F), Suzuki-style. Only rendered when a tank sensor exists.
function FuelLevelTile({ pct }) {
  const has = pct != null
  const low = has && pct <= 0.15
  return (
    <Paper sx={{ p: 1.75, bgcolor: GAUGE_BG, display: 'flex', flexDirection: 'column', justifyContent: 'center', minHeight: 0, flex: 1, width: '100%' }}>
      <Stack direction="row" justifyContent="space-between" sx={{ mb: 0.5 }}>
        <Typography sx={{ opacity: 0.55, fontSize: '0.78rem', letterSpacing: 1.5, fontWeight: 700 }}>FUEL</Typography>
        <Typography sx={{ fontWeight: 800, fontSize: '1.1rem', color: low ? GAUGE_COLORS.RED : 'text.primary' }}>{has ? `${Math.round(pct * 100)}%` : '—'}</Typography>
      </Stack>
      <Stack direction="row" alignItems="center" spacing={1}>
        <Typography sx={{ opacity: 0.6, fontWeight: 700 }}>E</Typography>
        <Box sx={{ flex: 1 }}>
          <Box sx={{ position: 'relative', height: 18, borderRadius: 1, bgcolor: 'rgba(255,255,255,0.14)', overflow: 'hidden' }}>
            <Box sx={{ height: '100%', width: `${(has ? pct : 0) * 100}%`, bgcolor: low ? GAUGE_COLORS.RED : pct <= 0.25 ? GAUGE_COLORS.AMBER : GAUGE_COLORS.GREEN, transition: 'width .3s' }} />
            {/* quarter-increment tick marks */}
            {[25, 50, 75].map((p) => (
              <Box key={p} sx={{ position: 'absolute', top: 2, bottom: 2, left: `${p}%`, width: '2px', bgcolor: 'rgba(0,0,0,0.55)' }} />
            ))}
          </Box>
          {/* quarter labels under the bar */}
          <Box sx={{ position: 'relative', height: 12, mt: 0.25 }}>
            {[['¼', 25], ['½', 50], ['¾', 75]].map(([t, p]) => (
              <Typography key={t} sx={{ position: 'absolute', left: `${p}%`, transform: 'translateX(-50%)', fontSize: '0.68rem', opacity: 0.5, lineHeight: 1 }}>{t}</Typography>
            ))}
          </Box>
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
          <Typography sx={{ fontWeight: 800, fontSize: '2.6rem', lineHeight: 1.05, color: acc || 'text.primary' }}>{v == null ? '—' : v.toFixed(2)}</Typography>
          <Typography sx={{ opacity: 0.6, fontSize: '1.1rem', fontWeight: 600 }}>V</Typography>
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
  const [demo] = useDemo()   // set in Settings → Config; shared via localStorage
  const [tempOpen, setTempOpen] = useState(false)
  const [gpsOpen, setGpsOpen] = useState(false)
  // Compass bezel mark — survives a reload, because a course you set an hour ago is
  // still the course you're steering.
  const [bezel, setBezel] = useState(() => {
    const v = Number(localStorage.getItem('helm.bezel'))
    return isFinite(v) && localStorage.getItem('helm.bezel') != null ? v : null
  })
  const setBezelPersist = (v) => {
    setBezel(v)
    try { if (v == null) localStorage.removeItem('helm.bezel'); else localStorage.setItem('helm.bezel', String(v)) } catch (e) { /* private mode */ }
  }
  const live = useSignalKData()
  const demoVals = useDemoValues(demo)
  const connected = demo ? true : live.connected
  const values = demo ? demoVals : live.values

  const rpmHz = numAt(values, findPath(values, /^propulsion\..+\.revolutions$/))
  const rpm = rpmHz == null ? null : rpmHz * 60
  const engTemp = (() => { const v = numAt(values, findPath(values, /^propulsion\..+\.(coolantTemperature|temperature)$/)); return v == null ? null : v - 273.15 })()
  const fuelRate = (() => { const v = numAt(values, findPath(values, /^propulsion\..+\.fuel\.rate$/)); return v == null ? null : v * M3S_TO_GPH })()
  const fuelLevel = numAt(values, findPath(values, /^tanks\.fuel\..+\.currentLevel$/))
  let engStatus = engineStatus(values)
  // Overheat is derived from the actual engine temperature, and shows the temp.
  if (engTemp != null) {
    if (engTemp >= 100) engStatus = worse(engStatus, { level: 'alarm', detail: `OVERHEAT ${Math.round(toF(engTemp))}°F` })
    else if (engTemp >= 90) engStatus = worse(engStatus, { level: 'warn', detail: `HOT ${Math.round(toF(engTemp))}°F` })
  }
  // Tach warning lamps — Suzuki set (check / temp / oil / water-in-fuel), each false | 'warn' | 'alarm'.
  const oilP = numAt(values, findPath(values, /^propulsion\..+\.oilPressure$/)) // Pa, if present
  const tachInd = {
    check: engStatus.level === 'alarm' ? 'alarm' : engStatus.level === 'warn' ? 'warn' : false,
    temp: engTemp == null ? false : engTemp >= 100 ? 'alarm' : engTemp >= 90 ? 'warn' : false,
    oil: oilP == null ? false : oilP < 50000 ? 'alarm' : oilP < 100000 ? 'warn' : false,
    water: false, // water-in-fuel: no sensor wired yet (lamp stays dark, like a dry separator)
  }
  const battV = numAt(values, findPath(values, /^electrical\.batteries\..+\.voltage$/))
  const battA = numAt(values, findPath(values, /^electrical\.batteries\..+\.current$/))
  const airT = skCelsius(values, 'environment.outside.temperature')
  const depth = skMeters(values, 'environment.depth.belowTransducer')
  const hdg = skDeg(values, 'navigation.headingTrue')
  const hdgM = skDeg(values, 'navigation.headingMagnetic')
  const heading = hdg != null ? hdg : hdgM
  // Live GPS is a real sensor — prefer it over demo for position/speed/course so the
  // panel shows the actual GPS the moment it gets a fix, even with demo on elsewhere.
  const gpsPos = skValue(live.values, 'navigation.position')
  const gpsFix = !!(gpsPos && typeof gpsPos.latitude === 'number')
  const gnssIV = skValue(live.values, 'navigation.gnss.satellitesInView')
  const gpsSats = gnssIV && typeof gnssIV.count === 'number' ? gnssIV.count : null
  const cog = gpsFix ? skDeg(live.values, 'navigation.courseOverGroundTrue') : skDeg(values, 'navigation.courseOverGroundTrue')
  const sog = gpsFix ? skKnots(live.values, 'navigation.speedOverGround') : skKnots(values, 'navigation.speedOverGround')
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
  const pos = gpsFix ? gpsPos : skValue(values, 'navigation.position')

  const attitude = useAttitude()
  const sys = useSystem()
  const gpsDiag = useGps()
  const cpuT = sys && typeof sys.temp === 'number' && sys.temp > 0 ? sys.temp : null
  // I2C ambient sensors via imu.py (real sensors win over SignalK air temp + demo).
  // SHT41 and HTU31D both give temp + humidity; MCP9808 is a temp-only fallback.
  const mcpT = attitude && typeof attitude.tempC === 'number' ? attitude.tempC : null
  const htuT = attitude && typeof attitude.htuC === 'number' ? attitude.htuC : null
  const humidity = attitude && typeof attitude.humidity === 'number' ? attitude.humidity : null
  const shtT = attitude && typeof attitude.shtC === 'number' ? attitude.shtC : null
  const shtHumidity = attitude && typeof attitude.shtHumidity === 'number' ? attitude.shtHumidity : null
  const ambC = htuT != null ? htuT : (mcpT != null ? mcpT : airT)
  const ambF = toF(ambC)
  const trip = useTrip(pos, sog)
  useEffect(() => { if (engHours != null) { try { localStorage.setItem('helm.engineHours', String(engHours)) } catch (e) {} } }, [engHours])
  const battHist = useHistory(battV)
  const fuelHist = useHistory(fuelRate)

  // POSITION always reflects the real GPS: coordinates when fixed, else acquiring status.
  // With no fix, fall back to the coarse Wi-Fi estimate if one exists — prefixed with
  // "≈" and shown in amber, so it can never be read as a real fix.
  const approx = gpsDiag?.approx
  const posStr = gpsFix
    ? `${Math.abs(gpsPos.latitude).toFixed(5)}° ${gpsPos.latitude >= 0 ? 'N' : 'S'}   ${Math.abs(gpsPos.longitude).toFixed(5)}° ${gpsPos.longitude >= 0 ? 'E' : 'W'}`
    : approx
      ? `≈ ${Math.abs(approx.lat).toFixed(4)}° ${approx.lat >= 0 ? 'N' : 'S'}   ${Math.abs(approx.lon).toFixed(4)}° ${approx.lon >= 0 ? 'E' : 'W'}`
      : `GPS acquiring${gpsSats != null ? ` · ${gpsSats} sat` : '…'}`

  const stMap = { ok: ['OK', GAUGE_COLORS.GREEN], warn: ['CHECK', GAUGE_COLORS.AMBER], alarm: ['ALARM', GAUGE_COLORS.RED], unknown: ['—', undefined] }
  const [statusText, statusColor] = stMap[engStatus.level] || stMap.unknown
  return (
    <Box sx={{ height: '100%', display: 'flex', flexDirection: 'column', p: 1, gap: 1, overflow: 'hidden' }}>
      <Stack direction="row" alignItems="center" spacing={1} sx={{ flexShrink: 0, height: 24 }}>
        {/* Status only — the demo switch itself lives in Settings → Config now, so a
            stray tap on a moving boat can't swap the panel to synthetic data. */}
        <Chip size="small" color={demo ? 'info' : connected ? 'success' : 'default'} variant="filled" label={demo ? 'demo' : connected ? 'live' : 'offline'} sx={{ height: 20 }} />
        <Box sx={{ flex: 1 }} />
      </Stack>

      {/* Layout: big SPEED on the left, RPM tach centre (full height), COMPASS
          (heading/COG) over the INCLINOMETER (heel/trim) on the right. */}
      <Box sx={{ flex: 1, minHeight: 0, display: 'grid', gap: 1.5, gridTemplateColumns: '1.15fr 1.4fr 1.15fr', gridTemplateRows: '1fr 1fr' }}>
        <GaugeCard sx={{ gridColumn: 1, gridRow: '1 / 3' }}><ArcGauge label="SPEED kn" value={sog} unit="kn" min={0} max={50} decimals={1} ticks={5} color={GAUGE_COLORS.BLUE} /></GaugeCard>

        <Box sx={{ gridColumn: 2, gridRow: '1 / 3', minHeight: 0, position: 'relative', display: 'flex' }}>
          <GaugeCard sx={{ flex: 1 }}><TachGauge value={rpm} min={0} max={7000} redline={0.857} indicators={tachInd} engTempF={toF(engTemp)} onTempClick={() => setTempOpen(true)} /></GaugeCard>
          {gear ? <GearIndicator gear={gear} /> : null}
          <EngineStatusBadge status={engStatus} text={statusText} color={statusColor} />
        </Box>

        {/* Heading, heel and trim are one sensor answering one question — shown on one
            dial, which also gives the horizon far more room than two stacked gauges. */}
        <GaugeCard sx={{ gridColumn: 3, gridRow: '1 / 3' }}>
          <AttitudeCompassGauge
            heading={heading} cog={cog}
            roll={attitude && typeof attitude.roll === 'number' ? -attitude.roll : null}
            pitch={attitude && typeof attitude.pitch === 'number' ? attitude.pitch : null}
            bezel={bezel} onBezel={setBezelPersist} />
        </GaugeCard>
      </Box>

      {/* Bottom strip */}
      <Box sx={{ flexShrink: 0, display: 'flex', gap: 1.5, height: 128 }}>
        <BatteryTile v={battV} a={battA} hist={battHist} />
        <FuelFlowTile rpm={rpm} gph={fuelRate} />
        {fuelLevel != null ? <Box sx={{ flex: 2.0, display: 'flex' }}><FuelLevelTile pct={fuelLevel} /></Box> : null}
        <Tile label="DEPTH" value={depth == null ? '—' : fmt(depth * M_TO_FT, 0)} unit={depth == null ? '' : 'ft'} valueSize="2.7rem" sx={{ flex: 0.9 }} accent={GAUGE_COLORS.BLUE} center />
        <AmbientTile shtF={toF(shtT)} htuF={toF(htuT)} mcpF={toF(mcpT)} cpuT={cpuT} shtHumidity={shtHumidity} humidity={humidity} />
        <Tile label="TRIP" value={trip.distance ? trip.distance.toFixed(1) : '0.0'} unit="nm" sx={{ flex: 0.9 }} accent={GAUGE_COLORS.BLUE} />
        {/* Tap POSITION → GPS detail (module identity, RF front end, satellites, raw NMEA) */}
        <Tile label="POSITION" value={posStr} valueSize={gpsFix ? '1.35rem' : '1.15rem'} sx={{ flex: 1.9 }}
          accent={gpsFix ? GAUGE_COLORS.GREEN : GAUGE_COLORS.AMBER}
          onClick={() => setGpsOpen(true)}
          sub={!gpsFix && approx
            ? `Wi-Fi approx ±${Math.round(approx.accuracy || 0)} m — not a fix`
            : gpsDiag?.module?.model ? `${gpsDiag.module.model} · ${gpsDiag.satsInView ?? 0} sats · tap` : 'tap for GPS detail'} />
      </Box>

      {/* Tap the temp under the tach → engine detail popup (gauge + key readouts) */}
      <Dialog open={tempOpen} onClose={() => setTempOpen(false)} maxWidth="xs" fullWidth
        onClick={() => setTempOpen(false)}
        PaperProps={{ sx: { bgcolor: GAUGE_BG, p: 2 } }}>
        <Typography sx={{ fontWeight: 800, fontSize: '1rem', letterSpacing: 1.5, opacity: 0.7, mb: 0.5 }}>ENGINE</Typography>
        <Box sx={{ height: 210 }}>
          <ArcGauge label="ENGINE °F" value={toF(engTemp)} unit="°F" min={0} max={250} decimals={0} ticks={5} redline={0.848} zones={[{ from: 0.776, to: 0.848, color: GAUGE_COLORS.AMBER }]} color={GAUGE_COLORS.BLUE} />
        </Box>
        <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 1, mt: 1 }}>
          <InfoStat label="RPM" value={rpm == null ? '—' : Math.round(rpm)} />
          <InfoStat label="OIL PRESS" value={oilP == null ? '—' : `${Math.round(oilP / 6894.76)} psi`} />
          <InfoStat label="ENGINE HRS" value={engHours == null ? '—' : engHours.toFixed(1)} />
          <InfoStat label="FUEL" value={fuelRate == null ? '—' : `${fuelRate.toFixed(1)} gph`} />
          <InfoStat label="BATTERY" value={battV == null ? '—' : `${battV.toFixed(1)} V`} />
          <InfoStat label="GEAR" value={gear || '—'} />
        </Box>
      </Dialog>

      <GpsDetailDialog open={gpsOpen} onClose={() => setGpsOpen(false)} gps={gpsDiag} />
    </Box>
  )
}
