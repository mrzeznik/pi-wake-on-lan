import { beforeEach, describe, expect, it, vi } from "vitest";

const wol = vi.hoisted(() => {
	const ensureAwake = vi.fn(async () => {});
	return {
		ensureAwake,
		// Return the shared spy by default so `index.ts`'s top-level
		// `createWaker()` call (which runs at import time) is wired correctly.
		createWaker: vi.fn(() => ensureAwake),
		deriveProbeUrl: vi.fn(),
		loadConfig: vi.fn(),
		saveConfig: vi.fn(),
		validateConfig: vi.fn(() => [] as string[]),
		validateIpv4: vi.fn(() => true),
		validateMac: vi.fn(() => null),
		validateUrl: vi.fn(() => null),
		agentDir: "/tmp/pi-wake-agent",
	};
});

const CONFIG_PATH = "/tmp/pi-wake-agent/wol.json";

vi.mock("@earendil-works/pi-coding-agent", () => ({
	getAgentDir: () => wol.agentDir,
}));

vi.mock("./wol", () => ({
	createWaker: wol.createWaker,
	deriveProbeUrl: wol.deriveProbeUrl,
	loadConfig: wol.loadConfig,
	saveConfig: wol.saveConfig,
	validateConfig: wol.validateConfig,
	validateIpv4: wol.validateIpv4,
	validateMac: wol.validateMac,
	validateUrl: wol.validateUrl,
}));

import createExtension from "./index";

function makePi() {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => Promise<void> | void>();
	const commands = new Map<string, { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }>();
	const pi = {
		on: vi.fn((event: string, handler: (event: unknown, ctx: unknown) => Promise<void> | void) => {
			handlers.set(event, handler);
		}),
		registerCommand: vi.fn((name: string, options: { description?: string; handler: (args: string, ctx: unknown) => Promise<void> }) => {
			commands.set(name, options);
		}),
	};
	return { pi, handlers, commands };
}

function makeCtx(overrides: Record<string, unknown> = {}) {
	return {
		ui: { notify: vi.fn(), editor: vi.fn(async () => undefined) },
		hasUI: true,
		model: undefined,
		modelRegistry: { getProvider: vi.fn(() => undefined) },
		signal: undefined,
		...overrides,
	};
}

function validConfig() {
	return {
		mac: "AA:BB:CC:DD:EE:FF",
		waitForHost: 0,
		providers: ["local-llm"],
		useProbe: true,
		broadcastAddress: "255.255.255.255",
		wolPort: 9,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	wol.validateConfig.mockReturnValue([]);
	wol.validateMac.mockReturnValue(null);
	wol.validateUrl.mockReturnValue(null);
	wol.validateIpv4.mockReturnValue(true);
	wol.deriveProbeUrl.mockReturnValue("http://192.0.2.50:1234/v1/models");
});

describe("before_provider_request", () => {
	it("does nothing when there is no current model", async () => {
		const { pi, handlers } = makePi();
		createExtension(pi as never);
		wol.loadConfig.mockReturnValue(validConfig());

		const ctx = makeCtx({ model: undefined });
		await handlers.get("before_provider_request")!({}, ctx);

		expect(wol.ensureAwake).not.toHaveBeenCalled();
	});

	it("does nothing when no MAC is configured", async () => {
		const { pi, handlers } = makePi();
		createExtension(pi as never);
		wol.loadConfig.mockReturnValue({ ...validConfig(), mac: "" });

		const ctx = makeCtx({ model: { provider: "local-llm", baseUrl: "http://x/v1" } });
		await handlers.get("before_provider_request")!({}, ctx);

		expect(wol.ensureAwake).not.toHaveBeenCalled();
	});

	it("does nothing when the provider is not in the list", async () => {
		const { pi, handlers } = makePi();
		createExtension(pi as never);
		wol.loadConfig.mockReturnValue(validConfig());

		const ctx = makeCtx({ model: { provider: "other", baseUrl: "http://y/v1" } });
		await handlers.get("before_provider_request")!({}, ctx);

		expect(wol.ensureAwake).not.toHaveBeenCalled();
	});

	it("wakes when the provider matches, deriving the probe URL from the model", async () => {
		const { pi, handlers } = makePi();
		createExtension(pi as never);
		wol.loadConfig.mockReturnValue(validConfig());

		const ctx = makeCtx({
			model: { provider: "local-llm", baseUrl: "http://192.0.2.50:1234/v1" },
		});
		ctx.modelRegistry.getProvider.mockReturnValue({ baseUrl: "http://192.0.2.50:1234/v1" });

		await handlers.get("before_provider_request")!({}, ctx);

		expect(wol.deriveProbeUrl).toHaveBeenCalledWith(undefined, "http://192.0.2.50:1234/v1", "http://192.0.2.50:1234/v1");
		expect(wol.ensureAwake).toHaveBeenCalledTimes(1);

		const [cfg, probeUrl, signal, notify] = wol.ensureAwake.mock.calls[0];
		expect(cfg).toEqual(validConfig());
		expect(probeUrl).toBe("http://192.0.2.50:1234/v1/models");
		expect(signal).toBeUndefined();

		notify("hello", "info");
		expect(ctx.ui.notify).toHaveBeenCalledWith("hello", "info");
	});

	it("passes the provider baseUrl as the fallback candidate", async () => {
		const { pi, handlers } = makePi();
		createExtension(pi as never);
		wol.loadConfig.mockReturnValue(validConfig());

		const ctx = makeCtx({
			model: { provider: "local-llm", baseUrl: "http://192.0.2.50:1234/v1" },
		});
		ctx.modelRegistry.getProvider.mockReturnValue({ baseUrl: "http://fallback/v1" });

		await handlers.get("before_provider_request")!({}, ctx);

		expect(wol.deriveProbeUrl).toHaveBeenCalledWith(undefined, "http://192.0.2.50:1234/v1", "http://fallback/v1");
	});

	it("passes an explicit probeUrl override through", async () => {
		const { pi, handlers } = makePi();
		createExtension(pi as never);
		wol.loadConfig.mockReturnValue({ ...validConfig(), probeUrl: "http://custom/health" });

		const ctx = makeCtx({ model: { provider: "local-llm", baseUrl: "http://x/v1" } });
		await handlers.get("before_provider_request")!({}, ctx);

		expect(wol.deriveProbeUrl).toHaveBeenCalledWith("http://custom/health", "http://x/v1", undefined);
	});

	it("skips probe derivation when probing is disabled", async () => {
		const { pi, handlers } = makePi();
		createExtension(pi as never);
		wol.loadConfig.mockReturnValue({ ...validConfig(), useProbe: false });

		const ctx = makeCtx({ model: { provider: "local-llm", baseUrl: "http://x/v1" } });
		await handlers.get("before_provider_request")!({}, ctx);

		expect(wol.deriveProbeUrl).not.toHaveBeenCalled();
		expect(wol.ensureAwake).toHaveBeenCalledWith(expect.anything(), undefined, undefined, expect.any(Function));
	});

	it("passes undefined probeUrl when probing is enabled but no base URL is available", async () => {
		const { pi, handlers } = makePi();
		createExtension(pi as never);
		wol.loadConfig.mockReturnValue(validConfig());
		wol.deriveProbeUrl.mockReturnValue(undefined);

		const ctx = makeCtx({ model: { provider: "local-llm", baseUrl: "" } });
		await handlers.get("before_provider_request")!({}, ctx);

		expect(wol.deriveProbeUrl).toHaveBeenCalled();
		expect(wol.ensureAwake).toHaveBeenCalledWith(expect.anything(), undefined, undefined, expect.any(Function));
	});

	it("passes the abort signal through to the waker", async () => {
		const { pi, handlers } = makePi();
		createExtension(pi as never);
		wol.loadConfig.mockReturnValue(validConfig());
		const ctrl = new AbortController();

		const ctx = makeCtx({ model: { provider: "local-llm", baseUrl: "http://x/v1" }, signal: ctrl.signal });
		await handlers.get("before_provider_request")!({}, ctx);

		const [, , signal] = wol.ensureAwake.mock.calls[0];
		expect(signal).toBe(ctrl.signal);
	});

	it("never rejects, even when config loading throws", async () => {
		const { pi, handlers } = makePi();
		createExtension(pi as never);
		wol.loadConfig.mockImplementation(() => {
			throw new Error("boom");
		});

		const ctx = makeCtx({ model: { provider: "local-llm", baseUrl: "http://x/v1" } });
		await expect(handlers.get("before_provider_request")!({}, ctx)).resolves.toBeUndefined();
	});
});

describe("/wol command", () => {
	function setup() {
		const { pi, commands } = makePi();
		createExtension(pi as never);
		const command = commands.get("wol")!;
		return { command, ctx: makeCtx() };
	}

	it("registers the command with a description", () => {
		const { pi, commands } = makePi();
		createExtension(pi as never);
		expect(commands.get("wol")?.description).toBeTruthy();
	});

	it("shows configuration via the editor", async () => {
		const { command, ctx } = setup();
		wol.loadConfig.mockReturnValue(validConfig());
		wol.validateConfig.mockReturnValue(["mac: bad"]);

		await command.handler("", ctx as never);

		expect(ctx.ui.editor).toHaveBeenCalledWith("pi-wake configuration", expect.stringContaining("Wake-on-LAN configuration"));
		expect(ctx.ui.editor).toHaveBeenCalledWith(expect.anything(), expect.stringContaining("Validation errors"));
	});

	it("falls back to notify when there is no UI", async () => {
		const { command, ctx } = setup();
		ctx.hasUI = false;
		wol.loadConfig.mockReturnValue(validConfig());

		await command.handler("status", ctx as never);

		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Wake-on-LAN configuration"), "info");
	});

	it("reports an unknown subcommand", async () => {
		const { command, ctx } = setup();
		wol.loadConfig.mockReturnValue(validConfig());

		await command.handler("bogus", ctx as never);

		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("unknown subcommand"), "error");
	});

	it("sets a valid MAC", async () => {
		const { command, ctx } = setup();
		wol.loadConfig.mockReturnValue(validConfig());
		wol.validateMac.mockReturnValue(null);

		await command.handler("mac AA:BB:CC:DD:EE:FF", ctx as never);

		expect(wol.validateMac).toHaveBeenCalledWith("AA:BB:CC:DD:EE:FF");
		expect(wol.saveConfig).toHaveBeenCalledTimes(1);
		const [savedPath, savedCfg] = wol.saveConfig.mock.calls[0];
		expect(savedPath).toBe(CONFIG_PATH);
		expect(savedCfg.mac).toBe("AA:BB:CC:DD:EE:FF");
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("MAC set"), "info");
	});

	it("rejects an invalid MAC without saving", async () => {
		const { command, ctx } = setup();
		wol.loadConfig.mockReturnValue(validConfig());
		wol.validateMac.mockReturnValue("MAC must look like…");

		await command.handler("mac zz", ctx as never);

		expect(wol.saveConfig).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("MAC must look like…"), "error");
	});

	it("requires a value for mac", async () => {
		const { command, ctx } = setup();
		wol.loadConfig.mockReturnValue(validConfig());

		await command.handler("mac", ctx as never);

		expect(wol.saveConfig).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Usage: /wol mac"), "error");
	});

	it("sets a probe URL", async () => {
		const { command, ctx } = setup();
		wol.loadConfig.mockReturnValue(validConfig());
		wol.validateUrl.mockReturnValue(null);

		await command.handler("probe http://x/health", ctx as never);

		const [, savedCfg] = wol.saveConfig.mock.calls[0];
		expect(savedCfg.probeUrl).toBe("http://x/health");
	});

	it("clears the probe URL with 'auto'", async () => {
		const { command, ctx } = setup();
		wol.loadConfig.mockReturnValue({ ...validConfig(), probeUrl: "http://x/health" });

		await command.handler("probe auto", ctx as never);

		const [, savedCfg] = wol.saveConfig.mock.calls[0];
		expect(savedCfg.probeUrl).toBeUndefined();
	});

	it("rejects an invalid probe URL", async () => {
		const { command, ctx } = setup();
		wol.loadConfig.mockReturnValue(validConfig());
		wol.validateUrl.mockReturnValue("must be a valid URL.");

		await command.handler("probe nope", ctx as never);

		expect(wol.saveConfig).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("must be a valid URL."), "error");
	});

	it("sets waitForHost", async () => {
		const { command, ctx } = setup();
		wol.loadConfig.mockReturnValue(validConfig());

		await command.handler("wait 5000", ctx as never);

		const [, savedCfg] = wol.saveConfig.mock.calls[0];
		expect(savedCfg.waitForHost).toBe(5000);
	});

	it("rejects an invalid wait value", async () => {
		const { command, ctx } = setup();
		wol.loadConfig.mockReturnValue(validConfig());

		await command.handler("wait -5", ctx as never);

		expect(wol.saveConfig).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Usage: /wol wait"), "error");
	});

	it("rejects a fractional wait value", async () => {
		const { command, ctx } = setup();
		wol.loadConfig.mockReturnValue(validConfig());

		await command.handler("wait 1.5", ctx as never);

		expect(wol.saveConfig).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Usage: /wol wait"), "error");
	});

	it("sets the providers list", async () => {
		const { command, ctx } = setup();
		wol.loadConfig.mockReturnValue(validConfig());

		await command.handler("providers local-llm,other", ctx as never);

		const [, savedCfg] = wol.saveConfig.mock.calls[0];
		expect(savedCfg.providers).toEqual(["local-llm", "other"]);
	});

	it("rejects an empty providers list", async () => {
		const { command, ctx } = setup();
		wol.loadConfig.mockReturnValue(validConfig());

		await command.handler("providers , ", ctx as never);

		expect(wol.saveConfig).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Usage: /wol providers"), "error");
	});

	it("toggles use-probe", async () => {
		const { command, ctx } = setup();
		wol.loadConfig.mockReturnValue(validConfig());

		await command.handler("use-probe off", ctx as never);

		const [, savedCfg] = wol.saveConfig.mock.calls[0];
		expect(savedCfg.useProbe).toBe(false);
	});

	it("rejects an invalid use-probe value", async () => {
		const { command, ctx } = setup();
		wol.loadConfig.mockReturnValue(validConfig());

		await command.handler("use-probe maybe", ctx as never);

		expect(wol.saveConfig).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Usage: /wol use-probe"), "error");
	});

	it("sets the broadcast address", async () => {
		const { command, ctx } = setup();
		wol.loadConfig.mockReturnValue(validConfig());
		wol.validateIpv4.mockReturnValue(true);

		await command.handler("broadcast 192.0.2.255", ctx as never);

		const [, savedCfg] = wol.saveConfig.mock.calls[0];
		expect(savedCfg.broadcastAddress).toBe("192.0.2.255");
	});

	it("rejects an invalid broadcast address", async () => {
		const { command, ctx } = setup();
		wol.loadConfig.mockReturnValue(validConfig());
		wol.validateIpv4.mockReturnValue(false);

		await command.handler("broadcast nope", ctx as never);

		expect(wol.saveConfig).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Usage: /wol broadcast"), "error");
	});

	it("sets the WoL port", async () => {
		const { command, ctx } = setup();
		wol.loadConfig.mockReturnValue(validConfig());

		await command.handler("port 7", ctx as never);

		const [, savedCfg] = wol.saveConfig.mock.calls[0];
		expect(savedCfg.wolPort).toBe(7);
	});

	it("rejects an out-of-range port", async () => {
		const { command, ctx } = setup();
		wol.loadConfig.mockReturnValue(validConfig());

		await command.handler("port 70000", ctx as never);

		expect(wol.saveConfig).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Usage: /wol port"), "error");
	});

	it("rejects a fractional port", async () => {
		const { command, ctx } = setup();
		wol.loadConfig.mockReturnValue(validConfig());

		await command.handler("port 1.5", ctx as never);

		expect(wol.saveConfig).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("Usage: /wol port"), "error");
	});

	it("/wol wake resolves the probe URL and wakes", async () => {
		const { command, ctx } = setup();
		wol.loadConfig.mockReturnValue(validConfig());
		ctx.model = { provider: "local-llm", baseUrl: "http://x/v1" };
		ctx.modelRegistry.getProvider.mockReturnValue({ baseUrl: "http://x/v1" });

		await command.handler("wake", ctx as never);

		expect(wol.deriveProbeUrl).toHaveBeenCalledWith(undefined, "http://x/v1", "http://x/v1");
		expect(wol.ensureAwake).toHaveBeenCalledTimes(1);
	});

	it("surfaces unexpected errors as a notification", async () => {
		const { command, ctx } = setup();
		wol.loadConfig.mockImplementation(() => {
			throw new Error("disk error");
		});

		await command.handler("mac AA:BB:CC:DD:EE:FF", ctx as never);

		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("disk error"), "error");
	});
});
