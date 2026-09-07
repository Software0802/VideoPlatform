/** 智能体视图用到的内联图标（lucide 风格线性图标，默认 17px）。 */
import type { ReactElement } from "react";

type IconProps = { size?: number };

type StrokeProps = {
  fill: "none";
  stroke: "currentColor";
  strokeWidth: number;
  strokeLinecap: "round";
  strokeLinejoin: "round";
};

function line(width = 1.7): StrokeProps {
  return {
    fill: "none",
    stroke: "currentColor",
    strokeWidth: width,
    strokeLinecap: "round",
    strokeLinejoin: "round",
  };
}

function svg(size: number, children: ReactElement, w = 1.7): ReactElement {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" {...line(w)}>
      {children}
    </svg>
  );
}

export function IconPanelLeft({ size = 14 }: IconProps) {
  return svg(
    size,
    <>
      <rect x="3" y="4" width="18" height="16" rx="2" />
      <path d="M9 4v16" />
    </>,
  );
}

export function IconPlus({ size = 15 }: IconProps) {
  return svg(size, <path d="M12 5v14M5 12h14" />, 2);
}

export function IconLock({ size = 13 }: IconProps) {
  return svg(
    size,
    <>
      <path d="M8 11V6a4 4 0 0 1 8 0v5" />
      <rect x="5" y="11" width="14" height="9" rx="2" />
    </>,
  );
}

export function IconChevronDown({ size = 12 }: IconProps) {
  return svg(size, <path d="m6 9 6 6 6-6" />, 2);
}

export function IconChevronRight({ size = 13 }: IconProps) {
  return svg(size, <path d="m9 6 6 6-6 6" />, 2);
}

export function IconChevronLeft({ size = 15 }: IconProps) {
  return svg(size, <path d="m14 6-6 6 6 6" />, 2);
}

export function IconSkill({ size = 14 }: IconProps) {
  return svg(
    size,
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M12 4v3M12 17v3M4 12h3M17 12h3" />
    </>,
  );
}

export function IconList({ size = 14 }: IconProps) {
  return svg(size, <path d="M4 7h16M4 12h16M4 17h16" />);
}

export function IconArrowUp({ size = 14 }: IconProps) {
  return svg(
    size,
    <>
      <path d="m5 12 7-7 7 7" />
      <path d="M12 19V5" />
    </>,
    2.6,
  );
}

export function IconPencil({ size = 14 }: IconProps) {
  return svg(
    size,
    <>
      <path d="M4 20h5l11-11-5-5L4 15z" />
      <path d="M14 5l5 5" />
    </>,
  );
}

export function IconTrash({ size = 13 }: IconProps) {
  return svg(
    size,
    <>
      <path d="M4 7h16" />
      <path d="M10 11v6M14 11v6" />
      <path d="M6 7l1 13h10l1-13" />
      <path d="M9 7V4h6v3" />
    </>,
  );
}

export function IconX({ size = 14 }: IconProps) {
  return svg(size, <path d="M6 6l12 12M18 6 6 18" />, 2);
}

export function IconPlay({ size = 14 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

export function IconBolt({ size = 11 }: IconProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M13 2 4 14h6l-1 8 9-12h-6z" />
    </svg>
  );
}
