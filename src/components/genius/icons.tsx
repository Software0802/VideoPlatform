/*
  Genius App 的图标集：交接包里全部是 lucide 风格的内联线性图标，路径逐字取自
  `design_handoff/design_handoff_genius_app/Genius App.dc.html`。不引图标库（AGENTS.md），
  所以收在这一个文件里，`size` 只改 width/height，颜色一律 `currentColor`。
*/

type IconProps = { size?: number; className?: string };

const stroke = {
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.7,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
};

function Svg({ size = 17, className, children }: IconProps & { children: React.ReactNode }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

/* ── 侧栏导航（17px 线性） ── */

export const IconHome = (p: IconProps) => (
  <Svg {...p}>
    <g {...stroke}>
      <path d="M3 9.5 12 3l9 6.5V20a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z" />
      <path d="M9 21v-7h6v7" />
    </g>
  </Svg>
);

export const IconCreate = (p: IconProps) => (
  <Svg {...p}>
    <g {...stroke}>
      <path d="M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4z" />
      <path d="M18.5 16.5l.7 2 2 .7-2 .7-.7 2-.7-2-2-.7 2-.7z" />
    </g>
  </Svg>
);

export const IconAgent = (p: IconProps) => (
  <Svg {...p}>
    <g {...stroke}>
      <rect x="4" y="8" width="16" height="12" rx="3" />
      <path d="M12 4v4M9 14h.01M15 14h.01M2 13v3M22 13v3" />
    </g>
  </Svg>
);

export const IconCanvas = (p: IconProps) => (
  <Svg {...p}>
    <g {...stroke}>
      <path d="M4 20 10.5 4l6.5 16" />
      <path d="M7 14h9" />
    </g>
  </Svg>
);

export const IconSub = (p: IconProps) => (
  <Svg {...p}>
    <g {...stroke}>
      <path d="M4 8h16l-8 12z" />
      <path d="M8 4h8l4 4H4z" />
    </g>
  </Svg>
);

/* ── 顶栏 ── */

export const IconTag = ({ size = 13, ...p }: IconProps) => (
  <Svg size={size} {...p}>
    <g {...stroke} strokeWidth={1.9}>
      <path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0l-7.2-7.2a2 2 0 0 1-.6-1.4V4a1 1 0 0 1 1-1h8a2 2 0 0 1 1.4.6l7.4 7.4a2 2 0 0 1 0 2.4z" />
      <path d="M7.5 7.5h.01" />
    </g>
  </Svg>
);

/** 积分闪电，实心填充（顶栏 12px / 创作按钮 11px） */
export const IconBolt = ({ size = 12, ...p }: IconProps) => (
  <Svg size={size} {...p}>
    <path d="M13 2 4 14h6l-1 8 9-12h-6z" fill="currentColor" />
  </Svg>
);

export const IconGlobe = (p: IconProps) => (
  <Svg {...p}>
    <g {...stroke}>
      <circle cx="12" cy="12" r="9" />
      <path d="M3 12h18M12 3c2.5 2.6 2.5 15.4 0 18M12 3c-2.5 2.6-2.5 15.4 0 18" />
    </g>
  </Svg>
);

export const IconBell = (p: IconProps) => (
  <Svg {...p}>
    <g {...stroke}>
      <path d="M18 15V10a6 6 0 1 0-12 0v5l-1.5 3h15z" />
      <path d="M10 21h4" />
    </g>
  </Svg>
);

/* ── 创作面板 / 输入条 ── */

export const IconImage = ({ size = 17, ...p }: IconProps) => (
  <Svg size={size} {...p}>
    <g {...stroke}>
      <rect x="3" y="4" width="18" height="16" rx="3" />
      <path d="m5 17 4.5-5 3.5 3.5L16 12l3 4" />
      <circle cx="9" cy="9.5" r="1.4" />
    </g>
  </Svg>
);

export const IconArrowUp = ({ size = 15, ...p }: IconProps) => (
  <Svg size={size} {...p}>
    <g {...stroke} strokeWidth={2.6}>
      <path d="m5 12 7-7 7 7" />
      <path d="M12 19V5" />
    </g>
  </Svg>
);

export const IconVideo = ({ size = 13, ...p }: IconProps) => (
  <Svg size={size} {...p}>
    <g {...stroke} strokeWidth={1.8}>
      <rect x="3" y="5" width="18" height="14" rx="3" />
      <path d="m11 10 4 2-4 2z" />
    </g>
  </Svg>
);

export const IconPicture = ({ size = 13, ...p }: IconProps) => (
  <Svg size={size} {...p}>
    <g {...stroke} strokeWidth={1.8}>
      <rect x="3" y="5" width="18" height="14" rx="2" />
      <path d="m6 16 4-4.5 3 3L16 11l2 3" />
    </g>
  </Svg>
);

export const IconAudio = ({ size = 13, ...p }: IconProps) => (
  <Svg size={size} {...p}>
    <g {...stroke} strokeWidth={1.8}>
      <path d="M9 18V6l10-2v12" />
      <circle cx="7" cy="18" r="2" />
      <circle cx="17" cy="16" r="2" />
    </g>
  </Svg>
);

/** 创作搭子（魔杖） */
export const IconWand = ({ size = 15, ...p }: IconProps) => (
  <Svg size={size} {...p}>
    <g {...stroke}>
      <path d="M4 20h5l11-11-5-5L4 15z" />
      <path d="M14 5l5 5" />
    </g>
  </Svg>
);

/** 清空（扫帚） */
export const IconBroom = ({ size = 15, ...p }: IconProps) => (
  <Svg size={size} {...p}>
    <g {...stroke}>
      <path d="M4 20h6l10-10-6-6L4 14z" />
      <path d="M14 4l6 6" />
    </g>
  </Svg>
);

export const IconChevron = ({ size = 15, ...p }: IconProps) => (
  <Svg size={size} {...p}>
    <path {...stroke} strokeWidth={2} d="m6 9 6 6 6-6" />
  </Svg>
);

export const IconClose = ({ size = 15, ...p }: IconProps) => (
  <Svg size={size} {...p}>
    <path {...stroke} strokeWidth={2} d="M6 6l12 12M18 6 6 18" />
  </Svg>
);

/** 配置面板（三横线） */
export const IconSliders = ({ size = 13, ...p }: IconProps) => (
  <Svg size={size} {...p}>
    <path {...stroke} strokeWidth={1.8} d="M4 7h16M4 12h16M4 17h16" />
  </Svg>
);

/** 首尾帧两槽之间的三角 */
export const IconPlay = ({ size = 14, ...p }: IconProps) => (
  <Svg size={size} {...p}>
    <path d="m8 5 9 7-9 7z" fill="currentColor" />
  </Svg>
);

/** 瀑布流卡片左上角标题胶囊里的星 */
export const IconStar = ({ size = 11, ...p }: IconProps) => (
  <Svg size={size} {...p}>
    <path d="M12 3l1.9 5.6L19.5 10l-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.4z" fill="currentColor" />
  </Svg>
);

export const IconUpload = ({ size = 20, ...p }: IconProps) => (
  <Svg size={size} {...p}>
    <g {...stroke} strokeWidth={1.8}>
      <path d="M12 19V5" />
      <path d="m6 11 6-6 6 6" />
    </g>
  </Svg>
);

/* ── 阶段 B：作品详情操作 / 账户菜单 ── */

export const IconTrash = ({ size = 14, ...p }: IconProps) => (
  <Svg size={size} {...p}>
    <g {...stroke}>
      <path d="M4 7h16M10 7V5h4v2M6 7l1 13h10l1-13" />
      <path d="M10 11v6M14 11v6" />
    </g>
  </Svg>
);

export const IconShare = ({ size = 14, ...p }: IconProps) => (
  <Svg size={size} {...p}>
    <g {...stroke}>
      <circle cx="18" cy="5.5" r="2.5" />
      <circle cx="6" cy="12" r="2.5" />
      <circle cx="18" cy="18.5" r="2.5" />
      <path d="m8.3 10.8 7.4-4M8.3 13.2l7.4 4" />
    </g>
  </Svg>
);

/** 修改密码（钥匙） */
export const IconKey = ({ size = 14, ...p }: IconProps) => (
  <Svg size={size} {...p}>
    <g {...stroke}>
      <circle cx="8" cy="8" r="4" />
      <path d="m11 11 8 8M16 16l-2 2M19 13l-2 2" />
    </g>
  </Svg>
);

export const IconCheck = ({ size = 12, ...p }: IconProps) => (
  <Svg size={size} {...p}>
    <path {...stroke} strokeWidth={2.2} d="m5 13 4 4L19 7" />
  </Svg>
);

export const IconLogout = ({ size = 14, ...p }: IconProps) => (
  <Svg size={size} {...p}>
    <g {...stroke}>
      <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
      <path d="m16 17 5-5-5-5M21 12H9" />
    </g>
  </Svg>
);
