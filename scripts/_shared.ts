/**
 * Shared helpers for deploy and verify scripts.
 */
import { ethers } from "hardhat";
import { getDeployConfig, ChainDeployConfig } from "../config/deploy";

/** Resolved constructor args for BebopRouter — config values overridden by env vars. */
export interface RouterArgs {
  protocolTreasury: string;
  routerSigner: string;
  bebopPmm: string;
  permit2: string;
  wrappedNativeToken: string;
}

/** Read config for the connected chainId and apply env var overrides. */
export async function resolveChainArgs(): Promise<{ chainId: number; cfg: ChainDeployConfig; router: RouterArgs }> {
  const net = await ethers.provider.getNetwork();
  const chainId = Number(net.chainId);
  const cfg = getDeployConfig(chainId);

  const router: RouterArgs = {
    protocolTreasury: process.env.PROTOCOL_TREASURY ?? cfg.protocolTreasury,
    routerSigner: process.env.ROUTER_SIGNER ?? cfg.routerSigner,
    bebopPmm: process.env.BEBOP_PMM ?? cfg.bebopPmm,
    permit2: process.env.PERMIT2 ?? cfg.permit2,
    wrappedNativeToken: process.env.WRAPPED_NATIVE_TOKEN ?? cfg.wrappedNativeToken,
  };

  return { chainId, cfg, router };
}

/** Throw if address is malformed or zero — prevents deploys with forgotten placeholder values. */
export function assertAddress(label: string, addr: string) {
  if (!ethers.isAddress(addr) || addr === ethers.ZeroAddress) {
    throw new Error(`${label} is not set (got "${addr}"). Edit config/deploy.ts or pass via env var.`);
  }
}

/** Require an env var to be set, returning its value. */
export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

/** Print a standard header: chain name, chainId, deployer address, balance. */
export async function printHeader(cfg: ChainDeployConfig, chainId: number) {
  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Chain:              ${cfg.name} (chainId=${chainId})`);
  console.log(`Deployer:           ${deployer.address}`);
  console.log(`Balance:            ${ethers.formatEther(balance)} ETH`);
}

/** Log the resolved BebopRouter constructor args. */
export function printRouterArgs(args: RouterArgs) {
  console.log(`Protocol Treasury:  ${args.protocolTreasury}`);
  console.log(`Router Signer:      ${args.routerSigner}`);
  console.log(`Bebop PMM:          ${args.bebopPmm}`);
  console.log(`Permit2:            ${args.permit2}`);
  console.log(`Wrapped Native:     ${args.wrappedNativeToken}`);
}

/** Validate all router args are real addresses (catches zero placeholders early). */
export function assertRouterArgs(args: RouterArgs) {
  assertAddress("protocolTreasury", args.protocolTreasury);
  assertAddress("routerSigner", args.routerSigner);
  assertAddress("bebopPmm", args.bebopPmm);
  assertAddress("permit2", args.permit2);
  assertAddress("wrappedNativeToken", args.wrappedNativeToken);
}
