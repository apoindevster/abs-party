import { mount, flushPromises } from '@vue/test-utils'
import { ref } from 'vue'
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest'
import Room from './Room.vue'

const state = vi.hoisted(() => ({ player: null, connected: null, message: null, onEnded: null, send: vi.fn() }))
vi.mock('vue-router', () => ({
  useRoute: () => ({ params: { id: 'mobile01' }, query: { host: 'true', itemId: 'book', title: 'Book', author: 'Author', libraryId: 'lib' } }),
  useRouter: () => ({ push: vi.fn() }),
}))
vi.mock('../composables/useAbsPlayer.js', () => ({ useAbsPlayer: (_base, options) => {
  state.onEnded = options?.onEnded
  return state.player
} }))
vi.mock('../composables/useMediaSession.js', () => ({ useMediaSession: vi.fn() }))
vi.mock('../composables/useAudioCues.js', () => ({ useAudioCues: () => ({ playJoinLeave: vi.fn(), playAlert: vi.fn() }) }))
vi.mock('../composables/useWebSocket.js', () => ({ useWebSocket: handler => {
  state.message = handler
  return { connect: () => { state.connected.value = true }, disconnect: vi.fn(), send: state.send, connected: state.connected, rtt: ref(0) }
} }))
vi.mock('../api/abs.js', () => ({ getBookmarks: vi.fn().mockResolvedValue([]), createBookmark: vi.fn() }))

let wrapper
function snapshot(overrides = {}) {
  return { type: 'room_state', room_id: 'mobile01', created: false,
    item: { id: 'book', title: 'Book', author: 'Author' }, position: 0, playing: false, speed: 1,
    participants: [{ name: 'Alice', is_host: true }], ...overrides }
}
beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }))
  state.send.mockClear()
  state.connected = ref(false)
  state.player = {
    open: vi.fn().mockResolvedValue({ currentTime: 120 }), close: vi.fn(),
    currentTime: ref(0), duration: ref(1000), isPlaying: ref(false), volume: ref(1),
    playbackRate: ref(1), needsInteraction: ref(false), playbackError: ref(''), audio: new EventTarget(),
    setVolume: vi.fn(),
    setSpeed: vi.fn(rate => { state.player.playbackRate.value = rate }),
    seekTo: vi.fn(time => { state.player.currentTime.value = time; return time }),
    play: vi.fn(() => { state.player.isPlaying.value = true; return Promise.resolve(true) }),
    pause: vi.fn(() => { state.player.isPlaying.value = false }),
  }
  wrapper = mount(Room, { global: { provide: { auth: { token: 'test', username: 'Alice' }, ABS_BASE: 'https://abs.example' } } })
})
afterEach(() => { wrapper.unmount(); vi.unstubAllGlobals() })

describe('room recovery', () => {
  it('seeds a newly created room from ABS progress', async () => {
    await state.message(snapshot({ created: true }))
    expect(state.send).toHaveBeenCalledWith({ type: 'seek', position: 120 })
    expect(state.player.currentTime.value).toBe(120)
  })

  it('restores the server position and speed after reconnect, including for the host', async () => {
    await state.message(snapshot({ created: true }))
    state.player.currentTime.value = 300
    state.send.mockClear()
    await state.message(snapshot({ position: 250, speed: 1.5, playing: true }))
    expect(state.player.currentTime.value).toBeCloseTo(250, 0)
    expect(state.player.playbackRate.value).toBe(1.5)
    expect(state.player.isPlaying.value).toBe(true)
    expect(state.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'seek' }))
  })

  it('preserves local progress when reconnect recreates an expired room', async () => {
    await state.message(snapshot({ created: true }))
    state.player.currentTime.value = 300
    state.player.isPlaying.value = true
    state.send.mockClear()
    await state.message(snapshot({ created: true }))
    expect(state.player.currentTime.value).toBe(300)
    expect(state.send).toHaveBeenCalledWith({ type: 'seek', position: 300 })
    expect(state.send).toHaveBeenCalledWith({ type: 'play_intent', position: 300 })
  })

  it('applies the latest room command when ABS finishes opening', async () => {
    let finishOpening
    state.player.open.mockImplementation(() => new Promise(resolve => { finishOpening = resolve }))
    const opening = state.message(snapshot({ created: true }))
    await state.message({ type: 'play', position: 400 })
    await state.message({ type: 'pause', position: 420, sender_name: 'Bob' })
    finishOpening({ currentTime: 120 })
    await opening
    await flushPromises()
    expect(state.player.currentTime.value).toBe(420)
    expect(state.player.isPlaying.value).toBe(false)
  })

  it.each([true, false])('discards stale buffering after reconnecting to playing=%s while opening', async (playing) => {
    let finishOpening
    state.player.open.mockImplementation(() => new Promise(resolve => { finishOpening = resolve }))
    const opening = state.message(snapshot())
    await state.message({ type: 'play_intent', position: 100, sender_name: 'Bob' })
    state.connected.value = false
    await flushPromises()
    state.connected.value = true
    await flushPromises()
    await state.message(snapshot({ position: 110, playing }))
    finishOpening({ currentTime: 120 })
    await opening
    await flushPromises()
    expect(state.player.isPlaying.value).toBe(playing)
    expect(wrapper.find('.buffering-notice').exists()).toBe(false)
    expect(state.send).not.toHaveBeenCalledWith({ type: 'ready' })
  })

  it('honors a pending play intent replayed after the fresh snapshot', async () => {
    let finishOpening
    state.player.open.mockImplementation(() => new Promise(resolve => { finishOpening = resolve }))
    const opening = state.message(snapshot())
    await state.message({ type: 'play_intent', position: 100, sender_name: 'Bob' })
    await state.message(snapshot({ position: 200 }))
    await state.message({ type: 'play_intent', position: 200, sender_name: 'Bob' })
    finishOpening({ currentTime: 120 })
    await opening
    await flushPromises()
    expect(wrapper.find('.buffering-notice').exists()).toBe(true)
    state.player.audio.readyState = 3
    state.player.audio.dispatchEvent(new Event('canplay'))
    expect(state.send).toHaveBeenCalledWith({ type: 'ready' })
    await state.message({ type: 'play', position: 200 })
    expect(state.player.isPlaying.value).toBe(true)
    expect(state.player.currentTime.value).toBe(200)
  })

  it('pauses the room at the end and resumes everyone after rewinding', async () => {
    await state.message(snapshot({ playing: true, position: 990 }))
    state.player.currentTime.value = 1000
    state.player.isPlaying.value = false
    state.onEnded?.()
    await flushPromises()
    expect(state.send).toHaveBeenCalledWith({ type: 'pause', position: 1000 })
    state.send.mockClear()
    await wrapper.get('[aria-label="Skip back 10 seconds"]').trigger('click')
    await wrapper.get('[aria-label="Play"]').trigger('click')
    await flushPromises()
    expect(state.send).toHaveBeenCalledWith({ type: 'play_intent', position: 990 })
  })

  it('restarts the whole book when Play is pressed at its end', async () => {
    await state.message(snapshot({ position: 1000 }))
    state.send.mockClear()
    await wrapper.get('[aria-label="Play"]').trigger('click')
    await flushPromises()
    expect(state.send).toHaveBeenCalledWith({ type: 'play_intent', position: 0 })
  })

  it('lets an autoplay-blocked listener catch up without restarting the room', async () => {
    await state.message(snapshot({ playing: true, position: 100 }))
    state.player.isPlaying.value = false
    state.player.needsInteraction.value = true
    await flushPromises()
    state.send.mockClear()
    await wrapper.get('.playback-notice button').trigger('click')
    await flushPromises()
    expect(state.player.isPlaying.value).toBe(true)
    expect(state.player.currentTime.value).toBeCloseTo(100, 0)
    expect(state.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'play_intent' }))
  })
})
