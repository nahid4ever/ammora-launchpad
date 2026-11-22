import { useCallback, useEffect, useMemo, useState } from "react";
import { createPublicClient, createWalletClient, custom, defineChain, getAbiItem, http, numberToHex, formatEther, type Address, type Hex } from "viem";
import {
  AmmoraDataApiClient,
  AmmoraDataApiError,
  buildCreateALCSegmentedV3LaunchWithTokenConfig,
  giwaSepoliaVNext,
  giwaSepoliaMerged,
  giwaSepoliaAudited,
  giwaSepoliaSealed,
  giwaSepoliaVaults,
  giwaSepoliaPermissionless,
  segmentedALCLaunchFactoryV3Abi,
  type AmmoraLaunchSummary,
} from "@ammora-protocol/sdk";

const CHAIN_ID = 91_342;
const DATA_API = "https://ammora-giwa-sepolia-data.fly.dev";
const giwa = defineChain({
  id: CHAIN_ID,
  name: "GIWA Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://sepolia-rpc.giwa.io"] } },
  blockExplorers: { default: { name: "GIWA Explorer", url: "https://sepolia-explorer.giwa.io" } },
});
const explorer = "https://sepolia-explorer.giwa.io";
const publicClient = createPublicClient({ chain: giwa, transport: http() });
const dataApi = new AmmoraDataApiClient(DATA_API);
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const eth = (window as unknown as { ethereum?: any }).ethereum;


type ChainLaunch = { token: Address; curve: Address; creator: Address; configId: string; block: string; metadataUri: string };
const FACTORIES = [giwaSepoliaVNext, giwaSepoliaMerged, giwaSepoliaAudited, giwaSepoliaSealed, giwaSepoliaVaults, giwaSepoliaPermissionless]
  .map((d) => ({ address: d.contracts.launch.factory as Address, start: d.startBlock }));
type ScanResult = { launches: ChainLaunch[]; scannedFrom: bigint; latest: bigint; requests: number; lastError: string };
async function scanChainLaunches(): Promise<ScanResult> {
  const event = getAbiItem({ abi: segmentedALCLaunchFactoryV3Abi, name: "LaunchCreated" });
  const first = FACTORIES.reduce((m, f) => (f.start < m ? f.start : m), FACTORIES[0].start);
  const addresses = FACTORIES.map((f) => f.address);
  const latest = await publicClient.getBlockNumber();
  let to = latest, step = 100_000n, requests = 0, lastError = "";
  const out: ChainLaunch[] = [];
  while (to >= first && out.length < 24 && requests < 120) {
    const from = to - step + 1n > first ? to - step + 1n : first;
    requests++;
    try {
      const logs = await publicClient.getLogs({ address: addresses, event, fromBlock: from, toBlock: to });
      for (const l of logs as any[]) out.push({ token: l.args.token, curve: l.args.curve, creator: l.args.creator,
        configId: String(l.args.configId), block: String(l.blockNumber), metadataUri: String(l.args.metadataURI) });
      to = from - 1n;
    } catch (e) {
      lastError = ((e as Error).message || "").split("\n")[0].slice(0, 160);
      if (step > 1_000n) step = step / 2n; else break;
    }
  }
  out.sort((x, y) => Number(BigInt(y.block) - BigInt(x.block)));
  return { launches: out, scannedFrom: to + 1n, latest, requests, lastError };
}

export default function App() {
  const [tab, setTab] = useState<"explore" | "create">("explore");
  const [account, setAccount] = useState<Address | null>(null);
  const [chainOk, setChainOk] = useState(false);
  const [walletMsg, setWalletMsg] = useState("");
  const [configs, setConfigs] = useState<string[]>([]);

  const refreshChain = useCallback(async () => {
    if (!eth) return;
    setChainOk(Number(await eth.request({ method: "eth_chainId" })) === CHAIN_ID);
  }, []);

  async function connect() {
    if (!eth) return setWalletMsg("No EVM wallet found. Install MetaMask or Rabby (use a separate testnet account).");
    try {
      const [a] = (await eth.request({ method: "eth_requestAccounts" })) as Address[];
      setAccount(a);
      try {
        await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: numberToHex(CHAIN_ID) }] });
      } catch {
        await eth.request({
          method: "wallet_addEthereumChain",
          params: [{ chainId: numberToHex(CHAIN_ID), chainName: "GIWA Sepolia", nativeCurrency: giwa.nativeCurrency,
            rpcUrls: giwa.rpcUrls.default.http, blockExplorerUrls: [explorer] }],
        });
      }
      await refreshChain();
      setWalletMsg("");
    } catch (e) { setWalletMsg((e as Error).message); }
  }
  useEffect(() => {
    refreshChain();
    eth?.on?.("chainChanged", refreshChain);
    eth?.on?.("accountsChanged", (a: Address[]) => setAccount(a[0] ?? null));
  }, [refreshChain]);

  return (
    <div className="wrap">
      <header>
        <div className="brand">Ammora<span>·</span>LaunchPad</div>
        <button className="primary" onClick={connect}>
          {account ? `${short(account)} ${chainOk ? "· GIWA Sepolia" : "· wrong network"}` : "Connect wallet"}
        </button>
      </header>
      {walletMsg && <div className="msg err">{walletMsg}</div>}
      <h1>Token launches on GIWA Sepolia</h1>
      <p className="lead">A small launchpad built on the Ammora SDK. Browse launches indexed by the Ammora Data API, or prepare, simulate and send a launch transaction. Testnet only.</p>
      <nav>
        <button className={tab === "explore" ? "on" : ""} onClick={() => setTab("explore")}>Explore</button>
        <button className={tab === "create" ? "on" : ""} onClick={() => setTab("create")}>Create launch</button>
      </nav>
      {tab === "explore" ? <Explore onConfigs={setConfigs} /> : <Create account={account} chainOk={chainOk} configs={configs} />}
      <footer>Ammora SDK 0.3.9 is beta testnet software; no mainnet deployment or independent audit has been announced. Never use a main wallet here.</footer>
    </div>
  );
}

function Explore({ onConfigs }: { onConfigs: (c: string[]) => void }) {
  const [items, setItems] = useState<AmmoraLaunchSummary[] | null>(null);
  const [chain, setChain] = useState<ChainLaunch[] | null>(null);
  const [scanInfo, setScanInfo] = useState("");
  const [scanning, setScanning] = useState(false);
  const [err, setErr] = useState("");
  const [q, setQ] = useState("");
  const [block, setBlock] = useState<string | null>(null);
  const [rpcErr, setRpcErr] = useState(false);

  const scan = useCallback(async () => {
    setScanning(true);
    try {
      const r = await scanChainLaunches();
      setChain(r.launches); onConfigs([...new Set(r.launches.map((x) => x.configId))]);
      setScanInfo(`Scanned blocks ${r.scannedFrom}–${r.latest} in ${r.requests} requests across ${FACTORIES.length} launch factories.${r.lastError ? " Last RPC error: " + r.lastError : ""}`);
    } catch (e) { setChain([]); setScanInfo(`Scan failed: ${(e as Error).message.slice(0, 160)}`); }
    finally { setScanning(false); }
  }, [onConfigs]);

  const load = useCallback(async () => {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 20_000);
    try {
      const page = await dataApi.getLaunches({ chainId: BigInt(CHAIN_ID), signal: ctl.signal });
      setItems(page.items); setErr("");
    } catch (e) {
      setItems(null);
      if (e instanceof AmmoraDataApiError) setErr(`Ammora's launch index answered with HTTP ${e.status} (temporarily unavailable on their side).`);
      else if (ctl.signal.aborted) setErr("Ammora's launch index did not respond within 20 seconds.");
      else setErr((e as Error).message || "Could not reach the Ammora Data API.");
    } finally { clearTimeout(timer); }
  }, []);
  useEffect(() => { load(); const t = setInterval(() => load(), 30_000); return () => clearInterval(t); }, [load]);
  useEffect(() => { if (err && chain === null && !scanning) scan(); }, [err, chain, scanning, scan]);
  useEffect(() => {
    const tick = () => publicClient.getBlockNumber().then((b) => { setBlock(b.toString()); setRpcErr(false); }).catch(() => setRpcErr(true));
    tick(); const t = setInterval(tick, 10_000); return () => clearInterval(t);
  }, []);

  const needle = q.toLowerCase();
  const shown = useMemo(() => (items ?? []).filter((l) =>
    `${l.address} ${l.creatorAddress} ${l.status} ${l.metadataUri}`.toLowerCase().includes(needle)), [items, needle]);
  const shownChain = useMemo(() => (chain ?? []).filter((l) =>
    `${l.token} ${l.creator} ${l.metadataUri}`.toLowerCase().includes(needle)), [chain, needle]);
  const count = (s: string) => (items ?? []).filter((l) => l.status === s).length;
  const usingChain = !items && chain && chain.length > 0;

  return (
    <>
      <div className="stats">
        <div className="stat"><b>{items ? items.length : chain ? chain.length : "…"}</b><small>{items ? "launches loaded" : "launches found on-chain"}</small></div>
        <div className="stat"><b>{items ? count("ACTIVE") : "–"}</b><small>active</small></div>
        <div className="stat"><b>{items ? count("MIGRATED") : "–"}</b><small>graduated</small></div>
      </div>
      <div className="mono" style={{ marginBottom: 12 }}>
        GIWA Sepolia RPC: {rpcErr ? "unreachable" : block ? `connected · latest block ${block}` : "connecting…"} · Launch index: {items ? "online" : err ? "offline" : "loading…"}
      </div>
      <input placeholder="Search by token, creator or metadata" value={q} onChange={(e) => setQ(e.target.value)} />
      {err && !items && (
        <div className="msg warn">{err} {scanning ? "Reading launches directly from the GIWA chain…" : usingChain ? "Showing launches read directly from the GIWA chain instead (newest first)." : ""} <button onClick={() => { load(); }}>Retry index</button></div>
      )}
      {!items && !err && !scanning && chain === null && <p className="mono">Loading launches from the Data API…</p>}
      {!items && scanInfo && <p className="mono">{scanInfo}</p>}
      <div className="grid">
        {shown.map((l) => (
          <div className="card" key={l.id}>
            <h3><span className={`tag ${l.status}`}>{l.status}</span></h3>
            <div className="mono">Token <a href={`${explorer}/address/${l.address}`} target="_blank" rel="noreferrer">{short(l.address)}</a></div>
            <div className="mono">Curve <a href={`${explorer}/address/${l.curveAddress}`} target="_blank" rel="noreferrer">{short(l.curveAddress)}</a></div>
            <div className="mono">Creator {short(l.creatorAddress)} · block {l.createdBlock}</div>
            <div className="mono" style={{ marginTop: 6 }}>{l.metadataUri.slice(0, 70)}</div>
          </div>
        ))}
        {!items && shownChain.map((l) => (
          <div className="card" key={l.curve}>
            <h3><span className="tag">ON-CHAIN</span></h3>
            <div className="mono">Token <a href={`${explorer}/address/${l.token}`} target="_blank" rel="noreferrer">{short(l.token)}</a></div>
            <div className="mono">Curve <a href={`${explorer}/address/${l.curve}`} target="_blank" rel="noreferrer">{short(l.curve)}</a></div>
            <div className="mono">Creator {short(l.creator)} · block {l.block} · config {l.configId}</div>
            <div className="mono" style={{ marginTop: 6 }}>{l.metadataUri.slice(0, 70)}</div>
          </div>
        ))}
      </div>
      {!items && chain && chain.length === 0 && !scanning && <p className="lead">No launches found on-chain in the scanned range yet.</p>}
    </>
  );
}

function Create({ account, chainOk, configs }: { account: Address | null; chainOk: boolean; configs: string[] }) {
  const [f, setF] = useState({
    name: "", symbol: "", description: "", image: "", metadataUri: "",
    factory: giwaSepoliaVNext.contracts.launch.factory as string,
    configId: "", decimals: "9", fee: "0",
  });
  const [sim, setSim] = useState<"idle" | "ok" | "fail">("idle");
  const [msg, setMsg] = useState<{ kind: string; text: string } | null>(null);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => { setF({ ...f, [k]: e.target.value }); setSim("idle"); };

  function makeMetadata() {
    const json = JSON.stringify({ name: f.name, symbol: f.symbol, description: f.description, image: f.image });
    setF({ ...f, metadataUri: `data:application/json;base64,${btoa(unescape(encodeURIComponent(json)))}` }); setSim("idle");
  }

  const plan = useMemo(() => {
    try {
      if (!f.name || !f.symbol || !f.metadataUri || f.configId === "") return { error: "Fill name, symbol, metadata URI and config ID to preview." };
      const tx = buildCreateALCSegmentedV3LaunchWithTokenConfig(f.name, f.symbol, f.metadataUri, "", BigInt(f.configId), Number(f.decimals), BigInt(f.fee || "0"));
      return { tx };
    } catch (e) { return { error: (e as Error).message }; }
  }, [f]);

  async function simulate() {
    if (!plan.tx || !account) return;
    try {
      await publicClient.call({ account, to: f.factory as Address, data: plan.tx.data, value: plan.tx.value });
      setSim("ok"); setMsg({ kind: "ok", text: "Simulation succeeded on GIWA Sepolia (no transaction sent)." });
    } catch (e) { setSim("fail"); setMsg({ kind: "err", text: `Simulation reverted: ${(e as Error).message.slice(0, 300)}` }); }
  }
  async function send() {
    if (!plan.tx || !account || !eth) return;
    try {
      const wallet = createWalletClient({ chain: giwa, transport: custom(eth) });
      const hash: Hex = await wallet.sendTransaction({ account, to: f.factory as Address, data: plan.tx.data, value: plan.tx.value });
      setMsg({ kind: "ok", text: `Submitted: ${hash}` });
    } catch (e) { setMsg({ kind: "err", text: (e as Error).message.slice(0, 300) }); }
  }

  return (
    <div className="card">
      <div className="form">
        <div><label>Token name</label><input value={f.name} onChange={set("name")} placeholder="My Token" /></div>
        <div><label>Symbol</label><input value={f.symbol} onChange={set("symbol")} placeholder="MTK" /></div>
        <div className="full"><label>Description</label><textarea rows={2} value={f.description} onChange={set("description")} /></div>
        <div className="full"><label>Image URL (https or ipfs)</label><input value={f.image} onChange={set("image")} /></div>
        <div className="full"><label>Metadata URI</label><input value={f.metadataUri} onChange={set("metadataUri")} placeholder="ipfs://… (or generate a testnet data: URI)" />
          <button style={{ marginTop: 8 }} onClick={makeMetadata}>Generate data: URI from the fields above</button></div>
        <div><label>Config ID (from an enabled launch config)</label><input value={f.configId} onChange={set("configId")} inputMode="numeric" />
          {configs.length > 0 && <div className="mono" style={{ marginTop: 6 }}>Seen on-chain: {configs.map((c) => <button key={c} style={{ padding: "2px 8px", marginRight: 6 }} onClick={() => { setF({ ...f, configId: c }); setSim("idle"); }}>{c}</button>)}</div>}</div>
        <div><label>Token decimals</label><input value={f.decimals} onChange={set("decimals")} inputMode="numeric" /></div>
        <div><label>Pool creation fee (wei, from the config)</label><input value={f.fee} onChange={set("fee")} inputMode="numeric" /></div>
        <div><label>Launch factory (verify against the reviewed manifest)</label><input value={f.factory} onChange={set("factory")} /></div>
      </div>
      <h3 style={{ marginTop: 20 }}>Launch preview</h3>
      {plan.tx ? (
        <div className="mono">To {f.factory}<br />Value {formatEther(plan.tx.value)} ETH<br />Calldata {plan.tx.data.slice(0, 74)}… ({(plan.tx.data.length - 2) / 2} bytes, built by the Ammora SDK)</div>
      ) : <div className="mono">{plan.error}</div>}
      <div style={{ display: "flex", gap: 10, marginTop: 16, flexWrap: "wrap" }}>
        <button onClick={simulate} disabled={!plan.tx || !account || !chainOk}>1. Simulate</button>
        <button className="primary" onClick={send} disabled={sim !== "ok" || !chainOk}>2. Send launch transaction</button>
      </div>
      {!account && <div className="msg warn">Connect a testnet wallet to simulate or send.</div>}
      {msg && <div className={`msg ${msg.kind}`}>{msg.text}</div>}
    </div>
  );
}
