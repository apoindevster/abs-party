<template>
  <div class="room-page">
    <!-- Error / loading states -->
    <div v-if="fatalError" class="fatal">
      <p>{{ fatalError }}</p>
      <button @click="router.push('/')">Go home</button>
    </div>

    <template v-else>
      <!-- Header bar -->
      <div class="room-header">
        <div class="room-meta">
          <span class="room-title">{{ roomState.item?.title || 'Connecting…' }}</span>
          <span class="room-author">{{ roomState.item?.author }}</span>
        </div>
        <div class="room-code">
          Room: <strong>{{ roomId }}</strong>
          <button class="btn-copy" @click="copyLink" title="Copy invite link" aria-label="Copy invite link">📋</button>
        </div>
        <button class="btn-leave" @click="leaveRoom">Leave</button>
      </div>

      <!-- Main content: player + sidebar -->
      <div class="room-body">
        <!-- Player -->
        <div class="player-area">
          <div v-if="bookmarkSaved" class="notice">
            ✅ Bookmark saved at your previous position — you can restore it from the ABS bookmarks panel.
          </div>
          <p v-if="!connected" class="connection-notice" role="status">Reconnecting to the room… Audio may continue while controls reconnect.</p>
          <div v-if="preparing" class="status">Opening playback session…</div>

          <div v-else class="player">
            <div v-if="player.needsInteraction.value" class="playback-notice" role="status">
              <p>Your browser needs a tap to start listening.</p>
              <button class="ctrl-btn" :disabled="!connected" @click="requestPlay">Tap to listen</button>
            </div>
            <p v-if="player.playbackError.value" class="playback-error" role="alert">{{ player.playbackError.value }}</p>
            <!-- Cover -->
            <div class="cover-wrap">
              <img
                v-if="roomState.item?.id"
                :src="`${absBase}/api/items/${roomState.item.id}/cover`"
                class="cover"
                alt="cover"
              />
            </div>

            <!-- Progress bar -->
            <div class="progress-wrap">
              <span class="time">{{ fmt(player.currentTime.value) }}</span>
              <input
                type="range"
                class="progress"
                :value="scrubPosition ?? player.currentTime.value"
                :max="player.duration.value || 1"
                step="1"
                aria-label="Playback position"
                :aria-valuetext="`${fmt(scrubPosition ?? player.currentTime.value)} of ${fmt(player.duration.value)}`"
                :disabled="!connected"
                @input="scrubPosition = Number($event.target.value)"
                @change="onSeek"
              />
              <span class="time">{{ fmt(player.duration.value) }}</span>
            </div>

            <!-- Controls -->
            <div class="controls">
              <button class="ctrl-btn" :disabled="!connected" aria-label="Skip back 10 seconds" @click="skip(-10)">-10s</button>
              <button class="ctrl-btn play-btn" :class="{ buffering: buffering }" :disabled="!connected && !player.isPlaying.value" :aria-label="buffering ? 'Cancel playback' : player.isPlaying.value ? 'Pause' : 'Play'" @click="togglePlay">
                {{ buffering ? '⏳' : player.isPlaying.value ? '⏸' : '▶' }}
              </button>
              <button class="ctrl-btn" :disabled="!connected" aria-label="Skip forward 10 seconds" @click="skip(10)">+10s</button>
            </div>
            <div v-if="buffering" class="buffering-notice">Buffering…</div>

            <p v-if="!player.isPlaying.value" class="listening-hint">Start listening before locking your phone. Use your phone’s volume buttons to adjust the sound.</p>
            <div class="volume-row">
              <label class="volume-label">Vol
                <input
                  type="range"
                  class="volume-slider"
                  :value="player.volume.value"
                  min="0" max="1" step="0.05"
                  @input="e => player.setVolume(Number(e.target.value))"
                />
              </label>
            </div>
          </div>
        </div>

        <!-- Participants + Bookmarks sidebar -->
        <details class="sidebar" :open="detailsOpen" @toggle="detailsOpen = $event.target.open">
          <summary>Listeners &amp; bookmarks</summary>
          <div class="sidebar-content">
            <h3>Listeners ({{ participants.length }})</h3>
            <ul class="participant-list">
              <li v-for="p in participants" :key="p.name" :class="{ host: p.is_host }">
                {{ p.name }}<span v-if="p.is_host" class="host-badge">host</span>
              </li>
            </ul>

            <div class="sidebar-divider"></div>

            <h3>Bookmarks</h3>
            <div class="bookmark-add">
              <input
                v-model="newBookmarkTitle"
                class="bookmark-input"
                placeholder="Title (optional)"
                aria-label="Bookmark title"
                @keyup.enter="addBookmark"
              />
              <button class="btn-bookmark-add" @click="addBookmark">Add</button>
            </div>
            <ul class="bookmark-list">
              <li v-for="b in bookmarks" :key="b.time">
                <button class="bookmark-item bookmark-seekable" :disabled="!connected" @click="seekToBookmark(b)">
                  <span class="bookmark-title">{{ b.title }}</span>
                  <span class="bookmark-time">{{ fmt(b.time) }}</span>
                </button>
              </li>
              <li v-if="bookmarks.length === 0" class="bookmark-empty">No bookmarks yet</li>
            </ul>
          </div>
        </details>
      </div>

      <!-- Event log -->
      <details v-if="eventLog.length > 0" class="event-log" :open="!compactScreen">
        <summary>Room activity</summary>
        <div v-for="(e, i) in eventLog" :key="i" class="event-entry" :class="`event-${e.level}`">
          <span class="event-time">{{ e.time }}</span>
          <span class="event-msg">{{ e.message }}</span>
        </div>
      </details>
    </template>
  </div>
</template>

<script setup>
import { ref, reactive, computed, inject, onMounted, onBeforeUnmount, onUnmounted, watch, watchEffect } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useWebSocket } from '../composables/useWebSocket.js'
import { useMediaSession } from '../composables/useMediaSession.js'
import { useAbsPlayer } from '../composables/useAbsPlayer.js'
import { useSyncEngine } from '../composables/useSyncEngine.js'
import { getBookmarks, createBookmark } from '../api/abs.js'
import { useEventLog } from '../composables/useEventLog.js'
import { useAudioCues } from '../composables/useAudioCues.js'
import { shortenTitle } from '../utils/title.js'

const route = useRoute()
const router = useRouter()
const auth = inject('auth')
const absBase = inject('ABS_BASE')

const roomId = ref(route.params.id)
// Reclaim this connection after a network switch even if the old TCP socket lingers.
const resumeKey = crypto.randomUUID()
const isHostMode = route.query.host === 'true'  // constant: this tab intends to act as room creator
const displayName = computed(() => auth.username)

const compactScreen = window.matchMedia('(max-width: 700px)').matches
const detailsOpen = ref(!compactScreen)
const scrubPosition = ref(null)
const fatalError = ref('')
const preparing = ref(true)
const bookmarkSaved = ref(false)
const buffering = ref(false)
const participants = ref([])
const bookmarks = ref([])
const newBookmarkTitle = ref('')
const roomState = reactive({ item: null, position: 0, playing: false, speed: 1 })
const isHost = ref(isHostMode)


const previousTitle = document.title
watchEffect(() => {
  const bookTitle = roomState.item?.title
  if (bookTitle) {
    const role = isHost.value ? 'Host' : 'Guest'
    document.title = `${shortenTitle(bookTitle)} [${role}] — ABS Party`
  } else {
    document.title = 'ABS Party'
  }
})
onUnmounted(() => { document.title = previousTitle })

let bufferingTimeout = null
let bufferingReadyCb = null

let hasConnectedOnce = false
let opening = false
let disposed = false
let roomUpdatedAt = Date.now()
let bookmarkTimer = null
let awaitingBuffer = false

const player = useAbsPlayer(absBase, { onEnded: finishPlayback })

const { events: eventLog, addEvent } = useEventLog()
const { playJoinLeave, playAlert } = useAudioCues(player.volume)

const { connect, send, disconnect, connected, rtt } = useWebSocket(handleMessage)
const { handleMessage: applySyncMsg } = useSyncEngine(player, rtt, () => {
  addEvent('Desync detected — correcting…', 'alert')
  playAlert()
})

useMediaSession(player, () => roomState.item, {
  play: requestPlay,
  pause: requestPause,
  seek: seekRoom,
})

watch(connected, (val, old) => {
  if (old && !val) {
    awaitingBuffer = false
    cancelBuffering()
    addEvent('Connection lost — reconnecting…', 'alert')
  } else if (!old && val) {
    if (hasConnectedOnce) addEvent('Reconnected', 'normal')
    hasConnectedOnce = true
    rejoinRoom()
  }
})

onMounted(() => {
  if (!auth.token) {
    fatalError.value = 'You must be signed in to join a room.'
    return
  }
  if (isHostMode && !route.query.itemId) {
    fatalError.value = 'No book selected. Please go back and pick a book from the library first.'
    return
  }
  connect()
})

onBeforeUnmount(() => {
  disposed = true
  clearTimeout(bookmarkTimer)
  cancelBuffering()
  send({ type: 'leave' })
  disconnect()
})

function setRoomPosition(position, playing = roomState.playing) {
  roomState.position = position
  roomState.playing = playing
  roomUpdatedAt = Date.now()
}

function estimatedRoomPosition() {
  return roomState.position + (roomState.playing ? (Date.now() - roomUpdatedAt) / 1000 * roomState.speed : 0)
}

function restoreRoomState() {
  player.setSpeed(roomState.speed)
  player.seekTo(estimatedRoomPosition())
  if (roomState.playing) player.play()
  else player.pause()
}

async function handleMessage(msg) {
  if (disposed) return
  if (msg.type === 'room_state') {
    // The server replays a still-pending play intent after this snapshot.
    awaitingBuffer = false
    cancelBuffering()
    roomState.item = msg.item
    setRoomPosition(msg.position, msg.playing)
    roomState.speed = msg.speed
    participants.value = msg.participants
    const me = participants.value.find(p => p.name === displayName.value)
    isHost.value = me?.is_host ?? false

    if (preparing.value) {
      if (opening) return
      opening = true
      // Only a fresh, empty room starts from the creator's ABS progress.
      const useSavedPosition = msg.created === true
      try {
        const session = await player.open(auth.token, roomState.item.id)
        if (disposed || !session) return
        bookmarkSaved.value = true
        bookmarkTimer = setTimeout(() => { bookmarkSaved.value = false }, 5000)
        if (useSavedPosition && !roomState.playing && roomState.position === 0 && !awaitingBuffer) {
          const startPos = Math.max(0, session.currentTime ?? 0)
          setRoomPosition(startPos)
          send({ type: 'seek', position: startPos })
        }
        preparing.value = false
        restoreRoomState()
        if (awaitingBuffer) beginBuffering(roomState.position)
        loadBookmarks()
      } catch (e) {
        fatalError.value = 'Failed to open playback session: ' + e.message
      } finally {
        opening = false
      }
    } else {
      // A room may have expired while this phone kept playing. Only the creator
      // of a newly created room seeds its position; existing rooms stay authoritative.
      if (msg.created) {
        const wasPlaying = player.isPlaying.value
        const position = player.currentTime.value
        setRoomPosition(position, false)
        send({ type: 'seek', position })
        restoreRoomState()
        if (wasPlaying) send({ type: 'play_intent', position })
      } else {
        restoreRoomState()
      }
    }
    return
  }

  if (msg.type === 'participant_joined') {
    participants.value.push({ name: msg.name, is_host: false })
    addEvent(`${msg.name} joined`, 'normal')
    playJoinLeave()
    return
  }
  if (msg.type === 'participant_left') {
    participants.value = participants.value.filter(p => p.name !== msg.name)
    addEvent(`${msg.name} left`, 'normal')
    playJoinLeave()
    return
  }
  if (msg.type === 'host_changed') {
    participants.value = participants.value.map(p => ({ ...p, is_host: p.name === msg.name }))
    isHost.value = msg.name === displayName.value
    return
  }
  if (msg.type === 'error') {
    fatalError.value = msg.message
    return
  }

  if (msg.type === 'play_intent') {
    setRoomPosition(msg.position, false)
    awaitingBuffer = true
    addEvent(`${msg.sender_name || 'Someone'} starting playback — buffering…`, 'normal')
    if (!preparing.value) beginBuffering(msg.position)
    return
  }

  if (msg.type === 'play' || msg.type === 'pause') {
    setRoomPosition(msg.position, msg.type === 'play')
    addEvent(msg.type === 'play' ? 'All ready — playing' : `${msg.sender_name} paused playback`, 'normal')
    awaitingBuffer = false
    cancelBuffering()
  }
  if (msg.type === 'seek') {
    setRoomPosition(msg.position)
    addEvent(`${msg.sender_name} seeked to ${fmt(msg.position)}`, 'normal')
  }
  if (msg.type === 'speed') {
    setRoomPosition(estimatedRoomPosition())
    roomState.speed = msg.rate
  }
  if (!preparing.value) applySyncMsg(msg)
}

function beginBuffering(position) {
  cancelBuffering()
  buffering.value = true
  player.pause()
  player.seekTo(position)
  bufferingReadyCb = () => {
    if (player.audio.readyState >= 3 && !player.audio.seeking) sendReady()
  }
  player.audio.addEventListener('canplay', bufferingReadyCb)
  player.audio.addEventListener('seeked', bufferingReadyCb)
  bufferingTimeout = setTimeout(sendReady, 20_000)
  bufferingReadyCb()
}

function sendReady() {
  cancelBuffering()
  send({ type: 'ready' })
}

function cancelBuffering() {
  buffering.value = false
  clearTimeout(bufferingTimeout)
  bufferingTimeout = null
  if (bufferingReadyCb) {
    player.audio.removeEventListener('canplay', bufferingReadyCb)
    player.audio.removeEventListener('seeked', bufferingReadyCb)
    bufferingReadyCb = null
  }
}

function rejoinRoom() {
  if (isHostMode) {
    send({
      type: 'create_room',
      resume_key: resumeKey,
      room_id: roomId.value,
      abs_token: auth.token,
      item_id: roomState.item?.id || route.query.itemId,
      item_title: roomState.item?.title || route.query.title,
      item_author: roomState.item?.author || route.query.author,
      library_id: roomState.item?.library_id || route.query.libraryId,
    })
  } else if (roomId.value) {
    send({ type: 'join', room_id: roomId.value, abs_token: auth.token, resume_key: resumeKey })
  }
}

function togglePlay() {
  if (player.isPlaying.value || buffering.value) requestPause()
  else requestPlay()
}

async function requestPlay() {
  if (preparing.value || !connected.value || buffering.value) return
  if (roomState.playing) {
    // A listener whose browser blocked autoplay catches up without restarting everyone.
    player.seekTo(estimatedRoomPosition())
    player.play()
  } else {
    // Replay a completed book from its beginning, including multi-file books.
    if (player.duration.value > 0 && player.currentTime.value >= player.duration.value) player.seekTo(0)
    // Start from the gesture itself. The room's buffering response pauses this
    // element, then the shared play command resumes it after everyone is ready.
    const started = await player.play()
    if (!started || disposed || !connected.value || roomState.playing) return
    send({ type: 'play_intent', position: player.currentTime.value })
    addEvent('You started playback — waiting for all to buffer…', 'normal')
  }
}

function requestPause() {
  pauseRoom('You paused playback')
}

function finishPlayback() {
  if (disposed || preparing.value) return
  pauseRoom('Playback finished')
}

function pauseRoom(message) {
  player.pause()
  cancelBuffering()
  awaitingBuffer = false
  setRoomPosition(player.currentTime.value, false)
  send({ type: 'pause', position: player.currentTime.value })
  addEvent(message, 'normal')
}

function seekRoom(seconds) {
  if (preparing.value || !connected.value || !Number.isFinite(seconds)) return
  const pos = player.seekTo(seconds)
  setRoomPosition(pos)
  send({ type: 'seek', position: pos })
  addEvent(`You seeked to ${fmt(pos)}`, 'normal')
}

function onSeek(evt) {
  seekRoom(Number(evt.target.value))
  scrubPosition.value = null
}

function skip(seconds) {
  seekRoom(player.currentTime.value + seconds)
}

function seekToBookmark(b) {
  seekRoom(b.time)
}

async function loadBookmarks() {
  if (!roomState.item?.id) return
  try {
    const data = await getBookmarks(null, auth.token, roomState.item.id)
    bookmarks.value = Array.isArray(data) ? data.sort((a, b) => b.time - a.time) : []
  } catch (e) {
    console.warn('Failed to load bookmarks:', e)
  }
}

async function addBookmark() {
  if (!roomState.item?.id) return
  const time = player.currentTime.value
  const ts = new Date().toISOString().slice(0, 19)
  const title = newBookmarkTitle.value.trim() || ts
  try {
    await createBookmark(null, auth.token, roomState.item.id, time, title)
    newBookmarkTitle.value = ''
    await loadBookmarks()
  } catch (e) {
    console.warn('Failed to create bookmark:', e)
  }
}

async function leaveRoom() {
  send({ type: 'leave' })
  disconnect()
  player.close()
  router.push('/')
}

async function copyLink() {
  try {
    await navigator.clipboard.writeText(`${location.origin}/room/${roomId.value}`)
    addEvent('Invite link copied', 'normal')
  } catch {
    addEvent(`Share room code ${roomId.value} to invite a listener.`, 'alert')
  }
}

function fmt(s) {
  if (!s || isNaN(s)) return '0:00'
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = Math.floor(s % 60)
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  return `${m}:${String(sec).padStart(2, '0')}`
}
</script>

<style scoped>
.room-page { display: flex; flex-direction: column; height: 100%; overflow: hidden; }
.room-header { display: flex; align-items: center; gap: 1rem; padding: 0.75rem 1.5rem; background: #16213e; border-bottom: 1px solid #0f3460; flex-wrap: wrap; }
.room-meta { flex: 1; min-width: 0; overflow-wrap: anywhere; }
.room-title { font-weight: 700; font-size: 1rem; color: #e0e0e0; }
.room-author { display: block; font-size: 0.8rem; color: #aaa; }
.room-code { font-size: 0.85rem; color: #aaa; display: flex; align-items: center; gap: 0.4rem; }
.btn-copy { background: none; border: none; cursor: pointer; font-size: 1rem; line-height: 1; }
.btn-leave { background: #d63031; border: none; border-radius: 6px; color: #fff; padding: 0.4rem 1rem; cursor: pointer; font-size: 0.85rem; }

.room-body { display: flex; flex: 1; overflow: hidden; min-height: 0; }
.player-area { min-width: 0; flex: 1; display: flex; flex-direction: column; align-items: center; padding: 2rem; overflow-y: auto; }
.sidebar { flex-shrink: 0; width: 240px; border-left: 1px solid #0f3460; padding: 1rem; overflow-y: auto; background: #16213e; }

.notice { background: #00b894; color: #062f2a; border-radius: 8px; padding: 0.75rem 1rem; margin-bottom: 1rem; font-size: 0.85rem; max-width: 500px; }
.status { color: #aaa; margin: 3rem 0; }

.player { display: flex; flex-direction: column; align-items: center; gap: 1.5rem; width: 100%; max-width: 500px; }
.cover-wrap { width: min(220px, 100%); aspect-ratio: 1; flex-shrink: 0; border-radius: 12px; overflow: hidden; background: #0f3460; }
.cover { width: 100%; height: 100%; object-fit: cover; }

.progress-wrap { display: flex; align-items: center; gap: 0.75rem; width: 100%; }
.progress { touch-action: pan-y; min-width: 0; min-height: 44px; flex: 1; accent-color: #6c5ce7; }
.time { font-size: 0.8rem; color: #aaa; white-space: nowrap; min-width: 45px; }

.controls { display: flex; gap: 1rem; align-items: center; }
.ctrl-btn { background: #16213e; border: 1px solid #0f3460; color: #ccc; padding: 0.6rem 1.2rem; border-radius: 8px; cursor: pointer; font-size: 0.9rem; }
.ctrl-btn:disabled { opacity: 0.4; cursor: default; }
.play-btn { font-size: 1.5rem; padding: 0.75rem 1.5rem; background: #6c5ce7; border-color: #6c5ce7; color: #fff; border-radius: 50%; width: 64px; height: 64px; display: flex; align-items: center; justify-content: center; }
.play-btn.buffering { background: #fdcb6e; border-color: #fdcb6e; color: #2d3436; }
.buffering-notice { font-size: 0.8rem; color: #fdcb6e; }

.volume-row { display: flex; align-items: center; justify-content: center; }
.volume-label { display: flex; align-items: center; gap: 0.5rem; font-size: 0.85rem; color: #aaa; white-space: nowrap; }
.volume-slider { width: 90px; accent-color: #6c5ce7; cursor: pointer; }

.sidebar h3 { margin: 0 0 0.75rem; font-size: 0.9rem; color: #aaa; }
.sidebar-divider { border: none; border-top: 1px solid #0f3460; margin: 1rem 0; }
.bookmark-add { display: flex; gap: 0.4rem; margin-bottom: 0.6rem; }
.bookmark-input { flex: 1; min-width: 0; padding: 0.3rem 0.5rem; background: #0f3460; border: 1px solid #1a4a80; border-radius: 4px; color: #fff; font-size: 0.8rem; }
.bookmark-input::placeholder { color: #a3aac1; }
.btn-bookmark-add { background: #6c5ce7; border: none; border-radius: 4px; color: #fff; padding: 0.3rem 0.6rem; cursor: pointer; font-size: 0.8rem; white-space: nowrap; }
.bookmark-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.35rem; }
.bookmark-item { width: 100%; border: 0; background: transparent; text-align: left; padding: 0.5rem 0; min-height: 44px; display: flex; justify-content: space-between; align-items: baseline; gap: 0.4rem; font-size: 0.8rem; }
.bookmark-title { color: #ccc; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.bookmark-time { color: #b9b3ff; white-space: nowrap; flex-shrink: 0; font-variant-numeric: tabular-nums; }
.bookmark-empty { font-size: 0.8rem; color: #a3aac1; }
.bookmark-seekable { cursor: pointer; }
.bookmark-seekable:hover .bookmark-time { color: #a29bfe; }
.participant-list { list-style: none; padding: 0; margin: 0; display: flex; flex-direction: column; gap: 0.5rem; }
.participant-list li { font-size: 0.9rem; color: #e0e0e0; display: flex; align-items: center; gap: 0.5rem; }
.participant-list li.host { color: #a29bfe; font-weight: 600; }
.host-badge { font-size: 0.7rem; background: #6c5ce7; color: #fff; padding: 0.15rem 0.4rem; border-radius: 4px; }
.fatal { display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100%; padding: 1.5rem; gap: 1rem; color: #ff7675; }
.fatal button { background: #6c5ce7; border: none; border-radius: 6px; color: #fff; padding: 0.6rem 1.5rem; cursor: pointer; }

.event-log { background: #080815; border-top: 1px solid #0f3460; padding: 0.35rem 1rem; font-family: monospace; font-size: 0.72rem; display: flex; flex-direction: column; gap: 0.1rem; }
.event-entry { display: flex; gap: 0.75rem; }
.event-time { color: #a3aac1; flex-shrink: 0; }
.event-normal .event-msg { color: #a3aac1; }
.event-alert .event-msg { color: #e17055; }
summary { cursor: pointer; min-height: 44px; display: list-item; align-content: center; font-weight: 600; }
.sidebar-content { padding-top: 0.75rem; }
.sidebar > summary { font-size: 0.9rem; color: #e0e0e0; }
.connection-notice, .playback-notice, .playback-error { width: 100%; max-width: 500px; margin: 0 0 1rem; color: #fdcb6e; line-height: 1.5; }
.playback-notice p { margin: 0 0 0.75rem; }
.playback-error { color: #ffaaa9; }
.listening-hint { display: none; margin: 0; text-align: center; color: #aaa; font-size: 0.85rem; line-height: 1.5; max-width: 35ch; }
.event-log { flex-shrink: 0; max-height: 160px; overflow-y: auto; }
.event-log summary { font: 600 0.85rem system-ui, sans-serif; }
.event-entry { padding-bottom: 0.25rem; }
.event-msg { overflow-wrap: anywhere; }
@media (max-width: 700px), (pointer: coarse) and (max-height: 500px) {
  .room-page { overflow-y: auto; }
  .room-header { display: grid; grid-template-columns: minmax(0, 1fr) auto; padding: 0.75rem 1rem; gap: 0.5rem 1rem; flex-shrink: 0; }
  .room-meta { grid-column: 1; grid-row: 1; }
  .btn-leave { grid-column: 2; grid-row: 1; }
  .room-title { display: block; }
  .room-author { font-size: 0.875rem; margin-top: 0.25rem; }
  .room-code { grid-column: 1 / -1; grid-row: 2; width: 100%; }
  .btn-leave, .btn-copy { min-height: 44px; min-width: 44px; }
  .room-body { flex: 0 0 auto; flex-direction: column; overflow: visible; }
  .player-area { overflow: visible; padding: 1rem; }
  .player { gap: 1rem; }
  .listening-hint { display: block; }
  .cover-wrap { width: min(220px, 50vw, 32dvh); }
  .progress-wrap { gap: 0.5rem; }
  .controls { gap: 1.25rem; }
  .ctrl-btn { min-height: 48px; min-width: 48px; }
  .play-btn { width: 72px; height: 72px; }
  .sidebar { width: 100%; border-left: 0; border-top: 1px solid #0f3460; overflow: visible; padding: 0.5rem 1rem; }
  .bookmark-input { font-size: 1rem; }
  .bookmark-title { white-space: normal; overflow-wrap: anywhere; }
  .bookmark-item { font-size: 0.9rem; }
  .notice { font-size: 0.875rem; }
  .event-log { margin-top: auto; max-height: none; overflow: visible; }
  .event-entry { font-size: 0.8rem; }
}
@media (pointer: coarse) {
  .volume-row { display: none; }
}
@media (pointer: coarse) and (orientation: landscape) and (max-height: 500px) {
  .player { display: grid; grid-template-columns: 120px minmax(0, 1fr); max-width: 650px; column-gap: 1.5rem; }
  .cover-wrap { grid-column: 1; grid-row: 1 / span 3; width: 120px; }
  .progress-wrap, .controls, .listening-hint, .playback-notice, .playback-error, .buffering-notice { grid-column: 2; }
  .controls { justify-content: center; }
}
</style>
