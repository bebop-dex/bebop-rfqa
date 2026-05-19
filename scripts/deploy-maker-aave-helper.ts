/**
 * Deploy MakerAaveHelperHook — shared maker-side hook contract that any maker can use.
 *
 * The hook itself holds no tokens. Each maker that wants to use it must:
 *   1. Approve this contract to spend their `underlying` (e.g. USDC).
 *   2. Sign hooks targeting this contract with
 *        `data = abi.encode(underlying, aToken, aavePool)`
 *      and `useBebopHook = true`.
 *
 * Usage:
 *   ROUTER=0x<deployed BebopRouter> npm run deploy:maker-aave -- --network <network>
 */
import { ethers } from "hardhat";
import { resolveChainArgs, printHeader, assertAddress, requireEnv } from "./_shared";

async function main() {
  const { chainId, cfg } = await resolveChainArgs();
  const router = requireEnv("ROUTER");
  assertAddress("ROUTER", router);

  await printHeader(cfg, chainId);
  console.log(`Router:             ${router}`);
  console.log();

  console.log("Deploying MakerAaveHelperHook...");
  const factory = await ethers.getContractFactory("MakerAaveHelperHook");
  const deployed = await factory.deploy(router);
  await deployed.waitForDeployment();
  const address = await deployed.getAddress();
  console.log(`  MakerAaveHelperHook: ${address}`);

  console.log();
  console.log("=== Summary ===");
  console.log(JSON.stringify({
    chain: cfg.name,
    chainId,
    contract: "MakerAaveHelperHook",
    address,
    constructor: { router },
  }, null, 2));

  console.log();
  console.log("Per-maker usage:");
  console.log(`  1. Maker calls underlying.approve(${address}, type(uint256).max)`);
  console.log(`  2. Maker signs hooks targeting ${address} with`);
  console.log(`     data = abi.encode(underlying, aToken, aavePool) and useBebopHook=true`);
}

main().catch((e) => { console.error(e); process.exit(1); });
