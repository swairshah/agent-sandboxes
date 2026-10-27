import { expect, test } from "bun:test";
import { authProtocols, tokenFromProtocols } from "./protocol.ts";
import { issueOrbToken, verifyOrbToken } from "./tokens.ts";

const secret = "test-secret";

test("orb tokens round-trip", () => {
	const token = issueOrbToken(secret, { orb: "moonlet-1", gen: 3, exp: Date.now() + 60_000 });
	expect(verifyOrbToken(secret, token)).toMatchObject({ orb: "moonlet-1", gen: 3 });
});

test("orb tokens reject tampering, other secrets and expiry", () => {
	const token = issueOrbToken(secret, { orb: "moonlet-1", gen: 3, exp: Date.now() + 60_000 });
	const [kind, , signature] = token.split(".");
	const forged = `${kind}.${Buffer.from(JSON.stringify({ orb: "moonlet-2", gen: 3, exp: Date.now() + 60_000 })).toString("base64url")}.${signature}`;
	expect(verifyOrbToken(secret, forged)).toBeUndefined();
	expect(verifyOrbToken("other", token)).toBeUndefined();
	expect(verifyOrbToken(secret, issueOrbToken(secret, { orb: "o", gen: 1, exp: Date.now() - 1 }))).toBeUndefined();
	expect(verifyOrbToken(secret, "garbage")).toBeUndefined();
});

test("tokens travel in the WebSocket subprotocol header", () => {
	const header = authProtocols("orb.abc.def").join(", ");
	expect(tokenFromProtocols(header)).toBe("orb.abc.def");
	expect(tokenFromProtocols("moonlet.v1")).toBeUndefined();
	expect(tokenFromProtocols(null)).toBeUndefined();
});
