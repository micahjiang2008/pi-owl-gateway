#!/usr/bin/env node
/**
 * pi-owl-gateway CLI — standalone gateway daemon.
 *
 * Usage:
 *   node bin/gateway.mjs login -p weixin
 *   node bin/gateway.mjs start
 *   node bin/gateway.mjs stop
 *   node bin/gateway.mjs status
 *   node bin/gateway.mjs restart
 *
 * Commands:
 *   login -p <platform>   Platform QR login (weixin, telegram, ...)
 *   start                 Start gateway daemon (all configured platforms)
 *   stop                  Stop gateway daemon
 *   status                Show daemon + platform status
 *   restart               Stop + start
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync, chmodSync, unlinkSync, openSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { spawn } from "node:child_process";

// ────────────────────────────────────────────────────────────────────────────
// Paths
// ────────────────────────────────────────────────────────────────────────────

function getAgentDir() {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

function settingsPath() {
	return join(getAgentDir(), "settings.json");
}

function daemonPidPath() {
	return join(getAgentDir(), "gateway.pid");
}

function daemonLogPath() {
	return join(getAgentDir(), "gateway-daemon.log");
}

// ────────────────────────────────────────────────────────────────────────────
// Settings helpers
// ────────────────────────────────────────────────────────────────────────────

function readSettings() {
	const p = settingsPath();
	if (!existsSync(p)) return {};
	try {
		return JSON.parse(readFileSync(p, "utf-8"));
	} catch {
		return {};
	}
}

function writeSettings(update) {
	const p = settingsPath();
	const current = readSettings();
	const merged = { ...current, ...update };
	const content = JSON.stringify(merged, null, 2) + "\n";
	const tmp = p + ".tmp";
	writeFileSync(tmp, content, "utf-8");
	try {
		chmodSync(tmp, 0o600);
	} catch {}
	try {
		renameSync(tmp, p);
	} catch {
		writeFileSync(p, content, "utf-8");
		try {
			unlinkSync(tmp);
		} catch {}
	}
}

// ────────────────────────────────────────────────────────────────────────────
// Arguments parser
// ────────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
	const cmd = argv[2]; // login, start, stop, status, restart
	const options = {};
	for (let i = 3; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "-p" || arg === "--platform") {
			options.platform = argv[++i] || "";
		} else if (arg.startsWith("--platform=")) {
			options.platform = arg.slice("--platform=".length);
		} else if (arg.startsWith("-p=")) {
			options.platform = arg.slice(3);
		}
	}
	return { cmd, options };
}

// ────────────────────────────────────────────────────────────────────────────
// Login flow
// ────────────────────────────────────────────────────────────────────────────

/**
 * WeChat QR login — inline, no TS dependency.
 */
async function weixinLogin() {
	const { qrLogin } = await import("../lib/weixin-login.mjs");
	const creds = await qrLogin((status, detail) => {
		switch (status) {
			case "qr_art":
				console.log(detail);
				break;
			case "qr_url":
				console.log(`\n二维码链接: ${detail}\n`);
				break;
			case "wait":
				process.stdout.write(".");
				break;
			case "scaned":
				console.log("\n✅ 已扫码，请在微信中确认...");
				break;
			case "redirect":
				console.log(`\n↪ 重定向到 ${detail}`);
				break;
			case "expired":
				console.log(`\n🔄 二维码已过期，刷新中 (${detail})`);
				break;
			case "confirmed":
				console.log("\n✅ 微信登录成功！");
				break;
			case "error":
				console.log(`\n❌ ${detail}`);
				break;
		}
	});

	if (creds) {
		writeSettings({
			"micah-gw-wx-account-id": creds.accountId,
			"micah-gw-wx-token": creds.token,
			"micah-gw-wx-base-url": creds.baseUrl,
			"micah-gw-wx-user-id": creds.userId,
		});
		console.log(`\n凭证已保存到 ${settingsPath()}`);
		console.log(`  accountId: ${creds.accountId}`);
		return true;
	}
	console.log("\n微信登录失败或超时");
	return false;
}

// ────────────────────────────────────────────────────────────────────────────
// Daemon management
// ────────────────────────────────────────────────────────────────────────────

function readPid() {
	const p = daemonPidPath();
	if (!existsSync(p)) return null;
	try {
		const pid = parseInt(readFileSync(p, "utf-8").trim(), 10);
		return isNaN(pid) ? null : pid;
	} catch {
		return null;
	}
}

function isRunning(pid) {
	if (!pid) return false;
	try {
		// pid 0 = no error = process exists (Windows-friendly)
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function cmdStart() {
	const pid = readPid();
	if (pid && isRunning(pid)) {
		console.log(`Gateway already running (PID ${pid})`);
		return;
	}

	// Fork the daemon process - stdout/stderr go directly to log file
	const daemonScript = fileURLToPath(new URL("../lib/daemon.mjs", import.meta.url));
	const npmRoot = process.env.NODE_PATH || resolve(homedir(), "AppData", "Roaming", "npm", "node_modules");
	const logFd = openSync(daemonLogPath(), "a");

	const child = spawn(process.execPath, [daemonScript], {
		detached: true,
		stdio: ["ignore", logFd, logFd],
		env: {
			...process.env,
			PI_GATEWAY_DAEMON: "1",
			NODE_PATH: npmRoot,
		},
	});
	closeSync(logFd);

	// Write PID file and detach immediately
	writeFileSync(daemonPidPath(), String(child.pid), "utf-8");
	child.unref();

	console.log("Gateway daemon started (PID", child.pid, ")");
}

async function cmdStop() {
	const pid = readPid();
	if (!pid) {
		console.log("Gateway is not running (no PID file)");
		return;
	}

	if (!isRunning(pid)) {
		console.log("Gateway was not running (stale PID file)");
		try {
			unlinkSync(daemonPidPath());
		} catch {}
		return;
	}

	try {
		process.kill(pid, "SIGTERM");
		console.log(`Sent SIGTERM to PID ${pid}`);
		// Wait up to 5s for graceful shutdown
		for (let i = 0; i < 5; i++) {
			if (!isRunning(pid)) break;
			await new Promise((r) => setTimeout(r, 1000));
		}
		if (isRunning(pid)) {
			process.kill(pid, "SIGKILL");
			console.log("Force killed");
		}
	} catch (e) {
		console.log(`Error stopping: ${e.message}`);
	}
	try {
		unlinkSync(daemonPidPath());
	} catch {}
}

function cmdStatus() {
	const pid = readPid();
	const running = pid && isRunning(pid);

	console.log("Gateway daemon:", running ? "🟢 running" : "🔴 stopped");
	if (pid) {
		console.log(`  PID: ${pid}`);
		console.log(`  Alive: ${isRunning(pid)}`);
	}

	// Show configured platforms from settings
	const s = readSettings();
	const platformNames = [];
	if (s["micah-gw-wx-account-id"]) {
		platformNames.push("WeChat");
	}
	if (platformNames.length > 0) {
		console.log(`Platforms: ${platformNames.join(", ")}`);
	} else {
		console.log("Platforms: (none configured)");
	}
}

async function cmdRestart() {
	await cmdStop();
	await cmdStart();
}

// ────────────────────────────────────────────────────────────────────────────
// Help
// ────────────────────────────────────────────────────────────────────────────

function showHelp() {
	const lines = [
		"",
		"pi-owl-gateway — multi-platform gateway daemon",
		"",
		"Usage:",
		"  node bin/gateway.mjs login -p <platform>   QR login for a platform",
		"  node bin/gateway.mjs start                  Start daemon",
		"  node bin/gateway.mjs stop                   Stop daemon",
		"  node bin/gateway.mjs status                 Show daemon status",
		"  node bin/gateway.mjs restart                Restart daemon",
		"",
		"Platforms:",
		"  weixin   WeChat (iLink Bot API)",
		"",
		"Options:",
		"  -p, --platform <name>   Target platform for login",
		"",
		"Examples:",
		"  node bin/gateway.mjs login -p weixin",
		"  node bin/gateway.mjs start",
		"  node bin/gateway.mjs status",
		"",
		"Config: ~/.pi/agent/settings.json",
		"Log:    ~/.pi/agent/gateway-daemon.log",
		"PID:    ~/.pi/agent/gateway.pid",
	];
	console.log(lines.join("\n"));
}

// ────────────────────────────────────────────────────────────────────────────
// Main
// ────────────────────────────────────────────────────────────────────────────

const { cmd, options } = parseArgs(process.argv);

switch (cmd) {
	case "login": {
		const platform = options.platform || "";
		if (!platform) {
			console.error("Usage: node bin/gateway.mjs login -p <platform>");
			process.exit(1);
		}
		if (platform === "weixin") {
			await weixinLogin();
		} else {
			console.error(`Unknown platform: ${platform}`);
			process.exit(1);
		}
		break;
	}
	case "start":
		await cmdStart();
		break;
	case "stop":
		await cmdStop();
		break;
	case "status":
		cmdStatus();
		break;
	case "restart":
		await cmdRestart();
		break;
	default:
		showHelp();
		break;
}
