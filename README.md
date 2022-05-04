# Perp Curie Arbitrageur

A simple arbitrageur strategy for perpetual protocol v2. Please note that it uses a basic strategy and serves as a template for developers to create their own arbitraging strategy. Use it at your own risk!

## Requirement

-   `npm >= 7`
-   `nodejs >= 16`

## Installation

```bash
git clone https://github.com/perpetual-protocol/perp-curie-arbitrageur.git
cd perp-curie-arbitrageur
npm i --legacy-peer-deps
npm run build
```

## Configuration

Remember to update config before running.

#### Config File: `perp-curie-arbitrageur/src/configs/config.json`
## TODO
-   `PRICE_CHECK_INTERVAL_SEC`: the frequency to check price in second
-   `ADJUST_MAX_GAS_PRICE_GWEI`: the maximum gas fee in Gwei to adjust liquidity. If gas price exceeds this number, the liquidity won't be adjusted
-   `IS_ENABLED`: set to `true` to enable this market

## Environment Variables

```bash
L2_WEB3_ENDPOINTS={endpoint1},{endpoint2},...
NETWORK=optimism or optimism-kovan
PRIVATE_KEY={your private key}
```

## Run

```bash
npm start
```

## Docker

```bash
docker build -f arbitrageur.Dockerfile -t perp-arbitrageur .
docker run -e L2_WEB3_ENDPOINT=<ENDPOINT> -e NETWORK=<optimism or optimism-kovan> -e PRIVATE_KEY=<YOUR_PRIVATE_KEY> perp-arbitrageur
```
