/**
 * Deploy PoolsBasedOracle only (stateless, no constructor args).
 *
 * Usage:
 *   npm run deploy:oracle:<network>      (e.g. deploy:oracle:mainnet)
 *   npm run deploy:oracle                 (default: hardhat local)
 */
import { ethers } from "hardhat";
import { resolveChainArgs, printHeader } from "./_shared";

async function main() {
  const { chainId, cfg } = await resolveChainArgs();
  await printHeader(cfg, chainId);
  console.log();

  console.log("Deploying PoolsBasedOracle...");
  const factory = await ethers.getContractFactory("PoolsBasedOracle");
  const deployed = await factory.deploy();
  await deployed.waitForDeployment();
  const address = await deployed.getAddress();
  console.log(`  PoolsBasedOracle:      ${address}`);

  console.log();
  console.log("=== Summary ===");
  console.log(JSON.stringify({
    chain: cfg.name,
    chainId,
    contract: "PoolsBasedOracle",
    address,
  }, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
