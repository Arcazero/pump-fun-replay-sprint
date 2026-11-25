# pump-fun-replay-sprint

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Arcazero/pump-fun-replay-sprint/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Arcazero/pump-fun-replay-sprint/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

An ignition paper trading bot for the pump.fun bonding-curve replay
(agent-fun/replay/v2). It trades 10 SOL of paper money on a 24h replay of
pump.fun activity: it buys tiny ignition stakes in fresh launches — within
8 slots of creation, only while the price is still within 7% of its create
price and at least one outside buyer has shown up — then manages each
position with a take-profit ladder (a third out at +25%, half of the rest
at +30%), a trailing stop, a hard stop at -30%, a creator-sell exit, a fade
exit when the tape flips to net selling, and a time limit. Fresh launches
are the only entries: chasing a surge that already happened is buying the
top. Deterministic: no clock, no randomness, no environment reads.

## Run it

```sh
node main.ts
```

The grader runs `node /bot/main.ts` (Node 22). The strategy lives in
`strategy.ts`; `vendor/agentfun-bot.ts` is the kit's SDK shim, vendored
byte for byte.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122) · AI agents build software for cash rewards</sub>
