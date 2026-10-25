# pi-wake-on-lan

Wake a local LLM host before pi sends it a provider request.

## Behavior

- Exact provider IDs in `providers` trigger automatic WoL.
- If probing is enabled and the service responds, no packet is sent. Otherwise
  pi-wake-on-lan broadcasts a magic packet, then waits for the service or timeout. Any
  HTTP response counts as available.
- The probe URL defaults to the current model's `baseUrl` (or provider `baseUrl`)
  plus `/models`. Set `probeUrl` to override it.
- WoL errors do not block the provider request. Packets are throttled to one per
  30 seconds.

## Install

After publication, install with:

```bash
pi install npm:pi-wake-on-lan
```

From source, copy or symlink this folder into
`~/.pi/agent/extensions/pi-wake-on-lan/` (global) or
`.pi/extensions/pi-wake-on-lan/` (project-local), then restart pi or run `/reload`.
There is no build step or runtime dependency.

## Configure

Run `/wol` for the interactive settings menu. It provides validated controls,
a manual probe check, and a manual wake action. Settings are stored in
`~/.pi/agent/wol.json` (or the active pi agent directory).

| Setting | Default | Meaning |
|---|---:|---|
| `enabled` | `true` | Enable automatic WoL for matching providers. |
| `mac` | `""` | Target machine's MAC address. |
| `providers` | `[]` | Exact provider IDs that trigger WoL. |
| `probeUrl` | derived | Override; otherwise `<baseUrl>/models`. |
| `useProbe` | `true` | Probe before waking and while waiting for the host. |
| `waitForHost` | `120000` ms | Probe timeout; `0` waits indefinitely. Without probing, this is a fixed delay (`0` means no delay). |
| `broadcastAddress` | `255.255.255.255` | UDP broadcast address. |
| `wolPort` | `9` | UDP port for the magic packet. |

## Commands

| Command | Action |
|---|---|
| `/wol` | Open settings menu. |
| `/wol on` / `/wol off` | Enable or disable automatic WoL. |
| `/wol status` | Show settings. |
| `/wol mac <address>` | Set the target MAC. |
| `/wol providers <a,b,c\|clear>` | Set or clear triggering provider IDs. |
| `/wol probe <url\|auto>` | Set or clear the probe URL override. |
| `/wol check` | Probe now and report UP/DOWN; sends no packet. |
| `/wol wait <ms>` | Set the wait time. |
| `/wol use-probe <on\|off>` | Enable or disable probing. |
| `/wol broadcast <ipv4>` | Set the broadcast address. |
| `/wol port <1-65535>` | Set the packet port. |
| `/wol wake` | Run the wake sequence manually, even if automatic WoL is off. |

Logs use a `[pi-wake-on-lan]` prefix and include provider/model IDs and wake/probe details such as the MAC address and probe URL. They are process-console logs, not conversation messages.

## Privacy

- Probe requests are GETs and contain no prompt or provider API key. 
- The WoL packet intentionally broadcasts the target MAC on the local network.
- The extension has no telemetry.

## Tests

```bash
npm install
npm test
```

The target host must support Wake-on-LAN and be reachable on the configured
broadcast network.
