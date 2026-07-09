import React, { useCallback, useEffect, useRef, useState } from 'react'
import { apiGet, apiPost } from '../api.js'

// DogSand is our little stress-relief game. Cute dogs drop from the top,
// running happily in place on the way down; when one lands (on the floor or on
// the pile below) it gently melts into a heap of sand in its own colour. The
// sand obeys a simple per-pixel physics — grains fall and slide down slopes —
// and whenever a row fills most of the way across it clears, Tetris-style, for
// points. It's meant to be soothing to watch, not hard to win.

// --- Simulation size -------------------------------------------------------
// The sand lives on a COLS x ROWS grid of grains. SCALE blows each grain up to
// a few screen pixels; the canvas is then scaled to fit its container by CSS.
const COLS = 90
const ROWS = 140
const SCALE = 4
const VIEW_W = COLS * SCALE
const VIEW_H = ROWS * SCALE

// A full-ish horizontal line of sand clears. Real sand piles into slopes, so
// requiring a *completely* full row would almost never trigger — 88% feels
// right: you're rewarded for filling the floor without needing perfection.
const CLEAR_FRACTION = 0.88

// How often (in animation frames) gravity pulls the falling dog down one cell.
// Soft-drop skips the wait. 60fps / 4 = 15 cells a second.
const FALL_EVERY = 4
const SOFT_FALL_EVERY = 1

// How many frames the landing melt takes: the pup squashes down while its
// grains pour out row by row from the bottom.
const MELT_FRAMES = 40

// The breeds, drawn WeChat-表情包-style. The strongest breed signals — ears,
// tail, and coat pattern (花色) — each get their own field:
//   face:  'capped' = white face/belly wearing the colour over scalp+back;
//          'solid'  = fully coloured with a light muzzle patch
//   ear:   'perky' (triangles up) | 'floppy' (drop beside the head) |
//          'round' (puffs) | 'drop' (long spaniel ears)
//   tail:  'curl' (over the back — shiba/samoyed/pug) | 'fluff' (thick plume)
//          | 'stub' (docked nub — corgi/rottie) | 'thin' | 'straight'
//   extras: brows (eyebrow dots), mask (dark snout), spots (dalmatian),
//          saddle (the German-shepherd black back), earColor (when the ears
//          differ from the marking), sand (explicit sand colour so white
//          breeds never melt into invisible white grains)
//   weight: relative spawn frequency (the user's favourites show up more)
const BREEDS = [
  // the four favourites, weighted up
  { name: 'samoyed', color: [0xf9, 0xf5, 0xee], face: 'solid', muzzle: [0xff, 0xff, 0xff], ear: 'perky', tail: 'curl', sand: [0xe9, 0xd6, 0xae], weight: 3 },
  { name: 'shiba', color: [0xf0, 0x94, 0x4a], face: 'capped', ear: 'perky', tail: 'curl', brows: [0xff, 0xf6, 0xe8], weight: 3 },
  { name: 'german shepherd', color: [0xdf, 0xa7, 0x5e], face: 'solid', ear: 'perky', earColor: [0x4b, 0x43, 0x50], tail: 'straight', saddle: [0x4b, 0x43, 0x50], mask: [0x5a, 0x4a, 0x42], weight: 3 },
  { name: 'bernese', color: [0x4f, 0x4a, 0x55], face: 'capped', ear: 'floppy', tail: 'fluff', brows: [0xd9, 0xa0, 0x5e], weight: 3 },
  // popular pals
  { name: 'husky', color: [0x9a, 0xa4, 0xb5], face: 'capped', ear: 'perky', tail: 'curl', weight: 2 },
  { name: 'corgi', color: [0xf4, 0x9b, 0x52], face: 'capped', ear: 'perky', tail: 'stub', weight: 2 },
  { name: 'golden', color: [0xee, 0xc2, 0x7c], face: 'solid', muzzle: [0xf9, 0xec, 0xd2], ear: 'floppy', tail: 'fluff', weight: 2 },
  { name: 'akita', color: [0xf2, 0xc9, 0x8f], face: 'capped', ear: 'perky', tail: 'curl' },
  // the rest of the park
  { name: 'beagle', color: [0xc0, 0x89, 0x4f], face: 'capped', ear: 'drop', tail: 'straight' },
  { name: 'border collie', color: [0x55, 0x50, 0x5e], face: 'capped', ear: 'floppy', tail: 'fluff' },
  { name: 'aussie', color: [0x9a, 0x93, 0xa5], face: 'capped', ear: 'floppy', tail: 'stub' },
  { name: 'st bernard', color: [0xc0, 0x7a, 0x4a], face: 'capped', ear: 'floppy', tail: 'fluff' },
  { name: 'jack russell', color: [0xc5, 0x8a, 0x4f], face: 'capped', ear: 'perky', tail: 'thin', sand: [0xe8, 0xdc, 0xc4] },
  { name: 'cavalier', color: [0xa8, 0x6a, 0x3f], face: 'capped', ear: 'drop', tail: 'fluff' },
  { name: 'frenchie', color: [0xcf, 0xc4, 0xbf], face: 'capped', ear: 'round', tail: 'stub' },
  { name: 'papillon', color: [0xb0, 0x79, 0x3f], face: 'capped', ear: 'perky', tail: 'thin', sand: [0xe6, 0xd8, 0xbe] },
  { name: 'cream lab', color: [0xf4, 0xe3, 0xc8], face: 'solid', muzzle: [0xff, 0xfa, 0xf0], ear: 'floppy', tail: 'straight' },
  { name: 'black lab', color: [0x4a, 0x45, 0x50], face: 'solid', muzzle: [0x5e, 0x58, 0x66], ear: 'floppy', tail: 'straight' },
  { name: 'choco lab', color: [0x96, 0x68, 0x3f], face: 'solid', muzzle: [0xb9, 0x8c, 0x63], ear: 'floppy', tail: 'straight' },
  { name: 'rottweiler', color: [0x4a, 0x42, 0x45], face: 'solid', muzzle: [0xc9, 0xa0, 0x6e], ear: 'floppy', tail: 'stub', brows: [0xc9, 0xa0, 0x6e] },
  { name: 'doberman', color: [0x3f, 0x3a, 0x45], face: 'solid', muzzle: [0xb9, 0x88, 0x5a], ear: 'perky', tail: 'thin', brows: [0xb9, 0x88, 0x5a] },
  { name: 'pom', color: [0xf3, 0xb5, 0x6e], face: 'solid', muzzle: [0xfc, 0xe7, 0xc8], ear: 'round', tail: 'curl' },
  { name: 'chow chow', color: [0xe8, 0x9a, 0x55], face: 'solid', muzzle: [0xf0, 0xb8, 0x7a], ear: 'round', tail: 'curl' },
  { name: 'pink poodle', color: [0xee, 0xb0, 0xab], face: 'solid', muzzle: [0xf8, 0xd8, 0xd4], ear: 'round', tail: 'curl' },
  { name: 'apricot poodle', color: [0xe8, 0xc4, 0x9a], face: 'solid', muzzle: [0xf6, 0xe6, 0xcd], ear: 'round', tail: 'curl' },
  { name: 'dalmatian', color: [0xf6, 0xf4, 0xee], face: 'solid', muzzle: [0xff, 0xff, 0xff], ear: 'floppy', tail: 'thin', spots: [0x42, 0x3c, 0x48], sand: [0xe6, 0xdc, 0xc8] },
  { name: 'pug', color: [0xe3, 0xc1, 0x94], face: 'solid', muzzle: [0xf0, 0xdd, 0xbd], ear: 'floppy', tail: 'curl', mask: [0x6b, 0x57, 0x47] },
  { name: 'pekingese', color: [0xd9, 0xb2, 0x85], face: 'solid', muzzle: [0xe8, 0xcc, 0xa5], ear: 'drop', tail: 'curl', mask: [0x6b, 0x57, 0x47] },
  { name: 'schnauzer', color: [0x8f, 0x8a, 0x95], face: 'solid', muzzle: [0xd9, 0xd5, 0xdd], ear: 'perky', tail: 'stub' },
  { name: 'westie', color: [0xf4, 0xef, 0xe2], face: 'solid', muzzle: [0xff, 0xff, 0xff], ear: 'perky', tail: 'straight', sand: [0xe7, 0xd9, 0xb8] },
  { name: 'scottie', color: [0x3d, 0x38, 0x44], face: 'solid', muzzle: [0x4a, 0x45, 0x50], ear: 'perky', tail: 'straight' },
  { name: 'maltese', color: [0xfb, 0xf7, 0xf0], face: 'solid', muzzle: [0xff, 0xff, 0xff], ear: 'drop', tail: 'fluff', sand: [0xea, 0xd9, 0xc2] },
  { name: 'dachshund', color: [0xa5, 0x71, 0x4c], face: 'solid', muzzle: [0xe6, 0xc9, 0xa8], ear: 'drop', tail: 'thin' },
]

// Weighted pick so the favourite breeds visit the most.
const BREED_TICKETS = BREEDS.flatMap((b) => Array(b.weight || 1).fill(b))
function pickBreed() {
  return BREED_TICKETS[Math.floor(Math.random() * BREED_TICKETS.length)]
}

// The dog's footprint: a small rounded blob. Both the falling sprite and the
// melted sand use this mask, so the pile matches the pup that made it.
const DOG_W = 14
const DOG_H = 11
const DOG_MASK = buildDogMask()

function buildDogMask() {
  const cells = []
  const cx = (DOG_W - 1) / 2
  const cy = (DOG_H - 1) / 2
  const rx = DOG_W / 2
  const ry = DOG_H / 2
  for (let y = 0; y < DOG_H; y++) {
    for (let x = 0; x < DOG_W; x++) {
      const nx = (x - cx) / rx
      const ny = (y - cy) / ry
      if (nx * nx + ny * ny <= 1) cells.push([x, y])
    }
  }
  return cells
}

// pack turns an [r,g,b] into a single non-zero integer we can store per grain.
// Zero means "empty", so we never let a colour collapse to 0 (pure black is
// nudged up a touch).
function pack(r, g, b) {
  const v = (r << 16) | (g << 8) | b
  return v === 0 ? 1 : v
}

// jitter nudges a grain's brightness a little so a melted pile looks like sand
// (grainy) rather than a flat blob of one colour.
function jitter(channel) {
  const d = Math.floor((Math.random() - 0.5) * 26)
  return Math.max(0, Math.min(255, channel + d))
}

// tintVisible keeps sand seeable: a white pup would otherwise melt into
// near-white grains that vanish against the pale sky. Anything too bright is
// pulled down to a warm cream that still reads as "that white dog's sand".
function tintVisible(c) {
  const avg = (c[0] + c[1] + c[2]) / 3
  if (avg <= 225) return c
  return [Math.round(c[0] * 0.88), Math.round(c[1] * 0.84), Math.round(c[2] * 0.72)]
}

// grainColor picks a sand colour for one grain of a melting pup: mostly the
// marking colour, sometimes a light speckle (or the dalmatian's dark spots).
// A breed with an explicit `sand` colour uses it directly — that's how the
// white dogs (samoyed, maltese, westie…) melt into warm cream instead of
// invisible white.
function grainColor(breed) {
  const body = breed.sand || tintVisible(breed.color)
  const speck = breed.spots || tintVisible(breed.muzzle || [0xff, 0xf6, 0xe8])
  const src = Math.random() < (breed.spots ? 0.22 : 0.12) ? speck : body
  return pack(jitter(src[0]), jitter(src[1]), jitter(src[2]))
}

// --- Little sounds (Web Audio, no files needed) ------------------------------
// A soft sandy "shhh" when a pup melts, and a happy two-note chime when a row
// clears. The context is created on the first Play click (browsers require a
// user gesture before audio).
let AC = null
function audioCtx() {
  if (!AC) {
    const Ctor = window.AudioContext || window.webkitAudioContext
    if (!Ctor) return null
    AC = new Ctor()
  }
  if (AC.state === 'suspended') AC.resume()
  return AC
}

// playMeltSound: a short burst of band-passed noise — the 哗啦 of pouring sand.
function playMeltSound() {
  const ac = audioCtx()
  if (!ac) return
  const dur = 0.45
  const buf = ac.createBuffer(1, Math.floor(ac.sampleRate * dur), ac.sampleRate)
  const d = buf.getChannelData(0)
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1
  const src = ac.createBufferSource()
  src.buffer = buf
  const bp = ac.createBiquadFilter()
  bp.type = 'bandpass'
  bp.frequency.value = 3800
  bp.Q.value = 0.7
  const g = ac.createGain()
  const t0 = ac.currentTime
  g.gain.setValueAtTime(0.0001, t0)
  g.gain.exponentialRampToValueAtTime(0.22, t0 + 0.03)
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur)
  src.connect(bp)
  bp.connect(g)
  g.connect(ac.destination)
  src.start()
}

// playClearSound: two quick ascending chime notes for a cleared row.
function playClearSound() {
  const ac = audioCtx()
  if (!ac) return
  const t0 = ac.currentTime
  for (const [freq, dt] of [[784, 0], [1046.5, 0.09]]) {
    const o = ac.createOscillator()
    o.type = 'triangle'
    o.frequency.value = freq
    const g = ac.createGain()
    g.gain.setValueAtTime(0.0001, t0 + dt)
    g.gain.exponentialRampToValueAtTime(0.18, t0 + dt + 0.015)
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.28)
    o.connect(g)
    g.connect(ac.destination)
    o.start(t0 + dt)
    o.stop(t0 + dt + 0.3)
  }
}

// relTime turns a timestamp into a short "how long ago" label for the plays.
function relTime(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000)
  if (s < 60) return 'just now'
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  const d = Math.floor(h / 24)
  return d === 1 ? 'yesterday' : `${d}d ago`
}

export default function DogSand() {
  const canvasRef = useRef(null)
  const [status, setStatus] = useState('idle') // idle | playing | over
  const [score, setScore] = useState(0)
  const [high, setHigh] = useState(null) // {score, holderName}
  const [flash, setFlash] = useState('') // a short "New record!" style note

  // Everything the animation loop mutates lives in a ref, so re-renders don't
  // reset the simulation and the loop always sees the latest values.
  const sim = useRef(null)
  const scoreRef = useRef(0)

  // Load the shared best score when the screen opens.
  useEffect(() => {
    apiGet('/api/game/score').then(setHigh).catch(() => {})
  }, [])

  // Build a fresh, empty simulation state.
  const makeSim = useCallback(
    () => ({
      grid: new Int32Array(COLS * ROWS), // 0 = empty, else packed colour
      dog: null, // the pup currently falling
      melt: null, // the pup currently melting into sand
      fallTick: 0, // frames since the dog last dropped a cell
      legTick: 0, // drives the running-legs animation
      soft: false, // is soft-drop (down) held?
      move: 0, // -1 / 0 / +1 horizontal intent this frame
      spawned: 0, // how many pups so far — drives the speed ramp
      raf: 0,
      running: false,
    }),
    [],
  )

  // Spawn a new pup at the top-centre. If its cells are already blocked, the
  // pile has reached the ceiling and the game is over. Each pup also draws a
  // random sticker expression so the fall stays lively.
  const spawnDog = useCallback((st) => {
    const breed = pickBreed()
    const x = Math.floor((COLS - DOG_W) / 2)
    const y = 0
    if (collides(st.grid, DOG_MASK, x, y)) return false
    st.dog = {
      x, y, breed,
      flip: Math.random() < 0.5,
      expr: {
        eyes: Math.random() < 0.4 ? 'happy' : 'bead',
        mouth: Math.random() < 0.45 ? 'open' : 'w',
      },
    }
    st.fallTick = 0
    st.spawned++
    return true
  }, [])

  // One physics tick: settle the sand, move/drop the dog, advance a melt,
  // clear full rows.
  const step = useCallback(
    (st) => {
      // Two sand substeps per frame so piles settle briskly but still visibly.
      stepSand(st.grid)
      stepSand(st.grid)

      // Horizontal nudge from the controls (blocked by walls/sand).
      if (st.dog && st.move && canMove(st.grid, st.dog, st.move, 0)) {
        st.dog.x += st.move
      }

      // Gravity on the pup. The longer you play, the faster they fall, so the
      // gap between pups keeps tightening (every 6 pups shaves a frame, down to
      // a brisk floor).
      if (st.dog) {
        st.fallTick++
        const ramped = Math.max(2, FALL_EVERY - Math.floor(st.spawned / 6))
        const every = st.soft ? SOFT_FALL_EVERY : ramped
        if (st.fallTick >= every) {
          st.fallTick = 0
          if (canMove(st.grid, st.dog, 0, 1)) {
            st.dog.y++
            st.legTick++ // legs stride each time it advances
          } else {
            // Landed — start the gentle melt instead of vanishing instantly.
            // A melting pup always closes its eyes happily (^^): it's content.
            st.melt = {
              x: st.dog.x, y: st.dog.y, breed: st.dog.breed, flip: st.dog.flip,
              expr: { ...st.dog.expr, eyes: 'happy' },
              t: 0, doneRows: 0,
            }
            st.dog = null
            playMeltSound() // the 哗啦 of a pup becoming sand
          }
        }
      }

      // A melting pup pours its grains out row by row from the bottom while the
      // sprite squashes down; the fresh grains slide with the sand physics
      // immediately, so the melt looks soft and alive.
      if (st.melt) {
        st.melt.t++
        const rows = Math.min(DOG_H, Math.ceil((st.melt.t / MELT_FRAMES) * DOG_H))
        if (rows > st.melt.doneRows) {
          for (const [mx, my] of DOG_MASK) {
            if (my < DOG_H - rows || my >= DOG_H - st.melt.doneRows) continue
            const gx = st.melt.x + mx
            const gy = st.melt.y + my
            if (gx < 0 || gx >= COLS || gy < 0 || gy >= ROWS) continue
            const i = gy * COLS + gx
            if (!st.grid[i]) st.grid[i] = grainColor(st.melt.breed)
          }
          st.melt.doneRows = rows
        }
        if (st.melt.t >= MELT_FRAMES) st.melt = null
      }

      // Clear any nearly-full rows and reward them. Points scale a little with
      // how many clear at once, so a big collapse feels good.
      const cleared = clearFullRows(st.grid)
      if (cleared > 0) {
        const gained = cleared * 10 * cleared
        scoreRef.current += gained
        setScore(scoreRef.current)
        playClearSound()
      }

      // Nobody falling or melting? Send in the next pup; failure = game over.
      if (!st.dog && !st.melt && st.running) {
        if (!spawnDog(st)) endGame(st)
      }
    },
    [spawnDog],
  )

  // Submit the current score to the shared board. The server only keeps it if
  // it beats the record, so it's safe to call whenever a run ends — including
  // just walking away. withUi updates the on-screen best + "new record" note;
  // we skip that when the component is going away (leaving the Play tab).
  const submitScore = useCallback((withUi) => {
    const sc = scoreRef.current
    if (sc <= 0) return
    const p = apiPost('/api/game/score', { score: sc })
    if (withUi) {
      p.then((g) => {
        setHigh(g)
        if (g.isNewRecord) setFlash('🏆 New record!')
      }).catch(() => {})
    } else {
      p.catch(() => {})
    }
  }, [])

  // Finish the game: stop the loop and bank the score.
  const endGame = useCallback((st) => {
    st.running = false
    setStatus('over')
    submitScore(true)
  }, [submitScore])

  // Draw the current frame: the settled sand as pixels, then the running (or
  // melting) pup on top as a little vector sprite.
  const draw = useCallback((st) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    ctx.imageSmoothingEnabled = false
    // The cute painted backdrop (sun, clouds, paw prints) replaces a plain
    // clear: it's opaque, so it wipes the previous frame in one blit.
    ctx.drawImage(getBackground(), 0, 0)

    // Blit the sand grid via an ImageData at grain resolution, scaled up.
    const off = st.off || (st.off = makeOffscreen())
    const img = st.img || (st.img = off.ctx.createImageData(COLS, ROWS))
    const data = img.data
    const grid = st.grid
    for (let i = 0; i < grid.length; i++) {
      const c = grid[i]
      const p = i * 4
      if (c) {
        data[p] = (c >> 16) & 255
        data[p + 1] = (c >> 8) & 255
        data[p + 2] = c & 255
        data[p + 3] = 255
      } else {
        data[p + 3] = 0
      }
    }
    off.ctx.putImageData(img, 0, 0)
    ctx.drawImage(off.canvas, 0, 0, VIEW_W, VIEW_H)

    if (st.dog) drawDog(ctx, st.dog, st.legTick)
    if (st.melt) drawMelt(ctx, st.melt)
  }, [])

  // The animation loop. Kept in a ref-driven closure so React state changes
  // never restart it mid-game.
  const loop = useCallback(() => {
    const st = sim.current
    if (!st || !st.running) return
    step(st)
    draw(st)
    st.raf = requestAnimationFrame(loop)
  }, [step, draw])

  const start = useCallback(() => {
    audioCtx() // unlock audio on the click, so the melt/clear sounds can play
    const st = makeSim()
    sim.current = st
    scoreRef.current = 0
    setScore(0)
    setFlash('')
    st.running = true
    spawnDog(st)
    setStatus('playing')
    st.raf = requestAnimationFrame(loop)
  }, [makeSim, spawnDog, loop])

  // Leaving the Play screen mid-game (switching tabs, logging out) counts as
  // stopping: bank the score first — the game is hard to lose, so most bests
  // come from simply walking away, not from dying.
  useEffect(() => {
    return () => {
      const st = sim.current
      if (st) {
        if (st.running) submitScore(false)
        st.running = false
        cancelAnimationFrame(st.raf)
      }
    }
  }, [submitScore])

  // Closing the tab / navigating away mid-game also banks the score. fetch with
  // keepalive survives the page unload where a normal request would be dropped.
  useEffect(() => {
    const onLeave = () => {
      const st = sim.current
      if (st && st.running && scoreRef.current > 0) {
        fetch('/api/game/score', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ score: scoreRef.current }),
          keepalive: true,
        }).catch(() => {})
      }
    }
    window.addEventListener('pagehide', onLeave)
    return () => window.removeEventListener('pagehide', onLeave)
  }, [])

  // Keyboard controls: ← → steer, ↓ soft-drop. Held keys set the intent; the
  // loop reads it each frame.
  useEffect(() => {
    const down = (e) => {
      const st = sim.current
      if (!st || !st.running) return
      if (e.key === 'ArrowLeft') { st.move = -1; e.preventDefault() }
      else if (e.key === 'ArrowRight') { st.move = 1; e.preventDefault() }
      else if (e.key === 'ArrowDown') { st.soft = true; e.preventDefault() }
    }
    const up = (e) => {
      const st = sim.current
      if (!st) return
      if (e.key === 'ArrowLeft' && st.move === -1) st.move = 0
      else if (e.key === 'ArrowRight' && st.move === 1) st.move = 0
      else if (e.key === 'ArrowDown') st.soft = false
    }
    window.addEventListener('keydown', down)
    window.addEventListener('keyup', up)
    return () => {
      window.removeEventListener('keydown', down)
      window.removeEventListener('keyup', up)
    }
  }, [])

  // On-screen buttons for phones. press() sets the intent, release() clears it.
  const press = (kind) => () => {
    const st = sim.current
    if (!st || !st.running) return
    if (kind === 'left') st.move = -1
    else if (kind === 'right') st.move = 1
    else if (kind === 'down') st.soft = true
  }
  const release = (kind) => () => {
    const st = sim.current
    if (!st) return
    if (kind === 'down') st.soft = false
    else st.move = 0
  }

  const holderNote =
    high && high.score > 0 && high.holderName ? ` · ${high.holderName}` : ''

  return (
    <div className="game">
      <div className="game-stage">
        {/* The frame matches the canvas box exactly, so the chip and overlay
            pin to the play field itself rather than the surrounding space. */}
        <div className="game-frame">
        <canvas
          ref={canvasRef}
          className="game-canvas"
          width={VIEW_W}
          height={VIEW_H}
        />

        {/* Score chip pinned to the corner of the play field, always in view. */}
        <div className="game-scores">
          <span className="game-score">⭐ {score}</span>
          <span className="game-high">
            Best {high ? high.score : '—'}
            {holderNote}
          </span>
        </div>

        {status !== 'playing' && (
          <div className="game-overlay">
            {status === 'idle' ? (
              <>
                <div className="game-title">🐾 Puppy Sandfall</div>
                <button className="send-btn" onClick={start}>Play 🐶</button>
              </>
            ) : (
              <>
                <div className="game-title">All done 🐾</div>
                <p className="game-blurb">
                  You scored <b>{score}</b>.{flash && <span className="game-flash"> {flash}</span>}
                </p>
                <button className="send-btn" onClick={start}>Play again 🐶</button>
              </>
            )}

            {high?.plays?.length > 0 && (
              <div className="game-plays">
                <div className="game-plays-title">Recent plays</div>
                {high.plays.map((p, i) => (
                  <div key={i} className="game-play-row">
                    <span className="game-play-who">{p.name}</span>
                    <span className="game-play-score">⭐ {p.score}</span>
                    <span className="game-play-when">{relTime(p.at)}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
        </div>
      </div>

      {status === 'playing' && (
        <div className="game-pad">
          <button
            className="pad-btn"
            onMouseDown={press('left')} onMouseUp={release('left')} onMouseLeave={release('left')}
            onTouchStart={press('left')} onTouchEnd={release('left')}
          >◀</button>
          <button
            className="pad-btn"
            onMouseDown={press('down')} onMouseUp={release('down')} onMouseLeave={release('down')}
            onTouchStart={press('down')} onTouchEnd={release('down')}
          >▼</button>
          <button
            className="pad-btn"
            onMouseDown={press('right')} onMouseUp={release('right')} onMouseLeave={release('right')}
            onTouchStart={press('right')} onTouchEnd={release('right')}
          >▶</button>
        </div>
      )}
    </div>
  )
}

// --- Physics helpers (plain functions over the grid) -----------------------

// makeOffscreen builds a tiny grain-resolution canvas we render the sand into
// once per frame, then scale up. Cheaper than thousands of fillRects.
function makeOffscreen() {
  const canvas = document.createElement('canvas')
  canvas.width = COLS
  canvas.height = ROWS
  return { canvas, ctx: canvas.getContext('2d') }
}

// stepSand advances every grain by one cell: straight down if it can, else
// tumbling to a free diagonal below. Scanning bottom-up means a grain only
// moves once per pass. The column scan direction flips each call so piles don't
// lean to one side.
function stepSand(grid) {
  const dir = Math.random() < 0.5 ? 1 : -1
  for (let y = ROWS - 2; y >= 0; y--) {
    const rowBase = y * COLS
    for (let k = 0; k < COLS; k++) {
      const x = dir === 1 ? k : COLS - 1 - k
      const i = rowBase + x
      const c = grid[i]
      if (!c) continue
      const below = i + COLS
      if (!grid[below]) {
        grid[below] = c
        grid[i] = 0
        continue
      }
      const canL = x > 0 && !grid[below - 1]
      const canR = x < COLS - 1 && !grid[below + 1]
      if (canL && canR) {
        if (Math.random() < 0.5) grid[below - 1] = c
        else grid[below + 1] = c
        grid[i] = 0
      } else if (canL) {
        grid[below - 1] = c
        grid[i] = 0
      } else if (canR) {
        grid[below + 1] = c
        grid[i] = 0
      }
    }
  }
}

// clearFullRows empties any row that's filled past CLEAR_FRACTION and returns
// how many cleared. The sand above simply falls into the gap next frame — a
// satisfying little collapse.
function clearFullRows(grid) {
  const need = Math.floor(COLS * CLEAR_FRACTION)
  let cleared = 0
  for (let y = ROWS - 1; y >= 0; y--) {
    const rowBase = y * COLS
    let count = 0
    for (let x = 0; x < COLS; x++) if (grid[rowBase + x]) count++
    if (count >= need) {
      for (let x = 0; x < COLS; x++) grid[rowBase + x] = 0
      cleared++
    }
  }
  return cleared
}

// collides reports whether any of the mask's cells (placed at x,y) fall outside
// the grid or onto settled sand.
function collides(grid, mask, x, y) {
  for (const [mx, my] of mask) {
    const gx = x + mx
    const gy = y + my
    if (gx < 0 || gx >= COLS || gy < 0 || gy >= ROWS) return true
    if (grid[gy * COLS + gx]) return true
  }
  return false
}

// canMove checks whether the dog can shift by (dx,dy) without hitting a wall or
// the pile. Only the dog's own mask matters — it isn't in the grid yet.
function canMove(grid, dog, dx, dy) {
  return !collides(grid, DOG_MASK, dog.x + dx, dog.y + dy)
}

// --- Dog sprite ------------------------------------------------------------

// drawDog paints the falling pup: translate to its cell box, flip to face left
// or right, add a happy bob, and hand off to drawPup.
function drawDog(ctx, dog, legTick) {
  const w = DOG_W * SCALE
  const h = DOG_H * SCALE
  ctx.save()
  ctx.translate(dog.x * SCALE + w / 2, dog.y * SCALE + h / 2)
  if (dog.flip) ctx.scale(-1, 1)
  ctx.translate(0, Math.sin(legTick * 0.9) * h * 0.04)
  drawPup(ctx, dog.breed, w, h, legTick, dog.expr)
  ctx.restore()
}

// drawMelt paints the landing squash: the pup flattens toward the ground and
// widens a touch while its sand pours out underneath, fading near the end.
function drawMelt(ctx, melt) {
  const w = DOG_W * SCALE
  const h = DOG_H * SCALE
  const p = melt.t / MELT_FRAMES
  const q = Math.max(0.06, 1 - p)
  ctx.save()
  ctx.globalAlpha = p < 0.65 ? 1 : Math.max(0, (1 - p) / 0.35)
  ctx.translate(melt.x * SCALE + w / 2, melt.y * SCALE + h) // anchor at its feet
  if (melt.flip) ctx.scale(-1, 1)
  ctx.scale(1 + 0.45 * p, q) // squash down, spread out
  ctx.translate(0, -h / 2)
  drawPup(ctx, melt.breed, w, h, 0, melt.expr)
  ctx.restore()
}

// --- The pup sprite (WeChat-sticker side view) -------------------------------
// The pup is drawn the way sticker apps do it: all the parts are painted as
// clean FILLS on an offscreen canvas, and then a uniform ink border is stamped
// around the union of everything (by re-drawing the sprite's silhouette at 8
// offsets underneath itself). That one unbroken outline around the whole
// figure is what makes it read as hand-drawn; strokes around each shape never
// do. Proportions follow the 表情包 references in claude/sticker-example/:
// huge head at the front, clear snout, big ear, chubby little body, thick tail.

// Two reusable scratch canvases: the sprite and its ink-tinted copy.
let SCRATCH = null
function getScratch() {
  if (!SCRATCH) {
    const mk = () => {
      const c = document.createElement('canvas')
      c.width = 180
      c.height = 160
      return c
    }
    const s = mk()
    const t = mk()
    SCRATCH = { s, sc: s.getContext('2d'), t, tc: t.getContext('2d') }
  }
  return SCRATCH
}

// drawPup builds the pup on the scratch canvas and blits it (plus its stamped
// outline) centred on the current origin of ctx — so the caller's transforms
// (flip, bob, melt squash) apply to the finished sticker. Shapes are authored
// in a 100x80 design space, dog facing right. legTick drives the trot; expr
// picks the expression.
function drawPup(ctx, breed, w, h, legTick, expr = { eyes: 'bead', mouth: 'w' }) {
  const rgb = (c) => `rgb(${c[0]},${c[1]},${c[2]})`
  const col = rgb(breed.color)
  const white = '#fff8f0'
  const base = breed.face === 'solid' ? col : white
  const ink = '#4a3a2e' // the sticker's warm outline
  const dark = '#3a2b26' // eye / nose / mouth
  const swing = Math.sin(legTick * 0.9)

  const U = (w * 1.15) / 100 // one design unit in pixels
  const { s, sc, t, tc } = getScratch()
  const SW = s.width
  const SH = s.height
  const X = (v) => SW / 2 + (v - 52) * U
  const Y = (v) => SH / 2 + (v - 36) * U

  sc.setTransform(1, 0, 0, 1, 0, 0)
  sc.clearRect(0, 0, SW, SH)

  // Outlined capsule strokes (legs, tail): fat ink pass, then colour on top.
  const rim = Math.max(1.1, U * 2.2)
  const capsule = (color, width, path) => {
    for (const [style, lw] of [[ink, width + rim * 2], [color, width]]) {
      sc.strokeStyle = style
      sc.lineWidth = lw
      sc.lineCap = 'round'
      sc.beginPath()
      path()
      sc.stroke()
    }
  }

  // -- tail: each breed's most recognisable flag, wagging --------------------
  // curl = over the back (shiba/samoyed/pug), fluff = thick plume (golden/
  // bernese), stub = docked nub (corgi), thin = whip, straight = plain happy.
  const tailKind = breed.tail || 'straight'
  if (tailKind === 'curl') {
    capsule(col, U * 5.5, () => {
      sc.moveTo(X(12), Y(42))
      sc.bezierCurveTo(X(2 + swing * 2), Y(30), X(6 + swing * 3), Y(18), X(16 + swing * 2), Y(24))
    })
  } else if (tailKind === 'fluff') {
    capsule(col, U * 9, () => {
      sc.moveTo(X(12), Y(46))
      sc.quadraticCurveTo(X(4 + swing * 3), Y(38), X(6 + swing * 4), Y(28))
    })
  } else if (tailKind === 'stub') {
    capsule(col, U * 5, () => {
      sc.moveTo(X(11), Y(46))
      sc.lineTo(X(7 + swing * 2), Y(41))
    })
  } else if (tailKind === 'thin') {
    capsule(col, U * 3.5, () => {
      sc.moveTo(X(12), Y(46))
      sc.quadraticCurveTo(X(2 + swing * 3), Y(38), X(2 + swing * 4), Y(24))
    })
  } else {
    capsule(col, U * 6, () => {
      sc.moveTo(X(12), Y(46))
      sc.quadraticCurveTo(X(4 + swing * 3), Y(36), X(7 + swing * 4), Y(24))
    })
  }

  // -- far legs (a darker shade, peeking from behind the body) --------------
  const shade = rgb(breed.color.map((v) => Math.max(0, Math.round(v * 0.8))))
  const farBase = breed.face === 'solid' ? shade : '#e8dccb'
  const leg = (hipX, hipY, dir, color) => {
    const kick = swing * dir
    capsule(color, U * 6.5, () => {
      sc.moveTo(X(hipX), Y(hipY))
      sc.lineTo(X(hipX + kick * 6), Y(73 - Math.max(0, kick) * 4))
    })
  }
  leg(54, 60, -1, farBase)
  leg(20, 61, 1, farBase)

  // -- the three body masses: a longer, slimmer body, the head (a size down
  // from before, per the user), and the snout ------------------------------
  const bodyParts = () => {
    sc.ellipse(X(31), Y(52), U * 30, U * 16, -0.06, 0, Math.PI * 2) // body loaf
    sc.moveTo(X(86), Y(30))
    sc.arc(X(66), Y(30), U * 20, 0, Math.PI * 2) // the head
    sc.moveTo(X(97), Y(39))
    sc.ellipse(X(87), Y(39), U * 10, U * 8, 0, 0, Math.PI * 2) // snout
  }
  sc.beginPath()
  bodyParts()
  sc.fillStyle = base
  sc.fill()

  // Capped breeds wear their colour over the scalp and back, leaving the
  // muzzle, chest and belly white — filled inside a clip of the whole mass.
  if (breed.face === 'capped') {
    sc.save()
    sc.beginPath()
    bodyParts()
    sc.clip()
    sc.fillStyle = col
    sc.beginPath()
    sc.moveTo(X(100), Y(31))
    sc.bezierCurveTo(X(89), Y(37), X(80), Y(39), X(73), Y(37)) // under the eye
    sc.bezierCurveTo(X(60), Y(33), X(46), Y(40), X(36), Y(44)) // over the shoulder
    sc.bezierCurveTo(X(26), Y(48), X(14), Y(52), X(2), Y(56)) // down the back
    sc.lineTo(X(-10), Y(-20))
    sc.lineTo(X(110), Y(-20))
    sc.closePath()
    sc.fill()
    sc.restore()
  } else if (breed.muzzle) {
    // solid breeds get a light muzzle patch on the snout
    sc.fillStyle = rgb(breed.muzzle)
    sc.beginPath()
    sc.ellipse(X(88), Y(41), U * 8.5, U * 6, 0, 0, Math.PI * 2)
    sc.fill()
  }

  // The German-shepherd-style saddle: a dark blanket over the back, clipped to
  // the body so it hugs the silhouette. THE unmistakable GSD signal.
  if (breed.saddle) {
    sc.save()
    sc.beginPath()
    bodyParts()
    sc.clip()
    sc.fillStyle = rgb(breed.saddle)
    sc.beginPath()
    sc.ellipse(X(28), Y(44), U * 25, U * 11, -0.08, 0, Math.PI * 2)
    sc.fill()
    sc.restore()
  }

  // Pug-style dark mask right on the snout.
  if (breed.mask) {
    sc.fillStyle = rgb(breed.mask)
    sc.beginPath()
    sc.ellipse(X(91), Y(38), U * 7, U * 6, -0.2, 0, Math.PI * 2)
    sc.fill()
  }

  // -- near legs, on top of the belly line ----------------------------------
  leg(46, 62, 1, base)
  leg(14, 62, -1, base)

  // -- the ear, big and flapping with the run (some breeds' ears have their
  // own colour, e.g. the shepherd's black ears on a tan head) ----------------
  const earCol = breed.earColor ? rgb(breed.earColor) : col
  sc.save()
  sc.translate(X(62), Y(13))
  sc.rotate(swing * 0.1)
  sc.beginPath()
  if (breed.ear === 'perky') {
    sc.moveTo(U * -7, U * 5)
    sc.lineTo(U * 0, U * -13)
    sc.lineTo(U * 12, U * 0)
    sc.closePath()
  } else if (breed.ear === 'floppy') {
    sc.ellipse(U * -3, U * 10, U * 6.5, U * 11, 0.35, 0, Math.PI * 2)
  } else if (breed.ear === 'drop') {
    // long spaniel/beagle ears, hanging right down the side of the head
    sc.ellipse(U * -4, U * 14, U * 6, U * 14, 0.25, 0, Math.PI * 2)
  } else {
    sc.arc(U * -1, U * -2, U * 8, 0, Math.PI * 2)
  }
  sc.fillStyle = earCol
  sc.fill()
  sc.strokeStyle = ink
  sc.lineWidth = rim
  sc.stroke()
  sc.restore()

  // -- markings --------------------------------------------------------------
  if (breed.spots) {
    sc.fillStyle = rgb(breed.spots)
    for (const [px, py, pr] of [[75, 25, 5.5], [26, 44, 4.5], [42, 52, 3.2]]) {
      sc.beginPath()
      sc.arc(X(px), Y(py), U * pr, 0, Math.PI * 2)
      sc.fill()
    }
  }
  if (breed.brows) {
    sc.fillStyle = rgb(breed.brows)
    sc.beginPath()
    sc.arc(X(76), Y(breed.face === 'capped' ? 17 : 20), U * 2.4, 0, Math.PI * 2)
    sc.fill()
  }

  // -- the face ---------------------------------------------------------------
  if (expr.eyes === 'happy') {
    sc.strokeStyle = dark
    sc.lineWidth = Math.max(1.4, U * 2.2)
    sc.lineCap = 'round'
    sc.beginPath()
    sc.arc(X(75), Y(28), U * 3.8, Math.PI * 1.15, Math.PI * 1.85)
    sc.stroke()
  } else {
    const eyeR = Math.max(1.7, U * 3)
    sc.fillStyle = dark
    sc.beginPath()
    sc.arc(X(75), Y(27), eyeR, 0, Math.PI * 2)
    sc.fill()
    sc.fillStyle = '#fff'
    sc.beginPath()
    sc.arc(X(75) - eyeR * 0.3, Y(27) - eyeR * 0.35, eyeR * 0.35, 0, Math.PI * 2)
    sc.fill()
  }

  // nose on the snout tip
  sc.fillStyle = dark
  sc.beginPath()
  sc.ellipse(X(95), Y(36.5), U * 2.8, U * 2.2, 0, 0, Math.PI * 2)
  sc.fill()

  // mouth: a little smile on the muzzle, or open with a tongue
  if (expr.mouth === 'open') {
    sc.fillStyle = '#5a3833'
    sc.beginPath()
    sc.moveTo(X(85), Y(43))
    sc.quadraticCurveTo(X(90), Y(49.5), X(94.5), Y(43))
    sc.closePath()
    sc.fill()
    sc.fillStyle = '#f27d93'
    sc.beginPath()
    sc.ellipse(X(90), Y(45.5), U * 2.4, U * 1.8, 0, 0, Math.PI * 2)
    sc.fill()
  } else {
    sc.strokeStyle = dark
    sc.lineWidth = Math.max(1.2, U * 1.7)
    sc.lineCap = 'round'
    sc.beginPath()
    sc.moveTo(X(86), Y(43.5))
    sc.quadraticCurveTo(X(90), Y(46.5), X(94), Y(42.5))
    sc.stroke()
  }

  // blush on the cheek — the sticker signature
  sc.fillStyle = 'rgba(247,143,160,0.68)'
  sc.beginPath()
  sc.ellipse(X(74), Y(36), U * 4.2, U * 2.8, 0, 0, Math.PI * 2)
  sc.fill()

  // -- stamp the outline and blit --------------------------------------------
  // Tint a copy of the sprite pure ink, draw it at 8 offsets under the sprite:
  // a uniform border around the union of every part.
  tc.setTransform(1, 0, 0, 1, 0, 0)
  tc.clearRect(0, 0, SW, SH)
  tc.drawImage(s, 0, 0)
  tc.globalCompositeOperation = 'source-in'
  tc.fillStyle = ink
  tc.fillRect(0, 0, SW, SH)
  tc.globalCompositeOperation = 'source-over'

  const o = Math.max(1.2, U * 2.4)
  for (const [dx, dy] of [[o, 0], [-o, 0], [0, o], [0, -o], [o * 0.7, o * 0.7], [-o * 0.7, o * 0.7], [o * 0.7, -o * 0.7], [-o * 0.7, -o * 0.7]]) {
    ctx.drawImage(t, -SW / 2 + dx, -SH / 2 + dy)
  }
  ctx.drawImage(s, -SW / 2, -SH / 2)
}

// --- The painted backdrop ----------------------------------------------------
// A cosy little world behind the sand: pastel sky, a soft sun, drifting-still
// clouds, faint paw prints, and a scalloped meadow strip at the bottom that
// the sand slowly buries. Painted once into an offscreen canvas and blitted
// each frame (cheaper than clearing + CSS shows nothing through opaque sand).
let BG = null
function getBackground() {
  if (BG) return BG
  BG = document.createElement('canvas')
  BG.width = VIEW_W
  BG.height = VIEW_H
  const g = BG.getContext('2d')

  // sky
  const grad = g.createLinearGradient(0, 0, 0, VIEW_H)
  grad.addColorStop(0, '#d9ecff')
  grad.addColorStop(0.55, '#eef7ff')
  grad.addColorStop(1, '#d8f3e3')
  g.fillStyle = grad
  g.fillRect(0, 0, VIEW_W, VIEW_H)

  // a soft sun with a halo, tucked into the top-left (the score chip lives on
  // the right)
  g.fillStyle = 'rgba(255,214,140,0.35)'
  g.beginPath()
  g.arc(58, 62, 40, 0, Math.PI * 2)
  g.fill()
  g.fillStyle = '#ffd98f'
  g.beginPath()
  g.arc(58, 62, 24, 0, Math.PI * 2)
  g.fill()

  // fluffy clouds: three overlapping puffs each
  const cloud = (x, y, s) => {
    g.beginPath()
    g.arc(x, y, 16 * s, 0, Math.PI * 2)
    g.arc(x + 18 * s, y - 7 * s, 13 * s, 0, Math.PI * 2)
    g.arc(x + 34 * s, y + 1 * s, 15 * s, 0, Math.PI * 2)
    g.fill()
  }
  g.fillStyle = 'rgba(255,255,255,0.88)'
  cloud(150, 70, 1.1)
  cloud(280, 130, 0.85)
  cloud(60, 190, 0.7)
  cloud(230, 250, 0.65)
  g.fillStyle = 'rgba(255,255,255,0.6)'
  cloud(320, 330, 0.55)

  // faint paw prints wandering up the middle of the sky
  const paw = (x, y, s, rot) => {
    g.save()
    g.translate(x, y)
    g.rotate(rot)
    g.beginPath()
    g.ellipse(0, 0, 5 * s, 4 * s, 0, 0, Math.PI * 2) // main pad
    g.fill()
    for (const [dx, dy] of [[-5, -6], [0, -8], [5, -6]]) {
      g.beginPath()
      g.arc(dx * s, dy * s, 2 * s, 0, Math.PI * 2)
      g.fill()
    }
    g.restore()
  }
  g.fillStyle = 'rgba(240,150,170,0.16)'
  const steps = [[120, 480, -0.2], [160, 430, 0.15], [130, 380, -0.15], [175, 330, 0.2], [145, 285, -0.1]]
  for (const [x, y, r] of steps) paw(x, y, 1.15, r)

  // the meadow strip: scalloped grass bumps along the very bottom, with tiny
  // flowers — the first rows of sand will slowly bury it, which is the charm
  g.fillStyle = '#c5ead2'
  g.beginPath()
  g.moveTo(0, VIEW_H)
  for (let x = 0; x <= VIEW_W; x += 36) {
    g.quadraticCurveTo(x + 18, VIEW_H - 22, x + 36, VIEW_H - 8)
  }
  g.lineTo(VIEW_W, VIEW_H)
  g.closePath()
  g.fill()
  const flowers = [[40, 12, '#f6a8bd'], [130, 8, '#fff'], [215, 13, '#f6c98f'], [305, 9, '#f6a8bd']]
  for (const [x, up, c] of flowers) {
    g.fillStyle = c
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2
      g.beginPath()
      g.arc(x + Math.cos(a) * 3, VIEW_H - up + Math.sin(a) * 3, 2, 0, Math.PI * 2)
      g.fill()
    }
    g.fillStyle = '#ffe9a8'
    g.beginPath()
    g.arc(x, VIEW_H - up, 1.8, 0, Math.PI * 2)
    g.fill()
  }

  return BG
}
