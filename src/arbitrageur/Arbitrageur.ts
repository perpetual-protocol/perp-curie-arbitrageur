import { min } from "@perp/common/build/lib/bn"
import { Side as FTXSide, OrderType } from "@perp/common/build/lib/external/FtxService"
import { sleep } from "@perp/common/build/lib/helper"
import { Log } from "@perp/common/build/lib/loggers"
import { BotService } from "@perp/common/build/lib/perp/BotService"
import { AmountType, Side } from "@perp/common/build/lib/perp/PerpService"
import Big from "big.js"
import { ethers } from "ethers"
import { Service } from "typedi"

import config from "../configs/config.json"

// workaround: use require here since typescript cannot find ftx-api-rest.d.ts
const FTXRest = require("ftx-api-rest")

interface Market {
    name: string
    baseToken: string
    poolAddr: string
    ftxSizeIncrement: Big
    // config
    ftxMarketName: string
    orderAmount: Big
    // spread
    shortTriggerSpread: Big
    longTriggerSpread: Big
    // reduce mode
    isEmergencyReduceModeEnabled: boolean
    // balance routine
    imbalanceStartTime: number | null
}

const DUST_USD_SIZE = Big(100)

@Service()
export class Arbitrageur extends BotService {
    readonly log = Log.getLogger(Arbitrageur.name)

    private wallet!: ethers.Wallet
    private marketMap: { [key: string]: Market } = {}
    private ftxClient: any
    private referralCode: string | null = null
    private readonly arbitrageMaxGasFeeEth = Big(config.ARBITRAGE_MAX_GAS_FEE_ETH)

    async setup(): Promise<void> {
        this.log.jinfo({
            event: "SetupArbitrageur",
        })
        const privateKey = process.env.PRIVATE_KEY
        const ftxKey = process.env.FTX_API_KEY
        const ftxSecret = process.env.FTX_API_SECRET
        const ftxSubaccount = process.env.FTX_SUBACCOUNT
        if (!privateKey || !ftxKey || !ftxSecret || !ftxSubaccount) {
            throw new Error("Missing required env variables")
        }
        this.wallet = this.ethService.privateKeyToWallet(privateKey)
        await this.createNonceMutex([this.wallet])
        await this.createMarketMap()

        try {
            this.referralCode = await this.perpService.getReferralCode(this.wallet.address)
        } catch (err: any) {
            if (this.perpService.serverProfile.stage === "production") {
                if (err.message && err.message.includes("You do not have a referral code")) {
                    this.log.jinfo({ event: "NoReferralCode" })
                } else {
                    await this.log.jerror({ event: "GetReferralCodeError", params: { err } })
                }
            }
        }

        this.log.jinfo({
            event: "Arbitrageur",
            params: {
                address: this.wallet.address,
                nextNonce: this.addrNonceMutexMap[this.wallet.address].nextNonce,
                referralCode: this.referralCode,
            },
        })
        this.ftxClient = new FTXRest({
            key: ftxKey,
            secret: ftxSecret,
            subaccount: ftxSubaccount,
            timeout: 60 * 1000,
        })
    }

    async createMarketMap() {
        const poolMap: { [keys: string]: any } = {}
        for (const pool of this.perpService.metadata.pools) {
            poolMap[pool.baseSymbol] = pool
        }
        for (const [marketName, market] of Object.entries(config.MARKET_MAP)) {
            if (!market.IS_ENABLED) {
                continue
            }
            const pool = poolMap[marketName]
            const ftxMarket = await this.ftxService.getMarket(market.FTX_MARKET_NAME)
            this.marketMap[marketName] = {
                name: marketName,
                baseToken: pool.baseAddress,
                poolAddr: pool.address,
                ftxSizeIncrement: ftxMarket.sizeIncrement,
                // config
                ftxMarketName: market.FTX_MARKET_NAME,
                orderAmount: Big(market.ORDER_AMOUNT),
                // spread
                shortTriggerSpread: Big(market.SHORT_TRIGGER_SPREAD),
                longTriggerSpread: Big(market.LONG_TRIGGER_SPREAD),
                // emergency reduce mode
                isEmergencyReduceModeEnabled: market.IS_EMERGENCY_REDUCE_MODE_ENABLED,
                // balance routine
                imbalanceStartTime: null,
            }
        }
    }

    async start(): Promise<void> {
        this.ethService.enableEndpointRotation()
        const balance = await this.perpService.getUSDCBalance(this.wallet.address)
        this.log.jinfo({ event: "CheckUSDCBalance", params: { balance: +balance } })
        if (balance.gt(0)) {
            await this.approve(this.wallet, balance)
            await this.deposit(this.wallet, balance)
        }
        this.emergencyReduceRoutine()
        this.balanceRoutine()
        this.arbitrageRoutine()
    }

    isImbalance(market: Market, ftxPositionSize: Big, perpPositionSize: Big): boolean {
        const positionSizeDiffAbs = ftxPositionSize.add(perpPositionSize).abs()
        return positionSizeDiffAbs.gte(market.ftxSizeIncrement)
    }

    async balance(market: Market) {
        const [isBelowFTXMarginRatio, perpPositionSize, ftxPositionSize] = await Promise.all([
            this.isBelowFTXMarginRatio(config.FTX_MIN_MARGIN_RATIO),
            this.perpService.getTotalPositionSize(this.wallet.address, market.baseToken),
            this.ftxService.getPositionSize(this.ftxClient, market.ftxMarketName),
        ])
        const positionSizeDiffAbs = ftxPositionSize.add(perpPositionSize).abs()
        if (this.isImbalance(market, ftxPositionSize, perpPositionSize)) {
            const now = Date.now()
            if (market.imbalanceStartTime === null) {
                market.imbalanceStartTime = now
            }
            this.log.jinfo({
                event: "Imbalance",
                params: {
                    market: market.name,
                    perpPositionSize: +perpPositionSize,
                    ftxPositionSize: +ftxPositionSize,
                    ts: market.imbalanceStartTime,
                },
            })
            if ((now - market.imbalanceStartTime) / 1000 >= 30) {
                const positionSizeDiff = ftxPositionSize.add(perpPositionSize)
                const isReduceOnFTX = ftxPositionSize.abs() > perpPositionSize.abs()
                if (isReduceOnFTX || !isBelowFTXMarginRatio) {
                    // balance on FTX
                    this.log.jinfo({
                        event: "BalanceOnFTX",
                        params: { positionSizeDiff: +positionSizeDiff, isReduceOnFTX, isBelowFTXMarginRatio },
                    })
                    const side = positionSizeDiff.gt(0) ? FTXSide.SELL : FTXSide.BUY
                    await this.ftxService.placeOrder(this.ftxClient, {
                        market: market.ftxMarketName,
                        side,
                        price: null,
                        size: +positionSizeDiffAbs,
                        type: OrderType.MARKET,
                    })
                } else {
                    // balance on perp, always reduce
                    this.log.jinfo({
                        event: "BalanceOnPerp",
                        params: { positionSizeDiff: +positionSizeDiff, isReduceOnFTX, isBelowFTXMarginRatio },
                    })
                    const side = positionSizeDiff.gt(0) ? Side.SHORT : Side.LONG
                    await this.openPosition(
                        this.wallet,
                        market.baseToken,
                        side,
                        AmountType.BASE,
                        positionSizeDiffAbs,
                        undefined,
                        Big(config.BALANCE_MAX_GAS_FEE_ETH),
                        this.referralCode,
                    )
                }
                market.imbalanceStartTime = null
            }
        } else {
            market.imbalanceStartTime = null
        }
    }

    async balanceRoutine() {
        while (true) {
            this.markRoutineAlive("BalanceRoutine")
            for (const market of Object.values(this.marketMap)) {
                try {
                    await this.balance(market)
                } catch (err: any) {
                    await this.jerror({ event: "BalanceError", params: { err } })
                }
            }
            await sleep(config.BALANCE_CHECK_INTERVAL_SEC * 1000)
        }
    }

    async arbitrageRoutine() {
        while (true) {
            this.markRoutineAlive("ArbitrageRoutine")
            await Promise.all(
                Object.values(this.marketMap).map(async market => {
                    try {
                        await this.arbitrage(market)
                    } catch (err: any) {
                        await this.jerror({ event: "ArbitrageError", params: { err } })
                    }
                }),
            )
            await sleep(config.PRICE_CHECK_INTERVAL_SEC * 1000)
        }
    }

    async emergencyReducePerpPosition(market: Market) {
        const positionValue = await this.perpService.getTotalPositionValue(this.wallet.address, market.baseToken)
        if (positionValue.abs().lte(DUST_USD_SIZE)) {
            this.log.jinfo({
                event: "EmergencyReducePositionValueIsTooSmall",
                params: { market: market.name, positionValue: +positionValue },
            })
            return
        }
        const emergencyReduceAmount = min([Big(config.EMERGENCY_REDUCE_AMOUNT), positionValue.abs()])
        const side = positionValue.gt(0) ? Side.SHORT : Side.LONG
        this.log.jinfo({
            event: "EmergencyReducePerpPosition",
            params: { market: market.name, reduceAmount: +emergencyReduceAmount, positionValue: +positionValue },
        })
        await this.openPosition(
            this.wallet,
            market.baseToken,
            side,
            AmountType.QUOTE,
            emergencyReduceAmount,
            undefined,
            undefined,
            this.referralCode,
        )
    }

    async emergencyReduceFTXPosition(market: Market) {
        const emergencyReduceAmount = Big(config.EMERGENCY_REDUCE_AMOUNT)
        const positionSize = await this.ftxService.getPositionSize(this.ftxClient, market.ftxMarketName)
        if (positionSize.eq(0)) {
            return
        }
        const price = await this.ftxService.getPrice(market.ftxMarketName)
        const reduceSize = min([positionSize.abs(), emergencyReduceAmount.div(price)])
        if (reduceSize.lt(market.ftxSizeIncrement)) {
            return
        }
        const side = positionSize.gt(0) ? FTXSide.SELL : FTXSide.BUY
        try {
            this.log.jinfo({
                event: "EmergencyReduceFTXPosition",
                params: { market: market.name, reduceSize: +reduceSize, positionSize: +positionSize },
            })
            await this.ftxService.placeOrder(this.ftxClient, {
                market: market.ftxMarketName,
                side,
                price: null,
                size: +reduceSize,
                type: OrderType.MARKET,
            })
        } catch (err: any) {
            await this.jerror({
                event: "FTXPlaceOrderError",
                params: { err, market: market.ftxMarketName, side, size: +reduceSize },
            })
            throw err
        }
    }

    async emergencyReducePosition(market: Market) {
        if (!market.isEmergencyReduceModeEnabled) {
            return
        }
        await Promise.allSettled([this.emergencyReducePerpPosition(market), this.emergencyReduceFTXPosition(market)])
    }

    private async isBelowFTXMarginRatio(criterion: number) {
        const accountInfo = await this.ftxService.getAccountInfo(this.ftxClient)
        const marginRatio = accountInfo.marginFraction
        this.log.jinfo({ event: "FTXMarginRatio", params: { marginRatio: marginRatio === null ? null : +marginRatio } })
        return marginRatio !== null && marginRatio.lt(criterion)
    }

    private async isBelowPerpMarginRatio(criterion: number) {
        const marginRatio = await this.perpService.getMarginRatio(this.wallet.address)
        this.log.jinfo({
            event: "PerpMarginRatio",
            params: { marginRatio: marginRatio === null ? null : +marginRatio },
        })
        return marginRatio !== null && marginRatio.lt(criterion)
    }

    async emergencyReduceRoutine() {
        while (true) {
            try {
                this.markRoutineAlive("EmergencyReduceRoutine")
                const isBelowFTXMarginRatio = await this.isBelowFTXMarginRatio(config.FTX_EMERGENCY_MARGIN_RATIO)
                const isBelowPerpMarginRatio = await this.isBelowPerpMarginRatio(config.PERP_EMERGENCY_MARGIN_RATIO)
                if (isBelowFTXMarginRatio || isBelowPerpMarginRatio) {
                    this.log.jinfo({
                        event: "EnterEmergencyReduceMode",
                        params: {
                            perpEmergencyMarginRatio: config.PERP_EMERGENCY_MARGIN_RATIO,
                            ftxEmergencyMarginRatio: config.FTX_EMERGENCY_MARGIN_RATIO,
                        },
                    })
                    await Promise.allSettled(
                        Object.values(this.marketMap).map(market => this.emergencyReducePosition(market)),
                    )
                    await sleep(config.EMERGENCY_REDUCE_SLEEP_SEC * 1000)
                }
                await sleep(config.EMERGENCY_REDUCE_CHECK_INTERVAL_SEC * 1000)
            } catch (err: any) {
                await this.jerror({ event: "EmergencyReduceRoutineError", params: { err } })
            }
        }
    }

    async getAvgPrice(market: Market, side: Side, openOrderAmount: Big) {
        const swapResp = await this.perpService.quote(market.baseToken, side, AmountType.QUOTE, openOrderAmount, Big(0))
        return swapResp.deltaAvailableQuote.div(swapResp.deltaAvailableBase)
    }

    async calcOpenSize(market: Market, ftxPrice: Big, openOrderAmount: Big, isIncrease: boolean) {
        const buyingPower = await this.perpService.getBuyingPower(this.wallet.address)
        if (isIncrease) {
            openOrderAmount = min([openOrderAmount, buyingPower])
        }
        const precision = Math.floor(-Math.log10(+market.ftxSizeIncrement))
        const baseSize = openOrderAmount.div(ftxPrice).round(precision, Big.roundDown)
        if (baseSize.lt(market.ftxSizeIncrement)) {
            const err = new Error("OpenSizeSmallerThanFTXSizeIncrementError")
            await this.log.jerror({
                event: "OpenSizeSmallerThanFTXSizeIncrementError",
                params: {
                    err,
                    market: market.name,
                    openOrderAmount: +openOrderAmount,
                    baseSize: +baseSize,
                    precision,
                    ftxSizeIncrement: +market.ftxSizeIncrement,
                },
            })
            throw err
        }
        return baseSize
    }

    async arbitrage(market: Market) {
        // getting margin ratio
        const [isBelowPerpMarginRatio, isBelowFTXMarginRatio, perpPositionSize, ftxPositionSize] = await Promise.all([
            this.isBelowPerpMarginRatio(config.PERP_MIN_MARGIN_RATIO),
            this.isBelowFTXMarginRatio(config.FTX_MIN_MARGIN_RATIO),
            this.perpService.getTotalPositionSize(this.wallet.address, market.baseToken),
            this.ftxService.getPositionSize(this.ftxClient, market.ftxMarketName),
        ])
        if (this.isImbalance(market, ftxPositionSize, perpPositionSize)) {
            this.log.jinfo({
                event: "SkipArbitrageDueToImbalance",
                params: { market: market.name, ftxPositionSize: +ftxPositionSize, perpPositionSize: +perpPositionSize },
            })
            return
        }

        // spread
        const orderAmount = market.orderAmount
        const [ftxPrice, perpLongAvgPrice, perpShortAvgPrice] = await Promise.all([
            this.ftxService.getPrice(market.ftxMarketName),
            this.getAvgPrice(market, Side.LONG, orderAmount),
            this.getAvgPrice(market, Side.SHORT, orderAmount),
        ])
        const curShortSpread = perpShortAvgPrice.minus(ftxPrice).div(ftxPrice)
        const curLongSpread = perpLongAvgPrice.minus(ftxPrice).div(ftxPrice)

        this.log.jinfo({
            event: "Spread",
            params: {
                market: market.name,
                ftxPrice: +ftxPrice,
                perpShortAvgPrice: +perpShortAvgPrice,
                perpLongAvgPrice: +perpLongAvgPrice,
                shortTriggerSpread: +market.shortTriggerSpread,
                curShortSpread: +curShortSpread,
                curLongSpread: +curLongSpread,
                longTriggerSpread: +market.longTriggerSpread,
            },
        })
        const isBelowMarginRatio = isBelowPerpMarginRatio || isBelowFTXMarginRatio
        this.log.jinfo({
            event: "PositionSizeBefore",
            params: { market: market.name, perpPositionSize: +perpPositionSize, ftxPositionSize: +ftxPositionSize },
        })
        const reduceSide = perpPositionSize.lte(0) ? Side.LONG : Side.SHORT
        const estimatedGasFee = await this.estimateOpenPositionGasFee(
            this.wallet,
            market.baseToken,
            reduceSide,
            AmountType.QUOTE,
            orderAmount,
            undefined,
            this.referralCode,
        )
        if (estimatedGasFee.gt(this.arbitrageMaxGasFeeEth)) {
            this.log.jinfo({
                event: "GasFeeTooHigh",
                params: {
                    market: market.name,
                    estimatedGasFee: +estimatedGasFee,
                    arbitrageMaxGasFeeEth: +this.arbitrageMaxGasFeeEth,
                },
            })
            return
        }

        if (curShortSpread.gt(market.shortTriggerSpread)) {
            // short
            const perpSide = Side.SHORT
            const ftxSide = FTXSide.BUY
            // should not increase position if we are below min margin ratio
            const isIncrease = perpPositionSize.lte(0)
            if (isIncrease && isBelowMarginRatio) {
                this.log.jinfo({
                    event: "ShouldNotIncreasePerpPosition",
                    params: {
                        perpMinMarginRatio: config.PERP_MIN_MARGIN_RATIO,
                        ftxMinMarginRatio: config.FTX_MIN_MARGIN_RATIO,
                    },
                })
                return
            }
            const size = await this.calcOpenSize(market, ftxPrice, orderAmount, isIncrease)
            this.log.jinfo({
                event: "ShortArbitrage",
                params: {
                    market: market.name,
                    size: +size,
                    ftxSizeIncrement: +market.ftxSizeIncrement,
                },
            })
            await Promise.all([
                this.openPosition(
                    this.wallet,
                    market.baseToken,
                    perpSide,
                    AmountType.BASE,
                    size,
                    undefined,
                    undefined,
                    this.referralCode,
                ),
                this.ftxService.placeOrder(this.ftxClient, {
                    market: market.ftxMarketName,
                    side: ftxSide,
                    price: null,
                    size: +size,
                    type: OrderType.MARKET,
                }),
            ])
        } else if (curLongSpread.lt(market.longTriggerSpread)) {
            // long
            const perpSide = Side.LONG
            const ftxSide = FTXSide.SELL
            // should not increase position if we are below min margin ratio
            const isIncrease = perpPositionSize.gte(0)
            if (isIncrease && isBelowMarginRatio) {
                this.log.jinfo({
                    event: "ShouldNotIncreasePerpPosition",
                    params: {
                        perpMinMarginRatio: config.PERP_MIN_MARGIN_RATIO,
                        ftxMinMarginRatio: config.FTX_MIN_MARGIN_RATIO,
                    },
                })
                return
            }
            const size = await this.calcOpenSize(market, ftxPrice, orderAmount, isIncrease)
            this.log.jinfo({
                event: "LongArbitrage",
                params: {
                    market: market.name,
                    size: +size,
                    ftxSizeIncrement: +market.ftxSizeIncrement,
                },
            })
            await Promise.all([
                this.openPosition(
                    this.wallet,
                    market.baseToken,
                    perpSide,
                    AmountType.BASE,
                    size,
                    undefined,
                    undefined,
                    this.referralCode,
                ),
                this.ftxService.placeOrder(this.ftxClient, {
                    market: market.ftxMarketName,
                    side: ftxSide,
                    price: null,
                    size: +size,
                    type: OrderType.MARKET,
                }),
            ])
        } else {
            this.log.jinfo({ event: "NotTriggered", params: { market: market.name } })
        }
        let [perpPositionSizeAfter, ftxPositionSizeAfter] = await Promise.all([
            this.perpService.getTotalPositionSize(this.wallet.address, market.baseToken),
            this.ftxService.getPositionSize(this.ftxClient, market.ftxMarketName),
        ])
        this.log.jinfo({
            event: "PositionSizeAfter",
            params: {
                market: market.name,
                perpPositionSize: +perpPositionSizeAfter,
                ftxPositionSize: +ftxPositionSizeAfter,
            },
        })
    }
}
