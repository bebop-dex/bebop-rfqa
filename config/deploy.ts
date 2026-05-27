/**
 * Per-chain deployment configuration for BebopRouter + PoolsBasedOracle.
 *
 * Keyed by EVM chainId. The deploy script reads the config matching the connected network's
 * chainId. Any field can be overridden at deploy time via env vars (see scripts/deploy.ts).
 *
 * Never commit private keys here — use env vars (DEPLOYER_PRIVATE_KEY) for signing.
 */

export interface ChainDeployConfig {
  /** Human-readable chain name, used for logging */
  name: string;
  /** Address that receives protocol fees + positive slippage */
  protocolTreasury: string;
  /** Address whose EIP-712 signature authorizes router orders */
  routerSigner: string;
  /** BebopSettlement (PMM) contract address */
  bebopPmm: string;
  /** Permit2 contract (same address on every EVM chain) */
  permit2: string;
  /** Wrapped native token (WETH/WMATIC/...) used for auto-wrap/unwrap */
  wrappedNativeToken: string;
}

// Permit2 is canonical and deployed at the same address on every supported EVM chain
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

// Bebop PMM lives at the same address across supported chains
const BEBOP_PMM = "0xbbbbbBB520d69a9775E85b458C58c648259FAD5F";

export const DEPLOY_CONFIGS: Record<number, ChainDeployConfig> = {
  // ======== Ethereum Mainnet ========
  1: {
    name: "mainnet",
    protocolTreasury: "0x76E8d5c2FCb95dcD8e72e86022be76EaB02C2160", // TODO: set before mainnet deploy
    routerSigner:     "0x00677F201E2f4A30D1D5b4e0ebbF672CaF336727", // TODO: set before mainnet deploy
    bebopPmm: BEBOP_PMM,
    permit2: PERMIT2,
    wrappedNativeToken: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
  },

  // ======== Polygon PoS ========
  137: {
    name: "polygon",
    protocolTreasury: "0x76E8d5c2FCb95dcD8e72e86022be76EaB02C2160",
    routerSigner:     "0x00677F201E2f4A30D1D5b4e0ebbF672CaF336727",
    bebopPmm: BEBOP_PMM,
    permit2: PERMIT2,
    wrappedNativeToken: "0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270", // WMATIC
  },

  
  // ======== Local Hardhat network (fork of mainnet) ========
  // Hardhat exposes chainId=31337 by default even when forking a different chain.
  31337: {
    name: "hardhat",
    protocolTreasury: "0x1111111111111111111111111111111111111111", // placeholder
    routerSigner:     "0x2222222222222222222222222222222222222222", // placeholder
    bebopPmm: BEBOP_PMM,
    permit2: PERMIT2,
    wrappedNativeToken: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  },
};

/**
 * Look up config by chainId. Throws with a helpful message if chain is unsupported.
 */
export function getDeployConfig(chainId: number): ChainDeployConfig {
  const cfg = DEPLOY_CONFIGS[chainId];
  if (!cfg) {
    const supported = Object.keys(DEPLOY_CONFIGS).map(Number).sort((a, b) => a - b);
    throw new Error(
      `No deploy config for chainId=${chainId}. ` +
      `Supported: [${supported.join(", ")}]. ` +
      `Add it to config/deploy.ts or override via env vars.`
    );
  }
  return cfg;
}
