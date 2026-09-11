# Checkpoint evidence

Screenshots captured from a single live Anvil session (chain 31337), 11 September 2026.
These are the images reproduced in Appendix A of the project report.

| Prefix | Checkpoint | Covers |
|---|---|---|
| `cp1-*` | 1 — Environment | Anvil running, chain ID 31337, the three MetaMask accounts, network configuration |
| `cp2-*` | 2 — Build / deploy | `forge test` passing, deployment output with the admin binding asserted |
| `cp3-*` | 3 — Roles, vesting | Admin / employer / employee views, registration, stream creation, live vesting, and the DevTools proof that the counter issues no per-second RPC |
| `cp4-*` | 4 — Settlement | Withdrawal, fee accrual, admin claim, cancellation three-way split, mid-stream partial withdrawal |
| `cp5-*` | 5 — Bonus | Two browser profiles; cancellation in one updates the other with no reload |
| `fig-*` | — | Diagrams used in the report |

Filenames are ordered so that `ls` returns them in demonstration order.
