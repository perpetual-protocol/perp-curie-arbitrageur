<img width="1012" alt="arbitrageur" src="https://user-images.githubusercontent.com/105896/168986870-ea5a41cb-d2a8-4bf0-a2b9-61a0cd50fff5.png">

# Perp Curie Arbitrageur

A simple arbitrageur strategy for perpetual protocol v2. Please note that it uses a basic strategy and serves as a template for developers to create their own arbitraging strategy. Use it at your own risk!

## Requirement

-   `npm >= 7`
-   `nodejs >= 16`

## Installation

```bash
$ git clone https://github.com/perpetual-protocol/perp-curie-arbitrageur.git
$ cd perp-curie-arbitrageur
$ npm install
$ npm run build
```

## Configuration
Edit the trading parameters in `src/configs/config.json`:

```javascript
{
    "PRICE_CHECK_INTERVAL_SEC": 5,
    "BALANCE_CHECK_INTERVAL_SEC": 10,

    // max gas fee you would like to pay per transaction
    "ARBITRAGE_MAX_GAS_FEE_ETH": 0.02,
    "BALANCE_MAX_GAS_FEE_ETH": 0.1,

    // margin ratio = collateral / total position value
    // min margin ratio 0.2 = max leverage 5x
    "PERP_MIN_MARGIN_RATIO": 0.2,
    "FTX_MIN_MARGIN_RATIO": 0.2,

    // emergency reduce position threshold
    // margin ratio 0.1 = leverage 10x
    "PERP_EMERGENCY_MARGIN_RATIO": 0.1,
    "FTX_EMERGENCY_MARGIN_RATIO": 0.1,

    "EMERGENCY_REDUCE_AMOUNT": 9000,
    "EMERGENCY_REDUCE_SLEEP_SEC": 10,
    "EMERGENCY_REDUCE_CHECK_INTERVAL_SEC": 1,

    // Maximum 5 markets
    "MARKET_MAP": {
        "vBTC": {
            "IS_ENABLED": true,
            "FTX_MARKET_NAME": "BTC-PERP",
            // order amount in USDC for each trade
            "ORDER_AMOUNT": 3000,
            // spread = (price on Curie - price on FTX) / price on FTX
            "SHORT_TRIGGER_SPREAD": 0.002, // short on Curie, long on FTX
            "LONG_TRIGGER_SPREAD": -0.002, // long on Curie, short on FTX

            // whether (or not) bot should reduce positions when the leverage is too high
            "IS_EMERGENCY_REDUCE_MODE_ENABLED": true
        }
    }
}

```

## Environment Variables
Provide your endpoint(s) and API keys in `.env`:

```bash
# endpoint(s)
L2_WEB3_ENDPOINTS={ENDPOINT1,ENDPOINT2,...}

# secrets
PRIVATE_KEY={WALLET_PRIVATE_KEY}
FTX_API_KEY={FTX_API_KEY}
FTX_API_SECRET={FTX_API_SECRET}
FTX_SUBACCOUNT={FTX_SUBACCOUNT_NAME}
```

## Run

```bash
$ env $(cat .env | grep -v '#' | xargs) npm run start
```

## Docker

```bash
$ docker build -f arbitrageur.Dockerfile -t perp-arbitrageur .
$ docker run --env-file ./.env perp-arbitrageur
```
