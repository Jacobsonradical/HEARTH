import React, { useCallback, useEffect, useRef, useState } from 'react'
import { apiGet, apiPost, ApiError, wsURL } from './api.js'
import Login from './components/Login.jsx'
import Setup from './components/Setup.jsx'
import Chat from './components/Chat.jsx'
import Garden from './components/Garden.jsx'
import DogSand from './components/DogSand.jsx'
import Settings from './components/Settings.jsx'

// App is the shell: it owns the session, the single shared WebSocket, and the
// pieces of state that more than one screen needs (messages, garden, presence).
export default function App() {
  const [loading, setLoading] = useState(true)
  const [needsSetup, setNeedsSetup] = useState(false)
  const [me, setMe] = useState(null)
  const [partner, setPartner] = useState(null)
  const [nickname, setNickname] = useState('') // what I privately call my partner
  const [tab, setTab] = useState('chat')
  // Theme is a per-device choice, so it lives in localStorage, not the server.
  const [theme, setTheme] = useState(() => localStorage.getItem('hearth_theme') || 'light')

  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    localStorage.setItem('hearth_theme', theme)
  }, [theme])

  const [messages, setMessages] = useState([])
  const [garden, setGarden] = useState(null)
  const [notifSounds, setNotifSounds] = useState([]) // my personal alert sounds
  const [presence, setPresence] = useState([]) // [{id, status}] of connected people
  const [partnerTyping, setPartnerTyping] = useState(false)
  const [unread, setUnread] = useState(0)
  const [dividerMsgId, setDividerMsgId] = useState(null) // where the unread line sits
  const [visible, setVisible] = useState(
    typeof document === 'undefined' || document.visibilityState === 'visible',
  )

  const ws = useRef(null)
  const meRef = useRef(null) // latest "me" for use inside ws callbacks
  const tabRef = useRef(tab)
  const notifSoundsRef = useRef([]) // latest sounds, for use inside ws callbacks
  meRef.current = me
  tabRef.current = tab
  notifSoundsRef.current = notifSounds

  // Presence status plumbing. lastActivityRef is when I last moved the mouse or
  // typed; lastStatusRef avoids re-sending an unchanged status; the typing refs
  // throttle outbound "typing" pings and clear the partner's indicator.
  const lastActivityRef = useRef(Date.now())
  const lastStatusRef = useRef('')
  const lastTypingSentRef = useRef(0)
  const typingClearRef = useRef(null)

  // computeStatus turns my activity + tab visibility into a presence status.
  // Idle for 5 minutes wins (away); otherwise a hidden tab means I'm busy
  // elsewhere, and a visible one means I'm present.
  const computeStatus = useCallback(() => {
    const idle = Date.now() - lastActivityRef.current
    if (idle > 5 * 60 * 1000) return 'away'
    const hidden = typeof document !== 'undefined' && document.visibilityState !== 'visible'
    return hidden ? 'busy' : 'active'
  }, [])

  // sendStatus reports my status over the socket, but only when it changes.
  const sendStatus = useCallback(() => {
    const socket = ws.current
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    const status = computeStatus()
    if (status === lastStatusRef.current) return
    lastStatusRef.current = status
    socket.send(JSON.stringify({ type: 'status', status }))
  }, [computeStatus])

  // notifyTyping tells my partner I'm typing (throttled to once every 1.5s).
  const notifyTyping = useCallback(() => {
    const socket = ws.current
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    lastActivityRef.current = Date.now()
    const now = Date.now()
    if (now - lastTypingSentRef.current < 1500) return
    lastTypingSentRef.current = now
    socket.send(JSON.stringify({ type: 'typing' }))
  }, [])

  // Read tracking: readIdRef is how far the server says I've read. viewingRef,
  // sessionAnchorRef and dividerDoneRef bound a single "viewing session" (the
  // stretch of time I'm actually looking at the chat).
  const readIdRef = useRef(0)
  const viewingRef = useRef(false)
  const sessionAnchorRef = useRef(0)
  const dividerDoneRef = useRef(false)

  // loadMe fetches identity; a 401 simply means "show the login screen".
  const loadMe = useCallback(async () => {
    try {
      const data = await apiGet('/api/me')
      setMe(data.user)
      setPartner(data.partner || null)
      setNickname(data.partnerNickname || '')
      readIdRef.current = data.readId || 0 // server is the source of truth
      return true
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        setMe(null)
        return false
      }
      throw err
    }
  }, [])

  // On first load, check whether we already have a valid session. If not, ask
  // whether this is a fresh install that still needs its accounts created.
  useEffect(() => {
    loadMe()
      .then(async (authed) => {
        if (!authed) {
          const s = await apiGet('/api/setup-status').catch(() => null)
          setNeedsSetup(!!s?.needsSetup)
        }
      })
      .finally(() => setLoading(false))
  }, [loadMe])

  // Play a notification sound when a message arrives from my partner while I'm
  // not looking at the chat. I can keep several sounds — one is picked at
  // random each time — and a per-device volume scales them all.
  const playNotif = useCallback(() => {
    const sounds = notifSoundsRef.current
    if (!sounds || sounds.length === 0) return
    const pick = sounds[Math.floor(Math.random() * sounds.length)]
    const audio = new Audio(pick.path)
    const vol = parseFloat(localStorage.getItem('hearth_notif_volume'))
    audio.volume = Number.isFinite(vol) ? Math.min(1, Math.max(0, vol)) : 1
    audio.play().catch(() => {
      // Browsers block autoplay until the first interaction; that's fine.
    })
  }, [])

  // Once logged in, load history + garden and open the realtime connection.
  useEffect(() => {
    if (!me) return

    let closed = false
    apiGet('/api/messages').then((d) => setMessages(d.messages || [])).catch(() => {})
    apiGet('/api/garden').then(setGarden).catch(() => {})
    apiGet('/api/notif-sounds').then((d) => setNotifSounds(d.sounds || [])).catch(() => {})

    const socket = new WebSocket(wsURL())
    ws.current = socket

    socket.onmessage = (ev) => {
      let msg
      try {
        msg = JSON.parse(ev.data)
      } catch {
        return
      }
      if (msg.type === 'message') {
        setMessages((prev) => {
          if (prev.some((m) => m.id === msg.message.id)) return prev // de-dupe
          return [...prev, msg.message]
        })
        const fromPartner = msg.message.senderId !== meRef.current?.id
        if (fromPartner) {
          setPartnerTyping(false) // they sent it, so they've stopped typing
        }
        const looking = tabRef.current === 'chat' && !document.hidden
        if (fromPartner && !looking) {
          playNotif()
          setUnread((n) => n + 1)
        }
      } else if (msg.type === 'garden') {
        // Merge the shared fields, keeping my personal water/greeting flags.
        setGarden((prev) => ({ ...prev, ...msg }))
      } else if (msg.type === 'presence') {
        setPresence(msg.users || [])
      } else if (msg.type === 'typing') {
        // Show my partner's "typing…" for a few seconds after their last keypress.
        if (msg.userId !== meRef.current?.id) {
          setPartnerTyping(true)
          clearTimeout(typingClearRef.current)
          typingClearRef.current = setTimeout(() => setPartnerTyping(false), 3000)
        }
      } else if (msg.type === 'profile') {
        // A name/photo changed — update whichever side it belongs to live.
        const u = msg.user
        setMe((prev) => (prev && u.id === prev.id ? { ...prev, ...u } : prev))
        setPartner((prev) => (prev && u.id === prev.id ? { ...prev, ...u } : prev))
      }
    }

    socket.onopen = () => {
      lastStatusRef.current = '' // force a fresh status report on (re)connect
      sendStatus()
    }

    socket.onclose = () => {
      // If we didn't close on purpose, a full reload is the simplest reliable
      // way to re-establish everything on a home network.
      if (!closed) setTimeout(() => !closed && loadMe(), 2000)
    }

    return () => {
      closed = true
      socket.close()
    }
  }, [me, loadMe, playNotif, sendStatus])

  // Keep an unread count in the tab title so a buzz is visible at a glance.
  // (The tab's hearth icon comes from the favicon, so the title stays plain.)
  useEffect(() => {
    document.title = unread > 0 ? `(${unread}) Hearth` : 'Hearth'
  }, [unread])

  // Track whether the window/tab is actually in the foreground.
  useEffect(() => {
    const onVis = () => setVisible(document.visibilityState === 'visible')
    document.addEventListener('visibilitychange', onVis)
    return () => document.removeEventListener('visibilitychange', onVis)
  }, [])

  // Watch my activity so my presence reflects reality: any input counts as being
  // active, changing tabs recomputes it, and a periodic tick catches the slide
  // into "away" after 5 idle minutes.
  useEffect(() => {
    if (!me) return
    const onActivity = () => {
      lastActivityRef.current = Date.now()
      sendStatus()
    }
    const events = ['mousemove', 'mousedown', 'keydown', 'touchstart', 'scroll', 'wheel']
    events.forEach((e) => window.addEventListener(e, onActivity, { passive: true }))
    document.addEventListener('visibilitychange', sendStatus)
    const tick = setInterval(sendStatus, 30000)
    return () => {
      events.forEach((e) => window.removeEventListener(e, onActivity))
      document.removeEventListener('visibilitychange', sendStatus)
      clearInterval(tick)
    }
  }, [me, sendStatus])

  // The heart of "unread": I count as *reading* only while the chat tab is open
  // AND the window is in the foreground. Each time I start looking, we open a
  // new read session — freezing where I left off (the anchor), pinning the
  // unread line to the first message I hadn't seen, and then marking everything
  // up to the newest as read. Messages that arrive while I'm elsewhere or the
  // window is hidden are left unread, so they show up next time I look.
  useEffect(() => {
    const viewing = !!me && tab === 'chat' && visible
    if (viewing && !viewingRef.current) {
      sessionAnchorRef.current = readIdRef.current
      dividerDoneRef.current = false
      setDividerMsgId(null)
    }
    viewingRef.current = viewing
    if (!viewing) return

    // Place the unread line once per session, as soon as messages are loaded.
    if (!dividerDoneRef.current && messages.length) {
      dividerDoneRef.current = true
      const anchor = sessionAnchorRef.current
      const firstUnread = messages.find((m) => m.id > anchor && m.senderId !== me.id)
      setDividerMsgId(firstUnread ? firstUnread.id : null)
    }

    // I'm looking, so catch my read marker up to the newest message.
    if (messages.length) {
      const newest = messages[messages.length - 1].id
      if (newest > readIdRef.current) {
        readIdRef.current = newest
        apiPost('/api/read', { id: newest }).catch(() => {})
      }
    }
    setUnread(0)
  }, [me, tab, visible, messages])

  const sendMessage = useCallback((body, imagePath) => {
    const socket = ws.current
    if (!socket || socket.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify({ type: 'message', body, imagePath }))
  }, [])

  const handleLogout = useCallback(async () => {
    try {
      await apiPost('/api/logout')
    } catch {
      // ignore; we're tearing down anyway
    }
    ws.current?.close()
    setMe(null)
    setMessages([])
    setGarden(null)
    setTab('chat')
  }, [])

  if (loading) {
    return <div className="splash">🏡</div>
  }

  if (!me && needsSetup) {
    return (
      <Setup
        onDone={() => {
          setNeedsSetup(false)
          loadMe()
        }}
      />
    )
  }

  if (!me) {
    return <Login onAuthed={() => loadMe()} />
  }

  // The partner's shown name is my private nickname if I set one, else their own.
  const partnerName = nickname || partner?.displayName || 'my love'
  const partnerEntry = partner ? presence.find((u) => u.id === partner.id) : null
  const partnerStatus = partnerEntry ? partnerEntry.status : 'offline'

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">🏡 Hearth</div>
        <nav className="tabs">
          <button className={tab === 'chat' ? 'active' : ''} onClick={() => setTab('chat')}>
            💬 Chat{unread > 0 ? ` (${unread})` : ''}
          </button>
          <button className={tab === 'garden' ? 'active' : ''} onClick={() => setTab('garden')}>
            🌱 Garden
          </button>
          <button className={tab === 'play' ? 'active' : ''} onClick={() => setTab('play')}>
            🐾 Play
          </button>
          <button className={tab === 'settings' ? 'active' : ''} onClick={() => setTab('settings')}>
            ⚙️ Setting
          </button>
        </nav>
      </header>

      <main className="content">
        {tab === 'chat' && (
          <Chat
            me={me}
            partner={partner}
            partnerName={partnerName}
            partnerStatus={partnerStatus}
            partnerTyping={partnerTyping}
            messages={messages}
            onSend={sendMessage}
            onTyping={notifyTyping}
            dividerMsgId={dividerMsgId}
          />
        )}
        {tab === 'garden' && <Garden garden={garden} setGarden={setGarden} />}
        {tab === 'play' && <DogSand />}
        {tab === 'settings' && (
          <Settings
            me={me}
            setMe={setMe}
            nickname={nickname}
            setNickname={setNickname}
            notifSounds={notifSounds}
            setNotifSounds={setNotifSounds}
            theme={theme}
            setTheme={setTheme}
            onLogout={handleLogout}
          />
        )}
      </main>
    </div>
  )
}
