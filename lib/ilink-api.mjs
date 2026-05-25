/**
 * iLink Bot API — low-level HTTP helpers.
 *
 * Shared between the extension (jiti-loaded TS) and the CLI (plain .mjs).
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const ILINK_BASE_URL = "https://ilinkai.weixin.qq.com";
export const ILINK_APP_ID = "bot";
export const ILINK_APP_CLIENT_VERSION = String((2 << 16) | (2 << 8) | 0); // 132866
export const CHANNEL_VERSION = "2.2.0";

// ---------------------------------------------------------------------------
// Headers builder
// ---------------------------------------------------------------------------

/**
 * Build headers for an authenticated iLink POST request.
 */
export function ilinkPostHeaders(token, body) {
	const uin = Buffer.from(String(Math.floor(Math.random() * 0xffffffff))).toString("base64");
	return {
		"Content-Type": "application/json",
		Authorization: `Bearer ${token}`,
		AuthorizationType: "ilink_bot_token",
		"Content-Length": String(Buffer.byteLength(body, "utf-8")),
		"X-WECHAT-UIN": uin,
		"iLink-App-Id": ILINK_APP_ID,
		"iLink-App-ClientVersion": ILINK_APP_CLIENT_VERSION,
	};
}

/**
 * Build headers for unauthenticated iLink GET requests (QR polling).
 */
export function ilinkGetHeaders() {
	return {
		"iLink-App-Id": ILINK_APP_ID,
		"iLink-App-ClientVersion": ILINK_APP_CLIENT_VERSION,
	};
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

/**
 * GET with timeout.
 */
export async function ilinkGet(url, timeoutMs = 35_000) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const resp = await fetch(url, {
			signal: controller.signal,
			headers: ilinkGetHeaders(),
		});
		if (!resp.ok) {
			throw new Error(`iLink GET HTTP ${resp.status}: ${(await resp.text().catch(() => "(body)"))}`);
		}
		return await resp.json();
	} finally {
		clearTimeout(timer);
	}
}

/**
 * POST with auth token and timeout.
 */
export async function ilinkPost(url, token, body, timeoutMs = 15_000) {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const resp = await fetch(url, {
			method: "POST",
			headers: ilinkPostHeaders(token, body),
			body,
			signal: controller.signal,
		});
		return { status: resp.status, data: await resp.json() };
	} finally {
		clearTimeout(timer);
	}
}
