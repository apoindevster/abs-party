import { ref, onUnmounted } from 'vue'
import Hls from 'hls.js'
import { startPlaybackSession, syncProgress, closeSession, getProgress, createBookmark } from '../api/abs.js'

const SYNC_INTERVAL_MS = 10_000

export function useAbsPlayer(absBase, { onEnded } = {}) {
  // Keep one media element for the session: mobile playback permission belongs to it.
  const audio = new Audio()
  audio.preload = 'auto'
  audio.setAttribute('playsinline', '')
  const sessionId = ref(null)
  const currentTime = ref(0)
  const duration = ref(0)
  const isPlaying = ref(false)
  const needsInteraction = ref(false)
  const playbackError = ref('')
  const playbackRate = ref(1)
  const saved = parseFloat(localStorage.getItem('absPartyVolume'))
  if (isFinite(saved) && saved >= 0 && saved <= 1) audio.volume = saved
  const volume = ref(audio.volume)

  let hls = null
  let tracks = []
  let trackIndex = 0
  let pendingSeek = null
  let playAttempt = 0
  let closed = false
  let closePromise = null
  let syncTimer = null
  let listenedSinceSync = 0
  let lastSyncTime = 0
  let currentToken = null
  let currentItemId = null

  audio.addEventListener('timeupdate', () => {
    if (pendingSeek !== null) return
    currentTime.value = (tracks[trackIndex]?.startOffset ?? 0) + audio.currentTime
  })
  audio.addEventListener('loadedmetadata', applyPendingSeek)
  audio.addEventListener('canplay', applyPendingSeek)
  audio.addEventListener('durationchange', () => {
    if (!duration.value && Number.isFinite(audio.duration)) duration.value = audio.duration
  })
  audio.addEventListener('playing', () => {
    isPlaying.value = true
    needsInteraction.value = false
    playbackError.value = ''
  })
  audio.addEventListener('pause', () => { isPlaying.value = false })
  audio.addEventListener('ratechange', () => { playbackRate.value = audio.playbackRate })
  audio.addEventListener('error', () => {
    if (closed) return
    isPlaying.value = false
    playbackError.value = 'Audio could not load. Check your connection and try playing again.'
  })
  audio.addEventListener('ended', () => {
    if (closed) return
    isPlaying.value = false
    if (trackIndex < tracks.length - 1) {
      trackIndex++
      pendingSeek = 0
      loadDirectTrack(tracks[trackIndex])
      play()
    } else {
      currentTime.value = duration.value || currentTime.value
      onEnded?.()
    }
  })

  async function open(token, libraryItemId) {
    currentToken = token
    currentItemId = libraryItemId
    await savePreJoinBookmark(token, libraryItemId)
    if (closed) return null
    const session = await startPlaybackSession(null, token, libraryItemId)
    if (closed) {
      await closeSession(null, token, session.id, session.currentTime ?? 0, 0)
      return null
    }
    sessionId.value = session.id
    const audioTracks = session.audioTracks ?? []
    if (!audioTracks.length) throw new Error('No playable audio tracks were returned.')
    const last = audioTracks[audioTracks.length - 1]
    duration.value = (last.startOffset ?? 0) + (last.duration ?? 0) || session.duration || 0
    const first = audioTracks[0]
    const rawUrl = first.contentUrl?.startsWith('http') ? first.contentUrl : `${absBase}${first.contentUrl}`
    if (rawUrl.includes('.m3u8')) {
      loadHls(rawUrl)
    } else {
      tracks = audioTracks
      trackIndex = 0
      loadDirectTrack(first)
    }
    startSyncTimer()
    return session
  }

  function loadHls(src) {
    // Prefer the browser's media pipeline on Safari, including screen-off playback.
    if (audio.canPlayType('application/vnd.apple.mpegurl')) {
      audio.src = src
    } else if (Hls.isSupported()) {
      hls = new Hls()
      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (data.fatal) {
          isPlaying.value = false
          playbackError.value = 'The audio stream was interrupted. Leave and rejoin the room to retry.'
        }
      })
      hls.loadSource(src)
      hls.attachMedia(audio)
    } else {
      throw new Error('This browser does not support this audio stream.')
    }
  }

  function loadDirectTrack(track) {
    const base = track.contentUrl.startsWith('http') ? '' : absBase
    const url = new URL(`${base}${track.contentUrl}`, location.origin)
    url.searchParams.set('token', currentToken)
    audio.src = url.href
    audio.load()
    audio.playbackRate = playbackRate.value
  }

  async function savePreJoinBookmark(token, libraryItemId) {
    try {
      const progress = await getProgress(null, token, libraryItemId)
      const time = Math.max(0, progress?.currentTime ?? 0)
      const ts = new Date().toISOString().slice(0, 19)
      await createBookmark(null, token, libraryItemId, time, `pre_party_${ts}`)
    } catch (e) {
      console.warn('Could not save pre-join bookmark:', e)
    }
  }

  async function play() {
    if (closed) return false
    const attempt = ++playAttempt
    playbackError.value = ''
    try {
      // Call before any await so a tap or media-key action retains user activation.
      await audio.play()
      if (closed || attempt !== playAttempt) return false
      isPlaying.value = !audio.paused
      needsInteraction.value = false
      return true
    } catch (error) {
      if (closed || attempt !== playAttempt) return false
      isPlaying.value = false
      if (error.name === 'NotAllowedError') {
        needsInteraction.value = true
      } else if (error.name !== 'AbortError') {
        playbackError.value = 'Playback could not start. Check your connection and try again.'
      }
      return false
    }
  }

  function pause() {
    playAttempt++
    audio.pause()
    isPlaying.value = false
  }

  function applyPendingSeek() {
    if (pendingSeek === null || audio.readyState < 1) return
    try {
      audio.currentTime = pendingSeek
      pendingSeek = null
    } catch { /* Some streams are not seekable until canplay. */ }
  }

  function seekTo(seconds) {
    if (!Number.isFinite(seconds)) return currentTime.value
    const target = Math.max(0, Math.min(seconds, duration.value || Infinity))
    let nextIndex = 0
    if (tracks.length > 1) {
      nextIndex = tracks.findIndex(track => target < track.startOffset + track.duration)
      if (nextIndex < 0) nextIndex = tracks.length - 1
    }
    const resume = !audio.paused
    pendingSeek = target - (tracks[nextIndex]?.startOffset ?? 0)
    if (nextIndex !== trackIndex) {
      trackIndex = nextIndex
      loadDirectTrack(tracks[trackIndex])
      if (resume) play()
    }
    applyPendingSeek()
    currentTime.value = target
    lastSyncTime = target
    return target
  }

  function setSpeed(rate) {
    audio.playbackRate = rate
    playbackRate.value = rate
  }

  function setVolume(v) {
    audio.volume = v
    volume.value = audio.volume
    localStorage.setItem('absPartyVolume', v)
  }

  function startSyncTimer() {
    clearInterval(syncTimer)
    lastSyncTime = currentTime.value
    syncTimer = setInterval(async () => {
      if (!sessionId.value || !currentToken) return
      const now = currentTime.value
      const delta = Math.max(0, now - lastSyncTime)
      listenedSinceSync += isPlaying.value ? delta / playbackRate.value : 0
      lastSyncTime = now
      if (listenedSinceSync >= 10) {
        const listened = listenedSinceSync
        listenedSinceSync = 0
        try {
          await syncProgress(null, currentToken, sessionId.value, now, listened)
        } catch (e) {
          listenedSinceSync += listened
          console.warn('Progress sync failed:', e)
        }
      }
    }, SYNC_INTERVAL_MS)
  }

  function close() {
    if (closePromise) return closePromise
    closed = true
    clearInterval(syncTimer)
    pause()
    hls?.destroy()
    hls = null
    audio.removeAttribute('src')
    audio.load()
    const id = sessionId.value
    sessionId.value = null
    closePromise = (async () => {
      if (id && currentToken && currentItemId) {
        const time = Math.max(0, currentTime.value)
        const ts = new Date().toISOString().slice(0, 19)
        try { await createBookmark(null, currentToken, currentItemId, time, `leave_${ts}`) } catch {}
        try { await closeSession(null, currentToken, id, time, listenedSinceSync) } catch {}
      }
    })()
    return closePromise
  }

  onUnmounted(close)
  return { open, play, pause, seekTo, setSpeed, setVolume, close, currentTime, duration, volume,
    isPlaying, needsInteraction, playbackError, playbackRate, audio }
}
