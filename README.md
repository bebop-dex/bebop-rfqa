# BebopRouter

A wrapper contract around the Bebop **PMM** (Private Market Maker) settlement that adds the integration features missing at the bare PMM layer: pluggable fees and slippage oracles, modular pre/post hooks.

---

## Concept

1. **Modular fee and slippage attribution.** A protocol treasury and the makers split a configurable cut of fees and protocol-shared slippage. Any positive slippage above the quote also routes to the treasury (or back to the makers if it's smaller than `minPositiveSlippageToTreasury` dust).
2. **Pluggable oracle and checker.** The oracle returns slippage in units (`1 unit = 0.01 bps`) based on onchain pool prices vs. an offchain price snapshot encoded into `extraInfo`. The checker returns the fee in the same units. Both are addresses on the order — orders can use any combination of them.
3. **Pre/post hooks.** Hooks let one fill compose with off-PMM actions: e.g. unwrap aUSDC → USDC before the swap, or wrap WETH → aWETH after. Hooks may carry a maker signature, which lets makers hold liquidity in a custom contract (e.g. JIT-mint a synthetic token) and only release it for a specific signed fill.
4. **Gasless settlement (`settle`).** A relayer can submit on behalf of the user. The user authorizes the fill via either an EIP-712 signature over the order, or a Permit2 `permitWitnessTransferFrom` signature whose witness is the order itself.

Everything else — actual maker matching, partial fills, signature checks against maker keys — happens inside `BebopSettlement`. The router calls into it via raw calldata that's parsed and validated, with the fill amount surgically replaced before the call.

---

## Order semantics

```solidity
struct BebopRouterOrder {
    uint256 fromAmount;        // quote: exchange rate numerator (taker side)
    uint256 toAmount;          // quote: exchange rate denominator (maker side)
    int256  limitAmount;       // > 0: minToAmount  (exactIn)
                                // < 0: maxFromAmount (exactOut, encoded as -value)
                                // == 0: disabled
    address fromToken;         // user-facing input token
    address toToken;           // user-facing output token
    address pmmFromToken;      // PMM taker token (= fromToken if no pre-hook)
    address pmmToToken;        // PMM maker token (= toToken if no post-hook)
    address tokensOwner;       // for settle(): user; for swap(): optional msg.sender check
    address receiver;          // recipient of the toToken
    address originAddress;     // optional tx.origin pin
    address oracle;            // optional IOracle (slippage)
    address checker;           // optional IChecker (fee)
    uint256 info;              // packed: [u128 minPositiveSlippageToTreasury | u64 expiry | u32 protocolShareSlippage | u32 protocolShareFee]
    uint256 routerNonce;       // bitmap-invalidated replay nonce (signed)
    uint256 unsignedFlags;     // bit 0: usingPermit2. NOT signed.
}
```

### Fill modes (`exactAmount`)

`swap` and `settle` take `int256 exactAmount`:

| `exactAmount` | mode | meaning |
|---|---|---|
| `> 0` | exactIn | fill exactly this much `fromToken`, scaling toAmount and PMM legs proportionally |
| `< 0` | exactOut | user wants exactly `\|exactAmount\|` of `toToken` after fees; `newFromAmount` derived from quote ratio inflated by `1 / (1 - feeRate - slippageRate)` |
| `== 0` | balance-of-router | use whatever `fromToken` balance the router currently holds (e.g. from a pre-hook) |

`exactAmount == 0` is disallowed in `settle()` — the user must commit to a fill size up-front.

### Fee distribution

After the PMM returns `pmmToToken` to the router, `_distributeFees` runs in `pmmToToken`:

1. **Receiver's amount is sacred.** `toAmountAfterFeeSlippage` is paid to the receiver first, even if it means fees take less than theoretical.
2. **Fee pool** = `pmmReturn − receiverShare`. If the PMM returned slightly less than the theoretical gross (rounding), the fee pool absorbs the shortfall — never the receiver.
3. **Theoretical fee + slippage** are scaled down to fit the actual pool if needed, preserving the `feeRate / slippageRate` ratio.
4. **Positive slippage** = `feePool − theoreticalFee − theoreticalSlippage` (when positive). Goes to treasury, unless it's below `minPositiveSlippageToTreasury` and there are no other treasury transfers (avoids dust).
5. **Protocol share** of fee and slippage goes to treasury (configurable per-order). The remainder of fee/slippage refunds to makers, distributed by their last-leg PMM amounts.

This guarantees `exactOut` users always receive exactly `|exactAmount|` of `toToken`, and never overpays — `newFromAmount` is computed up-front from the quote ratio and capped by `limitAmount`.

### Permit2 + exactOut

For Permit2 + exactOut, `limitAmount < 0` is required. The user signs `permitted.amount = -limitAmount` (their max spend); the router pulls `newFromAmount ≤ -limitAmount` based on the actual fill.

For Permit2 + exactIn, `permitted.amount = fromAmount`.

---

## Smart contracts

### `contracts/BebopRouter.sol`
Main entry point. Inherits:
- `Ownable` — owner can swap the `routerSigner` address (whose EIP-712 signature authorizes orders)
- `ReentrancyGuardTransient`
- `BebopValidation` (signature validation + bitmap nonces)
- `BebopPmmHelper` (parsing and executing PMM calldata)

Constructor: `(protocolTreasury, routerSigner, bebopPmm, permit2, wrappedNativeToken)`.

Core externals:
- `swap(exactAmount, order, extraInfo, routerSig, pmmCalldata, hooks)` — taker-pays flow. Pulls `fromToken` from `msg.sender` (or accepts `msg.value` for native ETH).
- `settle(exactAmount, order, extraInfo, routerSig, pmmCalldata, hooks, userSig)` — gasless. Pulls `fromToken` from `order.tokensOwner` via Permit2 witness or EIP-712 sig.
- `invalidateNonce(nonce)` — user-initiated cancel (sender-scoped bitmap).
- `setRouterSigner(addr)` — owner only.

View helpers:
- `hashOrder(order, extraInfo, hooksHash)` — full EIP-712 digest (or Permit2 witness digest if `usingPermit2`)
- `hashHook(hook, makerNonce)` — EIP-712 digest for a single hook signature
- `hooksHash(hooks, makerAddrs, makerNonces)` — aggregate hooks hash bound to the order

### `contracts/base/BebopPmmHelper.sol`
Validates and executes PMM calldata. Supports both `swapSingle` and `swapAggregate` selectors. For aggregate orders, walks the leg structure, validates each maker has at most 2 legs (one optional middle-token leg + one last leg), and confirms the middle token is consistent across legs. Replaces the taker amount in calldata before forwarding to `BebopSettlement`.

Extracts `eventId` from PMM order flags (bits 128-255) for downstream emission in `BebopRouterSwap`.

### `contracts/base/BebopValidation.sol`
- `validateSignature(signer, digest, sig)` — supports 65-byte ECDSA, 64-byte EIP-2098 compact sigs, and ERC-1271 contract sigs.
- `_invalidateNonce(owner, nonce)` — bitmap-based; `nonce >> 8 = slot`, `1 << (nonce & 0xff) = bit`. 256 nonces per storage slot.

### `contracts/libraries/BebopRouterOrderLib.sol`
- `ORDER_TYPE_HASH` — EIP-712 type hash including `extraInfoHash` and `hooksHash` as signed fields (so signed orders bind the hooks they were authored against).
- `hash(order, extraInfo, hooksHash)` — assembly-based: writes 17 words (typeHash + 14 struct fields + extraInfoHash + hooksHash) to a single buffer and runs one `keccak256` over the lot. Skips `unsignedFlags` (NOT signed by design).
- `permit2OrderHash(...)` — wraps the order hash inside a Permit2 `PermitWitnessTransferFrom` digest using `PermitHash.hashWithWitness`.
- `info` field unpackers: `getExpiry`, `getProtocolShareFee`, `getProtocolShareSlippage`, `getMinPositiveSlippageToTreasury`.
- `unsignedFlags` getters: `isUsingPermit2`.

### `contracts/libraries/HookLib.sol`
- `Hook` struct: `(targetContract, data, hookSignature, flags)` where `flags` packs `[address makerAddress | bool postHook | bool revertOnFail | bool useBebopHook | bool needsApproval]`.
- `HOOK_SIGN_TYPE_HASH` — EIP-712 type hash for `BebopHook(address targetContract,bytes32 dataHash,uint256 makerNonce,uint256 flags)`.
- `executeHooks(hooks, postPhase, makerAddresses, makerSwapLegs, originalFromAmount, filledFromAmount)` — iterates hooks, optionally calls `IBebopHook.bebopHook(data, scaledSwaps[])` if `useBebopHook`, otherwise raw call.
- `_buildScaledSwaps` — scales each maker's swap legs by `filledFromAmount / originalFromAmount` so a JIT-mint hook sees the actual filled amounts.

### `contracts/oracles/BebopOracle.sol`
Real onchain oracle that reads Uni V3 (`slot0()`) and Uni V2 (`getReserves()`) pool prices, decimal-normalizes them, and compares against an offchain price snapshot encoded in `extraInfo` to compute slippage.

Two public functions:
- `getSlippage(...)` — `IOracle` interface. Returns slippage in units, capped to `[minSlippage, maxSlippage]`. Returns 0 if onchain price ≥ offchain (price improved) or if the diff is below `minSlippage`.
- `getMidPrice(...)` — pure pricing read; useful offchain.
- `getMidPrices(extraInfos[])` — batch read for many pairs in one RPC.

Pricing semantics: **full-unit per full-unit, scaled 1e18** (e.g. "1988 USDC per WETH"). Each `PoolInfo` carries the pool's `dec0` and `dec1`, so the oracle normalizes per-pool. This keeps both directions representable for asymmetric pairs (e.g. MOG 18-dec @ $5e-7 vs USDC 6-dec).

`PoolInfo` (48 bytes, tightly packed):
```
uint8   poolType      0 = UniV3, 1 = UniV2
uint8   tokenConfig   0–5: which pool tokens map to from/to/middle, even=invert, odd=direct
uint8   dec0          token0 decimals
uint8   dec1          token1 decimals
uint32  poolFee       fee tier (3000, 500, etc.)
address pool          20 bytes
address middleToken   0x0 for direct, else the middle token
```

`getSlippage` extraInfo: `[uint256 offchainMidPrice | uint16 minSlip | uint16 maxSlip | uint8 numPools | PoolInfo[]]`.

`getMidPrice` extraInfo: `[uint8 numPools | PoolInfo[]]`.

Multi-pool, multi-middle-token paths are supported: pools with the same `middleToken` are grouped, each group's `from→middle` × `middle→to` is computed via `Math.mulDiv` (overflow-safe), and all final from→to prices are averaged.

`error ZeroPriceFromPool()` — explicit revert if a pool returns rawPrice 0 (V3 at extreme tick, dead V2 pair) instead of an opaque division-by-zero panic.

### Mock contracts (test only)
- `contracts/oracles/MockOracle.sol` — reads slippage value directly from `extraInfo[32:64]`. Used in router tests so we test the slippage *flow* without depending on real pool state.
- `contracts/checkers/MockChecker.sol` — reads fee value from `extraInfo[0:32]`.
- `contracts/hooks/Mock*.sol` — mock Aave (1:1 aToken), rate-based wrapped tokens, mintable token, maker mint hook for JIT-mint scenarios.

---

## Hooks

A `Hook` runs either before (`postHook = false`) or after (`postHook = true`) the PMM call.

Two execution modes:
- **Raw call** (`useBebopHook = false`): `target.call(hook.data)`. The hook is responsible for pulling tokens via `transferFrom(router, hook, amount)` if `needsApproval` is true (the router approves before each phase).
- **`IBebopHook.bebopHook(data, swaps[])`** (`useBebopHook = true`): the router invokes this canonical entrypoint, passing the scaled swap legs alongside `data`. Useful when the hook needs to know the actual filled amounts (e.g. mint exactly N tokens).

If a hook has `makerAddress != address(0)`, the maker must sign the hook (EIP-712 over `HOOK_SIGN_TYPE_HASH`). The maker's nonce is taken from the matching PMM order so canceling the PMM order also cancels the hook authorization.

`revertOnFail` controls whether a hook revert bubbles or is silently swallowed.

---

## Oracle and Checker

Both are **per-order** addresses. If `order.checker == address(0)` no fee is charged. If `order.oracle == address(0)` no slippage is charged. Both contracts are stateless and may be redeployed when their internal logic needs to change (e.g. supporting new pool types).

`checkAndGetFee(user, receiver, msgSender, extraInfo) → uint256 fee` — units, where `1 unit = 0.01 bps`, `UNIT_BASE = 1_000_000 = 100%`.
`getSlippage(fromToken, toToken, fromAmount, toAmount, extraInfo) → uint256 slippage` — same units.

Note: the oracle is called with the **PMM** amounts (`pmmTakerAmount`, `pmmMakerAmount`), not the order amounts — since the order amounts are not protected against manipulation through calldata replacement.

---

## Building, testing, deploying

### Setup

```bash
npm install
cp .env.example .env
# fill in DEPLOYER_PRIVATE_KEY, ETHERSCAN_API_KEY, RPC URLs as needed
```

### Test

```bash
npm test                    # all 83 tests
npm run test:router         # 56 router tests
npm run test:oracles        # 27 oracle tests
npm run test:gas            # all tests + per-method gas table
```

The router tests run against a Hardhat fork of Ethereum mainnet at block `22100000`. Token funding is done via storage-slot manipulation (`fundToken`).

### Deploy

Per-chain constructor args live in `config/deploy.ts` (keyed by chainId). Edit the `protocolTreasury` and `routerSigner` placeholders before deploying to mainnet — the deploy script asserts they're non-zero and aborts with a pointer to the config file otherwise.

```bash
# both contracts
npm run deploy:router
npm run deploy:oracle
```

You can override any constructor arg ad-hoc via env vars: `PROTOCOL_TREASURY`, `ROUTER_SIGNER`, `BEBOP_PMM`, `PERMIT2`, `WRAPPED_NATIVE_TOKEN`.

### Verify

`ETHERSCAN_API_KEY` must be set in `.env`.

```bash
ADDRESS=0x... npm run verify:router
ADDRESS=0x... npm run verify:oracle
```

The verify-router script reuses `config/deploy.ts` to determine the constructor args (so they match what was deployed — same env-var overrides apply).

