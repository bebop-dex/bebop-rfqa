/**
 * Deploy BebopRouter only.
 *
 * Usage:
 *   npm run deploy:router:<network>      (e.g. deploy:router:mainnet, deploy:router:arbitrum)
 *   npm run deploy:router                 (default: hardhat local)
 *
 * Args are read from config/deploy.ts (keyed by chainId). Override any field with an env var:
 *   PROTOCOL_TREASURY, ROUTER_SIGNER, BEBOP_PMM, PERMIT2, WRAPPED_NATIVE_TOKEN
 */
import { ethers } from "hardhat";
import { resolveChainArgs, printHeader, printRouterArgs, assertRouterArgs } from "./_shared";

async function main() {
  const { chainId, cfg, router } = await resolveChainArgs();
  assertRouterArgs(router);
  await printHeader(cfg, chainId);
  printRouterArgs(router);
  console.log();

  console.log("Deploying BebopRouter...");
  const factory = await ethers.getContractFactory("BebopRouter");
  const deployed = await factory.deploy(
    router.protocolTreasury,
    router.routerSigner,
    router.bebopPmm,
    router.permit2,
    router.wrappedNativeToken,
  );
  await deployed.waitForDeployment();
  const address = await deployed.getAddress();
  console.log(`  BebopRouter:      ${address}`);

  console.log();
  console.log("=== Summary ===");
  console.log(JSON.stringify({
    chain: cfg.name,
    chainId,
    contract: "BebopRouter",
    address,
    constructor: router,
  }, null, 2));

  console.log();
  console.log(`Verify with: ADDRESS=${address} npm run verify:router:${cfg.name}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
