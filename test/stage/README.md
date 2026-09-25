# Stage test scripts (getLogs plan)

Scripts for `bg-rpc-docs/IMPLEMENTATION_PLAN_GETLOGS_KEYS.md`. Each phase's **Tests**
list says when to run them; later phases (3b-2 to 3b-4) rerun all of them as a
regression check.

**Run on the downstream machine**, against **stage only**: they send requests to
`stage.rpc.buidlguidl.com:48544` (bg-rpc-proxy) and `:3003` (pool), and read local
logs (`/home/ubuntu/shared/*.log`, `~/.pm2/logs/pool-out.log`). Plain Node, no
dependencies: `node test/stage/test3.js`. They are not jest tests (`npm test` skips
them). Each prints `PASS`/`FAIL` lines and ends with `all passed` or `N FAILED`.

| Script | Plan item | Needs | Checks |
|---|---|---|---|
| `test1a.js` | 1a | 1+ node | large receipts and getLogs through the pool, node stays connected, no fallback |
| `test1c.js` | 1c | 1+ node | batch cap 50/51, chunked POST and extra headers reach the pool, heavy-method failures don't fall back |
| `test1e.js` | 1e | 1+ node | gzip/br/deflate negotiation on 48544, decoded body identical, small responses uncompressed. Uses `getlogs60.json` (a fixed past range) |
| `test3.js` | 3 | 1+ reth node | floor check, tags, `pending`, `blockHash` (D11), capacity (`4 × readyNodes + 1` concurrent → one `-32005`), `/getlogsStatus` |
| `testfilters.js` | D15 | 1+ node | the six filter methods answer `-32601`; `eth_getLogs` still works |
| `testS2.js` | deferred M5–M7 | 2+ reth nodes with different floors | routing by floor coverage, capacity spill-over, `/getlogsStatus` (lowest floor, D14) |
| `testS3.js` | deferred M4, M12 | 3+ nodes at the same head | getLogs never compared; `eth_call` still 1-in-20 compared; spread across nodes |
| `testM14.js` | deferred M14 (and M18) | 2+ nodes; bgnode7 as the only one covering 25.5M | a node kept busy with getLogs gets clearly fewer light requests (power of two, 3b-3): baseline split vs split under load |
| `freshness-summary.sh` | 3b "Decide" (freshness) | pool log with `🧭` lines | summary of candidates at / within 1 of the highest block |

Stage-specific values are hard-coded: receipt floors 25,300,000 (bgnode7) and
25,800,000 (others) as of 2026-09-25, and the USDC / ENS addresses used for
large and ~1 s queries. Update them if stage's nodes change.

Not scripted (manual steps in the plan, because they change config temporarily and
restart the pool or proxy): the 200 ms heavy-timeout test (M3), the forced
light-method retry (M12 retry half, sends one Telegram alert), and the 50 ms
bg-rpc-proxy timeout (`-69008`).

Side effects: requests go through stage's real chain. Failures of **non-getLogs**
methods fall through to stage's broken fallback and send a Telegram alert; these
scripts are written to avoid that in normal runs.
