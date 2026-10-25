# pi-wake

Wake-on-LAN for [pi](https://github.com/earendil-works/pi) — wake a local LLM
machine **before** a request is sent to a configured provider, then optionally
wait until the machine's model service actually responds.

Use case: you run models on a separate machine (e.g. a home server) under a
provider id such as `local-llm` (`local-llm/gemini4`, `local-llm/qwen3.8`, …).
When that machine sleeps, the first request would fail. `pi-wake` sends a WoL
magic packet and waits for the service before the request goes out.

## How it works

1. On the `before_provider_request` event, the extension looks at the current
   model's **provider** (`ctx.model.provider`). Only requests whose provider is
   in `providers` trigger anything; everything else is left untouched.
2. If probing is enabled, it first checks whether the host is already awake
   (fast path — no WoL, no waiting).
3. Otherwise it sends a WoL magic packet (UDP broadcast, no external binaries).
4. It then waits according to `waitForHost`:
   - **probe enabled** — poll the probe URL until it responds, up to
     `waitForHost` ms (`0` = wait indefinitely, until the probe responds or the
     request is aborted);
   - **probe disabled** — a fixed delay of `waitForHost` ms (`0` = no delay).

## Probe URL

By default the probe URL is **derived from the provider's own base URL** in
pi's model config:

```
model.baseUrl
  → fallback: ctx.modelRegistry.getProvider(model.provider).baseUrl
```

`model.baseUrl` already reflects the configured `baseUrl` (including any
override in `models.json`), so no credential/API-key resolution is performed —
which also avoids a network round-trip to a machine that is still asleep.
Then `/models` is appended. For a `local-llm` provider with
`baseUrl: http://192.0.2.50:1234/v1`, it probes
`http://192.0.2.50:1234/v1/models` — the real model-listing endpoint, without
sending an agent request.

Set `probeUrl` to override this (e.g. a dedicated health endpoint).

"Asleep" is defined strictly as a **thrown fetch error** (ECONNREFUSED,
timeout, DNS failure, host unreachable). Any HTTP response — even `404`/`401`/
`500` — means the service is reachable and therefore "awake".

## Installation

Copy or symlink the folder into an extension directory:

```bash
# global
ln -s "$PWD/pi-wake" ~/.pi/agent/extensions/pi-wake

# or project-local
ln -s "$PWD/pi-wake" .pi/extensions/pi-wake
```

Then `/reload` (or restart pi). Configure with `/wol` — there is no build step
and no runtime dependency (the extension uses only Node/Bun built-ins).

## Testing

Unit tests cover the core logic (`wol.ts`) and the pi wiring (`index.ts`):

```bash
npm install   # dev dependency: vitest
npm test
```

## Configuration

Configuration is stored in `<agent-dir>/wol.json` (`~/.pi/agent/wol.json` by
default). It is created on the first `/wol set …` command. See
[`config.example.json`](config.example.json) for the full shape.

| Key | Type | Default | Description |
|---|---|---|---|
| `mac` | string | `""` | MAC address of the machine to wake, e.g. `AA:BB:CC:DD:EE:FF`. |
| `probeUrl` | string? | *(derived)* | Override probe URL. Omit to derive `<baseUrl>/models` from the provider. |
| `waitForHost` | number (ms) | `120000` | Wait time after WoL. Probe enabled: max time to wait for the probe (`0` = no limit). Probe disabled: fixed delay (`0` = no delay). |
| `providers` | string[] | `[]` | Provider ids that trigger WoL, e.g. `["local-llm"]`. |
| `useProbe` | boolean | `true` | Whether to probe before/after sending WoL. |
| `broadcastAddress` | string | `255.255.255.255` | UDP broadcast address for the magic packet. Use the subnet broadcast (e.g. `192.0.2.255`) when `255.255.255.255` does not reach the target. |
| `wolPort` | number | `9` | UDP port for the magic packet (conventionally `7` or `9`). |

## The `/wol` command

```
/wol                                   show configuration (and subcommand help)
/wol mac <AA:BB:CC:DD:EE:FF>           set the MAC address
/wol probe <url|auto>                  override the probe URL (auto = derive)
/wol wait <ms>                         set waitForHost (0 = no limit / no delay)
/wol providers <a,b,c>                 set providers that trigger WoL
/wol use-probe <on|off>                enable/disable probing
/wol broadcast <ipv4>                  set the UDP broadcast address
/wol port <1-65535>                    set the UDP port
/wol wake                              wake the machine now (manual test)
```

All inputs are validated: MAC format (six hex octets, not all-zero/all-ones,
not multicast), probe URL (`http`/`https`), wait time (non-negative integer),
providers (non-empty ids), broadcast address (IPv4), and port (1–65535).
Invalid values are rejected with an error notification and are not saved.
When `wol.json` is hand-edited, a field with the wrong type (e.g. `providers`
as a string instead of a list) falls back to its default rather than breaking
requests.

## Caveats & protections

- **No WoL flooding** — magic packets are throttled to at most one per 30
  seconds (`WOL_COOLDOWN_MS`), and the "already awake" probe fast-path avoids
  sending a packet at all when the host responds.
- **No probe hammering** — probes are spaced `PROBE_INTERVAL_MS` (1.5 s) apart
  and each attempt has a `PROBE_TIMEOUT_MS` (4 s) hard timeout, so a
  blackholed host cannot stall the loop indefinitely.
- **`waitForHost: 0` blocks** — with probing enabled this waits until the probe
  succeeds. It honors the request's abort signal, so cancelling the request
  stops the wait, but an unattended request can block for a long time.
- **Broadcast reach** — `255.255.255.255` may not cross routers/VLANs. Set
  `broadcastAddress` to the target subnet's broadcast if the packet does not
  arrive. The target machine must have WoL enabled in BIOS/NIC and OS.
- **Probe only, no magic** — if the provider has no usable `baseUrl` and no
  `probeUrl` is set, the extension falls back to a fixed `waitForHost` delay
  (or nothing when it is `0`).
- **Failures never break the request** — any WoL/probe error is caught; the
  provider request proceeds (and fails normally if the host is still down).

## Code layout

- `wol.ts` — pure core logic with no pi dependencies (config, validation,
  magic packet, probe/wait, wake sequence).
- `index.ts` — thin pi wiring: the `before_provider_request` hook and the
  `/wol` command, delegating to `wol.ts`.
- `wol.test.ts` / `index.test.ts` — Vitest suites.
