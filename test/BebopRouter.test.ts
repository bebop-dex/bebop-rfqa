import { expect } from "chai";
import { ethers } from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { BebopRouter, MockChecker, MockOracle, MockAToken, MockRateToken, MockMintableToken, MockAaveWithdrawHook, MockAaveSupplyHook, MockMakerMintHook } from "../typechain-types";
import { swapTestConfigs, SwapTestConfig, WETH, USDC, NATIVE_TOKEN, pctToUnits, e6, e18 } from "./test-configs";

// ==================== Constants ====================
const BEBOP_PMM = "0xbbbbbBB520d69a9775E85b458C58c648259FAD5F";
const PERMIT2 = "0x000000000022D473030F116dDEE9F6B43aC78BA3";

const PMM_DOMAIN_NAME = "BebopSettlement";
const PMM_DOMAIN_VERSION = "2";
const ROUTER_DOMAIN_NAME = "BebopRouter";
const ROUTER_DOMAIN_VERSION = "1";

const TOKEN_SLOTS: Record<string, bigint> = {
  [USDC.toLowerCase()]: 9n,
  ["0x6B175474E89094C44Da98b954EedeAC495271d0F".toLowerCase()]: 2n, // DAI
};

// ==================== PMM Types ====================

interface PmmSingleOrder {
  expiry: bigint; taker_address: string; maker_address: string; maker_nonce: bigint;
  taker_token: string; maker_token: string; taker_amount: bigint; maker_amount: bigint;
  receiver: string; packed_commands: bigint; flags: bigint;
}

interface PmmAggregateOrder {
  expiry: bigint; taker_address: string;
  maker_addresses: string[]; maker_nonces: bigint[];
  taker_tokens: string[][]; maker_tokens: string[][]; taker_amounts: bigint[][]; maker_amounts: bigint[][];
  receiver: string; commands: string; flags: bigint;
}

interface RouterOrder {
  fromAmount: bigint; toAmount: bigint; limitAmount: bigint;
  fromToken: string; toToken: string; pmmFromToken: string; pmmToToken: string;
  tokensOwner: string; receiver: string; originAddress: string;
  oracle: string; checker: string; info: bigint; routerNonce: bigint; unsignedFlags: bigint;
}

// ==================== Helpers ====================

function packInfo(expiry: bigint, protocolShareSlippage = 0n, protocolShareFee = 0n, minPositiveSlippageToTreasury = 0n): bigint {
  return (minPositiveSlippageToTreasury << 128n) | (expiry << 64n) | (protocolShareSlippage << 32n) | protocolShareFee;
}
function encodeExtraInfo(feeUnits: bigint, slippageUnits: bigint): string {
  return ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256"], [feeUnits, slippageUnits]);
}

async function signRouterOrder(signer: SignerWithAddress, verifyingContract: string, chainId: bigint, order: RouterOrder, extraInfo: string, hooksHash: string): Promise<string> {
  return signer.signTypedData(
    { name: ROUTER_DOMAIN_NAME, version: ROUTER_DOMAIN_VERSION, chainId, verifyingContract },
    { BebopRouterOrder: [
      { name: "fromAmount", type: "uint256" }, { name: "toAmount", type: "uint256" },
      { name: "limitAmount", type: "int256" }, { name: "fromToken", type: "address" },
      { name: "toToken", type: "address" }, { name: "pmmFromToken", type: "address" },
      { name: "pmmToToken", type: "address" }, { name: "tokensOwner", type: "address" },
      { name: "receiver", type: "address" }, { name: "originAddress", type: "address" },
      { name: "oracle", type: "address" }, { name: "checker", type: "address" },
      { name: "info", type: "uint256" }, { name: "routerNonce", type: "uint256" },
      { name: "extraInfoHash", type: "bytes32" }, { name: "hooksHash", type: "bytes32" },
    ]},
    { ...order, extraInfoHash: ethers.keccak256(extraInfo), hooksHash }
  );
}

async function signPmmSingleOrder(signer: SignerWithAddress, pmmAddress: string, chainId: bigint, order: PmmSingleOrder, partnerId: bigint): Promise<string> {
  return signer.signTypedData(
    { name: PMM_DOMAIN_NAME, version: PMM_DOMAIN_VERSION, chainId, verifyingContract: pmmAddress },
    { SingleOrder: [
      { name: "partner_id", type: "uint64" }, { name: "expiry", type: "uint256" },
      { name: "taker_address", type: "address" }, { name: "maker_address", type: "address" },
      { name: "maker_nonce", type: "uint256" }, { name: "taker_token", type: "address" },
      { name: "maker_token", type: "address" }, { name: "taker_amount", type: "uint256" },
      { name: "maker_amount", type: "uint256" }, { name: "receiver", type: "address" },
      { name: "packed_commands", type: "uint256" },
    ]},
    { partner_id: partnerId, ...order }
  );
}

function encodePmmSwapSingle(order: PmmSingleOrder, makerSig: string, filledTakerAmount: bigint): string {
  const iface = new ethers.Interface([
    "function swapSingle(tuple(uint256,address,address,uint256,address,address,uint256,uint256,address,uint256,uint256) order, tuple(bytes,uint256) makerSignature, uint256 filledTakerAmount)"
  ]);
  return iface.encodeFunctionData("swapSingle", [
    [order.expiry, order.taker_address, order.maker_address, order.maker_nonce, order.taker_token, order.maker_token, order.taker_amount, order.maker_amount, order.receiver, order.packed_commands, order.flags],
    [makerSig, 0n], filledTakerAmount
  ]);
}

function encodePmmSwapAggregate(order: PmmAggregateOrder, makerSigs: string[], filledTakerAmount: bigint): string {
  const iface = new ethers.Interface([
    "function swapAggregate(tuple(uint256,address,address[],uint256[],address[][],address[][],uint256[][],uint256[][],address,bytes,uint256) order, tuple(bytes,uint256)[] makersSignatures, uint256 filledTakerAmount)"
  ]);
  return iface.encodeFunctionData("swapAggregate", [
    [order.expiry, order.taker_address, order.maker_addresses, order.maker_nonces, order.taker_tokens, order.maker_tokens, order.taker_amounts, order.maker_amounts, order.receiver, order.commands, order.flags],
    makerSigs.map(sig => [sig, 0n]), filledTakerAmount
  ]);
}

// Sign a MultiOrder (maker's portion of aggregate) using standard EIP-712 signTypedData.
// PMM hashMultiOrder uses keccak256(abi.encodePacked(array)) for arrays,
// which is exactly what EIP-712 signTypedData does for dynamic types.
const PMM_MULTI_ORDER_TYPES = {
  MultiOrder: [
    { name: "partner_id", type: "uint64" },
    { name: "expiry", type: "uint256" },
    { name: "taker_address", type: "address" },
    { name: "maker_address", type: "address" },
    { name: "maker_nonce", type: "uint256" },
    { name: "taker_tokens", type: "address[]" },
    { name: "maker_tokens", type: "address[]" },
    { name: "taker_amounts", type: "uint256[]" },
    { name: "maker_amounts", type: "uint256[]" },
    { name: "receiver", type: "address" },
    { name: "commands", type: "bytes" },
  ],
};

/// Extract the command slice for a given maker index from the full aggregate commands hex.
/// Per maker i: maker_tokens[i].length commands + taker_tokens[i].length commands.
function getMakerCommandSlice(
  cfg: { taker_tokens: string[][]; maker_tokens: string[][] },
  makerIdx: number,
  fullCommandsHex: string,
): string {
  const commandsBytes = fullCommandsHex.slice(2); // strip 0x
  let offset = 0;
  for (let i = 0; i < makerIdx; i++) {
    offset += (cfg.maker_tokens[i].length + cfg.taker_tokens[i].length) * 2; // 2 hex chars per byte
  }
  const numBytes = cfg.maker_tokens[makerIdx].length + cfg.taker_tokens[makerIdx].length;
  return "0x" + commandsBytes.slice(offset, offset + numBytes * 2);
}

async function signPmmMultiOrder(
  signer: SignerWithAddress,
  pmmAddress: string,
  chainId: bigint,
  order: PmmAggregateOrder,
  makerIdx: number,
  makerCommands: string,
  partnerId: bigint = 0n,
): Promise<string> {
  return signer.signTypedData(
    { name: PMM_DOMAIN_NAME, version: PMM_DOMAIN_VERSION, chainId, verifyingContract: pmmAddress },
    PMM_MULTI_ORDER_TYPES,
    {
      partner_id: partnerId,
      expiry: order.expiry,
      taker_address: order.taker_address,
      maker_address: order.maker_addresses[makerIdx],
      maker_nonce: order.maker_nonces[makerIdx],
      taker_tokens: order.taker_tokens[makerIdx],
      maker_tokens: order.maker_tokens[makerIdx],
      taker_amounts: order.taker_amounts[makerIdx],
      maker_amounts: order.maker_amounts[makerIdx],
      receiver: order.receiver,
      commands: makerCommands,
    }
  );
}

async function fundWeth(signer: SignerWithAddress, to: string, amount: bigint) {
  const iface = new ethers.Interface(["function deposit() payable", "function transfer(address,uint256) returns (bool)"]);
  await signer.sendTransaction({ to: WETH, value: amount, data: iface.encodeFunctionData("deposit") });
  if (to.toLowerCase() !== signer.address.toLowerCase()) {
    const weth = await ethers.getContractAt("IERC20", WETH);
    await weth.connect(signer).transfer(to, amount);
  }
}

async function fundToken(token: string, to: string, amount: bigint) {
  if (token.toLowerCase() === WETH.toLowerCase()) throw new Error("Use fundWeth for WETH");
  const slot = TOKEN_SLOTS[token.toLowerCase()];
  if (slot === undefined) throw new Error(`No storage slot for ${token}`);
  const balanceSlot = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "uint256"], [to, slot]));
  await ethers.provider.send("hardhat_setStorageAt", [token, balanceSlot, ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [amount])]);
}

// ==================== Test Suite ====================

describe("BebopRouter", function () {
  this.timeout(120000);

  let router: BebopRouter;
  let checker: MockChecker;
  let oracle: MockOracle;
  let hookAddresses: Record<string, string>;
  let mockAUSDC: MockAToken;
  let mockRateUSDC: MockRateToken;
  let mockRateWETH: MockRateToken;
  let mockTSLA: MockMintableToken;
  let mockAWETH: MockAToken;
  let owner: SignerWithAddress, routerSigner: SignerWithAddress, user: SignerWithAddress;
  let makers: SignerWithAddress[];
  let treasury: SignerWithAddress, receiver: SignerWithAddress;
  let chainId: bigint, routerAddr: string, checkerAddr: string, oracleAddr: string;
  let nonceCounter = 100n;

  // Map placeholder names → addresses (populated after signers are available)
  let addressMap: Record<string, string>;

  function resolveAddress(who: string): string {
    const addr = addressMap[who];
    if (!addr) throw new Error(`Unknown address placeholder: "${who}"`);
    return addr;
  }

  before(async function () {
    const signers = await ethers.getSigners();
    [owner, routerSigner, user, treasury, receiver] = signers;
    makers = signers.slice(5, 10);
    chainId = (await ethers.provider.getNetwork()).chainId;

    router = await (await ethers.getContractFactory("BebopRouter")).deploy(treasury.address, routerSigner.address, BEBOP_PMM, PERMIT2, WETH);
    await router.waitForDeployment();
    routerAddr = await router.getAddress();

    checker = await (await ethers.getContractFactory("MockChecker")).deploy();
    await checker.waitForDeployment();
    checkerAddr = await checker.getAddress();

    oracle = await (await ethers.getContractFactory("MockOracle")).deploy();
    await oracle.waitForDeployment();
    oracleAddr = await oracle.getAddress();


    // Deploy mock aTokens (1:1 with underlying, deterministic)
    const MockATokenFactory = await ethers.getContractFactory("MockAToken");
    mockAUSDC = await MockATokenFactory.deploy("Mock aUSDC", "maUSDC", 6, USDC);
    await mockAUSDC.waitForDeployment();
    mockAWETH = await MockATokenFactory.deploy("Mock aWETH", "maWETH", 18, WETH);
    await mockAWETH.waitForDeployment();

    // Deploy mock rate tokens (non-1:1 rates)
    const MockRateTokenFactory = await ethers.getContractFactory("MockRateToken");
    // 1 share = 1.25 USDC (rate=1.25e18). 800 shares = 1000 USDC.
    mockRateUSDC = await MockRateTokenFactory.deploy("Rate USDC Vault", "rvUSDC", 6, USDC, ethers.parseEther("1.25"));
    await mockRateUSDC.waitForDeployment();
    // 1 share = 0.8 WETH (rate=0.8e18). 0.5 shares = 0.4 WETH.
    mockRateWETH = await MockRateTokenFactory.deploy("Rate WETH Vault", "rvWETH", 18, WETH, ethers.parseEther("0.8"));
    await mockRateWETH.waitForDeployment();

    // Deploy mock hooks (same hooks work for both MockAToken and MockRateToken — same interface)
    const withdrawHook = await (await ethers.getContractFactory("MockAaveWithdrawHook")).deploy();
    await withdrawHook.waitForDeployment();
    const supplyHook = await (await ethers.getContractFactory("MockAaveSupplyHook")).deploy();
    await supplyHook.waitForDeployment();

    const makerMintHook = await (await ethers.getContractFactory("MockMakerMintHook")).deploy();
    await makerMintHook.waitForDeployment();

    // Deploy mock TSLA token (mintable)
    mockTSLA = await (await ethers.getContractFactory("MockMintableToken")).deploy("Mock TSLA", "mTSLA", 18);
    await mockTSLA.waitForDeployment();

    hookAddresses = {
      "mock-aave-withdraw": await withdrawHook.getAddress(),
      "mock-aave-supply": await supplyHook.getAddress(),
      "mock-maker-mint": await makerMintHook.getAddress(),
    };

    // Store mock token addresses for placeholder resolution in configs
    const mockAUSDCAddr = await mockAUSDC.getAddress();
    const mockAWETHAddr = await mockAWETH.getAddress();
    const mockRateUSDCAddr = await mockRateUSDC.getAddress();
    const mockRateWETHAddr = await mockRateWETH.getAddress();
    const mockTSLAAddr = await mockTSLA.getAddress();

    addressMap = {
      user: user.address,
      receiver: receiver.address,
      treasury: treasury.address,
      ...Object.fromEntries(makers.map((m, i) => [`maker${i}`, m.address])),
    };

    // Replace MOCK_AUSDC/MOCK_AWETH placeholders in all test configs with actual deployed addresses
    for (const cfg of swapTestConfigs) {
      const replaceToken = (t: string) => {
        if (t === "MOCK_AUSDC") return mockAUSDCAddr;
        if (t === "MOCK_AWETH") return mockAWETHAddr;
        if (t === "MOCK_RATE_USDC") return mockRateUSDCAddr;
        if (t === "MOCK_RATE_WETH") return mockRateWETHAddr;
        if (t === "MOCK_TSLA") return mockTSLAAddr;
        return t;
      };
      cfg.routerInputToken = replaceToken(cfg.routerInputToken);
      cfg.routerOutputToken = replaceToken(cfg.routerOutputToken);
      if (cfg.pmmFromToken) cfg.pmmFromToken = replaceToken(cfg.pmmFromToken);
      if (cfg.pmmToToken) cfg.pmmToToken = replaceToken(cfg.pmmToToken);
      cfg.taker_tokens = cfg.taker_tokens.map(arr => arr.map(replaceToken));
      cfg.maker_tokens = cfg.maker_tokens.map(arr => arr.map(replaceToken));
      if (cfg.hooks) {
        for (const h of cfg.hooks) {
          h.tokens = h.tokens.map(replaceToken);
          if (h.mintTo) h.mintTo = h.mintTo; // mintTo is a placeholder resolved by resolveAddress at runtime
        }
      }
      for (const bc of cfg.expectedBalanceChanges) {
        bc.token = replaceToken(bc.token);
      }
      cfg.expectedRouterSwapEvent.fromToken = replaceToken(cfg.expectedRouterSwapEvent.fromToken);
      cfg.expectedRouterSwapEvent.toToken = replaceToken(cfg.expectedRouterSwapEvent.toToken);
      for (const pe of cfg.expectedPmmSwapEvents) {
        pe.takerToken = replaceToken(pe.takerToken);
        pe.makerToken = replaceToken(pe.makerToken);
      }
    }
  });

  // ==================== Config-driven test runner ====================


  async function runSwapTest(cfg: SwapTestConfig) {
    const pmmFromToken = cfg.pmmFromToken ?? cfg.routerInputToken;
    const pmmToToken = cfg.pmmToToken ?? cfg.routerOutputToken;
    const expiry = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const routerNonce = nonceCounter++;

    const numMakers = cfg.taker_tokens.length;

    // --- Fund user ---
    const isNativeInput = cfg.routerInputToken.toLowerCase() === NATIVE_TOKEN.toLowerCase();
    const userFundAmount = cfg.isExactInput ? cfg.exactAmount : cfg.routerInputTokenAmount * 2n;
    if (!isNativeInput) {
      const lcInput = cfg.routerInputToken.toLowerCase();
      const mockTokenAddrs = [
        await mockAUSDC.getAddress(), await mockAWETH.getAddress(),
        await mockRateUSDC.getAddress(), await mockRateWETH.getAddress(),
      ];
      const mockTokenAddr = mockTokenAddrs.find(a => a.toLowerCase() === lcInput);

      if (mockTokenAddr) {
        // Fund with mock wrapped token: get underlying, deposit to get shares
        // Both MockAToken and MockRateToken have: underlying(), deposit(amount, to)
        // For MockAToken (1:1): deposit X underlying → X shares, so fund X underlying
        // For MockRateToken: deposit X underlying → X * RATE_BASE / rate shares
        //   We want `userFundAmount` shares. Need to deposit `userFundAmount * rate / RATE_BASE` underlying.
        const mock = new ethers.Contract(mockTokenAddr, [
          "function underlying() view returns (address)",
          "function deposit(uint256 amount, address to) external",
          "function rate() view returns (uint256)",
        ], ethers.provider);
        const underlying = await mock.underlying();
        let underlyingNeeded = userFundAmount;
        try {
          const rate = await mock.rate(); // MockRateToken has rate(), MockAToken doesn't
          underlyingNeeded = userFundAmount * rate / ethers.parseEther("1");
        } catch { /* MockAToken — no rate(), 1:1 */ }

        if (underlying.toLowerCase() === WETH.toLowerCase()) {
          await fundWeth(user, user.address, underlyingNeeded);
        } else {
          await fundToken(underlying, user.address, underlyingNeeded);
        }
        const underlyingToken = await ethers.getContractAt("IERC20", underlying);
        await underlyingToken.connect(user).approve(mockTokenAddr, underlyingNeeded);
        await (new ethers.Contract(mockTokenAddr, ["function deposit(uint256,address)"], user)).deposit(underlyingNeeded, user.address);
      } else if (lcInput === WETH.toLowerCase()) {
        await fundWeth(user, user.address, userFundAmount);
      } else {
        await fundToken(cfg.routerInputToken, user.address, userFundAmount);
      }
      const inputToken = await ethers.getContractAt("IERC20", cfg.routerInputToken);
      await inputToken.connect(user).approve(routerAddr, userFundAmount);
    }
    // For native input, user already has ETH (hardhat default 10000 ETH)

    // --- Build PMM order + fund makers ---
    const pmmMakerNonces: bigint[] = [];
    let pmmCalldata: string;

    if (cfg.orderType === "single") {
      const makerNonce = nonceCounter++;
      pmmMakerNonces.push(makerNonce);
      // Fund maker (skip tokens provided by mint hooks)
      const hookMintedTokens = new Set((cfg.hooks ?? []).filter(h => h.hookType === "mock-maker-mint").flatMap(h => h.tokens.map(t => t.toLowerCase())));
      for (let j = 0; j < cfg.maker_tokens[0].length; j++) {
        if (hookMintedTokens.has(cfg.maker_tokens[0][j].toLowerCase())) continue; // hook will mint
        if (cfg.maker_tokens[0][j].toLowerCase() === WETH.toLowerCase()) {
          await fundWeth(makers[0], makers[0].address, cfg.maker_amounts[0][j]);
        } else {
          await fundToken(cfg.maker_tokens[0][j], makers[0].address, cfg.maker_amounts[0][j]);
        }
      }
      for (const tok of [...new Set(cfg.maker_tokens[0])]) {
        const t = await ethers.getContractAt("IERC20", tok);
        await t.connect(makers[0]).approve(BEBOP_PMM, ethers.MaxUint256);
      }

      const pmmOrder: PmmSingleOrder = {
        expiry, taker_address: routerAddr, maker_address: makers[0].address,
        maker_nonce: makerNonce, taker_token: cfg.taker_tokens[0][0], maker_token: cfg.maker_tokens[0][0],
        taker_amount: cfg.taker_amounts[0][0], maker_amount: cfg.maker_amounts[0][0],
        receiver: routerAddr, packed_commands: 0n, flags: 0n,
      };
      const sig = await signPmmSingleOrder(makers[0], BEBOP_PMM, chainId, pmmOrder, 0n);
      pmmCalldata = encodePmmSwapSingle(pmmOrder, sig, 0n);

    } else {
      // aggregate
      const makerAddresses: string[] = [];
      const makerNonces: bigint[] = [];
      const aggHookMinted = new Set((cfg.hooks ?? []).filter(h => h.hookType === "mock-maker-mint").flatMap(h => h.tokens.map(t => t.toLowerCase())));
      for (let i = 0; i < numMakers; i++) {
        makerAddresses.push(makers[i].address);
        const mn = nonceCounter++;
        makerNonces.push(mn);
        pmmMakerNonces.push(mn);
        for (let j = 0; j < cfg.maker_tokens[i].length; j++) {
          if (aggHookMinted.has(cfg.maker_tokens[i][j].toLowerCase())) continue; // hook will mint
          if (cfg.maker_tokens[i][j].toLowerCase() === WETH.toLowerCase()) {
            await fundWeth(makers[i], makers[i].address, cfg.maker_amounts[i][j]);
          } else {
            await fundToken(cfg.maker_tokens[i][j], makers[i].address, cfg.maker_amounts[i][j]);
          }
        }
        for (const tok of [...new Set(cfg.maker_tokens[i])]) {
          const t = await ethers.getContractAt("IERC20", tok);
          await t.connect(makers[i]).approve(BEBOP_PMM, ethers.MaxUint256);
        }
      }

      const aggOrder: PmmAggregateOrder = {
        expiry, taker_address: routerAddr, maker_addresses: makerAddresses, maker_nonces: makerNonces,
        taker_tokens: cfg.taker_tokens, maker_tokens: cfg.maker_tokens,
        taker_amounts: cfg.taker_amounts, maker_amounts: cfg.maker_amounts,
        receiver: routerAddr, commands: cfg.commands, flags: 0n,
      };

      // Sign each maker's MultiOrder (their portion of the aggregate)
      const makerSigs: string[] = [];
      for (let i = 0; i < numMakers; i++) {
        const makerCmds = getMakerCommandSlice(cfg, i, cfg.commands);
        const sig = await signPmmMultiOrder(makers[i], BEBOP_PMM, chainId, aggOrder, i, makerCmds);
        makerSigs.push(sig);
      }
      pmmCalldata = encodePmmSwapAggregate(aggOrder, makerSigs, 0n);
    }

    // --- Convert percent to units ---
    const feeUnits = pctToUnits(cfg.feePercent);
    const slippageUnits = pctToUnits(cfg.slippagePercent);
    const protocolShareFeeUnits = pctToUnits(cfg.protocolShareFeePercent ?? 0);
    const protocolShareSlippageUnits = pctToUnits(cfg.protocolShareSlippagePercent ?? 0);

    // --- Build router order ---
    const useOracle = slippageUnits > 0n;
    const useChecker = feeUnits > 0n;
    const extraInfo = (useOracle || useChecker) ? encodeExtraInfo(feeUnits, slippageUnits) : "0x";

    const routerOrder: RouterOrder = {
      fromAmount: cfg.routerInputTokenAmount, toAmount: cfg.routerOutputTokenAmount,
      limitAmount: cfg.limitAmount ?? 0n,
      fromToken: cfg.routerInputToken, toToken: cfg.routerOutputToken,
      pmmFromToken, pmmToToken,
      tokensOwner: cfg.isSettle ? user.address : ethers.ZeroAddress, receiver: receiver.address,
      originAddress: ethers.ZeroAddress,
      oracle: useOracle ? oracleAddr : ethers.ZeroAddress,
      checker: useChecker ? checkerAddr : ethers.ZeroAddress,
      info: packInfo(expiry, protocolShareSlippageUnits, protocolShareFeeUnits),
      routerNonce: routerNonce,
      unsignedFlags: cfg.isPermit2 ? 1n : 0n,
    };

    // --- Build hooks (packed flags: address(160) | postHook(1) | revertOnFail(1) | useBebopHook(1) | needsApproval(1)) ---
    function packHookFlags(makerAddr: string, postHook: boolean, revertOnFail: boolean, useBebopHook: boolean, needsApproval: boolean): bigint {
      return BigInt(makerAddr)
        | (postHook ? (1n << 160n) : 0n)
        | (revertOnFail ? (1n << 161n) : 0n)
        | (useBebopHook ? (1n << 162n) : 0n)
        | (needsApproval ? (1n << 163n) : 0n);
    }

    const hooks: { targetContract: string; data: string; hookSignature: string; flags: bigint }[] = [];
    if (cfg.hooks) {
      for (const h of cfg.hooks) {
        const target = hookAddresses[h.hookType];
        if (!target) throw new Error(`Unknown hookType: ${h.hookType}`);
        let data: string;
        let makerAddr = ethers.ZeroAddress;
        let hookSig = "0x";
        const needsApproval = h.hookType !== "mock-maker-mint";

        if (h.hookType === "mock-aave-withdraw" || h.hookType === "mock-aave-supply") {
          data = ethers.AbiCoder.defaultAbiCoder().encode(["address"], h.tokens);
        } else if (h.hookType === "mock-maker-mint") {
          const mintToAddr = h.mintTo ? resolveAddress(h.mintTo) : ethers.ZeroAddress;
          data = ethers.AbiCoder.defaultAbiCoder().encode(["address"], [mintToAddr]);
          if (h.makerIndex !== undefined) {
            makerAddr = makers[h.makerIndex].address;
          }
        } else {
          throw new Error(`Unknown hookType: ${h.hookType}`);
        }

        const hookFlags = packHookFlags(makerAddr, h.postHook, h.revertOnFail, h.useBebopHook, needsApproval);

        // Sign hook if maker address is set
        if (makerAddr !== ethers.ZeroAddress && h.makerIndex !== undefined) {
          const makerNonce = pmmMakerNonces[h.makerIndex];
          // EIP-712 signTypedData with BebopHook type
          hookSig = await makers[h.makerIndex].signTypedData(
            { name: ROUTER_DOMAIN_NAME, version: ROUTER_DOMAIN_VERSION, chainId, verifyingContract: routerAddr },
            { BebopHook: [
              { name: "targetContract", type: "address" },
              { name: "dataHash", type: "bytes32" },
              { name: "makerNonce", type: "uint256" },
              { name: "flags", type: "uint256" },
            ]},
            {
              targetContract: target,
              dataHash: ethers.keccak256(data),
              makerNonce,
              flags: hookFlags,
            }
          );
        }

        hooks.push({ targetContract: target, data, hookSignature: hookSig, flags: hookFlags });
      }
    }

    // Compute hooksHash. hookHash is now a proper EIP-712 struct hash:
    // keccak256(abi.encode(HOOK_SIGN_TYPE_HASH, targetContract, keccak256(data), makerAddress, nonce, flags))
    const HOOK_SIGN_TYPE_HASH = ethers.keccak256(ethers.toUtf8Bytes(
      "BebopHook(address targetContract,bytes32 dataHash,uint256 makerNonce,uint256 flags)"
    ));
    let hooksHash = ethers.ZeroHash;
    if (hooks.length > 0) {
      const hookHashes = hooks.map(h => {
        const makerAddr = ethers.getAddress("0x" + (h.flags & ((1n << 160n) - 1n)).toString(16).padStart(40, "0"));
        let nonce = 0n;
        if (makerAddr !== ethers.ZeroAddress) {
          const makerIdx = makers.findIndex(m => m.address.toLowerCase() === makerAddr.toLowerCase());
          if (makerIdx >= 0 && pmmMakerNonces[makerIdx] !== undefined) nonce = pmmMakerNonces[makerIdx];
        }
        return ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
          ["bytes32", "address", "bytes32", "uint256", "uint256"],
          [HOOK_SIGN_TYPE_HASH, h.targetContract, ethers.keccak256(h.data), nonce, h.flags]
        ));
      });
      hooksHash = ethers.keccak256(ethers.solidityPacked(hookHashes.map(() => "bytes32"), hookHashes));
    }

    const routerSig = await signRouterOrder(routerSigner, routerAddr, chainId, routerOrder, extraInfo, hooksHash);

    // --- Snapshot balances before ---
    const allTokens = [...new Set([
      cfg.routerInputToken, cfg.routerOutputToken, pmmFromToken, pmmToToken,
      ...cfg.taker_tokens.flat(), ...cfg.maker_tokens.flat(),
    ])];
    const allWhos = [...new Set(cfg.expectedBalanceChanges.map(c => c.who))];
    const allAddrs = allWhos.map(w => resolveAddress(w));

    const getBalance = async (addr: string, tok: string) => {
      if (tok.toLowerCase() === NATIVE_TOKEN.toLowerCase()) {
        return ethers.provider.getBalance(addr);
      }
      return (await ethers.getContractAt("IERC20", tok)).balanceOf(addr);
    };

    const balBefore: Record<string, Record<string, bigint>> = {};
    for (const addr of allAddrs) {
      balBefore[addr] = {};
      for (const tok of allTokens) {
        balBefore[addr][tok.toLowerCase()] = await getBalance(addr, tok);
      }
    }


    // --- Execute ---
    const exactAmount = cfg.isExactInput ? cfg.exactAmount : -cfg.exactAmount;
    let tx;
    if (cfg.isSettle) {
      let userSig: string;
      if (cfg.isPermit2) {
        // User approves Permit2 contract to spend their tokens
        const inputToken = await ethers.getContractAt("IERC20", cfg.routerInputToken);
        await inputToken.connect(user).approve(PERMIT2, ethers.MaxUint256);

        // Sign using Permit2's witness type
        // The user signs: PermitWitnessTransferFrom with BebopRouterOrder as witness
        const permit2Contract = await ethers.getContractAt("IPermit2", PERMIT2);
        const permit2Domain = { name: "Permit2", chainId, verifyingContract: PERMIT2 };

        // Build the full witness type string for signTypedData
        const orderWitness = routerOrder.hash ? undefined : undefined; // we'll use raw types
        userSig = await user.signTypedData(
          permit2Domain,
          {
            PermitWitnessTransferFrom: [
              { name: "permitted", type: "TokenPermissions" },
              { name: "spender", type: "address" },
              { name: "nonce", type: "uint256" },
              { name: "deadline", type: "uint256" },
              { name: "witness", type: "BebopRouterOrder" },
            ],
            TokenPermissions: [
              { name: "token", type: "address" },
              { name: "amount", type: "uint256" },
            ],
            BebopRouterOrder: [
              { name: "fromAmount", type: "uint256" }, { name: "toAmount", type: "uint256" },
              { name: "limitAmount", type: "int256" }, { name: "fromToken", type: "address" },
              { name: "toToken", type: "address" }, { name: "pmmFromToken", type: "address" },
              { name: "pmmToToken", type: "address" }, { name: "tokensOwner", type: "address" },
              { name: "receiver", type: "address" }, { name: "originAddress", type: "address" },
              { name: "oracle", type: "address" }, { name: "checker", type: "address" },
              { name: "info", type: "uint256" }, { name: "routerNonce", type: "uint256" },
              { name: "extraInfoHash", type: "bytes32" }, { name: "hooksHash", type: "bytes32" },
            ],
          },
          {
            permitted: {
              token: cfg.routerInputToken,
              amount: routerOrder.limitAmount >= 0n ? routerOrder.fromAmount : -routerOrder.limitAmount,
            },
            spender: routerAddr,
            nonce: routerOrder.routerNonce,
            deadline: expiry,
            witness: { ...routerOrder, extraInfoHash: ethers.keccak256(extraInfo), hooksHash },
          }
        );
      } else {
        userSig = await signRouterOrder(user, routerAddr, chainId, routerOrder, extraInfo, hooksHash);
      }
      tx = await router.connect(owner).settle(exactAmount, routerOrder, extraInfo, routerSig, pmmCalldata, hooks, userSig);
    } else {
      const msgValue = isNativeInput ? userFundAmount : 0n;
      tx = await router.connect(user).swap(exactAmount, routerOrder, extraInfo, routerSig, pmmCalldata, hooks, { value: msgValue });
    }
    const receipt = await tx.wait();

    // --- Snapshot after ---
    const balAfter: Record<string, Record<string, bigint>> = {};
    for (const addr of allAddrs) {
      balAfter[addr] = {};
      for (const tok of allTokens) {
        balAfter[addr][tok.toLowerCase()] = await getBalance(addr, tok);
      }
    }

    // --- Verify balance changes ---
    for (const c of cfg.expectedBalanceChanges) {
      const addr = resolveAddress(c.who);
      const actual = (balAfter[addr][c.token.toLowerCase()] ?? 0n) - (balBefore[addr][c.token.toLowerCase()] ?? 0n);
      expect(actual).to.equal(c.delta, `${c.who} balance change for ${c.token}`);
    }

    // --- Verify events ---
    if (receipt) {
      const parseLogs = (name: string) => receipt.logs
        .filter(log => { try { return router.interface.parseLog({ topics: log.topics as string[], data: log.data })?.name === name; } catch { return false; } })
        .map(log => router.interface.parseLog({ topics: log.topics as string[], data: log.data })!);

      // BebopRouterSwap
      const rEvents = parseLogs("BebopRouterSwap");
      expect(rEvents.length).to.equal(1, "Should emit exactly one BebopRouterSwap");
      const re = rEvents[0].args;
      const exp = cfg.expectedRouterSwapEvent;
      expect(re.fromToken).to.equal(exp.fromToken, "RouterSwap.fromToken");
      expect(re.toToken).to.equal(exp.toToken, "RouterSwap.toToken");
      expect(re.fromAmount).to.equal(exp.fromAmount, "RouterSwap.fromAmount");
      expect(re.toAmount).to.equal(exp.toAmount, "RouterSwap.toAmount");
      expect(re.feeValue).to.equal(pctToUnits(exp.feePercent), "RouterSwap.feeValue");
      expect(re.slippageValue).to.equal(pctToUnits(exp.slippagePercent), "RouterSwap.slippageValue");
      expect(re.receiver).to.equal(receiver.address, "RouterSwap.receiver");

      // BebopPmmSwap
      const pEvents = parseLogs("BebopPmmSwap");
      expect(pEvents.length).to.equal(cfg.expectedPmmSwapEvents.length, "BebopPmmSwap count");
      for (let i = 0; i < cfg.expectedPmmSwapEvents.length; i++) {
        const pe = cfg.expectedPmmSwapEvents[i];
        const act = pEvents[i];
        expect(act.args.makerAddress).to.equal(resolveAddress(pe.maker), `PmmSwap[${i}].makerAddress`);
        expect(act.args.takerToken).to.equal(pe.takerToken, `PmmSwap[${i}].takerToken`);
        expect(act.args.makerToken).to.equal(pe.makerToken, `PmmSwap[${i}].makerToken`);
        expect(act.args.takerAmount).to.equal(pe.takerAmount, `PmmSwap[${i}].takerAmount`);
        expect(act.args.makerAmount).to.equal(pe.makerAmount, `PmmSwap[${i}].makerAmount`);
        expect(act.args.makerAmountRefunded).to.equal(pe.makerAmountRefunded, `PmmSwap[${i}].makerAmountRefunded`);
      }
    }
  }

  // ==================== Unit Tests ====================

  describe("Deployment", function () {
    it("should set constructor params correctly", async function () {
      expect(await router.protocolTreasury()).to.equal(treasury.address);
      expect(await router.routerSigner()).to.equal(routerSigner.address);
      expect(await router.bebopPmm()).to.equal(BEBOP_PMM);
    });
  });

  describe("MockChecker", function () {
    it("should return fee from extraInfo", async function () {
      expect(await checker.checkAndGetFee(ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress, encodeExtraInfo(5000n, 0n))).to.equal(5000n);
    });
    it("should return 0 if empty", async function () {
      expect(await checker.checkAndGetFee(ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress, "0x")).to.equal(0n);
    });
  });

  describe("MockOracle", function () {
    it("should return slippage from extraInfo", async function () {
      expect(await oracle.getSlippage(ethers.ZeroAddress, ethers.ZeroAddress, 0, 0, encodeExtraInfo(0n, 3000n))).to.equal(3000n);
    });
    it("should return 0 if empty", async function () {
      expect(await oracle.getSlippage(ethers.ZeroAddress, ethers.ZeroAddress, 0, 0, "0x")).to.equal(0n);
    });
  });

  describe("Nonce Management", function () {
    it("should invalidate nonce", async function () {
      expect(await router.isNonceValid(user.address, 1)).to.be.true;
      await router.connect(user).invalidateNonce(1);
      expect(await router.isNonceValid(user.address, 1)).to.be.false;
    });
    it("should revert on zero nonce", async function () {
      await expect(router.connect(user).invalidateNonce(0)).to.be.revertedWithCustomError(router, "ZeroNonce");
    });
    it("should revert on already-used nonce", async function () {
      await router.connect(user).invalidateNonce(2);
      await expect(router.connect(user).invalidateNonce(2)).to.be.revertedWithCustomError(router, "InvalidNonce");
    });
  });

  describe("Access control", function () {
    it("should allow owner to change routerSigner", async function () {
      await router.connect(owner).setRouterSigner(user.address);
      expect(await router.routerSigner()).to.equal(user.address);
      await router.connect(owner).setRouterSigner(routerSigner.address);
    });
    it("should revert if non-owner", async function () {
      await expect(router.connect(user).setRouterSigner(user.address)).to.be.revertedWithCustomError(router, "OwnableUnauthorizedAccount");
    });
  });

  describe("Edge cases", function () {
    it("should revert settle with zero tokensOwner", async function () {
      const o: RouterOrder = { fromAmount: 100n, toAmount: 100n, limitAmount: 0n, fromToken: USDC, toToken: WETH, pmmFromToken: USDC, pmmToToken: WETH, tokensOwner: ethers.ZeroAddress, receiver: receiver.address, originAddress: ethers.ZeroAddress, oracle: ethers.ZeroAddress, checker: ethers.ZeroAddress, info: packInfo(BigInt(Math.floor(Date.now()/1000)+3600)), routerNonce: 999n, unsignedFlags: 0n };
      await expect(router.connect(user).settle(100n, o, "0x", "0x"+"00".repeat(65), "0x4dcebcba"+"00".repeat(388), [], "0x"+"00".repeat(65))).to.be.revertedWithCustomError(router, "ZeroTokensOwnerForSettle");
    });
    it("should revert settle with exactAmount=0", async function () {
      const o: RouterOrder = { fromAmount: 100n, toAmount: 100n, limitAmount: 0n, fromToken: USDC, toToken: WETH, pmmFromToken: USDC, pmmToToken: WETH, tokensOwner: user.address, receiver: receiver.address, originAddress: ethers.ZeroAddress, oracle: ethers.ZeroAddress, checker: ethers.ZeroAddress, info: packInfo(BigInt(Math.floor(Date.now()/1000)+3600)), routerNonce: 998n, unsignedFlags: 0n };
      await expect(router.connect(user).settle(0n, o, "0x", "0x"+"00".repeat(65), "0x4dcebcba"+"00".repeat(388), [], "0x"+"00".repeat(65))).to.be.revertedWithCustomError(router, "ExactAmountZeroForSettle");
    });

    // Security guard: when useBebopHook=false (raw call), the router must reject any hook
    // whose data starts with the bebopHook(address,bytes,(uint256,address,uint256,address)[])
    // selector. Otherwise a caller could forge a privileged call to a hook contract's
    // bebopHook entrypoint while skipping the maker-signed bebopHook path.
    it("should revert raw-call hook whose data starts with bebopHook selector", async function () {
      const expiry = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const routerNonce = nonceCounter++;
      const makerNonce = nonceCounter++;
      const fromAmount = e18("0.1");
      const toAmount = e6(300);

      // Minimal valid PMM single calldata — never actually executes; pre-hook revert
      // fires inside _executeSwapCore before the PMM call.
      const pmmOrder: PmmSingleOrder = {
        expiry, taker_address: routerAddr, maker_address: makers[0].address,
        maker_nonce: makerNonce, taker_token: WETH, maker_token: USDC,
        taker_amount: fromAmount, maker_amount: toAmount,
        receiver: routerAddr, packed_commands: 0n, flags: 0n,
      };
      const makerSig = await signPmmSingleOrder(makers[0], BEBOP_PMM, chainId, pmmOrder, 0n);
      const pmmCalldata = encodePmmSwapSingle(pmmOrder, makerSig, 0n);

      // Craft data = bebopHook selector + 32 zero bytes. First 4 bytes match
      // IBebopHook.bebopHook.selector, which the router's raw-call path bans.
      const bebopHookSelector = ethers.id(
        "bebopHook(address,bytes,(uint256,address,uint256,address)[])"
      ).slice(0, 10); // "0x" + 8 hex chars
      const maliciousData = bebopHookSelector + "00".repeat(32);

      // Hook flags: maker=address(0), postHook=false, revertOnFail=true,
      //             useBebopHook=false (raw call), needsApproval=false
      const hookFlags = (1n << 161n);
      const maliciousHook = {
        targetContract: makers[0].address, // arbitrary; never reached
        data: maliciousData,
        hookSignature: "0x",
        flags: hookFlags,
      };

      // hooksHash for a single hook with maker=0 → nonce=0
      const HOOK_SIGN_TYPE_HASH = ethers.keccak256(ethers.toUtf8Bytes(
        "BebopHook(address targetContract,bytes32 dataHash,uint256 makerNonce,uint256 flags)"
      ));
      const hookHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "address", "bytes32", "uint256", "uint256"],
        [HOOK_SIGN_TYPE_HASH, maliciousHook.targetContract, ethers.keccak256(maliciousHook.data), 0n, maliciousHook.flags]
      ));
      const hooksHash = ethers.keccak256(ethers.solidityPacked(["bytes32"], [hookHash]));

      const order: RouterOrder = {
        fromAmount, toAmount, limitAmount: 0n,
        fromToken: NATIVE_TOKEN, toToken: USDC,
        pmmFromToken: WETH, pmmToToken: USDC,
        tokensOwner: ethers.ZeroAddress, receiver: receiver.address,
        originAddress: ethers.ZeroAddress, oracle: ethers.ZeroAddress, checker: ethers.ZeroAddress,
        info: packInfo(expiry), routerNonce, unsignedFlags: 0n,
      };
      const routerSig = await signRouterOrder(routerSigner, routerAddr, chainId, order, "0x", hooksHash);

      await expect(
        router.connect(user).swap(fromAmount, order, "0x", routerSig, pmmCalldata, [maliciousHook], { value: fromAmount })
      ).to.be.revertedWithCustomError(router, "BebopHookSelectorBanned");
    });

    // Sanity check: the same hook with a different leading selector executes the raw call
    // (target is an EOA so the call is a no-op success). This guards against the previous
    // test passing for the wrong reason (e.g. unrelated revert earlier in the swap flow).
    it("should NOT revert raw-call hook whose data has a different selector", async function () {
      const expiry = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const routerNonce = nonceCounter++;
      const makerNonce = nonceCounter++;
      const fromAmount = e18("0.1");
      const toAmount = e6(300);

      const pmmOrder: PmmSingleOrder = {
        expiry, taker_address: routerAddr, maker_address: makers[0].address,
        maker_nonce: makerNonce, taker_token: WETH, maker_token: USDC,
        taker_amount: fromAmount, maker_amount: toAmount,
        receiver: routerAddr, packed_commands: 0n, flags: 0n,
      };
      const pmmMakerSig = await signPmmSingleOrder(makers[0], BEBOP_PMM, chainId, pmmOrder, 0n);
      const pmmCalldata = encodePmmSwapSingle(pmmOrder, pmmMakerSig, 0n);

      // Data starts with a clearly non-bebopHook selector — call target is an EOA, so
      // the raw call returns success with no side effects; pre-hook check passes.
      const benignData = "0xdeadbeef" + "00".repeat(32);
      const hookFlags = (1n << 161n); // revertOnFail=true, useBebopHook=false, maker=0, post=false
      const benignHook = {
        targetContract: makers[0].address,
        data: benignData,
        hookSignature: "0x",
        flags: hookFlags,
      };

      const HOOK_SIGN_TYPE_HASH = ethers.keccak256(ethers.toUtf8Bytes(
        "BebopHook(address targetContract,bytes32 dataHash,uint256 makerNonce,uint256 flags)"
      ));
      const hookHash = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
        ["bytes32", "address", "bytes32", "uint256", "uint256"],
        [HOOK_SIGN_TYPE_HASH, benignHook.targetContract, ethers.keccak256(benignHook.data), 0n, benignHook.flags]
      ));
      const hooksHash = ethers.keccak256(ethers.solidityPacked(["bytes32"], [hookHash]));

      const order: RouterOrder = {
        fromAmount, toAmount, limitAmount: 0n,
        fromToken: NATIVE_TOKEN, toToken: USDC,
        pmmFromToken: WETH, pmmToToken: USDC,
        tokensOwner: ethers.ZeroAddress, receiver: receiver.address,
        originAddress: ethers.ZeroAddress, oracle: ethers.ZeroAddress, checker: ethers.ZeroAddress,
        info: packInfo(expiry), routerNonce, unsignedFlags: 0n,
      };
      const routerSig = await signRouterOrder(routerSigner, routerAddr, chainId, order, "0x", hooksHash);

      // We expect the swap to progress past the pre-hook check and revert later (the
      // junk PMM signature won't validate inside BebopSettlement). Critically, it should
      // NOT revert with BebopHookSelectorBanned.
      await expect(
        router.connect(user).swap(fromAmount, order, "0x", routerSig, pmmCalldata, [benignHook], { value: fromAmount })
      ).to.not.be.revertedWithCustomError(router, "BebopHookSelectorBanned");
    });
  });

  describe("View helpers", function () {
    it("hashOrder matches signTypedData digest", async function () {
      const expiry = BigInt(Math.floor(Date.now() / 1000) + 3600);
      const order: RouterOrder = {
        fromAmount: e6(1000), toAmount: e18("0.4"), limitAmount: 0n,
        fromToken: USDC, toToken: WETH, pmmFromToken: USDC, pmmToToken: WETH,
        tokensOwner: ethers.ZeroAddress, receiver: receiver.address,
        originAddress: ethers.ZeroAddress, oracle: ethers.ZeroAddress, checker: ethers.ZeroAddress,
        info: packInfo(expiry), routerNonce: 42n, unsignedFlags: 0n,
      };
      const extraInfo = "0x";
      const hooksHash = ethers.ZeroHash;

      // Get hash from contract
      const contractHash = await router.hashOrder(order, extraInfo, hooksHash);

      // Sign using signTypedData (same types as signRouterOrder)
      const sig = await routerSigner.signTypedData(
        { name: ROUTER_DOMAIN_NAME, version: ROUTER_DOMAIN_VERSION, chainId, verifyingContract: routerAddr },
        { BebopRouterOrder: [
          { name: "fromAmount", type: "uint256" }, { name: "toAmount", type: "uint256" },
          { name: "limitAmount", type: "int256" }, { name: "fromToken", type: "address" },
          { name: "toToken", type: "address" }, { name: "pmmFromToken", type: "address" },
          { name: "pmmToToken", type: "address" }, { name: "tokensOwner", type: "address" },
          { name: "receiver", type: "address" }, { name: "originAddress", type: "address" },
          { name: "oracle", type: "address" }, { name: "checker", type: "address" },
          { name: "info", type: "uint256" }, { name: "routerNonce", type: "uint256" },
          { name: "extraInfoHash", type: "bytes32" }, { name: "hooksHash", type: "bytes32" },
        ]},
        { ...order, extraInfoHash: ethers.keccak256(extraInfo), hooksHash }
      );

      // Recover signer from sig + contractHash
      const recovered = ethers.verifyMessage(ethers.getBytes(contractHash), sig);
      // Actually we need to verify the EIP-712 digest, not a message.
      // Instead: verify the contract can validate the signature
      // The contract's hashOrder returns the EIP-712 digest, so ecrecover should match.
      const sigExpanded = ethers.Signature.from(sig);
      const recoveredAddr = ethers.recoverAddress(contractHash, sigExpanded);
      expect(recoveredAddr).to.equal(routerSigner.address);
    });

    it("hashHook matches signTypedData digest", async function () {
      const hookTarget = ethers.ZeroAddress;
      const hookData = ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [123]);
      const makerAddr = makers[0].address;
      const makerNonce = 77n;
      const hookFlags = BigInt(makerAddr)
        | (0n << 160n)   // postHook = false
        | (1n << 161n)   // revertOnFail = true
        | (1n << 162n)   // useBebopHook = true
        | (0n << 163n);  // needsApproval = false

      const hook = {
        targetContract: hookTarget,
        data: hookData,
        hookSignature: "0x",
        flags: hookFlags,
      };

      // Get hash from contract
      const contractHash = await router.hashHook(hook, makerNonce);

      // Sign using signTypedData
      const sig = await makers[0].signTypedData(
        { name: ROUTER_DOMAIN_NAME, version: ROUTER_DOMAIN_VERSION, chainId, verifyingContract: routerAddr },
        { BebopHook: [
          { name: "targetContract", type: "address" },
          { name: "dataHash", type: "bytes32" },
          { name: "makerNonce", type: "uint256" },
          { name: "flags", type: "uint256" },
        ]},
        {
          targetContract: hookTarget,
          dataHash: ethers.keccak256(hookData),
          makerNonce,
          flags: hookFlags,
        }
      );

      const sigExpanded = ethers.Signature.from(sig);
      const recoveredAddr = ethers.recoverAddress(contractHash, sigExpanded);
      expect(recoveredAddr).to.equal(makers[0].address);
    });
  });

  // ==================== Config-Driven Swap Tests ====================

  describe("Swap - config driven", function () {
    for (const cfg of swapTestConfigs) {
    it(cfg.name, async function () {
        await runSwapTest(cfg);
      });
    }
  });
});
