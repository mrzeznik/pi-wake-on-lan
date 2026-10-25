/**
 * pi-wake core logic. No pi runtime dependencies — only Node built-ins — so it
 * can be unit-tested in isolation. The pi extension wiring lives in index.ts.
 */

import { createSocket } from "node:dgram";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface WolConfig {
	/** Whether automatic Wake-on-LAN is enabled for matching providers. */
	enabled: boolean;
	/** MAC address of the machine to wake, e.g. "AA:BB:CC:DD:EE:FF". */
	mac: string;
	/** Explicit probe URL. When unset, derived as `<baseUrl>/models`. */
	probeUrl?: string;
	/**
	 * How long to wait after sending the WoL packet, in milliseconds.
	 * - Probe enabled:  maximum time to wait for the probe to succeed.
	 *                   `0` = wait indefinitely.
	 * - Probe disabled: fixed delay before continuing. `0` = no delay.
	 */
	waitForHost: number;
	/** Provider ids that trigger the wake sequence. */
	providers: string[];
	/** Whether to probe the machine before/after sending WoL. */
	useProbe: boolean;
	/** UDP broadcast address for the magic packet. */
	broadcastAddress: string;
	/** UDP port for the magic packet (conventionally 7 or 9). */
	wolPort: number;
}

export const DEFAULTS: WolConfig = {
	enabled: true,
	mac: "",
	waitForHost: 120_000,
	providers: [],
	useProbe: true,
	broadcastAddress: "255.255.255.255",
	wolPort: 9,
};

/** Minimum delay between two magic packets, to avoid flooding the network. */
export const WOL_COOLDOWN_MS = 30_000;
/** Per-attempt probe timeout. A fetch that takes longer counts as "asleep". */
export const PROBE_TIMEOUT_MS = 4_000;
/** Default delay between probe attempts. */
export const PROBE_INTERVAL_MS = 1_500;

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

export function normalizeMac(mac: string): string {
	return mac.toLowerCase().replace(/[^0-9a-f]/g, "");
}

export function validateMac(mac: string): string | null {
	const raw = mac.trim();
	if (!/^([0-9a-fA-F]{2}[:-]){2}([0-9a-fA-F]{2}[:-]){2}([0-9a-fA-F]{2}[:-])[0-9a-fA-F]{2}$/.test(raw)) {
		return "MAC must look like AA:BB:CC:DD:EE:FF (six hex octets).";
	}
	const bytes = normalizeMac(raw);
	if (bytes === "000000000000") return "MAC must not be all zeros.";
	if (bytes === "ffffffffffff") return "MAC must not be all ones.";
	if (Number.parseInt(bytes.slice(0, 2), 16) & 0x01) return "MAC must not be a multicast address.";
	return null;
}

export function validateUrl(url: string): string | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return "must be a valid URL.";
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "must be an http(s) URL.";
	return null;
}

export function validateIpv4(addr: string): boolean {
	return /^\d{1,3}(\.\d{1,3}){3}$/.test(addr) && addr.split(".").every((n) => Number(n) <= 255);
}

export function validateConfig(cfg: WolConfig): string[] {
	const errors: string[] = [];
	if (cfg.mac) {
		const err = validateMac(cfg.mac);
		if (err) errors.push(`mac: ${err}`);
	}
	if (cfg.probeUrl) {
		const err = validateUrl(cfg.probeUrl);
		if (err) errors.push(`probeUrl: ${err}`);
	}
	if (!Number.isSafeInteger(cfg.waitForHost) || cfg.waitForHost < 0) {
		errors.push("waitForHost: must be a non-negative integer in milliseconds (0 = no limit / no delay).");
	}
	if (!Array.isArray(cfg.providers) || cfg.providers.some((p) => typeof p !== "string" || !p.trim())) {
		errors.push("providers: must be a list of non-empty provider ids.");
	}
	if (typeof cfg.enabled !== "boolean") {
		errors.push("enabled: must be a boolean.");
	}
	if (typeof cfg.useProbe !== "boolean") {
		errors.push("useProbe: must be a boolean.");
	}
	if (!validateIpv4(cfg.broadcastAddress)) {
		errors.push("broadcastAddress: must be a valid IPv4 address.");
	}
	if (!Number.isInteger(cfg.wolPort) || cfg.wolPort < 1 || cfg.wolPort > 65535) {
		errors.push("wolPort: must be an integer between 1 and 65535.");
	}
	return errors;
}

// ---------------------------------------------------------------------------
// Config persistence
// ---------------------------------------------------------------------------

export function loadConfig(path: string): WolConfig {
	const cfg: WolConfig = { ...DEFAULTS };
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		if (parsed && typeof parsed === "object") {
			// Coerce each field to its expected type; anything malformed falls
			// back to the default so downstream code never sees a bad type.
			if (typeof parsed.enabled === "boolean") cfg.enabled = parsed.enabled;
			if (typeof parsed.mac === "string") cfg.mac = parsed.mac;
			if (typeof parsed.probeUrl === "string" && parsed.probeUrl.trim()) cfg.probeUrl = parsed.probeUrl.trim();
			if (typeof parsed.waitForHost === "number" && Number.isFinite(parsed.waitForHost) && parsed.waitForHost >= 0) {
				cfg.waitForHost = parsed.waitForHost;
			}
			if (Array.isArray(parsed.providers)) {
				cfg.providers = parsed.providers.filter((p): p is string => typeof p === "string" && p.trim().length > 0);
			}
			if (typeof parsed.useProbe === "boolean") cfg.useProbe = parsed.useProbe;
			if (typeof parsed.broadcastAddress === "string" && parsed.broadcastAddress.trim()) {
				cfg.broadcastAddress = parsed.broadcastAddress.trim();
			}
			if (typeof parsed.wolPort === "number" && Number.isInteger(parsed.wolPort) && parsed.wolPort >= 1 && parsed.wolPort <= 65535) {
				cfg.wolPort = parsed.wolPort;
			}
		}
	} catch {
		// Missing or unreadable config → defaults.
	}
	return cfg;
}

export function saveConfig(path: string, cfg: WolConfig): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(cfg, null, 2)}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// Probe helpers
// ---------------------------------------------------------------------------

function timeoutSignal(ms: number): AbortSignal {
	if (typeof AbortSignal.timeout === "function") return AbortSignal.timeout(ms);
	const ctrl = new AbortController();
	setTimeout(() => ctrl.abort(), ms);
	return ctrl.signal;
}

function anySignal(signals: AbortSignal[]): AbortSignal {
	if (typeof AbortSignal.any === "function") return AbortSignal.any(signals);
	const ctrl = new AbortController();
	for (const signal of signals) {
		if (signal.aborted) {
			ctrl.abort();
			break;
		}
		signal.addEventListener("abort", () => ctrl.abort(), { once: true });
	}
	return ctrl.signal;
}

function probeSignal(external?: AbortSignal): AbortSignal | undefined {
	const timeout = timeoutSignal(PROBE_TIMEOUT_MS);
	return external ? anySignal([external, timeout]) : timeout;
}

/** True when the service responds at all; only a thrown fetch means "asleep". */
export async function isUp(url: string, signal?: AbortSignal): Promise<boolean> {
	try {
		await fetch(url, { method: "GET", signal: probeSignal(signal) });
		return true;
	} catch {
		return false;
	}
}

export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		if (signal?.aborted) {
			resolve();
			return;
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		const done = () => {
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
			resolve();
		};
		const onAbort = () => done();
		timer = setTimeout(done, ms);
		signal?.addEventListener("abort", onAbort, { once: true });
	});
}

/** Poll `url` until it responds, the deadline passes, or `signal` aborts. */
export async function waitUntilUp(
	url: string,
	maxWaitMs: number,
	signal?: AbortSignal,
	intervalMs: number = PROBE_INTERVAL_MS,
): Promise<boolean> {
	const start = Date.now();
	for (;;) {
		if (signal?.aborted) return false;
		if (await isUp(url, signal)) return true;
		if (signal?.aborted) return false;
		if (maxWaitMs > 0 && Date.now() - start >= maxWaitMs) return false;
		await sleep(intervalMs, signal);
	}
}

// ---------------------------------------------------------------------------
// Wake-on-LAN
// ---------------------------------------------------------------------------

export function buildMagicPacket(mac: string): Buffer {
	const bytes = normalizeMac(mac);
	if (bytes.length !== 12) throw new Error("invalid MAC address");
	const macBuf = Buffer.from(bytes, "hex");
	const packet = Buffer.alloc(102);
	packet.fill(0xff, 0, 6);
	for (let i = 0; i < 16; i++) macBuf.copy(packet, 6 + i * 6);
	return packet;
}

export function sendMagicPacket(mac: string, broadcastAddress: string, port: number): Promise<void> {
	return new Promise((resolve, reject) => {
		let packet: Buffer;
		try {
			packet = buildMagicPacket(mac);
		} catch (err) {
			reject(err);
			return;
		}

		const socket = createSocket("udp4");
		let settled = false;
		const finish = (err?: Error) => {
			if (settled) return;
			settled = true;
			try {
				socket.close();
			} catch {
				// ignore close errors
			}
			if (err) reject(err);
			else resolve();
		};

		socket.once("error", (err) => finish(err));
		socket.bind(() => {
			try {
				socket.setBroadcast(true);
				socket.send(packet, 0, packet.length, port, broadcastAddress, (err) => finish(err ?? undefined));
			} catch (err) {
				finish(err as Error);
			}
		});
	});
}

// ---------------------------------------------------------------------------
// Probe URL resolution
// ---------------------------------------------------------------------------

export function deriveProbeUrl(
	override: string | undefined,
	baseUrl: string | undefined,
	providerBaseUrl: string | undefined,
): string | undefined {
	if (override) return override;
	const resolved = baseUrl || providerBaseUrl;
	if (!resolved) return undefined;
	return `${resolved.replace(/\/+$/, "")}/models`;
}

// ---------------------------------------------------------------------------
// Wake sequence
// ---------------------------------------------------------------------------

export type NotifyFn = (message: string, type?: "info" | "warning" | "error") => void;

export interface WakerDeps {
	isUp?: (url: string, signal?: AbortSignal) => Promise<boolean>;
	waitUntilUp?: (url: string, maxWaitMs: number, signal?: AbortSignal, intervalMs?: number) => Promise<boolean>;
	sendMagicPacket?: (mac: string, broadcastAddress: string, port: number) => Promise<void>;
	sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
	now?: () => number;
	cooldownMs?: number;
}

export type EnsureAwake = (
	cfg: WolConfig,
	probeUrl: string | undefined,
	signal: AbortSignal | undefined,
	notify: NotifyFn,
) => Promise<void>;

export function createWaker(deps: WakerDeps = {}): EnsureAwake {
	const doIsUp = deps.isUp ?? isUp;
	const doWait = deps.waitUntilUp ?? waitUntilUp;
	const doWol = deps.sendMagicPacket ?? sendMagicPacket;
	const doSleep = deps.sleep ?? sleep;
	const now = deps.now ?? Date.now;
	const cooldownMs = deps.cooldownMs ?? WOL_COOLDOWN_MS;

	// Negative infinity so the first packet always sends, regardless of the
	// clock base used by `now`.
	let lastWolAt = Number.NEGATIVE_INFINITY;

	return async function ensureAwake(cfg, probeUrl, signal, notify) {
		const macErr = validateMac(cfg.mac);
		if (macErr) {
			notify(`pi-wake: ${macErr}`, "error");
			return;
		}

		// Fast path: already awake, nothing to do.
		if (probeUrl && (await doIsUp(probeUrl, signal))) return;
		// The request may have been aborted while probing.
		if (signal?.aborted) return;

		// Send the magic packet (throttled to avoid flooding the network).
		if (now() - lastWolAt >= cooldownMs) {
			// Reserve the slot before the async send so concurrent wake requests
			// cannot both pass the cooldown check and duplicate the packet.
			lastWolAt = now();
			notify(`pi-wake: sending WoL to ${cfg.mac}`, "info");
			try {
				await doWol(cfg.mac, cfg.broadcastAddress, cfg.wolPort);
			} catch (err) {
				notify(`pi-wake: WoL failed: ${(err as Error).message}`, "error");
				return;
			}
		}

		// Wait for the host: probe until it responds, or a fixed grace delay when
		// probing is unavailable/disabled.
		if (probeUrl) {
			notify(`pi-wake: waiting for ${probeUrl} …`, "info");
			const up = await doWait(probeUrl, cfg.waitForHost, signal);
			notify(up ? "pi-wake: machine is awake" : "pi-wake: machine did not respond in time", up ? "info" : "warning");
		} else if (cfg.waitForHost > 0) {
			await doSleep(cfg.waitForHost, signal);
		}
	};
}
