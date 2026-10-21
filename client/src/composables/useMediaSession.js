import { watchEffect, onUnmounted } from 'vue'

// Route system controls through the room, just like the visible player buttons.
export function useMediaSession(player, getItem, { play, pause, seek }) {
  const session = navigator.mediaSession
  if (!session) return
  const handlers = {
    play,
    pause,
    seekbackward: ({ seekOffset = 10 }) => seek(player.currentTime.value - seekOffset),
    seekforward: ({ seekOffset = 10 }) => seek(player.currentTime.value + seekOffset),
    seekto: ({ seekTime }) => seek(seekTime),
  }
  for (const [action, handler] of Object.entries(handlers)) {
    try { session.setActionHandler(action, handler) } catch { /* Browser-specific actions. */ }
  }
  watchEffect(() => {
    const item = getItem()
    if (item && typeof MediaMetadata !== 'undefined') {
      session.metadata = new MediaMetadata({ title: item.title, artist: item.author, album: 'ABS Party' })
    }
  })
  watchEffect(() => {
    session.playbackState = player.isPlaying.value ? 'playing' : 'paused'
    const duration = player.duration.value
    const position = player.currentTime.value
    const playbackRate = player.playbackRate.value
    if (Number.isFinite(duration) && duration > 0 && Number.isFinite(position)) {
      try {
        session.setPositionState?.({ duration, position: Math.max(0, Math.min(position, duration)), playbackRate })
      } catch { /* Position reporting is optional; playback still works without it. */ }
    }
  })
  onUnmounted(() => {
    for (const action of Object.keys(handlers)) {
      try { session.setActionHandler(action, null) } catch {}
    }
    session.metadata = null
    session.playbackState = 'none'
    try { session.setPositionState?.() } catch {}
  })
}
