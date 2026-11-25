// Ignition paper bot for the pump.fun bonding-curve replay (agent-fun/replay/v2).
//
// Where the edge is, measured on the dev window: a launch bought at its very
// first trade and sold ~500 slots later gains +10.9% on average, while the same
// launch bought 20 slots after creation loses -7.7% — by then you are the exit
// liquidity. The median launch never moves at all, but ~4% of them run 10x or
// more, and a launch bought at creation reaches a peak worth +85% on average
// inside 3000 slots. So the bot buys tiny ignition stakes at creation, adds
// only while the tape confirms (rising price, fresh buyers, net inflow), and
// lets the rare runner pay for the many flat ones: a take-profit ladder sells
// a third at +25% and half of what is left at +30%, a trailing stop keeps what a
// runner gains, and losers are cut at -30%, on a creator sell, on a fade of
// the tape, or when the money sits dead. Nothing is bought after the ignition
// window (age 8 slots): chasing a surge that already happened is how the
// earlier surge-dip version of this bot lost money on the same data. The
// ignition is also refused when the launch already ran more than 10% over its
// create price, when no outside buyer has shown up yet, or when the curve
// holds under 1 SOL of real reserves (below that the 1% size cap makes the
// round trip too small to count toward the 20-coin bar). Tuned on the full
// dev window (+0.031 SOL mean over four failed-tx draws, worst +0.029, 43
// qualifying coins, drawdown 0.007); the profit rides on one runner coin,
// as it does for every entry on this data, so the settings were chosen for
// the highest mean with a wide guardrail margin, not for a single best cell.
//
// Guardrails: the run needs a round trip of at least 0.01 SOL on each of at
// least 20 coins and a max drawdown of 50%. Ignition stakes are small and the
// bot cycles through hundreds of launches, so the coin bar is met with room
// to spare while total exposure stays low.
//
// Deterministic by construction: no clock, no environment reads, no
// randomness; iteration only over insertion-ordered maps fed by the batch
// stream, and every decision derives from the harness state (hello, batch,
// orders, slot).

import type {
  Batch,
  Bot,
  BotState,
  OrderInput,
  Pubkey,
} from './vendor/agentfun-bot.ts';

export interface Params {
  /** Latest age (slots since create) at which an ignition buy may be decided. */
  maxIgnitionAge: number;
  /** Minimum real SOL reserve at ignition (below it the 1% size cap is dust). */
  minRealSol: number;
  /** Maximum price run-up over the create price at ignition (don't buy a spike). */
  maxIgnitionRunup: number;
  /** Most distinct non-creator buyers in the opening tape at ignition. */
  maxOpenBuyers: number;
  /** Fewest distinct non-creator buyers in the opening tape at ignition. */
  minOpenBuyers: number;
  /** Ignition stake per coin (SOL), before the 1% reserve cap. */
  ignitionSol: number;
  /** Smallest single buy worth paying the tx fee for (SOL). */
  minBuySol: number;
  /** Total stake aimed for per coin (SOL, ignition + adds). */
  totalStakeSol: number;
  /** Size of one confirmation add (SOL). */
  addSol: number;
  /** Most confirmation adds per coin. */
  maxAdds: number;
  /** Latest age (slots) at which an add may still be decided. */
  maxAddAge: number;
  /** Slots to wait between adds on one coin. */
  addDelay: number;
  /** An add needs the price at least this far above the last buy's price. */
  addStep: number;
  /** An add needs this many distinct buyers in the recent window. */
  addMinBuyers: number;
  /** Recent window (slots) for the add flow check. */
  addWindow: number;
  /** Slippage allowed on buys (bps); sells always go out at 10000. */
  buySlipBps: number;
  /** Hard stop: sell all when realizable value / cost falls to this. */
  stopLoss: number;
  /** First take-profit level (value / cost): sell a third of the position. */
  takeProfit1: number;
  /** Second take-profit level (value / cost): sell half of what is left. */
  takeProfit2: number;
  /** Trailing stop arms once value / cost reaches this. */
  trailArm: number;
  /** Trailing stop: sell all when value / cost falls below peak * this. */
  trailGiveback: number;
  /** Fade window (slots) for the net-flow exit. */
  fadeWindow: number;
  /** Exit when net SOL flow over the fade window is below this (negative). */
  fadeNetSol: number;
  /** Sell dead money after this many slots held below the dead-line ratio. */
  deadHold: number;
  /** Below this value / cost the position counts as dead money. */
  deadRatio: number;
  /** Exit after this many slots held, whatever the position is worth. */
  maxHold: number;
  /** Slots to wait after an exit before the same curve may be bought again. */
  cooldown: number;
  /** Most positions open at once (caps.max_open_positions is 5). */
  maxPositions: number;
}

export const DEFAULT_PARAMS: Params = {
  maxIgnitionAge: 8,
  minRealSol: 1.0,
  maxIgnitionRunup: 0.1,
  maxOpenBuyers: 8,
  minOpenBuyers: 1,
  ignitionSol: 0.05,
  minBuySol: 0.005,
  totalStakeSol: 0.3,
  addSol: 0.1,
  maxAdds: 4,
  maxAddAge: 120,
  addDelay: 10,
  addStep: 0.02,
  addMinBuyers: 3,
  addWindow: 30,
  buySlipBps: 10000,
  stopLoss: 0.7,
  takeProfit1: 1.25,
  takeProfit2: 1.3,
  trailArm: 1.25,
  trailGiveback: 0.9,
  fadeWindow: 100,
  fadeNetSol: -1.0,
  deadHold: 2000,
  deadRatio: 1.05,
  maxHold: 2000,
  cooldown: 240,
  maxPositions: 5,
};

const LAMPORTS_PER_SOL = 1_000_000_000n;
/** Curve fee on a trade: protocol 95 bps + creator 30 bps. */
const CURVE_FEE = 0.0125;

interface TapeTrade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface CoinState {
  createdSlot: number;
  creator: Pubkey;
  createPrice: number;
  trades: TapeTrade[];
  /** Creator sold at any point (checked before entry and for the exit). */
  creatorSold: boolean;
  /** Ignition buy decided (at most one per coin). */
  ignited: boolean;
  /** Confirmation adds decided so far. */
  adds: number;
  /** Slot of the last buy decided on this coin. */
  lastBuySlot: number;
  /** Decision price of the last buy on this coin. */
  lastBuyPrice: number;
  /** Slot this coin was last exited (cooldown). */
  lastExitSlot: number;
  /** Its CompleteEvent arrived: no more orders (they would be rejected). */
  complete: boolean;
}

interface PositionTrack {
  peakRatio: number;
  tpStage: number;
  entrySlot: number;
}

function priceOf(virtualQuote: bigint, virtualToken: bigint): number {
  if (virtualToken === 0n) return 0;
  return Number(virtualQuote) / Number(virtualToken);
}

export function createStrategy(params: Params = DEFAULT_PARAMS): Bot {
  // Every coin ever seen, by mint. Never pruned while the run lives: a coin
  // re-created after pruning would look newborn and could be ignited again
  // at a much later real age, buying a top it already ran to. Only the
  // trade tapes are pruned (to the fade window + slack).
  const coins = new Map<Pubkey, CoinState>();
  const tracks = new Map<Pubkey, PositionTrack>();
  const tradedCoins = new Set<Pubkey>();
  // Coins young enough to enter (age <= maxAddAge) or holding a position:
  // the entry scan walks this set, not every coin ever seen.
  const candidates = new Set<Pubkey>();
  let firstSlot = -1;

  function coinFor(mint: Pubkey, slot: number): CoinState {
    let c = coins.get(mint);
    if (c === undefined) {
      c = {
        createdSlot: slot,
        creator: '',
        createPrice: 0,
        trades: [],
        creatorSold: false,
        ignited: false,
        adds: 0,
        lastBuySlot: -1,
        lastBuyPrice: 0,
        lastExitSlot: -1,
        complete: false,
      };
      coins.set(mint, c);
    }
    return c;
  }

  // Net SOL flow (buys minus sells) and distinct buyers over the last `span` slots.
  function recentFlow(
    coin: CoinState,
    slot: number,
    span: number,
  ): { net: number; buyers: Set<string>; lastPrice: number } {
    const from = slot - span;
    let net = 0;
    const buyers = new Set<string>();
    let lastPrice = 0;
    for (let i = coin.trades.length - 1; i >= 0; i--) {
      const tr = coin.trades[i];
      if (tr.slot <= from) break;
      if (lastPrice === 0) lastPrice = tr.price;
      net += tr.buy ? tr.sol : -tr.sol;
      if (tr.buy) buyers.add(tr.user);
    }
    return { net, buyers, lastPrice };
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      if (firstSlot < 0) firstSlot = batch.slot;
      const orders: OrderInput[] = [];
      const slot = batch.slot;

      // Fold this batch's events into the per-coin tapes.
      for (const e of batch.events) {
        if (e.event === 'CreateEvent') {
          const c = coinFor(e.mint, e.slot);
          c.createdSlot = e.slot;
          c.creator = e.creator;
          c.createPrice = priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves));
          candidates.add(e.mint);
        } else if (e.event === 'TradeEvent') {
          const c = coinFor(e.mint, e.slot);
          const sol = Number(BigInt(e.sol_amount)) / 1e9;
          c.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol,
            user: e.user,
            price: priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves)),
          });
          if (!e.is_buy && c.creator !== '' && e.user === c.creator) c.creatorSold = true;
          candidates.add(e.mint);
          // Keep only what the exits need (fade window + slack).
          const keepFrom = slot - 1024;
          while (c.trades.length > 0 && c.trades[0].slot <= keepFrom) c.trades.shift();
        } else {
          // CompleteEvent: the replay closes positions in it; mark it so it
          // is never entered again, but keep the record (see above).
          const c = coins.get(e.mint);
          if (c !== undefined) c.complete = true;
          candidates.delete(e.mint);
        }
      }
      // Age candidates out of the entry scan once they pass the add window
      // (they can never be entered again); positions keep their own record.
      for (const mint of candidates) {
        const c = coins.get(mint);
        if (c === undefined || slot - c.createdSlot > params.maxAddAge) candidates.delete(mint);
      }

      // Mints with an order already in flight (pending is keyed by client_id).
      const pendingBuys = new Set<Pubkey>();
      const pendingSells = new Set<Pubkey>();
      for (const p of state.pending.values()) {
        if (p.order.side === 'buy') pendingBuys.add(p.order.mint);
        else pendingSells.add(p.order.mint);
      }

      // --- Exits first: manage every open position. ---
      for (const [mint, holding] of state.positions) {
        if (pendingSells.has(mint)) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        // Realizable value: what selling the whole holding actually returns
        // through the curve (the sale moves the price against us), curve fees
        // deducted, less one tx fee — not tokens x spot price, which overstates
        // value exactly when the position is biggest.
        const tokens = Number(holding.token_amount);
        const vq = Number(curve.virtual_quote_reserves);
        const vt = Number(curve.virtual_token_reserves);
        if (vt + tokens <= 0 || vq <= 0) continue;
        const txSol = Number(state.txFeeLamports()) / 1e9;
        const valueSol = ((tokens * vq) / (vt + tokens) / 1e9) * (1 - CURVE_FEE) - txSol;
        const costSol = Number(holding.cost_lamports) / 1e9;
        if (costSol <= 0) continue;
        const ratio = valueSol / costSol;

        let track = tracks.get(mint);
        if (track === undefined) {
          track = { peakRatio: ratio, tpStage: 0, entrySlot: slot };
          tracks.set(mint, track);
        }
        if (ratio > track.peakRatio) track.peakRatio = ratio;

        const coin = coins.get(mint);
        let sellFraction = 0;
        if (ratio <= params.stopLoss) {
          sellFraction = 1;
        } else if (coin !== undefined && coin.creatorSold) {
          sellFraction = 1;
        } else if (track.tpStage === 0 && ratio >= params.takeProfit1) {
          sellFraction = 1 / 3;
          track.tpStage = 1;
        } else if (track.tpStage === 1 && ratio >= params.takeProfit2) {
          sellFraction = 0.5;
          track.tpStage = 2;
        } else if (track.peakRatio >= params.trailArm && ratio <= track.peakRatio * params.trailGiveback) {
          sellFraction = 1;
        } else if (slot - track.entrySlot >= params.maxHold) {
          sellFraction = 1;
        } else if (slot - track.entrySlot >= params.deadHold && ratio < params.deadRatio) {
          sellFraction = 1;
        } else if (coin !== undefined) {
          const fade = recentFlow(coin, slot, params.fadeWindow);
          if (fade.net < params.fadeNetSol) sellFraction = 1;
        }

        if (sellFraction > 0) {
          const amount =
            sellFraction >= 1
              ? holding.token_amount
              : (holding.token_amount * BigInt(Math.floor(sellFraction * 1000))) / 1000n;
          if (amount > 0n) {
            orders.push({
              side: 'sell',
              mint,
              token_amount: amount,
              max_slippage_bps: 10000,
            });
          }
          if (sellFraction >= 1) {
            tracks.delete(mint);
            if (coin !== undefined) coin.lastExitSlot = slot;
          }
        }
      }

      // --- Entries: ignition buys on fresh launches, adds on confirmation. ---
      const buyingThisBatch = new Set<Pubkey>();
      const txFee = state.txFeeLamports();
      for (const mint of candidates) {
        if (orders.length >= 16) break;
        if (pendingBuys.has(mint) || buyingThisBatch.has(mint)) continue;
        const coin = coins.get(mint);
        if (coin === undefined || coin.complete) continue;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        const age = slot - coin.createdSlot;
        const held = state.positions.get(mint);
        const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (price <= 0) continue;

        if (held === undefined) {
          // Ignition: one tiny buy at creation, before the edge decays.
          if (coin.ignited) continue;
          if (age < 0 || age > params.maxIgnitionAge) continue;
          if (coin.lastExitSlot >= 0 && slot - coin.lastExitSlot < params.cooldown) continue;
          if (state.committedPositionCount() + buyingThisBatch.size >= params.maxPositions) continue;
          if (coin.creatorSold) continue;
          const realSol = Number(curve.real_quote_reserves) / 1e9;
          if (realSol < params.minRealSol) continue;
          if (coin.createPrice > 0 && price / coin.createPrice - 1 > params.maxIgnitionRunup) continue;
          const open = recentFlow(coin, slot, params.maxIgnitionAge + 2);
          const nonCreatorBuyers = [...open.buyers].filter((u) => u !== coin.creator);
          if (nonCreatorBuyers.length > params.maxOpenBuyers) continue;
          if (nonCreatorBuyers.length < params.minOpenBuyers) continue;

          const cap = state.maxBuyLamports(mint);
          if (cap <= 0n) continue;
          let stake = BigInt(Math.floor(params.ignitionSol * 1e9));
          const capped = (cap * 9n) / 10n;
          if (stake > capped) stake = capped;
          if (stake < BigInt(Math.floor(params.minBuySol * 1e9))) continue;
          if (state.freeCashLamports() < stake + txFee) continue;

          orders.push({ side: 'buy', mint, quote_lamports: stake, max_slippage_bps: params.buySlipBps });
          buyingThisBatch.add(mint);
          coin.ignited = true;
          coin.adds = 0;
          coin.lastBuySlot = slot;
          coin.lastBuyPrice = price;
          tradedCoins.add(mint);
        } else {
          // Confirmation add: the launch is attracting buyers and climbing.
          if (coin.adds >= params.maxAdds) continue;
          if (age > params.maxAddAge) continue;
          if (slot - coin.lastBuySlot < params.addDelay) continue;
          if (state.committedPositionCount() + buyingThisBatch.size >= params.maxPositions) continue;
          const invested = Number(held.cost_lamports) / 1e9;
          if (invested >= params.totalStakeSol) continue;
          if (price < coin.lastBuyPrice * (1 + params.addStep)) continue;
          const flow = recentFlow(coin, slot, params.addWindow);
          if (flow.net <= 0) continue;
          const nonCreatorBuyers = [...flow.buyers].filter((u) => u !== coin.creator);
          if (nonCreatorBuyers.length < params.addMinBuyers) continue;

          const cap = state.maxBuyLamports(mint);
          if (cap <= 0n) continue;
          let stake = BigInt(Math.floor(params.addSol * 1e9));
          const capped = (cap * 9n) / 10n;
          if (stake > capped) stake = capped;
          const remaining = BigInt(Math.floor((params.totalStakeSol - invested) * 1e9));
          if (stake > remaining) stake = remaining;
          if (stake < BigInt(Math.floor(params.minBuySol * 1e9))) continue;
          if (state.freeCashLamports() < stake + txFee) continue;

          orders.push({ side: 'buy', mint, quote_lamports: stake, max_slippage_bps: params.buySlipBps });
          buyingThisBatch.add(mint);
          coin.adds += 1;
          coin.lastBuySlot = slot;
          coin.lastBuyPrice = price;
        }
      }

      return orders;
    },

    onDone(state: BotState): void {
      const cashSol = Number(state.cash) / 1e9;
      console.error(
        `ignition done: cash ${cashSol.toFixed(4)} SOL, ` +
          `coins traded ${tradedCoins.size}, curves seen ${state.curves.size}`,
      );
    },
  };
}
