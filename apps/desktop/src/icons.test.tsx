import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Icon, iconPaths, iconSymbols } from "./icons";

describe("named SVG icon paths", () => {
  it("defines non-empty vector paths for every named icon", () => {
    for (const [name, icon] of Object.entries(iconPaths)) {
      expect(icon.viewBox, name).toBeTruthy();
      expect(icon.paths.length, name).toBeGreaterThan(0);
      for (const path of icon.paths) expect(path.trim(), name).toBeTruthy();
    }
  });

  it("defines a glyph for every named toolbar symbol", () => {
    for (const [name, symbol] of Object.entries(iconSymbols))
      expect(symbol.trim(), name).toBeTruthy();
  });

  it("renders path icons and toolbar glyphs from their names", () => {
    expect(renderToStaticMarkup(<Icon name="copyRight" />)).toContain(
      'data-icon="copyRight"',
    );
    expect(renderToStaticMarkup(<Icon name="home" />)).toContain(
      `data-icon="home">${iconSymbols.home}</span>`,
    );
  });
});
