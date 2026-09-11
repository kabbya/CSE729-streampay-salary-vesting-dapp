import { ethers } from "ethers";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.resolve(HERE, "../frontend");
const RPC = "http://127.0.0.1:8545";
const ABI = JSON.parse(fs.readFileSync(path.join(FRONTEND, "abi/StreamPay.json"), "utf8"));
const CONFIG_TEXT = fs.readFileSync(path.join(FRONTEND, "config.js"), "utf8");
const CONFIGURED_ADDRESS = CONFIG_TEXT.match(/contractAddress:\s*["'](0x[0-9a-fA-F]{40})["']/)?.[1];

const p = new ethers.JsonRpcProvider(RPC, undefined, { cacheTimeout: -1 });
const K1 = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d";
const K2 = "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a";
const A2 = "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const CONTRACT = process.argv[2] || CONFIGURED_ADDRESS;
if (!CONTRACT) throw new Error("Pass a deployed address or set frontend/config.js.");

const employer = new ethers.Wallet(K1, p);
const employee = new ethers.Wallet(K2, p);
const cEmployer = new ethers.Contract(CONTRACT, ABI, employer);
const cEmployee = new ethers.Contract(CONTRACT, ABI, employee);
const cRead = new ethers.Contract(CONTRACT, ABI, p);

/* ---- the EXACT functions copied out of frontend/app.js ---- */
const FEE_BPS = 100n, BPS_DENOMINATOR = 10_000n, CLOSED = 2n;
function unlockedOf(s, nowTs) {
  const effective = s.status === CLOSED ? s.closedAt : nowTs;
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
const norm = (r) => ({
  companyId: BigInt(r.companyId), employer: r.employer, employee: r.employee,
  totalDeposit: BigInt(r.totalDeposit), startTime: BigInt(r.startTime), duration: BigInt(r.duration),
  totalWithdrawn: BigInt(r.totalWithdrawn), totalFeeCharged: BigInt(r.totalFeeCharged),
  closedAt: BigInt(r.closedAt), status: BigInt(r.status)
});

async function warp(sec) {
  await p.send("evm_increaseTime", [sec]);
  await p.send("evm_mine", []);
}

let checks = 0, mismatches = 0;
let randomState = 0x446729;
const random = () => ((randomState = (1664525 * randomState + 1013904223) >>> 0) / 2 ** 32);
const rng = (n) => Math.floor(random() * n);

for (let trial = 0; trial < 6; trial++) {
  const deposit = ethers.parseEther((0.01 + random() * 3).toFixed(18));
  const duration = BigInt(17 + rng(4000));
  await (await cEmployer.registerEmployee(A2).catch(() => ({ wait: async () => {} }))).wait?.();
  const tx = await cEmployer.createStream(A2, duration, { value: deposit });
  const rc = await tx.wait();
  const id = (await cRead.totalStreams());

  for (let step = 0; step < 8; step++) {
    await warp(1 + rng(Number(duration) / 3 | 0 || 1));
    const s = norm(await cRead.getStream(id));
    if (s.status !== 1n) break;

    const blk = await p.getBlock("latest");
    const nowTs = BigInt(blk.timestamp);

    const [gOn, fOn, nOn] = await cRead.previewWithdraw(id);
    const js = previewOf(s, nowTs);
    checks++;
    if (BigInt(gOn) !== js.gross || BigInt(fOn) !== js.fee || BigInt(nOn) !== js.net) {
      mismatches++;
      console.log("MISMATCH", { id: id.toString(), onchain: [gOn, fOn, nOn].map(String), js: [js.gross, js.fee, js.net].map(String) });
    }
    if (js.net > 0n && random() < 0.5) { await (await cEmployee.withdraw(id)).wait(); }
  }
  // cancel and re-check the frozen value
  const st = norm(await cRead.getStream(id));
  if (st.status === 1n) {
    await (await cEmployer.cancelStream(id)).wait();
    const after = norm(await cRead.getStream(id));
    await warp(100000);
    const onFrozen = await cRead.getUnlockedAmount(id);
    const jsFrozen = unlockedOf(after, BigInt((await p.getBlock("latest")).timestamp));
    checks++;
    if (BigInt(onFrozen) !== jsFrozen) { mismatches++; console.log("FROZEN MISMATCH", String(onFrozen), String(jsFrozen)); }
  }
}
console.log(`\ndifferential check: ${checks} comparisons, ${mismatches} mismatches`);
process.exit(mismatches === 0 ? 0 : 1);
