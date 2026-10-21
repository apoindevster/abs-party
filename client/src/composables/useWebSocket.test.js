import { mount } from '@vue/test-utils'
import { defineComponent } from 'vue'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { useWebSocket } from './useWebSocket.js'

class FakeSocket {
  static OPEN = 1
  static CONNECTING = 0
  static instances = []
  readyState = 0
  send = vi.fn()
  close = vi.fn(() => { this.readyState = 3; this.onclose?.() })
  constructor() { FakeSocket.instances.push(this) }
  open() { this.readyState = 1; this.onopen() }
  message(msg) { this.onmessage({ data: JSON.stringify(msg) }) }
  pong() {
    const ping = this.send.mock.calls.map(([data]) => JSON.parse(data)).filter(m => m.type === 'ping').at(-1)
    this.message({ type: 'pong', sent_at: ping.sent_at })
  }
}

let wrapper, socket
beforeEach(() => {
  vi.useFakeTimers()
  FakeSocket.instances = []
  vi.stubGlobal('WebSocket', FakeSocket)
  wrapper = mount(defineComponent({ setup() { socket = useWebSocket(vi.fn()); return () => null } }))
})
afterEach(() => { wrapper.unmount(); vi.useRealTimers(); vi.unstubAllGlobals() })

describe('mobile connection recovery', () => {
  it('does not reconnect after intentional disconnect or unmount', () => {
    socket.connect()
    FakeSocket.instances[0].open()
    socket.disconnect()
    vi.advanceTimersByTime(60_000)
    expect(FakeSocket.instances).toHaveLength(1)
    window.dispatchEvent(new Event('online'))
    expect(FakeSocket.instances).toHaveLength(1)
  })
  it('reconnects when a heartbeat goes unanswered', () => {
    socket.connect()
    FakeSocket.instances[0].open()
    vi.advanceTimersByTime(10_000)
    expect(socket.connected.value).toBe(false)
    vi.advanceTimersByTime(3000)
    expect(FakeSocket.instances).toHaveLength(2)
  })
  it('requests canonical room state on foregrounding without joining twice', () => {
    socket.connect()
    const ws = FakeSocket.instances[0]
    ws.open()
    ws.pong()
    document.dispatchEvent(new Event('visibilitychange'))
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'get_state' }))
    expect(FakeSocket.instances).toHaveLength(1)
  })
  it('bounds stalled connection attempts and ignores events from old sockets', () => {
    socket.connect()
    const old = FakeSocket.instances[0]
    vi.advanceTimersByTime(13_000)
    const current = FakeSocket.instances[1]
    current.open()
    current.pong()
    old.onclose()
    expect(socket.connected.value).toBe(true)
    expect(current.close).not.toHaveBeenCalled()
  })
  it('tries immediately when the network comes back', () => {
    socket.connect()
    FakeSocket.instances[0].open()
    FakeSocket.instances[0].close()
    window.dispatchEvent(new Event('online'))
    expect(FakeSocket.instances).toHaveLength(2)
  })
})
