type SvgIconDefinition = {
  viewBox: string;
  fill: string;
  stroke: string;
  strokeWidth: number;
  strokeLinejoin?: "round";
  strokeLinecap?: "round";
  paths: readonly string[];
};

// Toolbar and chrome icons share one 16px grid, 1.5px rounded stroke style.
const line = (...paths: string[]) =>
  ({
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.5,
    strokeLinejoin: "round",
    strokeLinecap: "round",
    paths,
  }) as const;

export const iconPaths = {
  copyLeft: {
    viewBox: "0 0 16 12",
    fill: "currentColor",
    stroke: "none",
    strokeWidth: 0,
    paths: ["M15 4.5H7V1L1 6l6 5V7.5h8z"],
  },
  copyRight: {
    viewBox: "0 0 16 12",
    fill: "currentColor",
    stroke: "none",
    strokeWidth: 0,
    paths: ["M1 4.5h8V1l6 5-6 5V7.5H1z"],
  },
  workflowFolder: {
    viewBox: "0 0 48 48",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    paths: ["M5 14V8h14l5 6h19v27H5z", "M5 19h38M16 28h16m-5-5 5 5-5 5"],
  },
  workflowText: {
    viewBox: "0 0 48 48",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    paths: ["M8 5h23l9 9v29H8zM31 5v10h9M15 22h18M15 28h18M15 34h11"],
  },
  workflowMerge: {
    viewBox: "0 0 48 48",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    paths: [
      "M8 5h23l9 9v29H8zM31 5v10h9M15 22h18M15 28h18M15 34h11",
      "m4 19 8 7-8 7m40-14-8 7 8 7",
    ],
  },
  folder: {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1,
    strokeLinejoin: "round",
    paths: ["M1.5 13.5v-11h5l2 2h6v9Z"],
  },
  openFolder: {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1,
    strokeLinejoin: "round",
    paths: ["M1.5 13.5v-11h5l2 2h6v9Z", "m1.5 13.5 2-7h12l-2 7Z"],
  },
  file: {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1,
    strokeLinejoin: "round",
    paths: ["M3 1.5h6l4 4v9H3Zm6 0v4h4M5 8h6m-6 3h6"],
  },
  error: {
    viewBox: "0 0 16 16",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1,
    strokeLinejoin: "round",
    paths: ["M8 1 15 14H1ZM8 5v4m0 2v1"],
  },
  link: line(
    "M6.5 9.5 9.5 6.5",
    "M7 4.5 8.2 3.3a2.5 2.5 0 0 1 3.5 3.5L10.5 8",
    "M9 11.5l-1.2 1.2a2.5 2.5 0 0 1-3.5-3.5L5.5 8",
  ),
  home: line("M2 7.5 8 2.5l6 5", "M3.5 6.5v7h9v-7M6.5 13.5v-4h3v4"),
  all: line("M3 4h10M3 8h10M3 12h10"),
  differences: line("M3.5 6h9M3.5 10h9M10 3 6 13"),
  same: line("M3.5 6h9M3.5 10h9"),
  context: line("M3.5 8h.01M8 8h.01M12.5 8h.01"),
  minor: line("M2.5 9c1.5-3 3-3 5.5 0s4 3 5.5 0"),
  whitespace: line("M7 13V3M10 13V3M10 3H6.5a2.5 2.5 0 0 0 0 5H7"),
  inline: line("M2.5 13.5h11M4.5 10.5 8 3l3.5 7.5M5.8 8.5h4.4"),
  anchor: line("M8 2.5v8M5 8l3 3 3-3M3.5 13.5h9"),
  clear: line("M4 4l8 8M12 4l-8 8"),
  close: line("M4 4l8 8M12 4l-8 8"),
  settings: line(
    "M2.5 5h6M11.5 5h2M2.5 11h2M7.5 11h6",
    "M8.5 5a1.5 1.5 0 1 0 3 0 1.5 1.5 0 1 0-3 0M4.5 11a1.5 1.5 0 1 0 3 0 1.5 1.5 0 1 0-3 0",
  ),
  format: line("M2.5 3.5h11M2.5 7h7M2.5 10.5h11M2.5 14h7"),
  search: line(
    "M7 11.5a4.5 4.5 0 1 0 0-9 4.5 4.5 0 0 0 0 9Z",
    "m10.5 10.5 3.5 3.5",
  ),
  refresh: line("M13 8a5 5 0 1 1-1.6-3.7", "M13 2.5v3h-3"),
  copy: line("M2.5 8h11M5 5.5 2.5 8 5 10.5M11 5.5 13.5 8 11 10.5"),
  expand: line("M8 3v10M3 8h10"),
  collapse: line("M3 8h10"),
  plus: line("M8 3v10M3 8h10"),
  swap: line("M2.5 5.5h10M10 3l2.5 2.5L10 8M13.5 10.5h-10M6 8l-2.5 2.5L6 13"),
  stop: line("M4 4h8v8H4Z"),
  filters: line("M2.5 3h11L9.5 8.5V13l-3-1.5V8.5Z"),
  peek: line(
    "M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z",
    "M8 10a2 2 0 1 0 0-4 2 2 0 0 0 0 4Z",
  ),
  chevronLeft: line("M10 3 5 8l5 5"),
  chevronRight: line("M6 3l5 5-5 5"),
  chevronUp: line("M3 10l5-5 5 5"),
  chevronDown: line("M3 6l5 5 5-5"),
  arrowUp: line("M8 13V3M4 7l4-4 4 4"),
  arrowDown: line("M8 3v10M4 9l4 4 4-4"),
  save: line("M2.5 2.5h9l2 2v9h-11Z", "M5 2.5v3.5h5V2.5M5 13.5V9h6v4.5"),
  saveAs: line(
    "M9 13.5H2.5v-11h9l2 2V8",
    "M5 2.5v3.5h5V2.5M5 13.5V9h3M12 10v4M10 12h4",
  ),
  undo: line("M5 3.5 2.5 6 5 8.5M2.5 6h7a3.5 3.5 0 0 1 0 7H6"),
  redo: line("M11 3.5 13.5 6 11 8.5M13.5 6h-7a3.5 3.5 0 0 0 0 7H10"),
  more: line("M3.5 8h.01M8 8h.01M12.5 8h.01"),
  sessions: line("M4.5 2.5h7v11L8 10.5l-3.5 3Z"),
  history: line(
    "M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11Z",
    "M8 5v3l2 1.5",
  ),
  sun: line(
    "M8 10.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5Z",
    "M8 1.5V3M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M12.6 3.4l-1 1M4.4 11.6l-1 1",
  ),
  moon: line("M13 9.5A5.5 5.5 0 0 1 6.5 3a5.5 5.5 0 1 0 6.5 6.5Z"),
  trash: line("M3 4.5h10M6 4.5V3h4v1.5M4.5 4.5l.5 9h6l.5-9"),
  check: line("M3 8.5 6.5 12 13 4.5"),
} as const satisfies Record<string, SvgIconDefinition>;

export const iconSymbols = {
  moveFrom: "↗",
  moveTo: "↙",
} as const;

export type SvgIconName = keyof typeof iconPaths;
export type IconName = SvgIconName | keyof typeof iconSymbols;

type IconProps = {
  name: IconName;
  className?: string;
};

function isSymbolIcon(name: IconName): name is keyof typeof iconSymbols {
  return Object.hasOwn(iconSymbols, name);
}

export function Icon({ name, className }: IconProps) {
  if (isSymbolIcon(name))
    return (
      <span aria-hidden="true" className={className} data-icon={name}>
        {iconSymbols[name]}
      </span>
    );
  const definition: SvgIconDefinition = iconPaths[name];
  return (
    <svg
      viewBox={definition.viewBox}
      fill={definition.fill}
      stroke={definition.stroke}
      strokeWidth={definition.strokeWidth}
      strokeLinejoin={definition.strokeLinejoin}
      strokeLinecap={definition.strokeLinecap}
      aria-hidden="true"
      focusable="false"
      className={className}
      data-icon={name}
    >
      {definition.paths.map((d) => (
        <path key={d} d={d} />
      ))}
    </svg>
  );
}

export function createIconElement(
  name: SvgIconName,
  className: string,
): SVGSVGElement {
  const definition: SvgIconDefinition = iconPaths[name];
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("viewBox", definition.viewBox);
  svg.setAttribute("fill", definition.fill);
  svg.setAttribute("stroke", definition.stroke);
  svg.setAttribute("stroke-width", String(definition.strokeWidth));
  if (definition.strokeLinejoin)
    svg.setAttribute("stroke-linejoin", definition.strokeLinejoin);
  if (definition.strokeLinecap)
    svg.setAttribute("stroke-linecap", definition.strokeLinecap);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  svg.dataset.icon = name;
  for (const d of definition.paths) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}
