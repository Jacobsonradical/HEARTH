import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiGet, apiPost } from '../api.js'
import Tree from './garden/Tree.jsx'
import Flower from './garden/Flower.jsx'

// The garden is a little living scene: the sun really travels the sky through
// the day, night brings the moon and stars, clouds drift by, the weather echoes
// the real weather outside (when HEARTH_LAT/LON are set), a bee drops in when
// it pleases, and the tree and flowers grow from our real interaction.

// Defaults when the weather service is off: sunrise 6:30, sunset 19:30.
const DEFAULT_SUNRISE = 390
const DEFAULT_SUNSET = 1170

// A tiny deterministic "random" so stars/flowers land in the same pretty spots
// on every render (no flicker, no Math.random in render).
function scatter(i, salt) {
  const x = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453
  return x - Math.floor(x)
}

// minutesNow returns minutes since local midnight. For trying out looks, the
// URL can force a time (?t=HH:MM) and a weather kind (?w=rain) — handy for
// admiring the night sky at noon.
function minutesNow() {
  const forced = new URLSearchParams(location.search).get('t')
  if (forced) {
    const [h, m] = forced.split(':').map(Number)
    if (!isNaN(h)) return h * 60 + (m || 0)
  }
  const d = new Date()
  return d.getHours() * 60 + d.getMinutes()
}

// phaseOfDay maps the clock to the sky's mood.
function phaseOfDay(now, sunrise, sunset) {
  if (now >= sunrise - 40 && now < sunrise + 30) return 'dawn'
  if (now >= sunrise + 30 && now < sunset - 40) return 'day'
  if (now >= sunset - 40 && now < sunset + 40) return 'dusk'
  return 'night'
}

// arcPosition places the sun (or moon) along a gentle arc: t runs 0..1 from
// rise to set; left sweeps across, top dips low at the edges, high at noon.
function arcPosition(t) {
  const clamped = Math.max(0, Math.min(1, t))
  return {
    left: 6 + clamped * 84 + '%',
    top: 50 - 38 * Math.sin(Math.PI * clamped) + '%',
  }
}

// How many clouds each weather mood wants, and how heavy they look.
const CLOUDS = {
  clear: { n: 1, dark: false },
  partly: { n: 2, dark: false },
  cloudy: { n: 4, dark: true },
  fog: { n: 3, dark: true },
  rain: { n: 3, dark: true },
  snow: { n: 3, dark: false },
  storm: { n: 4, dark: true },
}

// A small chip in the panel showing the real weather.
const WEATHER_CHIP = {
  clear: '☀️', partly: '🌤️', cloudy: '☁️', fog: '🌫️',
  rain: '🌧️', snow: '❄️', storm: '⛈️',
}

export default function Garden({ garden, setGarden }) {
  const [busy, setBusy] = useState(false)
  const [watering, setWatering] = useState(false)
  const [weather, setWeather] = useState(null)
  const [now, setNow] = useState(minutesNow)
  const [bees, setBees] = useState([]) // little visitors, up to a few at once
  const [hearts, setHearts] = useState([]) // little thanks for petting a bee
  const [sunSmile, setSunSmile] = useState(false) // the sun beams back when poked
  const [squish, setSquish] = useState(null) // {i, nonce} of the cloud being squished
  const flowersRef = useRef([]) // latest flower spots, for bees to aim at
  const nightRef = useRef(false) // bees sleep at night
  const gardenRef = useRef(null) // for measuring where the flowers really are
  const heartIdRef = useRef(1)
  const heartTimersRef = useRef(new Set())

  // Petting a bee: a tiny burst of hearts bubbles up from the bee — three of
  // them, different sizes, drifting apart as they rise.
  const popHeart = useCallback((e) => {
    const root = gardenRef.current
    if (!root) return
    const rect = root.getBoundingClientRect()
    const bee = e.currentTarget.getBoundingClientRect()
    const x = ((bee.left + bee.width / 2 - rect.left) / rect.width) * 100
    const y = ((bee.top - rect.top) / rect.height) * 100
    const burst = ['💗', '💕', '💖'].map((emoji, i) => ({
      id: heartIdRef.current++,
      emoji,
      x,
      y,
      dx: (Math.random() * 2 - 1) * 22,        // sideways drift, px
      rot: (Math.random() * 2 - 1) * 24,       // a little tilt as it rises
      size: 12 + Math.random() * 7,
      delay: i * 0.14,
    }))
    setHearts((prev) => [...prev, ...burst])
    const t = setTimeout(() => {
      heartTimersRef.current.delete(t)
      const gone = new Set(burst.map((h) => h.id))
      setHearts((prev) => prev.filter((h) => !gone.has(h.id)))
    }, 2100)
    heartTimersRef.current.add(t)
  }, [])

  useEffect(() => {
    const timers = heartTimersRef.current
    return () => timers.forEach(clearTimeout)
  }, [])

  // Poking the sun makes it smile for a moment.
  const pokeSun = useCallback(() => {
    setSunSmile(true)
    const t = setTimeout(() => {
      heartTimersRef.current.delete(t)
      setSunSmile(false)
    }, 2600)
    heartTimersRef.current.add(t)
  }, [])

  // Squishing a cloud: remember which one (with a nonce so rapid pokes replay
  // the wobble), and let it settle back after the animation.
  const pokeCloud = useCallback((i) => {
    setSquish({ i, nonce: Date.now() })
    const t = setTimeout(() => {
      heartTimersRef.current.delete(t)
      setSquish(null)
    }, 750)
    heartTimersRef.current.add(t)
  }, [])

  // Clock tick so the sun keeps moving while the tab stays open.
  useEffect(() => {
    const t = setInterval(() => setNow(minutesNow()), 30000)
    return () => clearInterval(t)
  }, [])

  // Fetch the real weather now and then. Silently does nothing when disabled.
  useEffect(() => {
    let alive = true
    const load = () => apiGet('/api/weather').then((w) => alive && setWeather(w)).catch(() => {})
    load()
    const t = setInterval(load, 15 * 60 * 1000)
    return () => {
      alive = false
      clearInterval(t)
    }
  }, [])

  // The bees. Each one enters from a random side, then either drifts straight
  // across, or dives down to one of our flowers, circles it for a while, and
  // only then buzzes away. Up to three can be out at once, on their own
  // schedules. Movement is plain CSS transitions on left/top, so each leg of
  // the journey is just a state patch with its travel time.
  useEffect(() => {
    let alive = true
    let active = 0
    let nextId = 1
    const timers = new Set()
    const later = (fn, ms) => {
      const t = setTimeout(() => {
        timers.delete(t)
        if (alive) fn()
      }, ms)
      timers.add(t)
    }
    const patch = (id, p) =>
      setBees((prev) => prev.map((b) => (b.id === id ? { ...b, ...p } : b)))

    const spawn = () => {
      later(spawn, 5000 + Math.random() * 13000) // keep the visits coming
      if (nightRef.current || active >= 3) return // bees are home after dark
      active++
      const id = nextId++
      const dir = Math.random() < 0.5 ? 1 : -1
      const entryX = dir === 1 ? -6 : 106
      setBees((prev) => [
        ...prev,
        { id, dir, x: entryX, y: 14 + Math.random() * 26, t: 0, orbit: false },
      ])

      const leave = (travel) => {
        patch(id, { x: dir === 1 ? 106 : -6, y: 12 + Math.random() * 30, t: travel, orbit: false })
        later(() => {
          setBees((prev) => prev.filter((b) => b.id !== id))
          active--
        }, travel * 1000 + 300)
      }

      // A beat after entering, choose: visit a flower, or just pass through.
      later(() => {
        const spots = flowersRef.current
        if (spots.length && Math.random() < 0.65) {
          const f = spots[Math.floor(Math.random() * spots.length)]
          const travel = 3 + Math.random() * 2
          // Aim at the blossom itself: measure the real layout instead of
          // guessing, since the garden's height differs per device. The flower
          // stands on the hill above the panel; its head sits near the top of
          // its 90px (scaled) sprite.
          let y = 62
          const root = gardenRef.current
          if (root && root.clientHeight > 0) {
            const panelH = root.querySelector('.garden-panel')?.offsetHeight || 150
            const headPx = root.clientHeight - panelH - 26 - 90 * f.size * 0.62
            y = (headPx / root.clientHeight) * 100
          }
          patch(id, { x: f.left, y, t: travel })
          later(() => {
            patch(id, { orbit: true }) // circle the flower
            later(() => leave(3.5 + Math.random() * 2), 2200 + Math.random() * 3200)
          }, travel * 1000)
        } else {
          leave(8 + Math.random() * 5)
        }
      }, 80)
    }

    later(spawn, 2000 + Math.random() * 5000)
    return () => {
      alive = false
      timers.forEach(clearTimeout)
    }
  }, [])

  const water = useCallback(async () => {
    setBusy(true)
    setWatering(true)
    try {
      const view = await apiPost('/api/garden/water')
      setGarden(view)
    } catch (err) {
      alert(err.message)
    } finally {
      setBusy(false)
      setTimeout(() => setWatering(false), 1300)
    }
  }, [setGarden])

  // Stars keep their places between renders.
  const stars = useMemo(
    () =>
      Array.from({ length: 26 }, (_, i) => ({
        left: scatter(i, 1) * 96 + 2 + '%',
        top: scatter(i, 2) * 52 + 2 + '%',
        delay: scatter(i, 3) * 3 + 's',
        size: scatter(i, 4) > 0.8 ? 3 : 2,
      })),
    [],
  )

  if (!garden) {
    return <div className="garden loading">Growing…</div>
  }

  const sunrise = weather?.enabled && weather.sunriseMin > 0 ? weather.sunriseMin : DEFAULT_SUNRISE
  const sunset = weather?.enabled && weather.sunsetMin > 0 ? weather.sunsetMin : DEFAULT_SUNSET
  const phase = phaseOfDay(now, sunrise, sunset)
  const night = phase === 'night'
  nightRef.current = night

  const forcedKind = new URLSearchParams(location.search).get('w')
  const kind = forcedKind || (weather?.enabled ? weather.kind : 'clear')
  const clouds = CLOUDS[kind] || CLOUDS.clear

  // Sun by day, moon by night, each on its own arc.
  let celestial
  if (!night) {
    celestial = { cls: 'sun', ...arcPosition((now - sunrise) / (sunset - sunrise)) }
  } else {
    // The night runs sunset -> sunrise (crossing midnight).
    const len = 24 * 60 - (sunset - sunrise)
    const since = now >= sunset ? now - sunset : now + (24 * 60 - sunset)
    celestial = { cls: 'moon', ...arcPosition(since / len) }
  }

  const growth = garden.maxStage > 0 ? (garden.treeStage / garden.maxStage) * 100 : 0

  // Flowers scatter across the hill, each with its own kind, size and sway.
  const flowers = Array.from({ length: garden.flowers }, (_, i) => ({
    kind: i % 6,
    left: 4 + scatter(i, 7) * 88,
    size: 0.75 + scatter(i, 8) * 0.4,
    sway: scatter(i, 9) * 2,
    back: scatter(i, 7) > 0.36 && scatter(i, 7) < 0.64, // behind the tree zone
  }))
  flowersRef.current = flowers // where the bees will look for nectar

  return (
    <div ref={gardenRef} className={`garden phase-${phase} w-${kind}`}>
      <div className="sky">
        <div
          className={celestial.cls + (sunSmile ? ' happy' : '')}
          style={{ left: celestial.left, top: celestial.top }}
          onClick={pokeSun}
        >
          {/* The sun's face, revealed when someone says hello. */}
          {sunSmile && !night && (
            <svg className="sun-face" viewBox="0 0 40 40" aria-hidden="true">
              <circle cx="13" cy="16" r="2.6" fill="#a5651e" />
              <circle cx="27" cy="16" r="2.6" fill="#a5651e" />
              <path d="M12 24 Q 20 32 28 24" stroke="#a5651e" strokeWidth="2.6"
                fill="none" strokeLinecap="round" />
              <circle cx="9" cy="22" r="2.4" fill="#ffb199" opacity="0.7" />
              <circle cx="31" cy="22" r="2.4" fill="#ffb199" opacity="0.7" />
            </svg>
          )}

          {/* The moon's face: the very same smile, but eyes closed and dozing —
              softly shut lids and a little zZ. */}
          {sunSmile && night && (
            <svg className="moon-face" viewBox="0 0 40 40" aria-hidden="true">
              {/* peacefully closed eyes (gentle downward lids) */}
              <path d="M9 16 Q13 20 17 16" stroke="#8681a3" strokeWidth="2.2"
                fill="none" strokeLinecap="round" />
              <path d="M23 16 Q27 20 31 16" stroke="#8681a3" strokeWidth="2.2"
                fill="none" strokeLinecap="round" />
              {/* the same style of smile as the sun */}
              <path d="M13 25 Q 20 31 27 25" stroke="#8681a3" strokeWidth="2.4"
                fill="none" strokeLinecap="round" />
              <circle cx="9" cy="22" r="2.4" fill="#c9a9d8" opacity="0.6" />
              <circle cx="31" cy="22" r="2.4" fill="#c9a9d8" opacity="0.6" />
              {/* a sleepy little zZ drifting up from the corner */}
              <text className="moon-zzz" x="30" y="12" fill="#8681a3">z</text>
              <text className="moon-zzz2" x="34" y="7" fill="#8681a3">z</text>
            </svg>
          )}
        </div>

        {night &&
          stars.map((s, i) => (
            <span key={i} className="star"
              style={{ left: s.left, top: s.top, width: s.size, height: s.size, animationDelay: s.delay }} />
          ))}

        {Array.from({ length: clouds.n }, (_, i) => (
          <div key={i}
            className={'cloud' + (clouds.dark ? ' cloud-dark' : '')}
            style={{
              top: 6 + scatter(i, 11) * 30 + '%',
              animationDuration: 70 + scatter(i, 12) * 50 + 's',
              animationDelay: -scatter(i, 13) * 90 + 's',
              transform: `scale(${0.7 + scatter(i, 14) * 0.6})`,
            }}>
            {/* The inner puff is what jiggles when squished (keyed so rapid
                pokes restart the wobble). */}
            <div
              key={squish?.i === i ? squish.nonce : 'calm'}
              className={'cloud-puff' + (squish?.i === i ? ' squish' : '')}
              onClick={() => pokeCloud(i)}
            />
          </div>
        ))}

        {/* In grey weather a slow cloud keeps the sun company. */}
        {!night && (kind === 'cloudy' || kind === 'partly') && (
          <div className="cloud sun-hugger"
            style={{
              left: `calc(${celestial.left} + 26px)`,
              top: `calc(${celestial.top} + 14px)`,
            }}>
            <div
              key={squish?.i === -1 ? squish.nonce : 'calm'}
              className={'cloud-puff' + (squish?.i === -1 ? ' squish' : '')}
              onClick={() => pokeCloud(-1)}
            />
          </div>
        )}

        {(kind === 'rain' || kind === 'storm') && (
          <div className="rain">
            {Array.from({ length: 26 }, (_, i) => (
              <span key={i} className="raindrop"
                style={{ left: scatter(i, 21) * 100 + '%', animationDelay: scatter(i, 22) * 1 + 's' }} />
            ))}
          </div>
        )}
        {kind === 'snow' && (
          <div className="snow">
            {Array.from({ length: 22 }, (_, i) => (
              <span key={i} className="snowflake"
                style={{ left: scatter(i, 31) * 100 + '%', animationDelay: scatter(i, 32) * 5 + 's' }}>
                ❄
              </span>
            ))}
          </div>
        )}
        {kind === 'storm' && <div className="lightning" />}
        {kind === 'fog' && <div className="fog" />}

      </div>

      {/* A small weather-app style card: place, temperature, conditions. */}
      {weather?.enabled && (
        <div className="weather-card">
          <div className="weather-place">{weather.place || 'Home'}</div>
          <div className="weather-temp">
            {Math.round(weather.tempC)}°C
            <span className="weather-f">{Math.round(weather.tempC * 9 / 5 + 32)}°F</span>
          </div>
          <div className="weather-desc">
            {WEATHER_CHIP[kind]} {weather.desc}
          </div>
        </div>
      )}

      <div className="garden-scene">
        {watering && (
          <div className="water-drops" aria-hidden="true">
            {Array.from({ length: 7 }).map((_, i) => (
              <span key={i} className="drop"
                style={{ left: 36 + i * 5 + '%', animationDelay: i * 0.09 + 's' }}>
                💧
              </span>
            ))}
          </div>
        )}

        <div className="hill" />
        {/* Flowers behind the tree first, then the tree, then the front row. */}
        <div className="flower-row">
          {flowers.filter((f) => f.back).map((f, i) => (
            <div key={'b' + i} className="flower-spot" style={{ left: f.left + '%' }}>
              <Flower kind={f.kind} size={f.size * 0.9} sway={f.sway} />
            </div>
          ))}
        </div>
        <div className="tree-wrap" title={garden.stageName}>
          <Tree stage={garden.treeStage} season={garden.season} />
        </div>
        <div className="flower-row front">
          {flowers.filter((f) => !f.back).map((f, i) => (
            <div key={'f' + i} className="flower-spot" style={{ left: f.left + '%' }}>
              <Flower kind={f.kind} size={f.size} sway={f.sway} />
            </div>
          ))}
        </div>
      </div>

      {/* Bees fly above the plants (but under the panel). */}
      <div className="bee-layer" aria-hidden="true">
        {bees.map((b) => (
          <div key={b.id} className="bee-fly"
            style={{
              left: b.x + '%',
              top: b.y + '%',
              transition: `left ${b.t}s linear, top ${b.t}s ease-in-out`,
            }}>
            <span className={'bee-orbiter' + (b.orbit ? ' orbit' : '')}>
              {/* Clicking (petting) a bee earns you a little heart. */}
              <span className="bee" onClick={popHeart}
                style={{ transform: b.dir === 1 ? 'scaleX(-1)' : 'none' }}>🐝</span>
            </span>
          </div>
        ))}
        {hearts.map((h) => (
          <span key={h.id} className="heart-pop"
            style={{
              left: h.x + '%',
              top: h.y + '%',
              fontSize: h.size + 'px',
              animationDelay: h.delay + 's',
              '--dx': h.dx + 'px',
              '--rot': h.rot + 'deg',
            }}>
            {h.emoji}
          </span>
        ))}
      </div>

      <div className="garden-panel">
        <div className="garden-stage-name">{garden.stageName}</div>
        <div className="growth-bar">
          <div className="growth-fill" style={{ width: growth + '%' }} />
        </div>
        <div className="garden-stats">
          <span title="Growth points">🌟 {garden.points}</span>
          <span title="Day streak">🔥 {garden.streakDays}</span>
          <span title="Flowers in bloom">🌷 {garden.flowers}</span>
        </div>
        <div className="garden-actions">
          <button className="garden-btn" disabled={!garden.canWaterToday || busy} onClick={water}>
            💧 {garden.canWaterToday ? 'Water the garden' : 'Watered today'}
          </button>
        </div>
      </div>
    </div>
  )
}
