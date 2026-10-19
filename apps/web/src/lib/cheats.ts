import type { Cheat } from "@neslink/core";

/** Cheats are kept per ROM in this browser. */
function cheatsKey(romHash: string) {
  return `neslink:cheats:${romHash}`;
}

export function loadCheats(romHash: string): Cheat[] {
  try {
    const saved = JSON.parse(localStorage.getItem(cheatsKey(romHash)) ?? "[]") as unknown;
    if (!Array.isArray(saved)) return [];
    return saved.filter(
      (c): c is Cheat => c && typeof c.code === "string" && typeof c.name === "string" && typeof c.enabled === "boolean",
    );
  } catch {
    return [];
  }
}

export function saveCheats(romHash: string, cheats: Cheat[]): void {
  try {
    localStorage.setItem(cheatsKey(romHash), JSON.stringify(cheats));
  } catch {
    // Not kept for next time; they still apply now.
  }
}
