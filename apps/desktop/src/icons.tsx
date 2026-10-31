type SvgIconDefinition = {
  viewBox: string;
  fill: string;
  stroke: string;
  strokeWidth: number;
  strokeLinejoin?: "round";
  paths: readonly string[];
};

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
} as const satisfies Record<string, SvgIconDefinition>;

export const iconSymbols = {
  home: "⌂",
  all: "*",
  differences: "≠",
  same: "=",
  context: "⋯",
  minor: "~",
  whitespace: "·",
  anchor: "↧",
  clear: "×",
  settings: "⚙",
  format: "▤",
  search: "⌕",
  refresh: "↻",
  copy: "↔",
  expand: "+",
  collapse: "−",
  swap: "⇄",
  stop: "x",
  filters: "▽",
  peek: "◉",
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
