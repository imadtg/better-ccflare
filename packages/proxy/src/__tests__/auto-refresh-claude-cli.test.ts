import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	resolveAutoRefreshClient,
	sendAutoRefreshViaClaudeCli,
} from "../auto-refresh-claude-cli";

/**
 * A stand-in for `claude -p`: records its environment and argv, then behaves
 * according to the prompt so each test can pick a scenario. It never talks to
 * anything but the ANTHROPIC_BASE_URL it was given.
 */
const FAKE_CLAUDE = `#!/usr/bin/env bun
const { writeFileSync } = require("node:fs");
const argv = process.argv.slice(2);
// Records go next to this script: the CLI's HOME is removed after each run.
const record = (name, data) => writeFileSync(import.meta.dir + "/" + name, JSON.stringify(data));
record("invocation.json", { env: process.env, argv, cwd: process.cwd() });
const prompt = argv[argv.indexOf("-p") + 1];
if (prompt === "never-sends") {
	process.stderr.write("Invalid API key");
	process.exit(1);
}
if (prompt === "hangs") await new Promise(() => {});
if (prompt === "ignores-sigterm") {
	process.on("SIGTERM", () => {});
	// A descendant that would outlive its parent and hold its output open.
	const child = Bun.spawn(["sleep", "300"], { stdout: "inherit", stderr: "inherit" });
	record("descendant.json", { pid: child.pid });
	await new Promise(() => {});
}
if (prompt === "asks-again") {
	// Like Claude Code continuing a reply cut at max_tokens: a second request,
	// then a non-zero exit when it is refused.
	const ask = () => fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages?beta=true", {
		method: "POST",
		headers: { authorization: "Bearer " + process.env.ANTHROPIC_AUTH_TOKEN },
		body: "{}",
	});
	await (await ask()).text();
	const again = await ask();
	record("again.json", { status: again.status, body: await again.json() });
	process.exit(1);
}
if (prompt === "knocks-without-token") {
	const res = await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages", { method: "POST", body: "{}" });
	record("knock.json", { status: res.status });
}
const res = await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages?beta=true", {
	method: "POST",
	headers: {
		authorization: "Bearer " + process.env.ANTHROPIC_AUTH_TOKEN,
		"user-agent": "claude-cli/9.9.9 (external, sdk-cli)",
		"content-type": "application/json",
	},
	body: JSON.stringify({ model: "claude-haiku", messages: [{ role: "user", content: prompt }] }),
});
if (prompt === "reads-one-chunk") {
	await res.body.getReader().read();
	await new Promise(() => {});
}
process.stdout.write(await res.text());
process.exit(res.ok ? 0 : 1);
`;

const SSE_BODY =
	'event: message_start\ndata: {"type":"message_start"}\n\nevent: message_stop\ndata: {"type":"message_stop"}\n\n';

let dir: string;
let fakeClaude: string;
let proxy: ReturnType<typeof Bun.serve>;
let received: Array<{ path: string; headers: Headers; body: string }>;
let reply: () => Response;

const internalHeaders = {
	"x-better-ccflare-account-id": "account-1",
	"x-better-ccflare-bypass-session": "true",
	"x-better-ccflare-auto-refresh": "true",
	"x-better-ccflare-internal-probe-secret": "probe-s3cret",
};

function probe(
	prompt: string,
	overrides: {
		timeoutMs?: number;
		claudePath?: string;
		proxyOrigin?: string;
	} = {},
) {
	return sendAutoRefreshViaClaudeCli({
		claudePath: overrides.claudePath ?? fakeClaude,
		prompt,
		proxyOrigin: overrides.proxyOrigin ?? `http://127.0.0.1:${proxy.port}`,
		internalHeaders,
		timeoutMs: overrides.timeoutMs,
	});
}

function invocation(): {
	env: Record<string, string>;
	argv: string[];
	cwd: string;
} {
	return JSON.parse(readFileSync(join(dir, "invocation.json"), "utf8"));
}

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "ccflare-claude-cli-"));
	fakeClaude = join(dir, "claude");
	writeFileSync(fakeClaude, FAKE_CLAUDE);
	chmodSync(fakeClaude, 0o755);
	proxy = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			received.push({
				path: new URL(req.url).pathname,
				headers: req.headers,
				body: await req.text(),
			});
			return reply();
		},
	});
});

afterAll(() => {
	proxy.stop(true);
	rmSync(dir, { recursive: true, force: true });
});

afterEach(() => {
	for (const name of [
		"invocation.json",
		"knock.json",
		"descendant.json",
		"again.json",
	]) {
		rmSync(join(dir, name), { force: true });
	}
});

describe("sendAutoRefreshViaClaudeCli", () => {
	it("routes the CLI's request through the proxy and returns the proxy's answer", async () => {
		received = [];
		reply = () =>
			new Response(SSE_BODY, {
				status: 200,
				headers: {
					"content-type": "text/event-stream",
					"anthropic-ratelimit-unified-reset": "1790000000",
				},
			});

		const result = await probe("What is 2+2?");

		expect(result.sent).toBe(true);
		expect(result.exitCode).toBe(0);
		expect(result.response?.status).toBe(200);
		expect(
			result.response?.headers.get("anthropic-ratelimit-unified-reset"),
		).toBe("1790000000");
		expect(await result.response?.text()).toBe(SSE_BODY);

		expect(received).toHaveLength(1);
		const [request] = received;
		expect(request.path).toBe("/v1/messages");
		for (const [name, value] of Object.entries(internalHeaders)) {
			expect(request.headers.get(name)).toBe(value);
		}
		// The CLI's own request is what goes out, minus its placeholder token.
		expect(request.headers.get("user-agent")).toBe(
			"claude-cli/9.9.9 (external, sdk-cli)",
		);
		expect(request.headers.get("authorization")).toBeNull();
		expect(JSON.parse(request.body).messages[0].content).toBe("What is 2+2?");
	});

	it("keeps the probe secret and the server's environment away from the CLI", async () => {
		received = [];
		reply = () =>
			new Response(SSE_BODY, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		process.env.CCFLARE_TEST_SERVER_ONLY = "server-secret";
		try {
			await probe("What is 2+2?");
		} finally {
			delete process.env.CCFLARE_TEST_SERVER_ONLY;
		}

		const { env, argv, cwd } = invocation();
		expect(JSON.stringify({ env, argv })).not.toContain("probe-s3cret");
		expect(env.CCFLARE_TEST_SERVER_ONLY).toBeUndefined();
		// A fresh temporary HOME, removed after; auto-memory, which would put
		// its path in the prompt, is off.
		expect(env.HOME.startsWith(join(tmpdir(), "claude-"))).toBe(true);
		expect(env.CLAUDE_CONFIG_DIR).toBe(join(env.HOME, ".claude"));
		expect(existsSync(env.HOME)).toBe(false);
		expect(env.ANTHROPIC_BASE_URL).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
		expect(env.CLAUDE_CODE_MAX_RETRIES).toBe("0");
		expect(env.CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK).toBe("1");
		expect(env.CLAUDE_CODE_DISABLE_AUTO_MEMORY).toBe("1");
		expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
		// No world-writable ancestors to load CLAUDE.md files or skills from.
		expect(cwd).toBe("/");
		expect(argv).toEqual([
			"-p",
			"What is 2+2?",
			"--model",
			"haiku",
			"--no-session-persistence",
			"--max-turns",
			"1",
		]);
	});

	it("serves only the CLI it started", async () => {
		received = [];
		reply = () =>
			new Response(SSE_BODY, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});

		const result = await probe("knocks-without-token");

		const knock = JSON.parse(readFileSync(join(dir, "knock.json"), "utf8"));
		expect(knock.status).toBe(401);
		// Only the CLI's own, authenticated request reached the proxy.
		expect(received).toHaveLength(1);
		expect(result.sent).toBe(true);
		expect(result.exitCode).toBe(0);
	});

	it("forwards one Messages request, and judges the probe by its answer", async () => {
		received = [];
		reply = () =>
			new Response(SSE_BODY, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});

		const result = await probe("asks-again");

		expect(received).toHaveLength(1);
		const again = JSON.parse(readFileSync(join(dir, "again.json"), "utf8"));
		expect(again.status).toBe(400);
		expect(again.body.error.type).toBe("invalid_request_error");
		// The CLI failed, but the answer it got was whole: that is a refresh.
		expect(result.exitCode).toBe(1);
		expect(result.response?.status).toBe(200);
		expect(await result.response?.text()).toBe(SSE_BODY);
		expect(result.error).toBeUndefined();
	});

	for (const [name, body] of [
		[
			"ends in an error event",
			'event: message_start\ndata: {"type":"message_start"}\n\nevent: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
		],
		[
			"stops before message_stop",
			'event: message_start\ndata: {"type":"message_start"}\n\n',
		],
	]) {
		it(`does not count a 200 whose stream ${name}, whatever the CLI says`, async () => {
			received = [];
			reply = () =>
				new Response(body, {
					status: 200,
					headers: { "content-type": "text/event-stream" },
				});

			// The fake exits 0 on any 200.
			const result = await probe("What is 2+2?");

			expect(result.exitCode).toBe(0);
			expect(result.response?.status).toBe(200);
			expect(result.error).toContain("did not complete");
		});
	}

	it("hands an error answer back unchanged", async () => {
		received = [];
		const overloaded =
			'{"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}';
		reply = () =>
			new Response(overloaded, {
				status: 529,
				headers: { "content-type": "application/json" },
			});

		const result = await probe("What is 2+2?");

		expect(result.sent).toBe(true);
		expect(result.exitCode).toBe(1);
		expect(result.response?.status).toBe(529);
		expect(await result.response?.text()).toBe(overloaded);
	});

	it("reports nothing sent when the CLI exits before making a request", async () => {
		received = [];
		reply = () => new Response("unexpected", { status: 500 });

		const result = await probe("never-sends");

		expect(result.sent).toBe(false);
		expect(result.response).toBeNull();
		expect(result.exitCode).toBe(1);
		expect(result.error).toContain("Invalid API key");
		expect(received).toHaveLength(0);
	});

	it("runs a relative executable path from the server's directory", async () => {
		received = [];
		reply = () =>
			new Response(SSE_BODY, {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			});
		// "./claude" exists only from here, not from the CLI's own cwd.
		const serverCwd = process.cwd();
		process.chdir(dir);
		try {
			const result = await probe("What is 2+2?", { claudePath: "./claude" });

			expect(result.sent).toBe(true);
			expect(result.error).toBeUndefined();
		} finally {
			process.chdir(serverCwd);
		}
	});

	it("reports nothing sent when the executable cannot be started", async () => {
		const result = await probe("What is 2+2?", {
			claudePath: join(dir, "no-such-claude"),
		});

		expect(result.sent).toBe(false);
		expect(result.response).toBeNull();
		expect(result.error).toContain("could not start");
	});

	it("kills a CLI that does not finish in time", async () => {
		received = [];
		const result = await probe("hangs", { timeoutMs: 500 });

		expect(result.sent).toBe(false);
		expect(result.response).toBeNull();
		expect(result.error).toContain("did not finish");
	});

	it("kills a CLI that ignores SIGTERM, and what it started", async () => {
		const started = Date.now();
		const result = await probe("ignores-sigterm", { timeoutMs: 1_000 });

		expect(Date.now() - started).toBeLessThan(5_000);
		expect(result.error).toContain("did not finish");
		const { pid } = JSON.parse(
			readFileSync(join(dir, "descendant.json"), "utf8"),
		);
		await Bun.sleep(100);
		expect(() => process.kill(pid, 0)).toThrow();
	});

	it("stops reading an answer that stalls past the timeout", async () => {
		received = [];
		let stalled: ReadableStreamDefaultController<Uint8Array> | undefined;
		reply = () =>
			new Response(
				new ReadableStream<Uint8Array>({
					start(controller) {
						stalled = controller;
						controller.enqueue(
							new TextEncoder().encode(
								'event: message_start\ndata: {"type":"message_start"}\n\n',
							),
						);
					},
				}),
				{ status: 200, headers: { "content-type": "text/event-stream" } },
			);

		const started = Date.now();
		try {
			const result = await probe("reads-one-chunk", { timeoutMs: 500 });

			expect(Date.now() - started).toBeLessThan(5_000);
			expect(result.sent).toBe(true);
			expect(result.response?.status).toBe(200);
			expect(result.error).toContain("did not finish");
		} finally {
			try {
				stalled?.close();
			} catch {}
		}
	});

	it("counts a probe the proxy never answered as sent, with no response", async () => {
		// A port nothing listens on: bind one, note it, release it.
		const closed = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => new Response(),
		});
		const origin = `http://127.0.0.1:${closed.port}`;
		closed.stop(true);

		const result = await probe("What is 2+2?", { proxyOrigin: origin });

		expect(result.sent).toBe(true);
		expect(result.response).toBeNull();
		expect(result.exitCode).toBe(1);
	});
});

describe("resolveAutoRefreshClient", () => {
	const found = () => "/usr/local/bin/claude";
	const missing = () => null;

	it("auto picks the CLI only when the executable can be found", () => {
		expect(resolveAutoRefreshClient("auto", "claude", found)).toBe(
			"claude-cli",
		);
		expect(resolveAutoRefreshClient("auto", "claude", missing)).toBe(
			"synthetic",
		);
	});

	it("an explicit choice is kept whether or not the CLI is there", () => {
		expect(resolveAutoRefreshClient("claude-cli", "claude", missing)).toBe(
			"claude-cli",
		);
		expect(resolveAutoRefreshClient("synthetic", "claude", found)).toBe(
			"synthetic",
		);
	});
});
