import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "./index";

const ENV_KEY = "CCFLARE_AUTO_REFRESH_CLIENT";
const original = process.env[ENV_KEY];

function makeConfig(file: object = {}): {
	config: Config;
	cleanup: () => void;
} {
	const dir = mkdtempSync(join(tmpdir(), "better-ccflare-config-"));
	const path = join(dir, "config.json");
	writeFileSync(path, JSON.stringify(file));
	return {
		config: new Config(path),
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

describe("auto-refresh client setting", () => {
	afterEach(() => {
		if (original === undefined) delete process.env[ENV_KEY];
		else process.env[ENV_KEY] = original;
	});

	it("defaults to auto", () => {
		delete process.env[ENV_KEY];
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getAutoRefreshClient()).toBe("auto");
		} finally {
			cleanup();
		}
	});

	it("takes the env var over the config file, and ignores unknown values", () => {
		const { config, cleanup } = makeConfig({
			auto_refresh_client: "claude-cli",
		});
		try {
			delete process.env[ENV_KEY];
			expect(config.getAutoRefreshClient()).toBe("claude-cli");
			process.env[ENV_KEY] = "synthetic";
			expect(config.getAutoRefreshClient()).toBe("synthetic");
			process.env[ENV_KEY] = "cli";
			expect(config.getAutoRefreshClient()).toBe("claude-cli");
		} finally {
			cleanup();
		}
	});
});
