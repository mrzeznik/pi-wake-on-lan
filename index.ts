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
	return ensureAwake(cfg, probeUrl, ctx.signal, (message, type) => notify(ctx, message, type));
}

// ---------------------------------------------------------------------------
// /wol command
// ---------------------------------------------------------------------------

async function showStatus(ctx: ExtensionContext, cfg: WolConfig): Promise<void> {
	const errors = validateConfig(cfg);
	const lines = [
		"Wake-on-LAN configuration",
		"",
		`mac:              ${cfg.mac || "(not set)"}`,
		`probeUrl:         ${cfg.probeUrl || "(auto — provider baseUrl + /models)"}`,
		`waitForHost:      ${cfg.waitForHost} ms (0 = no limit / no delay)`,
		`providers:        ${cfg.providers.length ? cfg.providers.join(", ") : "(none)"}`,
		`useProbe:         ${cfg.useProbe}`,
		`broadcastAddress: ${cfg.broadcastAddress}`,
		`wolPort:          ${cfg.wolPort}`,
		"",
	];
	if (errors.length) {
		lines.push("Validation errors:", `  - ${errors.join("\n  - ")}`, "");
	}
	lines.push(
		"Subcommands:",
		"  /wol mac <AA:BB:CC:DD:EE:FF>     set MAC address",
		"  /wol probe <url|auto>            override probe URL (auto = derive)",
		"  /wol wait <ms>                   set waitForHost (0 = no limit / no delay)",
		"  /wol providers <a,b,c>           set providers that trigger WoL",
		"  /wol use-probe <on|off>          enable/disable probing",
		"  /wol broadcast <ipv4>            set UDP broadcast address",
		"  /wol port <1-65535>              set UDP port",
		"  /wol wake                        wake the machine now",
		"  /wol status                      show this configuration",
	);
	const text = lines.join("\n");
	if (ctx.hasUI) {
		await ctx.ui.editor("pi-wake configuration", text);
	} else {
		ctx.ui.notify(text, "info");
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
			if (!cfg.mac || !cfg.providers.includes(model.provider)) return;
			await resolveAndWake(ctx, cfg);
		} catch {
			// Never break the model request because of WoL/probe failures.
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
					case undefined:
					case "status":
					case "show":
					case "help":
						await showStatus(ctx, cfg);
						return;
					case "mac":
						setMac(ctx, cfg, rest);
						return;
					case "probe":
						setProbe(ctx, cfg, rest);
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
