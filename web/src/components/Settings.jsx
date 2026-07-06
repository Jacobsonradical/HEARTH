import React, { useRef, useState } from 'react'
import { apiPost, apiUpload } from '../api.js'

// One reusable row for uploading a file (avatar, sound, background).
function UploadRow({ label, accept, hint, onUpload, children }) {
  const ref = useRef(null)
  const [busy, setBusy] = useState(false)

  async function pick(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setBusy(true)
    try {
      await onUpload(file)
    } catch (err) {
      alert(err.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="setting-row">
      <div className="setting-label">{label}{hint && <small>{hint}</small>}</div>
      <div className="setting-control">
        {children}
        <input ref={ref} type="file" accept={accept} hidden onChange={pick} />
        <button className="ghost-btn" onClick={() => ref.current?.click()} disabled={busy}>
          {busy ? 'Uploading…' : 'Choose file'}
        </button>
      </div>
    </div>
  )
}

export default function Settings({ me, setMe, nickname, setNickname, onLogout }) {
  const [name, setName] = useState(me.displayName)
  const [nick, setNick] = useState(nickname)
  const [saved, setSaved] = useState('')

  function flash(msg) {
    setSaved(msg)
    setTimeout(() => setSaved(''), 1500)
  }

  async function saveName() {
    const res = await apiPost('/api/profile', { displayName: name.trim() })
    setMe((prev) => ({ ...prev, displayName: res.displayName }))
    flash('Name saved 💾')
  }

  async function saveNick() {
    const res = await apiPost('/api/nickname', { nickname: nick.trim() })
    setNickname(res.nickname)
    flash('Nickname saved 💛')
  }

  function testSound() {
    if (me.notifSound) new Audio(me.notifSound).play().catch(() => {})
  }

  return (
    <div className="settings">
      <h2>Make it yours ✨</h2>

      <section className="setting-card">
        <div className="setting-row">
          <div className="setting-label">Your name<small>What your partner sees</small></div>
          <div className="setting-control">
            <input value={name} onChange={(e) => setName(e.target.value)} />
            <button className="ghost-btn" onClick={saveName} disabled={!name.trim()}>Save</button>
          </div>
        </div>

        <div className="setting-row">
          <div className="setting-label">
            Nickname for her/him<small>Only you can see this</small>
          </div>
          <div className="setting-control">
            <input
              value={nick}
              onChange={(e) => setNick(e.target.value)}
              placeholder="e.g. honeybee 🐝"
            />
            <button className="ghost-btn" onClick={saveNick}>Save</button>
          </div>
        </div>
      </section>

      <section className="setting-card">
        <UploadRow
          label="Profile photo"
          accept="image/*"
          onUpload={async (file) => {
            const { path } = await apiUpload('/api/upload/avatar', file)
            setMe((prev) => ({ ...prev, avatarPath: path }))
            flash('Photo updated 📸')
          }}
        >
          {me.avatarPath
            ? <img className="avatar" src={me.avatarPath} alt="" />
            : <div className="avatar avatar-fallback">🙂</div>}
        </UploadRow>

        <UploadRow
          label="Notification sound"
          hint="Played when a message arrives"
          accept="audio/*"
          onUpload={async (file) => {
            const { path } = await apiUpload('/api/upload/notif-sound', file)
            setMe((prev) => ({ ...prev, notifSound: path }))
            flash('Sound updated 🔔')
          }}
        >
          <button className="ghost-btn" onClick={testSound} disabled={!me.notifSound}>▶ Test</button>
        </UploadRow>

        <UploadRow
          label="Chat background"
          hint="Behind your conversation"
          accept="image/*"
          onUpload={async (file) => {
            const { path } = await apiUpload('/api/upload/chat-bg', file)
            setMe((prev) => ({ ...prev, chatBg: path }))
            flash('Background updated 🖼️')
          }}
        >
          {me.chatBg
            ? <img className="bg-preview" src={me.chatBg} alt="" />
            : <span className="muted">none</span>}
        </UploadRow>
      </section>

      <section className="setting-card address-card">
        <div className="setting-row">
          <div className="setting-label">
            Our Hearth address<small>Bookmark it on every device you use 💛</small>
          </div>
          <div className="setting-control">
            <code className="address-code">{location.origin}</code>
            <button
              className="ghost-btn"
              onClick={() => {
                navigator.clipboard?.writeText(location.origin).then(
                  () => flash('Address copied 📋'),
                  () => flash('Could not copy'),
                )
              }}
            >
              Copy
            </button>
          </div>
        </div>
        <p className="address-hint">
          This address is the host computer's home-network IP. If Hearth stops
          opening one day (usually after the router or host PC restarts), the IP
          may have changed — on the host, run <code>./setup.sh</code> in the
          Hearth folder and restart the app (<code>docker compose up -d</code>);
          it will print the new address. Tip: give the host PC a <b>fixed IP</b>
          in your router's settings (often called "DHCP reservation" or "static
          lease") and the address will never change.
        </p>
      </section>

      <div className="settings-footer">
        {saved && <span className="saved-flash">{saved}</span>}
        <button className="logout-btn" onClick={onLogout}>Log out</button>
      </div>
    </div>
  )
}
