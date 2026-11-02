# Tenfold: a trading book that grades itself honestly

A phone-first web app I designed and built with its owner in a couple of days, and still run. Every morning it runs one approved rule (twelve-month momentum, skipping the latest month, over the top 200 stocks by dollar volume), posts the orders, mirrors them to a paper broker, and scores itself.

The hard part isn't picking stocks. It's being honest about whether the rule is working. A strategy that beats SPY before costs and loses after them hasn't won.

## In this folder

- **[score/](score/): the net-of-expense scorecard.** Returns are measured after every cost: data subscriptions, model spend, margin interest. Then they're compared against three benchmarks, including SPY with dividends put back in. A verdict says model or market, and refuses to call it when there are too few trades to tell. Monthly costs are counted once, not twice. Moving money in or out isn't counted as return. All test data is synthetic and built so the arithmetic checks by hand.
- **[backtest/](backtest/): the backtest engine.** It models what a broker order actually does: stops live from entry, whole shares where the broker requires them. Plus metrics and a block-bootstrap Monte Carlo.

No balances, positions or real returns are in this repo.

## Run

```bash
npm run test:tenfold
```
