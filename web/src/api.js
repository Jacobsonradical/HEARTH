// Tiny wrapper around fetch so the components don't repeat headers and error
// handling. Everything talks to the same origin that served the page, so the
// session cookie rides along automatically.

// ApiError carries the HTTP status so callers can tell "not logged in" (401)
// apart from other failures.
export class ApiError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

async function handle(res) {
  if (!res.ok) {
    let msg = res.statusText
    try {
      const body = await res.json()
      if (body && body.error) msg = body.error
    } catch {
      // response wasn't JSON; keep the status text
    }
    throw new ApiError(res.status, msg)
  }
  // Some endpoints return no body; guard against empty responses.
  const text = await res.text()
  return text ? JSON.parse(text) : null
}

export function apiGet(path) {
  return fetch(path).then(handle)
}

export function apiPost(path, body) {
  return fetch(path, {
    method: 'POST',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }).then(handle)
}

// apiUpload posts a single file under the form field "file", plus any extra
// string fields (e.g. a sticker name) passed in the optional fields object.
export function apiUpload(path, file, fields) {
  const form = new FormData()
  form.append('file', file)
  if (fields) {
    for (const key of Object.keys(fields)) form.append(key, fields[key])
  }
  return fetch(path, { method: 'POST', body: form }).then(handle)
}

// wsURL builds the WebSocket URL from the current page origin, so it works on
// whatever LAN IP the browser used to reach us.
export function wsURL() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${proto}//${location.host}/ws`
}
