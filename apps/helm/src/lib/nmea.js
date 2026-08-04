// Turn NMEA 0183 sentences into plain English for the helm's GPS view.
//
// The raw stream is unreadable unless you already know the format — "$GPGSV,1,1,00,0*65"
// is just "GPS: no satellites in view". Everything here is display-only; parsing that
// drives state lives in the stereo-service (server.js parseGps).
//
// Empty fields are the normal case before a fix: a receiver with no satellites still
// emits every sentence, with the data positions blank. We say "not available yet"
// rather than showing nothing, so a blank sentence still reads as informative.

const TALKERS = {
  GP: 'GPS', GL: 'GLONASS', GA: 'Galileo', GB: 'BeiDou', GQ: 'QZSS',
  GI: 'NavIC', GN: 'Combined', HC: 'Compass', II: 'Instrument', EI: 'Electronic',
}
// GGA field 6 — how the position was obtained (0 means there isn't one).
const FIX_QUALITY = {
  0: 'no fix', 1: 'GPS fix', 2: 'differential GPS fix', 3: 'precise (PPS) fix',
  4: 'RTK fixed', 5: 'RTK float', 6: 'dead reckoning', 7: 'manual input', 8: 'simulated',
}
const GSA_FIX = { 1: 'no fix', 2: '2D fix', 3: '3D fix' }
const GSA_SYSTEM = { 1: 'GPS', 2: 'GLONASS', 3: 'Galileo', 4: 'BeiDou', 5: 'QZSS', 6: 'NavIC' }

const num = (s) => (s != null && s !== '' && isFinite(Number(s)) ? Number(s) : null)

// NMEA checksum: XOR of every character between '$' and '*', printed as two hex digits.
// It only proves the sentence arrived intact — a no-fix sentence full of empty fields
// still checksums fine. A rising failure rate is the signature of a wiring or baud-rate
// problem (or interference on the serial line), which is worth surfacing on a boat.
// Returns true/false, or null when the sentence carries no checksum at all.
export function checksumOk(line) {
  if (!line || line[0] !== '$') return null
  const star = line.lastIndexOf('*')
  if (star < 0 || star + 3 > line.length) return null
  let c = 0
  for (let i = 1; i < star; i++) c ^= line.charCodeAt(i)
  return c === parseInt(line.slice(star + 1, star + 3), 16)
}

export function checksumStats(lines) {
  let ok = 0, bad = 0
  for (const l of lines || []) {
    const v = checksumOk(l)
    if (v === true) ok++
    else if (v === false) bad++
  }
  return { ok, bad, total: ok + bad }
}

// "4700.0000,N" → 47.00000° N. NMEA packs degrees and minutes into one number
// (DDMM.MMMM), which is the other reason these sentences resist reading.
function latLon(value, hemi) {
  const v = num(value)
  if (v == null || !hemi) return null
  const deg = Math.floor(Math.abs(v) / 100)
  const min = Math.abs(v) - deg * 100
  const dec = deg + min / 60
  return `${dec.toFixed(5)}° ${hemi}`
}

function hhmmss(t) {
  if (!t || t.length < 6) return null
  return `${t.slice(0, 2)}:${t.slice(2, 4)}:${t.slice(4, 6)} UTC`
}

// Returns { key, title, text, tone } — tone: 'ok' | 'warn' | 'dim'.
export function describeNmea(line) {
  if (!line || line[0] !== '$') return { key: 'other', title: '—', text: line || '', tone: 'dim' }
  // A damaged sentence can't be trusted enough to decode — say so instead of showing
  // fields that may be garbage.
  if (checksumOk(line) === false) {
    return { key: `bad-${line.slice(1, 6)}`, title: 'Corrupt', text: 'checksum mismatch — this sentence was damaged in transit', tone: 'bad' }
  }
  const body = line.split('*')[0]
  const f = body.split(',')
  const tag = (f[0] || '').slice(1)          // e.g. GPGSV
  const talker = TALKERS[tag.slice(0, 2)] || tag.slice(0, 2)
  const type = tag.slice(2)
  const key = tag

  switch (type) {
    case 'GGA': {
      const q = num(f[6])
      const used = num(f[7])
      const alt = num(f[9])
      const pos = latLon(f[2], f[3]) && latLon(f[4], f[5]) ? `${latLon(f[2], f[3])}  ${latLon(f[4], f[5])}` : null
      const quality = q != null ? FIX_QUALITY[q] || `quality ${q}` : 'no fix'
      const bits = [`${quality}`, `${used ?? 0} satellites used`]
      if (pos) bits.push(pos)
      if (alt != null) bits.push(`altitude ${alt} m`)
      if (hhmmss(f[1])) bits.push(hhmmss(f[1]))
      return { key, title: 'Position', text: bits.join(' · '), tone: q ? 'ok' : 'warn' }
    }
    case 'RMC': {
      const valid = f[2] === 'A'
      const sog = num(f[7])
      const cog = num(f[8])
      const pos = latLon(f[3], f[4]) && latLon(f[5], f[6]) ? `${latLon(f[3], f[4])}  ${latLon(f[5], f[6])}` : null
      if (!valid) return { key, title: 'Navigation', text: 'no valid fix yet — position, speed and course not available', tone: 'warn' }
      const bits = [pos, sog != null ? `${sog.toFixed(1)} kn` : null, cog != null ? `course ${cog.toFixed(0)}°` : null, hhmmss(f[1])].filter(Boolean)
      return { key, title: 'Navigation', text: bits.join(' · '), tone: 'ok' }
    }
    case 'GSA': {
      const mode = num(f[2])
      const sys = num(f[f.length - 1])
      const pdop = num(f[15]), hdop = num(f[16]), vdop = num(f[17])
      const used = f.slice(3, 15).filter((x) => x).length
      const which = sys != null && GSA_SYSTEM[sys] ? GSA_SYSTEM[sys] : talker
      if (mode === 1 || mode == null) {
        return { key: `${key}-${sys || 0}`, title: `${which} fix`, text: 'no fix — no satellites locked', tone: 'warn' }
      }
      const dop = [pdop, hdop, vdop].every((x) => x != null) ? ` · accuracy ${hdop.toFixed(1)} HDOP` : ''
      return { key: `${key}-${sys || 0}`, title: `${which} fix`, text: `${GSA_FIX[mode]} using ${used} satellites${dop}`, tone: 'ok' }
    }
    case 'GSV': {
      const inView = num(f[3]) ?? 0
      const sats = []
      for (let i = 4; i + 3 < f.length; i += 4) {
        if (f[i]) sats.push({ id: f[i], el: num(f[i + 1]), snr: num(f[i + 3]) })
      }
      if (!inView) return { key, title: talker, text: 'no satellites in view', tone: 'warn' }
      const strong = sats.filter((s) => s.snr).sort((a, b) => b.snr - a.snr).slice(0, 4)
        .map((s) => `#${s.id} ${s.snr}dB`).join(', ')
      return {
        key, title: talker,
        text: `${inView} in view${strong ? ` · strongest ${strong}` : ' · none with usable signal'}`,
        tone: strong ? 'ok' : 'warn',
      }
    }
    case 'GLL': {
      const valid = f[6] === 'A'
      const pos = latLon(f[1], f[2]) && latLon(f[3], f[4]) ? `${latLon(f[1], f[2])}  ${latLon(f[3], f[4])}` : null
      return { key, title: 'Lat/Long', text: valid && pos ? pos : 'not available yet', tone: valid ? 'ok' : 'warn' }
    }
    case 'VTG': {
      const cog = num(f[1]), kn = num(f[5])
      if (cog == null && kn == null) return { key, title: 'Speed/course', text: 'not available yet', tone: 'warn' }
      return { key, title: 'Speed/course', text: `${kn != null ? `${kn.toFixed(1)} kn` : '—'}${cog != null ? ` · ${cog.toFixed(0)}° true` : ''}`, tone: 'ok' }
    }
    case 'ZDA':
      return { key, title: 'Time', text: hhmmss(f[1]) ? `${hhmmss(f[1])} · ${f[2]}/${f[3]}/${f[4]}` : 'not available yet', tone: hhmmss(f[1]) ? 'ok' : 'warn' }
    case 'TXT':
      return { key: `${key}-${f[3] || 0}`, title: 'Message', text: f.slice(4).join(',') || '(empty)', tone: 'dim' }
    case 'HDM':
      return { key, title: 'Heading', text: num(f[1]) != null ? `${num(f[1]).toFixed(0)}° magnetic` : 'not available', tone: 'ok' }
    default:
      return { key, title: tag, text: f.slice(1).join(',') || '(no data)', tone: 'dim' }
  }
}

// The stream repeats the same handful of sentences every second, so a scrolling log is
// mostly noise. Collapse to the newest of each kind — one row per thing the receiver is
// telling you — keeping first-seen order so rows don't jump around between refreshes.
export function latestByKind(lines) {
  const seen = new Map()
  for (const line of lines || []) {
    const d = describeNmea(line)
    seen.set(d.key, { ...d, raw: line })
  }
  return [...seen.values()]
}

// One-line answer to "so what?" — the summary a person actually wants.
export function gpsSummary(gps) {
  if (!gps || !gps.alive) return { text: 'No data from the receiver.', tone: 'warn' }
  if ((gps.fix || 0) >= 1) return { text: `Fixed — using ${gps.satsUsed || 0} satellites.`, tone: 'ok' }
  if (gps.satsInView > 0) return { text: `Searching — ${gps.satsInView} satellite${gps.satsInView === 1 ? '' : 's'} heard, none locked on yet. This usually resolves within a minute or two.`, tone: 'warn' }
  return { text: 'Searching — no satellites heard at all. The receiver is alive and talking, but the antenna needs a clear view of the sky.', tone: 'warn' }
}
