import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createProvider, envApiKeyAuth, type ProviderStreams } from "@earendil-works/pi-ai";
import { isKeyRelease, matchesKey, parseKey, type KeyId } from "@earendil-works/pi-tui";
import { spawn, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const agentDir = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi/agent");
let config: { shortcut?: string; language?: string } = {};
try { config = JSON.parse(readFileSync(join(agentDir, "pi-dictate.json"), "utf8")); } catch {}
const shortcut = config.shortcut || "ctrl+alt+d";
const language = config.language || "en";
const bareKey = (key: string) => key.replace(/^(?:(?:ctrl|shift|alt|super|meta|cmd)\+)+/, "");
const keyName = bareKey(shortcut);

export default function (pi: ExtensionAPI) {
	pi.registerProvider(createProvider({
		id: "deepgram", name: "Deepgram", baseUrl: "https://api.deepgram.com",
		auth: { apiKey: envApiKeyAuth("Deepgram API key", ["DEEPGRAM_API_KEY"]) },
		models: [], api: {} as ProviderStreams,
	}));

	let ctx: ExtensionContext | undefined;
	let mic: ChildProcess | undefined;
	let socket: WebSocket | undefined;
	let audio: Buffer[] = [];
	let finals: string[] = [];
	let editorBefore = "";
	let started = 0;
	let pressed = false;
	let statusTimer: ReturnType<typeof setInterval> | undefined;
	let releaseTimer: ReturnType<typeof setTimeout> | undefined;
	let unsubscribe: (() => void) | undefined;
	let operation = Promise.resolve();

	const status = () => ctx?.ui.setStatus("dictate", pressed
		? ctx.ui.theme.fg("error", "●") + ctx.ui.theme.fg("muted", ` REC ${((Date.now() - started) / 1000).toFixed(1)}s`)
		: undefined);
	const queue = (work: () => Promise<void>) => {
		operation = operation.then(work, work).catch(error => finish(error instanceof Error ? error.message : String(error)));
	};
	const armRelease = (delay: number) => {
		clearTimeout(releaseTimer);
		releaseTimer = setTimeout(release, delay);
	};

	function finish(error?: string) {
		clearInterval(statusTimer);
		clearTimeout(releaseTimer);
		pressed = false;
		status();
		mic?.kill("SIGKILL");
		const ws = socket;
		mic = socket = undefined;
		audio = [];
		finals = [];
		editorBefore = "";
		ws?.close();
		if (error) ctx?.ui.notify(error, "error");
	}

	function capture() {
		audio = [];
		mic = spawn("ffmpeg", [
			"-f", "avfoundation", "-i", ":default", "-ac", "1", "-ar", "16000",
			"-sample_fmt", "s16", "-f", "s16le", "-loglevel", "error", "pipe:1",
		], { stdio: ["ignore", "pipe", "ignore"] });
		mic.stdout?.on("data", chunk => socket?.readyState === WebSocket.OPEN ? socket.send(chunk) : audio.push(chunk));
		mic.on("error", error => finish(`Microphone failed: ${error.message}`));
	}

	async function connect() {
		if (!ctx) return;
		const key = (await ctx.modelRegistry.getProviderAuth("deepgram"))?.auth.apiKey;
		if (!key) throw new Error("Run /login deepgram first");
		const query = new URLSearchParams({
			model: "nova-3", language, encoding: "linear16", sample_rate: "16000",
			channels: "1", smart_format: "true", interim_results: "true",
		});
		editorBefore = ctx.ui.getEditorText().trim();
		finals = [];
		const ws = socket = new WebSocket(`wss://api.deepgram.com/v1/listen?${query}`, {
			headers: { Authorization: `Token ${key}` },
		} as any);
		ws.onopen = () => { for (const chunk of audio) ws.send(chunk); audio = []; };
		ws.onmessage = event => {
			const message = JSON.parse(String(event.data));
			const text = message.channel?.alternatives?.[0]?.transcript?.trim() || "";
			if (message.is_final && text) finals.push(text);
			ctx?.ui.setEditorText([editorBefore, ...finals, message.is_final ? "" : text].filter(Boolean).join(" "));
		};
		ws.onerror = () => { if (socket === ws) finish("Deepgram connection failed"); };
		ws.onclose = () => { if (socket === ws) finish(); };
	}

	async function stop() {
		mic?.kill("SIGTERM");
		if (!socket) return finish();
		const ws = socket;
		if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: "CloseStream" }));
		setTimeout(() => { if (socket === ws) ws.close(); }, 2500).unref();
	}

	function release() {
		if (!pressed) return;
		pressed = false;
		clearInterval(statusTimer);
		clearTimeout(releaseTimer);
		status();
		queue(stop);
	}

	pi.registerShortcut(shortcut as KeyId, {
		description: "Push to dictate",
		handler(handlerCtx) {
			if (pressed || socket) return;
			ctx = handlerCtx;
			pressed = true;
			started = Date.now();
			statusTimer = setInterval(status, 100);
			status();
			capture();
			armRelease(650);
			queue(connect);
		},
	});

	pi.on("session_start", (_event, sessionCtx) => {
		ctx = sessionCtx;
		unsubscribe = sessionCtx.ui.onTerminalInput(data => {
			if (!pressed || bareKey(parseKey(data) || "") !== keyName) return;
			if (isKeyRelease(data)) release(); else if (matchesKey(data, shortcut as KeyId)) armRelease(120);
			return { consume: true };
		});
	});

	pi.on("session_shutdown", () => {
		unsubscribe?.();
		finish();
		ctx = undefined;
	});
}
