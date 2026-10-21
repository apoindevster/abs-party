import { ref, onUnmounted } from 'vue'

const RECONNECT_MS = 3000
const PING_MS = 5000
const PONG_TIMEOUT_MS = 10_000

export function useWebSocket(onMessage) {
  const connected = ref(false)
  const rtt = ref(0)
  let ws = null
  let stopped = true
  let reconnectTimer = null
  let pingTimer = null
  let pongTimer = null
  let pendingPing = null

  function clearHeartbeat() {
    clearInterval(pingTimer)
    clearTimeout(pongTimer)
    pendingPing = null
  }

  function connect() {
    stopped = false
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return
    clearTimeout(reconnectTimer)
    const protocol = location.protocol === 'https:' ? 'wss' : 'ws'
    const socket = new WebSocket(`${protocol}://${location.host}/ws`)
    ws = socket
    // Also bound a connection attempt that never completes after a network switch.
    pongTimer = setTimeout(() => retry(socket), PONG_TIMEOUT_MS)

    socket.onopen = () => {
      if (ws !== socket || stopped) return
      clearHeartbeat()
      connected.value = true
      pingTimer = setInterval(sendPing, PING_MS)
      sendPing()
    }
    socket.onclose = () => {
      if (ws === socket) retry(socket)
    }
    socket.onerror = () => retry(socket)
    socket.onmessage = (evt) => {
      if (ws !== socket || stopped) return
      let msg
      try { msg = JSON.parse(evt.data) } catch { return }
      if (msg.type === 'pong') {
        if (pendingPing === msg.sent_at) {
          rtt.value = Math.max(0, Date.now() - pendingPing)
          pendingPing = null
          clearTimeout(pongTimer)
        }
        return
      }
      onMessage(msg)
    }
  }

  function retry(socket) {
    if (ws !== socket) return
    ws = null
    connected.value = false
    clearHeartbeat()
    socket.close()
    clearTimeout(reconnectTimer)
    if (!stopped) reconnectTimer = setTimeout(connect, RECONNECT_MS)
  }

  function send(obj) {
    if (ws?.readyState !== WebSocket.OPEN) return false
    ws.send(JSON.stringify(obj))
    return true
  }

  function sendPing() {
    if (pendingPing !== null || ws?.readyState !== WebSocket.OPEN) return
    pendingPing = Date.now()
    send({ type: 'ping', sent_at: pendingPing })
    const socket = ws
    pongTimer = setTimeout(() => retry(socket), PONG_TIMEOUT_MS)
  }

  function resume() {
    if (stopped || document.visibilityState === 'hidden') return
    if (ws?.readyState === WebSocket.OPEN) {
      // A suspended timer is not evidence of a dead socket. Probe it afresh.
      clearTimeout(pongTimer)
      pendingPing = null
      sendPing()
      send({ type: 'get_state' })
    } else {
      if (ws) retry(ws)
      connect()
    }
  }

  function disconnect() {
    stopped = true
    clearTimeout(reconnectTimer)
    clearHeartbeat()
    const socket = ws
    ws = null
    connected.value = false
    socket?.close()
  }

  document.addEventListener('visibilitychange', resume)
  window.addEventListener('pageshow', resume)
  window.addEventListener('online', resume)
  onUnmounted(() => {
    disconnect()
    document.removeEventListener('visibilitychange', resume)
    window.removeEventListener('pageshow', resume)
    window.removeEventListener('online', resume)
  })

  return { connect, send, disconnect, connected, rtt }
}
