import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

class Emitter {
	handlers = new Map<string, Function[]>();
	on(name: string, handler: Function) {
		this.handlers.set(name, [...(this.handlers.get(name) || []), handler]);
		return this;
	}
	emit(name: string, value?: unknown) {
		for (const handler of this.handlers.get(name) || []) handler(value);
	}
}

let microphone: Emitter & { stdout: Emitter; kill: ReturnType<typeof mock> };
const childProcess = await import("node:child_process");
mock.module("node:child_process", () => ({ ...childProcess, spawn: () => microphone }));

const sockets: FakeSocket[] = [];
class FakeSocket {
	static OPEN = 1;
	readyState = 0;
	sent: unknown[] = [];
	onopen?: () => void;
	onmessage?: (event: { data: string }) => void;
	onerror?: () => void;
	onclose?: () => void;
	constructor(public url: string, public options: unknown) { sockets.push(this); }
	send(value: unknown) { this.sent.push(value); }
	close() { this.readyState = 3; }
	open() { this.readyState = 1; this.onopen?.(); }
}
globalThis.WebSocket = FakeSocket as any;

const agentDir = mkdtempSync(join(tmpdir(), "pi-dictate-"));
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
process.env.PI_CODING_AGENT_DIR = agentDir;
const { default: dictate } = await import("../extensions/dictate");
afterAll(() => {
	if (previousAgentDir) process.env.PI_CODING_AGENT_DIR = previousAgentDir;
	else delete process.env.PI_CODING_AGENT_DIR;
	rmSync(agentDir, { recursive: true });
});

beforeEach(() => {
	sockets.length = 0;
	microphone = Object.assign(new Emitter(), { stdout: new Emitter(), kill: mock() });
});

function setup(auth: unknown = { auth: { apiKey: "test-key" } }) {
	const events = new Map<string, Function>();
	let shortcut: any;
	let terminalInput: Function | undefined;
	let editor = "before\n\n\nafter";
	let cursor = "before\n\n".length;
	const pi = {
		registerProvider: mock(),
		registerShortcut: (_key: string, value: unknown) => { shortcut = value; },
		on: (name: string, handler: Function) => events.set(name, handler),
	};
	const ctx = {
		modelRegistry: { getProviderAuth: async () => auth },
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			onTerminalInput: (handler: Function) => { terminalInput = handler; return () => {}; },
			setStatus: mock(), notify: mock(),
			pasteToEditor: (text: string) => { editor = editor.slice(0, cursor) + text + editor.slice(cursor); cursor += text.length; },
			getEditorText: () => editor,
			setEditorText: (value: string) => { editor = value; },
		},
	};
	dictate(pi as any);
	events.get("session_start")?.({}, ctx);
	return { ctx, pi, shortcut, input: (data: string) => terminalInput?.(data), editor: () => editor };
}

const settle = () => new Promise(resolve => setTimeout(resolve, 0));

describe("dictation", () => {
	test("buffers audio, streams at the cursor, and finalizes after release", async () => {
		const app = setup();
		app.shortcut.handler(app.ctx);
		expect(app.ctx.ui.setStatus).toHaveBeenCalledWith("dictate", "● REC 0.0s");
		microphone.stdout.emit("data", Buffer.from([1, 2]));
		await settle();

		const socket = sockets[0]!;
		expect(socket.url).toContain("model=nova-3");
		expect(socket.url).toContain("language=en");
		expect(socket.url).toContain("interim_results=true");
		socket.open();
		expect(socket.sent).toContainEqual(Buffer.from([1, 2]));
		socket.onmessage?.({ data: JSON.stringify({ is_final: false, channel: { alternatives: [{ transcript: "hello" }] } }) });
		expect(app.editor()).toBe("before\n\nhello\nafter");

		app.input("\x1b[100;7:3u");
		await settle();
		expect(microphone.kill).toHaveBeenCalledWith("SIGTERM");
		expect(socket.sent).toContain(JSON.stringify({ type: "CloseStream" }));
		socket.onmessage?.({ data: JSON.stringify({ is_final: true, channel: { alternatives: [{ transcript: "hello world" }] } }) });
		socket.onclose?.();
		expect(app.editor()).toBe("before\n\nhello world\nafter");
	});

	test("closes a short recording after the connection opens", async () => {
		const app = setup();
		app.shortcut.handler(app.ctx);
		app.input("\x1b[100;7:3u");
		await settle();

		const socket = sockets[0]!;
		socket.open();
		expect(socket.sent).toContain(JSON.stringify({ type: "CloseStream" }));
	});

	test("retries one failed connection", async () => {
		const app = setup();
		app.shortcut.handler(app.ctx);
		await settle();
		sockets[0]!.onerror?.();
		await settle();

		expect(sockets).toHaveLength(2);
		expect(app.ctx.ui.notify).not.toHaveBeenCalled();
		sockets[1]!.onerror?.();
		expect(app.ctx.ui.notify).toHaveBeenCalledWith("Deepgram connection failed", "error");
	});

	test("cleans up when auth is missing", async () => {
		const app = setup(null);
		app.shortcut.handler(app.ctx);
		await settle();
		expect(microphone.kill).toHaveBeenCalledWith("SIGKILL");
		expect(app.ctx.ui.notify).toHaveBeenCalledWith("Run /login deepgram first", "error");
		expect(app.editor()).toBe("before\n\n\nafter");
	});

	test("reports a microphone that exits while recording", async () => {
		const app = setup();
		app.shortcut.handler(app.ctx);
		microphone.emit("exit", 1);
		await settle();
		expect(app.ctx.ui.notify).toHaveBeenCalledWith("Microphone stopped (1)", "error");
		expect(sockets).toHaveLength(0);
	});

	test("cleans up a Deepgram protocol error", async () => {
		const app = setup();
		app.shortcut.handler(app.ctx);
		await settle();
		sockets[0]!.onmessage?.({ data: JSON.stringify({ type: "Error", message: "Bad request" }) });
		expect(app.ctx.ui.notify).toHaveBeenCalledWith("Bad request", "error");
		expect(microphone.kill).toHaveBeenCalledWith("SIGKILL");
		expect(app.editor()).toBe("before\n\n\nafter");
	});
});
