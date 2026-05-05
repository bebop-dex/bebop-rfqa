import { expect } from "chai";
import { ethers } from "hardhat";
import { BebopOracle } from "../typechain-types";

const USDC = "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48"; // 6 dec
const WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2"; // 18 dec
const DAI  = "0x6B175474E89094C44Da98b954EedeAC495271d0F"; // 18 dec
const MOG  = "0xaaeE1A9723aaDB7afA2810263653A34bA2C21C7a"; // 18 dec
const WBTC = "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599"; // 8 dec
const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7"; // 6 dec

// Real mainnet pools at block 22100000
const V3_005_POOL  = "0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640"; // USDC/WETH 0.05%, t0=USDC t1=WETH
const V3_030_POOL  = "0x8ad599c3A0ff1De082011EFDDc58f1908eb6e6D8"; // USDC/WETH 0.3%
const V2_POOL      = "0xB4e16d0168e52d35CaCD2c6185b44281Ec28C9Dc"; // USDC/WETH V2
const DAI_USDC_V3  = "0x5777d92f208679DB4b9778590Fa3CAB3aC9e2168"; // t0=DAI, t1=USDC
const DAI_WETH_V3  = "0xC2e9F25Be6257c210d7Adf0D4Cd6E3E881ba25f8"; // t0=DAI, t1=WETH
const MOG_WETH_V2  = "0xc2eab7d33d3cb97692ecb231a5d0e4a649cb539d"; // V2 pair, t0=MOG, t1=WETH
const WBTC_WETH_V3 = "0x4585fe77225b41b697c938b018e2ac67ac5a20c0"; // t0=WBTC, t1=WETH
const USDT_WBTC_V3 = "0x56534741cd8b152df6d48adf7ac51f75169a83b2"; // t0=WBTC, t1=USDT

const POOL_UNI_V3 = 0;
const POOL_UNI_V2 = 1;

// tokenConfig from caller's from/to perspective
const TC_FROM_TO_DIRECT = 1;  // t0=to,   t1=from          — direct
const TC_FROM_TO_INVERT = 0;  // t0=from, t1=to            — invert
const TC_FROM_MID_DIRECT = 3; // t0=middle, t1=from        — direct (→ from per middle)
const TC_FROM_MID_INVERT = 2; // t0=from,   t1=middle      — invert (→ from per middle)
const TC_MID_TO_DIRECT = 5;   // t0=to,     t1=middle      — direct (→ middle per to)
const TC_MID_TO_INVERT = 4;   // t0=middle, t1=to          — invert (→ middle per to)

const ZERO_ADDR = ethers.ZeroAddress;
const POOL_INFO_SIZE = 48;

// ==================== Helpers ====================

function encodePoolInfo(
  poolType: number,
  tokenConfig: number,
  dec0: number,
  dec1: number,
  fee: number,
  pool: string,
  middleToken: string = ZERO_ADDR,
): string {
  const buf = Buffer.alloc(POOL_INFO_SIZE);
  buf[0] = poolType;
  buf[1] = tokenConfig;
  buf[2] = dec0;
  buf[3] = dec1;
  buf.writeUInt32BE(fee, 4);
  Buffer.from(pool.slice(2), "hex").copy(buf, 8);
  Buffer.from(middleToken.slice(2), "hex").copy(buf, 28);
  return "0x" + buf.toString("hex");
}

function encodeMidPriceExtraInfo(pools: string[]): string {
  const header = Buffer.alloc(1);
  header[0] = pools.length;
  const poolBytes = pools.map(p => p.slice(2)).join("");
  return "0x" + header.toString("hex") + poolBytes;
}

function encodeSlippageExtraInfo(
  offchainMidPrice: bigint,
  minSlippage: number,
  maxSlippage: number,
  pools: string[],
): string {
  const priceBuf = Buffer.alloc(32);
  const priceHex = offchainMidPrice.toString(16).padStart(64, "0");
  Buffer.from(priceHex, "hex").copy(priceBuf);
  const metaBuf = Buffer.alloc(5);
  metaBuf.writeUInt16BE(minSlippage, 0);
  metaBuf.writeUInt16BE(maxSlippage, 2);
  metaBuf[4] = pools.length;
  const poolBytes = pools.map(p => p.slice(2)).join("");
  return "0x" + priceBuf.toString("hex") + metaBuf.toString("hex") + poolBytes;
}

// Convenience wrappers for pools used frequently
const poolV3_005_fromUSDCtoWETH = (tc: number) => encodePoolInfo(POOL_UNI_V3, tc, 6, 18, 500, V3_005_POOL);
const poolV3_030_fromUSDCtoWETH = (tc: number) => encodePoolInfo(POOL_UNI_V3, tc, 6, 18, 3000, V3_030_POOL);
const poolV2_fromUSDCtoWETH = (tc: number) => encodePoolInfo(POOL_UNI_V2, tc, 6, 18, 3000, V2_POOL);

// ==================== Logging helpers ====================

/// Format a scaled-1e18 price as a human-readable decimal.
/// Uses scientific notation for very small values (< 1e-4) to preserve significant digits.
function fmtPrice(p: bigint): string {
  const SCALE = 10n ** 18n;
  if (p === 0n) return "0";
  const whole = p / SCALE;
  const frac = p % SCALE;
  // For very small values, use scientific notation so significant digits don't get lost
  if (whole === 0n && frac > 0n) {
    // Find position of first non-zero digit in the 18-char fraction
    const fracStr = frac.toString().padStart(18, "0");
    const firstNonZero = fracStr.search(/[1-9]/);
    // Take up to 4 significant digits
    const sigDigits = fracStr.slice(firstNonZero, firstNonZero + 4).replace(/0+$/, "") || "0";
    const exponent = -(firstNonZero + 1);
    const mantissa = sigDigits.length === 1
      ? sigDigits
      : `${sigDigits[0]}.${sigDigits.slice(1)}`;
    return `${mantissa}e${exponent}`;
  }
  // Normal formatting for values ≥ 1
  let fracStr = frac.toString().padStart(18, "0");
  fracStr = fracStr.replace(/0+$/, "");
  if (fracStr.length === 0) return whole.toString();
  if (fracStr.length > 8) fracStr = fracStr.slice(0, 8);
  return `${whole.toString()}.${fracStr}`;
}

/// Log a computed mid price in both raw and human form.
function logPrice(label: string, price: bigint, units: string) {
  console.log(`      ${label.padEnd(32)} = ${price.toString().padStart(44)}  ≈ ${fmtPrice(price)} ${units}`);
}

/// Log roundtrip forward*reverse deviation from 1e36.
/// Shows both prices (raw + formatted) and the absolute/relative error.
function logRoundtrip(label: string, fwd: bigint, rev: bigint) {
  const ONE_E36 = 10n ** 36n;
  const product = fwd * rev;
  const diff = product - ONE_E36;
  const absDiff = diff < 0n ? -diff : diff;
  const sign = diff < 0n ? "-" : "+";
  const relErr = absDiff === 0n ? 0 : Number(absDiff) / Number(ONE_E36);
  const relStr = relErr === 0 ? "0" : `${sign}${relErr.toExponential(3)}`;
  console.log(`      ${label}`);
  console.log(`        fwd = ${fwd.toString().padStart(44)}  ≈ ${fmtPrice(fwd)}`);
  console.log(`        rev = ${rev.toString().padStart(44)}  ≈ ${fmtPrice(rev)}`);
  console.log(`        fwd × rev = 1e36 ${sign} ${absDiff.toString().padStart(30)}   (rel err ${relStr})`);
}

describe("BebopOracle", function () {
  let oracle: BebopOracle;

  before(async function () {
    oracle = await (await ethers.getContractFactory("BebopOracle")).deploy();
  });

  // ==================== getMidPrice ====================
  // Prices are "from_full per to_full × 1e18". For USDC↔WETH at ETH ≈ $1988:
  //   USDC→WETH ≈ 1988e18 (USDC per 1 WETH, since toToken is the numerator we invert)
  //   wait: from_per_to = from units per 1 to unit. For USDC→WETH, from=USDC, to=WETH,
  //   so from_per_to = USDC per WETH ≈ 1988 → scaled 1e18 ≈ 2e21.

  describe("getMidPrice", function () {
    it("single V3 pool — USDC→WETH (invert)", async function () {
      const price = await oracle.getMidPrice(USDC, WETH, 0, 0, encodeMidPriceExtraInfo([poolV3_005_fromUSDCtoWETH(TC_FROM_TO_INVERT)]));
      logPrice("USDC→WETH (V3 0.05%)", price, "USDC per WETH");
      expect(price).to.equal(1988001195578468716813n);
    });

    it("single V2 pool — USDC→WETH (invert)", async function () {
      const price = await oracle.getMidPrice(USDC, WETH, 0, 0, encodeMidPriceExtraInfo([poolV2_fromUSDCtoWETH(TC_FROM_TO_INVERT)]));
      logPrice("USDC→WETH (V2)", price, "USDC per WETH");
      expect(price).to.equal(1984011048782905447623n);
    });

    it("multi-pool average — V3 0.05% + V3 0.3% + V2", async function () {
      const pools = [
        poolV3_005_fromUSDCtoWETH(TC_FROM_TO_INVERT),
        poolV3_030_fromUSDCtoWETH(TC_FROM_TO_INVERT),
        poolV2_fromUSDCtoWETH(TC_FROM_TO_INVERT),
      ];
      const price = await oracle.getMidPrice(USDC, WETH, 0, 0, encodeMidPriceExtraInfo(pools));
      logPrice("USDC→WETH (3-pool avg)", price, "USDC per WETH");
      expect(price).to.equal(1985135426041096831563n);
    });

    it("inverted tokenConfig — WETH→USDC direct", async function () {
      const price = await oracle.getMidPrice(WETH, USDC, 0, 0, encodeMidPriceExtraInfo([poolV3_005_fromUSDCtoWETH(TC_FROM_TO_DIRECT)]));
      logPrice("WETH→USDC (V3 0.05%, TC=1)", price, "WETH per USDC");
      expect(price).to.equal(503017806138200n);
    });

    it("getMidPrices — batch returns same values as individual calls", async function () {
      // Mix of different pair types: single V3, multi-pool, middle-token, low-priced, direct
      const extraInfos = [
        encodeMidPriceExtraInfo([poolV3_005_fromUSDCtoWETH(TC_FROM_TO_INVERT)]),                                    // USDC→WETH single V3
        encodeMidPriceExtraInfo([poolV2_fromUSDCtoWETH(TC_FROM_TO_INVERT)]),                                        // USDC→WETH single V2
        encodeMidPriceExtraInfo([                                                                                   // MOG→USDC via WETH
          encodePoolInfo(POOL_UNI_V2, TC_FROM_MID_INVERT, 18, 18, 3000, MOG_WETH_V2, WETH),
          encodePoolInfo(POOL_UNI_V3, TC_MID_TO_DIRECT,   6,  18, 500,  V3_005_POOL, WETH),
        ]),
        encodeMidPriceExtraInfo([encodePoolInfo(POOL_UNI_V3, TC_FROM_TO_DIRECT, 8, 6, 3000, USDT_WBTC_V3)]),        // USDT→WBTC direct
      ];

      const batch = await oracle.getMidPrices(extraInfos);

      // Verify each entry matches a solo call
      expect(batch.length).to.equal(4);
      expect(batch[0]).to.equal(await oracle.getMidPrice(USDC, WETH, 0, 0, extraInfos[0]));
      expect(batch[1]).to.equal(await oracle.getMidPrice(USDC, WETH, 0, 0, extraInfos[1]));
      expect(batch[2]).to.equal(await oracle.getMidPrice(MOG,  USDC, 0, 0, extraInfos[2]));
      expect(batch[3]).to.equal(await oracle.getMidPrice(USDT, WBTC, 0, 0, extraInfos[3]));

      // Log for visibility
      console.log(`      batch[0] USDC→WETH (V3)   = ${batch[0]}  ≈ ${fmtPrice(batch[0])}`);
      console.log(`      batch[1] USDC→WETH (V2)   = ${batch[1]}  ≈ ${fmtPrice(batch[1])}`);
      console.log(`      batch[2] MOG→USDC (hops)  = ${batch[2]}  ≈ ${fmtPrice(batch[2])}`);
      console.log(`      batch[3] USDT→WBTC        = ${batch[3]}  ≈ ${fmtPrice(batch[3])}`);

      // Also verify values are what we expect
      expect(batch[0]).to.equal(1988001195578468716813n);
      expect(batch[1]).to.equal(1984011048782905447623n);
      expect(batch[2]).to.equal(2146898356365913229187580n);
      expect(batch[3]).to.equal(84177163705170638418169n);
    });

    it("getMidPrices — empty array returns empty array", async function () {
      const batch = await oracle.getMidPrices([]);
      expect(batch.length).to.equal(0);
    });
  });

  // ==================== getSlippage ====================

  describe("getSlippage", function () {
    let onchainPrice: bigint;

    before(async function () {
      onchainPrice = await oracle.getMidPrice(USDC, WETH, 0, 0, encodeMidPriceExtraInfo([poolV3_005_fromUSDCtoWETH(TC_FROM_TO_INVERT)]));
    });

    it("returns 0 when offchain equals onchain", async function () {
      const extraInfo = encodeSlippageExtraInfo(onchainPrice, 0, 50000, [poolV3_005_fromUSDCtoWETH(TC_FROM_TO_INVERT)]);
      expect(await oracle.getSlippage(USDC, WETH, 0, 0, extraInfo)).to.equal(0);
    });

    it("returns 0 when price improved (current > offchain)", async function () {
      const lower = onchainPrice * 99n / 100n;
      const extraInfo = encodeSlippageExtraInfo(lower, 0, 50000, [poolV3_005_fromUSDCtoWETH(TC_FROM_TO_INVERT)]);
      expect(await oracle.getSlippage(USDC, WETH, 0, 0, extraInfo)).to.equal(0);
    });

    it("returns exact diff when in [minSlippage, maxSlippage]", async function () {
      const higher = onchainPrice * 101n / 100n;
      const extraInfo = encodeSlippageExtraInfo(higher, 0, 50000, [poolV3_005_fromUSDCtoWETH(TC_FROM_TO_INVERT)]);
      const slippage = await oracle.getSlippage(USDC, WETH, 0, 0, extraInfo);
      const expected = (higher - onchainPrice) * 1000000n / higher;
      expect(slippage).to.equal(expected);
    });

    it("capped at maxSlippage", async function () {
      const higher = onchainPrice * 110n / 100n;
      const extraInfo = encodeSlippageExtraInfo(higher, 0, 5000, [poolV3_005_fromUSDCtoWETH(TC_FROM_TO_INVERT)]);
      expect(await oracle.getSlippage(USDC, WETH, 0, 0, extraInfo)).to.equal(5000);
    });

    it("returns 0 when diff < minSlippage", async function () {
      const slightlyHigher = onchainPrice * 10001n / 10000n;
      const extraInfo = encodeSlippageExtraInfo(slightlyHigher, 500, 50000, [poolV3_005_fromUSDCtoWETH(TC_FROM_TO_INVERT)]);
      expect(await oracle.getSlippage(USDC, WETH, 0, 0, extraInfo)).to.equal(0);
    });

    it("multi-pool average: offchain = onchain returns 0", async function () {
      const pools = [poolV3_005_fromUSDCtoWETH(TC_FROM_TO_INVERT), poolV2_fromUSDCtoWETH(TC_FROM_TO_INVERT)];
      const avg = await oracle.getMidPrice(USDC, WETH, 0, 0, encodeMidPriceExtraInfo(pools));
      const extraInfo = encodeSlippageExtraInfo(avg, 0, 50000, pools);
      expect(await oracle.getSlippage(USDC, WETH, 0, 0, extraInfo)).to.equal(0);
    });
  });

  // ==================== Middle token ====================

  describe("middle token paths", function () {
    it("USDC→WETH via DAI middle", async function () {
      const pools = [
        encodePoolInfo(POOL_UNI_V3, TC_FROM_MID_DIRECT, 18, 6,  100,  DAI_USDC_V3, DAI),
        encodePoolInfo(POOL_UNI_V3, TC_MID_TO_INVERT,   18, 18, 3000, DAI_WETH_V3, DAI),
      ];
      const price = await oracle.getMidPrice(USDC, WETH, 0, 0, encodeMidPriceExtraInfo(pools));
      logPrice("USDC→WETH (via DAI)", price, "USDC per WETH");
      expect(price).to.equal(1983216987121448531559n);
    });

    it("mixed direct + DAI middle-token path", async function () {
      const pools = [
        poolV3_005_fromUSDCtoWETH(TC_FROM_TO_INVERT),
        encodePoolInfo(POOL_UNI_V3, TC_FROM_MID_DIRECT, 18, 6,  100,  DAI_USDC_V3, DAI),
        encodePoolInfo(POOL_UNI_V3, TC_MID_TO_INVERT,   18, 18, 3000, DAI_WETH_V3, DAI),
      ];
      const price = await oracle.getMidPrice(USDC, WETH, 0, 0, encodeMidPriceExtraInfo(pools));
      logPrice("USDC→WETH (direct + DAI)", price, "USDC per WETH");
      expect(price).to.equal((1988001195578468716813n + 1983216987121448531559n) / 2n);
    });
  });

  // ==================== Precision edge cases ====================
  // Exercises low-priced tokens (MOG ≈ $5e-7) and mixed decimals (WBTC 8, USDT 6, MOG 18).
  // Thanks to decimal normalization, both forward and reverse directions are representable.

  describe("precision edge cases", function () {
    it("MOG→USDC via WETH (low-priced token)", async function () {
      const pools = [
        encodePoolInfo(POOL_UNI_V2, TC_FROM_MID_INVERT, 18, 18, 3000, MOG_WETH_V2, WETH),
        encodePoolInfo(POOL_UNI_V3, TC_MID_TO_DIRECT,   6,  18, 500,  V3_005_POOL, WETH),
      ];
      const price = await oracle.getMidPrice(MOG, USDC, 0, 0, encodeMidPriceExtraInfo(pools));
      logPrice("MOG→USDC (via WETH)", price, "MOG per USDC");
      expect(price).to.equal(2146898356365913229187580n);
    });

    it("MOG→WBTC via WETH (low-priced × 8-dec WBTC)", async function () {
      const pools = [
        encodePoolInfo(POOL_UNI_V2, TC_FROM_MID_INVERT, 18, 18, 3000, MOG_WETH_V2,  WETH),
        encodePoolInfo(POOL_UNI_V3, TC_MID_TO_DIRECT,   8,  18, 3000, WBTC_WETH_V3, WETH),
      ];
      const price = await oracle.getMidPrice(MOG, WBTC, 0, 0, encodeMidPriceExtraInfo(pools));
      logPrice("MOG→WBTC (via WETH)", price, "MOG per WBTC");
      expect(price).to.equal(180698171635083080847319799187n);
    });

    it("USDT→WBTC direct (6dec → 8dec)", async function () {
      const pool = encodePoolInfo(POOL_UNI_V3, TC_FROM_TO_DIRECT, 8, 6, 3000, USDT_WBTC_V3);
      const price = await oracle.getMidPrice(USDT, WBTC, 0, 0, encodeMidPriceExtraInfo([pool]));
      logPrice("USDT→WBTC (direct)", price, "USDT per WBTC");
      expect(price).to.equal(84177163705170638418169n);
    });

    it("WBTC→USDT direct (reverse of above)", async function () {
      const pool = encodePoolInfo(POOL_UNI_V3, TC_FROM_TO_INVERT, 8, 6, 3000, USDT_WBTC_V3);
      const price = await oracle.getMidPrice(WBTC, USDT, 0, 0, encodeMidPriceExtraInfo([pool]));
      logPrice("WBTC→USDT (direct)", price, "WBTC per USDT");
      expect(price).to.equal(11879706514019n);
    });

    it("MOG→USDC slippage returns 0 when offchain matches onchain", async function () {
      const pools = [
        encodePoolInfo(POOL_UNI_V2, TC_FROM_MID_INVERT, 18, 18, 3000, MOG_WETH_V2, WETH),
        encodePoolInfo(POOL_UNI_V3, TC_MID_TO_DIRECT,   6,  18, 500,  V3_005_POOL, WETH),
      ];
      const onchain = await oracle.getMidPrice(MOG, USDC, 0, 0, encodeMidPriceExtraInfo(pools));
      const extraInfo = encodeSlippageExtraInfo(onchain, 0, 50000, pools);
      expect(await oracle.getSlippage(MOG, USDC, 0, 0, extraInfo)).to.equal(0);
    });

    it("MOG→WBTC slippage returns correct diff for 1% price drop", async function () {
      const pools = [
        encodePoolInfo(POOL_UNI_V2, TC_FROM_MID_INVERT, 18, 18, 3000, MOG_WETH_V2,  WETH),
        encodePoolInfo(POOL_UNI_V3, TC_MID_TO_DIRECT,   8,  18, 3000, WBTC_WETH_V3, WETH),
      ];
      const onchain = await oracle.getMidPrice(MOG, WBTC, 0, 0, encodeMidPriceExtraInfo(pools));
      const offchain = onchain * 101n / 100n;
      const extraInfo = encodeSlippageExtraInfo(offchain, 0, 50000, pools);
      const slippage = await oracle.getSlippage(MOG, WBTC, 0, 0, extraInfo);
      const expected = (offchain - onchain) * 1000000n / offchain;
      expect(slippage).to.equal(expected);
    });
  });

  // ==================== Reverse / roundtrip ====================
  // With decimal normalization, both directions are representable (even for MOG).
  // Invariant: forward × reverse ≈ 1e36 (exact equality iff all pool rawPrices are equal).
  //
  // Deviations come from:
  //  (a) truncation in 1e36 / rawPrice inversion (relative error < rawPrice / 1e36)
  //  (b) AM-GM: avg(1/R) × avg(R) ≥ 1 when pools have different rawPrices
  //  (c) truncation in Math.mulDiv middle-token multiplication

  describe("reverse direction / roundtrip", function () {
    const ONE_E36 = 10n ** 36n;

    function expectRoundtrip(forward: bigint, reverse: bigint, label: string) {
      logRoundtrip(label, forward, reverse);
      const product = forward * reverse;
      const diff = product > ONE_E36 ? product - ONE_E36 : ONE_E36 - product;
      const relError = diff * 10n ** 18n / ONE_E36;
      expect(relError).to.be.lt(10n ** 14n, `${label}: |fwd*rev - 1e36|/1e36 = ${relError}e-18, must be < 1e-4`);
    }

    it("USDC↔WETH roundtrip — single V3 pool", async function () {
      const fwd = await oracle.getMidPrice(USDC, WETH, 0, 0, encodeMidPriceExtraInfo([poolV3_005_fromUSDCtoWETH(TC_FROM_TO_INVERT)]));
      const rev = await oracle.getMidPrice(WETH, USDC, 0, 0, encodeMidPriceExtraInfo([poolV3_005_fromUSDCtoWETH(TC_FROM_TO_DIRECT)]));
      expectRoundtrip(fwd, rev, "V3 USDC/WETH");
    });

    it("USDC↔WETH roundtrip — single V2 pool", async function () {
      const fwd = await oracle.getMidPrice(USDC, WETH, 0, 0, encodeMidPriceExtraInfo([poolV2_fromUSDCtoWETH(TC_FROM_TO_INVERT)]));
      const rev = await oracle.getMidPrice(WETH, USDC, 0, 0, encodeMidPriceExtraInfo([poolV2_fromUSDCtoWETH(TC_FROM_TO_DIRECT)]));
      expectRoundtrip(fwd, rev, "V2 USDC/WETH");
    });

    it("USDC↔WETH roundtrip — multi-pool average (V3 0.05% + V3 0.3% + V2)", async function () {
      const fwdPools = [
        poolV3_005_fromUSDCtoWETH(TC_FROM_TO_INVERT),
        poolV3_030_fromUSDCtoWETH(TC_FROM_TO_INVERT),
        poolV2_fromUSDCtoWETH(TC_FROM_TO_INVERT),
      ];
      const revPools = [
        poolV3_005_fromUSDCtoWETH(TC_FROM_TO_DIRECT),
        poolV3_030_fromUSDCtoWETH(TC_FROM_TO_DIRECT),
        poolV2_fromUSDCtoWETH(TC_FROM_TO_DIRECT),
      ];
      const fwd = await oracle.getMidPrice(USDC, WETH, 0, 0, encodeMidPriceExtraInfo(fwdPools));
      const rev = await oracle.getMidPrice(WETH, USDC, 0, 0, encodeMidPriceExtraInfo(revPools));
      expectRoundtrip(fwd, rev, "multi-pool USDC/WETH");
    });

    it("USDC↔WETH roundtrip — via DAI middle token", async function () {
      const fwdPools = [
        encodePoolInfo(POOL_UNI_V3, TC_FROM_MID_DIRECT, 18, 6,  100,  DAI_USDC_V3, DAI),
        encodePoolInfo(POOL_UNI_V3, TC_MID_TO_INVERT,   18, 18, 3000, DAI_WETH_V3, DAI),
      ];
      // Reverse: from=WETH, to=USDC, middle=DAI
      // DAI/WETH (t0=DAI=middle, t1=WETH=from) → TC=3 direct → WETH per DAI
      // DAI/USDC (t0=DAI=middle, t1=USDC=to)   → TC=4 invert → DAI per USDC
      const revPools = [
        encodePoolInfo(POOL_UNI_V3, TC_FROM_MID_DIRECT, 18, 18, 3000, DAI_WETH_V3, DAI),
        encodePoolInfo(POOL_UNI_V3, TC_MID_TO_INVERT,   18, 6,  100,  DAI_USDC_V3, DAI),
      ];
      const fwd = await oracle.getMidPrice(USDC, WETH, 0, 0, encodeMidPriceExtraInfo(fwdPools));
      const rev = await oracle.getMidPrice(WETH, USDC, 0, 0, encodeMidPriceExtraInfo(revPools));
      expectRoundtrip(fwd, rev, "DAI-middle USDC/WETH");
    });

    it("USDT↔WBTC roundtrip — direct V3", async function () {
      const fwdPool = encodePoolInfo(POOL_UNI_V3, TC_FROM_TO_DIRECT, 8, 6, 3000, USDT_WBTC_V3);
      const revPool = encodePoolInfo(POOL_UNI_V3, TC_FROM_TO_INVERT, 8, 6, 3000, USDT_WBTC_V3);
      const fwd = await oracle.getMidPrice(USDT, WBTC, 0, 0, encodeMidPriceExtraInfo([fwdPool]));
      const rev = await oracle.getMidPrice(WBTC, USDT, 0, 0, encodeMidPriceExtraInfo([revPool]));
      expectRoundtrip(fwd, rev, "USDT/WBTC");
    });

    it("MOG↔USDC roundtrip", async function () {
      const fwdPools = [
        encodePoolInfo(POOL_UNI_V2, TC_FROM_MID_INVERT, 18, 18, 3000, MOG_WETH_V2, WETH),
        encodePoolInfo(POOL_UNI_V3, TC_MID_TO_DIRECT,   6,  18, 500,  V3_005_POOL, WETH),
      ];
      // Reverse USDC→MOG: from=USDC, middle=WETH, to=MOG
      const revPools = [
        encodePoolInfo(POOL_UNI_V3, TC_FROM_MID_INVERT, 6,  18, 500,  V3_005_POOL, WETH),
        encodePoolInfo(POOL_UNI_V2, TC_MID_TO_DIRECT,   18, 18, 3000, MOG_WETH_V2, WETH),
      ];
      const fwd = await oracle.getMidPrice(MOG, USDC, 0, 0, encodeMidPriceExtraInfo(fwdPools));
      const rev = await oracle.getMidPrice(USDC, MOG, 0, 0, encodeMidPriceExtraInfo(revPools));
      expect(fwd).to.equal(2146898356365913229187580n);
      expect(rev).to.equal(465788236799n);
      expectRoundtrip(fwd, rev, "MOG/USDC");
    });

    it("MOG↔WBTC roundtrip", async function () {
      const fwdPools = [
        encodePoolInfo(POOL_UNI_V2, TC_FROM_MID_INVERT, 18, 18, 3000, MOG_WETH_V2,  WETH),
        encodePoolInfo(POOL_UNI_V3, TC_MID_TO_DIRECT,   8,  18, 3000, WBTC_WETH_V3, WETH),
      ];
      // Reverse WBTC→MOG
      const revPools = [
        encodePoolInfo(POOL_UNI_V3, TC_FROM_MID_INVERT, 8,  18, 3000, WBTC_WETH_V3, WETH),
        encodePoolInfo(POOL_UNI_V2, TC_MID_TO_DIRECT,   18, 18, 3000, MOG_WETH_V2,  WETH),
      ];
      const fwd = await oracle.getMidPrice(MOG, WBTC, 0, 0, encodeMidPriceExtraInfo(fwdPools));
      const rev = await oracle.getMidPrice(WBTC, MOG, 0, 0, encodeMidPriceExtraInfo(revPools));
      expect(fwd).to.equal(180698171635083080847319799187n);
      expect(rev).to.equal(5534090n);
      expectRoundtrip(fwd, rev, "MOG/WBTC");
    });
  });
});
