import React from 'react';

interface IconProps {
  size?: number;
}

const baseProps = (size: number) => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.85,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true as const,
  style: { flexShrink: 0 },
});

export function IconBookmark({ size = 18 }: IconProps) {
  return (
    <svg {...baseProps(size)}>
      <path d="M6 4h12a1 1 0 0 1 1 1v15l-7-4-7 4V5a1 1 0 0 1 1-1z" />
    </svg>
  );
}

export function IconShield({ size = 18 }: IconProps) {
  return (
    <svg {...baseProps(size)}>
      <path d="M12 3l7 3v6c0 4.5-3 7.8-7 9-4-1.2-7-4.5-7-9V6l7-3z" />
      <path d="M9.5 12l1.8 1.8L15 10" />
    </svg>
  );
}

export function IconSparkles({ size = 18 }: IconProps) {
  return (
    <svg {...baseProps(size)}>
      <path d="M12 3l1.8 4.8L18.5 9.5l-4.7 1.7L12 16l-1.8-4.8L5.5 9.5l4.7-1.7L12 3z" />
      <path d="M18.5 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8.8-2z" />
    </svg>
  );
}

export function IconSearch({ size = 16 }: IconProps) {
  return (
    <svg {...baseProps(size)}>
      <circle cx="11" cy="11" r="7" />
      <path d="M20 20l-3.5-3.5" />
    </svg>
  );
}

export function IconFolder({ size = 17 }: IconProps) {
  return (
    <svg {...baseProps(size)}>
      <path d="M3 6.5A1.5 1.5 0 0 1 4.5 5H9l2 2h8.5A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5v-11z" />
    </svg>
  );
}

export function IconClock({ size = 17 }: IconProps) {
  return (
    <svg {...baseProps(size)}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </svg>
  );
}

export function IconCopy({ size = 17 }: IconProps) {
  return (
    <svg {...baseProps(size)}>
      <rect x="9" y="9" width="11" height="11" rx="2" />
      <path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1" />
    </svg>
  );
}

export function IconTagOff({ size = 17 }: IconProps) {
  return (
    <svg {...baseProps(size)}>
      <path d="M4 12V6a2 2 0 0 1 2-2h6l8 8-6 6-8-8" />
      <circle cx="8.5" cy="8.5" r="1" />
    </svg>
  );
}

export function IconLinkOff({ size = 17 }: IconProps) {
  return (
    <svg {...baseProps(size)}>
      <path d="M9 15l6-6" />
      <path d="M11 6l1.5-1.5a3.5 3.5 0 0 1 5 5L16 11" />
      <path d="M13 18l-1.5 1.5a3.5 3.5 0 0 1-5-5L8 13" />
      <path d="M4 4l16 16" />
    </svg>
  );
}

export function IconGlobe({ size = 18 }: IconProps) {
  return (
    <svg {...baseProps(size)}>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17" />
      <path d="M12 3.5a12 12 0 0 1 0 17 12 12 0 0 1 0-17z" />
    </svg>
  );
}

export function IconHistory({ size = 18 }: IconProps) {
  return (
    <svg {...baseProps(size)}>
      <path d="M3 12a9 9 0 1 0 3-6.7L3 8" />
      <path d="M3 3v5h5" />
      <path d="M12 7v5l3 2" />
    </svg>
  );
}

export function IconDownload({ size = 16 }: IconProps) {
  return (
    <svg {...baseProps(size)}>
      <path d="M12 4v11" />
      <path d="M7.5 11.5L12 16l4.5-4.5" />
      <path d="M5 19h14" />
    </svg>
  );
}

export function IconSync({ size = 16 }: IconProps) {
  return (
    <svg {...baseProps(size)}>
      <path d="M20 11a8 8 0 0 0-14.5-4.5L3 9" />
      <path d="M3 4v5h5" />
      <path d="M4 13a8 8 0 0 0 14.5 4.5L21 15" />
      <path d="M21 20v-5h-5" />
    </svg>
  );
}

export function IconTerminal({ size = 18 }: IconProps) {
  return (
    <svg {...baseProps(size)}>
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M7.5 9.5L10.5 12l-3 2.5" />
      <path d="M12.5 14.5h4" />
    </svg>
  );
}

export function IconBolt({ size = 16 }: IconProps) {
  return (
    <svg {...baseProps(size)}>
      <path d="M13 2L4.5 13H12l-1 9 8.5-11H12l1-9z" />
    </svg>
  );
}

export function IconTrash({ size = 14 }: IconProps) {
  return (
    <svg {...baseProps(size)}>
      <path d="M4 7h16" />
      <path d="M9 4h6" />
      <path d="M6 7l1 13h10l1-13" />
    </svg>
  );
}
