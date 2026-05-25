/**
 * WeiXin iLink QR login — plain .mjs, no TypeScript dependency.
 * Used by the CLI (`pi gateway login -p weixin`).
 *
 * Same flow as qr-login.ts but in plain JS for direct Node.js execution.
 */

import { ilinkGet, ILINK_BASE_URL } from "./ilink-api.mjs";

const QR_POLL_INTERVAL_MS = 1000;
const QR_REFRESH_LIMIT = 3;
const LOGIN_TIMEOUT_SECONDS = 480;

/**
 * @param {(status: string, detail?: string) => void} onStatus
 * @param {number} timeoutSeconds
 * @returns {Promise<{accountId: string, token: string, baseUrl: string, userId: string}|null>}
 */
export async function qrLogin(onStatus, timeoutSeconds = LOGIN_TIMEOUT_SECONDS) {
	let qrCode = null;
	let qrUrl = null;
	let currentBaseUrl = ILINK_BASE_URL;
	let refreshCount = 0;
	const deadline = Date.now() + timeoutSeconds * 1000;

	async function fetchQrCode() {
		try {
			const resp = await ilinkGet(`${ILINK_BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=3`);
			qrCode = resp.qrcode || null;
			qrUrl = resp.qrcode_img_content || null;
			if (!qrCode) {
				onStatus?.("error", "QR response missing qrcode field");
				return false;
			}
			return true;
		} catch (err) {
			onStatus?.("error", `Failed to fetch QR code: ${err.message}`);
			return false;
		}
	}

	async function renderQr() {
		const scanData = qrUrl || qrCode;
		if (!scanData) return null;
		try {
			const qrcode = await import("qrcode");
			return await qrcode.toString(scanData, { type: "terminal", small: true });
		} catch {
			return scanData;
		}
	}

	// Initial fetch
	const ok = await fetchQrCode();
	if (!ok) return null;

	const qrArt = await renderQr();
	if (qrArt) onStatus?.("qr_art", qrArt);
	if (qrUrl) onStatus?.("qr_url", qrUrl);

	// Poll loop
	while (Date.now() < deadline) {
		try {
			const resp = await ilinkGet(
				`${currentBaseUrl}/ilink/bot/get_qrcode_status?qrcode=${qrCode}`,
			);

			const status = resp.status || "wait";

			switch (status) {
				case "wait":
					onStatus?.("wait");
					await sleep(QR_POLL_INTERVAL_MS);
					continue;

				case "scaned":
					onStatus?.("scaned");
					await sleep(QR_POLL_INTERVAL_MS);
					continue;

				case "scaned_but_redirect": {
					if (resp.redirect_host) {
						currentBaseUrl = `https://${resp.redirect_host}`;
						onStatus?.("redirect", resp.redirect_host);
					}
					await sleep(QR_POLL_INTERVAL_MS);
					continue;
				}

				case "expired": {
					refreshCount++;
					if (refreshCount > QR_REFRESH_LIMIT) {
						onStatus?.("error", "QR code expired too many times (max 3)");
						return null;
					}
					onStatus?.("expired", `Refreshing (${refreshCount}/${QR_REFRESH_LIMIT})`);

					const refreshed = await fetchQrCode();
					if (!refreshed) return null;

					const newQrArt = await renderQr();
					if (newQrArt) onStatus?.("qr_art", newQrArt);
					if (qrUrl) onStatus?.("qr_url", qrUrl);
					await sleep(QR_POLL_INTERVAL_MS);
					continue;
				}

				case "confirmed": {
					const accountId = resp.ilink_bot_id || "";
					const token = resp.bot_token || "";
					const baseUrl = resp.baseurl || ILINK_BASE_URL;
					const userId = resp.ilink_user_id || "";

					if (!accountId || !token) {
						onStatus?.("error", "Confirmed but credentials incomplete");
						return null;
					}

					const creds = { accountId, token, baseUrl, userId };
					onStatus?.("confirmed", JSON.stringify(creds));
					return creds;
				}

				default:
					onStatus?.("error", `Unknown status: ${status}`);
					await sleep(QR_POLL_INTERVAL_MS);
					continue;
			}
		} catch (err) {
			if (err?.name === "AbortError") {
				onStatus?.("error", "Request timed out");
				return null;
			}
			onStatus?.("error", `Poll error: ${err.message}`);
			await sleep(QR_POLL_INTERVAL_MS);
		}
	}

	onStatus?.("error", "Login timed out");
	return null;
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
