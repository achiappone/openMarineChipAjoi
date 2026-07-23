import { memo } from 'react'
import { Box } from '@mui/material'

// Wraps an existing SignalK webapp (Freeboard, KIP) in an iframe. Because our app
// is served from the same origin (:3000), these load with full data access and no
// CORS. The iframe stays mounted across tab switches (App only toggles its size /
// visibility) so the map and instruments keep their state instead of reloading.
// memo: never re-render on parent (App) state changes — props are stable.
function EmbeddedApp({ src, title }) {
  return (
    <Box
      component="iframe"
      src={src}
      title={title}
      sx={{ width: '100%', height: '100%', border: 0, display: 'block', bgcolor: '#000' }}
      allow="geolocation; fullscreen"
    />
  )
}

export default memo(EmbeddedApp)
