import { beforeEach, describe, expect, mock, test } from "bun:test";

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
mock.module("node:child_process", () => ({
	...childProcess,
	spawn: () => microphone,
}));

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

const { default: dictate } = await import("../extensions/dictate");

beforeEach(() => {
	sockets.length = 0;
	microphone = Object.assign(new Emitter(), { stdout: new Emitter(), kill: mock() });
});

describe("dictation", () => {
	test("streams audio and inserts the final transcript on release", async () => {
		const events = new Map<string, Function>();
		let shortcut: any;
		let terminalInput: Function | undefined;
		let editor = "existing";
		const pi = {
			registerProvider: mock(),
			registerShortcut: (_key: string, value: unknown) => { shortcut = value; },
			on: (name: string, handler: Function) => events.set(name, handler),
		};
		dictate(pi as any);
		const ctx = {
			modelRegistry: { getProviderAuth: async () => ({ auth: { apiKey: "test-key" } }) },
			ui: {
				onTerminalInput: (handler: Function) => { terminalInput = handler; return () => {}; },
				setStatus: mock(), notify: mock(),
				getEditorText: () => editor,
				setEditorText: (value: string) => { editor = value; },
			},
		};
		events.get("session_start")?.({}, ctx);
		shortcut.handler(ctx);
		expect(ctx.ui.setStatus).toHaveBeenCalledWith("dictate", "● REC 0.0s");
		await new Promise(resolve => setTimeout(resolve, 0));

		const socket = sockets[0]!;
		expect(socket.url).toContain("model=nova-3");
		expect(socket.url).toContain("language=en");
		expect(socket.url).toContain("interim_results=true");
		socket.open();
		microphone.stdout.emit("data", Buffer.from([1, 2]));
		expect(socket.sent).toContainEqual(Buffer.from([1, 2]));
		socket.onmessage?.({ data: JSON.stringify({ is_final: false, channel: { alternatives: [{ transcript: "hello" }] } }) });
		expect(editor).toBe("existing hello");
		socket.onmessage?.({ data: JSON.stringify({ is_final: true, channel: { alternatives: [{ transcript: "hello world" }] } }) });
		expect(editor).toBe("existing hello world");

		terminalInput?.("\x1b[100;7:3u");
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(microphone.kill).toHaveBeenCalledWith("SIGTERM");
		expect(socket.sent).toContain(JSON.stringify({ type: "CloseStream" }));
		expect(ctx.ui.setStatus).toHaveBeenCalledWith("dictate", undefined);
		socket.onclose?.();
		expect(editor).toBe("existing hello world");
	});
});
