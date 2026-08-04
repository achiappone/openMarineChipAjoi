import { useState } from 'react'
import { Box, Stack, Typography, Chip } from '@mui/material'
import { describeNmea, latestByKind, checksumStats, checksumOk } from '../lib/nmea'

const TONE = { ok: '#39d98a', warn: '#ffb52e', bad: '#ff3b30', dim: 'rgba(255,255,255,0.5)' }

// Readable view of the GPS stream. Defaults to one row per kind of sentence — the
// receiver repeats the same handful every second, so a scrolling log is mostly noise —
// with the raw text available behind a toggle for when you want to see the wire.
export default function NmeaConsole({ lines, maxHeight = 240 }) {
  const [raw, setRaw] = useState(false)
  const rows = latestByKind(lines)
  // Link integrity. All-valid is the boring normal case; failures mean the sentence was
  // damaged between the module and the Pi — wrong baud, a loose UART wire, or noise on
  // the line — which looks nothing like "no satellites" and shouldn't be confused with it.
  const cs = checksumStats(lines)
  if (!lines || !lines.length) {
    return <Box sx={{ opacity: 0.5, fontFamily: 'monospace', fontSize: '0.95rem' }}>waiting for NMEA…</Box>
  }
  return (
    <Box>
      <Stack direction="row" spacing={1} alignItems="center" sx={{ mb: 0.75 }}>
        <Chip size="small" label={raw ? 'Raw sentences' : 'Decoded'} onClick={() => setRaw(!raw)}
          variant={raw ? 'outlined' : 'filled'} sx={{ fontSize: '0.72rem', height: 24, cursor: 'pointer' }} />
        <Typography sx={{ fontSize: '0.72rem', opacity: 0.45 }}>
          {raw ? 'tap to read it in plain English' : `newest of each · tap for raw`}
        </Typography>
        <Box sx={{ flex: 1 }} />
        <Typography sx={{ fontSize: '0.72rem', fontWeight: 700, color: cs.bad ? TONE.bad : TONE.ok }}>
          {cs.total ? `${cs.ok}/${cs.total} checksums valid` : ''}
          {cs.bad ? ' — link is corrupting data' : ''}
        </Typography>
      </Stack>
      <Box sx={{ bgcolor: 'rgba(0,0,0,0.5)', borderRadius: 1, p: 1.25, maxHeight, overflowY: 'auto' }}>
        {raw ? (
          (lines || []).map((l, i) => (
            <Box key={i} sx={{ whiteSpace: 'nowrap', fontFamily: 'monospace', fontSize: '0.95rem', lineHeight: 1.45,
              color: checksumOk(l) === false ? TONE.bad : 'rgba(150,220,150,0.9)' }}>{l}</Box>
          ))
        ) : (
          rows.map((r, i) => (
            <Box key={r.key} sx={{ display: 'flex', alignItems: 'baseline', gap: 1.5, py: 0.5,
              borderBottom: i < rows.length - 1 ? '1px solid rgba(255,255,255,0.07)' : 'none' }}>
              <Typography sx={{ minWidth: 104, fontWeight: 800, fontSize: '0.85rem', color: TONE[r.tone] || TONE.dim }}>{r.title}</Typography>
              <Typography sx={{ flex: 1, fontSize: '0.95rem', lineHeight: 1.35 }}>{r.text}</Typography>
            </Box>
          ))
        )}
      </Box>
    </Box>
  )
}
