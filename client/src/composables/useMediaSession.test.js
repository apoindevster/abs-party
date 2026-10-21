import { mount } from '@vue/test-utils'
import { defineComponent, ref, nextTick } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useMediaSession } from './useMediaSession.js'

let wrapper
afterEach(() => { wrapper?.unmount(); vi.unstubAllGlobals() })

describe('lock-screen controls', () => {
  it('routes controls through room actions, reports book position, and cleans up', async () => {
    const actions = {}
    const session = { setActionHandler: vi.fn((name, fn) => { actions[name] = fn }), setPositionState: vi.fn() }
    vi.stubGlobal('navigator', { mediaSession: session })
    vi.stubGlobal('MediaMetadata', class { constructor(data) { Object.assign(this, data) } })
    const player = { currentTime: ref(125), duration: ref(500), isPlaying: ref(true), playbackRate: ref(1.5) }
    const handlers = { play: vi.fn(), pause: vi.fn(), seek: vi.fn() }
    wrapper = mount(defineComponent({ setup() {
      useMediaSession(player, () => ({ title: 'Book', author: 'Author' }), handlers)
      return () => null
    } }))
    expect(session.metadata.title).toBe('Book')
    expect(session.playbackState).toBe('playing')
    expect(session.setPositionState).toHaveBeenCalledWith({ duration: 500, position: 125, playbackRate: 1.5 })
    actions.play(); actions.pause(); actions.seekbackward({}); actions.seekforward({ seekOffset: 30 }); actions.seekto({ seekTime: 300 })
    expect(handlers.play).toHaveBeenCalledOnce()
    expect(handlers.pause).toHaveBeenCalledOnce()
    expect(handlers.seek.mock.calls).toEqual([[115], [155], [300]])
    player.isPlaying.value = false
    await nextTick()
    expect(session.playbackState).toBe('paused')
    wrapper.unmount()
    expect(Object.values(actions).every(value => value === null)).toBe(true)
    expect(session.metadata).toBe(null)
    expect(session.playbackState).toBe('none')
  })

  it('works without the Media Session API', () => {
    vi.stubGlobal('navigator', {})
    expect(() => { wrapper = mount(defineComponent({ setup() { useMediaSession({}, () => null, {}); return () => null } })) }).not.toThrow()
  })
})
