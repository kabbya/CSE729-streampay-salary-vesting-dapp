# StreamPay - Corporate Micro-Salary & Vesting Protocol

CSE729 Project 2. An employer locks ETH for an employee for a fixed number of
seconds. The salary unlocks linearly, second by second. The employee withdraws
whatever has vested; either party can cancel; the protocol admin earns a 1% fee
and claims it with a pull payment.

| | |
|---|---|
| Contract | Solidity `^0.8.20`, built and tested with Foundry |
| Chain | local Anvil, RPC `http://127.0.0.1:8545`, chain ID `31337` |
| Frontend | HTML / CSS / Vanilla JavaScript + Ethers.js **v6.7.0** + MetaMask |
| Admin | the deployer, i.e. Anvil Account #0 |

## Roles

| Anvil account | Address | Role |
|---|---|---|
| #0 | `0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266` | Protocol Admin (deployer, collects the 1% fee) |
| #1 | `0x70997970C51812dc3A010C7d01b50e0d17dc79C8` | Employer |
| #2 | `0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC` | Employee |

These are Anvil's default development accounts. Their private keys are public and
worthless. **Never send real ETH to them and never reuse them on a public network.**

## Prerequisites

- Foundry (`forge`, `cast`, `anvil`) - <https://getfoundry.sh>
- MetaMask browser extension
- VS Code with the Live Server extension (or any static file server)

## Run it

```bash
# 0. clone
git clone https://github.com/YOUR_USERNAME/streampay.git
cd streampay
# forge-std is vendored inside lib/ (no git submodule), so nothing else to fetch.

# 1. build and test
forge build
forge test -vvv

# 2. terminal A - local chain (leave running)
anvil

# 3. terminal B - deploy from Account #0
forge script script/DeployStreamPay.s.sol:DeployStreamPay \
  --rpc-url http://127.0.0.1:8545 --broadcast

# 4. export the ABI the frontend uses (note: --json is required)
forge inspect src/StreamPay.sol:StreamPay abi --json > frontend/abi/StreamPay.json

# 5. paste the printed address into frontend/config.js -> contractAddress

# 6. serve the frontend over HTTP (never open index.html with file://)
#    VS Code: right-click frontend/index.html -> "Open with Live Server"
#    or:      python3 -m http.server 5500 --directory frontend
```

MetaMask network settings:

| Field | Value |
|---|---|
| Network name | Anvil Localhost |
| RPC URL | `http://127.0.0.1:8545` |
| Chain ID | `31337` |
| Currency symbol | ETH |

> **Anvil is amnesiac.** Every restart wipes the chain. After a restart you must
> redeploy and update `contractAddress` in `frontend/config.js`. If MetaMask then
> says "nonce too high", use Settings -> Advanced -> Clear activity tab data.

## Demo script

1. Connect Account #1 (Employer). Open **Company setup**, register Account #2.
2. Create a stream: recipient = Account #2, duration = `120`, amount = `1` ETH.
3. Switch to Account #2 (Employee) - ideally in a second browser profile. The
   claimable figure ticks up once a second.
4. Around 40 s, click **Withdraw Vested Funds**. Withdrawn and fee update.
5. Back in the employer window, click **Cancel Stream**. The employee window
   flips to `Closed` and stops ticking **without a reload** (bonus checkpoint).
6. Switch to Account #0 (Admin) and click **Claim Admin Fees**.

## Money math

```
unlocked        = totalDeposit * elapsed / duration      (capped at totalDeposit)
grossClaimable  = unlocked - totalWithdrawn
feeOwedTotal    = (totalWithdrawn + grossClaimable) * 100 / 10000
feeNow          = feeOwedTotal - totalFeeCharged
employeeNet     = grossClaimable - feeNow
employerRefund  = totalDeposit - vested                  (on cancel)
```

`totalWithdrawn` stores the **gross** vested principal already settled, never the
employee's net receipt - otherwise the 1% already taken as fee would become
claimable a second time. The cumulative fee formula makes N small withdrawals
cost exactly the same total fee as one big one.

Worked example, 1 ETH over 100 s, withdraw at 40 s, cancel at 70 s:

| | Employee | Admin | Employer |
|---|---|---|---|
| withdraw @40s | 0.396 | 0.004 | - |
| cancel @70s | 0.297 | 0.003 | 0.300 |
| **total** | **0.693** | **0.007** | **0.300** |

0.693 + 0.007 + 0.300 = **1.000 ETH**. Nothing is created or destroyed.

## Tests

`forge test` - 38 tests across two suites: `StreamPay.t.sol` (35, including two fuzzed
properties and a conservation-of-funds invariant) and `AdversarialEdgeCases.t.sol` (3 wei-level
edge cases: a `type(uint256).max` duration must not lock funds, batch reads reject unknown
IDs, and a final 1-wei claim whose whole value is fee still settles and closes the stream).

```
forge test -vvv
forge test --gas-report
forge coverage
```

## Optional verification tools

These are not needed to run the project; they are how the maths and the UI were
verified. Run each against a **freshly restarted** Anvil.

```bash
npm install                      # installs ethers 6.7.0 + playwright (pnpm also works)
npx playwright install chromium  # one-time browser download for the UI test
cd tools
node verify-frontend-math.mjs    # JS ticking maths vs the live contract (reads config.js)
node e2e-ui-test.mjs             # headless browser walkthrough incl. bonus + safety probes
```

Expected: `differential check: 36 comparisons, 0 mismatches` and `28/28 UI checks passed`.

## Layout

```
src/StreamPay.sol              the contract
test/StreamPay.t.sol           35 Forge tests
test/AdversarialEdgeCases.t.sol    3 wei-level edge-case tests
script/DeployStreamPay.s.sol   deploys from Account #0
frontend/index.html            role-aware UI
frontend/app.js                Ethers v6 client, single-fetch ticking engine
frontend/config.js             chain ID, RPC URL, contract address (public data only)
frontend/vendor/               ethers v6.7.0 UMD, vendored so the demo works offline
lib/forge-std/                 vendored test library (not a submodule)
frontend/abi/StreamPay.json    generated by `forge inspect ... --json`
tools/                         optional verification scripts
docs/screenshots/              checkpoint evidence
```

## Safety behaviour worth knowing

- Every write re-checks MetaMask's chain ID, that bytecode exists at `contractAddress`,
  and that it answers like StreamPay (`admin()`, `FEE_BPS()`), *before* building the
  transaction. After an Anvil restart with a stale address, the page refuses to send
  rather than pushing ETH into an empty account.
- The read provider is created with `cacheTimeout: -1`. Ethers v6 otherwise caches
  `getBlock("latest")` for 250 ms, which can hand the ticking engine a stale timestamp.
- Events that arrive while a refresh is already running are not dropped; the refresh
  loops once more.

## Known limitations

- Local academic prototype. Not audited, no production identity system, no
  dispute process, no legal compliance.
- `block.timestamp` is the time source. Adequate here; on a public chain a block
  producer can nudge it by a few seconds.
- Cancellation pushes ETH to both parties in one transaction. If either party were
  a contract that rejects ETH, the cancel would revert. A production version would
  use pull payments for all three parties, as the admin fee already does.
- Integer division floors, so the very last wei of a stream can round in the
  employee's favour by design; the cap guarantees it can never exceed the deposit.

## Credits

Built fresh for this project. The Foundry / Anvil / MetaMask / Ethers v6 /
`tx.wait()` / `contract.on()` workflow follows the course Lab 5 voting manual
(<https://github.com/Sajid-Mahir/Lab5-Web3-Voting-Manual>). No code was copied
from it; StreamPay shares no logic with the voting contract.
