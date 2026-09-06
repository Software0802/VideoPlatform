/** 画布视图用到的内联图标（lucide 风格线性图标）。 */
import type { ReactElement } from "react";

type IconProps = { size?: number };

function svg(size: number, children: ReactElement, w = 1.7): ReactElement {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth={w}
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

export function IconText({ size = 14 }: IconProps) {
  return svg(size, <path d="M4 7h16M4 12h12M4 17h8" />, 1.8);
}

export function IconImage({ size = 14 }: IconProps) {
  return svg(
    size,
    <>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m6 16 4-4.5 3 3L16 11l2 3" />
      <circle cx="9" cy="9" r="1.2" />
    </>,
  );
}

export function IconVideo({ size = 14 }: IconProps) {
  return svg(
    size,
    <>
      <rect x="3" y="5" width="18" height="14" rx="3" />
      <path d="m11 10 4 2-4 2z" />
    </>,
  );
}

export function IconAudio({ size = 14 }: IconProps) {
  return svg(size, <path d="M5 12h2l2-5 2 10 2-8 2 6 2-3h2" />);
}

export function IconBoard({ size = 14 }: IconProps) {
  return svg(
    size,
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M3 12h18M12 4v16" />
    </>,
  );
}

export function IconCursor({ size = 16 }: IconProps) {
  return svg(size, <path d="M5 3l14 8-6 1.5L11 19z" />);
}

export function IconFolder({ size = 16 }: IconProps) {
  return svg(size, <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />);
}

export function IconToolbox({ size = 16 }: IconProps) {
  return svg(
    size,
    <>
      <rect x="3" y="7" width="18" height="12" rx="2" />
      <path d="M8 7V5h8v2" />
    </>,
  );
}

export function IconUndo({ size = 16 }: IconProps) {
  return svg(
    size,
    <>
      <path d="M9 14 4 9l5-5" />
      <path d="M4 9h9a6 6 0 0 1 0 12H8" />
    </>,
  );
}

export function IconRedo({ size = 16 }: IconProps) {
  return svg(
    size,
    <>
      <path d="m15 14 5-5-5-5" />
      <path d="M20 9h-9a6 6 0 0 0 0 12h5" />
    </>,
  );
}

export function IconPlus({ size = 19 }: IconProps) {
  return svg(size, <path d="M12 5v14M5 12h14" />, 2.2);
}

export function IconClose({ size = 15 }: IconProps) {
  return svg(size, <path d="M6 6l12 12M18 6 6 18" />, 2);
}

export function IconSearch({ size = 14 }: IconProps) {
  return svg(
    size,
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-4.3-4.3" />
    </>,
    1.8,
  );
}

export function IconFilter({ size = 15 }: IconProps) {
  return svg(size, <path d="M4 7h16M7 12h10M10 17h4" />, 1.8);
}

export function IconShare({ size = 14 }: IconProps) {
  return svg(
    size,
    <>
      <path d="M14 4h6v6" />
      <path d="M20 4 10 14" />
      <path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" />
    </>,
    1.8,
  );
}

export function IconBot({ size = 14 }: IconProps) {
  return svg(
    size,
    <>
      <rect x="4" y="8" width="16" height="12" rx="3" />
      <path d="M12 4v4M9 14h.01M15 14h.01" />
    </>,
    1.8,
  );
}

export function IconPanels({ size = 15 }: IconProps) {
  return svg(
    size,
    <>
      <rect x="3" y="4" width="7" height="16" rx="1.5" />
      <rect x="14" y="4" width="7" height="16" rx="1.5" />
    </>,
  );
}

export function IconFit({ size = 15 }: IconProps) {
  return svg(size, <path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4" />);
}

export function IconMinimap({ size = 15 }: IconProps) {
  return svg(
    size,
    <>
      <path d="m9 4 6 2 6-2v14l-6 2-6-2-6 2V6z" />
      <path d="M9 4v14M15 6v14" />
    </>,
  );
}

export function IconExpand({ size = 15 }: IconProps) {
  return svg(size, <path d="M15 4h5v5M9 20H4v-5M20 4l-6 6M4 20l6-6" />, 1.8);
}

export function IconVolume({ size = 13 }: IconProps) {
  return svg(
    size,
    <>
      <path d="M4 9v6h3l4 3V6L7 9z" />
      <path d="M16 9.5a3.5 3.5 0 0 1 0 5" />
    </>,
    1.8,
  );
}

export function IconArrowUp({ size = 13 }: IconProps) {
  return svg(
    size,
    <>
      <path d="m5 12 7-7 7 7" />
      <path d="M12 19V5" />
    </>,
    2.6,
  );
}

export function IconGrid9({ size = 15 }: IconProps) {
  return svg(
    size,
    <>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <path d="M9 3v18M15 3v18M3 9h18M3 15h18" />
    </>,
  );
}

export function IconFace({ size = 15 }: IconProps) {
  return svg(
    size,
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M9 10h.01M15 10h.01M9 15c1.8 1.4 4.2 1.4 6 0" />
    </>,
  );
}

export function IconPointer({ size = 12 }: IconProps) {
  return svg(size, <path d="M5 3l14 8-6 1.5L11 19z" />, 1.8);
}

export function IconBolt({ size = 11 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M13 2 4 14h6l-1 8 9-12h-6z" />
    </svg>
  );
}

export function IconPlay({ size = 10 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="#fff" aria-hidden="true">
      <path d="m8 5 11 7-11 7z" />
    </svg>
  );
}
