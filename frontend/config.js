/**
 * Public configuration only. NEVER put a private key, seed phrase or API key here -
 * everything in this file is downloaded by the browser and visible to anyone.
 *
 * contractAddress must be updated every time you redeploy (and Anvil forgets
 * everything when it restarts, so a restart always means redeploy + update this).
 */
window.STREAMPAY_CONFIG = {
  chainId: 31337,
  rpcUrl: "http://127.0.0.1:8545",
  contractAddress: "0x5FbDB2315678afecb367f032d93F642f64180aa3"
};
