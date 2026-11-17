import { useLayoutEffect, useState } from "react";

const palettes = {
  slate: "冰川蓝",
  cypress: "冷杉绿",
  walnut: "胡桃棕",
  iris: "鸢尾紫",
  darcula: "Darcula 深色",
} as const;
type Palette = keyof typeof palettes;
const preferenceKey = "superagent.content-palette";

function isPalette(value: string | null): value is Palette {
  return value !== null && Object.hasOwn(palettes, value);
}

function initialPalette(): Palette {
  try {
    const stored = window.localStorage.getItem(preferenceKey);
    if (isPalette(stored)) return stored;
  } catch {
    // The palette still works for this page when storage is unavailable.
  }
  return "slate";
}

export function ContentPaletteSelect() {
  const [palette, setPalette] = useState(initialPalette);

  useLayoutEffect(() => {
    document.documentElement.dataset.contentPalette = palette;
    return () => { delete document.documentElement.dataset.contentPalette; };
  }, [palette]);

  return (
    <label className="ide-palette">
      <span className="ide-palette-dot" aria-hidden="true" />
      <select aria-label="内容区配色" value={palette} onChange={event => {
        const value = event.currentTarget.value;
        if (!isPalette(value)) return;
        setPalette(value);
        try {
          window.localStorage.setItem(preferenceKey, value);
        } catch {
          // Keep the in-memory choice.
        }
      }}>
        {Object.entries(palettes).map(([id, label]) => <option key={id} value={id}>{label}</option>)}
      </select>
    </label>
  );
}
