import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AutoRefreshScheduler } from "../auto-refresh-scheduler";

const FAKE_CLAUDE = `#!/usr/bin/env bun
const prompt = process.argv[process.argv.indexOf("-p") + 1];
const res = await fetch(process.env.ANTHROPIC_BASE_URL + "/v1/messages", {
	method: "POST",
	headers: {
		authorization: "Bearer " + process.env.ANTHROPIC_AUTH_TOKEN,
		"content-type": "application/json",
	},
	body: JSON.stringify({ model: "claude-haiku", messages: [{ role: "user", content: prompt }] }),
});
const text = await res.text();
// Like Claude Code: an error event in a streamed 200 still fails the run.
process.exit(res.ok && !text.includes('"type":"error"') ? 0 : 1);
`;

// A Claude Code too old for the flags it is given: exits without a request.
const OLD_CLAUDE = `#!/bin/sh
echo "error: unknown option '--no-session-persistence'" >&2
exit 1
`;

let dir: string;
let fakeClaude: string;
let oldClaude: string;
let proxy: ReturnType<typeof Bun.serve>;
let proxyHits: Headers[];
let proxyReply: () => Response;

beforeAll(() => {
	dir = mkdtempSync(join(tmpdir(), "ccflare-claude-cli-scheduler-"));
	fakeClaude = join(dir, "claude");
	writeFileSync(fakeClaude, FAKE_CLAUDE);
	chmodSync(fakeClaude, 0o755);
	oldClaude = join(dir, "old-claude");
	writeFileSync(oldClaude, OLD_CLAUDE);
	chmodSync(oldClaude, 0o755);
	proxy = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req) {
			proxyHits.push(req.headers);
			return proxyReply();
		},
	});
});

afterAll(() => {
	proxy.stop(true);
	rmSync(dir, { recursive: true, force: true });
});

async function makeScheduler(
	claudePath: string,
	client: "auto" | "claude-cli" = "claude-cli",
) {
	const runCalls: Array<[string, unknown[]]> = [];
	const db = {
		run: mock(async (sql: string, params: unknown[]) => {
			runCalls.push([sql, params]);
		}),
		query: mock(async () => []),
	};
	const { AutoRefreshScheduler } = await import("../auto-refresh-scheduler");
	const scheduler = new AutoRefreshScheduler(
		db as never,
		{
			runtime: { port: proxy.port, clientId: "test-client" },
			refreshInFlight: new Map(),
			internalProbeSecret: "probe-s3cret",
			config: {
				getAutoRefreshClient: () => client,
				getAutoRefreshClaudePath: () => claudePath,
			},
		} as never,
	) as AutoRefreshScheduler & {
		sendDummyMessage(row: typeof account): Promise<boolean>;
	};
	return { scheduler, runCalls };
}

const account = {
	id: "account-cli",
	name: "Account CLI",
	provider: "anthropic",
	refresh_token: "refresh-token",
	access_token: "access-token",
	expires_at: 1,
	rate_limit_reset: null,
	custom_endpoint: null,
	paused: 0,
	auto_pause_on_overage_enabled: 0,
	pause_reason: null,
};

describe("AutoRefreshScheduler with the claude-cli client", () => {
	it("treats the proxy's 401 to the CLI's probe like a synthetic probe's", async () => {
		proxyHits = [];
		proxyReply = () => new Response("Unauthorized", { status: 401 });
		const { scheduler, runCalls } = await makeScheduler(fakeClaude);

		const result = await scheduler.sendDummyMessage(account);

		expect(result).toBe(false);
		expect(proxyHits).toHaveLength(1);
		expect(proxyHits[0].get("x-better-ccflare-account-id")).toBe("account-cli");
		expect(proxyHits[0].get("x-better-ccflare-internal-probe-secret")).toBe(
			"probe-s3cret",
		);
		expect(runCalls).toHaveLength(1);
		const [sql, params] = runCalls[0];
		expect(sql).toContain("auto_refresh_enabled = 0");
		expect(params).toEqual(["account-cli"]);
	});

	it("does not count a 200 whose stream then failed as a refresh", async () => {
		proxyHits = [];
		proxyReply = () =>
			new Response(
				'event: message_start\ndata: {"type":"message_start"}\n\nevent: error\ndata: {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}\n\n',
				{
					status: 200,
					headers: {
						"content-type": "text/event-stream",
						"anthropic-ratelimit-unified-reset": "1790000000",
					},
				},
			);
		const { scheduler, runCalls } = await makeScheduler(fakeClaude);

		const result = await scheduler.sendDummyMessage(account);

		expect(result).toBe(false);
		expect(proxyHits).toHaveLength(1);
		// No rate_limit_reset update, no cooldown cleared, no account resumed.
		expect(runCalls).toHaveLength(0);
	});

	it("sends nothing and changes nothing when the CLI cannot run", async () => {
		proxyHits = [];
		const { scheduler, runCalls } = await makeScheduler(
			join(dir, "no-such-claude"),
		);

		const result = await scheduler.sendDummyMessage(account);

		expect(result).toBe(false);
		expect(proxyHits).toHaveLength(0);
		expect(runCalls).toHaveLength(0);
	});

	// The synthetic probe still carries its frozen header set.
	const isSynthetic = (headers: Headers) =>
		headers.get("x-stainless-package-version") === "0.60.0";

	it("auto: uses the CLI when it is installed", async () => {
		proxyHits = [];
		proxyReply = () => new Response("Unauthorized", { status: 401 });
		const { scheduler } = await makeScheduler(fakeClaude, "auto");

		await scheduler.sendDummyMessage(account);

		expect(proxyHits).toHaveLength(1);
		expect(isSynthetic(proxyHits[0])).toBe(false);
	});

	it("auto: sends the synthetic probe when the CLI is not installed", async () => {
		proxyHits = [];
		proxyReply = () => new Response("Unauthorized", { status: 401 });
		const { scheduler, runCalls } = await makeScheduler(
			join(dir, "no-such-claude"),
			"auto",
		);

		const result = await scheduler.sendDummyMessage(account);

		expect(result).toBe(false);
		expect(proxyHits).toHaveLength(1);
		expect(isSynthetic(proxyHits[0])).toBe(true);
		// Handled as any synthetic probe's 401.
		expect(runCalls[0]?.[0]).toContain("auto_refresh_enabled = 0");
	});

	it("auto: falls back to the synthetic probe when the CLI sends nothing", async () => {
		proxyHits = [];
		proxyReply = () => new Response("Unauthorized", { status: 401 });
		const { scheduler } = await makeScheduler(oldClaude, "auto");

		await scheduler.sendDummyMessage(account);

		expect(proxyHits).toHaveLength(1);
		expect(isSynthetic(proxyHits[0])).toBe(true);
	});

	it("claude-cli: does not fall back when the CLI sends nothing", async () => {
		proxyHits = [];
		const { scheduler, runCalls } = await makeScheduler(oldClaude);

		const result = await scheduler.sendDummyMessage(account);

		expect(result).toBe(false);
		expect(proxyHits).toHaveLength(0);
		expect(runCalls).toHaveLength(0);
	});
});
