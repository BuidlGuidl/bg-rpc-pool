# bg-rpc-pool

Community Ethereum node pool for the BuidlGuidl RPC stack. Volunteer nodes connect over Socket.IO, check in with their head block, and serve JSON-RPC. The proxy (`bg-rpc-proxy`) forwards cache misses here; this process picks live nodes, optionally checks consensus, writes per-node logs, and pushes cacheable results back to the proxy.

This is the execution layer, not the public RPC frontend. Clients talk to the proxy. The proxy talks to `POST /requestPool`. Connected nodes never accept traffic from the internet through this service; they only receive work over their Socket.IO session.

## How it fits

| Piece | Role |
| --- | --- |
| Community nodes (`buidlguidl-client`) | Connect to the public Socket.IO port and handle RPC methods |
| `bg-rpc-proxy` | Sends JSON-RPC to this pool; receives cache updates over WebSocket |
| `bg-rpc-logs` | Tails `shared/poolNodes.log` and `shared/poolCompareResults.log`; supplies weekly timeout rates used for routing |
| `bg-rpc-web-server` | Dashboard views of pool nodes, continents, and owner stats |
| `bg-rpc-watchdog` | Hits `/watchdog` |

## Routing

On `POST /requestPool`:

1. Drop nodes that have not fully checked in, are stale, or are marked **suspicious** (MAC on the blocklist, or a head block more than 2 ahead of the pool mode).
2. Prefer **fast** nodes: last-week timeout rate from `bg-rpc-logs` at or under 5%. Slow nodes are mostly excluded from serving, with a small chance of being included as a spot check.
3. Keep nodes at the highest block among the fast set. Pick up to three at random, with a fast node first.
4. Serve the request:
   - Fewer than 3 eligible nodes, or a method in the skip list (`eth_blockNumber`, `eth_chainId`, filters, mempool, …) → **single node**, retry a second node on timeout.
   - Otherwise → **1 in 20** requests go to three nodes in parallel (`handleRequestSet`): return the first success, then compare the three results and log mismatches. The other 19 go to a single node.
5. Default node timeout is 3s (`eth_getLogs` is 10s; a few block methods are shorter).
6. Successful, cacheable methods with a hex block number (not `latest` / `pending` / …) are broadcast to the proxy over WebSocket. Responses from suspicious nodes are not cached.

Each node attempt is appended to `shared/poolNodes.log`. Three-way compares go to `shared/poolCompareResults.log`.

## Rewards (Bread)

At the top of every hour, owners of nodes within 2 blocks of the pool head earn pending Bread (1.0 for a fast node, 0.25 for a slow node). At the start of each UTC day those balances are minted on Base.

## Two HTTPS servers

Both use `shared/server.key` and `shared/server.cert`.

**Public Socket.IO — port 48546** (community nodes)

| Path | Purpose |
| --- | --- |
| Socket.IO | Node sessions; `checkin` updates owner, machine id, enode, block number |
| `/enodes`, `/peerids`, `/consensuspeeraddr` | Discovery helpers for clients |
| `/yourpoints`, `/yourpendingbread` | Owner points and pending Bread |
| `/watchdog` | Health check |

**Internal API — port 3003** (proxy and dashboard)

| Path | Purpose |
| --- | --- |
| `POST /requestPool` | JSON-RPC from the proxy |
| WebSocket (same port) | Cache updates to the proxy |
| `/poolNodes`, `/nodeContinents`, `/rpcSiteStats`, `/yournodes` | Live pool views |
| `/suspiciousNodes`, `/suspiciousMacAddresses` | Abuse / blocklist inspection |
| `POST /reloadSuspiciousMacAddresses` | Reload `suspiciousMacAddresses.json` without restart |

Stale Socket.IO entries (no check-in for 5 minutes, or a disconnected socket) are removed every minute.

## Layout

```
pool.js                         Socket.IO + /requestPool + cache WebSocket
config.js                       Ports, timeouts, skip/cache method lists
utils/selectRandomClients.js    Fast/slow + highest-block selection
utils/handleRequestSingle.js    One node, timeout retry
utils/handleRequestSet.js       Three nodes + consensus
utils/compareResults.js         Normalize and diff RPC results
utils/updateCache.js            Broadcast cacheable results to the proxy
utils/logNode.js                shared/poolNodes.log
utils/logCompareResults.js      shared/poolCompareResults.log
utils/processNodesForBread.js   Hourly pending Bread
utils/mintBread.js              Daily mint on Base
utils/suspiciousMacChecker.js   MAC blocklist
database_scripts/               Postgres: location, ENS, Bread, points
```

## Run

```bash
yarn install
yarn start
```

On this host it runs as the PM2 process `pool`. It needs the TLS certs in `../shared/`, Postgres, and (for Bread minting) env vars in `.env`. After editing the MAC blocklist, either restart or `POST /reloadSuspiciousMacAddresses`. CLI: `node manageSuspiciousMac.js`.

## License

MIT. See [LICENSE](LICENSE).
