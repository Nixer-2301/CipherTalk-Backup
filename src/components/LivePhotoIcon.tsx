import React from 'react'

interface LivePhotoIconProps {
  size?: number | string
  className?: string
  style?: React.CSSProperties
}

const OUTER_DOT_COUNT = 36
const OUTER_DOT_RADIUS = 2.5
const OUTER_RING_RADIUS = 56
const OUTER_DOTS = Array.from({ length: OUTER_DOT_COUNT }, (_, index) => {
  const angle = (index / OUTER_DOT_COUNT) * Math.PI * 2 - Math.PI / 2
  return {
    cx: 60 + Math.cos(angle) * OUTER_RING_RADIUS,
    cy: 60 + Math.sin(angle) * OUTER_RING_RADIUS,
  }
})

export const LivePhotoIcon: React.FC<LivePhotoIconProps> = ({ size = 24, className = '', style = {} }) => {
  return (
    <svg
      aria-hidden="true"
      className={className}
      focusable="false"
      height={size}
      style={style}
      viewBox="0 0 120 120"
      width={size}
      xmlns="http://www.w3.org/2000/svg"
    >
      <g fill="currentColor">
        {OUTER_DOTS.map((dot, index) => (
          <circle key={index} cx={dot.cx} cy={dot.cy} r={OUTER_DOT_RADIUS} />
        ))}
      </g>
      <circle cx="60" cy="60" fill="none" r="39" stroke="currentColor" strokeWidth="6" />
      <circle cx="60" cy="60" fill="none" r="16.5" stroke="currentColor" strokeWidth="11" />
    </svg>
  )
}
