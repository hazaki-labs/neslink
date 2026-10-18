import { describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import { issueTicket, secretBytes, verifyTicket } from "./index";

const secret = "dGVzdC1vbmx5LW5vdC1hLXByb2R1Y3Rpb24ta2V5LTEyMzQ1Njc4OTA";
const key = { kid: "test-key", secret };
const keys = new Map([[key.kid, secret]]);
const room = { id: "abcdef", romHash: "a".repeat(40), romName: "Test" };
const identity = { playerId: "12345678", seat: 0, gameId: "11111111-1111-4111-8111-111111111111" };
const origin = "https://nes.example";
const now = 1_800_000_000_000;
const verify = (token: string, at = now) => verifyTicket(token, "east", room.id, origin, keys, at);

describe("connection tickets", () => {
  it("issues a new nonce per attempt, with exactly a 30 second connection window", async () => {
    const a = await issueTicket("east", room, origin, key, identity, now);
    const b = await issueTicket("east", room, origin, key, identity, now);
    const ga = await verify(a.ticket); const gb = await verify(b.ticket);
    expect(ga.jti).not.toBe(gb.jti);
    expect(ga.seat).toBe(0);
    expect(a.expiresAt).toBe(now + 30_000);
    await expect(verify(a.ticket, now + 30_000)).rejects.toThrow();
  });
  it("binds node, room, and origin", async () => {
    const { ticket } = await issueTicket("east", room, origin, key, identity, now);
    await expect(verifyTicket(ticket, "west", room.id, origin, keys, now)).rejects.toThrow();
    await expect(verifyTicket(ticket, "east", "ghjkmn", origin, keys, now)).rejects.toThrow();
    await expect(verifyTicket(ticket, "east", room.id, "https://evil.example", keys, now)).rejects.toThrow();
  });
  it("rejects tampering, unknown/retired keys, future issue times, and weak keys", async () => {
    const { ticket } = await issueTicket("east", room, origin, key, identity, now);
    const parts = ticket.split("."); parts[1] = parts[1].slice(0, -3) + "AAA";
    await expect(verify(parts.join("."))).rejects.toThrow();
    await expect(verifyTicket(ticket, "east", room.id, origin, new Map(), now)).rejects.toThrow();
    await expect(verify(ticket, now - 10_000)).rejects.toThrow();
    expect(() => secretBytes("short")).toThrow();
  });
  it("accepts a previous key during rotation, but rejects a signed token with the wrong algorithm/type/lifetime", async () => {
    const { ticket } = await issueTicket("east", room, origin, key, identity, now);
    await expect(verifyTicket(ticket, "east", room.id, origin, new Map([["new", secret], ...keys]), now)).resolves.toMatchObject({ seat: 0 });
    for (const [alg, typ, lifetime] of [["HS384", "neslink-relay+jwt", 30], ["HS256", "JWT", 30], ["HS256", "neslink-relay+jwt", 60]] as const) {
      const token = await new SignJWT({ room, origin, ...identity }).setProtectedHeader({ alg, typ, kid: key.kid })
        .setIssuer("neslink:relay").setAudience("east").setJti(crypto.randomUUID())
        .setIssuedAt(now / 1000).setExpirationTime(now / 1000 + lifetime)
        .sign(alg === "HS384" ? new Uint8Array(64).fill(7) : secretBytes(secret));
      await expect(verify(token)).rejects.toThrow();
    }
  });
});
