import { createContext, useContext } from 'react'

// Live control values, shared from the app shell to any view that shows them.
//
// The stereo state is polled every 2s, which is fine for "what's playing" and useless
// for anything a hand is moving right now. The shell already receives volume and tuning
// events over SSE the instant a detent lands; this hands those to the views so the big
// on-screen readouts react at the same speed as the knob dial, instead of catching up on
// the next poll. The polled state stays authoritative — these are display overrides that
// expire as soon as it agrees.

const LiveControlsContext = createContext({ volume: null, freq: null, mode: 'volume', turning: false })

export function LiveControlsProvider({ value, children }) {
  return <LiveControlsContext.Provider value={value}>{children}</LiveControlsContext.Provider>
}

export function useLiveControls() {
  return useContext(LiveControlsContext)
}

// Convenience: the frequency to display, preferring the live one while it exists.
export function useLiveFreq(polled) {
  const { freq } = useLiveControls()
  return freq != null ? freq : polled
}
