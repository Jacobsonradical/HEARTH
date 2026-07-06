import React, { useState } from 'react'
import { apiPost } from '../api.js'

// The first-open screen: shown once, on a fresh install, to create the two
// accounts. The person at the keyboard (the host) fills in both and is signed
// in as the first one right away. Display names start equal to the usernames
// and can be dressed up later in Settings.
export default function Setup({ onDone }) {
  const [u1, setU1] = useState('')
  const [p1, setP1] = useState('')
  const [u2, setU2] = useState('')
  const [p2, setP2] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      await apiPost('/api/setup', {
        username1: u1,
        password1: p1,
        username2: u2,
        password2: p2,
      })
      onDone() // we're already logged in as account 1
    } catch (err) {
      setError(err.message || 'Setup failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-screen">
      <form className="login-card setup-card" onSubmit={submit}>
        <div className="login-emoji">🏡✨</div>
        <h1>Let's set up your Hearth</h1>
        <p className="setup-sub">
          Two accounts, just for the two of you. You can add photos, nicknames
          and sounds later in Settings.
        </p>

        <div className="setup-person">
          <div className="setup-person-title">👤 You</div>
          <label>
            Username
            <input value={u1} onChange={(e) => setU1(e.target.value)} autoFocus />
          </label>
          <label>
            Password
            <input type="password" value={p1} onChange={(e) => setP1(e.target.value)} />
          </label>
        </div>

        <div className="setup-person">
          <div className="setup-person-title">💛 Your love</div>
          <label>
            Username
            <input value={u2} onChange={(e) => setU2(e.target.value)} />
          </label>
          <label>
            Password
            <input type="password" value={p2} onChange={(e) => setP2(e.target.value)} />
          </label>
        </div>

        {error && <div className="login-error">{error}</div>}

        <button type="submit" disabled={busy || !u1 || !p1 || !u2 || !p2}>
          {busy ? 'Building your home…' : 'Create our home 🏡'}
        </button>
      </form>
    </div>
  )
}
