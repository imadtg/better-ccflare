import { randomBytes, timingSafeEqual } from "node:crypto";
import {
	closeSync,
	mkdtempSync,
	openSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AutoRefreshClient } from "@better-ccflare/config";
import { Logger } from "@better-ccflare/logger";

const log = new Logger("AutoRefreshClaudeCli");

/** Longest the CLI may run, response included, before the probe is abandoned. */
export const CLAUDE_CLI_PROBE_TIMEOUT_MS = 120_000;

/**
 * How much of the probe's response body is kept for the scheduler. The body is
 * only logged and checked for a local-refusal error type, both of which need
 * the first few hundred bytes at most.
 */
const MAX_CAPTURED_BODY_BYTES = 64 * 1024;

/**
 * The client a probe is sent with. "auto" means the CLI if `claudePath` names
 * an executable (on PATH, or a path), so installing Claude Code is enough to
 * switch, and the synthetic probe on installs without it, Docker included.
 */
export function resolveAutoRefreshClient(
	configured: AutoRefreshClient,
	claudePath: string,
	which: (command: string) => string | null = Bun.which,
): "synthetic" | "claude-cli" {
	if (configured !== "auto") return configured;
	return which(claudePath) ? "claude-cli" : "synthetic";
}

export interface ClaudeCliProbeOptions {
	/** Executable to run: a bare name resolved on PATH, or a path. */
	claudePath: string;
	/** The prompt claimed from the auto-refresh pool. */
	prompt: string;
	/** Origin of this proxy, e.g. `http://localhost:8080`. */
	proxyOrigin: string;
	/**
	 * Headers the proxy needs to route and authorise the probe (forced account,
	 * session bypass, auto-refresh marker, probe secret). Added by the relay,
	 * never handed to the CLI.
	 */
	internalHeaders: Record<string, string>;
	timeoutMs?: number;
}

export interface ClaudeCliProbeResult {
	/** Whether a Messages request reached the proxy, i.e. the prompt was spent. */
	sent: boolean;
	/**
	 * The proxy's answer to that request, with the body read back (capped). Null
	 * when nothing was sent, or when the request went out but no answer came back.
	 */
	response: Response | null;
	exitCode: number | null;
	error?: string;
}

function isMessagesRequest(method: string, pathname: string): boolean {
	return method === "POST" && pathname === "/v1/messages";
}

/**
 * Ends the CLI and anything it started. It runs as the leader of its own
 * process group, so a wrapper script's children go with it.
 */
function killProcessTree(proc: {
	pid: number;
	kill(signal?: number | NodeJS.Signals): void;
}): void {
	try {
		if (process.platform === "win32") proc.kill("SIGKILL");
		else process.kill(-proc.pid, "SIGKILL");
	} catch {
		// Already gone.
	}
}

function hasToken(header: string | null, token: string): boolean {
	const expected = Buffer.from(`Bearer ${token}`);
	const actual = Buffer.from(header ?? "");
	return (
		actual.byteLength === expected.byteLength &&
		timingSafeEqual(actual, expected)
	);
}

/**
 * Passes `body` through, except that the error the deadline puts into it ends
 * the stream instead: the CLI reading it has been killed by then, and an
 * errored response body would only surface as an unhandled rejection.
 */
function endsAtDeadline(
	body: ReadableStream<Uint8Array>,
	signal: AbortSignal,
): ReadableStream<Uint8Array> {
	const reader = body.getReader();
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { done, value } = await reader.read();
				if (done) controller.close();
				else controller.enqueue(value);
			} catch (error) {
				if (signal.aborted) controller.close();
				else controller.error(error);
			}
		},
		cancel(reason) {
			return reader.cancel(reason);
		},
	});
}

interface CapturedAnswer {
	/** The body as far as it is kept (capped). */
	text: string;
	/**
	 * Whether the answer arrived whole: a stream that reached `message_stop`
	 * without an `error` event, or a non-streamed message.
	 */
	complete: boolean;
}

/**
 * Reads the proxy's answer alongside the CLI. It judges the whole stream, not
 * just the kept part: a 200 is only a refresh if the reply behind it finished.
 */
async function readAnswer(
	body: ReadableStream<Uint8Array> | null,
	contentType: string,
): Promise<CapturedAnswer> {
	if (!body) return { text: "", complete: false };
	const streamed = contentType.includes("text/event-stream");
	const reader = body.getReader();
	const decoder = new TextDecoder();
	const chunks: Uint8Array[] = [];
	let size = 0;
	let line = "";
	let stopped = false;
	let errored = false;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (size < MAX_CAPTURED_BODY_BYTES) {
				chunks.push(value.subarray(0, MAX_CAPTURED_BODY_BYTES - size));
				size += value.byteLength;
			}
			if (!streamed) continue;
			const lines = (line + decoder.decode(value, { stream: true })).split(
				"\n",
			);
			line = lines.pop() ?? "";
			for (const l of lines) {
				const event = l.startsWith("event:") ? l.slice(6).trim() : null;
				if (event === "message_stop") stopped = true;
				if (event === "error") errored = true;
			}
		}
	} catch {
		// Cut off: whatever arrived is kept, and the answer is incomplete.
		return { text: decode(chunks), complete: false };
	}
	const text = decode(chunks);
	if (streamed) return { text, complete: stopped && !errored };
	try {
		return { text, complete: JSON.parse(text)?.type === "message" };
	} catch {
		return { text, complete: false };
	}
}

function decode(chunks: Uint8Array[]): string {
	return new TextDecoder().decode(Buffer.concat(chunks));
}

/**
 * Sends an auto-refresh probe as a real `claude -p` run instead of a request
 * assembled by hand.
 *
 * The synthetic probe imitates Claude Code's headers with values frozen at the
 * time they were copied, so it drifts away from what the CLI actually sends.
 * Running the CLI means the request on the wire is whatever the installed
 * Claude Code produces, current by construction.
 *
 * The CLI talks to a loopback relay rather than to the proxy directly. The
 * relay adds the internal routing headers and records the proxy's answer for
 * the scheduler, so the probe secret never enters the child's environment or
 * argv, and the scheduler sees the same status and rate-limit headers it
 * would from the synthetic probe.
 */
export async function sendAutoRefreshViaClaudeCli(
	options: ClaudeCliProbeOptions,
): Promise<ClaudeCliProbeResult> {
	const {
		claudePath,
		prompt,
		proxyOrigin,
		internalHeaders,
		timeoutMs = CLAUDE_CLI_PROBE_TIMEOUT_MS,
	} = options;

	let sent = false;
	let captured: Promise<{ response: Response; complete: boolean }> | null =
		null;
	// Any local process can reach a loopback port, and the relay attaches the
	// probe secret: it only serves the CLI it started, which proves itself with
	// this token in place of an API key.
	const relayToken = randomBytes(32).toString("hex");
	// Ends everything the probe started: the CLI, and the relay's requests to
	// the proxy, so an answer that stalls mid-stream cannot outlive the timeout.
	const deadline = new AbortController();

	const relay = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 0,
		async fetch(req) {
			if (!hasToken(req.headers.get("authorization"), relayToken)) {
				return new Response(null, { status: 401 });
			}
			const url = new URL(req.url);
			// One probe, one request. Claude Code can ask again on its own
			// (after a 404, to continue a reply cut at max_tokens); each would
			// spend quota the scheduler never decided to spend.
			if (sent || !isMessagesRequest(req.method, url.pathname)) {
				return Response.json(
					{
						type: "error",
						error: {
							type: "invalid_request_error",
							message:
								"An auto-refresh probe sends exactly one Messages request.",
						},
					},
					{ status: 400 },
				);
			}
			sent = true;
			const headers = new Headers(req.headers);
			// The CLI's token only opens the relay: the proxy authenticates the
			// probe by its secret and sends the account's own credentials upstream.
			headers.delete("authorization");
			headers.delete("x-api-key");
			headers.delete("host");
			for (const [name, value] of Object.entries(internalHeaders)) {
				headers.set(name, value);
			}

			let upstream: Response;
			try {
				upstream = await fetch(`${proxyOrigin}${url.pathname}${url.search}`, {
					method: req.method,
					headers,
					body: req.body,
					signal: deadline.signal,
					...(req.body ? ({ duplex: "half" } as RequestInit) : {}),
				});
			} catch (error) {
				// Nothing is recorded: to the scheduler this is a probe that went
				// out and got no answer, the same as a synthetic probe's fetch error.
				if (!deadline.signal.aborted) {
					log.warn(`Claude CLI probe could not reach the proxy: ${error}`);
				}
				return new Response(null, { status: 502 });
			}

			// fetch has already decoded the body, so its framing headers no
			// longer describe what the CLI will receive.
			const responseHeaders = new Headers(upstream.headers);
			responseHeaders.delete("content-encoding");
			responseHeaders.delete("content-length");
			responseHeaders.delete("transfer-encoding");

			const { status, statusText } = upstream;
			const recorded = new Headers(responseHeaders);
			let clientBody: ReadableStream<Uint8Array> | null = null;
			let copy: ReadableStream<Uint8Array> | null = null;
			if (upstream.body) [clientBody, copy] = upstream.body.tee();
			captured = readAnswer(copy, recorded.get("content-type") ?? "").then(
				({ text, complete }) => ({
					response: new Response(text, {
						status,
						statusText,
						headers: recorded,
					}),
					complete,
				}),
			);

			return new Response(
				clientBody && endsAtDeadline(clientBody, deadline.signal),
				{
					status: upstream.status,
					statusText: upstream.statusText,
					headers: responseHeaders,
				},
			);
		},
	});

	let home: string | undefined;
	try {
		// A fresh, private HOME and config dir per run: nothing carries between
		// probes, and none of the operator's own Claude Code setup applies.
		home = mkdtempSync(join(tmpdir(), "claude-"));
		const outputPath = join(home, "output.log");
		const output = openSync(outputPath, "w");

		let proc: ReturnType<typeof Bun.spawn>;
		try {
			proc = Bun.spawn(
				[
					// A relative path means relative to the server, as when it was
					// found by resolveAutoRefreshClient; the CLI runs from "/".
					/[\\/]/.test(claudePath) ? resolve(claudePath) : claudePath,
					"-p",
					prompt,
					"--model",
					"haiku",
					"--no-session-persistence",
					// The tools stay in the request, as in any Claude Code run,
					// but none is ever executed: a reply asking for one ends the
					// run, so no answer can make the CLI read local files and
					// send them in a follow-up request.
					"--max-turns",
					"1",
				],
				{
					// Claude Code describes its working directory to the model and
					// loads CLAUDE.md files, skills and agents from every directory
					// above it. Under a shared, world-writable temporary directory
					// any local user could plant those; the filesystem root has no
					// ancestors and is writable only by root.
					cwd: "/",
					// Built from scratch: nothing from the server's environment
					// (credentials, base URLs, proxies) reaches the CLI.
					env: {
						PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
						HOME: home,
						CLAUDE_CONFIG_DIR: join(home, ".claude"),
						ANTHROPIC_BASE_URL: `http://127.0.0.1:${relay.port}`,
						ANTHROPIC_AUTH_TOKEN: relayToken,
						CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
						// One probe, one request: the scheduler decides what a
						// failure means and when to try again. Retries are not the
						// only second request: after a failed stream the CLI asks
						// again without streaming unless told not to.
						CLAUDE_CODE_MAX_RETRIES: "0",
						CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK: "1",
						// Auto-memory writes the config dir's path into the prompt,
						// and that path is under TMPDIR, which can name the operator
						// (on Windows it is inside their profile).
						CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
					},
					detached: true,
					stdin: "ignore",
					// A file rather than pipes: a pipe held open by a leftover
					// descendant would keep the probe waiting for EOF.
					stdout: output,
					stderr: output,
				},
			);
		} catch (error) {
			return {
				sent: false,
				response: null,
				exitCode: null,
				error: `could not start ${claudePath}: ${error instanceof Error ? error.message : String(error)}`,
			};
		} finally {
			closeSync(output);
		}

		let timedOut = false;
		const timer = setTimeout(() => {
			timedOut = true;
			killProcessTree(proc);
			deadline.abort();
		}, timeoutMs);
		let exitCode: number;
		let answer: { response: Response; complete: boolean } | null;
		try {
			exitCode = await proc.exited;
			// A CLI that gave up mid-stream leaves the proxy's answer still
			// arriving; the same deadline bounds reading it.
			answer = captured
				? await (captured as Promise<{ response: Response; complete: boolean }>)
				: null;
		} finally {
			clearTimeout(timer);
			killProcessTree(proc);
		}
		const response = answer?.response ?? null;
		// The answer decides, not the CLI's exit status: a whole 2xx answer is
		// a refresh even if the CLI then stops non-zero (a reply asking for a
		// tool hits --max-turns, a follow-up request is refused), and a 2xx
		// whose stream failed is not one even if the CLI exits 0.
		let error: string | undefined;
		if (timedOut) {
			error = `the probe did not finish within ${timeoutMs}ms`;
		} else if (response?.ok && !answer?.complete) {
			error = "the proxy's answer did not complete";
		} else if (exitCode !== 0 && !response?.ok) {
			const output = readFileSync(outputPath, "utf8").trim().slice(0, 500);
			error = `claude exited with ${exitCode}: ${output}`;
		}
		if (error) log.debug(`Claude CLI probe: ${error}`);
		return { sent, response, exitCode, error };
	} finally {
		deadline.abort();
		relay.stop(true);
		if (home) rmSync(home, { recursive: true, force: true });
	}
}
