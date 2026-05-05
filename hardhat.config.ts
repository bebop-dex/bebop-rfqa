import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";

// Load .env so DEPLOYER_PRIVATE_KEY, *_RPC_URL, ETHERSCAN_API_KEY etc. are available
// in process.env when Hardhat builds the network/plugin config below.
dotenv.config();

const MAINNET_RPC  = process.env.MAINNET_RPC_URL  ?? "";
const SEPOLIA_RPC  = process.env.SEPOLIA_RPC_URL  ?? "";
const ARBITRUM_RPC = process.env.ARBITRUM_RPC_URL ?? "https://arb1.arbitrum.io/rpc";
const OPTIMISM_RPC = process.env.OPTIMISM_RPC_URL ?? "https://mainnet.optimism.io";
const POLYGON_RPC  = process.env.POLYGON_RPC_URL  ?? "https://1rpc.io/matic";
const BASE_RPC     = process.env.BASE_RPC_URL     ?? "https://mainnet.base.org";
const DEPLOYER_KEY = process.env.DEPLOYER_PRIVATE_KEY;
const accounts = DEPLOYER_KEY ? [DEPLOYER_KEY] : [];

// Optional explicit gas-price overrides (in wei). Useful when an RPC enforces a
// per-tx fee cap (e.g. public Polygon RPCs reject txs whose fee exceeds 1 MATIC).
// Setting a manual gasPrice keeps total fee = gasPrice × gasLimit under the cap.
// Example: POLYGON_GAS_PRICE=50000000000  (50 gwei)
function gasPrice(envName: string): number | "auto" {
  const v = process.env[envName];
  return v ? Number(v) : "auto";
}

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.27",
    settings: {
      evmVersion: "cancun",
      viaIR: true,
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  networks: {
    hardhat: {
      forking: {
        url: MAINNET_RPC,
        blockNumber: 22100000,
      },
      initialBaseFeePerGas: 0,
    },
    mainnet:  { url: MAINNET_RPC,  accounts, gasPrice: gasPrice("MAINNET_GAS_PRICE") },
    sepolia:  { url: SEPOLIA_RPC,  accounts, gasPrice: gasPrice("SEPOLIA_GAS_PRICE") },
    arbitrum: { url: ARBITRUM_RPC, accounts, gasPrice: gasPrice("ARBITRUM_GAS_PRICE") },
    optimism: { url: OPTIMISM_RPC, accounts, gasPrice: gasPrice("OPTIMISM_GAS_PRICE") },
    polygon:  { url: POLYGON_RPC,  accounts, gasPrice: gasPrice("POLYGON_GAS_PRICE") },
    base:     { url: BASE_RPC,     accounts, gasPrice: gasPrice("BASE_GAS_PRICE") },
  },
  gasReporter: {
    // Enabled when REPORT_GAS=true is set (or via `npm run test:gas`)
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
    // coinmarketcap API key optional; without it ETH/USD prices are skipped
    coinmarketcap: process.env.COINMARKETCAP_API_KEY,
    showMethodSig: false,
    excludeContracts: ["MockAToken", "MockRateToken", "MockMintableToken", "MockMakerMintHook", "MockAaveSupplyHook", "MockAaveWithdrawHook", "MockChecker", "MockOracle"],
  },
  etherscan: {
    apiKey: process.env.ETHERSCAN_API_KEY,
  },
};

export default config;
