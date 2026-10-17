export interface RomInfo {
  mapper: number;
  prgRomKiB: number;
  chrRomKiB: number;
  battery: boolean;
}

/** Parse and validate an iNES / NES 2.0 header. Throws on non-NES data. */
export function parseRomHeader(rom: Uint8Array): RomInfo {
  if (
    rom.length < 16 ||
    rom[0] !== 0x4e || // N
    rom[1] !== 0x45 || // E
    rom[2] !== 0x53 || // S
    rom[3] !== 0x1a
  ) {
    throw new Error("Not an iNES ROM (missing NES<EOF> header)");
  }
  return {
    mapper: (rom[6] >> 4) | (rom[7] & 0xf0),
    prgRomKiB: rom[4] * 16,
    chrRomKiB: rom[5] * 8,
    battery: (rom[6] & 0x02) !== 0,
  };
}

/** SHA-1 of the ROM, hex encoded. Netplay uses it to check everyone has the same file. */
export async function hashRom(rom: Uint8Array<ArrayBuffer>): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", rom);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
