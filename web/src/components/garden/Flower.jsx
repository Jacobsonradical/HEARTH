import React from 'react'

// Hand-drawn pastel flowers for the garden. Each kind is a small SVG anchored
// at its stem base, so it can be planted straight onto the hill. Petals are
// simple ellipses/paths — soft shapes, no hard outlines, sweet colors.

// A shared thin stem with two little leaves.
function Stem({ h = 46 }) {
  const top = 88 - h
  return (
    <g>
      <path
        d={`M20 88 C 20 ${88 - h / 3}, 20 ${88 - h / 2}, 20 ${top}`}
        stroke="#7fb069"
        strokeWidth="2.4"
        fill="none"
        strokeLinecap="round"
      />
      <path d={`M20 ${88 - h / 2.6} q -9 -7 -13 -1 q 6 7 13 1`} fill="#8fc177" />
      <path d={`M20 ${88 - h / 1.8} q 9 -7 13 -1 q -6 7 -13 1`} fill="#8fc177" />
    </g>
  )
}

// Daisy: white petals around a warm yellow heart.
function Daisy() {
  const petals = []
  for (let i = 0; i < 8; i++) {
    petals.push(
      <ellipse key={i} cx="20" cy="30" rx="4.6" ry="11"
        fill="#fffdf7" transform={`rotate(${i * 45} 20 39)`} />,
    )
  }
  return (
    <g>
      <Stem h={44} />
      {petals}
      <circle cx="20" cy="39" r="6.5" fill="#ffd166" />
      <circle cx="18" cy="37" r="2" fill="#ffe3a1" />
    </g>
  )
}

// Tulip: a soft pink cup on a tall stem.
function Tulip() {
  return (
    <g>
      <Stem h={48} />
      <path d="M11 42 C 10 28, 16 24, 20 31 C 24 24, 30 28, 29 42 C 27 49, 13 49, 11 42 Z" fill="#ffa8c0" />
      <path d="M16 40 C 15 30, 19 27, 20 33 C 21 27, 25 30, 24 40 Z" fill="#ffc2d4" />
    </g>
  )
}

// Bellflower: a lavender bell nodding gently to one side.
function Bell() {
  return (
    <g>
      <Stem h={50} />
      <path
        d="M20 38 C 11 38, 10 30, 13 26 C 16 22, 24 22, 27 26 C 30 30, 29 38, 20 38 Z"
        fill="#c3b1e1"
        transform="rotate(14 20 30)"
      />
      <path d="M14 37 q 2 4 3 5 M20 38 q 0 4 0 6 M26 37 q -2 4 -3 5"
        stroke="#c3b1e1" strokeWidth="2" strokeLinecap="round" fill="none"
        transform="rotate(14 20 30)" />
    </g>
  )
}

// Little rose: layered rounds of pink.
function Rose() {
  return (
    <g>
      <Stem h={42} />
      <circle cx="20" cy="38" r="11" fill="#f795a8" />
      <circle cx="20" cy="38" r="7.5" fill="#fbaebd" />
      <circle cx="20" cy="38" r="4.4" fill="#fdc6d1" />
      <path d="M20 34 a 4.4 4.4 0 0 1 0 8" stroke="#f795a8" strokeWidth="1.4" fill="none" />
    </g>
  )
}

// Forget-me-not: five round sky-blue petals, tiny and dear.
function ForgetMeNot() {
  const petals = []
  for (let i = 0; i < 5; i++) {
    petals.push(
      <circle key={i} cx="20" cy="34" r="5.2"
        fill="#a5c9f2" transform={`rotate(${i * 72} 20 40)`} />,
    )
  }
  return (
    <g>
      <Stem h={40} />
      {petals}
      <circle cx="20" cy="40" r="3.4" fill="#ffe08a" />
    </g>
  )
}

// Sunflower: golden petals, cocoa heart — planted in the earth where it belongs.
function Sunflower() {
  const petals = []
  for (let i = 0; i < 12; i++) {
    petals.push(
      <ellipse key={i} cx="20" cy="26" rx="3.6" ry="10"
        fill="#ffc94d" transform={`rotate(${i * 30} 20 36)`} />,
    )
  }
  return (
    <g>
      <Stem h={52} />
      {petals}
      <circle cx="20" cy="36" r="7.2" fill="#8a5a33" />
      <circle cx="20" cy="36" r="4.6" fill="#6f4426" />
    </g>
  )
}

// The varieties in the order they join the garden as it grows.
const KINDS = [Daisy, Tulip, ForgetMeNot, Bell, Rose, Sunflower]

export default function Flower({ kind, size = 1, sway = 0 }) {
  const Petals = KINDS[kind % KINDS.length]
  return (
    <svg
      className="flower-svg"
      viewBox="0 0 40 90"
      style={{
        width: 40 * size + 'px',
        height: 90 * size + 'px',
        animationDelay: sway + 's',
      }}
      aria-hidden="true"
    >
      <Petals />
    </svg>
  )
}
