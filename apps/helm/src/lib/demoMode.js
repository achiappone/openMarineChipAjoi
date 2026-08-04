import { useState, useEffect } from 'react'

// Demo mode is set in Settings → Config but consumed by the Instruments panel, which is a
// separate view. Rather than lift state through the whole app, it lives in localStorage
// with a custom event for same-window updates — so the toggle takes effect immediately
// and survives a reload or a kiosk restart.
const KEY = 'helm.demo'
const EVENT = 'helm-demo-change'

export function getDemo() {
  try {
    const v = localStorage.getItem(KEY)
    return v == null ? true : v === '1'   // default on: a dry-docked helm should still move
  } catch (e) {
    return true
  }
}

export function setDemoMode(on) {
  try { localStorage.setItem(KEY, on ? '1' : '0') } catch (e) { /* private mode */ }
  try { window.dispatchEvent(new CustomEvent(EVENT, { detail: !!on })) } catch (e) { /* SSR */ }
}

export function useDemo() {
  const [demo, set] = useState(getDemo)
  useEffect(() => {
    const sync = () => set(getDemo())
    window.addEventListener(EVENT, sync)
    window.addEventListener('storage', sync)   // a second browser window/tab
    return () => { window.removeEventListener(EVENT, sync); window.removeEventListener('storage', sync) }
  }, [])
  return [demo, setDemoMode]
}
