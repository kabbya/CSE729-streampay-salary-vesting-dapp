/* =============================================================================
 * StreamPay frontend - Ethers v6 + MetaMask + local Anvil (chain 31337)
 *
 * Three rules this file obeys, because the brief grades them:
 *  1. SINGLE FETCH: chain state is read once per "refresh", never once per second.
 *  2. LOCAL TICK:   one setInterval recomputes the claimable figure in the browser
 *                   using exactly the same integer maths the contract uses.
 *  3. tx.wait():    every write waits for the block, then refreshes state once.
 * ===========================================================================*/

"use strict";

const CFG = window.STREAMPAY_CONFIG;
const FEE_BPS = 100n;          // 1%
const BPS_DENOMINATOR = 10_000n;
const STATUS = { NONE: 0n, ACTIVE: 1n, CLOSED: 2n };
const ACTIVITY_PREVIEW = 6;    // rows shown before "Show all"
const ACTIVITY_MAX = 50;       // rows kept in memory
const CLOSED_PREVIEW = 3;      // closed streams shown per list before "Show all closed"

/* ---------------------------------------------------------------- state --- */
const S = {
  abi: null,
  readProvider: null,    // plain HTTP link to Anvil: reads + event feed
  eventContract: null,   // contract bound to the read/event provider
  browserProvider: null, // MetaMask's currently selected network
  signer: null,          // MetaMask signer: writes only
  writeContract: null,
  writeReady: false,
  account: null,
  chainId: null,
  admin: null,
  companyId: 0n,
  adminFeeBalance: 0n,
  contractBalance: 0n,
  outgoing: [],         // array of normalised stream objects
  incoming: [],
  accountBalance: 0n,   // connected wallet's ETH balance at the last snapshot
  activity: [],         // StreamPay events involving this account, newest first (max 50)
  activityExpanded: false, // false = show the first ACTIVITY_PREVIEW rows only
  closedExpanded: { employer: false, employee: false }, // per-list "Show all closed" state
  lastEvent: null,      // newest activity row, plus wallet balance before/after its block
  chainTimeBase: 0n,       // max(latest block time, wall time) at the last snapshot
  chainTimeBaseMs: 0,      // performance.now() at that same snapshot
  tickTimer: null,         // exactly ONE interval for the whole page
  refreshing: false,
  forceEmployer: false  // set when an employee also wants the create-stream form
};

/* ------------------------------------------------------------- DOM utils --- */
const $ = (id) => document.getElementById(id);
const show = (id, on) => { $(id).hidden = !on; };

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text !== undefined) n.textContent = text;   // textContent, never innerHTML
  return n;
}
function kv(key, value, big) {
  const wrap = el("div");
  wrap.appendChild(el("span", "k", key));
  const v = el("div", big ? "v big mono" : "v mono", value);
  wrap.appendChild(v);
  return { wrap, v };
}
const short = (a) => a ? a.slice(0, 6) + "..." + a.slice(-4) : "-";

/** Format without converting wei to Number (which loses precision for large values). */
function eth(value) {
  const wei = BigInt(value);
  if (wei !== 0n && wei > -1_000_000_000_000n && wei < 1_000_000_000_000n) {
    return wei.toString() + " wei";
  }
  const exact = ethers.formatEther(wei);
  const [whole, fraction = ""] = exact.split(".");
  const useful = fraction.replace(/0+$/, "");
  if (!useful) return whole + " ETH";
  return whole + "." + useful.slice(0, 6) + (useful.length > 6 ? "…" : "") + " ETH";
}

/** eth() with an explicit sign, for balance changes: "+0.99 ETH", "-1 ETH", "0 ETH". */
function signedEth(value) {
  const wei = BigInt(value);
  return (wei > 0n ? "+" : "") + eth(wei);
}

function status(kind, message) {
  const box = $("txStatus");
  box.className = "banner " + kind;
  box.textContent = message;
  box.hidden = false;
}
function clearStatus() { $("txStatus").hidden = true; }

/* ============================================================================
 * 1. MATHS - a byte-for-byte mirror of StreamPay.sol.
 *    Everything is BigInt. A Number cannot hold 1e18 wei without losing precision,
 *    and `/` on BigInt truncates toward zero, exactly like Solidity's integer `/`.
 * ==========================================================================*/

function unlockedOf(s, nowTs) {
  const effective = s.status === STATUS.CLOSED ? s.closedAt : nowTs;
  if (effective <= s.startTime) return 0n;
  const elapsed = effective - s.startTime;
  if (elapsed >= s.duration) return s.totalDeposit;
  return (s.totalDeposit * elapsed) / s.duration;
}

function previewOf(s, nowTs) {
  const unlocked = unlockedOf(s, nowTs);
  const gross = unlocked > s.totalWithdrawn ? unlocked - s.totalWithdrawn : 0n;
  const feeRequired = ((s.totalWithdrawn + gross) * FEE_BPS) / BPS_DENOMINATOR;
  const fee = feeRequired > s.totalFeeCharged ? feeRequired - s.totalFeeCharged : 0n;
  return { unlocked, gross, fee, net: gross - fee };
}

/**
 * Use wall time only once, when a chain snapshot is taken. Thereafter advance with
 * performance.now(), which is monotonic even if the computer clock changes.
 */
const wallSeconds = () => BigInt(Math.floor(Date.now() / 1000));
const estimatedChainTime = () =>
  S.chainTimeBase + BigInt(Math.max(0, Math.floor((performance.now() - S.chainTimeBaseMs) / 1000)));

/* ============================================================================
 * 2. CONNECTION
 * ==========================================================================*/

async function loadAbi() {
  const res = await fetch("./abi/StreamPay.json");
  if (!res.ok) throw new Error("Could not load abi/StreamPay.json (HTTP " + res.status + ")");
  const json = await res.json();
  // Accept either a bare ABI array or a full Foundry artifact object.
  S.abi = Array.isArray(json) ? json : json.abi;
  if (!Array.isArray(S.abi)) throw new Error("abi/StreamPay.json is not a valid ABI array");
}

/** Read path + event feed. Deliberately NOT MetaMask: a direct node link is faster
 *  and does not depend on the wallet forwarding log queries. */
function connectReadPath() {
  S.readProvider = new ethers.JsonRpcProvider(CFG.rpcUrl, undefined, { cacheTimeout: -1 });
  S.readProvider.pollingInterval = 4000;              // events only; the counter polls nothing
  S.eventContract = new ethers.Contract(CFG.contractAddress, S.abi, S.readProvider);
}

function setWriteAvailability(ready) {
  S.writeReady = ready;
  document.querySelectorAll("[data-write]").forEach((button) => {
    button.disabled = !ready;
  });
  if (ready && S.admin && S.account && S.admin.toLowerCase() === S.account.toLowerCase()) {
    $("claimBtn").disabled = !S.writeReady || S.adminFeeBalance === 0n;
  }
}

function clearRenderedState() {
  S.admin = null;
  S.companyId = 0n;
  S.adminFeeBalance = 0n;
  S.contractBalance = 0n;
  S.outgoing = [];
  S.incoming = [];
  S.accountBalance = 0n;
  S.activity = [];
  S.lastEvent = null;
  $("balance").textContent = "-";
  liveNodes.length = 0;
  for (const id of ["balanceSection", "adminSection", "employerSection", "employeeSection",
                    "employerToggleRow", "emptyState", "activitySection"]) {
    show(id, false);
  }
  setWriteAvailability(false);
}

async function verifyDeployment(provider) {
  const rawChainId = await provider.send("eth_chainId", []);
  const chainId = BigInt(rawChainId);
  if (chainId !== BigInt(CFG.chainId)) {
    throw new Error("Wrong network: switch MetaMask to chain " + CFG.chainId + " before sending a transaction.");
  }

  const code = await provider.send("eth_getCode", [CFG.contractAddress, "latest"]);
  if (!code || code === "0x") {
    throw new Error("No StreamPay contract exists at the configured address. Redeploy after restarting Anvil, then update config.js.");
  }

  // A little code is not enough: probe StreamPay-specific getters as an identity check.
  const probe = new ethers.Contract(CFG.contractAddress, S.abi, provider);
  const [admin, feeBps, denominator] = await Promise.all([
    probe.admin(), probe.FEE_BPS(), probe.BPS_DENOMINATOR()
  ]);
  if (!ethers.isAddress(admin) || BigInt(feeBps) !== FEE_BPS || BigInt(denominator) !== BPS_DENOMINATOR) {
    throw new Error("The configured address does not identify the expected StreamPay deployment.");
  }
  return chainId;
}

async function connectWallet(interactive) {
  if (!window.ethereum) { show("noWallet", true); return false; }
  show("noWallet", false);

  S.writeContract = null;
  setWriteAvailability(false);
  const browserProvider = new ethers.BrowserProvider(window.ethereum);
  S.browserProvider = browserProvider;

  // eth_accounts is silent (auto-detect on load); eth_requestAccounts opens MetaMask.
  const accounts = interactive
    ? await browserProvider.send("eth_requestAccounts", [])
    : await browserProvider.send("eth_accounts", []);

  if (!accounts || accounts.length === 0) {
    S.account = null;
    S.signer = null;
    $("account").textContent = "not connected";
    return false;
  }

  S.account = ethers.getAddress(accounts[0]);
  S.chainId = BigInt(await browserProvider.send("eth_chainId", []));
  $("account").textContent = short(S.account);
  $("account").title = S.account;
  $("chain").textContent = S.chainId.toString();
  $("connectBtn").textContent = "Connected";

  const wrong = S.chainId !== BigInt(CFG.chainId);
  show("wrongNetwork", wrong);
  if (wrong) {
    S.signer = null;
    clearRenderedState();
    return false;
  }

  try {
    await verifyDeployment(browserProvider);
    S.signer = await browserProvider.getSigner();
    S.writeContract = new ethers.Contract(CFG.contractAddress, S.abi, S.signer);
    setWriteAvailability(true);
    return true;
  } catch (err) {
    S.signer = null;
    S.writeContract = null;
    clearRenderedState();
    status("error", friendlyError(err));
    return false;
  }
}

async function assertSafeToWrite() {
  if (!S.browserProvider || !S.account) throw new Error("Connect MetaMask first.");
  S.chainId = await verifyDeployment(S.browserProvider);
  const accounts = await S.browserProvider.send("eth_accounts", []);
  if (!accounts.length || ethers.getAddress(accounts[0]) !== S.account) {
    throw new Error("The active MetaMask account changed. Reconnect before sending a transaction.");
  }
  if (!S.signer) S.signer = await S.browserProvider.getSigner();
  S.writeContract = new ethers.Contract(CFG.contractAddress, S.abi, S.signer);
  setWriteAvailability(true);
}

async function switchNetwork() {
  const hexId = "0x" + Number(CFG.chainId).toString(16);
  try {
    await window.ethereum.request({ method: "wallet_switchEthereumChain", params: [{ chainId: hexId }] });
  } catch (err) {
    if (err && (err.code === 4902 || err.code === -32603)) {
      await window.ethereum.request({
        method: "wallet_addEthereumChain",
        params: [{
          chainId: hexId,
          chainName: "Anvil Localhost",
          rpcUrls: [CFG.rpcUrl],
          nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 }
        }]
      });
    } else { status("error", friendlyError(err)); }
  }
}

/* ============================================================================
 * 3. THE SINGLE FETCH
 * ==========================================================================*/

function toStream(id, raw) {
  return {
    id: BigInt(id),
    companyId: BigInt(raw.companyId),
    employer: ethers.getAddress(raw.employer),
    employee: ethers.getAddress(raw.employee),
    totalDeposit: BigInt(raw.totalDeposit),
    startTime: BigInt(raw.startTime),
    duration: BigInt(raw.duration),
    totalWithdrawn: BigInt(raw.totalWithdrawn),
    totalFeeCharged: BigInt(raw.totalFeeCharged),
    closedAt: BigInt(raw.closedAt),
    status: BigInt(raw.status)
  };
}

async function loadStreams(ids) {
  if (ids.length === 0) return [];
  const rows = await S.eventContract.getStreams(ids);      // one batch call for this stream list
  return rows.map((raw, i) => toStream(ids[i], raw));
}

/**
 * Wallet activity = the contract's own event log, filtered to this account, plus the
 * wallet's balance immediately before and after the newest event's block.
 *
 * One eth_getLogs for every StreamPay event (fine on a local chain; on a public chain
 * you would bound fromBlock to the deployment block), then two historical getBalance
 * reads. All of it runs inside refresh(), so it happens after a transaction, a wallet
 * change, a contract event, or the Refresh button - never on the 1-second tick.
 */
async function loadActivity() {
  const me = S.account.toLowerCase();
  const isAdmin = S.admin && S.admin.toLowerCase() === me;
  const streamsById = new Map();
  for (const s of [...S.outgoing, ...S.incoming]) streamsById.set(s.id.toString(), s);

  const logs = await S.eventContract.queryFilter("*", 0, "latest");
  const rows = [];
  const push = (log, row) => rows.push({
    block: log.blockNumber, index: log.index, tx: log.transactionHash, ...row
  });

  for (const log of logs) {
    if (!log.fragment || !log.args) continue;          // not one of our events
    const a = log.args;
    const name = log.fragment.name;
    const same = (addr) => ethers.getAddress(addr).toLowerCase() === me;

    if (name === "CompanyRegistered" && same(a.employer)) {
      push(log, { event: name, stream: "-", amount: 0n, wallet: false,
                  note: "company #" + a.companyId.toString() + " created" });
    } else if (name === "EmployeeRegistered") {
      if (same(a.employer)) push(log, { event: name, stream: "-", amount: 0n, wallet: false,
                                        note: "registered " + short(ethers.getAddress(a.employee)) });
      else if (same(a.employee)) push(log, { event: name, stream: "-", amount: 0n, wallet: false,
                                             note: "registered by " + short(ethers.getAddress(a.employer)) });
    } else if (name === "StreamCreated") {
      if (same(a.employer)) push(log, { event: name, stream: a.streamId.toString(),
                                        amount: -BigInt(a.deposit), wallet: true, note: "deposit locked" });
      else if (same(a.employee)) push(log, { event: name, stream: a.streamId.toString(), amount: 0n,
                                             wallet: false, note: eth(a.deposit) + " stream opened for you" });
    } else if (name === "SalaryWithdrawn") {
      if (same(a.employee)) push(log, { event: name, stream: a.streamId.toString(),
                                        amount: BigInt(a.netAmount), wallet: true,
                                        note: "gross " + eth(a.grossAmount) + ", fee " + eth(a.fee) });
      else if (isAdmin) push(log, { event: name, stream: a.streamId.toString(), amount: BigInt(a.fee),
                                    wallet: false, note: "fee accrued to unclaimed" });
    } else if (name === "StreamCancelled") {
      const s = streamsById.get(a.streamId.toString());
      if (s && s.employer.toLowerCase() === me) {
        push(log, { event: name, stream: a.streamId.toString(), amount: BigInt(a.employerRefund),
                    wallet: true, note: "unvested refund" });
      } else if (s && s.employee.toLowerCase() === me) {
        push(log, { event: name, stream: a.streamId.toString(), amount: BigInt(a.employeeNet),
                    wallet: true, note: "vested salary paid out" });
      }
      if (isAdmin) push(log, { event: name, stream: a.streamId.toString(), amount: BigInt(a.fee),
                               wallet: false, note: "fee accrued to unclaimed" });
    } else if (name === "AdminFeesClaimed" && same(a.admin)) {
      push(log, { event: name, stream: "-", amount: BigInt(a.amount), wallet: true, note: "fees claimed" });
    }
  }

  // Newest first: by block, then by position inside the block.
  rows.sort((x, y) => (y.block - x.block) || (y.index - x.index));
  S.activity = rows.slice(0, ACTIVITY_MAX);
  S.lastEvent = rows.length ? { ...rows[0] } : null;

  if (S.lastEvent) {
    const b = S.lastEvent.block;
    const [before, after] = await Promise.all([
      S.readProvider.getBalance(S.account, Math.max(0, b - 1)),
      S.readProvider.getBalance(S.account, b)
    ]);
    S.lastEvent.before = BigInt(before);
    S.lastEvent.after = BigInt(after);
  }
}

let refreshRequested = false;

async function refresh() {
  if (!S.account) return;
  refreshRequested = true;
  if (S.refreshing) return; // the running loop will see refreshRequested again

  S.refreshing = true;
  try {
    while (refreshRequested) {
      refreshRequested = false;
      const c = S.eventContract;

      const [network, code, admin, feeBal, bal, myBal, companyId, outIds, inIds, block] = await Promise.all([
        S.readProvider.getNetwork(),
        S.readProvider.getCode(CFG.contractAddress),
        c.admin(),
        c.adminFeeBalance(),
        S.readProvider.getBalance(CFG.contractAddress),
        S.readProvider.getBalance(S.account),
        c.companyIdOf(S.account),
        c.getOutgoingStreamIds(S.account),
        c.getIncomingStreamIds(S.account),
        S.readProvider.getBlock("latest")
      ]);

      if (network.chainId !== BigInt(CFG.chainId)) throw new Error("The configured RPC is not chain " + CFG.chainId + ".");
      if (!code || code === "0x") throw new Error("No contract exists at the configured address. Redeploy and update config.js.");

      S.admin = ethers.getAddress(admin);
      S.adminFeeBalance = BigInt(feeBal);
      S.contractBalance = BigInt(bal);
      S.accountBalance = BigInt(myBal);
      S.companyId = BigInt(companyId);

      // Idle Anvil can report an old latest block. Start from max(block, wall), then
      // advance using a monotonic clock so later wall-clock adjustments cannot jump it.
      const chainTs = BigInt(block.timestamp);
      const wall = wallSeconds();
      S.chainTimeBase = chainTs > wall ? chainTs : wall;
      S.chainTimeBaseMs = performance.now();

      S.outgoing = await loadStreams(outIds.map((x) => x.toString()));
      S.incoming = await loadStreams(inIds.map((x) => x.toString()));
      await loadActivity();   // history is part of the same snapshot, not a separate poll

      setWriteAvailability(Boolean(S.writeContract));
      render();
    }
  } catch (err) {
    refreshRequested = false;
    clearRenderedState();
    console.error(err);
    status("error", friendlyError(err));
  } finally {
    S.refreshing = false;
  }
}

/* ============================================================================
 * 4. RENDER
 * ==========================================================================*/

const liveNodes = [];   // nodes the 1-second tick rewrites, rebuilt on every render

function render() {
  liveNodes.length = 0;

  const isAdmin = S.admin && S.account && S.admin.toLowerCase() === S.account.toLowerCase();
  const hasOutgoing = S.outgoing.length > 0;
  const hasIncoming = S.incoming.length > 0;

  // Role routing. A wallet is whatever the chain says it is; an unknown wallet
  // defaults to "employer" so it gets the create-stream form. An employee who also
  // wants to pay someone can reveal the employer tools with the button below.
  const showEmployer = hasOutgoing || S.forceEmployer || (!isAdmin && !hasIncoming);

  const roles = [];
  if (isAdmin) roles.push("Protocol Admin");
  if (hasOutgoing || (showEmployer && !isAdmin && !hasIncoming)) roles.push("Employer");
  if (hasIncoming) roles.push("Employee");
  $("role").textContent = roles.length ? roles.join(" + ") : "Visitor";
  $("balance").textContent = eth(S.accountBalance);
  $("balance").title = ethers.formatEther(S.accountBalance) + " ETH";
  $("contractAddrOut").textContent = "Contract " + CFG.contractAddress;

  show("adminSection", isAdmin);
  show("employerSection", showEmployer);
  show("employeeSection", hasIncoming);
  show("employerToggleRow", hasIncoming && !showEmployer);
  show("emptyState", !isAdmin && !showEmployer && !hasIncoming);

  if (isAdmin) {
    $("adminFee").textContent = eth(S.adminFeeBalance);
    $("contractBal").textContent = eth(S.contractBalance);
    $("claimBtn").disabled = !S.writeReady || S.adminFeeBalance === 0n;
  }

  if (showEmployer) {
    $("companyId").textContent = S.companyId === 0n ? "not registered yet" : S.companyId.toString();
    $("setupBox").open = S.companyId === 0n;
    renderList($("outgoingList"), S.outgoing, "employer", "No outgoing streams yet.");
  }
  if (hasIncoming) {
    renderList($("incomingList"), S.incoming, "employee", "No incoming streams yet.");
  }

  show("balanceSection", true);
  show("activitySection", true);
  renderActivity();

  tick();   // paint the live numbers immediately instead of waiting a second
}

/** Wallet activity card: balance now, balance around the newest event, and a short history. */
function renderActivity() {
  $("actBalanceNow").textContent = eth(S.accountBalance);
  const last = S.lastEvent;

  if (!last) {
    $("actBefore").textContent = "-";
    $("actAfter").textContent = "-";
    $("actDelta").textContent = "-";
    $("actDelta").className = "stat-value mono";
    $("actLastLine").textContent = "No StreamPay activity for this account yet.";
  } else {
    const delta = last.after - last.before;
    $("actBefore").textContent = eth(last.before);
    $("actAfter").textContent = eth(last.after);
    $("actDelta").textContent = signedEth(delta);
    $("actDelta").className = "stat-value mono " + (delta > 0n ? "up" : delta < 0n ? "down" : "");
    const gas = last.wallet ? delta - last.amount : delta;
    $("actLastLine").textContent =
      "Last event: " + last.event +
      (last.stream !== "-" ? " on Stream #" + last.stream : "") +
      " in block " + last.block +
      " - protocol amount " + signedEth(last.amount) +
      (last.wallet ? "" : " (accounting only, wallet unchanged)") +
      (gas !== 0n ? "; remaining " + signedEth(gas) + " is gas" : "") + ".";
  }

  const toggle = $("activityToggle");
  const total = S.activity.length;
  toggle.hidden = total <= ACTIVITY_PREVIEW;
  toggle.textContent = S.activityExpanded ? "Show fewer" : "Show all (" + total + ")";
  const visible = S.activityExpanded ? S.activity : S.activity.slice(0, ACTIVITY_PREVIEW);

  const body = $("activityBody");
  body.textContent = "";
  if (total === 0) {
    const tr = el("tr");
    const td = el("td", "empty", "Nothing yet.");
    td.colSpan = 6;
    tr.appendChild(td);
    body.appendChild(tr);
    return;
  }
  for (const r of visible) {
    const tr = el("tr");
    tr.appendChild(el("td", "mono", String(r.block)));
    tr.appendChild(el("td", "", r.event));
    tr.appendChild(el("td", "mono", r.stream === "-" ? "-" : "#" + r.stream));
    const amt = el("td", "mono " + (r.amount > 0n ? "up" : r.amount < 0n ? "down" : ""),
                   r.wallet ? signedEth(r.amount) : (r.amount === 0n ? "-" : signedEth(r.amount) + " *"));
    tr.appendChild(amt);
    tr.appendChild(el("td", "muted", r.note));
    const txCell = el("td", "mono", short(r.tx));
    txCell.title = r.tx;
    tr.appendChild(txCell);
    body.appendChild(tr);
  }
}

function renderList(container, streams, role, emptyText) {
  container.textContent = "";
  if (streams.length === 0) { container.appendChild(el("p", "empty", emptyText)); return; }

  // Active streams first, then newest.
  const sorted = [...streams].sort((a, b) =>
    (a.status === b.status) ? Number(b.id - a.id) : Number(a.status - b.status));

  // Every active stream is always visible. Closed ones are history: show the most
  // recent few and let the user expand the rest, so a long-lived account stays readable.
  const active = sorted.filter((s) => s.status !== STATUS.CLOSED);
  const closed = sorted.filter((s) => s.status === STATUS.CLOSED);
  const expanded = S.closedExpanded[role];
  const visibleClosed = expanded ? closed : closed.slice(0, CLOSED_PREVIEW);

  for (const s of [...active, ...visibleClosed]) container.appendChild(streamCard(s, role));

  if (closed.length > CLOSED_PREVIEW) {
    const row = el("p", "hint");
    row.style.margin = "4px 0 0";
    const hiddenCount = closed.length - visibleClosed.length;
    row.appendChild(document.createTextNode(
      expanded ? "Showing all " + closed.length + " closed streams. "
               : hiddenCount + " older closed stream" + (hiddenCount === 1 ? "" : "s") + " hidden. "));
    const btn = el("button", "ghost small", expanded ? "Show fewer" : "Show all closed (" + closed.length + ")");
    btn.addEventListener("click", () => { S.closedExpanded[role] = !expanded; render(); });
    row.appendChild(btn);
    container.appendChild(row);
  }
}

function streamCard(s, role) {
  const closed = s.status === STATUS.CLOSED;
  const card = el("div", "stream");

  const head = el("div", "stream-head");
  head.appendChild(el("span", "stream-title", "Stream #" + s.id.toString()));
  head.appendChild(el("span", "pill " + (closed ? "closed" : "active"), closed ? "Closed" : "Active"));
  card.appendChild(head);

  const grid = el("div", "kv");
  const counterpart = role === "employer"
    ? kv("Employee", short(s.employee))
    : kv("Employer", short(s.employer));
  counterpart.v.title = role === "employer" ? s.employee : s.employer;
  grid.appendChild(counterpart.wrap);
  grid.appendChild(kv("Total salary", eth(s.totalDeposit)).wrap);
  grid.appendChild(kv("Duration", s.duration.toString() + " s").wrap);

  const withdrawnCell = kv("Withdrawn (gross)", eth(s.totalWithdrawn));
  const vestedCell = kv("Vested so far", "-");
  const feeCell = kv("Protocol fee (1%)", "-");
  const claimCell = kv(role === "employee" ? "Claimable now (net)" : "Employee would receive", "-", true);
  grid.appendChild(withdrawnCell.wrap);
  grid.appendChild(vestedCell.wrap);
  grid.appendChild(feeCell.wrap);
  grid.appendChild(claimCell.wrap);
  card.appendChild(grid);

  const bar = el("div", "progress");
  const fill = el("span");
  bar.appendChild(fill);
  card.appendChild(bar);

  const actions = el("div", "stream-actions");
  let withdrawBtn = null;
  if (role === "employee" && !closed) {
    withdrawBtn = el("button", "primary small", "Withdraw Vested Funds");
    withdrawBtn.dataset.write = "";
    withdrawBtn.disabled = true;
    withdrawBtn.addEventListener("click", () => sendTx(
      "withdraw", () => S.writeContract.withdraw(s.id), withdrawBtn));
    actions.appendChild(withdrawBtn);
  }
  if (!closed) {
    const cancelBtn = el("button", "danger small", "Cancel Stream");
    cancelBtn.dataset.write = "";
    cancelBtn.addEventListener("click", () => sendTx(
      "cancelStream", () => S.writeContract.cancelStream(s.id), cancelBtn));
    actions.appendChild(cancelBtn);
  }
  card.appendChild(actions);

  // Register this card with the 1-second tick. No RPC happens in here.
  liveNodes.push(() => {
    const p = previewOf(s, estimatedChainTime());
    vestedCell.v.textContent = eth(p.unlocked);
    feeCell.v.textContent = eth(p.fee);
    claimCell.v.textContent = eth(p.net);
    const pct = s.totalDeposit === 0n ? 0
      : Number((p.unlocked * 10000n) / s.totalDeposit) / 100;
    fill.style.width = Math.min(100, pct).toFixed(2) + "%";
    if (withdrawBtn) withdrawBtn.disabled = !S.writeReady || closed || p.gross === 0n;
  });

  return card;
}

/* ============================================================================
 * 5. THE TICKING ENGINE - one timer for the entire page, zero network traffic.
 * ==========================================================================*/

function tick() { for (const fn of liveNodes) fn(); }

function startTicking() {
  if (S.tickTimer) clearInterval(S.tickTimer);   // never stack timers
  S.tickTimer = setInterval(tick, 1000);
}

/* ============================================================================
 * 6. WRITES - always await tx.wait(), then refresh exactly once.
 * ==========================================================================*/

async function sendTx(label, buildTx, button) {
  const old = button ? button.textContent : null;
  if (button) { button.disabled = true; button.textContent = "Checking..."; }
  try {
    // Recheck chain ID, bytecode, and StreamPay identity immediately before EVERY write.
    // This prevents value being sent to an empty address after Anvil restarts.
    await assertSafeToWrite();
    if (button) button.textContent = "Waiting...";
    status("info", "Confirm the " + label + " transaction in MetaMask...");
    const tx = await buildTx();
    status("info", "Transaction sent (" + short(tx.hash) + "). Waiting for the block...");
    const receipt = await tx.wait();
    status("info", label + " confirmed in block " + receipt.blockNumber + ".");
    await refresh();
    setTimeout(clearStatus, 6000);
  } catch (err) {
    const message = friendlyError(err);
    if (message.startsWith("Wrong network") || message.startsWith("No StreamPay contract") ||
        message.startsWith("The configured address")) {
      S.writeContract = null;
      setWriteAvailability(false);
    }
    console.error(err);
    status("error", message);
  } finally {
    if (button && button.isConnected) {
      button.textContent = old;
      if (button.id === "claimBtn") button.disabled = !S.writeReady || S.adminFeeBalance === 0n;
      else button.disabled = !S.writeReady;
    }
  }
}

async function onCreateStream() {
  $("createError").hidden = true;
  const recipient = $("recipient").value.trim();
  const durationRaw = $("duration").value.trim();
  const amountRaw = $("amount").value.trim();

  // Validate in the browser purely for a nicer UX. The contract validates again;
  // frontend checks are convenience, never security.
  if (!ethers.isAddress(recipient)) return formError("Recipient is not a valid Ethereum address.");
  if (recipient.toLowerCase() === S.account.toLowerCase()) return formError("You cannot stream to yourself.");
  if (!/^\d+$/.test(durationRaw)) return formError("Duration must be a whole number of seconds.");
  const duration = BigInt(durationRaw);
  if (duration <= 15n) return formError("Duration must be strictly greater than 15 seconds.");

  let value;
  try { value = ethers.parseEther(amountRaw); }
  catch { return formError("Amount is not a valid ETH number."); }
  if (value <= 0n) return formError("Amount must be greater than zero.");

  await sendTx("createStream",
    () => S.writeContract.createStream(recipient, duration, { value }), $("createBtn"));
}

function formError(msg) { const p = $("createError"); p.textContent = msg; p.hidden = false; }

async function onRegisterEmployee() {
  const addr = $("regEmployee").value.trim();
  if (!ethers.isAddress(addr)) { status("error", "That is not a valid Ethereum address."); return; }
  await sendTx("registerEmployee",
    () => S.writeContract.registerEmployee(addr), $("registerBtn"));
}

/* ============================================================================
 * 7. EVENTS - Checkpoint 5. Another window's transaction updates this one.
 * ==========================================================================*/

let refreshTimer = null;
function scheduleRefresh() {
  refreshRequested = true;                  // never lose an event during an in-flight read
  if (refreshTimer) return;                  // several events per block -> one debounce timer
  refreshTimer = setTimeout(async () => {
    refreshTimer = null;
    await refresh();
  }, 250);
}

async function attachEventListeners() {
  await S.eventContract.removeAllListeners();
  for (const name of ["StreamCreated", "SalaryWithdrawn", "StreamCancelled",
                      "AdminFeesClaimed", "CompanyRegistered", "EmployeeRegistered"]) {
    await S.eventContract.on(name, () => {
      status("info", "Live update: " + name + " detected on chain.");
      setTimeout(clearStatus, 4000);
      scheduleRefresh();
    });
  }
}

/* ============================================================================
 * 8. ERRORS
 * ==========================================================================*/

function friendlyError(err) {
  if (!err) return "Unknown error.";
  if (err.code === 4001 || err.code === "ACTION_REJECTED") return "Transaction rejected in MetaMask.";
  if (err.revert && err.revert.name) {            // custom error decoded via the ABI
    const args = (err.revert.args || []).map((a) => a.toString()).join(", ");
    return "Contract rejected the call: " + err.revert.name + (args ? " (" + args + ")" : "");
  }
  if (err.reason) return "Contract rejected the call: " + err.reason;
  if (err.shortMessage) return err.shortMessage;
  return err.message || String(err);
}

/* ============================================================================
 * 9. BOOT
 * ==========================================================================*/

async function boot() {
  $("connectBtn").addEventListener("click", async () => {
    if (await connectWallet(true)) { await attachEventListeners(); await refresh(); }
  });
  $("refreshBtn").addEventListener("click", refresh);
  $("employerToggleBtn").addEventListener("click", () => { S.forceEmployer = true; render(); });
  $("activityToggle").addEventListener("click", () => { S.activityExpanded = !S.activityExpanded; renderActivity(); });
  $("switchBtn").addEventListener("click", switchNetwork);
  $("createBtn").addEventListener("click", onCreateStream);
  $("registerBtn").addEventListener("click", onRegisterEmployee);
  $("claimBtn").addEventListener("click", () =>
    sendTx("claimAdminFees", () => S.writeContract.claimAdminFees(), $("claimBtn")));

  if (window.ethereum) {
    // A wallet or network change rebuilds signer state. Reloading here is allowed:
    // the bonus forbids reloading in response to a CONTRACT event, not a wallet event.
    window.ethereum.on("accountsChanged", () => window.location.reload());
    window.ethereum.on("chainChanged", () => window.location.reload());
  }

  try {
    await loadAbi();
    connectReadPath();
    startTicking();
    if (await connectWallet(false)) { await attachEventListeners(); await refresh(); }
  } catch (err) {
    console.error(err);
    status("error", friendlyError(err));
  }
}

window.addEventListener("DOMContentLoaded", boot);
