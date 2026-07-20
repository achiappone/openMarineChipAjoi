import { createTheme } from '@mui/material/styles'

// Dark "marine helm" theme — high contrast for daylight, easy on the eyes at night.
const theme = createTheme({
  palette: {
    mode: 'dark',
    background: { default: '#0b1622', paper: '#12212f' },
    primary: { main: '#39a0ff' },
    secondary: { main: '#f5a623' },
    success: { main: '#3ddc84' },
  },
  shape: { borderRadius: 10 },
  typography: {
    fontFamily: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif',
    // Big touch targets / readable at a glance on the helm screen.
    button: { fontSize: '1rem', fontWeight: 700, textTransform: 'none' },
  },
})

export default theme
