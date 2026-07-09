import React, { useRef, useState } from 'react'
import { apiPost, apiUpload } from '../api.js'

// The notification volume is a per-device choice, so it lives in localStorage.
function loadVolume() {
  const v = parseFloat(localStorage.getItem('hearth_notif_volume'))
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 1
}

// beep plays a short soft tone at the given volume — the fallback preview when
// no real sound has been added yet, so the slider still makes a sound.
function beep(vol) {
  try {
    const Ctor = window.AudioContext || window.webkitAudioContext
    if (!Ctor) return
    const ac = new Ctor()
    const o = ac.createOscillator()
    const g = ac.createGain()
    o.type = 'sine'
    o.frequency.value = 660
    const t0 = ac.currentTime
    g.gain.setValueAtTime(0.0001, t0)
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, vol * 0.4), t0 + 0.02)
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22)
    o.connect(g)
    g.connect(ac.destination)
    o.start()
    o.stop(t0 + 0.24)
    o.onended = () => ac.close()
  } catch {
    // audio not available; the slider still works silently
  }
}

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

export default function Settings({
  me,
  setMe,
  nickname,
  setNickname,
  notifSounds,
  setNotifSounds,
  theme,
  setTheme,
  onLogout,
}) {
  const [name, setName] = useState(me.displayName)
  const [nick, setNick] = useState(nickname)
  const [saved, setSaved] = useState('')
  const [addingSound, setAddingSound] = useState(false)
  const [volume, setVolume] = useState(loadVolume)
  const soundFileRef = useRef(null)
  // Keep a single preview player so dragging the slider doesn't stack sounds.
  const previewRef = useRef(null)
  const previewAtRef = useRef(0)

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

  // Play one sound at the current volume (the ▶ button on each row).
  function playSound(path) {
    const audio = new Audio(path)
    audio.volume = volume
    audio.play().catch(() => {})
  }

  // Add a sound to my collection.
  async function onPickSound(e) {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setAddingSound(true)
    try {
      const { sound } = await apiUpload('/api/upload/notif-sound', file)
      setNotifSounds((prev) => [sound, ...prev])
      flash('Sound added 🔔')
    } catch (err) {
      alert('Could not add sound: ' + err.message)
    } finally {
      setAddingSound(false)
    }
  }

  async function deleteSound(id) {
    try {
      await apiPost('/api/notif-sound/delete', { id })
      setNotifSounds((prev) => prev.filter((s) => s.id !== id))
    } catch (err) {
      alert('Could not remove sound: ' + err.message)
    }
  }

  // Drag the volume slider: remember it, and give a little audible taste of the
  // new level (throttled so a drag doesn't machine-gun the speaker).
  function onVolume(e) {
    const v = parseFloat(e.target.value)
    setVolume(v)
    localStorage.setItem('hearth_notif_volume', String(v))
    const now = Date.now()
    if (now - previewAtRef.current < 140) return
    previewAtRef.current = now
    if (previewRef.current) {
      previewRef.current.pause()
    }
    // Preview the first real sound if there is one, otherwise a soft beep.
    if (notifSounds.length > 0) {
      const audio = new Audio(notifSounds[0].path)
      audio.volume = v
      previewRef.current = audio
      audio.play().catch(() => {})
    } else {
      beep(v)
    }
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
          <div className="setting-label">Appearance<small>Just on this device</small></div>
          <div className="setting-control">
            <button
              className="ghost-btn"
              onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
            >
              {theme === 'dark' ? '☀️ Switch to light' : '🌙 Switch to dark'}
            </button>
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

        <div className="setting-row sound-row">
          <div className="setting-label">
            Notification sounds
            <small>A random one plays on each new message</small>
          </div>
          <div className="setting-control sound-control">
            {notifSounds.length === 0 && (
              <span className="muted">No sounds yet — add one 🐾</span>
            )}
            {notifSounds.map((s, i) => (
              <div key={s.id} className="sound-chip">
                <button className="sound-play" onClick={() => playSound(s.path)} title="Play">▶</button>
                <span className="sound-name">Sound {notifSounds.length - i}</span>
                <button className="sound-del" onClick={() => deleteSound(s.id)} title="Remove">✕</button>
              </div>
            ))}
            <input ref={soundFileRef} type="file" accept="audio/*" hidden onChange={onPickSound} />
            <button
              className="ghost-btn"
              onClick={() => soundFileRef.current?.click()}
              disabled={addingSound}
            >
              {addingSound ? 'Adding…' : '＋ Add sound'}
            </button>
          </div>
        </div>

        <div className="setting-row">
          <div className="setting-label">
            Notification volume
            <small>Drag to hear the level · this device</small>
          </div>
          <div className="setting-control">
            <input
              className="volume-slider"
              type="range"
              min="0"
              max="1"
              step="0.05"
              value={volume}
              onChange={onVolume}
            />
            <span className="volume-pct">{Math.round(volume * 100)}%</span>
          </div>
        </div>

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
