import React, { useEffect, useRef, useState } from 'react'
import { apiGet, apiPost, apiUpload } from '../api.js'

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

// --- Inline stickers (表情包) ------------------------------------------------
// In the composer a sticker appears as a [name] token, so text and stickers mix
// freely ("hahaha [Haha] lets go [Woof]"). On send, each token whose name
// matches a saved sticker becomes a [[sticker:path]] wire token inside the
// message body; rendering turns those back into inline images. One message,
// one bubble — however many stickers are in it.
const NAME_TOKEN_RE = /\[([^\[\]]+)\]/g
const WIRE_TOKEN_RE = /\[\[sticker:[^\]]+\]\]/
const WIRE_SPLIT_RE = /(\[\[sticker:[^\]]+\]\])/g

// renderBody turns a stored body into text nodes plus inline sticker images.
// Only paths inside our shared stickers folder are honoured, so a hand-crafted
// token can't point an image at anything else.
function renderBody(body, big) {
  return body.split(WIRE_SPLIT_RE).map((part, i) => {
    const m = /^\[\[sticker:([^\]]+)\]\]$/.exec(part)
    if (m && m[1].startsWith('/uploads/stickers/')) {
      return <img key={i} className={'msg-sticker' + (big ? ' big' : '')} src={m[1]} alt="sticker" />
    }
    return part ? <React.Fragment key={i}>{part}</React.Fragment> : null
  })
}

// isStickerOnlyBody reports whether a body is nothing but sticker tokens, so a
// lone sticker (or a burst of them) can render big and frameless.
function isStickerOnlyBody(body) {
  return WIRE_TOKEN_RE.test(body) && body.replace(WIRE_SPLIT_RE, '').trim() === ''
}

// A legacy sticker message (sent as a bare image before stickers went inline)
// is spotted by its file living in the shared stickers folder.
function isStickerPath(path) {
  return !!path && path.startsWith('/uploads/stickers/')
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
  const inputRef = useRef(null)

  // The saved stickers are shared between both accounts. newName + the hidden
  // file input drive adding a new one from the drawer.
  const [stickers, setStickers] = useState([])
  const [showPicker, setShowPicker] = useState(false)
  const [newName, setNewName] = useState('')
  const [addingSticker, setAddingSticker] = useState(false)
  const stickerFileRef = useRef(null)

  function loadStickers() {
    apiGet('/api/stickers').then((d) => setStickers(d.stickers || [])).catch(() => {})
  }
  useEffect(loadStickers, [])

  // ESC closes the sticker drawer, so you don't have to reach for the ✕.
  useEffect(() => {
    if (!showPicker) return
    const onKey = (e) => {
      if (e.key === 'Escape') setShowPicker(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [showPicker])

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

  // send swaps every [name] token for its sticker and ships ONE message, so
  // text and stickers land together in a single bubble.
  function send() {
    const raw = text.trim()
    if (!raw) return
    const wire = raw.replace(NAME_TOKEN_RE, (whole, name) => {
      const n = name.trim().toLowerCase()
      const s = stickers.find((x) => x.name.toLowerCase() === n)
      return s ? `[[sticker:${s.path}]]` : whole
    })
    onSend(wire, '')
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

  // insertToken drops a [name] token into the composer at the cursor, so
  // stickers can sit anywhere between the words.
  function insertToken(s) {
    const token = `[${s.name}] `
    const el = inputRef.current
    if (el) {
      const start = el.selectionStart ?? text.length
      const end = el.selectionEnd ?? start
      setText(text.slice(0, start) + token + text.slice(end))
      requestAnimationFrame(() => {
        el.focus()
        const pos = start + token.length
        el.setSelectionRange(pos, pos)
      })
    } else {
      setText(text + token)
    }
  }

  // Add a new sticker: a name (typed first) plus a chosen image/gif. Square
  // brackets are stripped from names since they'd break the [name] tokens.
  async function onPickSticker(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    const name = newName.replace(/[\[\]]/g, '').trim()
    if (!name) {
      alert('Give the sticker a name first 🐾')
      return
    }
    setAddingSticker(true)
    try {
      const { sticker } = await apiUpload('/api/upload/sticker', file, { name })
      setStickers((prev) => [sticker, ...prev])
      setNewName('')
    } catch (err) {
      alert('Could not add sticker: ' + err.message)
    } finally {
      setAddingSticker(false)
    }
  }

  async function deleteSticker(s) {
    if (!confirm(`Remove sticker "${s.name}"?`)) return
    try {
      await apiPost('/api/sticker/delete', { id: s.id })
      setStickers((prev) => prev.filter((x) => x.id !== s.id))
    } catch (err) {
      alert('Could not remove sticker: ' + err.message)
    }
  }

  // Type-to-search: the word currently being typed is matched against sticker
  // names (Chinese or English). Matches pop up above Send; clicking one turns
  // the typed word into its [name] token.
  const token = text.split(/\s/).pop()
  const searchMatches =
    token && token.trim() && !token.includes('[')
      ? stickers.filter((s) => s.name.toLowerCase().includes(token.trim().toLowerCase())).slice(0, 24)
      : []

  function pickFromSearch(s) {
    setText(text.replace(/\S+$/, '') + `[${s.name}] `)
    inputRef.current?.focus()
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
          const legacySticker = isStickerPath(m.imagePath)
          const stickerOnly =
            (legacySticker && !m.body) || (!!m.body && !m.imagePath && isStickerOnlyBody(m.body))
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
                {/* Stickers with no text ride free of the bubble, like an emoji. */}
                <div className={'bubble' + (stickerOnly ? ' sticker-only' : '')}>
                  {m.imagePath && (
                    <img
                      className={'msg-image' + (legacySticker ? ' sticker' : '')}
                      src={m.imagePath}
                      alt={legacySticker ? 'sticker' : 'shared'}
                    />
                  )}
                  {m.body && <div className="msg-body">{renderBody(m.body, stickerOnly)}</div>}
                  <div className="msg-time">{formatTime(m.createdAt)}</div>
                </div>
                {mine && <Avatar user={who} fallback="💗" />}
              </div>
            </React.Fragment>
          )
        })}
      </div>

      {/* The sticker drawer: pick to insert into the message, or add a new one. */}
      {showPicker && (
        <div className="sticker-drawer">
          <div className="sticker-drawer-head">
            <span>Stickers 🐾</span>
            <button className="icon-btn small" onClick={() => setShowPicker(false)}>✕</button>
          </div>
          <div className="sticker-grid">
            {stickers.length === 0 && (
              <div className="sticker-empty">No stickers yet — add your first below 💛</div>
            )}
            {stickers.map((s) => (
              <div key={s.id} className="sticker-cell" title={s.name}>
                <img src={s.path} alt={s.name} onClick={() => insertToken(s)} />
                <span className="sticker-name">{s.name}</span>
                <button className="sticker-del" onClick={() => deleteSticker(s)} title="Remove">✕</button>
              </div>
            ))}
          </div>
          <div className="sticker-add">
            <input
              className="sticker-name-input"
              placeholder="Name (中文 or English)"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              maxLength={40}
            />
            <input
              ref={stickerFileRef}
              type="file"
              accept="image/*"
              hidden
              onChange={onPickSticker}
            />
            <button
              className="ghost-btn"
              onClick={() => stickerFileRef.current?.click()}
              disabled={addingSticker || !newName.trim()}
            >
              {addingSticker ? 'Adding…' : '＋ Add image/gif'}
            </button>
          </div>
        </div>
      )}

      <div className="composer-wrap">
        {/* Type-to-search results float just above Send; slide to see more. */}
        {searchMatches.length > 0 && (
          <div className="sticker-search">
            <div className="sticker-search-strip">
              {searchMatches.map((s) => (
                <button key={s.id} className="search-cell" onClick={() => pickFromSearch(s)} title={s.name}>
                  <img src={s.path} alt={s.name} />
                </button>
              ))}
            </div>
          </div>
        )}

        <div className="composer">
          <button
            className="icon-btn"
            title="Send a photo"
            onClick={() => fileRef.current?.click()}
            disabled={uploading}
          >
            {uploading ? '⏳' : '📷'}
          </button>
          <button
            className={'icon-btn' + (showPicker ? ' active' : '')}
            title="Stickers"
            onClick={() => setShowPicker((v) => !v)}
          >
            😀
          </button>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            hidden
            onChange={onPickImage}
          />
          <textarea
            ref={inputRef}
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
    </div>
  )
}
