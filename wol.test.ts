import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	buildMagicPacket,
	createWaker,
	DEFAULTS,
	deriveProbeUrl,
	isUp,
	loadConfig,
	saveConfig,
	sendMagicPacket,
	sleep,
	validateConfig,
	validateIpv4,
	validateMac,
	validateUrl,
	waitUntilUp,
	type WolConfig,
} from "./wol";

const dgramMock = vi.hoisted(() => {
	const socket = {
		once: vi.fn(),
		bind: vi.fn(),
		setBroadcast: vi.fn(),
		send: vi.fn(),
		close: vi.fn(),
	};
	return { socket, createSocket: vi.fn(() => socket) };
});

vi.mock("node:dgram", () => ({ createSocket: dgramMock.createSocket }));

function validConfig(overrides: Partial<WolConfig> = {}): WolConfig {
	return {
		enabled: true,
		mac: "AA:BB:CC:DD:EE:FF",
		waitForHost: 100,
		providers: ["local-llm"],
		useProbe: true,
		broadcastAddress: "255.255.255.255",
		wolPort: 9,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

describe("validateMac", () => {
	it("accepts colon and dash separators, case-insensitive", () => {
		expect(validateMac("AA:BB:CC:DD:EE:FF")).toBeNull();
		expect(validateMac("aa-bb-cc-dd-ee-ff")).toBeNull();
	});

	it("rejects wrong lengths", () => {
		expect(validateMac("AA:BB:CC")).not.toBeNull();
		expect(validateMac("AA:BB:CC:DD:EE:FF:00")).not.toBeNull();
	});

	it("rejects non-hex characters", () => {
		expect(validateMac("GG:BB:CC:DD:EE:FF")).not.toBeNull();
	});

	it("rejects all-zero and all-ones addresses", () => {
		expect(validateMac("00:00:00:00:00:00")).not.toBeNull();
		expect(validateMac("FF:FF:FF:FF:FF:FF")).not.toBeNull();
	});

	it("rejects multicast addresses", () => {
		expect(validateMac("01:00:5E:00:00:01")).not.toBeNull();
	});
});

describe("validateUrl", () => {
	it("accepts http and https", () => {
		expect(validateUrl("http://192.0.2.50:1234/v1")).toBeNull();
		expect(validateUrl("https://example.com")).toBeNull();
	});

	it("rejects non-http(s) schemes and malformed URLs", () => {
		expect(validateUrl("ftp://example.com")).not.toBeNull();
		expect(validateUrl("not a url")).not.toBeNull();
	});
});

describe("validateIpv4", () => {
	it("accepts valid addresses", () => {
		expect(validateIpv4("255.255.255.255")).toBe(true);
		expect(validateIpv4("192.0.2.0")).toBe(true);
	});

	it("rejects out-of-range and malformed addresses", () => {
		expect(validateIpv4("256.1.1.1")).toBe(false);
		expect(validateIpv4("1.2.3")).toBe(false);
		expect(validateIpv4("abc")).toBe(false);
	});
});

describe("validateConfig", () => {
	it("accepts a valid config", () => {
		expect(validateConfig(validConfig())).toEqual([]);
	});

	it("reports an invalid mac", () => {
		const errors = validateConfig(validConfig({ mac: "zz" }));
		expect(errors.some((e) => e.startsWith("mac:"))).toBe(true);
	});

	it("reports an invalid probeUrl", () => {
		const errors = validateConfig(validConfig({ probeUrl: "ftp://x" }));
		expect(errors.some((e) => e.startsWith("probeUrl:"))).toBe(true);
	});

	it("reports negative and fractional waitForHost", () => {
		expect(validateConfig(validConfig({ waitForHost: -1 })).some((e) => e.startsWith("waitForHost:"))).toBe(true);
		expect(validateConfig(validConfig({ waitForHost: 1.5 })).some((e) => e.startsWith("waitForHost:"))).toBe(true);
	});

	it("reports a non-string provider entry", () => {
		const cfg = validConfig({ providers: ["ok", 5 as unknown as string] });
		expect(validateConfig(cfg).some((e) => e.startsWith("providers:"))).toBe(true);
	});

	it("reports a non-boolean enabled flag", () => {
		const cfg = validConfig({ enabled: "yes" as unknown as boolean });
		expect(validateConfig(cfg).some((e) => e.startsWith("enabled:"))).toBe(true);
	});

	it("reports a non-boolean useProbe", () => {
		const cfg = validConfig({ useProbe: "yes" as unknown as boolean });
		expect(validateConfig(cfg).some((e) => e.startsWith("useProbe:"))).toBe(true);
	});

	it("reports an invalid broadcast address", () => {
		expect(validateConfig(validConfig({ broadcastAddress: "nope" })).some((e) => e.startsWith("broadcastAddress:"))).toBe(true);
	});

	it("reports an invalid wolPort", () => {
		expect(validateConfig(validConfig({ wolPort: 0 })).some((e) => e.startsWith("wolPort:"))).toBe(true);
		expect(validateConfig(validConfig({ wolPort: 70000 })).some((e) => e.startsWith("wolPort:"))).toBe(true);
		expect(validateConfig(validConfig({ wolPort: 1.5 })).some((e) => e.startsWith("wolPort:"))).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Config persistence
// ---------------------------------------------------------------------------

describe("loadConfig / saveConfig", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "pi-wake-on-lan-test-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const path = () => join(dir, "wol.json");

	it("returns defaults when the file is missing", () => {
		expect(loadConfig(path())).toEqual(DEFAULTS);
	});

	it("returns defaults when the file is not valid JSON", () => {
		writeFileSync(path(), "not json");
		expect(loadConfig(path())).toEqual(DEFAULTS);
	});

	it("loads the enabled flag", () => {
		writeFileSync(path(), JSON.stringify({ enabled: false }));
		expect(loadConfig(path()).enabled).toBe(false);
	});

	it("merges known fields and keeps defaults for the rest", () => {
		writeFileSync(path(), JSON.stringify({ mac: "AA:BB:CC:DD:EE:FF", providers: ["local-llm"] }));
		const cfg = loadConfig(path());
		expect(cfg.mac).toBe("AA:BB:CC:DD:EE:FF");
		expect(cfg.providers).toEqual(["local-llm"]);
		expect(cfg.waitForHost).toBe(DEFAULTS.waitForHost);
		expect(cfg.wolPort).toBe(DEFAULTS.wolPort);
	});

	it("coerces wrong types back to defaults", () => {
		writeFileSync(
			path(),
			JSON.stringify({
				mac: 123,
				providers: "local-llm",
				waitForHost: "forever",
				useProbe: "yes",
				wolPort: 99999,
				broadcastAddress: 42,
			}),
		);
		expect(loadConfig(path())).toEqual(DEFAULTS);
	});

	it("drops non-string and blank provider entries", () => {
		writeFileSync(path(), JSON.stringify({ providers: ["ok", 5, "", "  "] }));
		expect(loadConfig(path()).providers).toEqual(["ok"]);
	});

	it("writes valid JSON and creates parent directories", () => {
		const nested = join(dir, "sub", "wol.json");
		saveConfig(nested, validConfig());
		expect(JSON.parse(readFileSync(nested, "utf8"))).toMatchObject({ mac: "AA:BB:CC:DD:EE:FF" });
	});

	it("restricts config file permissions on POSIX systems", () => {
		const configPath = path();
		saveConfig(configPath, validConfig());
		if (process.platform !== "win32") expect(statSync(configPath).mode & 0o777).toBe(0o600);
	});

	it("tightens permissions on existing config files when loaded", () => {
		if (process.platform === "win32") return;
		const configPath = path();
		writeFileSync(configPath, JSON.stringify(validConfig()), { mode: 0o644 });
		chmodSync(configPath, 0o644);

		loadConfig(configPath);

		expect(statSync(configPath).mode & 0o777).toBe(0o600);
	});
});

// ---------------------------------------------------------------------------
// Magic packet
// ---------------------------------------------------------------------------

describe("buildMagicPacket", () => {
	it("builds the standard 102-byte magic packet", () => {
		const packet = buildMagicPacket("AA:BB:CC:DD:EE:FF");
		expect(packet.length).toBe(102);
		expect([...packet.subarray(0, 6)]).toEqual([0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);

		const mac = [0xaa, 0xbb, 0xcc, 0xdd, 0xee, 0xff];
		for (let i = 0; i < 16; i++) {
			expect([...packet.subarray(6 + i * 6, 6 + (i + 1) * 6)]).toEqual(mac);
		}
	});

	it("throws for an invalid MAC", () => {
		expect(() => buildMagicPacket("nope")).toThrow("invalid MAC address");
	});
});

describe("sendMagicPacket", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		dgramMock.socket.once.mockReset();
		dgramMock.socket.bind.mockImplementation((cb: () => void) => cb());
		dgramMock.socket.send.mockImplementation((_p: Buffer, _o: number, _l: number, _port: number, _addr: string, cb: (err?: Error | null) => void) =>
			cb(null),
		);
	});

	it("broadcasts the magic packet to the target address and port", async () => {
		await sendMagicPacket("AA:BB:CC:DD:EE:FF", "192.0.2.255", 9);

		expect(dgramMock.createSocket).toHaveBeenCalledWith("udp4");
		expect(dgramMock.socket.setBroadcast).toHaveBeenCalledWith(true);
		expect(dgramMock.socket.send).toHaveBeenCalledTimes(1);

		const [packet, offset, length, port, addr] = dgramMock.socket.send.mock.calls[0];
		expect(offset).toBe(0);
		expect(length).toBe(102);
		expect(port).toBe(9);
		expect(addr).toBe("192.0.2.255");
		expect(packet).toEqual(buildMagicPacket("AA:BB:CC:DD:EE:FF"));
		expect(dgramMock.socket.close).toHaveBeenCalled();
	});

	it("rejects when the socket reports an error", async () => {
		dgramMock.socket.send.mockImplementation((_p: Buffer, _o: number, _l: number, _port: number, _addr: string, cb: (err?: Error | null) => void) =>
			cb(new Error("network down")),
		);
		await expect(sendMagicPacket("AA:BB:CC:DD:EE:FF", "255.255.255.255", 9)).rejects.toThrow("network down");
	});

	it("rejects and closes the socket when it emits an error", async () => {
		dgramMock.socket.bind.mockImplementation(() => {});
		dgramMock.socket.once.mockImplementation((event: string, handler: (err: Error) => void) => {
			if (event === "error") handler(new Error("bind refused"));
		});

		await expect(sendMagicPacket("AA:BB:CC:DD:EE:FF", "255.255.255.255", 9)).rejects.toThrow("bind refused");
		expect(dgramMock.socket.close).toHaveBeenCalled();
	});

	it("rejects for an invalid MAC without touching the socket", async () => {
		await expect(sendMagicPacket("zz", "255.255.255.255", 9)).rejects.toThrow("invalid MAC address");
		expect(dgramMock.createSocket).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Probe URL derivation
// ---------------------------------------------------------------------------

describe("deriveProbeUrl", () => {
	it("returns the override as-is", () => {
		expect(deriveProbeUrl("http://custom/health", "http://a/v1", "http://b/v1")).toBe("http://custom/health");
	});

	it("appends /models to the model baseUrl", () => {
		expect(deriveProbeUrl(undefined, "http://192.0.2.50:1234/v1", undefined)).toBe("http://192.0.2.50:1234/v1/models");
	});

	it("strips a trailing slash before appending", () => {
		expect(deriveProbeUrl(undefined, "http://192.0.2.50:1234/v1/", undefined)).toBe("http://192.0.2.50:1234/v1/models");
	});

	it("falls back to the provider baseUrl", () => {
		expect(deriveProbeUrl(undefined, undefined, "http://provider/v1")).toBe("http://provider/v1/models");
	});

	it("returns undefined when no base URL is available", () => {
		expect(deriveProbeUrl(undefined, undefined, undefined)).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// Probe / wait helpers
// ---------------------------------------------------------------------------

describe("isUp", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("treats a resolving fetch — even an error status — as awake", async () => {
		const fetchMock = vi.fn(async () => ({ ok: false, status: 500 }));
		vi.stubGlobal("fetch", fetchMock);

		await expect(isUp("http://x/models")).resolves.toBe(true);
		expect(fetchMock).toHaveBeenCalledWith("http://x/models", { method: "GET", signal: expect.any(AbortSignal) });
	});

	it("treats a thrown fetch as asleep", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => {
			throw new Error("ECONNREFUSED");
		}));
		await expect(isUp("http://x/models")).resolves.toBe(false);
	});
});

describe("sleep", () => {
	afterEach(() => vi.useRealTimers());

	it("resolves only after the delay elapses", async () => {
		vi.useFakeTimers();
		const promise = sleep(1000);
		let settled = false;
		void promise.then(() => {
			settled = true;
		});

		await vi.advanceTimersByTimeAsync(999);
		expect(settled).toBe(false);

		await vi.advanceTimersByTimeAsync(1);
		await expect(promise).resolves.toBeUndefined();
		expect(settled).toBe(true);
	});

	it("resolves immediately when the signal is already aborted", async () => {
		const ctrl = new AbortController();
		ctrl.abort();
		await expect(sleep(10_000, ctrl.signal)).resolves.toBeUndefined();
	});

	it("resolves early when aborted mid-wait", async () => {
		const ctrl = new AbortController();
		const promise = sleep(10_000, ctrl.signal);
		ctrl.abort();
		await expect(promise).resolves.toBeUndefined();
	});
});

describe("waitUntilUp", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("returns true once the host responds", async () => {
		let calls = 0;
		vi.stubGlobal("fetch", vi.fn(async () => {
			calls += 1;
			if (calls < 3) throw new Error("ECONNREFUSED");
			return {};
		}));
		await expect(waitUntilUp("http://x/models", 10_000, undefined, 1)).resolves.toBe(true);
		expect(calls).toBe(3);
	});

	it("returns false when the deadline passes", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => {
			throw new Error("ECONNREFUSED");
		}));
		await expect(waitUntilUp("http://x/models", 20, undefined, 5)).resolves.toBe(false);
	});

	it("returns false when the signal aborts", async () => {
		vi.stubGlobal("fetch", vi.fn(async () => {
			throw new Error("ECONNREFUSED");
		}));
		const ctrl = new AbortController();
		const promise = waitUntilUp("http://x/models", 0, ctrl.signal, 5);
		ctrl.abort();
		await expect(promise).resolves.toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Wake sequence
// ---------------------------------------------------------------------------

describe("createWaker", () => {
	it("does nothing when the host is already awake", async () => {
		const isUpMock = vi.fn(async () => true);
		const sendMagicPacketMock = vi.fn(async () => {});
		const waker = createWaker({ isUp: isUpMock, sendMagicPacket: sendMagicPacketMock });
		const notify = vi.fn();

		await waker(validConfig(), "http://x/models", undefined, notify);

		expect(isUpMock).toHaveBeenCalledWith("http://x/models", undefined);
		expect(sendMagicPacketMock).not.toHaveBeenCalled();
		expect(notify).not.toHaveBeenCalled();
	});

	it("sends WoL then waits for the probe when asleep", async () => {
		const isUpMock = vi.fn(async () => false);
		const waitUntilUpMock = vi.fn(async () => true);
		const sendMagicPacketMock = vi.fn(async () => {});
		const waker = createWaker({ isUp: isUpMock, waitUntilUp: waitUntilUpMock, sendMagicPacket: sendMagicPacketMock });
		const notify = vi.fn();

		await waker(validConfig(), "http://x/models", undefined, notify);

		expect(sendMagicPacketMock).toHaveBeenCalledWith("AA:BB:CC:DD:EE:FF", "255.255.255.255", 9);
		expect(waitUntilUpMock).toHaveBeenCalledWith("http://x/models", 100, undefined);
		expect(notify).toHaveBeenNthCalledWith(1, expect.stringContaining("sending WoL"), "info");
		expect(notify).toHaveBeenNthCalledWith(2, expect.stringContaining("waiting"), "info");
		expect(notify).toHaveBeenNthCalledWith(3, expect.stringContaining("awaiting host"), "info");
		expect(notify).toHaveBeenNthCalledWith(4, expect.stringContaining("awake"), "info");
	});

	it("uses a fixed delay instead of probing when probing is disabled", async () => {
		const sendMagicPacketMock = vi.fn(async () => {});
		const sleepMock = vi.fn(async () => {});
		const waitUntilUpMock = vi.fn(async () => true);
		const waker = createWaker({ sendMagicPacket: sendMagicPacketMock, sleep: sleepMock, waitUntilUp: waitUntilUpMock });

		await waker(validConfig({ useProbe: false, waitForHost: 500 }), undefined, undefined, vi.fn());

		expect(sendMagicPacketMock).toHaveBeenCalledTimes(1);
		expect(waitUntilUpMock).not.toHaveBeenCalled();
		expect(sleepMock).toHaveBeenCalledWith(500, undefined);
	});

	it("skips the delay when probing is disabled and waitForHost is 0", async () => {
		const sendMagicPacketMock = vi.fn(async () => {});
		const sleepMock = vi.fn(async () => {});
		const waker = createWaker({ sendMagicPacket: sendMagicPacketMock, sleep: sleepMock });

		await waker(validConfig({ useProbe: false, waitForHost: 0 }), undefined, undefined, vi.fn());

		expect(sleepMock).not.toHaveBeenCalled();
	});

	it("notifies and skips WoL for an invalid MAC", async () => {
		const sendMagicPacketMock = vi.fn(async () => {});
		const waker = createWaker({ sendMagicPacket: sendMagicPacketMock });
		const notify = vi.fn();

		await waker(validConfig({ mac: "bad" }), "http://x/models", undefined, notify);

		expect(notify).toHaveBeenCalledWith(expect.stringContaining("MAC"), "error");
		expect(sendMagicPacketMock).not.toHaveBeenCalled();
	});

	it("notifies and skips waiting when WoL fails", async () => {
		const sendMagicPacketMock = vi.fn(async () => {
			throw new Error("boom");
		});
		const waitUntilUpMock = vi.fn(async () => true);
		const isUpMock = vi.fn(async () => false);
		const waker = createWaker({ sendMagicPacket: sendMagicPacketMock, waitUntilUp: waitUntilUpMock, isUp: isUpMock });
		const notify = vi.fn();

		await waker(validConfig(), "http://x/models", undefined, notify);

		expect(notify).toHaveBeenCalledWith(expect.stringContaining("WoL failed"), "error");
		expect(waitUntilUpMock).not.toHaveBeenCalled();
	});

	it("skips WoL when the request aborts during the fast-path probe", async () => {
		const ctrl = new AbortController();
		const isUpMock = vi.fn(async () => {
			ctrl.abort();
			return false;
		});
		const sendMagicPacketMock = vi.fn(async () => {});
		const waker = createWaker({ isUp: isUpMock, sendMagicPacket: sendMagicPacketMock });

		await waker(validConfig(), "http://x/models", ctrl.signal, vi.fn());

		expect(sendMagicPacketMock).not.toHaveBeenCalled();
	});

	it("enforces the cooldown between magic packets", async () => {
		let t = 0;
		const sendMagicPacketMock = vi.fn(async () => {});
		const isUpMock = vi.fn(async () => false);
		const waitUntilUpMock = vi.fn(async () => true);
		const waker = createWaker({
			sendMagicPacket: sendMagicPacketMock,
			isUp: isUpMock,
			waitUntilUp: waitUntilUpMock,
			now: () => t,
			cooldownMs: 1000,
		});
		const notify = vi.fn();

		await waker(validConfig(), "http://x/models", undefined, notify);
		await waker(validConfig(), "http://x/models", undefined, notify);
		expect(sendMagicPacketMock).toHaveBeenCalledTimes(1);

		t = 1000;
		await waker(validConfig(), "http://x/models", undefined, notify);
		expect(sendMagicPacketMock).toHaveBeenCalledTimes(2);
	});

	it("notifies a warning when the probe never responds in time", async () => {
		const isUpMock = vi.fn(async () => false);
		const waitUntilUpMock = vi.fn(async () => false);
		const sendMagicPacketMock = vi.fn(async () => {});
		const waker = createWaker({ isUp: isUpMock, waitUntilUp: waitUntilUpMock, sendMagicPacket: sendMagicPacketMock });
		const notify = vi.fn();

		await waker(validConfig(), "http://x/models", undefined, notify);

		expect(notify).toHaveBeenCalledWith(expect.stringContaining("did not respond"), "warning");
	});
});
