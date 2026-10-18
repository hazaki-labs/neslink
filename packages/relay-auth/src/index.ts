// Server-only package. Never export signing/verification code through @neslink/core.
import { SignJWT, jwtVerify, decodeProtectedHeader, base64url } from "jose";
import type { RoomInfo } from "@neslink/core/netplay";

export const TICKET_TTL_SECONDS = 30;
const ISSUER = "neslink:relay";
const TYPE = "neslink-relay+jwt";
export interface SigningKey { kid: string; secret: string }
export type RelayRoomInfo = Pick<RoomInfo, "id" | "romHash" | "romName">;
export interface RelayIdentity { playerId: string; seat: number | null; gameId: string }
export interface ConnectionGrant extends RelayIdentity { room: RelayRoomInfo; origin: string; jti: string; expires: number }

export function secretBytes(secret: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]{43,}$/.test(secret)) throw new Error("Relay keys must be base64url-encoded random bytes (at least 32 bytes)");
  const bytes = base64url.decode(secret);
  if (bytes.length < 32) throw new Error("Relay key is too short");
  return new Uint8Array(bytes);
}

export async function issueTicket(nodeId: string, room: RelayRoomInfo, origin: string, key: SigningKey, identity: RelayIdentity, now = Date.now()) {
  const issued = Math.floor(now / 1000);
  const expires = issued + TICKET_TTL_SECONDS;
  const ticket = await new SignJWT({ room: { id: room.id, romHash: room.romHash, romName: room.romName }, origin, ...identity })
    .setProtectedHeader({ alg: "HS256", typ: TYPE, kid: key.kid })
    .setIssuer(ISSUER).setAudience(nodeId).setJti(crypto.randomUUID())
    .setIssuedAt(issued).setExpirationTime(expires).sign(secretBytes(key.secret));
  return { ticket, expiresAt: expires * 1000 };
}

export async function verifyTicket(
  ticket: string, nodeId: string, roomId: string, origin: string,
  keys: ReadonlyMap<string, string>, now = Date.now(),
): Promise<ConnectionGrant> {
  if (ticket.length > 4096) throw new Error("Invalid ticket");
  const header = decodeProtectedHeader(ticket);
  const secret = typeof header.kid === "string" ? keys.get(header.kid) : undefined;
  if (!secret || header.typ !== TYPE) throw new Error("Invalid ticket");
  const { payload } = await jwtVerify(ticket, secretBytes(secret), {
    algorithms: ["HS256"], issuer: ISSUER, audience: nodeId, typ: TYPE,
    requiredClaims: ["exp", "iat", "jti"], currentDate: new Date(now), maxTokenAge: "35s",
  });
  const issued = payload.iat!;
  const expires = payload.exp!;
  const room = payload.room as RelayRoomInfo | undefined;
  if (payload.aud !== nodeId || !Number.isInteger(issued) || !Number.isInteger(expires) || expires - issued > TICKET_TTL_SECONDS ||
      expires <= issued || issued > Math.floor(now / 1000) + 5 ||
      typeof payload.jti !== "string" || !/^[a-f0-9-]{36}$/.test(payload.jti) ||
      payload.origin !== origin || !room || room.id !== roomId || !/^[a-z0-9]{6}$/.test(room.id) ||
      typeof room.romHash !== "string" || !/^[a-f0-9]{40}$/.test(room.romHash) ||
      typeof room.romName !== "string" || room.romName.length > 100 ||
      typeof payload.playerId !== "string" || !/^[a-f0-9-]{8,36}$/.test(payload.playerId) ||
      typeof payload.gameId !== "string" || !/^[a-f0-9-]{36}$/.test(payload.gameId) ||
      (payload.seat !== null && payload.seat !== 0 && payload.seat !== 1)) throw new Error("Invalid ticket");
  return { room, origin, jti: payload.jti, expires, playerId: payload.playerId, gameId: payload.gameId, seat: payload.seat as number | null };
}
