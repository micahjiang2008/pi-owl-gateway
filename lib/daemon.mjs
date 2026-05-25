#!/usr/bin/env node
/**
 * Gateway daemon — runs in background, managed by pi-owl-gateway start/stop.
 */

import { readFileSync, existsSync, appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import https from "node:https";

// ────────────────────────────────────────────────────────────────────────────
// State (persistent across handler invocations)
// ────────────────────────────────────────────────────────────────────────────

let _session = null;           // AgentSession (reused across messages)
let _replyResolve = null;      // Promise resolve for current AI reply
let _workDir = "";             // Resolved workspace directory
let _lastMessageTime = 0;      // Unix ms of last user message

// ────────────────────────────────────────────────────────────────────────────
// Paths / Config
// ────────────────────────────────────────────────────────────────────────────

function getAgentDir() {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function logPath() {
	return join(getAgentDir(), "gateway-daemon.log");
}

function log(msg) {
	const line = `[${new Date().toISOString()}] ${msg}\n`;
	try {
		appendFileSync(logPath(), line, "utf-8");
	} catch {}
}

// ────────────────────────────────────────────────────────────────────────────
// Settings
// ────────────────────────────────────────────────────────────────────────────

function readSettings() {
	const p = join(getAgentDir(), "settings.json");
	if (!existsSync(p)) return {};
	try {
		return JSON.parse(readFileSync(p, "utf-8"));
	} catch {
		return {};
	}
}

function gwSettings(settings) {
	return (settings["pi-owl-gateway"] || {}) ;
}

/**
 * Resolve the effective workspace directory.
 *
 * Priority:
 *   1. weixin.workDir (per-platform)
 *   2. defaultWorkDir (global gateway)
 *   3. ~/.pi/gateway-workspace (hardcoded fallback)
 */
function resolveWorkDir(settings, platform) {
	const gw = gwSettings(settings);
	const platformCfg = gw[platform] || {};
	const raw = (platformCfg["work-dir"] || gw["default-work-dir"] || "").trim();

	let dir = raw ? resolve(raw.replace(/^~/, homedir())) : resolve(join(homedir(), ".pi", "gateway-workspace"));

	if (!existsSync(dir)) {
		mkdirSync(dir, { recursive: true });
		log(`Created workDir: ${dir}`);
	}
	return dir;
}

// ────────────────────────────────────────────────────────────────────────────
// iLink API (node:https, no fetch — avoids SDK undici interference)
// ────────────────────────────────────────────────────────────────────────────

function httpsPost(url, body, token) {
	return new Promise((resolve, reject) => {
		const u = new URL(url);
		const uin = Buffer.from(String(Math.floor(Math.random() * 0xffffffff))).toString("base64");
		const data = Buffer.from(body, "utf-8");
		const opts = {
			hostname: u.hostname,
			port: 443,
			path: u.pathname + u.search,
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
				AuthorizationType: "ilink_bot_token",
				"Content-Length": String(data.length),
				"X-WECHAT-UIN": uin,
				"iLink-App-Id": "bot",
				"iLink-App-ClientVersion": String((2 << 16) | (2 << 8) | 0),
			},
		};
		const req = https.request(opts, (res) => {
			let c = "";
			res.on("data", (d) => (c += d));
			res.on("end", () => resolve({ status: res.statusCode, body: c }));
		});
		req.on("error", reject);
		req.setTimeout(15_000, () => {
			req.destroy();
			reject(new Error("timeout"));
		});
		req.end(data);
	});
}

async function sendWeiXinMessage(token, baseUrl, toUserId, text, contextToken) {
	const clientId = `gw-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	const msg = {
		from_user_id: "",
		to_user_id: toUserId,
		client_id: clientId,
		message_type: 2,
		message_state: 2,
		item_list: [{ type: 1, text_item: { text } }],
	};
	if (contextToken) msg.context_token = contextToken;
	const body = JSON.stringify({ msg, base_info: { channel_version: "2.2.0" } });
	const url = `${baseUrl.replace(/\/+$/, "")}/ilink/bot/sendmessage`;
	const { status } = await httpsPost(url, body, token);
	return status === 200;
}

// ────────────────────────────────────────────────────────────────────────────
// Session management
// ────────────────────────────────────────────────────────────────────────────

async function ensureSession() {
	if (_session) {
		// Check if session is stale (new day or >2h idle) → auto-new
		const now = Date.now();
		const today = new Date().toISOString().slice(0, 10);

		// Get session creation date from its file path if possible
		const sessionFile = _session.sessionFile;
		if (sessionFile) {
			const fileDate = sessionFile.slice(-15, -6); // "2026-05-25"
			if (fileDate !== today) {
				log(`New day detected (${fileDate} → ${today}), starting new session`);
				await disposeSession();
			}
		}

		// 2h idle threshold
		if (_session && now - _lastMessageTime > 7_200_000) {
			log("2h idle, starting new session");
			await disposeSession();
		}
	}

	if (_session) return _session;

	const { createAgentSession, SessionManager, AuthStorage, ModelRegistry } = await import(
		"@earendil-works/pi-coding-agent"
	);

	const authStorage = AuthStorage.create(getAgentDir());
	const modelRegistry = ModelRegistry.create(authStorage, join(getAgentDir(), "models.json"));

	// continueRecent: resumes the most recent session, or creates a new one
	const sm = SessionManager.continueRecent(_workDir);
	const result = await createAgentSession({
		sessionManager: sm,
		authStorage,
		modelRegistry,
		cwd: _workDir,
	});
	_session = result.session;

	// Subscribe once — agent_end fires after ALL turns complete
	_session.subscribe((event) => {
		if (event.type === "agent_end" && _replyResolve) {
			// Walk all messages, keep last assistant text
			let lastText = "";
			for (const msg of event.messages || []) {
				if (msg.role === "assistant") {
					const t = extractAssistantText(msg);
					if (t) lastText = t;
				}
			}
			if (lastText) {
				_replyResolve(lastText);
				_replyResolve = null;
			}
		}
	});

	const f = _session.sessionFile || "(in-memory)";
	log(`Session: ${f}`);
	return _session;
}

async function disposeSession() {
	if (_session) {
		try {
			_session.dispose();
		} catch {
			/* SDK cleanup noise */
		}
		_session = null;
	}
}

function extractAssistantText(msg) {
	const content = msg.content;
	if (!content) return "";
	if (typeof content === "string") return content.trim();
	if (Array.isArray(content)) {
		return content
			.filter((b) => b.type === "text" && b.text)
			.map((b) => b.text)
			.join("\n")
			.trim();
	}
	return "";
}

/**
 * Check if the user's text is requesting a new conversation.
 */
function isNewSessionRequest(text) {
	const t = text.trim().toLowerCase();
	return (
		t.includes("新对话") ||
		t.includes("新建对话") ||
		t.includes("新会话") ||
		t.includes("开个新") ||
		t.includes("重新开始") ||
		t.includes("new chat") ||
		t.includes("new session") ||
		t.includes("start over") ||
		t.includes("reset")
	);
}

// ────────────────────────────────────────────────────────────────────────────
// Process a single WeiXin message → AI → reply
// ────────────────────────────────────────────────────────────────────────────

async function processMessage(text, fromUserId, ctxToken, baseUrl, token) {
	// Check for "new session" request
	if (isNewSessionRequest(text)) {
		await disposeSession();
		// Still process normally — agent will start fresh and respond
	}

	const session = await ensureSession();
	_lastMessageTime = Date.now();

	const reply = await new Promise((resolve) => {
		_replyResolve = resolve;
		session.prompt(text).catch(() => {
			if (_replyResolve) {
				_replyResolve("");
				_replyResolve = null;
			}
		});
	});

	if (!reply) {
		log("No AI response generated");
		return;
	}

	// Append END marker so user knows reply is complete
	const endMarker = "\n\nEND!";
	const maxLen = 1800;
	const withEnd = reply + endMarker;
	const truncated = withEnd.length > maxLen;
	const final = truncated ? withEnd.slice(0, maxLen - 15) + "\n\n[截断]" : withEnd;
	try {
		const ok = await sendWeiXinMessage(token, baseUrl, fromUserId, final, ctxToken);
		log(`📤 WeiXin: ${ok ? "sent" : "send failed"} (${final.length}/${reply.length} chars)`);
	} catch (err) {
		log(`📤 send error: ${err.message}`);
	}
}

// ────────────────────────────────────────────────────────────────────────────
// Message queue (sequential AI processing)
// ────────────────────────────────────────────────────────────────────────────

let _busy = false;
const _queue = [];

function enqueueMessage(text, fromUserId, ctxToken, baseUrl, token) {
	if (_busy) {
		_queue.push({ text, fromUserId, ctxToken, baseUrl, token });
		return;
	}
	_busy = true;
	processMessage(text, fromUserId, ctxToken, baseUrl, token)
		.catch((err) => log(`process error: ${err.message}`))
		.finally(() => {
			_busy = false;
			if (_queue.length > 0) {
				const next = _queue.shift();
				enqueueMessage(next.text, next.fromUserId, next.ctxToken, next.baseUrl, next.token);
			}
		});
}

// ────────────────────────────────────────────────────────────────────────────
// WeiXin poll loop
// ────────────────────────────────────────────────────────────────────────────

async function runWeiXinPoll(token, accountId, baseUrl) {
	let syncBuf = "";
	let consecutiveErrors = 0;

	while (true) {
		try {
			const body = JSON.stringify({
				get_updates_buf: syncBuf,
				base_info: { channel_version: "2.2.0" },
			});
			const { status, body: respBody } = await httpsPost(
				`${baseUrl.replace(/\/+$/, "")}/ilink/bot/getupdates`,
				body,
				token,
			);

			if (status !== 200) {
				consecutiveErrors++;
				await sleep(2000 * Math.min(consecutiveErrors, 5));
				continue;
			}

			const data = JSON.parse(respBody);
			consecutiveErrors = 0;
			if (data.get_updates_buf) syncBuf = data.get_updates_buf;

			const ret = data.ret;
			const errcode = data.errcode;
			if ((ret !== undefined && ret !== 0 && ret !== null) || (errcode !== undefined && errcode !== 0 && errcode !== null)) {
				if (ret === -14 || errcode === -14) {
					log(`Session expired (-14), back off 10m`);
					await sleep(600_000);
				} else {
					log(`getupdates ret=${ret} errcode=${errcode} ${data.errmsg || ""}`);
				}
				continue;
			}

			for (const msg of data.msgs || []) {
				const text = extractText(msg);
				if (!text) continue;
				if ((msg.from_user_id || "") === accountId) continue;

				log(`📩 WeiXin: ${text.slice(0, 120)}`);
				enqueueMessage(text, msg.from_user_id, msg.context_token || null, baseUrl, token);
			}
		} catch (err) {
			if (err?.message === "timeout") continue;
			consecutiveErrors++;
			log(`Poll error: ${err.message}`);
			await sleep(2000 * Math.min(consecutiveErrors, 5));
		}
	}
}

function extractText(msg) {
	const items = msg.item_list || [];
	for (const item of items) {
		if (item.type === 1) return item.text_item?.text || "";
	}
	return "";
}

// ────────────────────────────────────────────────────────────────────────────
// Startup
// ────────────────────────────────────────────────────────────────────────────

log(`PID: ${process.pid}`);

const settings = readSettings();

// Migrate old flat keys (micah-gw-wx-*) to new namespace (pi-owl-gateway.weixin)
const oldAcct = settings["micah-gw-wx-account-id"];
if (oldAcct && !gwSettings(settings).weixin) {
	log(`Migrating old micah-gw-wx-* settings to pi-owl-gateway.weixin`);
	// In-place migration done by CLI on next login; daemon reads old keys as fallback
}

const weixinCfg = gwSettings(settings).weixin || {};
_workDir = resolveWorkDir(settings, "weixin");
log(`WorkDir: ${_workDir}`);

// Read new format, fall back to old flat keys
const wxToken = weixinCfg["token"] || settings["micah-gw-wx-token"] || "";
const wxAccountId = weixinCfg["account-id"] || settings["micah-gw-wx-account-id"] || "";
const wxBaseUrl = weixinCfg["base-url"] || settings["micah-gw-wx-base-url"] || "https://ilinkai.weixin.qq.com";

if (!wxToken || !wxAccountId) {
	log("WeiXin not configured. Run: pi-owl-gateway login -p weixin");
	process.exit(0);
}

process.on("SIGTERM", async () => {
	log("SIGTERM, shutting down...");
	await disposeSession();
	process.exit(0);
});
process.on("SIGINT", async () => {
	log("SIGINT, shutting down...");
	await disposeSession();
	process.exit(0);
});
process.on("uncaughtException", (err) => {
	// Suppress SDK theme noise in non-interactive daemon mode
	if (err?.message?.includes("Theme not initialized")) return;
	log(`Uncaught: ${err.message}`);
});
process.on("unhandledRejection", (err) => {
	if (err?.message?.includes("Theme not initialized")) return;
	log(`Unhandled: ${err?.message || err}`);
});

log("Starting WeiXin poll loop...");
runWeiXinPoll(wxToken, wxAccountId, wxBaseUrl).catch((err) => {
	log(`Fatal: ${err.message}`);
	process.exit(1);
});

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
