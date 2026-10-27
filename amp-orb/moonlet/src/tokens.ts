import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/**
 * Signed, expiring capability tokens: `<kind>.<payload>.<signature>`, base64url.
 * The server signs them with its secret; nothing else needs to verify them.
 */
export interface OrbClaims {
	/** The orb this token connects. */
	orb: string;
	/** Spawn generation. A token of an older spawn is refused, which retires stale bootstraps. */
	gen: number;
	/** Expiry, epoch milliseconds. */
	exp: number;
}

const b64 = (value: Buffer | string) => Buffer.from(value).toString("base64url");

function sign(secret: string, kind: string, payload: string) {
	return createHmac("sha256", secret).update(`${kind}.${payload}`).digest("base64url");
}

export function issueOrbToken(secret: string, claims: OrbClaims): string {
	const payload = b64(JSON.stringify(claims));
	return `orb.${payload}.${sign(secret, "orb", payload)}`;
}

export function verifyOrbToken(secret: string, token: string, now = Date.now()): OrbClaims | undefined {
	const [kind, payload, signature] = token.split(".");
	if (kind !== "orb" || payload === undefined || signature === undefined) return undefined;
	const expected = Buffer.from(sign(secret, kind, payload));
	const actual = Buffer.from(signature);
	if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return undefined;
	try {
		const claims = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as OrbClaims;
		if (typeof claims.orb !== "string" || typeof claims.gen !== "number" || typeof claims.exp !== "number") return undefined;
		return claims.exp > now ? claims : undefined;
	} catch {
		return undefined;
	}
}

export function randomSecret(prefix = ""): string {
	return prefix + randomBytes(24).toString("base64url");
}

export function safeEqual(a: string, b: string): boolean {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	return left.length === right.length && timingSafeEqual(left, right);
}
