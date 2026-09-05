/* @ds-bundle: {"format":4,"namespace":"MonoColorDesignSystem_73ec79","components":[{"name":"CarrierBadge","sourcePath":"components/information/CarrierBadge.jsx"},{"name":"RuledDataStrip","sourcePath":"components/information/RuledDataStrip.jsx"},{"name":"PlateBadge","sourcePath":"components/marks/PlateBadge.jsx"},{"name":"RegistrationMark","sourcePath":"components/marks/RegistrationMark.jsx"},{"name":"SectionRule","sourcePath":"components/marks/SectionRule.jsx"},{"name":"HalftoneField","sourcePath":"components/plate/HalftoneField.jsx"},{"name":"InkPair","sourcePath":"components/plate/InkPair.jsx"},{"name":"InkSwatch","sourcePath":"components/plate/InkSwatch.jsx"},{"name":"PaperSheet","sourcePath":"components/plate/PaperSheet.jsx"},{"name":"CompositionThumb","sourcePath":"components/poster/CompositionThumb.jsx"},{"name":"PosterSheet","sourcePath":"components/poster/PosterSheet.jsx"},{"name":"DisplayHeading","sourcePath":"components/type/DisplayHeading.jsx"},{"name":"MicroLabel","sourcePath":"components/type/MicroLabel.jsx"},{"name":"SpecimenCaption","sourcePath":"components/type/SpecimenCaption.jsx"}],"sourceHashes":{"components/information/CarrierBadge.jsx":"f6d8fe9b291a","components/information/RuledDataStrip.jsx":"8fe0f512c1b4","components/marks/PlateBadge.jsx":"0d058c13ecef","components/marks/RegistrationMark.jsx":"d0679c7a698c","components/marks/SectionRule.jsx":"8cfb35ef6344","components/plate/HalftoneField.jsx":"8276bfddb4bb","components/plate/InkPair.jsx":"2cd4b54e3dbd","components/plate/InkSwatch.jsx":"a9c1bead815b","components/plate/PaperSheet.jsx":"dda6cdbb257a","components/poster/CompositionThumb.jsx":"b45a6d191cf2","components/poster/PosterSheet.jsx":"b64027161568","components/type/DisplayHeading.jsx":"b3d7fb13e8ba","components/type/MicroLabel.jsx":"1ae6ee1e6f5a","components/type/SpecimenCaption.jsx":"8dd2c4e3e60f","ui_kits/printed-artifacts/OnePosterFive.jsx":"10244b847dd6","ui_kits/printed-artifacts/PressControls.jsx":"0e35d5373737","ui_kits/reference-board/Board.jsx":"788095641a21","ui_kits/reference-board/BoardPrimitives.jsx":"76d6e4d9c025","ui_kits/reference-board/CompositionGrammar.jsx":"56d354b5a02d","ui_kits/reference-board/InkLibrary.jsx":"1818bf099339","ui_kits/reference-board/PhysicalCarriers.jsx":"fd7056dfbac7","ui_kits/reference-board/TypographicRoles.jsx":"adedd355cbc9","ui_kits/reference-board/data.js":"6b531fa28bd1"},"inlinedExternals":[],"unexposedExports":[]} */

(() => {

const __ds_ns = (window.MonoColorDesignSystem_73ec79 = window.MonoColorDesignSystem_73ec79 || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// components/information/CarrierBadge.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function CarrierBadge({
  name,
  id,
  ratios = [],
  style,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    style: {
      display: "flex",
      flexDirection: "column",
      gap: "7px",
      ...style
    }
  }, rest), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-sans)",
      fontSize: "var(--type-micro)",
      fontWeight: "var(--weight-semibold)",
      color: "var(--text-ink)",
      textTransform: "uppercase"
    }
  }, name), id && /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: "var(--type-micro-xs)",
      color: "var(--text-muted)"
    }
  }, id.replace(/^carrier_/, "")), ratios.length > 0 && /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: "var(--type-micro-xs)",
      color: "var(--text-index)"
    }
  }, ratios.join(" / ")));
}
Object.assign(__ds_scope, { CarrierBadge });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/information/CarrierBadge.jsx", error: String((e && e.message) || e) }); }

// components/information/RuledDataStrip.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function RuledDataStrip({
  items = [],
  rule = "above",
  weight = 3,
  ink = "var(--rule-strong)",
  size = 20,
  align = "between",
  style,
  ...rest
}) {
  const line = /*#__PURE__*/React.createElement("div", {
    style: {
      height: weight + "px",
      background: ink
    }
  });
  return /*#__PURE__*/React.createElement("div", _extends({
    style: {
      display: "flex",
      flexDirection: "column",
      gap: "18px",
      ...style
    }
  }, rest), (rule === "above" || rule === "both") && line, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      gap: "40px",
      justifyContent: align === "between" ? "space-between" : "flex-start",
      alignItems: "baseline",
      flexWrap: "wrap"
    }
  }, items.map((it, i) => /*#__PURE__*/React.createElement("span", {
    key: i,
    style: {
      display: "flex",
      gap: "10px",
      alignItems: "baseline",
      fontFamily: "var(--font-mono)",
      fontSize: size + "px",
      letterSpacing: "var(--track-mono-strip)",
      color: "var(--text-ink)"
    }
  }, it.index && /*#__PURE__*/React.createElement("span", {
    style: {
      fontWeight: "var(--weight-bold)",
      color: "var(--text-index)"
    }
  }, it.index), /*#__PURE__*/React.createElement("span", {
    style: {
      textTransform: "uppercase"
    }
  }, it.label), it.value && /*#__PURE__*/React.createElement("span", {
    style: {
      color: "var(--text-muted)",
      fontVariantNumeric: "tabular-nums"
    }
  }, it.value)))), (rule === "below" || rule === "both") && line);
}
Object.assign(__ds_scope, { RuledDataStrip });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/information/RuledDataStrip.jsx", error: String((e && e.message) || e) }); }

// components/marks/PlateBadge.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function PlateBadge({
  children,
  tone = "index",
  size = 13,
  style,
  ...rest
}) {
  const c = tone === "mark" ? "var(--text-mark)" : tone === "ink" ? "var(--text-ink)" : "var(--text-index)";
  return /*#__PURE__*/React.createElement("span", _extends({
    style: {
      fontFamily: "var(--font-mono)",
      fontWeight: "var(--weight-bold)",
      fontSize: size + "px",
      letterSpacing: "var(--track-mono-index)",
      color: c,
      ...style
    }
  }, rest), children);
}
Object.assign(__ds_scope, { PlateBadge });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/marks/PlateBadge.jsx", error: String((e && e.message) || e) }); }

// components/marks/RegistrationMark.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function RegistrationMark({
  size = 28,
  ink = "var(--text-ink)",
  weight = 1.5,
  style,
  ...rest
}) {
  const c = size / 2,
    r = size * 0.3;
  return /*#__PURE__*/React.createElement("svg", _extends({
    width: size,
    height: size,
    viewBox: "0 0 " + size + " " + size,
    "aria-hidden": "true",
    style: {
      display: "block",
      ...style
    }
  }, rest), /*#__PURE__*/React.createElement("circle", {
    cx: c,
    cy: c,
    r: r,
    fill: "none",
    stroke: ink,
    strokeWidth: weight
  }), /*#__PURE__*/React.createElement("line", {
    x1: c,
    y1: "0",
    x2: c,
    y2: size,
    stroke: ink,
    strokeWidth: weight
  }), /*#__PURE__*/React.createElement("line", {
    x1: "0",
    y1: c,
    x2: size,
    y2: c,
    stroke: ink,
    strokeWidth: weight
  }));
}
Object.assign(__ds_scope, { RegistrationMark });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/marks/RegistrationMark.jsx", error: String((e && e.message) || e) }); }

// components/marks/SectionRule.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function SectionRule({
  number,
  title,
  subtitle,
  weight = 2,
  style,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    style: {
      display: "flex",
      flexDirection: "column",
      gap: "14px",
      ...style
    }
  }, rest), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "baseline",
      gap: "0"
    }
  }, number && /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: "var(--type-index)",
      fontWeight: "var(--weight-bold)",
      letterSpacing: "var(--track-mono-index)",
      color: "var(--text-index)",
      width: "64px",
      flex: "0 0 64px"
    }
  }, number), title && /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-sans)",
      fontSize: "var(--type-section-title)",
      fontWeight: "var(--weight-semibold)",
      color: "var(--text-ink)"
    }
  }, title), subtitle && /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: "auto",
      fontFamily: "var(--font-mono)",
      fontSize: "16px",
      color: "var(--text-muted)"
    }
  }, subtitle)), /*#__PURE__*/React.createElement("div", {
    style: {
      height: weight + "px",
      background: "var(--rule-strong)"
    }
  }));
}
Object.assign(__ds_scope, { SectionRule });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/marks/SectionRule.jsx", error: String((e && e.message) || e) }); }

// components/plate/HalftoneField.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function HalftoneField({
  ink = "var(--plate-dominant)",
  paper = "var(--paper)",
  cell = 24,
  coverage = 1,
  style,
  children,
  ...rest
}) {
  const uid = React.useId().replace(/[^a-zA-Z0-9]/g, "");
  const k = cell / 24;
  return /*#__PURE__*/React.createElement("div", _extends({
    style: {
      position: "relative",
      background: ink,
      overflow: "hidden",
      ...style
    }
  }, rest), /*#__PURE__*/React.createElement("svg", {
    "aria-hidden": "true",
    style: {
      position: "absolute",
      inset: 0,
      width: "100%",
      height: "100%",
      opacity: coverage,
      pointerEvents: "none"
    }
  }, /*#__PURE__*/React.createElement("pattern", {
    id: "ht" + uid,
    width: cell,
    height: cell,
    patternUnits: "userSpaceOnUse"
  }, /*#__PURE__*/React.createElement("circle", {
    cx: 6 * k,
    cy: 6 * k,
    r: 4 * k,
    fill: paper,
    fillOpacity: "0.42"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: 18 * k,
    cy: 17 * k,
    r: 2.4 * k,
    fill: paper,
    fillOpacity: "0.24"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: 5 * k,
    cy: 20 * k,
    r: 1.2 * k,
    fill: paper,
    fillOpacity: "0.18"
  })), /*#__PURE__*/React.createElement("rect", {
    width: "100%",
    height: "100%",
    fill: "url(#ht" + uid + ")"
  })), children && /*#__PURE__*/React.createElement("div", {
    style: {
      position: "relative"
    }
  }, children));
}
Object.assign(__ds_scope, { HalftoneField });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/plate/HalftoneField.jsx", error: String((e && e.message) || e) }); }

// components/plate/InkPair.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function InkPair({
  dominant,
  accent,
  mode,
  size = "m",
  style,
  ...rest
}) {
  const w = size === "l" ? 200 : 142,
    h = size === "l" ? 130 : 92;
  return /*#__PURE__*/React.createElement("div", _extends({
    style: {
      display: "flex",
      flexDirection: "column",
      gap: "18px",
      ...style
    }
  }, rest), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      width: w * 1.5,
      height: h
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      flex: "0 0 75%",
      background: dominant.hex
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: "1 1 25%",
      background: accent.hex
    }
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: "5px"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-sans)",
      fontSize: "var(--type-micro)",
      fontWeight: "var(--weight-semibold)",
      color: "var(--text-ink)",
      textTransform: "uppercase"
    }
  }, dominant.name, " + ", accent.name), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: "var(--type-micro-s)",
      color: "var(--text-muted)"
    }
  }, dominant.hex, " + ", accent.hex), mode && /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: "var(--type-micro-s)",
      color: "var(--text-index)"
    }
  }, mode)));
}
Object.assign(__ds_scope, { InkPair });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/plate/InkPair.jsx", error: String((e && e.message) || e) }); }

// components/plate/InkSwatch.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const SIZES = {
  s: {
    w: 96,
    h: 62
  },
  m: {
    w: 142,
    h: 92
  },
  l: {
    w: 200,
    h: 130
  }
};
function InkSwatch({
  name,
  id,
  hex,
  size = "m",
  showMeta = true,
  style,
  ...rest
}) {
  const s = SIZES[size] || SIZES.m;
  return /*#__PURE__*/React.createElement("div", _extends({
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 0,
      ...style
    }
  }, rest), /*#__PURE__*/React.createElement("div", {
    style: {
      width: s.w,
      height: s.h,
      background: hex
    }
  }), showMeta && /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: "5px",
      marginTop: "18px"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      font: "var(--weight-semibold) var(--type-micro)/1 var(--font-label-face,var(--font-sans))",
      fontFamily: "var(--font-sans)",
      fontSize: "var(--type-micro)",
      fontWeight: "var(--weight-semibold)",
      color: "var(--text-ink)",
      textTransform: "uppercase"
    }
  }, name), id && /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: "var(--type-micro-s)",
      color: "var(--text-muted)"
    }
  }, id.replace(/^ink_/, "")), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: "var(--type-micro-s)",
      color: "var(--text-muted)"
    }
  }, hex)));
}
Object.assign(__ds_scope, { InkSwatch });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/plate/InkSwatch.jsx", error: String((e && e.message) || e) }); }

// components/plate/PaperSheet.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const SUBSTRATE = {
  "neutral-white": "var(--substrate-neutral-white)",
  "cool-gray": "var(--substrate-cool-gray)",
  "pale-beige": "var(--substrate-pale-beige)"
};
function PaperSheet({
  substrate = "neutral-white",
  noise = true,
  children,
  style,
  ...rest
}) {
  const uid = React.useId().replace(/[^a-zA-Z0-9]/g, "");
  return /*#__PURE__*/React.createElement("div", _extends({
    style: {
      position: "relative",
      background: SUBSTRATE[substrate] || SUBSTRATE["neutral-white"],
      ...style
    }
  }, rest), noise && /*#__PURE__*/React.createElement("svg", {
    "aria-hidden": "true",
    style: {
      position: "absolute",
      inset: 0,
      width: "100%",
      height: "100%",
      mixBlendMode: "multiply",
      pointerEvents: "none"
    }
  }, /*#__PURE__*/React.createElement("filter", {
    id: "paper" + uid,
    x: "-10%",
    y: "-10%",
    width: "120%",
    height: "120%"
  }, /*#__PURE__*/React.createElement("feTurbulence", {
    type: "fractalNoise",
    baseFrequency: "0.72",
    numOctaves: "3",
    seed: "5",
    result: "noise"
  }), /*#__PURE__*/React.createElement("feColorMatrix", {
    in: "noise",
    type: "saturate",
    values: "0",
    result: "gray"
  }), /*#__PURE__*/React.createElement("feComponentTransfer", {
    in: "gray"
  }, /*#__PURE__*/React.createElement("feFuncA", {
    type: "table",
    tableValues: "0 0.085"
  }))), /*#__PURE__*/React.createElement("rect", {
    width: "100%",
    height: "100%",
    fill: "#FFFFFF",
    filter: "url(#paper" + uid + ")"
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      position: "relative"
    }
  }, children));
}
Object.assign(__ds_scope, { PaperSheet });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/plate/PaperSheet.jsx", error: String((e && e.message) || e) }); }

// components/poster/CompositionThumb.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const W = 180,
  H = 226;
const COBALT = "var(--plate-dominant)",
  TERRA = "var(--plate-accent)",
  INK = "var(--text-ink)";
function Layout({
  id
}) {
  switch (id) {
    case "composition_image_field":
      return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("ellipse", {
        cx: "118",
        cy: "146",
        rx: "88",
        ry: "101",
        fill: COBALT
      }), /*#__PURE__*/React.createElement("rect", {
        x: "18",
        y: "55",
        width: "148",
        height: "16",
        fill: INK
      }));
    case "composition_specimen_annotation":
      return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("circle", {
        cx: "90",
        cy: "119",
        r: "48",
        fill: TERRA
      }), /*#__PURE__*/React.createElement("line", {
        x1: "22",
        y1: "58",
        x2: "67",
        y2: "96",
        stroke: INK,
        strokeWidth: "1"
      }), /*#__PURE__*/React.createElement("line", {
        x1: "117",
        y1: "144",
        x2: "158",
        y2: "178",
        stroke: INK,
        strokeWidth: "1"
      }));
    case "composition_type_declaration":
      return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("text", {
        x: "12",
        y: "78",
        fontFamily: "var(--font-grotesk)",
        fontSize: "62",
        fontWeight: "700",
        fill: INK
      }, "BIG"), /*#__PURE__*/React.createElement("text", {
        x: "42",
        y: "143",
        fontFamily: "var(--font-grotesk)",
        fontSize: "58",
        fontWeight: "700",
        fill: COBALT
      }, "TYPE"), /*#__PURE__*/React.createElement("rect", {
        x: "12",
        y: "184",
        width: "78",
        height: "18",
        fill: TERRA
      }));
    case "composition_ruled_information":
      return /*#__PURE__*/React.createElement(React.Fragment, null, [52, 90, 128, 166].map(y => /*#__PURE__*/React.createElement("line", {
        key: y,
        x1: "16",
        y1: y,
        x2: "164",
        y2: y,
        stroke: INK,
        strokeWidth: "1"
      })), /*#__PURE__*/React.createElement("rect", {
        x: "16",
        y: "18",
        width: "95",
        height: "22",
        fill: COBALT
      }), /*#__PURE__*/React.createElement("rect", {
        x: "112",
        y: "92",
        width: "50",
        height: "72",
        fill: TERRA
      }));
    case "composition_archival_plate":
      return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("rect", {
        x: "48",
        y: "51",
        width: "84",
        height: "112",
        fill: INK
      }), /*#__PURE__*/React.createElement("line", {
        x1: "20",
        y1: "35",
        x2: "60",
        y2: "72",
        stroke: COBALT,
        strokeWidth: "2"
      }), /*#__PURE__*/React.createElement("line", {
        x1: "120",
        y1: "153",
        x2: "159",
        y2: "190",
        stroke: COBALT,
        strokeWidth: "2"
      }), /*#__PURE__*/React.createElement("text", {
        x: "18",
        y: "208",
        fontFamily: "var(--font-mono)",
        fontSize: "11",
        fill: INK
      }, "PLATE 04"));
    case "composition_editorial_cover":
      return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("rect", {
        x: "56",
        y: "35",
        width: "124",
        height: "191",
        fill: COBALT
      }), /*#__PURE__*/React.createElement("rect", {
        x: "14",
        y: "96",
        width: "150",
        height: "23",
        fill: INK
      }), /*#__PURE__*/React.createElement("rect", {
        x: "14",
        y: "126",
        width: "112",
        height: "23",
        fill: INK
      }));
    case "composition_object_field":
      return /*#__PURE__*/React.createElement(React.Fragment, null, [0, 1, 2, 3].map(row => [0, 1, 2].map(col => /*#__PURE__*/React.createElement("circle", {
        key: row + "-" + col,
        cx: 42 + col * 49,
        cy: 48 + row * 44,
        r: "18",
        fill: (row + col) % 2 === 0 ? COBALT : TERRA
      }))), /*#__PURE__*/React.createElement("rect", {
        x: "18",
        y: "202",
        width: "112",
        height: "10",
        fill: INK
      }));
    case "composition_overprint_collage":
      return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("ellipse", {
        cx: "76",
        cy: "110",
        rx: "62",
        ry: "86",
        fill: COBALT
      }), /*#__PURE__*/React.createElement("ellipse", {
        cx: "122",
        cy: "129",
        rx: "48",
        ry: "73",
        fill: TERRA,
        fillOpacity: "0.78"
      }), /*#__PURE__*/React.createElement("rect", {
        x: "25",
        y: "107",
        width: "132",
        height: "17",
        fill: INK
      }));
    default:
      return /*#__PURE__*/React.createElement(React.Fragment, null, /*#__PURE__*/React.createElement("rect", {
        x: "18",
        y: "22",
        width: "82",
        height: "102",
        fill: COBALT
      }), [143, 163, 183].map(y => /*#__PURE__*/React.createElement("line", {
        key: y,
        x1: "18",
        y1: y,
        x2: "158",
        y2: y,
        stroke: INK,
        strokeWidth: "1"
      })), /*#__PURE__*/React.createElement("text", {
        x: "113",
        y: "37",
        fontFamily: "var(--font-mono)",
        fontSize: "12",
        fill: TERRA
      }, "07"));
  }
}
function CompositionThumb({
  layout,
  width = W,
  style,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("svg", _extends({
    width: width,
    height: width * H / W,
    viewBox: "0 0 " + W + " " + H,
    "aria-hidden": "true",
    style: {
      display: "block",
      ...style
    }
  }, rest), /*#__PURE__*/React.createElement("rect", {
    x: "0.5",
    y: "0.5",
    width: W - 1,
    height: H - 1,
    fill: "var(--paper-poster)",
    stroke: INK,
    strokeWidth: "1"
  }), /*#__PURE__*/React.createElement(Layout, {
    id: layout
  }));
}
Object.assign(__ds_scope, { CompositionThumb });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/poster/CompositionThumb.jsx", error: String((e && e.message) || e) }); }

// components/poster/PosterSheet.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const RATIOS = {
  "3:4": 3 / 4,
  "2:3": 2 / 3,
  "4:5": 4 / 5,
  "1:1": 1,
  "4:3": 4 / 3
};
const SUB = {
  "neutral-white": "var(--substrate-neutral-white)",
  "cool-gray": "var(--substrate-cool-gray)",
  "pale-beige": "var(--substrate-pale-beige)"
};
function PosterSheet({
  ratio = "3:4",
  substrate = "neutral-white",
  width = 540,
  margin = "5%",
  edge = true,
  children,
  style,
  ...rest
}) {
  const r = RATIOS[ratio] || RATIOS["3:4"];
  return /*#__PURE__*/React.createElement("div", _extends({
    style: {
      position: "relative",
      width: typeof width === "number" ? width + "px" : width,
      aspectRatio: String(r),
      background: SUB[substrate] || SUB["neutral-white"],
      boxShadow: edge ? "inset 0 0 0 1px var(--rule-strong)" : "none",
      ...style
    }
  }, rest), /*#__PURE__*/React.createElement("div", {
    style: {
      position: "absolute",
      inset: margin,
      display: "flex",
      flexDirection: "column"
    }
  }, children));
}
Object.assign(__ds_scope, { PosterSheet });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/poster/PosterSheet.jsx", error: String((e && e.message) || e) }); }

// components/type/DisplayHeading.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const VOICES = {
  literary: {
    fontFamily: "var(--font-serif-display)",
    fontStyle: "italic",
    fontWeight: 400,
    textTransform: "none",
    letterSpacing: 0
  },
  cultural: {
    fontFamily: "var(--font-grotesk)",
    fontWeight: 700,
    textTransform: "none",
    letterSpacing: "-0.02em"
  },
  condensed: {
    fontFamily: "var(--font-condensed)",
    fontWeight: 600,
    textTransform: "uppercase",
    letterSpacing: "0.01em"
  },
  programmatic: {
    fontFamily: "var(--font-sans)",
    fontWeight: 500,
    textTransform: "uppercase",
    letterSpacing: "0.02em",
    fontVariantNumeric: "tabular-nums"
  },
  typographic: {
    fontFamily: "var(--font-grotesk)",
    fontWeight: 700,
    textTransform: "lowercase",
    letterSpacing: "-0.03em"
  }
};
function DisplayHeading({
  voice = "cultural",
  size = 52,
  ink = "var(--text-ink)",
  rotated = false,
  as = "h2",
  children,
  style,
  ...rest
}) {
  const Tag = as;
  const v = VOICES[voice] || VOICES.cultural;
  return /*#__PURE__*/React.createElement(Tag, _extends({
    style: {
      margin: 0,
      fontSize: typeof size === "number" ? size + "px" : size,
      lineHeight: "var(--leading-display)",
      color: ink,
      ...(rotated ? {
        writingMode: "vertical-rl",
        transform: "rotate(180deg)"
      } : null),
      ...v,
      ...style
    }
  }, rest), children);
}
Object.assign(__ds_scope, { DisplayHeading });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/type/DisplayHeading.jsx", error: String((e && e.message) || e) }); }

// components/type/MicroLabel.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
const TONES = {
  muted: "var(--text-muted)",
  ink: "var(--text-ink)",
  index: "var(--text-index)",
  mark: "var(--text-mark)"
};
function MicroLabel({
  tone = "muted",
  size = 12,
  weight = 400,
  tracking = 0,
  uppercase = false,
  as = "span",
  children,
  style,
  ...rest
}) {
  const Tag = as;
  return /*#__PURE__*/React.createElement(Tag, _extends({
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: typeof size === "number" ? size + "px" : size,
      fontWeight: weight,
      letterSpacing: typeof tracking === "number" ? tracking + "px" : tracking,
      color: TONES[tone] || tone,
      textTransform: uppercase ? "uppercase" : "none",
      lineHeight: "var(--leading-label)",
      ...style
    }
  }, rest), children);
}
Object.assign(__ds_scope, { MicroLabel });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/type/MicroLabel.jsx", error: String((e && e.message) || e) }); }

// components/type/SpecimenCaption.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
function SpecimenCaption({
  name,
  id,
  rows = [],
  note,
  style,
  ...rest
}) {
  return /*#__PURE__*/React.createElement("div", _extends({
    style: {
      display: "flex",
      flexDirection: "column",
      gap: "8px",
      ...style
    }
  }, rest), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-sans)",
      fontSize: "var(--type-label)",
      fontWeight: "var(--weight-semibold)",
      color: "var(--text-ink)",
      textTransform: "uppercase",
      lineHeight: 1.15
    }
  }, name), id && /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: "var(--type-micro-xs)",
      color: "var(--text-muted)"
    }
  }, id), rows.length > 0 && /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "auto 1fr",
      gap: "4px 14px",
      marginTop: "6px"
    }
  }, rows.map((r, i) => /*#__PURE__*/React.createElement(React.Fragment, {
    key: i
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: "var(--type-micro-s)",
      color: "var(--text-ink)",
      textTransform: "uppercase"
    }
  }, r.label), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: "var(--type-micro-s)",
      color: "var(--text-ink)",
      fontVariantNumeric: "tabular-nums"
    }
  }, r.value)))), note && /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-sans)",
      fontSize: "var(--type-micro-s)",
      color: "var(--text-muted)",
      marginTop: "6px",
      lineHeight: 1.35
    }
  }, note));
}
Object.assign(__ds_scope, { SpecimenCaption });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/type/SpecimenCaption.jsx", error: String((e && e.message) || e) }); }

// ui_kits/printed-artifacts/OnePosterFive.jsx
try { (() => {
// Recreation of scripts/build_vibe_coding_poster.py — 1800x2400, pure one-ink on paper.
const CURSORS = ["1320,760 1450,1090 1360,1052 1312,1178 1254,1152 1304,1028 1218,1010", "1110,1090 1218,1368 1142,1338 1098,1452 1048,1432 1092,1320 1020,1306", "1370,1320 1485,1608 1404,1578 1360,1694 1306,1672 1352,1556 1276,1540", "1070,1580 1180,1854 1102,1828 1060,1938 1008,1918 1050,1808 978,1792", "1335,1810 1442,2084 1368,2056 1328,2162 1278,2142 1318,2036 1248,2020"];
const DRY = [[742, 1110, 92, 18, -8], [930, 1205, 66, 13, 5], [1210, 1055, 118, 16, -4], [1460, 1250, 82, 20, 7], [1120, 1488, 104, 15, -6], [760, 1640, 76, 14, 4], [1370, 1740, 126, 17, -5], [980, 1940, 88, 18, 6]];
function OnePosterFive({
  ink = "#2148B8",
  paper = "#F5F1E8",
  grain = true
}) {
  return /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 1800 2400",
    width: "1800",
    height: "2400",
    style: {
      display: "block"
    }
  }, /*#__PURE__*/React.createElement("defs", null, /*#__PURE__*/React.createElement("filter", {
    id: "p-noise",
    x: "-10%",
    y: "-10%",
    width: "120%",
    height: "120%"
  }, /*#__PURE__*/React.createElement("feTurbulence", {
    type: "fractalNoise",
    baseFrequency: "0.72",
    numOctaves: "3",
    seed: "5",
    result: "noise"
  }), /*#__PURE__*/React.createElement("feColorMatrix", {
    in: "noise",
    type: "saturate",
    values: "0",
    result: "gray"
  }), /*#__PURE__*/React.createElement("feComponentTransfer", {
    in: "gray",
    result: "soft"
  }, /*#__PURE__*/React.createElement("feFuncA", {
    type: "table",
    tableValues: "0 0.085"
  }))), /*#__PURE__*/React.createElement("pattern", {
    id: "p-halftone",
    width: "24",
    height: "24",
    patternUnits: "userSpaceOnUse"
  }, /*#__PURE__*/React.createElement("circle", {
    cx: "6",
    cy: "6",
    r: "4",
    fill: paper,
    fillOpacity: "0.42"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "18",
    cy: "17",
    r: "2.4",
    fill: paper,
    fillOpacity: "0.24"
  }), /*#__PURE__*/React.createElement("circle", {
    cx: "5",
    cy: "20",
    r: "1.2",
    fill: paper,
    fillOpacity: "0.18"
  })), /*#__PURE__*/React.createElement("filter", {
    id: "p-wobble",
    x: "-3%",
    y: "-3%",
    width: "106%",
    height: "106%"
  }, /*#__PURE__*/React.createElement("feTurbulence", {
    type: "fractalNoise",
    baseFrequency: "0.012",
    numOctaves: "2",
    seed: "5",
    result: "warp"
  }), /*#__PURE__*/React.createElement("feDisplacementMap", {
    in: "SourceGraphic",
    in2: "warp",
    scale: "5",
    xChannelSelector: "R",
    yChannelSelector: "G"
  })), /*#__PURE__*/React.createElement("clipPath", {
    id: "p-five"
  }, /*#__PURE__*/React.createElement("text", {
    x: "650",
    y: "2100",
    style: {
      fontFamily: "var(--font-grotesk)",
      fontSize: "1900px",
      fontWeight: 700
    }
  }, "5"))), /*#__PURE__*/React.createElement("rect", {
    width: "1800",
    height: "2400",
    fill: paper
  }), grain && /*#__PURE__*/React.createElement("rect", {
    width: "1800",
    height: "2400",
    fill: "#FFFFFF",
    filter: "url(#p-noise)",
    style: {
      mixBlendMode: "multiply"
    }
  }), /*#__PURE__*/React.createElement("text", {
    x: "116",
    y: "120",
    fill: ink,
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: "22px",
      fontWeight: 700,
      letterSpacing: "2px"
    }
  }, "OPEN PRACTICE / 05:00"), /*#__PURE__*/React.createElement("text", {
    x: "1684",
    y: "120",
    textAnchor: "end",
    fill: ink,
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: "18px",
      letterSpacing: "1.5px"
    }
  }, "START BEFORE YOU FEEL READY"), /*#__PURE__*/React.createElement("line", {
    x1: "116",
    y1: "166",
    x2: "1684",
    y2: "166",
    stroke: ink,
    strokeWidth: "5"
  }), /*#__PURE__*/React.createElement("text", {
    x: "116",
    y: "390",
    fill: ink,
    style: {
      fontFamily: "var(--font-cjk)",
      fontSize: "132px",
      fontWeight: 600
    }
  }, "\u6BCF\u4E2A\u4EBA\u90FD\u53EF\u4EE5"), /*#__PURE__*/React.createElement("path", {
    d: "M 96 270 C 268 218, 548 224, 720 302 C 770 326, 775 368, 736 398",
    fill: "none",
    stroke: ink,
    strokeWidth: "8",
    strokeLinecap: "round"
  }), /*#__PURE__*/React.createElement("path", {
    d: "M 697 421 C 520 480, 208 466, 102 384",
    fill: "none",
    stroke: ink,
    strokeWidth: "7",
    strokeLinecap: "round"
  }), /*#__PURE__*/React.createElement("text", {
    x: "108",
    y: "690",
    fill: ink,
    style: {
      fontFamily: "var(--font-grotesk)",
      fontSize: "250px",
      fontWeight: 700
    }
  }, "vibe"), /*#__PURE__*/React.createElement("text", {
    x: "104",
    y: "908",
    fill: ink,
    style: {
      fontFamily: "var(--font-grotesk)",
      fontSize: "250px",
      fontWeight: 700
    }
  }, "coding"), /*#__PURE__*/React.createElement("text", {
    x: "657",
    y: "2104",
    fill: ink,
    opacity: "0.13",
    style: {
      fontFamily: "var(--font-grotesk)",
      fontSize: "1900px",
      fontWeight: 700
    }
  }, "5"), /*#__PURE__*/React.createElement("text", {
    x: "650",
    y: "2100",
    fill: ink,
    filter: "url(#p-wobble)",
    style: {
      fontFamily: "var(--font-grotesk)",
      fontSize: "1900px",
      fontWeight: 700
    }
  }, "5"), /*#__PURE__*/React.createElement("rect", {
    x: "650",
    y: "1020",
    width: "980",
    height: "1080",
    fill: "url(#p-halftone)",
    clipPath: "url(#p-five)"
  }), /*#__PURE__*/React.createElement("g", {
    clipPath: "url(#p-five)"
  }, DRY.map(([x, y, w, h, a], i) => /*#__PURE__*/React.createElement("rect", {
    key: i,
    x: x,
    y: y,
    width: w,
    height: h,
    rx: h / 2,
    fill: paper,
    opacity: "0.78",
    transform: "rotate(" + a + " " + x + " " + y + ")"
  }))), CURSORS.map((pts, i) => /*#__PURE__*/React.createElement("polygon", {
    key: i,
    points: pts,
    fill: paper
  })), /*#__PURE__*/React.createElement("text", {
    x: "1220",
    y: "2180",
    fill: ink,
    style: {
      fontFamily: "var(--font-cjk)",
      fontSize: "142px",
      fontWeight: 600
    }
  }, "\u5206\u949F"), /*#__PURE__*/React.createElement("line", {
    x1: "116",
    y1: "2240",
    x2: "1684",
    y2: "2240",
    stroke: ink,
    strokeWidth: "3"
  }), /*#__PURE__*/React.createElement("text", {
    x: "116",
    y: "2304",
    fill: ink,
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: "20px",
      fontWeight: 700,
      letterSpacing: "1.5px"
    }
  }, "01 IDEA   02 TYPE   03 RUN   04 LOOK   05 CHANGE"), /*#__PURE__*/React.createElement("text", {
    x: "1684",
    y: "2304",
    textAnchor: "end",
    fill: ink,
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: "20px"
    }
  }, "NO PERMISSION REQUIRED"));
}
Object.assign(window, {
  OnePosterFive
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/printed-artifacts/OnePosterFive.jsx", error: String((e && e.message) || e) }); }

// ui_kits/printed-artifacts/PressControls.jsx
try { (() => {
const ONE_INKS = [["ink_cobalt", "Cobalt", "#2148B8"], ["ink_royal_blue", "Royal Blue", "#2058D4"], ["ink_botanical_green", "Botanical Green", "#008A4B"], ["ink_mint_green", "Mint Green", "#5EB783"], ["ink_terracotta", "Terracotta Orange", "#C65F38"], ["ink_signal_red", "Signal Red", "#C83232"], ["ink_aubergine", "Aubergine", "#63365F"], ["ink_charcoal", "Charcoal", "#30343A"]];
const SUBSTRATES = [["substrate_neutral_white", "Neutral White", "#FAFAF7"], ["substrate_cool_gray", "Cool Gray", "#E9E9E5"], ["substrate_pale_beige", "Pale Beige", "#F5F1E8"]];
function Legend({
  children
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: 11,
      letterSpacing: "1.2px",
      color: "#77736B",
      textTransform: "uppercase",
      marginBottom: 12
    }
  }, children);
}
function PressControls({
  ink,
  setInk,
  paper,
  setPaper,
  grain,
  setGrain
}) {
  return /*#__PURE__*/React.createElement("aside", {
    style: {
      width: 260,
      flex: "0 0 260px",
      padding: "28px 26px",
      background: "#FAFAF7",
      boxShadow: "inset 1px 0 0 #C8C1B5",
      position: "sticky",
      top: 0,
      alignSelf: "flex-start"
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: 13,
      fontWeight: 700,
      letterSpacing: "1.5px",
      color: "#2148B8"
    }
  }, "PRESS SHEET"), /*#__PURE__*/React.createElement("div", {
    style: {
      fontFamily: "var(--font-grotesk)",
      fontSize: 30,
      fontWeight: 700,
      lineHeight: 1,
      margin: "8px 0 20px",
      color: "#242321"
    }
  }, "vibe coding"), /*#__PURE__*/React.createElement("div", {
    style: {
      height: 2,
      background: "#242321",
      marginBottom: 24
    }
  }), /*#__PURE__*/React.createElement(Legend, null, "plate ink \xB7 one-ink"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "grid",
      gridTemplateColumns: "repeat(4,1fr)",
      gap: 8,
      marginBottom: 24
    }
  }, ONE_INKS.map(([id, name, hex]) => /*#__PURE__*/React.createElement("button", {
    key: id,
    title: name,
    onClick: () => setInk(hex),
    style: {
      all: "unset",
      cursor: "pointer",
      height: 44,
      background: hex,
      boxShadow: ink === hex ? "0 0 0 2px #FAFAF7, 0 0 0 4px #242321" : "none"
    }
  }))), /*#__PURE__*/React.createElement(Legend, null, "substrate"), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 8,
      marginBottom: 24
    }
  }, SUBSTRATES.map(([id, name, hex]) => /*#__PURE__*/React.createElement("button", {
    key: id,
    onClick: () => setPaper(hex),
    style: {
      all: "unset",
      cursor: "pointer",
      display: "flex",
      alignItems: "center",
      gap: 10,
      padding: "7px 9px",
      boxShadow: paper === hex ? "inset 0 0 0 2px #242321" : "inset 0 0 0 1px #C8C1B5"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 24,
      height: 24,
      background: hex,
      boxShadow: "inset 0 0 0 1px #C8C1B5"
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-sans)",
      fontSize: 12,
      fontWeight: 600,
      textTransform: "uppercase",
      color: "#242321"
    }
  }, name), /*#__PURE__*/React.createElement("span", {
    style: {
      marginLeft: "auto",
      fontFamily: "var(--font-mono)",
      fontSize: 11,
      color: "#77736B"
    }
  }, hex)))), /*#__PURE__*/React.createElement(Legend, null, "reproduction"), /*#__PURE__*/React.createElement("button", {
    onClick: () => setGrain(!grain),
    style: {
      all: "unset",
      cursor: "pointer",
      display: "flex",
      alignItems: "center",
      gap: 10,
      padding: "7px 9px",
      boxShadow: "inset 0 0 0 1px #C8C1B5",
      marginBottom: 28
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 24,
      height: 24,
      background: grain ? "#242321" : "transparent",
      boxShadow: "inset 0 0 0 1px #C8C1B5"
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-sans)",
      fontSize: 12,
      fontWeight: 600,
      textTransform: "uppercase",
      color: "#242321"
    }
  }, "paper grain")), /*#__PURE__*/React.createElement("div", {
    style: {
      height: 1,
      background: "#C8C1B5",
      marginBottom: 16
    }
  }), [["mode", "pure one-ink"], ["layout", "type-led declaration"], ["type", "grotesk + mono"], ["process", "halftone + dry edge"], ["paper", "35% empty"]].map(([k, v]) => /*#__PURE__*/React.createElement("div", {
    key: k,
    style: {
      display: "flex",
      gap: 10,
      marginBottom: 6
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: 11,
      color: "#242321",
      width: 66,
      textTransform: "uppercase"
    }
  }, k), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: 11,
      color: "#77736B"
    }
  }, v))));
}
Object.assign(window, {
  PressControls
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/printed-artifacts/PressControls.jsx", error: String((e && e.message) || e) }); }

// ui_kits/reference-board/Board.jsx
try { (() => {
function Board() {
  const [ink, setInk] = React.useState("ink_cobalt");
  const [comp, setComp] = React.useState("composition_image_field");
  return /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 1800 3000",
    width: "1800",
    height: "3000",
    style: {
      display: "block"
    }
  }, /*#__PURE__*/React.createElement("rect", {
    width: "1800",
    height: "3000",
    fill: "#F5F1E8"
  }), /*#__PURE__*/React.createElement("filter", {
    id: "board-grain",
    x: "-2%",
    y: "-2%",
    width: "104%",
    height: "104%"
  }, /*#__PURE__*/React.createElement("feTurbulence", {
    type: "fractalNoise",
    baseFrequency: "0.72",
    numOctaves: "3",
    seed: "5",
    result: "n"
  }), /*#__PURE__*/React.createElement("feColorMatrix", {
    in: "n",
    type: "saturate",
    values: "0",
    result: "g"
  }), /*#__PURE__*/React.createElement("feComponentTransfer", {
    in: "g"
  }, /*#__PURE__*/React.createElement("feFuncA", {
    type: "table",
    tableValues: "0 0.085"
  }))), /*#__PURE__*/React.createElement("rect", {
    width: "1800",
    height: "3000",
    fill: "#FFFFFF",
    filter: "url(#board-grain)",
    style: {
      mixBlendMode: "multiply"
    }
  }), /*#__PURE__*/React.createElement(T, {
    x: 90,
    y: 92,
    size: 18,
    family: "mono",
    weight: 700,
    fill: COBALT,
    spacing: 2
  }, "MONO-COLOR"), /*#__PURE__*/React.createElement(T, {
    x: 90,
    y: 168,
    size: 72,
    family: "grotesk",
    weight: 700
  }, "VISUAL SYSTEM"), /*#__PURE__*/React.createElement(T, {
    x: 1710,
    y: 94,
    size: 15,
    family: "mono",
    fill: MUTED,
    anchor: "end"
  }, "REFERENCE BOARD / V0.1"), /*#__PURE__*/React.createElement(T, {
    x: 1710,
    y: 156,
    size: 14,
    family: "mono",
    fill: MUTED,
    anchor: "end"
  }, "19 INKS \xB7 7 TYPE ROLES \xB7 9 COMPOSITIONS \xB7 7 CARRIERS"), /*#__PURE__*/React.createElement(Rule, {
    y: 214,
    w: 4
  }), /*#__PURE__*/React.createElement(InkLibrary, {
    selected: ink,
    onSelect: setInk
  }), /*#__PURE__*/React.createElement(TypographicRoles, null), /*#__PURE__*/React.createElement(CompositionGrammar, {
    selected: comp,
    onSelect: setComp
  }), /*#__PURE__*/React.createElement(PhysicalCarriers, null), /*#__PURE__*/React.createElement(Rule, {
    y: 2940,
    w: 2
  }), /*#__PURE__*/React.createElement(T, {
    x: 90,
    y: 2972,
    size: 12,
    family: "mono",
    fill: MUTED
  }, "SOURCE: design-system/*.json"), /*#__PURE__*/React.createElement(T, {
    x: 1710,
    y: 2972,
    size: 12,
    family: "mono",
    fill: MUTED,
    anchor: "end"
  }, "ONE OR TWO INKS. ACTIVE PAPER. ONE CONTROLLED GESTURE."));
}
Object.assign(window, {
  Board
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/reference-board/Board.jsx", error: String((e && e.message) || e) }); }

// ui_kits/reference-board/BoardPrimitives.jsx
try { (() => {
const INK = "#242321",
  MUTED = "#77736B",
  COBALT = "#2148B8",
  TERRA = "#C65F38",
  HAIRLINE = "#C8C1B5",
  POSTER = "#FBF8F0";
const FAM = {
  grotesk: "var(--font-grotesk)",
  sans: "var(--font-sans)",
  mono: "var(--font-mono)",
  condensed: "var(--font-condensed)",
  serif: "var(--font-serif-display)"
};
function T({
  x,
  y,
  size,
  family = "sans",
  weight = 400,
  fill = INK,
  anchor = "start",
  italic = false,
  spacing = 0,
  children
}) {
  return /*#__PURE__*/React.createElement("text", {
    x: x,
    y: y,
    textAnchor: anchor,
    style: {
      fontFamily: FAM[family],
      fontSize: size + "px",
      fontWeight: weight,
      fontStyle: italic ? "italic" : "normal",
      letterSpacing: spacing + "px"
    },
    fill: fill
  }, children);
}
function Rule({
  y,
  w = 2,
  x1 = 90,
  x2 = 1710,
  stroke = INK
}) {
  return /*#__PURE__*/React.createElement("line", {
    x1: x1,
    y1: y,
    x2: x2,
    y2: y,
    stroke: stroke,
    strokeWidth: w
  });
}
function SectionHeader({
  number,
  title,
  subtitle,
  y
}) {
  return /*#__PURE__*/React.createElement("g", null, /*#__PURE__*/React.createElement(T, {
    x: 90,
    y: y,
    size: 17,
    family: "mono",
    weight: 700,
    fill: COBALT,
    spacing: 1.2
  }, number), /*#__PURE__*/React.createElement(T, {
    x: 154,
    y: y,
    size: 34,
    weight: 600
  }, title), /*#__PURE__*/React.createElement(T, {
    x: 1710,
    y: y,
    size: 16,
    family: "mono",
    fill: MUTED,
    anchor: "end"
  }, subtitle), /*#__PURE__*/React.createElement(Rule, {
    y: y + 28
  }));
}
Object.assign(window, {
  T,
  Rule,
  SectionHeader,
  INK,
  MUTED,
  COBALT,
  TERRA,
  HAIRLINE,
  POSTER,
  FAM
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/reference-board/BoardPrimitives.jsx", error: String((e && e.message) || e) }); }

// ui_kits/reference-board/CompositionGrammar.jsx
try { (() => {
function CompPreview({
  index,
  x,
  y
}) {
  const g = [];
  g.push(/*#__PURE__*/React.createElement("rect", {
    key: "b",
    x: x,
    y: y,
    width: 180,
    height: 226,
    fill: POSTER,
    stroke: INK,
    strokeWidth: 1
  }));
  if (index === 0) {
    g.push(/*#__PURE__*/React.createElement("ellipse", {
      key: "a",
      cx: x + 118,
      cy: y + 146,
      rx: 88,
      ry: 101,
      fill: COBALT
    }), /*#__PURE__*/React.createElement("rect", {
      key: "c",
      x: x + 18,
      y: y + 55,
      width: 148,
      height: 16,
      fill: INK
    }));
  } else if (index === 1) {
    g.push(/*#__PURE__*/React.createElement("circle", {
      key: "a",
      cx: x + 90,
      cy: y + 119,
      r: 48,
      fill: TERRA
    }), /*#__PURE__*/React.createElement("line", {
      key: "b1",
      x1: x + 22,
      y1: y + 58,
      x2: x + 67,
      y2: y + 96,
      stroke: INK,
      strokeWidth: 1
    }), /*#__PURE__*/React.createElement("line", {
      key: "b2",
      x1: x + 117,
      y1: y + 144,
      x2: x + 158,
      y2: y + 178,
      stroke: INK,
      strokeWidth: 1
    }));
  } else if (index === 2) {
    g.push(/*#__PURE__*/React.createElement(T, {
      key: "t1",
      x: x + 12,
      y: y + 78,
      size: 62,
      family: "grotesk",
      weight: 700
    }, "BIG"), /*#__PURE__*/React.createElement(T, {
      key: "t2",
      x: x + 42,
      y: y + 143,
      size: 58,
      family: "grotesk",
      weight: 700,
      fill: COBALT
    }, "TYPE"), /*#__PURE__*/React.createElement("rect", {
      key: "r",
      x: x + 12,
      y: y + 184,
      width: 78,
      height: 18,
      fill: TERRA
    }));
  } else if (index === 3) {
    [52, 90, 128, 166].forEach(o => g.push(/*#__PURE__*/React.createElement("line", {
      key: "l" + o,
      x1: x + 16,
      y1: y + o,
      x2: x + 164,
      y2: y + o,
      stroke: INK,
      strokeWidth: 1
    })));
    g.push(/*#__PURE__*/React.createElement("rect", {
      key: "r1",
      x: x + 16,
      y: y + 18,
      width: 95,
      height: 22,
      fill: COBALT
    }), /*#__PURE__*/React.createElement("rect", {
      key: "r2",
      x: x + 112,
      y: y + 92,
      width: 50,
      height: 72,
      fill: TERRA
    }));
  } else if (index === 4) {
    g.push(/*#__PURE__*/React.createElement("rect", {
      key: "r",
      x: x + 48,
      y: y + 51,
      width: 84,
      height: 112,
      fill: INK
    }), /*#__PURE__*/React.createElement("line", {
      key: "l1",
      x1: x + 20,
      y1: y + 35,
      x2: x + 60,
      y2: y + 72,
      stroke: COBALT,
      strokeWidth: 2
    }), /*#__PURE__*/React.createElement("line", {
      key: "l2",
      x1: x + 120,
      y1: y + 153,
      x2: x + 159,
      y2: y + 190,
      stroke: COBALT,
      strokeWidth: 2
    }), /*#__PURE__*/React.createElement(T, {
      key: "t",
      x: x + 18,
      y: y + 208,
      size: 11,
      family: "mono"
    }, "PLATE 04"));
  } else if (index === 5) {
    g.push(/*#__PURE__*/React.createElement("rect", {
      key: "r1",
      x: x + 56,
      y: y + 35,
      width: 124,
      height: 191,
      fill: COBALT
    }), /*#__PURE__*/React.createElement("rect", {
      key: "r2",
      x: x + 14,
      y: y + 96,
      width: 150,
      height: 23,
      fill: INK
    }), /*#__PURE__*/React.createElement("rect", {
      key: "r3",
      x: x + 14,
      y: y + 126,
      width: 112,
      height: 23,
      fill: INK
    }));
  } else if (index === 6) {
    for (let row = 0; row < 4; row++) for (let col = 0; col < 3; col++) g.push(/*#__PURE__*/React.createElement("circle", {
      key: "c" + row + col,
      cx: x + 42 + col * 49,
      cy: y + 48 + row * 44,
      r: 18,
      fill: (row + col) % 2 === 0 ? COBALT : TERRA
    }));
    g.push(/*#__PURE__*/React.createElement("rect", {
      key: "r",
      x: x + 18,
      y: y + 202,
      width: 112,
      height: 10,
      fill: INK
    }));
  } else if (index === 7) {
    g.push(/*#__PURE__*/React.createElement("ellipse", {
      key: "e1",
      cx: x + 76,
      cy: y + 110,
      rx: 62,
      ry: 86,
      fill: COBALT
    }), /*#__PURE__*/React.createElement("ellipse", {
      key: "e2",
      cx: x + 122,
      cy: y + 129,
      rx: 48,
      ry: 73,
      fill: TERRA,
      fillOpacity: 0.78
    }), /*#__PURE__*/React.createElement("rect", {
      key: "r",
      x: x + 25,
      y: y + 107,
      width: 132,
      height: 17,
      fill: INK
    }));
  } else {
    g.push(/*#__PURE__*/React.createElement("rect", {
      key: "r",
      x: x + 18,
      y: y + 22,
      width: 82,
      height: 102,
      fill: COBALT
    }));
    [143, 163, 183].forEach(o => g.push(/*#__PURE__*/React.createElement("line", {
      key: "l" + o,
      x1: x + 18,
      y1: y + o,
      x2: x + 158,
      y2: y + o,
      stroke: INK,
      strokeWidth: 1
    })));
    g.push(/*#__PURE__*/React.createElement(T, {
      key: "t",
      x: x + 113,
      y: y + 37,
      size: 12,
      family: "mono",
      fill: TERRA
    }, "07"));
  }
  return /*#__PURE__*/React.createElement("g", null, g);
}
function CompositionGrammar({
  onSelect,
  selected
}) {
  return /*#__PURE__*/React.createElement("g", null, /*#__PURE__*/React.createElement(SectionHeader, {
    number: "03",
    title: "COMPOSITION GRAMMAR",
    subtitle: "SUBJECT MASS / PAPER / COLLISION",
    y: 1374
  }), window.MC_DATA.compositions.map((c, i) => {
    const row = Math.floor(i / 3),
      col = i % 3,
      x = 90 + col * 540,
      y = 1438 + row * 290,
      lx = x + 206,
      on = selected === c.id;
    return /*#__PURE__*/React.createElement("g", {
      key: c.id,
      onClick: () => onSelect && onSelect(c.id),
      style: {
        cursor: "pointer"
      }
    }, /*#__PURE__*/React.createElement(CompPreview, {
      index: i,
      x: x,
      y: y
    }), on && /*#__PURE__*/React.createElement("rect", {
      x: x - 7,
      y: y - 7,
      width: 194,
      height: 240,
      fill: "none",
      stroke: COBALT,
      strokeWidth: 2
    }), /*#__PURE__*/React.createElement(T, {
      x: lx,
      y: y + 28,
      size: 13,
      family: "mono",
      weight: 700,
      fill: COBALT
    }, "0" + (i + 1)), /*#__PURE__*/React.createElement(T, {
      x: lx,
      y: y + 58,
      size: 15,
      weight: 600
    }, c.layout.toUpperCase()), /*#__PURE__*/React.createElement(T, {
      x: lx,
      y: y + 88,
      size: 11,
      family: "mono",
      fill: MUTED
    }, c.id), /*#__PURE__*/React.createElement(T, {
      x: lx,
      y: y + 124,
      size: 12,
      family: "mono"
    }, "SUBJECT  " + c.subject[0] + "-" + c.subject[1] + "%"), /*#__PURE__*/React.createElement(T, {
      x: lx,
      y: y + 148,
      size: 12,
      family: "mono"
    }, "PAPER    " + c.paper[0] + "-" + c.paper[1] + "%"), /*#__PURE__*/React.createElement(T, {
      x: lx,
      y: y + 184,
      size: 12,
      fill: MUTED
    }, c.title));
  }));
}
Object.assign(window, {
  CompositionGrammar,
  CompPreview
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/reference-board/CompositionGrammar.jsx", error: String((e && e.message) || e) }); }

// ui_kits/reference-board/InkLibrary.jsx
try { (() => {
function InkLibrary({
  onSelect,
  selected
}) {
  const inks = window.MC_DATA.inks;
  return /*#__PURE__*/React.createElement("g", null, /*#__PURE__*/React.createElement(SectionHeader, {
    number: "01",
    title: "INK LIBRARY",
    subtitle: "SOLID PLATES / WARM PAPER",
    y: 276
  }), inks.map((ink, i) => {
    const row = Math.floor(i / 10),
      col = i % 10,
      x = 90 + col * 162,
      y = 328 + row * 178;
    const on = selected === ink.id;
    return /*#__PURE__*/React.createElement("g", {
      key: ink.id,
      onClick: () => onSelect && onSelect(ink.id),
      style: {
        cursor: "pointer"
      }
    }, /*#__PURE__*/React.createElement("rect", {
      x: x,
      y: y,
      width: 142,
      height: 92,
      fill: ink.hex
    }), on && /*#__PURE__*/React.createElement("rect", {
      x: x - 6,
      y: y - 6,
      width: 154,
      height: 104,
      fill: "none",
      stroke: COBALT,
      strokeWidth: 2
    }), /*#__PURE__*/React.createElement(T, {
      x: x,
      y: y + 116,
      size: 13,
      weight: 600
    }, ink.name.toUpperCase()), /*#__PURE__*/React.createElement(T, {
      x: x,
      y: y + 138,
      size: 12,
      family: "mono",
      fill: MUTED
    }, ink.id.replace("ink_", "")), /*#__PURE__*/React.createElement(T, {
      x: x,
      y: y + 158,
      size: 12,
      family: "mono",
      fill: on ? COBALT : MUTED
    }, ink.hex));
  }));
}
Object.assign(window, {
  InkLibrary
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/reference-board/InkLibrary.jsx", error: String((e && e.message) || e) }); }

// ui_kits/reference-board/PhysicalCarriers.jsx
try { (() => {
function CarrierIcon({
  index,
  x,
  y
}) {
  switch (index) {
    case 0:
      return /*#__PURE__*/React.createElement("g", null, /*#__PURE__*/React.createElement("rect", {
        x: x + 32,
        y: y + 12,
        width: 94,
        height: 126,
        fill: POSTER,
        stroke: INK,
        strokeWidth: 2
      }), /*#__PURE__*/React.createElement("circle", {
        cx: x + 39,
        cy: y + 19,
        r: 4,
        fill: TERRA
      }), /*#__PURE__*/React.createElement("circle", {
        cx: x + 119,
        cy: y + 19,
        r: 4,
        fill: TERRA
      }), /*#__PURE__*/React.createElement("rect", {
        x: x + 46,
        y: y + 36,
        width: 66,
        height: 56,
        fill: COBALT
      }));
    case 1:
      return /*#__PURE__*/React.createElement("g", null, /*#__PURE__*/React.createElement("path", {
        d: "M " + (x + 12) + " " + (y + 32) + " Q " + (x + 48) + " " + (y + 20) + " " + (x + 80) + " " + (y + 39) + " L " + (x + 80) + " " + (y + 138) + " Q " + (x + 48) + " " + (y + 120) + " " + (x + 12) + " " + (y + 132) + " Z",
        fill: POSTER,
        stroke: INK,
        strokeWidth: 2
      }), /*#__PURE__*/React.createElement("path", {
        d: "M " + (x + 148) + " " + (y + 32) + " Q " + (x + 112) + " " + (y + 20) + " " + (x + 80) + " " + (y + 39) + " L " + (x + 80) + " " + (y + 138) + " Q " + (x + 112) + " " + (y + 120) + " " + (x + 148) + " " + (y + 132) + " Z",
        fill: POSTER,
        stroke: INK,
        strokeWidth: 2
      }), /*#__PURE__*/React.createElement("line", {
        x1: x + 80,
        y1: y + 39,
        x2: x + 80,
        y2: y + 138,
        stroke: TERRA,
        strokeWidth: 3
      }));
    case 2:
      return /*#__PURE__*/React.createElement("g", null, /*#__PURE__*/React.createElement("rect", {
        x: x + 45,
        y: y + 6,
        width: 72,
        height: 142,
        rx: 10,
        fill: POSTER,
        stroke: INK,
        strokeWidth: 3
      }), /*#__PURE__*/React.createElement("rect", {
        x: x + 52,
        y: y + 28,
        width: 58,
        height: 92,
        fill: COBALT
      }), /*#__PURE__*/React.createElement("circle", {
        cx: x + 81,
        cy: y + 136,
        r: 4,
        fill: INK
      }));
    case 3:
      return /*#__PURE__*/React.createElement("g", null, /*#__PURE__*/React.createElement("rect", {
        x: x + 20,
        y: y + 12,
        width: 124,
        height: 124,
        fill: TERRA,
        stroke: INK,
        strokeWidth: 2
      }), /*#__PURE__*/React.createElement("circle", {
        cx: x + 82,
        cy: y + 74,
        r: 36,
        fill: "none",
        stroke: "#F5F1E8",
        strokeWidth: 10
      }), /*#__PURE__*/React.createElement("circle", {
        cx: x + 82,
        cy: y + 74,
        r: 5,
        fill: INK
      }));
    case 4:
      return /*#__PURE__*/React.createElement("g", null, /*#__PURE__*/React.createElement("path", {
        d: "M " + (x + 36) + " " + (y + 31) + " L " + (x + 101) + " " + (y + 10) + " L " + (x + 137) + " " + (y + 39) + " L " + (x + 137) + " " + (y + 127) + " L " + (x + 71) + " " + (y + 147) + " L " + (x + 36) + " " + (y + 118) + " Z",
        fill: POSTER,
        stroke: INK,
        strokeWidth: 2
      }), /*#__PURE__*/React.createElement("line", {
        x1: x + 71,
        y1: y + 59,
        x2: x + 137,
        y2: y + 39,
        stroke: TERRA,
        strokeWidth: 3
      }), /*#__PURE__*/React.createElement("line", {
        x1: x + 71,
        y1: y + 59,
        x2: x + 71,
        y2: y + 147,
        stroke: INK,
        strokeWidth: 2
      }));
    case 5:
      return /*#__PURE__*/React.createElement("g", null, /*#__PURE__*/React.createElement("path", {
        d: "M " + (x + 50) + " " + (y + 18) + " L " + (x + 21) + " " + (y + 47) + " L " + (x + 45) + " " + (y + 70) + " L " + (x + 45) + " " + (y + 141) + " L " + (x + 117) + " " + (y + 141) + " L " + (x + 117) + " " + (y + 70) + " L " + (x + 141) + " " + (y + 47) + " L " + (x + 112) + " " + (y + 18) + " L " + (x + 98) + " " + (y + 38) + " Q " + (x + 81) + " " + (y + 50) + " " + (x + 64) + " " + (y + 38) + " Z",
        fill: POSTER,
        stroke: INK,
        strokeWidth: 2
      }), /*#__PURE__*/React.createElement("rect", {
        x: x + 62,
        y: y + 75,
        width: 38,
        height: 30,
        fill: COBALT
      }));
    default:
      return /*#__PURE__*/React.createElement("g", null, /*#__PURE__*/React.createElement("rect", {
        x: x + 18,
        y: y + 31,
        width: 70,
        height: 104,
        fill: POSTER,
        stroke: INK,
        strokeWidth: 2
      }), /*#__PURE__*/React.createElement("rect", {
        x: x + 72,
        y: y + 12,
        width: 72,
        height: 104,
        fill: POSTER,
        stroke: INK,
        strokeWidth: 2
      }), /*#__PURE__*/React.createElement("rect", {
        x: x + 85,
        y: y + 28,
        width: 46,
        height: 53,
        fill: COBALT
      }), /*#__PURE__*/React.createElement("line", {
        x1: x + 100,
        y1: y + 123,
        x2: x + 144,
        y2: y + 123,
        stroke: TERRA,
        strokeWidth: 3
      }));
  }
}
function PhysicalCarriers() {
  return /*#__PURE__*/React.createElement("g", null, /*#__PURE__*/React.createElement(SectionHeader, {
    number: "04",
    title: "PHYSICAL CARRIERS",
    subtitle: "FORMAT MUST REMAIN VISIBLE",
    y: 2618
  }), window.MC_DATA.carriers.map((c, i) => {
    const x = 90 + i * 230,
      y = 2685;
    return /*#__PURE__*/React.createElement("g", {
      key: c.id
    }, /*#__PURE__*/React.createElement(CarrierIcon, {
      index: i,
      x: x,
      y: y
    }), /*#__PURE__*/React.createElement(T, {
      x: x,
      y: y + 177,
      size: 13,
      weight: 600
    }, c.name.toUpperCase()), /*#__PURE__*/React.createElement(T, {
      x: x,
      y: y + 201,
      size: 11,
      family: "mono",
      fill: MUTED
    }, c.id.replace("carrier_", "")), /*#__PURE__*/React.createElement(T, {
      x: x,
      y: y + 225,
      size: 11,
      family: "mono",
      fill: COBALT
    }, c.ratios.join(" / ")));
  }));
}
Object.assign(window, {
  PhysicalCarriers,
  CarrierIcon
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/reference-board/PhysicalCarriers.jsx", error: String((e && e.message) || e) }); }

// ui_kits/reference-board/TypographicRoles.jsx
try { (() => {
const TYPE_SAMPLES = [{
  role: "type_literary",
  render: (x, y) => /*#__PURE__*/React.createElement("g", null, /*#__PURE__*/React.createElement(T, {
    x: x,
    y: y + 100,
    size: 44,
    family: "serif",
    italic: true
  }, "SOMEWHERE,"), /*#__PURE__*/React.createElement(T, {
    x: x + 70,
    y: y + 147,
    size: 44,
    family: "serif",
    italic: true,
    fill: TERRA
  }, "SLOWLY"))
}, {
  role: "type_cultural_grotesk",
  render: (x, y) => /*#__PURE__*/React.createElement("g", null, /*#__PURE__*/React.createElement(T, {
    x: x,
    y: y + 105,
    size: 40,
    family: "grotesk",
    weight: 700
  }, "OPEN"), /*#__PURE__*/React.createElement("rect", {
    x: x + 3,
    y: y + 119,
    width: 270,
    height: 12,
    fill: COBALT
  }), /*#__PURE__*/React.createElement(T, {
    x: x + 25,
    y: y + 169,
    size: 29,
    family: "condensed",
    weight: 600
  }, "AFTER DARK"))
}, {
  role: "type_programmatic",
  render: (x, y) => /*#__PURE__*/React.createElement("g", null, /*#__PURE__*/React.createElement(T, {
    x: x,
    y: y + 102,
    size: 38,
    family: "condensed",
    weight: 500
  }, "FIELD NOTE 07"), /*#__PURE__*/React.createElement("line", {
    x1: x,
    y1: y + 125,
    x2: x + 340,
    y2: y + 125,
    stroke: INK,
    strokeWidth: 1
  }), /*#__PURE__*/React.createElement(T, {
    x: x,
    y: y + 153,
    size: 13,
    family: "mono",
    fill: MUTED
  }, "SPECIMEN / 07 / NORTH"))
}, {
  role: "type_typographic_object",
  render: (x, y) => /*#__PURE__*/React.createElement("g", null, /*#__PURE__*/React.createElement(T, {
    x: x - 2,
    y: y + 103,
    size: 52,
    family: "grotesk",
    weight: 700
  }, "STILL"), /*#__PURE__*/React.createElement(T, {
    x: x + 78,
    y: y + 162,
    size: 52,
    family: "grotesk",
    weight: 700,
    fill: COBALT
  }, "OPEN"))
}];
function TypographicRoles() {
  const roles = window.MC_DATA.roles;
  return /*#__PURE__*/React.createElement("g", null, /*#__PURE__*/React.createElement(SectionHeader, {
    number: "02",
    title: "TYPOGRAPHIC ROLES",
    subtitle: "DISPLAY / SUPPORT / BEHAVIOR",
    y: 802
  }), TYPE_SAMPLES.map((s, i) => {
    const x = 90 + i * 405,
      y = 866,
      r = roles[s.role];
    return /*#__PURE__*/React.createElement("g", {
      key: s.role
    }, /*#__PURE__*/React.createElement(T, {
      x: x,
      y: y,
      size: 13,
      family: "mono",
      weight: 700,
      fill: COBALT
    }, "0" + (i + 1)), /*#__PURE__*/React.createElement(T, {
      x: x + 40,
      y: y,
      size: 13,
      family: "mono",
      fill: MUTED
    }, s.role), /*#__PURE__*/React.createElement("line", {
      x1: x,
      y1: y + 20,
      x2: x + 390,
      y2: y + 20,
      stroke: HAIRLINE,
      strokeWidth: 1
    }), s.render(x, y), /*#__PURE__*/React.createElement(T, {
      x: x,
      y: y + 222,
      size: 15,
      weight: 600
    }, r.name.toUpperCase()), /*#__PURE__*/React.createElement(T, {
      x: x,
      y: y + 247,
      size: 12,
      family: "mono",
      fill: MUTED
    }, r.scale_ratio), /*#__PURE__*/React.createElement(T, {
      x: x,
      y: y + 275,
      size: 13,
      fill: MUTED
    }, r.behavior));
  }));
}
Object.assign(window, {
  TypographicRoles
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/reference-board/TypographicRoles.jsx", error: String((e && e.message) || e) }); }

// ui_kits/reference-board/data.js
try { (() => {
// Catalogs transcribed verbatim from skills/mono-color/design-system/*.json
window.MC_DATA = {
  inks: [{
    id: "ink_cobalt",
    name: "Cobalt",
    hex: "#2148B8"
  }, {
    id: "ink_royal_blue",
    name: "Royal Blue",
    hex: "#2058D4"
  }, {
    id: "ink_botanical_green",
    name: "Botanical Green",
    hex: "#008A4B"
  }, {
    id: "ink_mint_green",
    name: "Mint Green",
    hex: "#5EB783"
  }, {
    id: "ink_terracotta",
    name: "Terracotta Orange",
    hex: "#C65F38"
  }, {
    id: "ink_signal_red",
    name: "Signal Red",
    hex: "#C83232"
  }, {
    id: "ink_aubergine",
    name: "Aubergine",
    hex: "#63365F"
  }, {
    id: "ink_charcoal",
    name: "Charcoal",
    hex: "#30343A"
  }, {
    id: "ink_powder_blue",
    name: "Powder Blue",
    hex: "#9EB8D3"
  }, {
    id: "ink_oxblood",
    name: "Oxblood",
    hex: "#8F3434"
  }, {
    id: "ink_electric_blue",
    name: "Electric Blue",
    hex: "#173AE3"
  }, {
    id: "ink_carbon",
    name: "Carbon",
    hex: "#242321"
  }, {
    id: "ink_mint_charcoal",
    name: "Warm Charcoal",
    hex: "#302D2E"
  }, {
    id: "ink_ultramarine",
    name: "Ultramarine",
    hex: "#263E99"
  }, {
    id: "ink_safety_orange",
    name: "Safety Orange",
    hex: "#E55D2B"
  }, {
    id: "ink_cyan",
    name: "Cyan",
    hex: "#159DDA"
  }, {
    id: "ink_brick_red",
    name: "Brick Red",
    hex: "#B64032"
  }, {
    id: "ink_tangerine",
    name: "Tangerine",
    hex: "#E46C2D"
  }, {
    id: "ink_slate_blue",
    name: "Slate Blue",
    hex: "#4773A5"
  }],
  roles: {
    type_literary: {
      name: "Literary",
      scale_ratio: "6:1 to 12:1",
      behavior: "sentence-like lowercase"
    },
    type_cultural_grotesk: {
      name: "Cultural Grotesk",
      scale_ratio: "8:1 to 16:1",
      behavior: "letters may touch or optically interlock"
    },
    type_condensed_civic: {
      name: "Condensed Civic",
      scale_ratio: "8:1 to 14:1",
      behavior: "stacked public headline"
    },
    type_programmatic: {
      name: "Programmatic",
      scale_ratio: "4:1 to 9:1",
      behavior: "dates and numerals may become the anchor"
    },
    type_rotated_display: {
      name: "Rotated Display",
      scale_ratio: "10:1 to 20:1",
      behavior: "one title rotates 90 degrees"
    },
    type_handwritten_interjection: {
      name: "Handwritten Interjection",
      scale_ratio: "2:1 to 6:1",
      behavior: "one circled note or crossing phrase"
    },
    type_typographic_object: {
      name: "Typographic Object",
      scale_ratio: "12:1 to 20:1",
      behavior: "phrase is the dominant object"
    }
  },
  compositions: [{
    id: "composition_image_field",
    layout: "image field",
    subject: [60, 80],
    paper: [20, 40],
    title: "crosses or is cut by the image"
  }, {
    id: "composition_specimen_annotation",
    layout: "specimen annotation",
    subject: [45, 65],
    paper: [35, 55],
    title: "labels orbit one isolated specimen"
  }, {
    id: "composition_type_declaration",
    layout: "type-led declaration",
    subject: [55, 80],
    paper: [20, 45],
    title: "type is the dominant object"
  }, {
    id: "composition_ruled_information",
    layout: "ruled information poster",
    subject: [45, 65],
    paper: [35, 55],
    title: "headline and facts share one rule"
  }, {
    id: "composition_archival_plate",
    layout: "archival plate",
    subject: [45, 60],
    paper: [40, 55],
    title: "small title indexes the plate"
  }, {
    id: "composition_editorial_cover",
    layout: "editorial cover",
    subject: [55, 75],
    paper: [25, 45],
    title: "headline crosses the dominant crop"
  }, {
    id: "composition_object_field",
    layout: "object field",
    subject: [50, 75],
    paper: [25, 50],
    title: "title locks to repeated objects"
  }, {
    id: "composition_overprint_collage",
    layout: "overprint collage",
    subject: [60, 80],
    paper: [20, 40],
    title: "title participates in one visible overprint collision"
  }, {
    id: "composition_editorial_journal",
    layout: "editorial journal",
    subject: [45, 65],
    paper: [35, 55],
    title: "title sits inside the reading rhythm"
  }],
  carriers: [{
    id: "carrier_wall_poster",
    name: "Wall poster",
    ratios: ["3:4", "2:3"]
  }, {
    id: "carrier_zine",
    name: "Bound zine",
    ratios: ["3:4", "2:3"]
  }, {
    id: "carrier_social_cover",
    name: "Social cover",
    ratios: ["3:4", "4:5"]
  }, {
    id: "carrier_record_sleeve",
    name: "Record or playlist sleeve",
    ratios: ["1:1"]
  }, {
    id: "carrier_packaging",
    name: "Packaging",
    ratios: ["3:4", "1:1"]
  }, {
    id: "carrier_merch",
    name: "Garment merchandise",
    ratios: ["3:4", "4:5"]
  }, {
    id: "carrier_portfolio",
    name: "Portfolio or exhibition",
    ratios: ["3:4", "4:3"]
  }]
};
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/reference-board/data.js", error: String((e && e.message) || e) }); }

__ds_ns.CarrierBadge = __ds_scope.CarrierBadge;

__ds_ns.RuledDataStrip = __ds_scope.RuledDataStrip;

__ds_ns.PlateBadge = __ds_scope.PlateBadge;

__ds_ns.RegistrationMark = __ds_scope.RegistrationMark;

__ds_ns.SectionRule = __ds_scope.SectionRule;

__ds_ns.HalftoneField = __ds_scope.HalftoneField;

__ds_ns.InkPair = __ds_scope.InkPair;

__ds_ns.InkSwatch = __ds_scope.InkSwatch;

__ds_ns.PaperSheet = __ds_scope.PaperSheet;

__ds_ns.CompositionThumb = __ds_scope.CompositionThumb;

__ds_ns.PosterSheet = __ds_scope.PosterSheet;

__ds_ns.DisplayHeading = __ds_scope.DisplayHeading;

__ds_ns.MicroLabel = __ds_scope.MicroLabel;

__ds_ns.SpecimenCaption = __ds_scope.SpecimenCaption;

})();
