/**
 * Verify an already-deployed BebopRouter on Etherscan.
 *
 * Usage:
 *   ADDRESS=0x... npm run verify:router:<network>     (e.g. verify:router:mainnet)
 *
 * Constructor args are read from config/deploy.ts (keyed by chainId). Must match the
 * values used at deploy time. Override with the same env vars as deploy-router.ts
 * if the deployment used overrides.
 *
 * Requires ETHERSCAN_API_KEY set in the environment.
 */
import { run } from "hardhat";
import { resolveChainArgs, printHeader, printRouterArgs, assertRouterArgs, requireEnv } from "./_shared";

async function main() {
  const address = requireEnv("ADDRESS");
  requireEnv("ETHERSCAN_API_KEY");

  const { chainId, cfg, router } = await resolveChainArgs();
  assertRouterArgs(router);
  await printHeader(cfg, chainId);
  console.log(`Verifying BebopRouter at ${address}`);
  printRouterArgs(router);
  console.log();

  try {
    await run("verify:verify", {
      address,
      constructorArguments: [
        router.protocolTreasury,
        router.routerSigner,
        router.bebopPmm,
        router.permit2,
        router.wrappedNativeToken,
      ],
    });
    console.log(`  ✓ verified on Etherscan`);
  } catch (e: any) {
    if (e.message?.includes("Already Verified")) {
      console.log(`  already verified`);
    } else {
      throw e;
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
