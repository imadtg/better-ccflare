import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { AnthropicProvider } from "@better-ccflare/providers";
import { makeProxyRequest } from "../request-handler";

/**
 * Regression for tombii#336 / Greptile P1 "Probe Secret Reaches Provider Path":
 * the internal probe secret (and the marker headers it gates) must be stripped
 * before the request is forwarded upstream, so a provider or custom endpoint
 * never receives the process-local capability secret.
 */
describe("makeProxyRequest strips internal control headers before provider forward", () => {
	let realFetch: typeof globalThis.fetch;
	let sentHeaders: Headers | undefined;

	beforeEach(() => {
		realFetch = globalThis.fetch;
		sentHeaders = undefined;
		globalThis.fetch = mock(async (input: unknown, init?: RequestInit) => {
			sentHeaders =
				input instanceof Request
					? new Headers(input.headers)
					: new Headers(init?.headers);
			return new Response("ok", { status: 200 });
		}) as unknown as typeof globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	it("does not forward the probe secret or markers on the headers-param path", async () => {
		const headers = new Headers({
			"x-better-ccflare-internal-probe-secret": "s3cr3t",
			"x-better-ccflare-auto-refresh": "true",
			"x-better-ccflare-keepalive": "true",
			"x-better-ccflare-request-id": "internal-request-id",
			"x-better-ccflare-request-stream": "true",
			"x-better-ccflare-codex-custom-tools": "true",
			"x-better-ccflare-native-responses": "true",
			"x-better-ccflare-authenticated-caller": "forged-caller",
			"x-better-ccflare-exclude-providers": "anthropic-oauth",
			"x-better-ccflare-codex-continuation": "previous_response_id",
			"x-better-ccflare-prompt-cache-mode": "implicit",
			"x-better-ccflare-prompt-cache-ttl": "30m",
			"x-better-ccflare-prompt-cache-breakpoint": "developer",
			"x-better-ccflare-codex-path": "native_responses",
			"x-better-ccflare-codex-transport": "sse",
			authorization: "Bearer token",
			"content-type": "application/json",
		});
		await makeProxyRequest(
			"https://api.anthropic.com/v1/messages",
			"POST",
			headers,
			undefined,
			false,
		);
		expect(
			sentHeaders?.get("x-better-ccflare-internal-probe-secret"),
		).toBeNull();
		expect(sentHeaders?.get("x-better-ccflare-auto-refresh")).toBeNull();
		expect(sentHeaders?.get("x-better-ccflare-keepalive")).toBeNull();
		expect(sentHeaders?.get("x-better-ccflare-request-id")).toBeNull();
		expect(sentHeaders?.get("x-better-ccflare-request-stream")).toBeNull();
		expect(sentHeaders?.get("x-better-ccflare-codex-custom-tools")).toBeNull();
		expect(sentHeaders?.get("x-better-ccflare-native-responses")).toBeNull();
		expect(
			sentHeaders?.get("x-better-ccflare-authenticated-caller"),
		).toBeNull();
		expect(sentHeaders?.get("x-better-ccflare-exclude-providers")).toBeNull();
		for (const header of [
			"x-better-ccflare-codex-continuation",
			"x-better-ccflare-prompt-cache-mode",
			"x-better-ccflare-prompt-cache-ttl",
			"x-better-ccflare-prompt-cache-breakpoint",
			"x-better-ccflare-codex-path",
			"x-better-ccflare-codex-transport",
		]) {
			expect(sentHeaders?.get(header)).toBeNull();
		}
		// unrelated headers still forwarded
		expect(sentHeaders?.get("authorization")).toBe("Bearer token");
		expect(sentHeaders?.get("content-type")).toBe("application/json");
	});

	it("does not forward the probe secret on the Request-target path", async () => {
		const req = new Request("https://api.anthropic.com/v1/messages", {
			method: "POST",
			headers: {
				"x-better-ccflare-internal-probe-secret": "s3cr3t",
				"x-better-ccflare-keepalive": "true",
				"x-better-ccflare-request-id": "internal-request-id",
				"x-better-ccflare-native-responses": "true",
				"x-better-ccflare-authenticated-caller": "forged-caller",
				"x-better-ccflare-exclude-providers": "anthropic-oauth",
				"x-better-ccflare-codex-continuation": "previous_response_id",
				"x-better-ccflare-prompt-cache-mode": "implicit",
				"x-better-ccflare-prompt-cache-ttl": "30m",
				"x-better-ccflare-prompt-cache-breakpoint": "developer",
				"x-better-ccflare-codex-path": "native_responses",
				"x-better-ccflare-codex-transport": "sse",
				authorization: "Bearer token",
			},
		});
		await makeProxyRequest(req);
		expect(
			sentHeaders?.get("x-better-ccflare-internal-probe-secret"),
		).toBeNull();
		expect(sentHeaders?.get("x-better-ccflare-keepalive")).toBeNull();
		expect(sentHeaders?.get("x-better-ccflare-request-id")).toBeNull();
		expect(sentHeaders?.get("x-better-ccflare-native-responses")).toBeNull();
		expect(
			sentHeaders?.get("x-better-ccflare-authenticated-caller"),
		).toBeNull();
		expect(sentHeaders?.get("x-better-ccflare-exclude-providers")).toBeNull();
		for (const header of [
			"x-better-ccflare-codex-continuation",
			"x-better-ccflare-prompt-cache-mode",
			"x-better-ccflare-prompt-cache-ttl",
			"x-better-ccflare-prompt-cache-breakpoint",
			"x-better-ccflare-codex-path",
			"x-better-ccflare-codex-transport",
		]) {
			expect(sentHeaders?.get(header)).toBeNull();
		}
		expect(sentHeaders?.get("authorization")).toBe("Bearer token");
	});

	// The schedulers' routing headers (forced account, session bypass) were
	// never on the strip list, and most providers override prepareHeaders()
	// without BaseProvider's prefix sweep, so they reached the provider.
	const routingAndFutureHeaders = {
		"x-better-ccflare-account-id": "00000000-0000-0000-0000-000000000001",
		"x-better-ccflare-bypass-session": "true",
		"x-better-ccflare-some-future-header": "1",
	};

	it("does not forward routing or unlisted internal headers on the headers-param path", async () => {
		await makeProxyRequest(
			"https://api.anthropic.com/v1/messages",
			"POST",
			new Headers({ ...routingAndFutureHeaders, "x-api-key": "k" }),
			undefined,
			false,
		);
		for (const header of Object.keys(routingAndFutureHeaders)) {
			expect(sentHeaders?.get(header)).toBeNull();
		}
		expect(sentHeaders?.get("x-api-key")).toBe("k");
	});

	it("does not forward routing or unlisted internal headers on the Request-target path", async () => {
		await makeProxyRequest(
			new Request("https://api.anthropic.com/v1/messages", {
				method: "POST",
				headers: { ...routingAndFutureHeaders, "x-api-key": "k" },
			}),
		);
		for (const header of Object.keys(routingAndFutureHeaders)) {
			expect(sentHeaders?.get(header)).toBeNull();
		}
		expect(sentHeaders?.get("x-api-key")).toBe("k");
	});

	it("sends no internal header to Anthropic for an auto-refresh probe", async () => {
		// The header set AutoRefreshScheduler attaches, through the Anthropic
		// provider's own prepareHeaders() as proxyWithAccount does.
		const probeHeaders = new Headers({
			"anthropic-version": "2023-06-01",
			"x-better-ccflare-account-id": "00000000-0000-0000-0000-000000000001",
			"x-better-ccflare-bypass-session": "true",
			"x-better-ccflare-auto-refresh": "true",
			"x-better-ccflare-internal-probe-secret": "s3cr3t",
		});
		const outgoing = new AnthropicProvider().prepareHeaders(
			probeHeaders,
			"access-token",
		);
		await makeProxyRequest(
			"https://api.anthropic.com/v1/messages",
			"POST",
			outgoing,
			undefined,
			false,
		);
		const leaked = [...(sentHeaders?.keys() ?? [])].filter((key) =>
			key.startsWith("x-better-ccflare-"),
		);
		expect(leaked).toEqual([]);
		expect(sentHeaders?.get("authorization")).toBe("Bearer access-token");
	});
});
