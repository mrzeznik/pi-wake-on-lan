/**
 * pi-wake — Wake-on-LAN for local model providers.
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

function resolveAndWake(ctx: ExtensionContext, cfg: WolConfig): Promise<void> {
	const model = ctx.model;
	const providerBaseUrl = model ? ctx.modelRegistry.getProvider(model.provider)?.baseUrl : undefined;
	const probeUrl = cfg.useProbe ? deriveProbeUrl(cfg.probeUrl, model?.baseUrl, providerBaseUrl) : undefined;
	return ensureAwake(cfg, probeUrl, ctx.signal, (message, type) => {
		const safeMessage = probeUrl ? message.replaceAll(probeUrl, "<probe-url>") : message;
		const log = type === "error" ? console.error : type === "warning" ? console.warn : console.info;
		log(`[pi-wake] ${safeMessage}`);
		notify(ctx, message, type);
	});
}

// ---------------------------------------------------------------------------
// /wol command
// ---------------------------------------------------------------------------

async function checkProbe(ctx: ExtensionContext, cfg: WolConfig): Promise<void> {
	const model = ctx.model;
	const providerBaseUrl = model ? ctx.modelRegistry.getProvider(model.provider)?.baseUrl : undefined;
	const url = deriveProbeUrl(cfg.probeUrl, model?.baseUrl, providerBaseUrl);
	if (!url) {
		ctx.ui.notify("pi-wake: no probe URL available; configure one with /wol probe <url>", "warning");
		return;
	}
	const up = await isUp(url, ctx.signal);
	const message = `pi-wake: probe ${up ? "UP" : "DOWN"} (${url})`;
	const safeMessage = message.replaceAll(url, "<probe-url>");
	(up ? console.info : console.warn)(`[pi-wake] ${safeMessage}`);
	ctx.ui.notify(message, up ? "info" : "warning");
}

function statusText(cfg: WolConfig): string {
	const errors = validateConfig(cfg);
	const lines = [
		"Wake-on-LAN configuration",
		`automatic WoL:   ${cfg.enabled ? "ON" : "OFF"}`,
		`mac:             ${cfg.mac || "(not set)"}`,
		`probe URL:       ${cfg.probeUrl || "(auto — provider baseUrl + /models)"}`,
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
		ctx.ui.notify(`${statusText(cfg)}\n\nUse /wol <setting> to change configuration.`, "info");
		return;
	}

	while (true) {
		const choices = [
			`Automatic WoL: ${cfg.enabled ? "ON" : "OFF"} (toggle)`,
			`MAC address: ${cfg.mac || "not set"}`,
			"Clear MAC address",
			`Providers: ${cfg.providers.join(", ") || "none"}`,
			`Probe URL: ${cfg.probeUrl || "auto"}`,
			"Check probe now (no WoL)",
			`Probe before/after wake: ${cfg.useProbe ? "ON" : "OFF"} (toggle)`,
			`Wait for host: ${cfg.waitForHost} ms`,
			`Broadcast address: ${cfg.broadcastAddress}`,
			`WoL port: ${cfg.wolPort}`,
			"Wake now",
			"Close",
		];
		const selected = await ctx.ui.select("pi-wake settings", choices);
		if (!selected || selected === "Close") return;

		if (selected === choices[0]) {
			cfg.enabled = !cfg.enabled;
			saveConfig(CONFIG_PATH, cfg);
			ctx.ui.notify(`pi-wake: automatic WoL ${cfg.enabled ? "enabled" : "disabled"}`, "info");
		} else if (selected === choices[1]) {
			const value = await ctx.ui.input("Set MAC address", cfg.mac || "AA:BB:CC:DD:EE:FF");
			if (value !== undefined) setMac(ctx, cfg, value.trim());
		} else if (selected === choices[2]) {
			cfg.mac = "";
			saveConfig(CONFIG_PATH, cfg);
			ctx.ui.notify("pi-wake: MAC address cleared", "info");
		} else if (selected === choices[3]) {
			const value = await ctx.ui.input("Set providers (comma-separated; enter 'clear' to remove all)", cfg.providers.join(","));
			if (value !== undefined) setProviders(ctx, cfg, value);
		} else if (selected === choices[4]) {
			const value = await ctx.ui.input("Probe URL (or 'auto' to derive)", cfg.probeUrl || "auto");
			if (value !== undefined) setProbe(ctx, cfg, value);
		} else if (selected === choices[5]) {
			await checkProbe(ctx, cfg);
		} else if (selected === choices[6]) {
			cfg.useProbe = !cfg.useProbe;
			saveConfig(CONFIG_PATH, cfg);
			ctx.ui.notify(`pi-wake: probe ${cfg.useProbe ? "enabled" : "disabled"}`, "info");
		} else if (selected === choices[7]) {
			const value = await ctx.ui.input("Wait for host (milliseconds; 0 = no wait limit)", String(cfg.waitForHost));
			if (value !== undefined) setWait(ctx, cfg, value.trim());
		} else if (selected === choices[8]) {
			const value = await ctx.ui.input("Broadcast IPv4 address", cfg.broadcastAddress);
			if (value !== undefined) setBroadcast(ctx, cfg, value.trim());
		} else if (selected === choices[9]) {
			const value = await ctx.ui.input("WoL UDP port (1-65535)", String(cfg.wolPort));
			if (value !== undefined) setPort(ctx, cfg, value.trim());
		} else if (selected === choices[10]) {
			await resolveAndWake(ctx, cfg);
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
		ctx.ui.notify(`pi-wake: ${err}`, "error");
		return;
	}
	cfg.mac = value.trim();
	saveConfig(CONFIG_PATH, cfg);
	ctx.ui.notify(`pi-wake: MAC set to ${cfg.mac}`, "info");
}

function setProbe(ctx: ExtensionContext, cfg: WolConfig, value: string): void {
	const v = value.trim().toLowerCase();
	if (!v || v === "auto" || v === "none" || v === "off") {
		cfg.probeUrl = undefined;
		saveConfig(CONFIG_PATH, cfg);
		ctx.ui.notify("pi-wake: probe URL cleared (will be derived from provider baseUrl + /models)", "info");
		return;
	}
	const err = validateUrl(value);
	if (err) {
		ctx.ui.notify(`pi-wake: probeUrl ${err}`, "error");
		return;
	}
	cfg.probeUrl = value;
	saveConfig(CONFIG_PATH, cfg);
	ctx.ui.notify(`pi-wake: probe URL set to ${cfg.probeUrl}`, "info");
}

function setWait(ctx: ExtensionContext, cfg: WolConfig, value: string): void {
	const n = Number(value);
	if (!/^\d+$/.test(value) || !Number.isSafeInteger(n) || n < 0) {
		ctx.ui.notify("Usage: /wol wait <ms> (non-negative integer; 0 = no limit / no delay)", "error");
		return;
	}
	cfg.waitForHost = n;
	saveConfig(CONFIG_PATH, cfg);
	ctx.ui.notify(`pi-wake: waitForHost set to ${n} ms`, "info");
}

function setProviders(ctx: ExtensionContext, cfg: WolConfig, value: string): void {
	if (value.trim().toLowerCase() === "clear") {
		cfg.providers = [];
		saveConfig(CONFIG_PATH, cfg);
		ctx.ui.notify("pi-wake: provider list cleared", "info");
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
	ctx.ui.notify(`pi-wake: providers set to ${cfg.providers.join(", ")}`, "info");
}

function setUseProbe(ctx: ExtensionContext, cfg: WolConfig, value: string): void {
	const v = value.trim().toLowerCase();
	if (!["on", "true", "off", "false"].includes(v)) {
		ctx.ui.notify("Usage: /wol use-probe on|off", "error");
		return;
	}
	cfg.useProbe = v === "on" || v === "true";
	saveConfig(CONFIG_PATH, cfg);
	ctx.ui.notify(`pi-wake: probe ${cfg.useProbe ? "enabled" : "disabled"}`, "info");
}

function setBroadcast(ctx: ExtensionContext, cfg: WolConfig, value: string): void {
	if (!validateIpv4(value.trim())) {
		ctx.ui.notify("Usage: /wol broadcast <ipv4> (e.g. 192.0.2.255)", "error");
		return;
	}
	cfg.broadcastAddress = value.trim();
	saveConfig(CONFIG_PATH, cfg);
	ctx.ui.notify(`pi-wake: broadcast address set to ${cfg.broadcastAddress}`, "info");
}

function setPort(ctx: ExtensionContext, cfg: WolConfig, value: string): void {
	const n = Number(value);
	if (!/^\d+$/.test(value) || !Number.isInteger(n) || n < 1 || n > 65535) {
		ctx.ui.notify("Usage: /wol port <1-65535>", "error");
		return;
	}
	cfg.wolPort = n;
	saveConfig(CONFIG_PATH, cfg);
	ctx.ui.notify(`pi-wake: WoL port set to ${cfg.wolPort}`, "info");
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
			console.info(`[pi-wake] matched provider request ${model.provider}/${model.id}`);
			if (!cfg.enabled) {
				console.info("[pi-wake] automatic WoL is disabled; skipping");
				return;
			}
			if (!cfg.mac) {
				console.info("[pi-wake] no MAC address configured; skipping");
				return;
			}
			await resolveAndWake(ctx, cfg);
		} catch (err) {
			// Never break the model request because of WoL/probe failures.
			console.error(`[pi-wake] automatic wake failed: ${err instanceof Error ? err.message : String(err)}`);
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
						ctx.ui.notify(`pi-wake: automatic WoL ${cfg.enabled ? "enabled" : "disabled"}`, "info");
						return;
					case undefined:
					case "status":
					case "show":
					case "help":
						if (sub === undefined) await showSettingsMenu(ctx, cfg);
						else ctx.ui.notify(statusText(cfg), "info");
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
						ctx.ui.notify(`pi-wake: unknown subcommand "${sub}" — use /wol help`, "error");
				}
			} catch (err) {
				ctx.ui.notify(`pi-wake: ${(err as Error).message ?? String(err)}`, "error");
			}
		},
	});
}
