import React, { useState } from 'react'
import { apiPost } from '../api.js'

// The front door. Two fixed accounts, so no sign-up — just a warm little login.
export default function Login({ onAuthed }) {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e) {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      await apiPost('/api/login', { username, password })
      onAuthed()
    } catch (err) {
      setError(err.message || 'Could not log in')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <div className="login-emoji">🏡💕</div>
        <h1>Welcome home</h1>

        <label>
          Username
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoFocus
            autoComplete="username"
          />
        </label>
        <label>
          Password
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
          />
        </label>

        {error && <div className="login-error">{error}</div>}

        <button type="submit" disabled={busy}>
          {busy ? 'Opening the door…' : 'Come in 🌸'}
        </button>
      </form>
    </div>
  )
}
