import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createProvider, envApiKeyAuth, type ProviderStreams } from "@earendil-works/pi-ai";
import { isKeyRelease, matchesKey, parseKey, type KeyId } from "@earendil-works/pi-tui";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const settingsPath = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi/agent"), "pi-dictate.json");
let saved: { shortcut?: string; language?: string } = {};
try { saved = JSON.parse(readFileSync(settingsPath, "utf8")); } catch {}
const shortcut = saved.shortcut || "ctrl+alt+d";
const language = saved.language || "en";
const keyName = shortcut.replace(/^(?:(?:ctrl|shift|alt|super|meta|cmd)\+)+/, "");

export default function (pi: ExtensionAPI) {
	pi.registerProvider(createProvider({
		id: "deepgram",
		name: "Deepgram",
		baseUrl: "https://api.deepgram.com",
		auth: { apiKey: envApiKeyAuth("Deepgram API key", ["DEEPGRAM_API_KEY"]) },
		models: [],
		api: {} as ProviderStreams,
	}));

	let ctx: ExtensionContext | undefined;
	let mic: ChildProcess | undefined;
	let socket: WebSocket | undefined;
	let pendingAudio: Buffer[] = [];
	let transcript = "";
	let interim = "";
	let editorBefore = "";
	let started = 0;
	let statusTimer: ReturnType<typeof setInterval> | undefined;
	let releaseTimer: ReturnType<typeof setTimeout> | undefined;
	let keyDown = false;
	let unsubscribe: (() => void) | undefined;
	let operation = Promise.resolve();

	const queue = (fn: () => Promise<void>) => { operation = operation.then(fn, fn).catch(error => finish(String(error instanceof Error ? error.message : error))); };
	const setStatus = () => ctx?.ui.setStatus("dictate", keyDown
		? ctx.ui.theme.fg("error", "●") + ctx.ui.theme.fg("muted", ` REC ${((Date.now() - started) / 1000).toFixed(1)}s`)
		: undefined);
	const clearRelease = () => { if (releaseTimer) clearTimeout(releaseTimer); releaseTimer = undefined; };
	const updateEditor = () => ctx?.ui.setEditorText([editorBefore, transcript, interim].filter(Boolean).join(" "));

	function finish(error?: string) {
		if (statusTimer) clearInterval(statusTimer);
		statusTimer = undefined;
		mic?.kill("SIGKILL");
		mic = undefined;
		pendingAudio = [];
		socket?.close();
		socket = undefined;
		setStatus();
		transcript = "";
		interim = "";
		editorBefore = "";
		if (error) ctx?.ui.notify(error, "error");
	}

	async function start() {
		if (!ctx || socket) return;
		const key = (await ctx.modelRegistry.getProviderAuth("deepgram"))?.auth.apiKey;
		if (!key) throw new Error("Run /login deepgram first");
		const params = new URLSearchParams({
			model: "nova-3", language, encoding: "linear16", sample_rate: "16000",
			channels: "1", smart_format: "true", interim_results: "true",
		});
		transcript = "";
		interim = "";
		editorBefore = ctx.ui.getEditorText().trim();
		const ws = socket = new WebSocket(`wss://api.deepgram.com/v1/listen?${params}`, {
			headers: { Authorization: `Token ${key}` },
		} as any);
		ws.onopen = () => {
			for (const chunk of pendingAudio) ws.send(chunk);
			pendingAudio = [];
		};
		ws.onmessage = event => {
			const message = JSON.parse(String(event.data));
			const text = message.channel?.alternatives?.[0]?.transcript?.trim() || "";
			if (message.is_final) {
				if (text) transcript += `${transcript ? " " : ""}${text}`;
				interim = "";
			} else interim = text;
			updateEditor();
		};
		ws.onerror = () => finish("Deepgram connection failed");
		ws.onclose = () => finish();
	}

	function capture() {
		pendingAudio = [];
		mic = spawn("ffmpeg", [
			"-f", "avfoundation", "-i", ":default", "-ac", "1", "-ar", "16000",
			"-sample_fmt", "s16", "-f", "s16le", "-loglevel", "error", "pipe:1",
		], { stdio: ["ignore", "pipe", "ignore"] });
		mic.stdout?.on("data", chunk => {
			if (socket?.readyState === WebSocket.OPEN) socket.send(chunk);
			else pendingAudio.push(chunk);
		});
		mic.on("error", error => finish(`Microphone failed: ${error.message}`));
	}

	async function stop() {
		if (!socket) return finish();
		const ws = socket;
		if (statusTimer) clearInterval(statusTimer);
		statusTimer = undefined;
		ctx?.ui.setStatus("dictate", undefined);
		mic?.kill("SIGTERM");
		if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "CloseStream" }));
		setTimeout(() => { if (socket === ws) ws.close(); }, 2500).unref();
	}

	function release() {
		if (!keyDown) return;
		keyDown = false;
		clearRelease();
		if (statusTimer) clearInterval(statusTimer);
		statusTimer = undefined;
		setStatus();
		queue(stop);
	}

	function armRelease(delay: number) {
		clearRelease();
		releaseTimer = setTimeout(release, delay);
	}

	pi.registerShortcut(shortcut as KeyId, {
		description: "Push to dictate",
		handler(handlerCtx) {
			ctx = handlerCtx;
			if (keyDown) return;
			keyDown = true;
			started = Date.now();
			statusTimer = setInterval(setStatus, 100);
			setStatus();
			capture();
			armRelease(650);
			queue(start);
		},
	});

	pi.on("session_start", (_event, sessionCtx) => {
		ctx = sessionCtx;
		unsubscribe?.();
		unsubscribe = sessionCtx.ui.onTerminalInput(data => {
			if (!keyDown || parseKey(data)?.replace(/^(?:(?:ctrl|shift|alt|super|meta|cmd)\+)+/, "") !== keyName) return;
			if (isKeyRelease(data)) release(); else if (matchesKey(data, shortcut as KeyId)) armRelease(120);
			return { consume: true };
		});
	});

	pi.on("session_shutdown", () => {
		unsubscribe?.();
		unsubscribe = undefined;
		clearRelease();
		keyDown = false;
		mic?.kill("SIGKILL");
		socket?.close();
		transcript = "";
		finish();
		ctx = undefined;
	});
}
