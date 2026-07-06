import React from 'react'

// The couple's tree, drawn by stage (0 seed .. 6 grand tree) with foliage that
// follows the season. Anchored bottom-center so it stands on the hill.

// Foliage palettes per season: [main, light, dark] greens (or autumn golds).
const LEAF = {
  spring: ['#a4d791', '#bfe3ae', '#8cc47a'],
  summer: ['#7cbb72', '#98cc8e', '#66a85e'],
  autumn: ['#e8a35c', '#f0bc7d', '#d97f4e'],
  winter: ['#b8ccc2', '#ccdcd4', '#a3b8ae'],
}

const TRUNK = '#8a6248'
const BLOSSOM = '#ffb7ce'

// Blossom dots sprinkled over the canopy at the blossoming/grand stages.
function Blossoms({ spots }) {
  return (
    <g>
      {spots.map(([x, y, r], i) => (
        <circle key={i} cx={x} cy={y} r={r} fill={BLOSSOM} opacity="0.9" />
      ))}
    </g>
  )
}

// Snow caps resting on the canopy in winter.
function SnowCaps({ spots }) {
  return (
    <g>
      {spots.map(([x, y, rx], i) => (
        <ellipse key={i} cx={x} cy={y} rx={rx} ry={rx * 0.38} fill="#ffffff" opacity="0.85" />
      ))}
    </g>
  )
}

export default function Tree({ stage, season = 'summer' }) {
  const [leaf, leafLight, leafDark] = LEAF[season] || LEAF.summer
  const winter = season === 'winter'

  return (
    <svg className="tree-svg" viewBox="0 0 200 220" aria-hidden="true">
      {stage === 0 && (
        // A seed tucked into a little mound of earth, dreaming.
        <g>
          <ellipse cx="100" cy="210" rx="26" ry="9" fill="#b98d68" />
          <ellipse cx="100" cy="204" rx="9" ry="11" fill="#9c6b44" />
          <path d="M100 196 q 5 -8 12 -9" stroke="#8fc177" strokeWidth="2.5" fill="none" strokeLinecap="round" />
        </g>
      )}

      {stage === 1 && (
        // A sprout: one brave stem, two leaves.
        <g>
          <path d="M100 212 C 100 196, 100 186, 100 176" stroke="#7fb069" strokeWidth="4" fill="none" strokeLinecap="round" />
          <path d="M100 188 q -16 -12 -24 -2 q 11 12 24 2" fill={leaf} />
          <path d="M100 180 q 16 -12 24 -2 q -11 12 -24 2" fill={leafLight} />
        </g>
      )}

      {stage === 2 && (
        // A seedling finding its shape.
        <g>
          <path d="M100 212 C 100 190, 100 172, 100 152" stroke="#79a862" strokeWidth="5.5" fill="none" strokeLinecap="round" />
          <path d="M100 192 q -18 -13 -27 -3 q 12 13 27 3" fill={leaf} />
          <path d="M100 178 q 18 -13 27 -3 q -12 13 -27 3" fill={leafLight} />
          <path d="M100 164 q -16 -12 -24 -2 q 11 12 24 2" fill={leafDark} />
          <ellipse cx="100" cy="146" rx="12" ry="14" fill={leaf} />
        </g>
      )}

      {stage >= 3 && (
        // A real trunk from here on, thickening with age.
        <g>
          <path
            d={
              stage === 3
                ? 'M96 212 C 97 180, 98 160, 100 140 C 102 160, 103 180, 104 212 Z'
                : stage === 4
                  ? 'M93 212 C 95 175, 96 150, 100 126 C 104 150, 105 175, 107 212 Z'
                  : 'M89 212 C 92 170, 94 145, 100 114 C 106 145, 108 170, 111 212 Z'
            }
            fill={TRUNK}
          />
          {/* Branches emerge as the tree matures. */}
          {stage >= 4 && (
            <path d="M100 150 C 88 138, 76 132, 66 130 M100 142 C 112 130, 124 124, 136 124"
              stroke={TRUNK} strokeWidth={stage >= 5 ? 7 : 5} fill="none" strokeLinecap="round" />
          )}
          {/* At the grand stage the trunk carries a little carved heart. */}
          {stage === 6 && (
            <path
              d="M100 176 c -2.6 -4.6 -9 -3 -9 1.6 c 0 3.6 5 7 9 10 c 4 -3 9 -6.4 9 -10 c 0 -4.6 -6.4 -6.2 -9 -1.6 Z"
              fill="#6f4a33"
            />
          )}
        </g>
      )}

      {stage === 3 && (
        <g>
          <circle cx="100" cy="118" r="30" fill={leaf} />
          <circle cx="82" cy="128" r="20" fill={leafDark} />
          <circle cx="118" cy="126" r="21" fill={leafLight} />
          {winter && <SnowCaps spots={[[100, 92, 22], [80, 116, 12]]} />}
        </g>
      )}

      {stage === 4 && (
        <g>
          <circle cx="66" cy="118" r="24" fill={leafDark} />
          <circle cx="136" cy="112" r="26" fill={leafLight} />
          <circle cx="100" cy="92" r="36" fill={leaf} />
          <circle cx="100" cy="116" r="28" fill={leaf} />
          {winter && <SnowCaps spots={[[100, 60, 26], [66, 100, 14], [136, 92, 15]]} />}
        </g>
      )}

      {stage >= 5 && (
        <g>
          <circle cx="56" cy="112" r="27" fill={leafDark} />
          <circle cx="144" cy="106" r="29" fill={leafDark} />
          <circle cx="76" cy="82" r="30" fill={leaf} />
          <circle cx="124" cy="78" r="31" fill={leaf} />
          <circle cx="100" cy="60" r={stage === 6 ? 36 : 32} fill={leafLight} />
          <circle cx="100" cy="96" r="34" fill={leaf} />
          {stage === 6 && <circle cx="100" cy="44" r="24" fill={leafLight} />}
          {!winter && (
            <Blossoms
              spots={
                stage === 6
                  ? [[70, 70, 4], [130, 66, 4.5], [100, 40, 4], [88, 96, 3.6], [148, 96, 3.6], [56, 104, 3.4], [114, 84, 3.2]]
                  : [[74, 74, 4], [126, 70, 4], [98, 52, 3.6], [110, 92, 3.2]]
              }
            />
          )}
          {winter && <SnowCaps spots={[[100, 28, 26], [70, 58, 16], [130, 52, 17], [50, 90, 12], [150, 82, 12]]} />}
        </g>
      )}
    </svg>
  )
}
