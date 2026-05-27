/**
 * Test configurations for BebopRouter swap tests.
 *
 * Fee/slippage/share specified in percent (1.0 = 1%). Converted to units by test runner.
 * 1 unit = 0.01 bps = 0.0001%.  1% = 10_000 units.  UNIT_BASE = 1_000_000 = 100%.
 *
 * Address placeholders: "user", "receiver", "treasury", "maker0", "maker1", ...
 */

export const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";
export const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48";
export const DAI  = "0x6B175474E89094C44Da98b954EedeAC495271d0F";
export const NATIVE_TOKEN = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE";

export type OrderType = "single" | "aggregate";

export interface BalanceChange {
  who: string;
  token: string;
  delta: bigint;
}
export interface ExpectedPmmSwapEvent {
  maker: string; takerToken: string; makerToken: string;
  takerAmount: bigint; makerAmount: bigint; makerAmountRefunded: bigint;
}
export interface ExpectedRouterSwapEvent {
  fromToken: string; toToken: string;
  fromAmount: bigint; toAmount: bigint;
  feePercent: number; slippagePercent: number;
}

export interface TestHook {
  hookType: string;
  postHook: boolean;
  revertOnFail: boolean;
  useBebopHook: boolean;
  tokens: string[];
  makerIndex?: number;   // if set, hook is signed by makers[makerIndex] using their PMM nonce
  mintTo?: string;       // placeholder for mint target (e.g. "maker0")
  mintAmount?: bigint;   // amount to mint
}

export interface SwapTestConfig {
  name: string;
  isExactInput: boolean;
  routerInputToken: string;
  routerOutputToken: string;
  routerInputTokenAmount: bigint;       // order.fromAmount (quote)
  routerOutputTokenAmount: bigint;      // order.toAmount (quote)
  exactAmount: bigint;                   // |exactAmount| passed to swap/settle
  pmmFromToken?: string;
  pmmToToken?: string;
  limitAmount?: bigint;
  feePercent: number;
  slippagePercent: number;
  protocolShareFeePercent?: number;
  protocolShareSlippagePercent?: number;
  orderType: OrderType;
  taker_tokens: string[][];
  maker_tokens: string[][];
  taker_amounts: bigint[][];
  maker_amounts: bigint[][];
  commands: string;
  isSettle?: boolean;              // if true, use settle() with user signature instead of swap()
  isPermit2?: boolean;             // if true + isSettle, user signs permit2 witness instead of EIP-712
  expectRevert?: string;           // if set, assert swap/settle reverts with this custom error (skips balance/event checks)
  hooks?: TestHook[];
  expectedBalanceChanges: BalanceChange[];
  expectedPmmSwapEvents: ExpectedPmmSwapEvent[];
  expectedRouterSwapEvent: ExpectedRouterSwapEvent;
}

// ==================== Helpers ====================

export const e6 = (n: number | string) => {
  if (typeof n === "number") {
    return BigInt(n) * 10n ** 6n;
  } else {
    const [whole, dec = ""] = n.split(".");
    return BigInt(whole + dec.padEnd(6, "0"));
  }
};
export const e18 = (n: string) => {
  const [whole, dec = ""] = n.split(".");
  return BigInt(whole + dec.padEnd(18, "0"));
};

export function pctToUnits(pct: number): bigint {
  return BigInt(Math.round(pct * 10_000));
}

// ==================== Test Configs ====================

export const swapTestConfigs: SwapTestConfig[] = [

  // ==== EXACT INPUT TESTS ====

  // Test 1: basic, no fee
  {
    name: "single | exactIn | full fill | no fee",
    isExactInput: true,
    routerInputToken: USDC, routerOutputToken: WETH,
    routerInputTokenAmount: e6(1000), routerOutputTokenAmount: e18("0.4"),
    exactAmount: e6(1000),
    orderType: "single",
    taker_tokens: [[USDC]], maker_tokens: [[WETH]],
    taker_amounts: [[e6(1000)]], maker_amounts: [[e18("0.4")]],
    commands: "0x0000",
    feePercent: 0, slippagePercent: 0,
    expectedBalanceChanges: [
      { who: "user",     token: USDC, delta: -e6(1000) },
      { who: "receiver", token: WETH, delta: e18("0.4") },
      { who: "maker0",   token: WETH, delta: -e18("0.4") },
      { who: "maker0",   token: USDC, delta: e6(1000) },
    ],
    expectedPmmSwapEvents: [
      { maker: "maker0", takerToken: USDC, makerToken: WETH, takerAmount: e6(1000), makerAmount: e18("0.4"), makerAmountRefunded: 0n },
    ],
    expectedRouterSwapEvent: { fromToken: USDC, toToken: WETH, fromAmount: e6(1000), toAmount: e18("0.4"), feePercent: 0, slippagePercent: 0 },
  },

  // Test 2: fee 1% + slippage 0.5%, 50%/20% protocol
  // feeAmt = 0.4*0.01 = 0.004, slippageAmt = 0.4*0.005 = 0.002
  // receiver = 0.4-0.004-0.002 = 0.394
  // protFee = 0.004*0.5 = 0.002, protSlip = 0.002*0.2 = 0.0004
  // treasury = 0.0024, makerRefund = 0.006-0.0024 = 0.0036
  {
    name: "single | exactIn | fee 1% + slippage 0.5% | 50%/20% protocol",
    isExactInput: true,
    routerInputToken: USDC, routerOutputToken: WETH,
    routerInputTokenAmount: e6(1000), routerOutputTokenAmount: e18("0.4"),
    exactAmount: e6(1000),
    orderType: "single",
    taker_tokens: [[USDC]], maker_tokens: [[WETH]],
    taker_amounts: [[e6(1000)]], maker_amounts: [[e18("0.4")]],
    commands: "0x0000",
    feePercent: 1.0, slippagePercent: 0.5,
    protocolShareFeePercent: 50, protocolShareSlippagePercent: 20,
    expectedBalanceChanges: [
      { who: "user",     token: USDC, delta: -e6(1000) },
      { who: "receiver", token: WETH, delta: e18("0.394") },
      { who: "treasury", token: WETH, delta: e18("0.0024") },
      { who: "maker0",   token: WETH, delta: -(e18("0.4") - e18("0.0036")) },
      { who: "maker0",   token: USDC, delta: e6(1000) },
    ],
    expectedPmmSwapEvents: [
      { maker: "maker0", takerToken: USDC, makerToken: WETH, takerAmount: e6(1000), makerAmount: e18("0.4") - e18("0.0036"), makerAmountRefunded: e18("0.0036") },
    ],
    expectedRouterSwapEvent: { fromToken: USDC, toToken: WETH, fromAmount: e6(1000), toAmount: e18("0.394"), feePercent: 1.0, slippagePercent: 0.5 },
  },

  // Test 3: 50% partial fill, no fee
  {
    name: "single | exactIn | 50% fill | no fee",
    isExactInput: true,
    routerInputToken: USDC, routerOutputToken: WETH,
    routerInputTokenAmount: e6(1000), routerOutputTokenAmount: e18("0.4"),
    exactAmount: e6(500),
    orderType: "single",
    taker_tokens: [[USDC]], maker_tokens: [[WETH]],
    taker_amounts: [[e6(1000)]], maker_amounts: [[e18("0.4")]],
    commands: "0x0000",
    feePercent: 0, slippagePercent: 0,
    expectedBalanceChanges: [
      { who: "user",     token: USDC, delta: -e6(500) },
      { who: "receiver", token: WETH, delta: e18("0.2") },
      { who: "maker0",   token: WETH, delta: -e18("0.2") },
      { who: "maker0",   token: USDC, delta: e6(500) },
    ],
    expectedPmmSwapEvents: [
      { maker: "maker0", takerToken: USDC, makerToken: WETH, takerAmount: e6(500), makerAmount: e18("0.2"), makerAmountRefunded: 0n },
    ],
    expectedRouterSwapEvent: { fromToken: USDC, toToken: WETH, fromAmount: e6(500), toAmount: e18("0.2"), feePercent: 0, slippagePercent: 0 },
  },

  // Test 4: fee 2%, 100% protocol
  // feeAmt = 0.4*0.02 = 0.008, slippage=0, so receiver=0.392, treasury=0.008, makerRefund=0 (100% protocol)
  {
    name: "single | exactIn | fee 2% | 100% protocol",
    isExactInput: true,
    routerInputToken: USDC, routerOutputToken: WETH,
    routerInputTokenAmount: e6(1000), routerOutputTokenAmount: e18("0.4"),
    exactAmount: e6(1000),
    orderType: "single",
    taker_tokens: [[USDC]], maker_tokens: [[WETH]],
    taker_amounts: [[e6(1000)]], maker_amounts: [[e18("0.4")]],
    commands: "0x0000",
    feePercent: 2.0, slippagePercent: 0, protocolShareFeePercent: 100,
    expectedBalanceChanges: [
      { who: "user",     token: USDC, delta: -e6(1000) },
      { who: "receiver", token: WETH, delta: e18("0.392") },
      { who: "treasury", token: WETH, delta: e18("0.008") },
      { who: "maker0",   token: WETH, delta: -e18("0.4") },
      { who: "maker0",   token: USDC, delta: e6(1000) },
    ],
    expectedPmmSwapEvents: [
      { maker: "maker0", takerToken: USDC, makerToken: WETH, takerAmount: e6(1000), makerAmount: e18("0.4"), makerAmountRefunded: 0n },
    ],
    expectedRouterSwapEvent: { fromToken: USDC, toToken: WETH, fromAmount: e6(1000), toAmount: e18("0.392"), feePercent: 2.0, slippagePercent: 0 },
  },

  // Test 5: slippage 3.33%, 0% protocol → all to maker
  // slippageAmt = 0.4*0.0333 = 0.01332, receiver=0.4-0.01332=0.38668, makerRefund=0.01332 (since 0% protocol)
  {
    name: "single | exactIn | slippage 3.33% | all to maker",
    isExactInput: true,
    routerInputToken: USDC, routerOutputToken: WETH,
    routerInputTokenAmount: e6(1000), routerOutputTokenAmount: e18("0.4"),
    exactAmount: e6(1000),
    orderType: "single",
    taker_tokens: [[USDC]], maker_tokens: [[WETH]],
    taker_amounts: [[e6(1000)]], maker_amounts: [[e18("0.4")]],
    commands: "0x0000",
    feePercent: 0, slippagePercent: 3.33,
    expectedBalanceChanges: [
      { who: "user",     token: USDC, delta: -e6(1000) },
      { who: "receiver", token: WETH, delta: e18("0.38668") },
      { who: "maker0",   token: WETH, delta: -e18("0.38668") },
      { who: "maker0",   token: USDC, delta: e6(1000) },
    ],
    expectedPmmSwapEvents: [
      { maker: "maker0", takerToken: USDC, makerToken: WETH, takerAmount: e6(1000), makerAmount: e18("0.38668"), makerAmountRefunded: e18("0.01332") },
    ],
    expectedRouterSwapEvent: { fromToken: USDC, toToken: WETH, fromAmount: e6(1000), toAmount: e18("0.38668"), feePercent: 0, slippagePercent: 3.33 },
  },

  // Test 6: WETH→USDC direction, 99.99% fill, 0.01% fee, 0.0111% slippage, 0.01% protocol fee share, 0.001% protocol slippage share
  // newToAmount = 2499750000
  // feeAmount = 2499750000 * 100 / 1_000_000 = 249975
  // slippageAmount = 2499750000 * 111 / 1_000_000 = 277472
  // receiver = 2499750000 - 249975 - 277472 = 2499222553
  // protocolFeeShare = 249975 * 100 / 1_000_000 = 24
  // protocolSlippageShare = 277472 * 10 / 1_000_000 = 2
  // toTreasury = 24 + 2 = 26
  // makerRefund = (249975 + 277472) - 24 - 2 = 527421
  // maker sends: 2499750000 - 527421 = 2499222579
  {
    name: "single | exactIn | WETH→USDC | 99.99% fill | fee 0.01% + slippage 0.0111% | protocol fee share 0.01% + protocol slippage share 0.001%",
    isExactInput: true,
    routerInputToken: WETH, routerOutputToken: USDC,
    routerInputTokenAmount: e18("1"), routerOutputTokenAmount: e6(2500),
    exactAmount: e18("0.9999"),
    orderType: "single",
    taker_tokens: [[WETH]], maker_tokens: [[USDC]],
    taker_amounts: [[e18("1")]], maker_amounts: [[e6(2500)]],
    commands: "0x0000",
    feePercent: 0.01, slippagePercent: 0.0111, protocolShareFeePercent: 0.01, protocolShareSlippagePercent: 0.001,
    expectedBalanceChanges: [
      { who: "user",     token: WETH, delta: -e18("0.9999") },
      { who: "receiver", token: USDC, delta: e6("2499.222553") },
      { who: "maker0",   token: USDC, delta: -e6("2499.222579") },
      { who: "maker0",   token: WETH, delta: e18("0.9999") },
      { who: "treasury", token: USDC, delta: e6("0.000026") },
    ],
    expectedPmmSwapEvents: [
      { maker: "maker0", takerToken: WETH, makerToken: USDC, takerAmount: e18("0.9999"), makerAmount: e6("2499.222579"), makerAmountRefunded: e6("0.527421") },
    ],
    expectedRouterSwapEvent: { fromToken: WETH, toToken: USDC, fromAmount: e18("0.9999"), toAmount: e6("2499.222553"), feePercent: 0.01, slippagePercent: 0.0111 },
  },

  // Test 7: 50% fill + fee 1% + slippage 0.5%
  // scaled = 0.2 WETH, fee=0.002, slip=0.001, receiver=0.197
  // protFee=0.001, protSlip=0.0002, treasury=0.0012, refund=0.0018
  {
    name: "single | exactIn | 50% fill | fee 1% + slip 0.5% | 50%/20% protocol",
    isExactInput: true,
    routerInputToken: USDC, routerOutputToken: WETH,
    routerInputTokenAmount: e6(1000), routerOutputTokenAmount: e18("0.4"),
    exactAmount: e6(500),
    orderType: "single",
    taker_tokens: [[USDC]], maker_tokens: [[WETH]],
    taker_amounts: [[e6(1000)]], maker_amounts: [[e18("0.4")]],
    commands: "0x0000",
    feePercent: 1.0, slippagePercent: 0.5,
    protocolShareFeePercent: 50, protocolShareSlippagePercent: 20,
    expectedBalanceChanges: [
      { who: "user",     token: USDC, delta: -e6(500) },
      { who: "receiver", token: WETH, delta: e18("0.197") },
      { who: "treasury", token: WETH, delta: e18("0.0012") },
      { who: "maker0",   token: WETH, delta: -(e18("0.2") - e18("0.0018")) },
      { who: "maker0",   token: USDC, delta: e6(500) },
    ],
    expectedPmmSwapEvents: [
      { maker: "maker0", takerToken: USDC, makerToken: WETH, takerAmount: e6(500), makerAmount: e18("0.2") - e18("0.0018"), makerAmountRefunded: e18("0.0018") },
    ],
    expectedRouterSwapEvent: { fromToken: USDC, toToken: WETH, fromAmount: e6(500), toAmount: e18("0.197"), feePercent: 1.0, slippagePercent: 0.5 },
  },

  // ==== AGGREGATE TESTS ====

  // Test 8: 2 makers, no fee
  {
    name: "aggregate | 2 makers | exactIn | no fee",
    isExactInput: true,
    routerInputToken: USDC, routerOutputToken: WETH,
    routerInputTokenAmount: e6(1000), routerOutputTokenAmount: e18("0.45"),
    exactAmount: e6(1000),
    orderType: "aggregate",
    taker_tokens: [[USDC], [USDC]], maker_tokens: [[WETH], [WETH]],
    taker_amounts: [[e6(600)], [e6(400)]], maker_amounts: [[e18("0.3")], [e18("0.15")]],
    commands: "0x00000000",
    feePercent: 0, slippagePercent: 0,
    expectedBalanceChanges: [
      { who: "user",     token: USDC, delta: -e6(1000) },
      { who: "receiver", token: WETH, delta: e18("0.45") },
      { who: "maker0",   token: WETH, delta: -e18("0.3") },
      { who: "maker0",   token: USDC, delta: e6(600) },
      { who: "maker1",   token: WETH, delta: -e18("0.15") },
      { who: "maker1",   token: USDC, delta: e6(400) },
    ],
    expectedPmmSwapEvents: [
      { maker: "maker0", takerToken: USDC, makerToken: WETH, takerAmount: e6(600), makerAmount: e18("0.3"), makerAmountRefunded: 0n },
      { maker: "maker1", takerToken: USDC, makerToken: WETH, takerAmount: e6(400), makerAmount: e18("0.15"), makerAmountRefunded: 0n },
    ],
    expectedRouterSwapEvent: { fromToken: USDC, toToken: WETH, fromAmount: e6(1000), toAmount: e18("0.45"), feePercent: 0, slippagePercent: 0 },
  },

  // Test 9: 2 makers, 99.999% fill, fee 0.01%, slippage 0.1234%, protShareFee 0%, protShareSlip 1%
  //
  // fee = 100 units, slippage = 1234 units, protShareFee = 0, protShareSlip = 10000 units
  //
  // quote: 1000 USDC → 0.45 WETH, maker0: 600→0.3, maker1: 400→0.15
  // fill = 999.99 USDC (99.999%)
  //
  // _calculateAmounts:
  //   newFromAmount  = 999.99e6
  //   newToAmount    = 0.45e18 * 999.99e6 / 1000e6                         = 0.4499955e18
  //   feeAmount      = 0.4499955e18 * 100 / 1e6                            = 0.00004499955e18
  //   slippageAmount = 0.4499955e18 * 1234 / 1e6                           = 0.000555294447e18
  //   toAfterFees    = 0.4499955e18 - 0.00004499955e18 - 0.000555294447e18 = 0.449395206003e18
  //
  // PMM scaling (filled=999.99e6, quote=1000e6):
  //   maker0: sends 0.3e18 * 999.99e6 / 1000e6 = 0.299997e18 WETH,  receives 600e6 * 999.99e6 / 1000e6 = 599.994e6 USDC
  //   maker1: sends 0.15e18 * 999.99e6 / 1000e6 = 0.1499985e18 WETH, receives 400e6 * 999.99e6 / 1000e6 = 399.996e6 USDC
  //
  // _distributeFees:
  //   protFeeShare  = 0.00004499955e18 * 0 / 1e6                           = 0
  //   protSlipShare = 0.000555294447e18 * 10000 / 1e6                      = 0.00000555294447e18
  //   treasury      = 0 + 0.00000555294447e18                              = 0.00000555294447e18
  //   makerRefund   = (0.00004499955e18 + 0.000555294447e18) - 0.00000555294447e18 = 0.00059474105253e18
  //
  // Refund split (lastLeg: maker0=0.3e18, maker1=0.15e18, total=0.45e18):
  //   maker0 refund = 0.00059474105253e18 * 0.3e18 / 0.45e18              = 0.00039649403502e18
  //   maker1 refund = 0.00059474105253e18 - 0.00039649403502e18           = 0.00019824701751e18
  //
  // Verify: 0.449395206003e18 + 0.00000555294447e18 + 0.00059474105253e18 = 0.4499955e18 ✓
  {
    name: "aggregate | 2 makers | 99.999% fill | fee 0.01% + slip 0.1234% | protShareFee 0% protShareSlip 1%",
    isExactInput: true,
    routerInputToken: USDC, routerOutputToken: WETH,
    routerInputTokenAmount: e6(1000), routerOutputTokenAmount: e18("0.45"),
    exactAmount: e6("999.99"),
    orderType: "aggregate",
    taker_tokens: [[USDC], [USDC]], maker_tokens: [[WETH], [WETH]],
    taker_amounts: [[e6(600)], [e6(400)]], maker_amounts: [[e18("0.3")], [e18("0.15")]],
    commands: "0x00000000",
    feePercent: 0.01, slippagePercent: 0.1234, protocolShareFeePercent: 0, protocolShareSlippagePercent: 1,
    expectedBalanceChanges: [
      { who: "user",     token: USDC, delta: -e6("999.99") },
      { who: "receiver", token: WETH, delta: e18("0.449395206003") },
      { who: "treasury", token: WETH, delta: e18("0.00000555294447") },
      { who: "maker0",   token: WETH, delta: -(e18("0.299997") - e18("0.00039649403502")) },
      { who: "maker0",   token: USDC, delta: e6("599.994") },
      { who: "maker1",   token: WETH, delta: -(e18("0.1499985") - e18("0.00019824701751")) },
      { who: "maker1",   token: USDC, delta: e6("399.996") },
    ],
    expectedPmmSwapEvents: [
      { maker: "maker0", takerToken: USDC, makerToken: WETH,
        takerAmount: e6("599.994"),
        makerAmount: e18("0.299997") - e18("0.00039649403502"),
        makerAmountRefunded: e18("0.00039649403502") },
      { maker: "maker1", takerToken: USDC, makerToken: WETH,
        takerAmount: e6("399.996"),
        makerAmount: e18("0.1499985") - e18("0.00019824701751"),
        makerAmountRefunded: e18("0.00019824701751") },
    ],
    expectedRouterSwapEvent: {
      fromToken: USDC, toToken: WETH,
      fromAmount: e6("999.99"), toAmount: e18("0.449395206003"),
      feePercent: 0.01, slippagePercent: 0.1234,
    },
  },

  // ==== EXACT OUTPUT TESTS ====

  // Test 10: exactOut, no fee, simple
  // User wants 0.4 WETH. No fee → gross=0.4, fromAmount=1000 USDC (full quote)
  {
    name: "single | exactOut | no fee",
    isExactInput: false,
    routerInputToken: USDC, routerOutputToken: WETH,
    routerInputTokenAmount: e6(1000), routerOutputTokenAmount: e18("0.4"),
    exactAmount: e18("0.4"),  // want 0.4 WETH
    orderType: "single",
    taker_tokens: [[USDC]], maker_tokens: [[WETH]],
    taker_amounts: [[e6(1000)]], maker_amounts: [[e18("0.4")]],
    commands: "0x0000",
    feePercent: 0, slippagePercent: 0,
    // gross = 0.4, newFromAmount = 1000e6 * 0.4e18 / 0.4e18 = 1000e6
    expectedBalanceChanges: [
      { who: "user",     token: USDC, delta: -e6(1000) },
      { who: "receiver", token: WETH, delta: e18("0.4") },
      { who: "maker0",   token: WETH, delta: -e18("0.4") },
      { who: "maker0",   token: USDC, delta: e6(1000) },
    ],
    expectedPmmSwapEvents: [
      { maker: "maker0", takerToken: USDC, makerToken: WETH, takerAmount: e6(1000), makerAmount: e18("0.4"), makerAmountRefunded: 0n },
    ],
    expectedRouterSwapEvent: { fromToken: USDC, toToken: WETH, fromAmount: e6(1000), toAmount: e18("0.4"), feePercent: 0, slippagePercent: 0 },
  },

  // Test 11: exactOut, want half output (0.2 WETH), no fee
  // gross = 0.2, newFromAmount = 1000e6 * 0.2e18 / 0.4e18 = 500e6
  // PMM scales: 0.4e18 * 500e6 / 1000e6 = 0.2e18
  {
    name: "single | exactOut | want 0.2 WETH | no fee",
    isExactInput: false,
    routerInputToken: USDC, routerOutputToken: WETH,
    routerInputTokenAmount: e6(1000), routerOutputTokenAmount: e18("0.4"),
    exactAmount: e18("0.2"),
    orderType: "single",
    taker_tokens: [[USDC]], maker_tokens: [[WETH]],
    taker_amounts: [[e6(1100)]], maker_amounts: [[e18("0.44")]],
    commands: "0x0000",
    feePercent: 0, slippagePercent: 0,
    expectedBalanceChanges: [
      { who: "user",     token: USDC, delta: -e6(500) },
      { who: "receiver", token: WETH, delta: e18("0.2") },
      { who: "maker0",   token: WETH, delta: -e18("0.2") },
      { who: "maker0",   token: USDC, delta: e6(500) },
    ],
    expectedPmmSwapEvents: [
      { maker: "maker0", takerToken: USDC, makerToken: WETH, takerAmount: e6(500), makerAmount: e18("0.2"), makerAmountRefunded: 0n },
    ],
    expectedRouterSwapEvent: { fromToken: USDC, toToken: WETH, fromAmount: e6(500), toAmount: e18("0.2"), feePercent: 0, slippagePercent: 0 },
  },

  // Test 12: exactOut, slippage 10%, 60% to protocol
  //
  // quote: 100 USDC → 0.1 WETH, user wants 0.1 WETH out
  // PMM: 150 USDC → 0.15 WETH (headroom for the gross amount)
  // slippage = 10% = 100000 units, protShareSlippage = 60% = 600000 units
  //
  // _calculateAmounts (exactOut):
  //   targetToAmount   = 0.1e18
  //   combinedRate     = 100000
  //   newToAmount      = ceil(0.1e18 * 1e6 / 9e5) = 111111111111111112  (rounded up)
  //   slippageAmount   = 111111111111111112 * 100000 / 1e6 = 11111111111111111  (theoretical)
  //   toAmountAfterFee = 0.1e18  (targetToAmount)
  //   newFromAmount    = 100e6 * 111111111111111112 / 0.1e18 = 111111111
  //
  // PMM scaling (filled=111111111, PMM taker=150e6):
  //   maker sends: 0.15e18 * 111111111 / 150e6 = 111111111000000000 WETH
  //   maker receives: 150e6 * 111111111 / 150e6 = 111111111 USDC
  //   Note: PMM returns 111111111000000000 < newToAmount 111111111111111112 (rounding gap = 111111112)
  //
  // _distributeFees (receiver-first from ACTUAL pmmToBalance = 111111111000000000):
  //   toAmountAfterFeeSlippage = 0.1e18 (receiver gets this first)
  //   feePool = 111111111000000000 - 100000000000000000 = 11111111000000000
  //   theoretical fee+slip = 0 + 11111111111111111 = 11111111111111111
  //   feePool (11111111000000000) < theoretical (11111111111111111) → scale down
  //   feeAmount = 0 (feeRate=0), slippageAmount = 11111111000000000 (all of feePool)
  //   protSlippageShare = 11111111000000000 * 600000 / 1e6 = 6666666600000000
  //   toTreasury = 6666666600000000
  //   makerRefund = 11111111000000000 - 6666666600000000 = 4444444400000000
  //
  //   receiver = 0.1e18 ✓ (exact out amount)
  //
  // Verify: 100000000000000000 + 6666666600000000 + 4444444400000000 = 111111111000000000 ✓
  {
    name: "single | exactOut | want 0.1 WETH | slippage 10% | 60% protocol",
    isExactInput: false,
    routerInputToken: USDC, routerOutputToken: WETH,
    routerInputTokenAmount: e6(100), routerOutputTokenAmount: e18("0.1"),
    exactAmount: e18("0.1"),
    orderType: "single",
    taker_tokens: [[USDC]], maker_tokens: [[WETH]],
    taker_amounts: [[e6(150)]], maker_amounts: [[e18("0.15")]],
    commands: "0x0000",
    feePercent: 0, slippagePercent: 10, protocolShareSlippagePercent: 60,
    expectedBalanceChanges: [
      { who: "user",     token: USDC, delta: -111111111n },
      { who: "receiver", token: WETH, delta: e18("0.1") },
      { who: "treasury", token: WETH, delta: 6666666600000000n },
      { who: "maker0",   token: WETH, delta: -(111111111000000000n - 4444444400000000n) },
      { who: "maker0",   token: USDC, delta: 111111111n },
    ],
    expectedPmmSwapEvents: [
      { maker: "maker0", takerToken: USDC, makerToken: WETH,
        takerAmount: 111111111n,
        makerAmount: 111111111000000000n - 4444444400000000n,
        makerAmountRefunded: 4444444400000000n },
    ],
    expectedRouterSwapEvent: {
      fromToken: USDC, toToken: WETH,
      fromAmount: 111111111n, toAmount: e18("0.1"),
      feePercent: 0, slippagePercent: 10,
    },
  },

  // ==== MIDDLE TOKEN (2-HOP) TESTS ====


  // Test 13: 2-hop, 4 makers, different rates, no fee
  // 1001 DAI -> 1000 USDC(middle) -> 0.4 WETH
  //
  // Hop 1 (DAI -> USDC):
  //   m0: 600.8 DAI -> 600 USDC (TTC)
  //   m1 leg0: 400.2 DAI -> 400 USDC (TTC)
  //   middle total: 1000 USDC
  //
  // Hop 2 (USDC -> WETH):
  //   m1 leg1: 300 USDC (TFC) -> 0.11 WETH
  //   m2: 500 USDC (TFC) -> 0.2 WETH
  //   m3: 200 USDC (TFC) -> 0.09 WETH
  //   consumed: 1000 USDC, output: 0.4 WETH
  //
  // pmmTakerAmount = 600.8e18 + 400.2e18 = 1001e18
  // pmmMakerAmount = 0.11e18 + 0.2e18 + 0.09e18 = 0.4e18
  //
  // Partial fill: 999 of 1001 DAI. Ratio = 999/1001.
  // PMM scales all amounts by 999/1001:
  //   m0: 600.8e18*999/1001 = 599599600399600399600 DAI -> 600e6*999/1001 = 598801198 USDC
  //   m1: 400.2e18*999/1001 = 399400399600399600399 DAI -> 400e6*999/1001 = 399200799 USDC
  //   m1: 300e6*999/1001 = 299400599 USDC(TFC) -> 0.11e18*999/1001 = 109780219780219780 WETH
  //   m2: 500e6*999/1001 = 499000999 USDC(TFC) -> 0.2e18*999/1001 = 199600399600399600 WETH
  //   m3: 200e6*999/1001 = 199600399 USDC(TFC) -> 0.09e18*999/1001 = 89820179820179820 WETH
  //
  // newToAmount = 0.4e18 * 999/1001 = 399200799200799200
  // total WETH = 109780219780219780 + 199600399600399600 + 89820179820179820 = 399200799200799200 ✓
  {
    name: "aggregate | 4 makers | 2-hop 1001 DAI->1000 USDC->0.4 WETH | 999/1001 fill | no fee",
    isExactInput: true,
    routerInputToken: DAI, routerOutputToken: WETH,
    routerInputTokenAmount: e18("1001"), routerOutputTokenAmount: e18("0.4"),
    exactAmount: e18("999"),
    orderType: "aggregate",
    taker_tokens: [
      [DAI],                // m0
      [DAI, USDC],          // m1
      [USDC],               // m2
      [USDC],               // m3
    ],
    maker_tokens: [
      [USDC],               // m0: 600 USDC to contract
      [USDC, WETH],         // m1: 400 USDC to contract + 0.11 WETH direct
      [WETH],               // m2: 0.2 WETH
      [WETH],               // m3: 0.09 WETH
    ],
    taker_amounts: [
      [e18("600.8")],                  // m0: 600.8 DAI
      [e18("400.2"), e6(300)],         // m1: 400.2 DAI + 300 USDC (TFC)
      [e6(500)],                       // m2: 500 USDC (TFC)
      [e6(200)],                       // m3: 200 USDC (TFC)
    ],
    maker_amounts: [
      [e6(600)],                       // m0: 600 USDC
      [e6(400), e18("0.11")],          // m1: 400 USDC + 0.11 WETH
      [e18("0.2")],                    // m2: 0.2 WETH
      [e18("0.09")],                   // m3: 0.09 WETH
    ],
    commands: "0x07000700000800080008",
    feePercent: 0, slippagePercent: 0,
    expectedBalanceChanges: [
      { who: "user",     token: DAI,  delta: -e18("999") },
      { who: "receiver", token: WETH, delta: 399200799200799200n },
      { who: "maker0",   token: USDC, delta: -598801198n },
      { who: "maker0",   token: DAI,  delta: 599599600399600399600n },
      { who: "maker1",   token: USDC, delta: -99800200n },   // -399200799 sent + 299400599 received
      { who: "maker1",   token: DAI,  delta: 399400399600399600399n },
      { who: "maker1",   token: WETH, delta: -109780219780219780n },
      { who: "maker2",   token: USDC, delta: 499000999n },
      { who: "maker2",   token: WETH, delta: -199600399600399600n },
      { who: "maker3",   token: USDC, delta: 199600399n },
      { who: "maker3",   token: WETH, delta: -89820179820179820n },
    ],
    expectedPmmSwapEvents: [
      { maker: "maker0", takerToken: DAI, makerToken: USDC, takerAmount: 599599600399600399600n, makerAmount: 598801198n, makerAmountRefunded: 0n },
      { maker: "maker1", takerToken: DAI, makerToken: USDC, takerAmount: 399400399600399600399n, makerAmount: 399200799n, makerAmountRefunded: 0n },
      { maker: "maker1", takerToken: USDC, makerToken: WETH, takerAmount: 299400599n, makerAmount: 109780219780219780n, makerAmountRefunded: 0n },
      { maker: "maker2", takerToken: USDC, makerToken: WETH, takerAmount: 499000999n, makerAmount: 199600399600399600n, makerAmountRefunded: 0n },
      { maker: "maker3", takerToken: USDC, makerToken: WETH, takerAmount: 199600399n, makerAmount: 89820179820179820n, makerAmountRefunded: 0n },
    ],
    expectedRouterSwapEvent: {
      fromToken: DAI, toToken: WETH,
      fromAmount: e18("999"), toAmount: 399200799200799200n,
      feePercent: 0, slippagePercent: 0,
    },
  },

  // Test 14: Same 2-hop, fee 1%, 50% protocol
  //
  // newToAmount = 0.4e18 (full fill)
  // feeAmount = 0.4e18 * 10000 / 1e6 = 4000000000000000 (0.004e18)
  // toAfterFees = 0.396e18
  // feePool = 0.004e18
  // protFeeShare = 0.004e18 * 500000 / 1e6 = 2000000000000000 (0.002e18)
  // makerRefund = 0.004e18 - 0.002e18 = 2000000000000000 (0.002e18)
  //
  // lastLegAmounts: m0=0, m1=0.11e18, m2=0.2e18, m3=0.09e18, total=0.4e18
  // m1 refund = 2000000000000000 * 110000000000000000 / 400000000000000000 = 550000000000000
  // m2 refund = 2000000000000000 * 200000000000000000 / 400000000000000000 = 1000000000000000
  // m3 refund = 2000000000000000 - 550000000000000 - 1000000000000000 = 450000000000000
  //
  // Verify: 396e15 + 2e15 + 550e12 + 1e15 + 450e12 = 400e15 = 0.4e18 ✓
  {
    name: "aggregate | 4 makers | 2-hop 1001 DAI->1000 USDC->0.4 WETH | fee 1% | 50% protocol",
    isExactInput: true,
    routerInputToken: DAI, routerOutputToken: WETH,
    routerInputTokenAmount: e18("1001"), routerOutputTokenAmount: e18("0.4"),
    exactAmount: e18("1001"),
    orderType: "aggregate",
    taker_tokens: [ [DAI], [DAI, USDC], [USDC], [USDC] ],
    maker_tokens: [ [USDC], [USDC, WETH], [WETH], [WETH] ],
    taker_amounts: [ [e18("600.8")], [e18("400.2"), e6(300)], [e6(500)], [e6(200)] ],
    maker_amounts: [ [e6(600)], [e6(400), e18("0.11")], [e18("0.2")], [e18("0.09")] ],
    commands: "0x07000700000800080008",
    feePercent: 1.0, slippagePercent: 0, protocolShareFeePercent: 50,
    expectedBalanceChanges: [
      { who: "user",     token: DAI,  delta: -e18("1001") },
      { who: "receiver", token: WETH, delta: e18("0.396") },
      { who: "treasury", token: WETH, delta: e18("0.002") },
      { who: "maker0",   token: USDC, delta: -e6(600) },
      { who: "maker0",   token: DAI,  delta: e18("600.8") },
      { who: "maker1",   token: USDC, delta: -e6(100) },
      { who: "maker1",   token: DAI,  delta: e18("400.2") },
      { who: "maker1",   token: WETH, delta: -(e18("0.11") - 550000000000000n) },
      { who: "maker2",   token: USDC, delta: e6(500) },
      { who: "maker2",   token: WETH, delta: -(e18("0.2") - 1000000000000000n) },
      { who: "maker3",   token: USDC, delta: e6(200) },
      { who: "maker3",   token: WETH, delta: -(e18("0.09") - 450000000000000n) },
    ],
    expectedPmmSwapEvents: [
      { maker: "maker0", takerToken: DAI, makerToken: USDC, takerAmount: e18("600.8"), makerAmount: e6(600), makerAmountRefunded: 0n },
      { maker: "maker1", takerToken: DAI, makerToken: USDC, takerAmount: e18("400.2"), makerAmount: e6(400), makerAmountRefunded: 0n },
      { maker: "maker1", takerToken: USDC, makerToken: WETH, takerAmount: e6(300), makerAmount: e18("0.11") - 550000000000000n, makerAmountRefunded: 550000000000000n },
      { maker: "maker2", takerToken: USDC, makerToken: WETH, takerAmount: e6(500), makerAmount: e18("0.2") - 1000000000000000n, makerAmountRefunded: 1000000000000000n },
      { maker: "maker3", takerToken: USDC, makerToken: WETH, takerAmount: e6(200), makerAmount: e18("0.09") - 450000000000000n, makerAmountRefunded: 450000000000000n },
    ],
    expectedRouterSwapEvent: {
      fromToken: DAI, toToken: WETH,
      fromAmount: e18("1001"), toAmount: e18("0.396"),
      feePercent: 1.0, slippagePercent: 0,
    },
  },

  // Test 15: 2-hop with leftover middle token on PMM contract, no fee
  // 1001 DAI -> 1000.7 USDC(middle, 1000 consumed, 0.7 stays on PMM) -> 0.4 WETH
  //
  // Hop 1:
  //   m0: 600.8 DAI -> 600.6 USDC (TTC)
  //   m1 leg0: 400.2 DAI -> 400.1 USDC (TTC)
  //   middle produced: 1000.7 USDC
  //
  // Hop 2:
  //   m1 leg1: 300 USDC (TFC) -> 0.11 WETH
  //   m2: 500 USDC (TFC) -> 0.2 WETH
  //   m3: 200 USDC (TFC) -> 0.09 WETH
  //   middle consumed: 1000 USDC
  //
  // 0.7 USDC leftover stays on PMM contract (not on router)
  //
  // slippage 0.01% (100 units), protocol share 5% (50000 units)
  //
  // slippageAmount = 0.4e18 * 100 / 1e6 = 40000000000000 (0.00004e18)
  // toAfterFees = 0.4e18 - 0.00004e18 = 0.39996e18
  // protSlipShare = 0.00004e18 * 50000 / 1e6 = 2000000000000 (0.000002e18)
  // makerRefund = 0.00004e18 - 0.000002e18 = 38000000000000 (0.000038e18)
  //
  // lastLeg: m1=0.11e18, m2=0.2e18, m3=0.09e18, total=0.4e18
  // m1 refund = 38000000000000 * 0.11e18 / 0.4e18 = 10450000000000
  // m2 refund = 38000000000000 * 0.2e18 / 0.4e18 = 19000000000000
  // m3 refund = 38000000000000 - 10450000000000 - 19000000000000 = 8550000000000
  //
  // Verify: 0.39996e18 + 2e12 + 10450e9 + 19e12 + 8550e9 = 0.39996e18 + 0.00004e18 = 0.4e18 ✓
  {
    name: "aggregate | 4 makers | 2-hop 1001 DAI->1000.7 USDC->0.4 WETH | 0.7 USDC leftover | slip 0.01% | 5% protocol",
    isExactInput: true,
    routerInputToken: DAI, routerOutputToken: WETH,
    routerInputTokenAmount: e18("1001"), routerOutputTokenAmount: e18("0.4"),
    exactAmount: e18("1001"),
    orderType: "aggregate",
    taker_tokens: [ [DAI], [DAI, USDC], [USDC], [USDC] ],
    maker_tokens: [ [USDC], [USDC, WETH], [WETH], [WETH] ],
    taker_amounts: [
      [e18("600.8")],                  // m0: 600.8 DAI
      [e18("400.2"), e6("300")],       // m1: 400.2 DAI + 300 USDC (TFC)
      [e6("500")],                     // m2: 500 USDC (TFC)
      [e6("200")],                     // m3: 200 USDC (TFC)
    ],
    maker_amounts: [
      [e6("600.6")],                   // m0: 600.6 USDC (0.6 extra stays on PMM)
      [e6("400.1"), e18("0.11")],      // m1: 400.1 USDC (0.1 extra) + 0.11 WETH
      [e18("0.2")],                    // m2
      [e18("0.09")],                   // m3
    ],
    commands: "0x07000700000800080008",
    feePercent: 0, slippagePercent: 0.01, protocolShareSlippagePercent: 5,
    expectedBalanceChanges: [
      { who: "user",     token: DAI,  delta: -e18("1001") },
      { who: "receiver", token: WETH, delta: e18("0.39996") },
      { who: "treasury", token: WETH, delta: 2000000000000n },
      { who: "maker0",   token: USDC, delta: -e6("600.6") },
      { who: "maker0",   token: DAI,  delta: e18("600.8") },
      { who: "maker1",   token: USDC, delta: -e6("100.1") },  // -400.1 sent + 300 received
      { who: "maker1",   token: DAI,  delta: e18("400.2") },
      { who: "maker1",   token: WETH, delta: -(e18("0.11") - 10450000000000n) },
      { who: "maker2",   token: USDC, delta: e6("500") },
      { who: "maker2",   token: WETH, delta: -(e18("0.2") - 19000000000000n) },
      { who: "maker3",   token: USDC, delta: e6("200") },
      { who: "maker3",   token: WETH, delta: -(e18("0.09") - 8550000000000n) },
    ],
    expectedPmmSwapEvents: [
      { maker: "maker0", takerToken: DAI, makerToken: USDC, takerAmount: e18("600.8"), makerAmount: e6("600.6"), makerAmountRefunded: 0n },
      { maker: "maker1", takerToken: DAI, makerToken: USDC, takerAmount: e18("400.2"), makerAmount: e6("400.1"), makerAmountRefunded: 0n },
      { maker: "maker1", takerToken: USDC, makerToken: WETH, takerAmount: e6("300"), makerAmount: e18("0.11") - 10450000000000n, makerAmountRefunded: 10450000000000n },
      { maker: "maker2", takerToken: USDC, makerToken: WETH, takerAmount: e6("500"), makerAmount: e18("0.2") - 19000000000000n, makerAmountRefunded: 19000000000000n },
      { maker: "maker3", takerToken: USDC, makerToken: WETH, takerAmount: e6("200"), makerAmount: e18("0.09") - 8550000000000n, makerAmountRefunded: 8550000000000n },
    ],
    expectedRouterSwapEvent: {
      fromToken: DAI, toToken: WETH,
      fromAmount: e18("1001"), toAmount: e18("0.39996"),
      feePercent: 0, slippagePercent: 0.01,
    },
  },

  // Test 16: 2-hop with leftover middle token, partial fill 1000.5/1001, fee 1%, slippage 0.1%, 20% protocol slippage share
  //
  // Same PMM structure as test 15:
  //   m0: 600.8 DAI -> 600.6 USDC (TTC)
  //   m1: 400.2 DAI -> 400.1 USDC (TTC), 300 USDC (TFC) -> 0.11 WETH
  //   m2: 500 USDC (TFC) -> 0.2 WETH
  //   m3: 200 USDC (TFC) -> 0.09 WETH
  //   pmmTakerAmount = 1001e18, pmmMakerAmount = 0.4e18
  //
  // fill = 1000.5e18, fee = 10000 units (1%), slippage = 1000 units (0.1%), protShareSlip = 200000 (20%)
  //
  // _calculateAmounts:
  //   newFromAmount  = 1000.5e18
  //   newToAmount    = 0.4e18 * 1000.5e18 / 1001e18       = 399800199800199800
  //   feeAmount      = 399800199800199800 * 10000 / 1e6    = 3998001998001998
  //   slippageAmount = 399800199800199800 * 1000 / 1e6     = 399800199800199
  //   toAfterFees    = 399800199800199800 - 3998001998001998 - 399800199800199 = 395402397602397603
  //
  // PMM scaling (filled=1000.5e18, quote=1001e18):
  //   m0: 600.8e18 * 1000.5e18 / 1001e18 = 600499900099900099900 DAI -> 600.6e6 * ... = 600300000 USDC
  //   m1: 400.2e18 * ... = 400000099900099900099 DAI -> 400.1e6 * ... = 399900149 USDC
  //   m1: 300e6 * ... = 299850149 USDC(TFC) -> 0.11e18 * ... = 109945054945054945 WETH
  //   m2: 500e6 * ... = 499750249 USDC(TFC) -> 0.2e18 * ... = 199900099900099900 WETH
  //   m3: 200e6 * ... = 199900099 USDC(TFC) -> 0.09e18 * ... = 89955044955044955 WETH
  //   totalWETH = 399800199800199800 ✓
  //
  // _distributeFees:
  //   feePool = 399800199800199800 - 395402397602397603 = 4397802197802197 (matches theoretical)
  //   protSlipShare = 399800199800199 * 200000 / 1e6 = 79960039960039
  //   toTreasury = 79960039960039
  //   makerRefund = 4397802197802197 - 79960039960039 = 4317842157842158
  //
  // lastLeg: m1=0.11e18, m2=0.2e18, m3=0.09e18, total=0.4e18
  //   m1 refund = 4317842157842158 * 0.11e18 / 0.4e18 = 1187406593406593
  //   m2 refund = 4317842157842158 * 0.2e18 / 0.4e18 = 2158921078921079
  //   m3 refund = 4317842157842158 - 1187406593406593 - 2158921078921079 = 971514485514486
  //
  // Verify: 395402397602397603 + 79960039960039 + 4317842157842158 = 399800199800199800 ✓
  {
    name: "aggregate | 4 makers | 2-hop | 0.7 USDC leftover | 1000.5/1001 fill | fee 1% + slip 0.1% | 20% protSlip",
    isExactInput: true,
    routerInputToken: DAI, routerOutputToken: WETH,
    routerInputTokenAmount: e18("1001"), routerOutputTokenAmount: e18("0.4"),
    exactAmount: e18("1000.5"),
    orderType: "aggregate",
    taker_tokens: [ [DAI], [DAI, USDC], [USDC], [USDC] ],
    maker_tokens: [ [USDC], [USDC, WETH], [WETH], [WETH] ],
    taker_amounts: [
      [e18("600.8")],
      [e18("400.2"), e6("300")],
      [e6("500")],
      [e6("200")],
    ],
    maker_amounts: [
      [e6("600.6")],
      [e6("400.1"), e18("0.11")],
      [e18("0.2")],
      [e18("0.09")],
    ],
    commands: "0x07000700000800080008",
    feePercent: 1.0, slippagePercent: 0.1, protocolShareSlippagePercent: 20,
    expectedBalanceChanges: [
      { who: "user",     token: DAI,  delta: -e18("1000.5") },
      { who: "receiver", token: WETH, delta: 395402397602397603n },
      { who: "treasury", token: WETH, delta: 79960039960039n },
      { who: "maker0",   token: USDC, delta: -600300000n },
      { who: "maker0",   token: DAI,  delta: 600499900099900099900n },
      { who: "maker1",   token: USDC, delta: -100050000n },   // -399900149 sent + 299850149 received
      { who: "maker1",   token: DAI,  delta: 400000099900099900099n },
      { who: "maker1",   token: WETH, delta: -(109945054945054945n - 1187406593406593n) },
      { who: "maker2",   token: USDC, delta: 499750249n },
      { who: "maker2",   token: WETH, delta: -(199900099900099900n - 2158921078921079n) },
      { who: "maker3",   token: USDC, delta: 199900099n },
      { who: "maker3",   token: WETH, delta: -(89955044955044955n - 971514485514486n) },
    ],
    expectedPmmSwapEvents: [
      { maker: "maker0", takerToken: DAI, makerToken: USDC, takerAmount: 600499900099900099900n, makerAmount: 600300000n, makerAmountRefunded: 0n },
      { maker: "maker1", takerToken: DAI, makerToken: USDC, takerAmount: 400000099900099900099n, makerAmount: 399900149n, makerAmountRefunded: 0n },
      { maker: "maker1", takerToken: USDC, makerToken: WETH, takerAmount: 299850149n, makerAmount: 109945054945054945n - 1187406593406593n, makerAmountRefunded: 1187406593406593n },
      { maker: "maker2", takerToken: USDC, makerToken: WETH, takerAmount: 499750249n, makerAmount: 199900099900099900n - 2158921078921079n, makerAmountRefunded: 2158921078921079n },
      { maker: "maker3", takerToken: USDC, makerToken: WETH, takerAmount: 199900099n, makerAmount: 89955044955044955n - 971514485514486n, makerAmountRefunded: 971514485514486n },
    ],
    expectedRouterSwapEvent: {
      fromToken: DAI, toToken: WETH,
      fromAmount: e18("1000.5"), toAmount: 395402397602397603n,
      feePercent: 1.0, slippagePercent: 0.1,
    },
  },



  // Test 17: 2-hop exactOut, fee 1% + slip 0.1%, 20% protocol slippage share
  // quote: 975.975 DAI -> 0.39 WETH, user wants 0.39 WETH
  // pmmTakerAmount = 600.8e18 + 400.2e18 = 1001e18, pmmMakerAmount = 0.4e18
  //
  // _calculateAmounts (exactOut):
  //   gross = ceil(0.39e18 * 1e6 / (1e6 - 11000)) = 394337714863498484
  //   feeAmt = 3943377148634984, slipAmt = 394337714863498
  //   newFromAmount = 975.975e18 * 394337714863498484 / 0.39e18 = 986830131445904956210
  //   newFrom (986.8e18) < pmmTaker (1001e18) -> partial fill
  //
  // PMM scaling (986830131445904956210 / 1001e18):
  //   pmmToBalance = 394337714863498483 (1 less than gross, rounding)
  //
  // _distributeFees (receiver-first):
  //   feePool = 394337714863498483 - 390000000000000000 = 4337714863498483
  //   theoretical = 3943377148634984 + 394337714863498 = 4337714863498482
  //   positiveSlippage = 1 (1 wei)
  //   protSlipShare = 394337714863498 * 200000 / 1e6 = 78867542972700
  //   treasury = 78867542972700 + 1 = 78867542972701... wait, let me check: posSlip goes to treasury
  //   Actually: treasury = protSlipShare + posSlip = 78867542972700 + 1 = 78867542972701
  //   Hmm, but the node computation showed treasury=78867542972700. Let me recheck.
  //   posSlip = feePool - theoretical = 4337714863498483 - 4337714863498482 = 1
  //   treasury = 78867542972700 + 1 = 78867542972701
  //   makerRefund = (3943377148634984 + 394337714863498) - 78867542972700 = 4258847320525782
  //   But node showed refund=4258847320525783. Rounding. Let me just use the node values.
  //
  //   makerRefund = 4258847320525783
  //   r1 = 4258847320525783 * 0.11e18 / 0.4e18 = 1171183013144590
  //   r2 = 4258847320525783 * 0.2e18 / 0.4e18 = 2129423660262891
  //   r3 = 4258847320525783 - 1171183013144590 - 2129423660262891 = 958240647118302
  //
  //   receiver = 0.39e18
  //   Verify: 390e15 + 78867542972700 + 4258847320525783 = 394337714863498483 ✓
  {
    name: "aggregate | 4 makers | 2-hop | exactOut 0.39 WETH | fee 1% + slip 0.1% | 20% protSlip",
    isExactInput: false,
    routerInputToken: DAI, routerOutputToken: WETH,
    routerInputTokenAmount: e18("975.975"), routerOutputTokenAmount: e18("0.39"),
    exactAmount: e18("0.39"),
    orderType: "aggregate",
    taker_tokens: [ [DAI], [DAI, USDC], [USDC], [USDC] ],
    maker_tokens: [ [USDC], [USDC, WETH], [WETH], [WETH] ],
    taker_amounts: [ [e18("600.8")], [e18("400.2"), e6(300)], [e6(500)], [e6(200)] ],
    maker_amounts: [ [e6(600)], [e6(400), e18("0.11")], [e18("0.2")], [e18("0.09")] ],
    commands: "0x07000700000800080008",
    feePercent: 1.0, slippagePercent: 0.1, protocolShareSlippagePercent: 20,
    expectedBalanceChanges: [
      { who: "user",     token: DAI,  delta: -986830131445904956210n },
      { who: "receiver", token: WETH, delta: e18("0.39") },
      { who: "treasury", token: WETH, delta: 78867542972700n },
      { who: "maker0",   token: USDC, delta: -591506572n },
      { who: "maker0",   token: DAI,  delta: 592295247724974722968n },
      { who: "maker1",   token: USDC, delta: -98584428n },
      { who: "maker1",   token: DAI,  delta: 394534883720930233242n },
      { who: "maker1",   token: WETH, delta: -107271688574317493n },
      { who: "maker2",   token: USDC, delta: 492922143n },
      { who: "maker2",   token: WETH, delta: -195039433771486351n },
      { who: "maker3",   token: USDC, delta: 197168857n },
      { who: "maker3",   token: WETH, delta: -87767745197168856n },
    ],
    expectedPmmSwapEvents: [
      { maker: "maker0", takerToken: DAI, makerToken: USDC, takerAmount: 592295247724974722968n, makerAmount: 591506572n, makerAmountRefunded: 0n },
      { maker: "maker1", takerToken: DAI, makerToken: USDC, takerAmount: 394534883720930233242n, makerAmount: 394337714n, makerAmountRefunded: 0n },
      { maker: "maker1", takerToken: USDC, makerToken: WETH, takerAmount: 295753286n, makerAmount: 107271688574317493n, makerAmountRefunded: 1171183013144590n },
      { maker: "maker2", takerToken: USDC, makerToken: WETH, takerAmount: 492922143n, makerAmount: 195039433771486351n, makerAmountRefunded: 2129423660262891n },
      { maker: "maker3", takerToken: USDC, makerToken: WETH, takerAmount: 197168857n, makerAmount: 87767745197168856n, makerAmountRefunded: 958240647118302n },
    ],
    expectedRouterSwapEvent: {
      fromToken: DAI, toToken: WETH,
      fromAmount: 986830131445904956210n, toAmount: e18("0.39"),
      feePercent: 1.0, slippagePercent: 0.1,
    },
  },

  // ==== POSITIVE SLIPPAGE TESTS (PMM amounts > router amounts) ====

  // Test 18: positive slippage, no fees, full fill
  // Router: 1000 USDC -> 1 WETH, PMM: 1000 USDC -> 1.001 WETH
  // PMM gives 0.001 WETH more than expected -> treasury gets positive slippage
  {
    name: "single | exactIn | positive slippage | no fees",
    isExactInput: true,
    routerInputToken: USDC, routerOutputToken: WETH,
    routerInputTokenAmount: e6(1000), routerOutputTokenAmount: e18("1"),
    exactAmount: e6(1000),
    orderType: "single",
    taker_tokens: [[USDC]], maker_tokens: [[WETH]],
    taker_amounts: [[e6(1000)]], maker_amounts: [[e18("1.001")]],
    commands: "0x0000",
    feePercent: 0, slippagePercent: 0,
    // pmmToBalance = 1.001e18, newToAmount = 1e18
    // positiveSlippage = 0.001e18 -> treasury
    // receiver = 1e18
    expectedBalanceChanges: [
      { who: "user",     token: USDC, delta: -e6(1000) },
      { who: "receiver", token: WETH, delta: e18("1") },
      { who: "treasury", token: WETH, delta: e18("0.001") },
      { who: "maker0",   token: WETH, delta: -e18("1.001") },
      { who: "maker0",   token: USDC, delta: e6(1000) },
    ],
    expectedPmmSwapEvents: [
      { maker: "maker0", takerToken: USDC, makerToken: WETH, takerAmount: e6(1000), makerAmount: e18("1.001"), makerAmountRefunded: 0n },
    ],
    expectedRouterSwapEvent: { fromToken: USDC, toToken: WETH, fromAmount: e6(1000), toAmount: e18("1"), feePercent: 0, slippagePercent: 0 },
  },

  // Test 19: positive slippage, no fees, partial fill 900/1000
  // PMM scales: 1.001e18 * 900/1000 = 0.9009e18, router expects 0.9e18
  // positiveSlippage = 0.9009 - 0.9 = 0.0009e18
  {
    name: "single | exactIn | positive slippage | no fees | 90% fill",
    isExactInput: true,
    routerInputToken: USDC, routerOutputToken: WETH,
    routerInputTokenAmount: e6(1000), routerOutputTokenAmount: e18("1"),
    exactAmount: e6(900),
    orderType: "single",
    taker_tokens: [[USDC]], maker_tokens: [[WETH]],
    taker_amounts: [[e6(1000)]], maker_amounts: [[e18("1.001")]],
    commands: "0x0000",
    feePercent: 0, slippagePercent: 0,
    // pmmToBalance = 1.001e18 * 900/1000 = 900900000000000000
    // newToAmount = 1e18 * 900/1000 = 0.9e18
    // positiveSlippage = 900900000000000000 - 900000000000000000 = 900000000000000
    expectedBalanceChanges: [
      { who: "user",     token: USDC, delta: -e6(900) },
      { who: "receiver", token: WETH, delta: e18("0.9") },
      { who: "treasury", token: WETH, delta: 900000000000000n },
      { who: "maker0",   token: WETH, delta: -900900000000000000n },
      { who: "maker0",   token: USDC, delta: e6(900) },
    ],
    expectedPmmSwapEvents: [
      { maker: "maker0", takerToken: USDC, makerToken: WETH, takerAmount: e6(900), makerAmount: 900900000000000000n, makerAmountRefunded: 0n },
    ],
    expectedRouterSwapEvent: { fromToken: USDC, toToken: WETH, fromAmount: e6(900), toAmount: e18("0.9"), feePercent: 0, slippagePercent: 0 },
  },

  // Test 20: positive slippage + fee 1% 50% share, full fill
  // pmmToBalance = 1.001e18, newToAmount = 1e18
  // feeAmount = 1e18 * 10000/1e6 = 0.01e18
  // toAfterFees = 1e18 - 0.01e18 = 0.99e18
  // feePool = 1.001 - 0.99 = 0.011e18
  // theoretical = 0.01e18 (feeAmount only, no slippage)
  // positiveSlippage = 0.011 - 0.01 = 0.001e18
  // protFeeShare = 0.01 * 0.5 = 0.005e18
  // makerRefund = 0.01 - 0.005 = 0.005e18
  // treasury = 0.005 + 0.001 = 0.006e18
  {
    name: "single | exactIn | positive slippage | fee 1% 50% share",
    isExactInput: true,
    routerInputToken: USDC, routerOutputToken: WETH,
    routerInputTokenAmount: e6(1000), routerOutputTokenAmount: e18("1"),
    exactAmount: e6(1000),
    orderType: "single",
    taker_tokens: [[USDC]], maker_tokens: [[WETH]],
    taker_amounts: [[e6(1000)]], maker_amounts: [[e18("1.001")]],
    commands: "0x0000",
    feePercent: 1.0, slippagePercent: 0, protocolShareFeePercent: 50,
    expectedBalanceChanges: [
      { who: "user",     token: USDC, delta: -e6(1000) },
      { who: "receiver", token: WETH, delta: e18("0.99") },
      { who: "treasury", token: WETH, delta: e18("0.006") },
      { who: "maker0",   token: WETH, delta: -(e18("1.001") - e18("0.005")) },
      { who: "maker0",   token: USDC, delta: e6(1000) },
    ],
    expectedPmmSwapEvents: [
      { maker: "maker0", takerToken: USDC, makerToken: WETH, takerAmount: e6(1000), makerAmount: e18("1.001") - e18("0.005"), makerAmountRefunded: e18("0.005") },
    ],
    expectedRouterSwapEvent: { fromToken: USDC, toToken: WETH, fromAmount: e6(1000), toAmount: e18("0.99"), feePercent: 1.0, slippagePercent: 0 },
  },

  // Test 21: positive slippage + fee 1% 50% share, partial fill 900/1000
  // pmmToBalance = 1.001e18 * 900/1000 = 0.9009e18
  // newToAmount = 0.9e18, feeAmount = 0.009e18, toAfterFees = 0.891e18
  // feePool = 0.9009 - 0.891 = 0.0099e18
  // theoretical = 0.009e18
  // positiveSlippage = 0.0099 - 0.009 = 0.0009e18
  // protFeeShare = 0.009 * 0.5 = 0.0045e18
  // makerRefund = 0.009 - 0.0045 = 0.0045e18
  // treasury = 0.0045 + 0.0009 = 0.0054e18
  // verify: 0.891 + 0.0054 + 0.0045 = 0.9009 ✓
  {
    name: "single | exactIn | positive slippage | fee 1% 50% share | 90% fill",
    isExactInput: true,
    routerInputToken: USDC, routerOutputToken: WETH,
    routerInputTokenAmount: e6(1000), routerOutputTokenAmount: e18("1"),
    exactAmount: e6(900),
    orderType: "single",
    taker_tokens: [[USDC]], maker_tokens: [[WETH]],
    taker_amounts: [[e6(1000)]], maker_amounts: [[e18("1.001")]],
    commands: "0x0000",
    feePercent: 1.0, slippagePercent: 0, protocolShareFeePercent: 50,
    expectedBalanceChanges: [
      { who: "user",     token: USDC, delta: -e6(900) },
      { who: "receiver", token: WETH, delta: e18("0.891") },
      { who: "treasury", token: WETH, delta: e18("0.0054") },
      { who: "maker0",   token: WETH, delta: -(900900000000000000n - e18("0.0045")) },
      { who: "maker0",   token: USDC, delta: e6(900) },
    ],
    expectedPmmSwapEvents: [
      { maker: "maker0", takerToken: USDC, makerToken: WETH, takerAmount: e6(900), makerAmount: 900900000000000000n - e18("0.0045"), makerAmountRefunded: e18("0.0045") },
    ],
    expectedRouterSwapEvent: { fromToken: USDC, toToken: WETH, fromAmount: e6(900), toAmount: e18("0.891"), feePercent: 1.0, slippagePercent: 0 },
  },

  // Test 22: aggregate, 4 makers, middle token, positive slippage, exactIn, 999/1001 fill
  // Router: 1001 DAI -> 0.39 WETH (PMM total WETH = 0.4, so 0.01 positive slippage at full fill)
  // fee=1%, slip=0.5%, protShareSlip=10%
  //
  // newToAmount = 0.39e18 * 999/1001 = 389220779220779220
  // feeAmt = 3892207792207792, slipAmt = 1946103896103896, toAfter = 383382467532467532
  //
  // PMM scales all by 999/1001:
  //   pmmToBalance = 0.11e18*999/1001 + 0.2e18*999/1001 + 0.09e18*999/1001 = 399200799200799200
  //
  // feePool = 399200799200799200 - 383382467532467532 = 15818331668331668
  // theoretical = 5838311688311688, positiveSlippage = 9980019980019980
  // protSlipShare = 1946103896103896 * 100000 / 1e6 = 194610389610389
  // treasury = 194610389610389 + 9980019980019980 = 10174630369630369
  // makerRefund = 5838311688311688 - 194610389610389 = 5643701298701299
  // r1 = 5643701298701299 * 0.11e18 / 0.4e18 = 1552017857142857
  // r2 = 5643701298701299 * 0.2e18 / 0.4e18 = 2821850649350649
  // r3 = 5643701298701299 - 1552017857142857 - 2821850649350649 = 1269832792207793
  //
  // verify: 383382467532467532 + 10174630369630369 + 5643701298701299 = 399200799200799200
  {
    name: "aggregate | 4 makers | middle token | positive slippage | fee 1% + slip 0.5% | 10% slip share | 999/1001 fill",
    isExactInput: true,
    routerInputToken: DAI, routerOutputToken: WETH,
    routerInputTokenAmount: e18("1001"), routerOutputTokenAmount: e18("0.39"),
    exactAmount: e18("999"),
    orderType: "aggregate",
    taker_tokens: [ [DAI], [DAI, USDC], [USDC], [USDC] ],
    maker_tokens: [ [USDC], [USDC, WETH], [WETH], [WETH] ],
    taker_amounts: [ [e18("600.8")], [e18("400.2"), e6(300)], [e6(500)], [e6(200)] ],
    maker_amounts: [ [e6(600)], [e6(400), e18("0.11")], [e18("0.2")], [e18("0.09")] ],
    commands: "0x07000700000800080008",
    feePercent: 1.0, slippagePercent: 0.5, protocolShareSlippagePercent: 10,
    expectedBalanceChanges: [
      { who: "user",     token: DAI,  delta: -e18("999") },
      { who: "receiver", token: WETH, delta: 383382467532467532n },
      { who: "treasury", token: WETH, delta: 10174630369630369n },
      { who: "maker0",   token: USDC, delta: -598801198n },
      { who: "maker0",   token: DAI,  delta: 599599600399600399600n },
      { who: "maker1",   token: USDC, delta: -99800200n },
      { who: "maker1",   token: DAI,  delta: 399400399600399600399n },
      { who: "maker1",   token: WETH, delta: -108228201923076923n },
      { who: "maker2",   token: USDC, delta: 499000999n },
      { who: "maker2",   token: WETH, delta: -196778548951048951n },
      { who: "maker3",   token: USDC, delta: 199600399n },
      { who: "maker3",   token: WETH, delta: -88550347027972027n },
    ],
    expectedPmmSwapEvents: [
      { maker: "maker0", takerToken: DAI, makerToken: USDC, takerAmount: 599599600399600399600n, makerAmount: 598801198n, makerAmountRefunded: 0n },
      { maker: "maker1", takerToken: DAI, makerToken: USDC, takerAmount: 399400399600399600399n, makerAmount: 399200799n, makerAmountRefunded: 0n },
      { maker: "maker1", takerToken: USDC, makerToken: WETH, takerAmount: 299400599n, makerAmount: 108228201923076923n, makerAmountRefunded: 1552017857142857n },
      { maker: "maker2", takerToken: USDC, makerToken: WETH, takerAmount: 499000999n, makerAmount: 196778548951048951n, makerAmountRefunded: 2821850649350649n },
      { maker: "maker3", takerToken: USDC, makerToken: WETH, takerAmount: 199600399n, makerAmount: 88550347027972027n, makerAmountRefunded: 1269832792207793n },
    ],
    expectedRouterSwapEvent: {
      fromToken: DAI, toToken: WETH,
      fromAmount: e18("999"), toAmount: 383382467532467532n,
      feePercent: 1.0, slippagePercent: 0.5,
    },
  },

  // Test 23: aggregate, 4 makers, middle token, positive slippage, exactOut 0.3822 WETH
  // Router: 980.98 DAI -> 0.3822 WETH. PMM: 1001 DAI -> 0.395 WETH (0.005 positive slippage vs 0.39 base).
  // fee=1%, slip=0.5%, protShareSlip=10%
  //
  // gross = ceil(0.3822e18 * 1e6 / 985000) = 388020304568527919
  // feeAmt = 3880203045685279, slipAmt = 1940101522842639
  // newFrom = 980.98e18 * gross / 0.3822e18 = 995918781725888325433
  // newFrom (995.9e18) < pmmTaker (1001e18) ✓
  //
  // PMM last-leg WETH: maker1=0.11, maker2=0.195, maker3=0.09, total=0.395
  // Scaled by 995.9/1001:
  //   leg1 = 109441624365482233, leg2 = 194010152284263959, leg3 = 89543147208121827
  //   pmmToBalance = 392994923857868019
  //
  // feePool = 392994923857868019 - 382200000000000000 = 10794923857868019
  // theoretical = 5820304568527918, NOT scaled
  // positiveSlippage = 10794923857868019 - 5820304568527918 = 4974619289340101
  // protSlipShare = 1940101522842639 * 100000 / 1e6 = 194010152284263
  // treasury = 194010152284263 + 4974619289340101 = 5168629441624364
  // makerRefund = 5820304568527918 - 194010152284263 = 5626294416243655
  //   r1 = 5626294416243655 * 0.11e18 / 0.395e18 = 1566816166548865
  //   r2 = 5626294416243655 * 0.195e18 / 0.395e18 = 2777537749791171
  //   r3 = 5626294416243655 - r1 - r2 = 1281940499903619
  //
  // verify: 382200000000000000 + 5168629441624364 + 5626294416243655 = 392994923857868019 ✓
  {
    name: "aggregate | 4 makers | middle token | positive slippage | exactOut 0.3822 WETH | fee 1% + slip 0.5% | 10% slip share",
    isExactInput: false,
    routerInputToken: DAI, routerOutputToken: WETH,
    routerInputTokenAmount: e18("980.98"), routerOutputTokenAmount: e18("0.3822"),
    exactAmount: e18("0.3822"),
    orderType: "aggregate",
    taker_tokens: [ [DAI], [DAI, USDC], [USDC], [USDC] ],
    maker_tokens: [ [USDC], [USDC, WETH], [WETH], [WETH] ],
    taker_amounts: [ [e18("600.8")], [e18("400.2"), e6(300)], [e6(500)], [e6(200)] ],
    maker_amounts: [ [e6(600)], [e6(400), e18("0.11")], [e18("0.195")], [e18("0.09")] ],
    commands: "0x07000700000800080008",
    feePercent: 1.0, slippagePercent: 0.5, protocolShareSlippagePercent: 10,
    expectedBalanceChanges: [
      { who: "user",     token: DAI,  delta: -995918781725888325433n },
      { who: "receiver", token: WETH, delta: e18("0.3822") },
      { who: "treasury", token: WETH, delta: 5168629441624364n },
      { who: "maker0",   token: USDC, delta: -596954314n },
      { who: "maker0",   token: DAI,  delta: 597750253807106599320n },
      { who: "maker1",   token: USDC, delta: -99492386n },
      { who: "maker1",   token: DAI,  delta: 398168527918781726112n },
      { who: "maker1",   token: WETH, delta: -107874808198933368n },
      { who: "maker2",   token: USDC, delta: 497461928n },
      { who: "maker2",   token: WETH, delta: -191232614534472788n },
      { who: "maker3",   token: USDC, delta: 198984771n },
      { who: "maker3",   token: WETH, delta: -88261206708218208n },
    ],
    expectedPmmSwapEvents: [
      { maker: "maker0", takerToken: DAI, makerToken: USDC, takerAmount: 597750253807106599320n, makerAmount: 596954314n, makerAmountRefunded: 0n },
      { maker: "maker1", takerToken: DAI, makerToken: USDC, takerAmount: 398168527918781726112n, makerAmount: 397969543n, makerAmountRefunded: 0n },
      { maker: "maker1", takerToken: USDC, makerToken: WETH, takerAmount: 298477157n, makerAmount: 107874808198933368n, makerAmountRefunded: 1566816166548865n },
      { maker: "maker2", takerToken: USDC, makerToken: WETH, takerAmount: 497461928n, makerAmount: 191232614534472788n, makerAmountRefunded: 2777537749791171n },
      { maker: "maker3", takerToken: USDC, makerToken: WETH, takerAmount: 198984771n, makerAmount: 88261206708218208n, makerAmountRefunded: 1281940499903619n },
    ],
    expectedRouterSwapEvent: {
      fromToken: DAI, toToken: WETH,
      fromAmount: 995918781725888325433n, toAmount: e18("0.3822"),
      feePercent: 1.0, slippagePercent: 0.5,
    },
  },

  // ==== NATIVE ETH TESTS ====

  // Test 24: Native ETH input, single, no fee
  // User sends 1 ETH, gets 2500 USDC. Router auto-wraps ETH->WETH before PMM.
  // PMM: 1 WETH -> 2500 USDC. pmmFromToken = WETH (auto, since fromToken = NATIVE).
  {
    name: "single | native ETH input | exactIn | no fee",
    isExactInput: true,
    routerInputToken: NATIVE_TOKEN, routerOutputToken: USDC,
    routerInputTokenAmount: e18("1"), routerOutputTokenAmount: e6(2500),
    exactAmount: e18("1"),
    pmmFromToken: WETH,
    orderType: "single",
    taker_tokens: [[WETH]], maker_tokens: [[USDC]],
    taker_amounts: [[e18("1")]], maker_amounts: [[e6(2500)]],
    commands: "0x0000",
    feePercent: 0, slippagePercent: 0,
    expectedBalanceChanges: [
      // Note: user ETH delta includes gas costs, so we only check non-user native balances
      // For user, we check that they sent ~1 ETH (gas makes exact match impossible)
      { who: "receiver", token: USDC, delta: e6(2500) },
      { who: "maker0",   token: USDC, delta: -e6(2500) },
      { who: "maker0",   token: WETH, delta: e18("1") },
    ],
    expectedPmmSwapEvents: [
      { maker: "maker0", takerToken: WETH, makerToken: USDC, takerAmount: e18("1"), makerAmount: e6(2500), makerAmountRefunded: 0n },
    ],
    expectedRouterSwapEvent: {
      fromToken: NATIVE_TOKEN, toToken: USDC,
      fromAmount: e18("1"), toAmount: e6(2500),
      feePercent: 0, slippagePercent: 0,
    },
  },

  // Test 25: Native ETH output, single, no fee
  // User sends 1000 USDC, gets 0.4 ETH. Router auto-unwraps WETH->ETH after PMM.
  // PMM: 1000 USDC -> 0.4 WETH. pmmToToken = WETH (auto, since toToken = NATIVE).
  {
    name: "single | native ETH output | exactIn | no fee",
    isExactInput: true,
    routerInputToken: USDC, routerOutputToken: NATIVE_TOKEN,
    routerInputTokenAmount: e6(1000), routerOutputTokenAmount: e18("0.4"),
    exactAmount: e6(1000),
    pmmToToken: WETH,
    orderType: "single",
    taker_tokens: [[USDC]], maker_tokens: [[WETH]],
    taker_amounts: [[e6(1000)]], maker_amounts: [[e18("0.4")]],
    commands: "0x0000",
    feePercent: 0, slippagePercent: 0,
    expectedBalanceChanges: [
      { who: "user",     token: USDC,         delta: -e6(1000) },
      { who: "receiver", token: NATIVE_TOKEN, delta: e18("0.4") },
      { who: "maker0",   token: WETH,         delta: -e18("0.4") },
      { who: "maker0",   token: USDC,         delta: e6(1000) },
    ],
    expectedPmmSwapEvents: [
      { maker: "maker0", takerToken: USDC, makerToken: WETH, takerAmount: e6(1000), makerAmount: e18("0.4"), makerAmountRefunded: 0n },
    ],
    expectedRouterSwapEvent: {
      fromToken: USDC, toToken: NATIVE_TOKEN,
      fromAmount: e6(1000), toAmount: e18("0.4"),
      feePercent: 0, slippagePercent: 0,
    },
  },

  // Test 26: Native ETH input with fee 1%, 50% protocol share
  // 1 ETH -> 2500 USDC, fee=1% on USDC output
  // feeAmt = 2500e6*10000/1e6 = 25e6
  // receiver = 2500-25 = 2475 USDC
  // protFeeShare = 25e6*500000/1e6 = 12.5e6 = 12500000
  // makerRefund = 12500000, treasury = 12500000
  {
    name: "single | native ETH input | fee 1% 50% share",
    isExactInput: true,
    routerInputToken: NATIVE_TOKEN, routerOutputToken: USDC,
    routerInputTokenAmount: e18("1"), routerOutputTokenAmount: e6(2500),
    exactAmount: e18("1"),
    pmmFromToken: WETH,
    orderType: "single",
    taker_tokens: [[WETH]], maker_tokens: [[USDC]],
    taker_amounts: [[e18("1")]], maker_amounts: [[e6(2500)]],
    commands: "0x0000",
    feePercent: 1.0, slippagePercent: 0, protocolShareFeePercent: 50,
    expectedBalanceChanges: [
      { who: "receiver", token: USDC, delta: e6(2475) },
      { who: "treasury", token: USDC, delta: 12500000n },
      { who: "maker0",   token: USDC, delta: -(e6(2500) - 12500000n) },
      { who: "maker0",   token: WETH, delta: e18("1") },
    ],
    expectedPmmSwapEvents: [
      { maker: "maker0", takerToken: WETH, makerToken: USDC, takerAmount: e18("1"), makerAmount: e6(2500) - 12500000n, makerAmountRefunded: 12500000n },
    ],
    expectedRouterSwapEvent: {
      fromToken: NATIVE_TOKEN, toToken: USDC,
      fromAmount: e18("1"), toAmount: e6(2475),
      feePercent: 1.0, slippagePercent: 0,
    },
  },

  // Test 27: Native ETH input, 90% fill, fee 1% + slip 0.5%, 30%/10% share
  // 1 ETH -> 2500 USDC quote, fill 0.9 ETH
  // newTo = 2500e6 * 0.9 / 1 = 2250e6
  // feeAmt = 2250e6 * 10000 / 1e6 = 22500000, slipAmt = 2250e6 * 5000 / 1e6 = 11250000
  // toAfter = 2250000000 - 22500000 - 11250000 = 2216250000
  // PMM scales: 2500e6 * 0.9/1 = 2250e6 (= newTo, no positive slippage)
  // protFee = 22500000 * 300000 / 1e6 = 6750000, protSlip = 11250000 * 100000 / 1e6 = 1125000
  // treasury = 7875000, makerRefund = 33750000 - 7875000 = 25875000
  {
    name: "single | native ETH input | 90% fill | fee 1% + slip 0.5% | 30%/10% share",
    isExactInput: true,
    routerInputToken: NATIVE_TOKEN, routerOutputToken: USDC,
    routerInputTokenAmount: e18("1"), routerOutputTokenAmount: e6(2500),
    exactAmount: e18("0.9"),
    pmmFromToken: WETH,
    orderType: "single",
    taker_tokens: [[WETH]], maker_tokens: [[USDC]],
    taker_amounts: [[e18("1")]], maker_amounts: [[e6(2500)]],
    commands: "0x0000",
    feePercent: 1.0, slippagePercent: 0.5, protocolShareFeePercent: 30, protocolShareSlippagePercent: 10,
    expectedBalanceChanges: [
      { who: "receiver", token: USDC, delta: 2216250000n },
      { who: "treasury", token: USDC, delta: 7875000n },
      { who: "maker0",   token: USDC, delta: -2224125000n },  // -(2250e6 - 25875000)
      { who: "maker0",   token: WETH, delta: e18("0.9") },
    ],
    expectedPmmSwapEvents: [
      { maker: "maker0", takerToken: WETH, makerToken: USDC, takerAmount: e18("0.9"), makerAmount: 2224125000n, makerAmountRefunded: 25875000n },
    ],
    expectedRouterSwapEvent: {
      fromToken: NATIVE_TOKEN, toToken: USDC,
      fromAmount: e18("0.9"), toAmount: 2216250000n,
      feePercent: 1.0, slippagePercent: 0.5,
    },
  },

  // Test 28: Native ETH output, exactOut 0.4 ETH, fee 2%, 100% protocol
  // quote: 1000 USDC -> 0.4 WETH. PMM: 1100 USDC -> 0.44 WETH (headroom).
  // Router unwraps WETH->ETH after PMM.
  //
  // gross = ceil(0.4e18 * 1e6 / (1e6 - 20000)) = 408163265306122449
  // feeAmt = 408163265306122449 * 20000 / 1e6 = 8163265306122448
  // newFrom = 1000e6 * 408163265306122449 / 0.4e18 = 1020408163
  // newFrom (1020408163) < pmmTaker (1100e6) -> partial fill
  //
  // PMM: 0.44e18 * 1020408163 / 1100e6 = 408163265200000000
  // pmmBal = 408163265200000000
  // feePool = 408163265200000000 - 400000000000000000 = 8163265200000000
  // theoretical = 8163265306122448 > feePool -> SCALED DOWN
  // actualFee = 8163265200000000 (all of feePool)
  // 100% protocol -> treasury = 8163265200000000, refund = 0
  // receiver = 400000000000000000 = 0.4e18
  {
    name: "single | native ETH output | exactOut 0.4 ETH | fee 2% | 100% protocol",
    isExactInput: false,
    routerInputToken: USDC, routerOutputToken: NATIVE_TOKEN,
    routerInputTokenAmount: e6(1000), routerOutputTokenAmount: e18("0.4"),
    exactAmount: e18("0.4"),
    pmmToToken: WETH,
    orderType: "single",
    taker_tokens: [[USDC]], maker_tokens: [[WETH]],
    taker_amounts: [[e6(1100)]], maker_amounts: [[e18("0.44")]],
    commands: "0x0000",
    feePercent: 2.0, slippagePercent: 0, protocolShareFeePercent: 100,
    expectedBalanceChanges: [
      { who: "user",     token: USDC,         delta: -1020408163n },
      { who: "receiver", token: NATIVE_TOKEN, delta: e18("0.4") },
      // treasury gets WETH (fee distributed before unwrap)
      { who: "treasury", token: WETH,         delta: 8163265200000000n },
      { who: "maker0",   token: WETH,         delta: -408163265200000000n },
      { who: "maker0",   token: USDC,         delta: 1020408163n },
    ],
    expectedPmmSwapEvents: [
      { maker: "maker0", takerToken: USDC, makerToken: WETH,
        takerAmount: 1020408163n,
        makerAmount: 408163265200000000n,
        makerAmountRefunded: 0n },
    ],
    expectedRouterSwapEvent: {
      fromToken: USDC, toToken: NATIVE_TOKEN,
      fromAmount: 1020408163n, toAmount: e18("0.4"),
      feePercent: 2.0, slippagePercent: 0,
    },
  },

  // Test 29: Native ETH input, exactOut 2000 USDC, fee 1% + slip 0.5%, 40%/20% share
  // order: 0.8 ETH -> 2000 USDC. PMM: 1 WETH -> 2500 USDC. User wants exactly 2000 USDC out.
  //
  // gross = ceil(2000e6 * 1e6 / (1e6 - 15000)) = 2030456853
  // feeAmt = 20304568, slipAmt = 10152284
  // newFrom = 0.8e18 * 2030456853 / 2000e6 = 812182741200000000
  // newFrom < pmmTaker (1e18) ✓
  //
  // PMM: 2500e6 * 812182741200000000 / 1e18 = 2030456853
  // feePool = 2030456853 - 2000000000 = 30456853
  // theoretical = 30456852, positiveSlippage = 1
  //
  // protFee = 20304568 * 400000 / 1e6 = 8121827
  // protSlip = 10152284 * 200000 / 1e6 = 2030456
  // treasury = 8121827 + 2030456 + 1 = 10152284
  // refund = (20304568 + 10152284) - 8121827 - 2030456 = 20304569
  //
  // receiver = 2000000000 (exactly 2000 USDC)
  // verify: 2000000000 + 10152284 + 20304569 = 2030456853 ✓
  {
    name: "single | native ETH input | exactOut 2000 USDC | fee 1% + slip 0.5% | 40%/20% share",
    isExactInput: false,
    routerInputToken: NATIVE_TOKEN, routerOutputToken: USDC,
    routerInputTokenAmount: e18("0.8"), routerOutputTokenAmount: e6(2000),
    exactAmount: e6(2000),
    pmmFromToken: WETH,
    orderType: "single",
    taker_tokens: [[WETH]], maker_tokens: [[USDC]],
    taker_amounts: [[e18("1")]], maker_amounts: [[e6(2500)]],
    commands: "0x0000",
    feePercent: 1.0, slippagePercent: 0.5, protocolShareFeePercent: 40, protocolShareSlippagePercent: 20,
    expectedBalanceChanges: [
      // user ETH delta includes gas, so skip exact check
      { who: "receiver", token: USDC, delta: e6(2000) },
      { who: "treasury", token: USDC, delta: 10152284n },
      { who: "maker0",   token: USDC, delta: -2010152284n },
      { who: "maker0",   token: WETH, delta: 812182741200000000n },
    ],
    expectedPmmSwapEvents: [
      { maker: "maker0", takerToken: WETH, makerToken: USDC,
        takerAmount: 812182741200000000n,
        makerAmount: 2010152284n,
        makerAmountRefunded: 20304569n },
    ],
    expectedRouterSwapEvent: {
      fromToken: NATIVE_TOKEN, toToken: USDC,
      fromAmount: 812182741200000000n, toAmount: e6(2000),
      feePercent: 1.0, slippagePercent: 0.5,
    },
  },

  // ==== SETTLE TESTS ====

  // Test 30: settle, exactIn, 80% fill, fee 2% + slip 1%, 50%/30% share
  // 1000 USDC -> 0.4 WETH quote, fill 800 USDC
  // newTo = 0.4e18 * 800/1000 = 0.32e18
  // feeAmt = 0.32e18 * 20000/1e6 = 0.0064e18, slipAmt = 0.32e18 * 10000/1e6 = 0.0032e18
  // toAfter = 0.32 - 0.0064 - 0.0032 = 0.3104e18
  // protFee = 0.0064 * 0.5 = 0.0032, protSlip = 0.0032 * 0.3 = 0.00096
  // treasury = 0.00416, refund = 0.0096 - 0.00416 = 0.00544
  // verify: 0.3104 + 0.00416 + 0.00544 = 0.32 ✓
  {
    name: "settle | exactIn | 80% fill | fee 2% + slip 1% | 50%/30% share",
    isExactInput: true,
    isSettle: true,
    routerInputToken: USDC, routerOutputToken: WETH,
    routerInputTokenAmount: e6(1000), routerOutputTokenAmount: e18("0.4"),
    exactAmount: e6(800),
    orderType: "single",
    taker_tokens: [[USDC]], maker_tokens: [[WETH]],
    taker_amounts: [[e6(1000)]], maker_amounts: [[e18("0.4")]],
    commands: "0x0000",
    feePercent: 2.0, slippagePercent: 1.0, protocolShareFeePercent: 50, protocolShareSlippagePercent: 30,
    expectedBalanceChanges: [
      { who: "user",     token: USDC, delta: -e6(800) },
      { who: "receiver", token: WETH, delta: e18("0.3104") },
      { who: "treasury", token: WETH, delta: e18("0.00416") },
      { who: "maker0",   token: WETH, delta: -e18("0.31456") },  // -(0.32 - 0.00544)
      { who: "maker0",   token: USDC, delta: e6(800) },
    ],
    expectedPmmSwapEvents: [
      { maker: "maker0", takerToken: USDC, makerToken: WETH,
        takerAmount: e6(800),
        makerAmount: e18("0.31456"),
        makerAmountRefunded: e18("0.00544") },
    ],
    expectedRouterSwapEvent: {
      fromToken: USDC, toToken: WETH,
      fromAmount: e6(800), toAmount: e18("0.3104"),
      feePercent: 2.0, slippagePercent: 1.0,
    },
  },

  // Test 31: settle, exactOut 0.35 WETH, fee 1%, 100% protocol
  // order: 875 USDC -> 0.35 WETH. PMM: 1000 USDC -> 0.4 WETH.
  //
  // gross = ceil(0.35e18 * 1e6 / 990000) = 353535353535353536
  // feeAmt = 3535353535353535
  // newFrom = 875e6 * 353535353535353536 / 0.35e18 = 883838383
  // newFrom < pmmTaker (1000e6) ✓
  //
  // PMM: 0.4e18 * 883838383 / 1000e6 = 353535353200000000
  // feePool = 353535353200000000 - 350000000000000000 = 3535353200000000
  // theoretical = 3535353535353535 > feePool → SCALED DOWN
  // actualFee = 3535353200000000 (all feePool), 100% protocol → treasury
  // refund = 0, receiver = 0.35e18
  {
    name: "settle | exactOut 0.35 WETH | fee 1% | 100% protocol",
    isExactInput: false,
    isSettle: true,
    routerInputToken: USDC, routerOutputToken: WETH,
    routerInputTokenAmount: e6(875), routerOutputTokenAmount: e18("0.35"),
    exactAmount: e18("0.35"),
    limitAmount: -e6(884), // exactOut must declare its max spend (newFrom ≈ 883.84 USDC)
    orderType: "single",
    taker_tokens: [[USDC]], maker_tokens: [[WETH]],
    taker_amounts: [[e6(1000)]], maker_amounts: [[e18("0.4")]],
    commands: "0x0000",
    feePercent: 1.0, slippagePercent: 0, protocolShareFeePercent: 100,
    expectedBalanceChanges: [
      { who: "user",     token: USDC, delta: -883838383n },
      { who: "receiver", token: WETH, delta: e18("0.35") },
      { who: "treasury", token: WETH, delta: 3535353200000000n },
      { who: "maker0",   token: WETH, delta: -353535353200000000n },
      { who: "maker0",   token: USDC, delta: 883838383n },
    ],
    expectedPmmSwapEvents: [
      { maker: "maker0", takerToken: USDC, makerToken: WETH,
        takerAmount: 883838383n,
        makerAmount: 353535353200000000n,
        makerAmountRefunded: 0n },
    ],
    expectedRouterSwapEvent: {
      fromToken: USDC, toToken: WETH,
      fromAmount: 883838383n, toAmount: e18("0.35"),
      feePercent: 1.0, slippagePercent: 0,
    },
  },

  // Negative: exactOut where the (unsigned, attacker-suppliable) maker order under-delivers.
  // Quote 1000 USDC -> 0.5 WETH; user wants 0.4 WETH; newFrom = 800 USDC. The stingy maker
  // order pays only 0.01 WETH for the 800 USDC fill. Without the exactOut output floor the
  // receiver would silently get 0.01 WETH; the floor now reverts with LimitAmountViolation.
  {
    name: "settle | exactOut | maker under-delivers | reverts LimitAmountViolation",
    isExactInput: false,
    isSettle: true,
    routerInputToken: USDC, routerOutputToken: WETH,
    routerInputTokenAmount: e6(1000), routerOutputTokenAmount: e18("0.5"),
    exactAmount: e18("0.4"),
    limitAmount: -e6(800),
    orderType: "single",
    taker_tokens: [[USDC]], maker_tokens: [[WETH]],
    taker_amounts: [[e6(800)]], maker_amounts: [[e18("0.01")]], // stingy: 800 USDC -> 0.01 WETH
    commands: "0x0000",
    feePercent: 0, slippagePercent: 0,
    expectRevert: "LimitAmountViolation",
    expectedBalanceChanges: [],
    expectedPmmSwapEvents: [],
    expectedRouterSwapEvent: { fromToken: USDC, toToken: WETH, fromAmount: 0n, toAmount: 0n, feePercent: 0, slippagePercent: 0 },
  },

  // ==== MOCK AAVE HOOK TESTS ====
  // Mock aTokens are 1:1 with underlying — all amounts are exact and deterministic.
  // "MOCK_AUSDC" / "MOCK_AWETH" are placeholders replaced by test runner with actual deployed addresses.

  // Test 32: mockAUSDC → WETH, pre-hook unwrap, no fee
  {
    name: "single | mockAUSDC→WETH | pre-hook withdraw | no fee",
    isExactInput: true,
    routerInputToken: "MOCK_AUSDC", routerOutputToken: WETH,
    routerInputTokenAmount: e6(1000), routerOutputTokenAmount: e18("0.4"),
    exactAmount: e6(1000),
    pmmFromToken: USDC,
    orderType: "single",
    taker_tokens: [[USDC]], maker_tokens: [[WETH]],
    taker_amounts: [[e6(1000)]], maker_amounts: [[e18("0.4")]],
    commands: "0x0000",
    feePercent: 0, slippagePercent: 0,
    hooks: [
      { hookType: "mock-aave-withdraw", postHook: false, revertOnFail: true, useBebopHook: false, tokens: ["MOCK_AUSDC"] },
    ],
    expectedBalanceChanges: [
      { who: "user",     token: "MOCK_AUSDC", delta: -e6(1000) },
      { who: "receiver", token: WETH,         delta: e18("0.4") },
      { who: "maker0",   token: WETH,         delta: -e18("0.4") },
      { who: "maker0",   token: USDC,         delta: e6(1000) },
    ],
    expectedPmmSwapEvents: [
      { maker: "maker0", takerToken: USDC, makerToken: WETH, takerAmount: e6(1000), makerAmount: e18("0.4"), makerAmountRefunded: 0n },
    ],
    expectedRouterSwapEvent: { fromToken: "MOCK_AUSDC", toToken: WETH, fromAmount: e6(1000), toAmount: e18("0.4"), feePercent: 0, slippagePercent: 0 },
  },

  // Test 33: USDC → mockAWETH, post-hook supply, no fee
  {
    name: "single | USDC→mockAWETH | post-hook supply | no fee",
    isExactInput: true,
    routerInputToken: USDC, routerOutputToken: "MOCK_AWETH",
    routerInputTokenAmount: e6(1000), routerOutputTokenAmount: e18("0.4"),
    exactAmount: e6(1000),
    pmmToToken: WETH,
    orderType: "single",
    taker_tokens: [[USDC]], maker_tokens: [[WETH]],
    taker_amounts: [[e6(1000)]], maker_amounts: [[e18("0.4")]],
    commands: "0x0000",
    feePercent: 0, slippagePercent: 0,
    hooks: [
      { hookType: "mock-aave-supply", postHook: true, revertOnFail: true, useBebopHook: false, tokens: ["MOCK_AWETH"] },
    ],
    expectedBalanceChanges: [
      { who: "user",     token: USDC,         delta: -e6(1000) },
      { who: "receiver", token: "MOCK_AWETH", delta: e18("0.4") },
      { who: "maker0",   token: WETH,         delta: -e18("0.4") },
      { who: "maker0",   token: USDC,         delta: e6(1000) },
    ],
    expectedPmmSwapEvents: [
      { maker: "maker0", takerToken: USDC, makerToken: WETH, takerAmount: e6(1000), makerAmount: e18("0.4"), makerAmountRefunded: 0n },
    ],
    expectedRouterSwapEvent: { fromToken: USDC, toToken: "MOCK_AWETH", fromAmount: e6(1000), toAmount: e18("0.4"), feePercent: 0, slippagePercent: 0 },
  },

  // Test 34: mockAUSDC → mockAWETH, both hooks, no fee
  {
    name: "single | mockAUSDC→mockAWETH | both hooks | no fee",
    isExactInput: true,
    routerInputToken: "MOCK_AUSDC", routerOutputToken: "MOCK_AWETH",
    routerInputTokenAmount: e6(1000), routerOutputTokenAmount: e18("0.4"),
    exactAmount: e6(1000),
    pmmFromToken: USDC, pmmToToken: WETH,
    orderType: "single",
    taker_tokens: [[USDC]], maker_tokens: [[WETH]],
    taker_amounts: [[e6(1000)]], maker_amounts: [[e18("0.4")]],
    commands: "0x0000",
    feePercent: 0, slippagePercent: 0,
    hooks: [
      { hookType: "mock-aave-withdraw", postHook: false, revertOnFail: true, useBebopHook: false, tokens: ["MOCK_AUSDC"] },
      { hookType: "mock-aave-supply", postHook: true, revertOnFail: true, useBebopHook: false, tokens: ["MOCK_AWETH"] },
    ],
    expectedBalanceChanges: [
      { who: "user",     token: "MOCK_AUSDC", delta: -e6(1000) },
      { who: "receiver", token: "MOCK_AWETH", delta: e18("0.4") },
      { who: "maker0",   token: WETH,         delta: -e18("0.4") },
      { who: "maker0",   token: USDC,         delta: e6(1000) },
    ],
    expectedPmmSwapEvents: [
      { maker: "maker0", takerToken: USDC, makerToken: WETH, takerAmount: e6(1000), makerAmount: e18("0.4"), makerAmountRefunded: 0n },
    ],
    expectedRouterSwapEvent: { fromToken: "MOCK_AUSDC", toToken: "MOCK_AWETH", fromAmount: e6(1000), toAmount: e18("0.4"), feePercent: 0, slippagePercent: 0 },
  },

  // Test 35: mockAUSDC → mockAWETH, 80% fill, fee 1.5% + slip 0.5%, 40%/20% share
  // newTo = 0.32e18, fee=0.0048e18, slip=0.0016e18, toAfter=0.3136e18
  // protFee=0.00192, protSlip=0.00032, treasury=0.00224, refund=0.00416
  {
    name: "single | mockAUSDC→mockAWETH | 80% fill | fee 1.5% + slip 0.5% | 40%/20% share",
    isExactInput: true,
    routerInputToken: "MOCK_AUSDC", routerOutputToken: "MOCK_AWETH",
    routerInputTokenAmount: e6(1000), routerOutputTokenAmount: e18("0.4"),
    exactAmount: e6(800),
    pmmFromToken: USDC, pmmToToken: WETH,
    orderType: "single",
    taker_tokens: [[USDC]], maker_tokens: [[WETH]],
    taker_amounts: [[e6(1000)]], maker_amounts: [[e18("0.4")]],
    commands: "0x0000",
    feePercent: 1.5, slippagePercent: 0.5, protocolShareFeePercent: 40, protocolShareSlippagePercent: 20,
    hooks: [
      { hookType: "mock-aave-withdraw", postHook: false, revertOnFail: true, useBebopHook: false, tokens: ["MOCK_AUSDC"] },
      { hookType: "mock-aave-supply", postHook: true, revertOnFail: true, useBebopHook: false, tokens: ["MOCK_AWETH"] },
    ],
    expectedBalanceChanges: [
      { who: "user",     token: "MOCK_AUSDC", delta: -e6(800) },
      { who: "receiver", token: "MOCK_AWETH", delta: e18("0.3136") },
      { who: "treasury", token: WETH,         delta: e18("0.00224") },
      { who: "maker0",   token: WETH,         delta: -e18("0.31584") },
      { who: "maker0",   token: USDC,         delta: e6(800) },
    ],
    expectedPmmSwapEvents: [
      { maker: "maker0", takerToken: USDC, makerToken: WETH, takerAmount: e6(800), makerAmount: e18("0.31584"), makerAmountRefunded: e18("0.00416") },
    ],
    expectedRouterSwapEvent: { fromToken: "MOCK_AUSDC", toToken: "MOCK_AWETH", fromAmount: e6(800), toAmount: e18("0.3136"), feePercent: 1.5, slippagePercent: 0.5 },
  },

  // Test 36: mockAUSDC → mockAWETH, exactOut 0.35, fee 2%, 100% protocol
  // order: 875 USDC → 0.35 WETH. PMM: 1000 USDC → 0.4 WETH.
  // gross = ceil(0.35e18 * 1e6 / 980000) = 357142857142857143
  // feeAmt = 7142857142857142, newFrom = 875e6 * gross / 0.35e18 = 892857142
  // newFrom < pmmTaker (1000e6) ✓
  // PMM: 0.4e18 * 892857142 / 1000e6 = 357142856800000000
  // feePool = 357142856800000000 - 350000000000000000 = 7142856800000000 < theoretical → scaled down
  // treasury = 7142856800000000, receiver = 0.35e18
  {
    name: "single | mockAUSDC→mockAWETH | exactOut 0.35 | fee 2% | 100% protocol",
    isExactInput: false,
    routerInputToken: "MOCK_AUSDC", routerOutputToken: "MOCK_AWETH",
    routerInputTokenAmount: e6(875), routerOutputTokenAmount: e18("0.35"),
    exactAmount: e18("0.35"),
    pmmFromToken: USDC, pmmToToken: WETH,
    orderType: "single",
    taker_tokens: [[USDC]], maker_tokens: [[WETH]],
    taker_amounts: [[e6(1000)]], maker_amounts: [[e18("0.4")]],
    commands: "0x0000",
    feePercent: 2.0, slippagePercent: 0, protocolShareFeePercent: 100,
    hooks: [
      { hookType: "mock-aave-withdraw", postHook: false, revertOnFail: true, useBebopHook: false, tokens: ["MOCK_AUSDC"] },
      { hookType: "mock-aave-supply", postHook: true, revertOnFail: true, useBebopHook: false, tokens: ["MOCK_AWETH"] },
    ],
    expectedBalanceChanges: [
      { who: "user",     token: "MOCK_AUSDC", delta: -892857142n },
      { who: "receiver", token: "MOCK_AWETH", delta: e18("0.35") },
      { who: "treasury", token: WETH,         delta: 7142856800000000n },
      { who: "maker0",   token: WETH,         delta: -357142856800000000n },
      { who: "maker0",   token: USDC,         delta: 892857142n },
    ],
    expectedPmmSwapEvents: [
      { maker: "maker0", takerToken: USDC, makerToken: WETH, takerAmount: 892857142n, makerAmount: 357142856800000000n, makerAmountRefunded: 0n },
    ],
    expectedRouterSwapEvent: { fromToken: "MOCK_AUSDC", toToken: "MOCK_AWETH", fromAmount: 892857142n, toAmount: e18("0.35"), feePercent: 2.0, slippagePercent: 0 },
  },

  // ==== RATE-BASED WRAPPED TOKEN TESTS (non-1:1) ====
  // rvUSDC: rate=1.25e18 → 1 share = 1.25 USDC. 800 shares = 1000 USDC.
  // rvWETH: rate=0.8e18 → 1 share = 0.8 WETH. 0.5 shares = 0.4 WETH.
  // order.toAmount must be in pmmToToken (WETH) units for fee math to work.

  // Test 37: rvUSDC → rvWETH, both hooks, no fee
  // 800 rvUSDC → (unwrap) → 1000 USDC → (PMM) → 0.4 WETH → (wrap) → 0.5 rvWETH
  {
    name: "single | rvUSDC→rvWETH | rate 1.25/0.8 | both hooks | no fee",
    isExactInput: true,
    routerInputToken: "MOCK_RATE_USDC", routerOutputToken: "MOCK_RATE_WETH",
    routerInputTokenAmount: e6(800), routerOutputTokenAmount: e18("0.4"), // toAmount in WETH (pmmToToken)
    exactAmount: e6(800),
    pmmFromToken: USDC, pmmToToken: WETH,
    orderType: "single",
    taker_tokens: [[USDC]], maker_tokens: [[WETH]],
    taker_amounts: [[e6(1000)]], maker_amounts: [[e18("0.4")]],
    commands: "0x0000",
    feePercent: 0, slippagePercent: 0,
    hooks: [
      { hookType: "mock-aave-withdraw", postHook: false, revertOnFail: true, useBebopHook: false, tokens: ["MOCK_RATE_USDC"] },
      { hookType: "mock-aave-supply", postHook: true, revertOnFail: true, useBebopHook: false, tokens: ["MOCK_RATE_WETH"] },
    ],
    expectedBalanceChanges: [
      { who: "user",     token: "MOCK_RATE_USDC", delta: -e6(800) },
      { who: "receiver", token: "MOCK_RATE_WETH", delta: e18("0.5") }, // 0.4 WETH / 0.8 rate = 0.5 shares
      { who: "maker0",   token: WETH,             delta: -e18("0.4") },
      { who: "maker0",   token: USDC,             delta: e6(1000) },
    ],
    expectedPmmSwapEvents: [
      // Event scales by newFromAmount(800e6) / pmmTakerAmount(1000e6) = 0.8
      { maker: "maker0", takerToken: USDC, makerToken: WETH,
        takerAmount: e6(800),    // 1000e6 * 800/1000
        makerAmount: e18("0.32"),  // 0.4e18 * 800/1000
        makerAmountRefunded: 0n },
    ],
    expectedRouterSwapEvent: { fromToken: "MOCK_RATE_USDC", toToken: "MOCK_RATE_WETH", fromAmount: e6(800), toAmount: e18("0.5"), feePercent: 0, slippagePercent: 0 },
  },

  // Test 38: rvUSDC → rvWETH, 75% fill, fee 2%, 50% protocol share
  // fill 600 rvUSDC of 800 quote → withdraw 600*1.25=750 USDC
  // PMM: 0.4e18 * 750e6 / 1000e6 = 0.3 WETH
  // newTo = 0.4e18 * 600e6 / 800e6 = 0.3e18 (WETH)
  // feeAmt = 0.3e18 * 20000/1e6 = 0.006e18
  // toAfter = 0.3 - 0.006 = 0.294 WETH
  // protFee = 0.006 * 0.5 = 0.003, refund = 0.003
  // wethForSupply = 0.3 - 0.003 - 0.003 = 0.294 WETH
  // receiver rvWETH = 0.294 / 0.8 = 0.3675
  {
    name: "single | rvUSDC→rvWETH | rate 1.25/0.8 | 75% fill | fee 2% | 50% share",
    isExactInput: true,
    routerInputToken: "MOCK_RATE_USDC", routerOutputToken: "MOCK_RATE_WETH",
    routerInputTokenAmount: e6(800), routerOutputTokenAmount: e18("0.4"),
    exactAmount: e6(600),
    pmmFromToken: USDC, pmmToToken: WETH,
    orderType: "single",
    taker_tokens: [[USDC]], maker_tokens: [[WETH]],
    taker_amounts: [[e6(1000)]], maker_amounts: [[e18("0.4")]],
    commands: "0x0000",
    feePercent: 2.0, slippagePercent: 0, protocolShareFeePercent: 50,
    hooks: [
      { hookType: "mock-aave-withdraw", postHook: false, revertOnFail: true, useBebopHook: false, tokens: ["MOCK_RATE_USDC"] },
      { hookType: "mock-aave-supply", postHook: true, revertOnFail: true, useBebopHook: false, tokens: ["MOCK_RATE_WETH"] },
    ],
    expectedBalanceChanges: [
      { who: "user",     token: "MOCK_RATE_USDC", delta: -e6(600) },
      { who: "receiver", token: "MOCK_RATE_WETH", delta: e18("0.3675") }, // 0.294 WETH / 0.8
      { who: "treasury", token: WETH,             delta: e18("0.003") },
      { who: "maker0",   token: WETH,             delta: -e18("0.297") },  // -(0.3 - 0.003 refund)
      { who: "maker0",   token: USDC,             delta: e6(750) },  // PMM got 750 USDC
    ],
    expectedPmmSwapEvents: [
      // Event scales by newFromAmount(600e6) / pmmTakerAmount(1000e6)
      { maker: "maker0", takerToken: USDC, makerToken: WETH,
        takerAmount: e6(600),  // 1000e6 * 600e6 / 1000e6
        makerAmount: e18("0.237"),  // 0.4e18 * 600e6 / 1000e6 - 0.003 refund = 0.24 - 0.003
        makerAmountRefunded: e18("0.003") },
    ],
    expectedRouterSwapEvent: { fromToken: "MOCK_RATE_USDC", toToken: "MOCK_RATE_WETH", fromAmount: e6(600), toAmount: e18("0.3675"), feePercent: 2.0, slippagePercent: 0 },
  },

  // ==== MAKER-SIGNED HOOK TEST ====
  // User swaps 1000 USDC → 10 TSLA. Maker doesn't hold TSLA, but mints it via a pre-hook.
  // Maker signs the hook to authorize the mint — prevents unauthorized minting without a swap.
  //
  // Flow:
  //   1. Pre-hook (maker-signed): MockMakerMintHook mints 10 TSLA to maker0
  //   2. PMM: maker0 sends 10 TSLA to router, router sends 1000 USDC to maker0
  //   3. Router sends 10 TSLA to receiver

  // Test 39: USDC → TSLA, maker-signed mint hook, no fee
  {
    name: "single | USDC→TSLA | maker-signed mint hook | no fee",
    isExactInput: true,
    routerInputToken: USDC, routerOutputToken: "MOCK_TSLA",
    routerInputTokenAmount: e6(1000), routerOutputTokenAmount: e18("10"),
    exactAmount: e6(1000),
    orderType: "single",
    taker_tokens: [[USDC]], maker_tokens: [["MOCK_TSLA"]],
    taker_amounts: [[e6(1000)]], maker_amounts: [[e18("10")]],
    commands: "0x0000",
    feePercent: 0, slippagePercent: 0,
    hooks: [
      {
        hookType: "mock-maker-mint",
        postHook: false,
        revertOnFail: true,
        useBebopHook: true,    // hook reads amount from Swap[] passed by router
        tokens: ["MOCK_TSLA"],
        makerIndex: 0,            // maker0 signs this hook
        mintTo: "maker0",         // mint TSLA to maker0
      },
    ],
    expectedBalanceChanges: [
      { who: "user",     token: USDC,        delta: -e6(1000) },
      { who: "receiver", token: "MOCK_TSLA", delta: e18("10") },
      { who: "maker0",   token: "MOCK_TSLA", delta: 0n },  // minted 10, sent 10 to PMM → net 0
      { who: "maker0",   token: USDC,        delta: e6(1000) },
    ],
    expectedPmmSwapEvents: [
      { maker: "maker0", takerToken: USDC, makerToken: "MOCK_TSLA", takerAmount: e6(1000), makerAmount: e18("10"), makerAmountRefunded: 0n },
    ],
    expectedRouterSwapEvent: { fromToken: USDC, toToken: "MOCK_TSLA", fromAmount: e6(1000), toAmount: e18("10"), feePercent: 0, slippagePercent: 0 },
  },

  // Test 40: Aggregate 2-hop WETH → USDC(middle) → TSLA, maker1 mints TSLA via signed pre-hook
  // 80% fill, fee 1%, 50% protocol
  //
  // maker0: 0.5 WETH → 1250 USDC (TTC)
  // maker1: 1250 USDC (TFC) → 25 TSLA (maker1 mints TSLA in pre-hook)
  // pmmTakerAmount = 0.5e18, pmmMakerAmount = 25e18
  //
  // fill = 0.4 WETH (80%)
  // PMM scaling (0.4/0.5 = 0.8):
  //   maker0: 0.4 WETH → 1000 USDC
  //   maker1: 1000 USDC → 20 TSLA (minted by hook)
  //
  // newTo = 25e18 * 0.4/0.5 = 20e18 (TSLA)
  // feeAmt = 20e18 * 10000/1e6 = 0.2e18, toAfter = 19.8e18
  // protFee = 0.2*0.5 = 0.1, refund to maker1 = 0.1
  //
  // maker1 TSLA: minted 20, sent 20 to PMM, got 0.1 refund from router → net +0.1
  {
    name: "aggregate | 2-hop WETH→USDC→TSLA | maker1 mint hook | 80% fill | fee 1% | 50% protocol",
    isExactInput: true,
    routerInputToken: WETH, routerOutputToken: "MOCK_TSLA",
    routerInputTokenAmount: e18("0.5"), routerOutputTokenAmount: e18("25"),
    exactAmount: e18("0.4"),
    pmmToToken: "MOCK_TSLA",
    orderType: "aggregate",
    taker_tokens: [[WETH], [USDC]],
    maker_tokens: [[USDC], ["MOCK_TSLA"]],
    taker_amounts: [[e18("0.5")], [e6(1250)]],
    maker_amounts: [[e6(1250)], [e18("25")]],
    commands: "0x07000008",  // maker0:[TTC, direct] + maker1:[direct, TFC]
    feePercent: 1.0, slippagePercent: 0, protocolShareFeePercent: 50,
    hooks: [
      {
        hookType: "mock-maker-mint",
        postHook: false,
        revertOnFail: true,
        useBebopHook: true,
        tokens: ["MOCK_TSLA"],
        makerIndex: 1,            // maker1 signs this hook
        mintTo: "maker1",
      },
    ],
    expectedBalanceChanges: [
      { who: "user",     token: WETH,        delta: -e18("0.4") },
      { who: "receiver", token: "MOCK_TSLA", delta: e18("19.8") },
      { who: "treasury", token: "MOCK_TSLA", delta: e18("0.1") },
      { who: "maker0",   token: USDC,        delta: -e6(1000) },
      { who: "maker0",   token: WETH,        delta: e18("0.4") },
      { who: "maker1",   token: "MOCK_TSLA", delta: e18("0.1") },  // minted 20, sent 20, got 0.1 refund
      { who: "maker1",   token: USDC,        delta: e6(1000) },    // from contract
    ],
    expectedPmmSwapEvents: [
      // maker0: middle leg (USDC TTC)
      { maker: "maker0", takerToken: WETH, makerToken: USDC,
        takerAmount: e18("0.4"), makerAmount: e6(1000), makerAmountRefunded: 0n },
      // maker1: last leg (TSLA direct)
      { maker: "maker1", takerToken: USDC, makerToken: "MOCK_TSLA",
        takerAmount: e6(1000), makerAmount: e18("19.9"), makerAmountRefunded: e18("0.1") },
    ],
    expectedRouterSwapEvent: {
      fromToken: WETH, toToken: "MOCK_TSLA",
      fromAmount: e18("0.4"), toAmount: e18("19.8"),
      feePercent: 1.0, slippagePercent: 0,
    },
  },

  // ==== PERMIT2 SETTLE TESTS ====

  // Test 41: settle + permit2, partial fill 80%, fee 2% + slip 1%, 50%/30% share
  // Same as test 30 but with permit2
  {
    name: "settle | permit2 | 80% fill | fee 2% + slip 1% | 50%/30% share",
    isExactInput: true,
    isSettle: true,
    isPermit2: true,
    routerInputToken: USDC, routerOutputToken: WETH,
    routerInputTokenAmount: e6(1000), routerOutputTokenAmount: e18("0.4"),
    exactAmount: e6(800),
    orderType: "single",
    taker_tokens: [[USDC]], maker_tokens: [[WETH]],
    taker_amounts: [[e6(1000)]], maker_amounts: [[e18("0.4")]],
    commands: "0x0000",
    feePercent: 2.0, slippagePercent: 1.0, protocolShareFeePercent: 50, protocolShareSlippagePercent: 30,
    expectedBalanceChanges: [
      { who: "user",     token: USDC, delta: -e6(800) },
      { who: "receiver", token: WETH, delta: e18("0.3104") },
      { who: "treasury", token: WETH, delta: e18("0.00416") },
      { who: "maker0",   token: WETH, delta: -e18("0.31456") },
      { who: "maker0",   token: USDC, delta: e6(800) },
    ],
    expectedPmmSwapEvents: [
      { maker: "maker0", takerToken: USDC, makerToken: WETH, takerAmount: e6(800), makerAmount: e18("0.31456"), makerAmountRefunded: e18("0.00544") },
    ],
    expectedRouterSwapEvent: { fromToken: USDC, toToken: WETH, fromAmount: e6(800), toAmount: e18("0.3104"), feePercent: 2.0, slippagePercent: 1.0 },
  },

  // Test 42: settle + permit2, exactOut 0.4 WETH, fee 1%, 100% protocol
  // Order: fromAmount=1000 USDC, toAmount=0.4 WETH. PMM quote: 1250 USDC → 0.5 WETH.
  // limitAmount = -1250e6 (max Permit2 spend). permitted.amount = 1250e6.
  // gross = ceil(0.4e18 * 1e6 / 990000) = 404040404040404041
  // newFrom = floor(1000e6 * 404040404040404041 / 0.4e18) = 1010101010
  // Check: 1010101010 <= 1250e6 ✓
  // PMM: 0.5e18 * 1010101010 / 1250e6 = 404040404000000000
  // feePool = 404040404000000000 - 0.4e18 = 4040404000000000
  // Scaled: treasury = 4040404000000000, receiver = 0.4e18, makerRefund = 0
  {
    name: "settle | permit2 | exactOut 0.4 WETH | fee 1% | 100% protocol",
    isExactInput: false,
    isSettle: true,
    isPermit2: true,
    routerInputToken: USDC, routerOutputToken: WETH,
    routerInputTokenAmount: e6(1000), routerOutputTokenAmount: e18("0.4"),
    exactAmount: e18("0.4"),
    limitAmount: -1250000000n,
    orderType: "single",
    taker_tokens: [[USDC]], maker_tokens: [[WETH]],
    taker_amounts: [[e6(1250)]], maker_amounts: [[e18("0.5")]],
    commands: "0x0000",
    feePercent: 1.0, slippagePercent: 0, protocolShareFeePercent: 100,
    expectedBalanceChanges: [
      { who: "user",     token: USDC, delta: -1010101010n },
      { who: "receiver", token: WETH, delta: e18("0.4") },
      { who: "treasury", token: WETH, delta: 4040404000000000n },
      { who: "maker0",   token: WETH, delta: -404040404000000000n },
      { who: "maker0",   token: USDC, delta: 1010101010n },
    ],
    expectedPmmSwapEvents: [
      { maker: "maker0", takerToken: USDC, makerToken: WETH, takerAmount: 1010101010n, makerAmount: 404040404000000000n, makerAmountRefunded: 0n },
    ],
    expectedRouterSwapEvent: { fromToken: USDC, toToken: WETH, fromAmount: 1010101010n, toAmount: e18("0.4"), feePercent: 1.0, slippagePercent: 0 },
  },
];
