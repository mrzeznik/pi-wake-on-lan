/**
 * pi-wake-on-lan — Wake-on-LAN for local model providers.
 *
 * Before a request is dispatched to a configured local provider, this
 * extension sends a Wake-on-LAN magic packet and, optionally, waits until
 * the provider's service responds.
 *
 * Configuration lives in `<agent-dir>/wol.json` and is managed with `/wol`.
 *
 * Only the *provider* is matched (e.g. `local-llm`), so every model under that
 * provider (`local-llm/gemini4`, `local-llm/qwen3.8`, …) triggers the wake.
 *
 * Core logic (no pi dependencies) lives in wol.ts so it can be unit-tested.
 */

import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	createWaker,
	deriveProbeUrl,
	isUp,
	loadConfig,
	saveConfig,
	validateConfig,
	validateIpv4,
	validateMac,
	validateUrl,
	type WolConfig,
} from "./wol";

const CONFIG_PATH = join(getAgentDir(), "wol.json");
const ensureAwake = createWaker();

function notify(ctx: ExtensionContext, message: string, type?: "info" | "warning" | "error"): void {
	ctx.ui.notify(message, type);
}

function resolveModelBaseUrls(ctx: ExtensionContext): { modelBaseUrl: string | undefined; providerBaseUrl: string | undefined } {
	const model = ctx.model;
	return {
		modelBaseUrl: model?.baseUrl,
		providerBaseUrl: model ? ctx.modelRegistry.getProvider(model.provider)?.baseUrl : undefined,
	};
}

function resolveAndWake(ctx: ExtensionContext, cfg: WolConfig): Promise<void> {
	const { modelBaseUrl, providerBaseUrl } = resolveModelBaseUrls(ctx);
	const probeUrl = cfg.useProbe ? deriveProbeUrl(cfg.probeUrl, modelBaseUrl, providerBaseUrl) : undefined;
	return ensureAwake(cfg, probeUrl, ctx.signal, (message, type) => {
		const log = type === "error" ? console.error : type === "warning" ? console.warn : console.info;
		log(`[pi-wake-on-lan] ${message}`);
		notify(ctx, message, type);
	});
}

// ---------------------------------------------------------------------------
// /wol command
// ---------------------------------------------------------------------------

function resolveProbeUrl(ctx: ExtensionContext, cfg: WolConfig): string | undefined {
	const { modelBaseUrl, providerBaseUrl } = resolveModelBaseUrls(ctx);
	return deriveProbeUrl(cfg.probeUrl, modelBaseUrl, providerBaseUrl);
}

async function checkProbe(ctx: ExtensionContext, cfg: WolConfig): Promise<void> {
	const url = resolveProbeUrl(ctx, cfg);
	if (!url) {
		ctx.ui.notify("pi-wake-on-lan: no probe URL available; configure one with /wol probe <url>", "warning");
		return;
	}
	const up = await isUp(url, ctx.signal);
	const message = `pi-wake-on-lan: probe ${up ? "UP" : "DOWN"} (${url})`;
	(up ? console.info : console.warn)(`[pi-wake-on-lan] ${message}`);
	ctx.ui.notify(message, up ? "info" : "warning");
}

function statusText(ctx: ExtensionContext, cfg: WolConfig): string {
	const errors = validateConfig(cfg);
	const probeUrl = resolveProbeUrl(ctx, cfg);
	const probeDisplay = cfg.probeUrl || (probeUrl || "no baseUrl available");
	const lines = [
		"Wake-on-LAN configuration",
		`automatic WoL:   ${cfg.enabled ? "ON" : "OFF"}`,
		`mac:             ${cfg.mac || "(not set)"}`,
		`probe URL:       ${probeDisplay}`,
		`wait for host:   ${cfg.waitForHost} ms (0 = no limit / no delay)`,
		`providers:       ${cfg.providers.length ? cfg.providers.join(", ") : "(none)"}`,
		`use probe:       ${cfg.useProbe}`,
		`broadcast:       ${cfg.broadcastAddress}:${cfg.wolPort}`,
	];
	if (errors.length) lines.push("", "Validation errors:", ...errors.map((error) => `  - ${error}`));
	return lines.join("\n");
}

async function showSettingsMenu(ctx: ExtensionContext, cfg: WolConfig): Promise<void> {
	if (!ctx.hasUI) {
		ctx.ui.notify(`${statusText(ctx, cfg)}\n\nUse /wol <setting> to change configuration.`, "info");
		return;
	}

	while (true) {
		const menu = [
			{ id: "toggle-enabled", label: `Automatic WoL: ${cfg.enabled ? "ON" : "OFF"} (toggle)` },
			{ id: "set-mac", label: `MAC address: ${cfg.mac || "not set"}` },
			{ id: "clear-mac", label: "Clear MAC address" },
			{ id: "set-providers", label: `Providers: ${cfg.providers.join(", ") || "none"}` },
			{ id: "set-probe", label: `Probe URL: ${cfg.probeUrl || "auto"}` },
			{ id: "check-probe", label: "Check probe now (no WoL)" },
			{ id: "toggle-use-probe", label: `Probe before/after wake: ${cfg.useProbe ? "ON" : "OFF"} (toggle)` },
			{ id: "set-wait", label: `Wait for host: ${cfg.waitForHost} ms` },
			{ id: "set-broadcast", label: `Broadcast address: ${cfg.broadcastAddress}` },
			{ id: "set-port", label: `WoL port: ${cfg.wolPort}` },
			{ id: "wake-now", label: "Wake now" },
			{ id: "close", label: "Close" },
		];
		const labels = menu.map((item) => item.label);
		const selected = await ctx.ui.select("pi-wake-on-lan settings", labels);
		const action = menu.find((item) => item.label === selected)?.id;
		if (!selected || action === "close") return;

		switch (action) {
			case "toggle-enabled":
				cfg.enabled = !cfg.enabled;
				saveConfig(CONFIG_PATH, cfg);
				ctx.ui.notify(`pi-wake-on-lan: automatic WoL ${cfg.enabled ? "enabled" : "disabled"}`, "info");
				break;
			case "set-mac": {
				const value = await ctx.ui.input("Set MAC address", cfg.mac || "AA:BB:CC:DD:EE:FF");
				if (value !== undefined) setMac(ctx, cfg, value.trim());
				break;
			}
			case "clear-mac":
				cfg.mac = "";
				saveConfig(CONFIG_PATH, cfg);
				ctx.ui.notify("pi-wake-on-lan: MAC address cleared", "info");
				break;
			case "set-providers": {
				const value = await ctx.ui.input("Set providers (comma-separated; enter 'clear' to remove all)", cfg.providers.join(","));
				if (value !== undefined) setProviders(ctx, cfg, value);
				break;
			}
			case "set-probe": {
				const value = await ctx.ui.input("Probe URL (or 'auto' to derive)", cfg.probeUrl || "auto");
				if (value !== undefined) setProbe(ctx, cfg, value);
				break;
			}
			case "check-probe":
				await checkProbe(ctx, cfg);
				break;
			case "toggle-use-probe":
				cfg.useProbe = !cfg.useProbe;
				saveConfig(CONFIG_PATH, cfg);
				ctx.ui.notify(`pi-wake-on-lan: probe ${cfg.useProbe ? "enabled" : "disabled"}`, "info");
				break;
			case "set-wait": {
				const value = await ctx.ui.input("Wait for host (milliseconds; 0 = no wait limit)", String(cfg.waitForHost));
				if (value !== undefined) setWait(ctx, cfg, value.trim());
				break;
			}
			case "set-broadcast": {
				const value = await ctx.ui.input("Broadcast IPv4 address", cfg.broadcastAddress);
				if (value !== undefined) setBroadcast(ctx, cfg, value.trim());
				break;
			}
			case "set-port": {
				const value = await ctx.ui.input("WoL UDP port (1-65535)", String(cfg.wolPort));
				if (value !== undefined) setPort(ctx, cfg, value.trim());
				break;
			}
			case "wake-now":
				await resolveAndWake(ctx, cfg);
				break;
		}
	}
}

function setMac(ctx: ExtensionContext, cfg: WolConfig, value: string): void {
	if (!value) {
		ctx.ui.notify("Usage: /wol mac AA:BB:CC:DD:EE:FF", "error");
		return;
	}
	const err = validateMac(value);
	if (err) {
		ctx.ui.notify(`pi-wake-on-lan: ${err}`, "error");
		return;
	}
	cfg.mac = value.trim();
	saveConfig(CONFIG_PATH, cfg);
	ctx.ui.notify(`pi-wake-on-lan: MAC set to ${cfg.mac}`, "info");
}

function setProbe(ctx: ExtensionContext, cfg: WolConfig, value: string): void {
	const v = value.trim().toLowerCase();
	if (!v || v === "auto" || v === "none" || v === "off") {
		cfg.probeUrl = undefined;
		saveConfig(CONFIG_PATH, cfg);
		ctx.ui.notify("pi-wake-on-lan: probe URL cleared (will be derived from provider baseUrl + /models)", "info");
		return;
	}
	const err = validateUrl(value);
	if (err) {
		ctx.ui.notify(`pi-wake-on-lan: probeUrl ${err}`, "error");
		return;
	}
	cfg.probeUrl = value;
	saveConfig(CONFIG_PATH, cfg);
	ctx.ui.notify(`pi-wake-on-lan: probe URL set to ${cfg.probeUrl}`, "info");
}

function setWait(ctx: ExtensionContext, cfg: WolConfig, value: string): void {
	const n = Number(value);
	if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < 0) {
		ctx.ui.notify("Usage: /wol wait <ms> (non-negative integer; 0 = no limit / no delay)", "error");
		return;
	}
	cfg.waitForHost = n;
	saveConfig(CONFIG_PATH, cfg);
	ctx.ui.notify(`pi-wake-on-lan: waitForHost set to ${n} ms`, "info");
}

function setProviders(ctx: ExtensionContext, cfg: WolConfig, value: string): void {
	if (value.trim().toLowerCase() === "clear") {
		cfg.providers = [];
		saveConfig(CONFIG_PATH, cfg);
		ctx.ui.notify("pi-wake-on-lan: provider list cleared", "info");
		return;
	}
	const list = value
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
	if (!list.length) {
		ctx.ui.notify("Usage: /wol providers local-llm[,other-provider …]", "error");
		return;
	}
	cfg.providers = list;
	saveConfig(CONFIG_PATH, cfg);
	ctx.ui.notify(`pi-wake-on-lan: providers set to ${cfg.providers.join(", ")}`, "info");
}

function setUseProbe(ctx: ExtensionContext, cfg: WolConfig, value: string): void {
	const v = value.trim().toLowerCase();
	if (!["on", "true", "off", "false"].includes(v)) {
		ctx.ui.notify("Usage: /wol use-probe on|off", "error");
		return;
	}
	cfg.useProbe = v === "on" || v === "true";
	saveConfig(CONFIG_PATH, cfg);
	ctx.ui.notify(`pi-wake-on-lan: probe ${cfg.useProbe ? "enabled" : "disabled"}`, "info");
}

function setBroadcast(ctx: ExtensionContext, cfg: WolConfig, value: string): void {
	if (!validateIpv4(value.trim())) {
		ctx.ui.notify("Usage: /wol broadcast <ipv4> (e.g. 192.0.2.255)", "error");
		return;
	}
	cfg.broadcastAddress = value.trim();
	saveConfig(CONFIG_PATH, cfg);
	ctx.ui.notify(`pi-wake-on-lan: broadcast address set to ${cfg.broadcastAddress}`, "info");
}

function setPort(ctx: ExtensionContext, cfg: WolConfig, value: string): void {
	const n = Number(value);
	if (!/^\d+$/.test(value) || !Number.isInteger(n) || n < 1 || n > 65535) {
		ctx.ui.notify("Usage: /wol port <1-65535>", "error");
		return;
	}
	cfg.wolPort = n;
	saveConfig(CONFIG_PATH, cfg);
	ctx.ui.notify(`pi-wake-on-lan: WoL port set to ${cfg.wolPort}`, "info");
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	pi.on("before_provider_request", async (_event, ctx) => {
		try {
			const model = ctx.model;
			if (!model) return;
			const cfg = loadConfig(CONFIG_PATH);
			if (!cfg.providers.includes(model.provider)) return;
			console.info(`[pi-wake-on-lan] matched provider request ${model.provider}/${model.id}`);
			if (!cfg.enabled) {
				console.info("[pi-wake-on-lan] automatic WoL is disabled; skipping");
				return;
			}
			if (!cfg.mac) {
				console.info("[pi-wake-on-lan] no MAC address configured; skipping");
				return;
			}
			await resolveAndWake(ctx, cfg);
		} catch (err) {
			// Never break the model request because of WoL/probe failures.
			console.error(`[pi-wake-on-lan] automatic wake failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	});

	pi.registerCommand("wol", {
		description: "Configure and trigger Wake-on-LAN for local model providers",
		handler: async (args, ctx) => {
			try {
				const parts = args.trim().split(/\s+/).filter(Boolean);
				const sub = parts[0]?.toLowerCase();
				const rest = parts.slice(1).join(" ");
				const cfg = loadConfig(CONFIG_PATH);

				switch (sub) {
					case "on":
					case "off":
						cfg.enabled = sub === "on";
						saveConfig(CONFIG_PATH, cfg);
						ctx.ui.notify(`pi-wake-on-lan: automatic WoL ${cfg.enabled ? "enabled" : "disabled"}`, "info");
						return;
					case undefined:
					case "status":
					case "show":
						if (sub === undefined) await showSettingsMenu(ctx, cfg);
						else ctx.ui.notify(statusText(ctx, cfg), "info");
						return;
					case "mac":
						setMac(ctx, cfg, rest);
						return;
					case "probe":
						setProbe(ctx, cfg, rest);
						return;
					case "check":
						await checkProbe(ctx, cfg);
						return;
					case "wait":
						setWait(ctx, cfg, rest);
						return;
					case "providers":
						setProviders(ctx, cfg, rest);
						return;
					case "use-probe":
						setUseProbe(ctx, cfg, rest);
						return;
					case "broadcast":
						setBroadcast(ctx, cfg, rest);
						return;
					case "port":
						setPort(ctx, cfg, rest);
						return;
					case "wake":
						await resolveAndWake(ctx, cfg);
						return;
					default:
						ctx.ui.notify(`pi-wake-on-lan: unknown subcommand "${sub}" — use /wol help`, "error");
				}
			} catch (err) {
				ctx.ui.notify(`pi-wake-on-lan: ${(err as Error).message ?? String(err)}`, "error");
			}
		},
	});
}
