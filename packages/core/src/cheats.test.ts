import { describe, expect, it } from "vitest";
import { cheatPatches, decodeGameGenie, normalizeCheat, parseCheat } from "./cheats";

/** Decoded by tetanes-core's own Game Genie parser: [code, addr, data, compare]. */
const TETANES_VECTORS: [string, number, number, number | null][] = [
  ["KGIXNS", 44383, 204, null],
  ["SXXIKUVN", 56228, 173, 254],
  ["LAOKSA", 51229, 3, null],
  ["NONASGKG", 36085, 151, 196],
  ["SZUTEL", 60208, 165, null],
  ["XZNNVYEO", 65406, 170, 144],
  ["PVOAUE", 34963, 105, null],
  ["IIKOOPNT", 39241, 85, 231],
  ["TZVNKO", 63852, 46, null],
  ["ISUGEXOK", 51888, 93, 201],
  ["GLZVTN", 59182, 60, null],
  ["LXSKGSPV", 50652, 43, 105],
  ["ONATYK", 58503, 249, null],
  ["KGYZTSKA", 42358, 196, 140],
  ["OXGOTT", 38606, 161, null],
  ["AULTGZZI", 58036, 48, 82],
  ["SULYIX", 62133, 189, null],
  ["XXEXVUGE", 43918, 170, 12],
  ["TVLVLX", 58043, 110, null],
  ["EASEUENX", 34907, 136, 175],
  ["GZZKEY", 53032, 36, null],
  ["UKYXGEZI", 41212, 195, 90],
  ["UUSAKY", 36820, 179, null],
  ["ETNZSEPP", 43125, 224, 25],
  ["OVLIUZ", 55987, 225, null],
  ["IYVXPGTE", 42089, 125, 6],
  ["YOKGUV", 52931, 31, null],
  ["OIPZGPGX", 41236, 217, 36],
  ["KXOEGI", 34204, 164, null],
  ["YSZEZNIU", 34730, 95, 61],
  ["KOXKUI", 52651, 148, null],
  ["VNEXAKKT", 42120, 246, 236],
  ["VYUXUS", 44347, 254, null],
  ["VYLLZKNN", 46130, 254, 255],
  ["ZKYLIZ", 45813, 66, null],
  ["USYIANEO", 55280, 219, 152],
  ["XNYXVN", 45054, 250, null],
  ["KOGXEIVL", 44488, 148, 182],
  ["SEKSSY", 57293, 133, null],
  ["UOGYZLGN", 62402, 155, 116]
];

describe("decodeGameGenie", () => {
  it("decodes like tetanes-core", () => {
    for (const [code, addr, data, compare] of TETANES_VECTORS) {
      expect(decodeGameGenie(code), code).toEqual({ addr, data, compare });
    }
  });

  it("decodes a well-known code and rejects non-codes", () => {
    // Super Mario Bros.: infinite lives.
    expect(decodeGameGenie("sxiopo")).toEqual({ addr: 0x91d9, data: 0xad, compare: null });
    expect(decodeGameGenie("SXIOP")).toBeNull();
    expect(decodeGameGenie("SXIOPB")).toBeNull();
  });
});

describe("parseCheat", () => {
  it("reads raw, Pro Action Replay and joined codes", () => {
    expect(parseCheat("0032:09")).toEqual([{ addr: 0x32, data: 9, compare: null }]);
    expect(parseCheat("7e0:ff:01")).toEqual([{ addr: 0x7e0, data: 0xff, compare: 1 }]);
    expect(parseCheat("00075A09")).toEqual([{ addr: 0x75a, data: 9, compare: null }]);
    expect(parseCheat("SXIOPO + 0032:09")).toHaveLength(2);
    expect(parseCheat("SXIOPO + nope")).toBeNull();
    expect(parseCheat("  ")).toBeNull();
  });

  it("normalizes and skips invalid codes in a list", () => {
    expect(normalizeCheat(" sxiopo, 0032:09 ")).toBe("SXIOPO+0032:09");
    expect(cheatPatches(["0032:09", "bad!", "0033:01"]).map((p) => p.addr)).toEqual([0x32, 0x33]);
  });
});
