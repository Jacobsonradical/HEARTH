import React, { useEffect, useRef, useState } from 'react'
import { apiUpload } from '../api.js'

// Avatar shows the person's uploaded photo, or a soft emoji fallback.
function Avatar({ user, fallback }) {
  if (user?.avatarPath) {
    return <img className="avatar" src={user.avatarPath} alt="" />
  }
  return <div className="avatar avatar-fallback">{fallback}</div>
}

// formatTime renders a friendly HH:MM for a message timestamp.
function formatTime(ms) {
  return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

// Friendly words for each presence status shown under my partner's name.
const STATUS_LABEL = { active: 'present', busy: 'busy', away: 'away', offline: 'offline' }

export default function Chat({
  me,
  partner,
  partnerName,
  partnerStatus,
  partnerTyping,
  messages,
  onSend,
  onTyping,
  dividerMsgId,
}) {
  const [text, setText] = useState('')
  const [uploading, setUploading] = useState(false)
  const listRef = useRef(null)
  const fileRef = useRef(null)
  const dividerRef = useRef(null)

  // Follow new messages to the bottom of the conversation.
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages])

  // The unread line lingers long enough to find your place, then melts away:
  // solid for 6s, a 2s fade, then gone until the next catch-up.
  const [dividerPhase, setDividerPhase] = useState('shown') // shown | fading | hidden
  useEffect(() => {
    if (dividerMsgId == null) return
    setDividerPhase('shown')
    const t1 = setTimeout(() => setDividerPhase('fading'), 6000)
    const t2 = setTimeout(() => setDividerPhase('hidden'), 8000)
    return () => {
      clearTimeout(t1)
      clearTimeout(t2)
    }
  }, [dividerMsgId])

  // When the unread line is (re)placed, bring it into view so I land right where
  // I left off. The unread position itself is decided by App (server-tracked).
  useEffect(() => {
    if (dividerMsgId != null && dividerRef.current) {
      dividerRef.current.scrollIntoView({ block: 'center' })
    }
  }, [dividerMsgId])

  function send() {
    const body = text.trim()
    if (!body) return
    onSend(body, '')
    setText('')
  }

  function onKeyDown(e) {
    // Enter sends; Shift+Enter makes a newline.
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  async function onPickImage(e) {
    const file = e.target.files?.[0]
    e.target.value = '' // allow re-picking the same file later
    if (!file) return
    setUploading(true)
    try {
      const { path } = await apiUpload('/api/upload/message-image', file)
      onSend('', path)
    } catch (err) {
      alert('Could not send image: ' + err.message)
    } finally {
      setUploading(false)
    }
  }

  // My own uploaded background, if any, sits behind the whole conversation.
  const bgStyle = me?.chatBg
    ? { backgroundImage: `url(${me.chatBg})`, backgroundSize: 'cover', backgroundPosition: 'center' }
    : undefined

  return (
    <div className="chat" style={bgStyle}>
      <div className="chat-header">
        <Avatar user={partner} fallback="🧡" />
        <div className="chat-header-name">
          {partnerName}
          {partnerTyping ? (
            <span className="presence typing">
              typing<span className="typing-dots" />
            </span>
          ) : (
            <span className={'presence ' + partnerStatus}>
              {STATUS_LABEL[partnerStatus] || 'offline'}
            </span>
          )}
        </div>
      </div>

      <div className="messages" ref={listRef}>
        {messages.length === 0 && (
          <div className="empty-hint">Say something sweet to start 💌</div>
        )}
        {messages.map((m) => {
          const mine = m.senderId === me.id
          const who = mine ? me : partner
          return (
            <React.Fragment key={m.id}>
              {m.id === dividerMsgId && dividerPhase !== 'hidden' && (
                <div
                  className={'unread-divider' + (dividerPhase === 'fading' ? ' fading' : '')}
                  ref={dividerRef}
                >
                  <span>unread messages 💌</span>
                </div>
              )}
              <div className={'msg-row ' + (mine ? 'mine' : 'theirs')}>
                {!mine && <Avatar user={who} fallback="🧡" />}
                <div className="bubble">
                  {m.imagePath && (
                    <img className="msg-image" src={m.imagePath} alt="shared" />
                  )}
                  {m.body && <div className="msg-body">{m.body}</div>}
                  <div className="msg-time">{formatTime(m.createdAt)}</div>
                </div>
                {mine && <Avatar user={who} fallback="💗" />}
              </div>
            </React.Fragment>
          )
        })}
      </div>

      <div className="composer">
        <button
          className="icon-btn"
          title="Send a photo"
          onClick={() => fileRef.current?.click()}
          disabled={uploading}
        >
          {uploading ? '⏳' : '📷'}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          hidden
          onChange={onPickImage}
        />
        <textarea
          className="composer-input"
          placeholder="Write with love…"
          value={text}
          onChange={(e) => {
            setText(e.target.value)
            onTyping() // let my partner see "typing…"
          }}
          onKeyDown={onKeyDown}
          rows={1}
        />
        <button className="send-btn" onClick={send} disabled={!text.trim()}>
          Send 💛
        </button>
      </div>
    </div>
  )
}
