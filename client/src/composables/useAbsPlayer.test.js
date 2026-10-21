import { mount, flushPromises } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { useAbsPlayer } from './useAbsPlayer.js'
import Hls from 'hls.js'
import { startPlaybackSession, closeSession, createBookmark } from '../api/abs.js'

vi.mock('../api/abs.js', () => ({
  startPlaybackSession: vi.fn(), syncProgress: vi.fn(), closeSession: vi.fn(),
  getProgress: vi.fn().mockResolvedValue({ currentTime: 12 }), createBookmark: vi.fn(),
}))
vi.mock('hls.js', () => {
  const Hls = vi.fn(function () { this.on = vi.fn(); this.loadSource = vi.fn(); this.attachMedia = vi.fn(); this.destroy = vi.fn() })
  Hls.isSupported = vi.fn(() => true)
  Hls.Events = { ERROR: 'error' }
  return { default: Hls }
})

class FakeAudio extends EventTarget {
  currentTime = 0
  duration = 100
  volume = 1
  playbackRate = 1
  paused = true
  readyState = 0
  canPlayType = vi.fn(() => '')
  setAttribute = vi.fn()
  removeAttribute = vi.fn()
  load = vi.fn(() => { this.readyState = 0; this.currentTime = 0; this.paused = true })
  play = vi.fn(() => {
    this.paused = false
    this.dispatchEvent(new Event('playing'))
    return Promise.resolve()
  })
  pause = vi.fn(() => { this.paused = true; this.dispatchEvent(new Event('pause')) })
  metadata() { this.readyState = 1; this.dispatchEvent(new Event('loadedmetadata')) }
}

let wrapper, player, onEnded
beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  localStorage.clear()
  vi.stubGlobal('Audio', FakeAudio)
  startPlaybackSession.mockResolvedValue({ id: 's1', audioTracks: [
    { contentUrl: '/track1.mp3', startOffset: 0, duration: 100 },
    { contentUrl: '/track2.mp3', startOffset: 100, duration: 100 },
  ] })
  onEnded = vi.fn()
  wrapper = mount(defineComponent({ setup() { player = useAbsPlayer('https://abs.example', { onEnded }); return () => null } }))
})
afterEach(async () => { wrapper.unmount(); await flushPromises(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('mobile audio playback', () => {
  it('reports blocked autoplay without claiming audio is playing, and recovers on a tap', async () => {
    await player.open('token', 'book')
    player.audio.play.mockRejectedValueOnce(new DOMException('Tap required', 'NotAllowedError'))
    expect(await player.play()).toBe(false)
    expect(player.isPlaying.value).toBe(false)
    expect(player.needsInteraction.value).toBe(true)
    expect(await player.play()).toBe(true)
    expect(player.needsInteraction.value).toBe(false)
    player.audio.pause() // OS/headphone interruption
    expect(player.isPlaying.value).toBe(false)
  })

  it('prefers native HLS even when hls.js is supported', async () => {
    player.audio.canPlayType.mockReturnValue('probably')
    startPlaybackSession.mockResolvedValue({ id: 's1', audioTracks: [{ contentUrl: '/stream.m3u8', startOffset: 0, duration: 500 }] })
    await player.open('token', 'book')
    expect(player.audio.src).toBe('https://abs.example/stream.m3u8')
    expect(Hls).not.toHaveBeenCalled()
  })

  it('falls back to hls.js when native HLS is unavailable', async () => {
    startPlaybackSession.mockResolvedValue({ id: 's1', audioTracks: [{ contentUrl: '/stream.m3u8', duration: 500 }] })
    await player.open('token', 'book')
    expect(Hls).toHaveBeenCalledOnce()
  })

  it('waits for metadata and keeps playing when seeking across files', async () => {
    await player.open('token', 'book')
    player.audio.metadata()
    await player.play()
    player.setSpeed(1.5)
    player.seekTo(125)
    expect(player.audio.src).toContain('/track2.mp3?token=token')
    expect(player.currentTime.value).toBe(125)
    player.audio.metadata()
    expect(player.audio.currentTime).toBe(25)
    expect(player.audio.play).toHaveBeenCalledTimes(2)
    expect(player.audio.playbackRate).toBe(1.5)
    expect(player.seekTo(900)).toBe(200)
    expect(player.seekTo(-10)).toBe(0)
  })

  it('keeps the latest seek while metadata is still loading', async () => {
    await player.open('token', 'book')
    player.seekTo(140)
    player.seekTo(170)
    player.audio.metadata()
    expect(player.audio.currentTime).toBe(70)
  })

  it('surfaces an autoplay rejection when advancing to the next file', async () => {
    await player.open('token', 'book')
    await player.play()
    player.audio.play.mockRejectedValueOnce(new DOMException('Tap required', 'NotAllowedError'))
    player.audio.dispatchEvent(new Event('ended'))
    await flushPromises()
    expect(player.needsInteraction.value).toBe(true)
    expect(player.isPlaying.value).toBe(false)
  })

  it('reports completion only after the final file, at the full book duration', async () => {
    await player.open('token', 'book')
    await player.play()
    player.audio.dispatchEvent(new Event('ended'))
    await flushPromises()
    expect(onEnded).not.toHaveBeenCalled()
    expect(player.audio.src).toContain('/track2.mp3')
    expect(player.isPlaying.value).toBe(true)
    player.audio.dispatchEvent(new Event('ended'))
    expect(onEnded).toHaveBeenCalledOnce()
    expect(player.currentTime.value).toBe(200)
    expect(player.isPlaying.value).toBe(false)
  })

  it('does not show an obsolete play error after a pause', async () => {
    let rejectPlay
    player.audio.play.mockImplementationOnce(() => new Promise((_, reject) => { rejectPlay = reject }))
    const attempt = player.play()
    player.pause()
    rejectPlay(new DOMException('Interrupted', 'NotAllowedError'))
    await attempt
    expect(player.needsInteraction.value).toBe(false)
    expect(player.isPlaying.value).toBe(false)
  })

  it('closes the ABS session only once on leave and unmount', async () => {
    await player.open('token', 'book')
    await player.close()
    wrapper.unmount()
    await flushPromises()
    expect(closeSession).toHaveBeenCalledOnce()
    expect(createBookmark).toHaveBeenCalledTimes(2)
  })

  it('closes a session that finishes opening after unmount', async () => {
    let resolveSession
    startPlaybackSession.mockImplementationOnce(() => new Promise(resolve => { resolveSession = resolve }))
    const opening = player.open('token', 'book')
    await flushPromises()
    wrapper.unmount()
    resolveSession({ id: 'late', currentTime: 42 })
    await opening
    expect(closeSession).toHaveBeenCalledWith(null, 'token', 'late', 42, 0)
  })
})
