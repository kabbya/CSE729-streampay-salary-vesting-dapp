import { chromium } from "playwright";
import { ethers } from "ethers";
import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "../frontend");
const CONFIG_TEXT = fs.readFileSync(path.join(ROOT, "config.js"), "utf8");
const CONTRACT = CONFIG_TEXT.match(/contractAddress:\s*["'](0x[0-9a-fA-F]{40})["']/)?.[1];
if (!CONTRACT) throw new Error("Set contractAddress in frontend/config.js before running the UI test.");
const MIME = { ".html":"text/html", ".js":"text/javascript", ".css":"text/css", ".json":"application/json" };
const server = http.createServer((req,res)=>{
  const p = path.join(ROOT, decodeURIComponent(req.url.split("?")[0]));
  const f = fs.existsSync(p) && fs.statSync(p).isDirectory() ? path.join(p,"index.html") : p;
  if(!fs.existsSync(f)){res.writeHead(404);return res.end("nf");}
  res.writeHead(200,{ "Content-Type": MIME[path.extname(f)]||"application/octet-stream" });
  res.end(fs.readFileSync(f));
});
await new Promise(r=>server.listen(5500,r));

const EMPLOYER="0x70997970C51812dc3A010C7d01b50e0d17dc79C8";
const EMPLOYEE="0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC";
const ADMIN="0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

// Minimal EIP-1193 shim: forwards everything to Anvil. Anvil unlocks its dev
// accounts, so eth_sendTransaction works exactly like a MetaMask confirmation.
const shim = (account, options = {}) => `
window.ethereum = {
  isMetaMask: true,
  _acct: "${account}",
  _sendCount: 0,
  on(){}, removeListener(){},
  async request({method, params}) {
    if (method === "eth_accounts" || method === "eth_requestAccounts") return [this._acct];
    if (method === "eth_chainId" && ${Boolean(options.wrongChain)}) return "0x1";
    if (method === "net_version" && ${Boolean(options.wrongChain)}) return "1";
    if (method === "eth_getCode" && ${Boolean(options.noCode)}) return "0x";
    if (method === "eth_sendTransaction") { this._sendCount++; params[0].from = this._acct; }
    const r = await fetch("http://127.0.0.1:8545", {
      method: "POST", headers: {"Content-Type":"application/json"},
      body: JSON.stringify({ jsonrpc:"2.0", id: Date.now(), method, params: params||[] })
    });
    const j = await r.json();
    if (j.error) { const e = new Error(j.error.message); e.code = j.error.code; e.data = j.error.data; throw e; }
    return j.result;
  }
};`;

const browser = await chromium.launch();
const results = [];
const ok = (name, cond, extra="") => { results.push([cond?"PASS":"FAIL", name, extra]); };
const abi = JSON.parse(fs.readFileSync(path.join(ROOT, "abi/StreamPay.json"), "utf8"));
const rpc = new ethers.JsonRpcProvider("http://127.0.0.1:8545", undefined, { cacheTimeout: -1 });
const employerContract = new ethers.Contract(CONTRACT, abi, await rpc.getSigner(EMPLOYER));
const employeeContract = employerContract.connect(await rpc.getSigner(EMPLOYEE));

async function pageFor(account, options = {}, captureConsoleErrors = true) {
  const ctx = await browser.newContext({ viewport:{width:1280,height:900} });
  await ctx.addInitScript(shim(account, options));
  const pg = await ctx.newPage();
  pg.on("pageerror", e => results.push(["FAIL","pageerror: "+e.message,""]));
  pg.on("console", m => { if (captureConsoleErrors && m.type()==="error") results.push(["FAIL","console.error: "+m.text(),""]); });
  await pg.goto("http://127.0.0.1:5500/index.html", { waitUntil:"networkidle" });
  await pg.waitForTimeout(1200);
  return { ctx, pg };
}

/* ---------- 0. SAFETY: never build/send a write on the wrong deployment ---------- */
let { ctx: cw, pg: wrong } = await pageFor(EMPLOYER, { wrongChain: true }, false);
ok("wrong-network banner is visible", await wrong.isVisible("#wrongNetwork"));
await wrong.evaluate(async () => {
  window.__buildCalled = false;
  await sendTx("safety probe", async () => { window.__buildCalled = true; }, null);
});
ok("wrong-network safety check blocks transaction construction", !(await wrong.evaluate(() => window.__buildCalled)));
ok("wrong-network safety check sends zero transactions", (await wrong.evaluate(() => window.ethereum._sendCount)) === 0);
await cw.close();

let { ctx: cn, pg: noCode } = await pageFor(EMPLOYER, { noCode: true }, false);
ok("missing deployment is reported", (await noCode.textContent("#txStatus")).includes("No StreamPay contract"));
await noCode.evaluate(async () => {
  window.__buildCalled = false;
  await sendTx("safety probe", async () => { window.__buildCalled = true; }, null);
});
ok("no-code safety check blocks transaction construction", !(await noCode.evaluate(() => window.__buildCalled)));
ok("no-code safety check sends zero transactions", (await noCode.evaluate(() => window.ethereum._sendCount)) === 0);
await cn.close();

/* ---------- 1. EMPLOYER: create a stream ---------- */
let { ctx: c1, pg: employer } = await pageFor(EMPLOYER);
ok("employer page: chain shows 31337", (await employer.textContent("#chain")) === "31337");
ok("employer page: no wrong-network banner", await employer.isHidden("#wrongNetwork"));
ok("employer page: employer section visible", await employer.isVisible("#employerSection"));
ok("employer page: admin section hidden", await employer.isHidden("#adminSection"));

await employer.evaluate(() => { document.getElementById("setupBox").open = true; });
await employer.fill("#regEmployee", EMPLOYEE);
await employer.click("#registerBtn");
await employer.waitForFunction(() => document.getElementById("companyId").textContent !== "not registered yet", null, {timeout:20000});
ok("registerEmployee confirmed, companyId rendered", /^\d+$/.test((await employer.textContent("#companyId")).trim()));

await employer.fill("#recipient", EMPLOYEE);
await employer.fill("#duration", "120");
await employer.fill("#amount", "1");
await employer.click("#createBtn");
await employer.waitForFunction(() => document.querySelectorAll("#outgoingList .stream").length > 0, null, {timeout:25000});
ok("createStream confirmed and outgoing card rendered", (await employer.locator("#outgoingList .stream").count()) >= 1);

/* ---------- 2. validation ---------- */
await employer.fill("#recipient", "0xnotanaddress");
await employer.click("#createBtn");
await employer.waitForTimeout(300);
ok("invalid address blocked client-side", await employer.isVisible("#createError"));
await employer.fill("#recipient", EMPLOYEE);
await employer.fill("#duration", "15");
await employer.click("#createBtn");
await employer.waitForTimeout(300);
ok("duration 15 blocked client-side",
   (await employer.textContent("#createError")).includes("strictly greater than 15"));

/* ---------- 3. EMPLOYEE: ticking counter, single fetch ---------- */
let { ctx: c2, pg: employee } = await pageFor(EMPLOYEE);
ok("employee page: employee section visible", await employee.isVisible("#employeeSection"));

/* An event that arrives while refresh() is waiting must request another snapshot. */
let delayedBlockRead = false;
let releaseBlockRead;
const blockGate = new Promise((resolve) => { releaseBlockRead = resolve; });
await employee.route("http://127.0.0.1:8545/", async (route) => {
  const body = route.request().postData() || "";
  if (!delayedBlockRead && body.includes('"method":"eth_getBlockByNumber"')) {
    // Fetch the old snapshot first, then hold its completed response. This creates
    // the precise race without disabling Ethers' normal request batching.
    const oldSnapshot = await route.fetch();
    delayedBlockRead = true;
    await blockGate;
    await route.fulfill({ response: oldSnapshot });
    return;
  }
  await route.continue();
});
const streamsBeforeRace = await employee.locator("#incomingList .stream").count();
await employee.click("#refreshBtn");
for (let i = 0; i < 40 && !delayedBlockRead; i++) await employee.waitForTimeout(50);
ok("race harness paused an in-flight refresh", delayedBlockRead);
await employee.waitForTimeout(300); // other snapshot calls now reflect the old stream list
await (await employerContract.createStream(EMPLOYEE, 120, { value: ethers.parseEther("0.01") })).wait();
await employee.evaluate(() => scheduleRefresh()); // exactly what the event callback does
releaseBlockRead();
await employee.waitForFunction(
  (before) => document.querySelectorAll("#incomingList .stream").length > before,
  streamsBeforeRace,
  { timeout: 20000 }
);
ok("event during refresh is retained and triggers a second snapshot", true);
await employee.unroute("http://127.0.0.1:8545/");

// Let the deliberately raced event finish its normal polling cycle, then count only
// state-snapshot methods. Event-filter polling itself is allowed by the bonus.
await employee.waitForTimeout(4500);
let stateRpcCalls = 0;
employee.on("request", (request) => {
  if (!request.url().includes("8545") || request.method() !== "POST") return;
  try {
    const body = JSON.parse(request.postData() || "null");
    const calls = Array.isArray(body) ? body : [body];
    stateRpcCalls += calls.filter((call) => call && ["eth_call", "eth_getBalance"].includes(call.method)).length;
  } catch { /* a malformed diagnostic request is irrelevant to this counter */ }
});
const readClaim = async () => (await employee.locator("#incomingList .stream .v.big").first().textContent()).trim();
const v1 = await readClaim();
await employee.waitForTimeout(6000);
const v2 = await readClaim();
ok("claimable counter ticks up locally", parseFloat(v2) > parseFloat(v1), `${v1} -> ${v2}`);
ok("local ticking makes zero state RPC calls in 6s", stateRpcCalls === 0, `${stateRpcCalls} state RPC calls`);

/* ---------- 4. withdraw ---------- */
const beforeWithdrawn = await employee.locator("#incomingList .stream .v.mono").nth(3).textContent();
await employee.click("#incomingList .stream button.primary");
await employee.waitForTimeout(6000);
const afterWithdrawn = await employee.locator("#incomingList .stream .v.mono").nth(3).textContent();
ok("withdraw updated the gross-withdrawn figure", beforeWithdrawn !== afterWithdrawn, `${beforeWithdrawn} -> ${afterWithdrawn}`);

/* ---------- 5. BONUS: employer cancels, employee window reacts with no reload ---------- */
let reloaded = false;
employee.on("framenavigated", () => { reloaded = true; });
await employer.waitForFunction(
  () => document.querySelectorAll("#outgoingList .stream").length >= 2,
  null,
  { timeout: 20000 }
);
await employer.click("#outgoingList .stream button.danger");
await employee.waitForFunction(
  () => [...document.querySelectorAll("#incomingList .stream .pill")].some((pill) => pill.textContent === "Closed"),
  null, { timeout: 30000 }
);
ok("BONUS: employee window shows Closed after employer cancelled", true);
ok("BONUS: employee window never reloaded", !reloaded);
const closedCard = employee.locator("#incomingList .stream").filter({ hasText: "Closed" }).first();
const readClosedClaim = async () => (await closedCard.locator(".v.big").textContent()).trim();
const c1v = await readClosedClaim(); await employee.waitForTimeout(3000); const c2v = await readClosedClaim();
ok("BONUS: employee counter stopped ticking", c1v === c2v, `${c1v} == ${c2v}`);

/* ---------- 6. ADMIN ---------- */
let { ctx: c3, pg: admin } = await pageFor(ADMIN);
ok("admin page: admin section visible", await admin.isVisible("#adminSection"));
ok("admin page: fee balance > 0", parseFloat(await admin.textContent("#adminFee")) > 0, await admin.textContent("#adminFee"));
await admin.click("#claimBtn");
await admin.waitForFunction(() => document.getElementById("adminFee").textContent.startsWith("0 "), null, {timeout:25000});
ok("claimAdminFees zeroed the balance", true);

/* ---------- 7. MICRO-ROUNDING: gross=1, fee=1, net=0 is still withdrawable ---------- */

const tinyId = await employerContract.nextStreamId();
await (await employerContract.createStream(EMPLOYEE, 100, { value: 100n })).wait();
const tiny = await employerContract.getStream(tinyId);
await rpc.send("evm_setNextBlockTimestamp", [Number(tiny.startTime + 99n)]);
await (await employeeContract.withdraw(tinyId)).wait();
await rpc.send("evm_setNextBlockTimestamp", [Number(tiny.startTime + 100n)]);
await rpc.send("evm_mine", []);
await employee.click("#refreshBtn");
await employee.waitForTimeout(1200);
const tinyCard = employee.locator("#incomingList .stream").filter({ hasText: "Stream #" + tinyId.toString() });
const tinyButton = tinyCard.locator("button.primary");
ok("final gross wei remains withdraw-enabled when displayed net is zero", !(await tinyButton.isDisabled()));
await tinyButton.click();
await employee.waitForFunction(
  (id) => [...document.querySelectorAll("#incomingList .stream")].some((card) =>
    card.querySelector(".stream-title")?.textContent === "Stream #" + id &&
    card.querySelector(".pill")?.textContent === "Closed"),
  tinyId.toString(),
  { timeout: 30000 }
);
ok("final gross wei settles and closes the stream", true);

await employer.screenshot({ path:path.resolve(HERE, "../docs/screenshots/ui-employer.png"), fullPage:true });
await employee.screenshot({ path:path.resolve(HERE, "../docs/screenshots/ui-employee.png"), fullPage:true });
await admin.screenshot({ path:path.resolve(HERE, "../docs/screenshots/ui-admin.png"), fullPage:true });

await browser.close(); server.close();
let fails = 0;
for (const [st,name,extra] of results) { if(st==="FAIL") fails++; console.log(`${st}  ${name}${extra?"  ["+extra+"]":""}`); }
console.log(`\n${results.length-fails}/${results.length} UI checks passed`);
process.exit(fails?1:0);
