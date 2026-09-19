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

export function IconCursor({ size = 16 }: IconProps) {
  return svg(size, <path d="M5 3l14 8-6 1.5L11 19z" />);
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

export function IconFit({ size = 15 }: IconProps) {
  return svg(size, <path d="M4 9V5h4M20 9V5h-4M4 15v4h4M20 15v4h-4" />);
}

export function IconBolt({ size = 11 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M13 2 4 14h6l-1 8 9-12h-6z" />
    </svg>
  );
}
