/**
 * GIRTool logo — borehole column with a CPT trace and probe-tip marker.
 *
 * Inline SVG so it scales crisply at any size and so the white strata
 * blocks pick up the dark sidebar background through the `opacity`
 * channel (no PNG fallbacks needed).
 *
 * Usage:  <Logo size={28} />
 */
export default function Logo({ size = 28, className = '' }) {
  return (
    <svg
      viewBox="0 0 100 100"
      width={size}
      height={size}
      className={className}
      xmlns="http://www.w3.org/2000/svg"
      aria-label="GIRTool"
    >
      {/* Soil strata layers (borehole column) */}
      <rect x="22" y="15" width="14" height="18" rx="2" fill="#FFFFFF" opacity="0.4" />
      <rect x="22" y="37" width="14" height="24" rx="2" fill="#FFFFFF" opacity="0.7" />
      <rect x="22" y="65" width="14" height="20" rx="2" fill="#FFFFFF" />

      {/* CPT continuous curve */}
      <path
        d="M 44 20 Q 56 30 48 45 T 78 62 T 55 78 T 78 85"
        fill="none"
        stroke="#00D2C4"
        strokeWidth="5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {/* Probe tip indicator */}
      <circle cx="78" cy="85" r="5.5" fill="#00D2C4" stroke="#0B213F" strokeWidth="1.5" />
    </svg>
  )
}
