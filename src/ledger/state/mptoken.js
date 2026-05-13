import { writeBalance } from "../../db/helpers/balances.js"
import { readTokenMetrics, writeTokenMetrics } from "../../db/helpers/tokenmetrics.js"
import { eq, gt, sum, sub } from '../../../vendor/xfl/wrappers/class.js'
import { issuerFromMPTIssuanceId } from "../../xrpl/mpt.js"
import TokenType from "../../xrpl/tokentype.js"
import { isPseudoAccount } from "./pseudoaccounts.js"

export function parse({ entry }){
    return {
        account: entry.Account,
        mptAmount: entry.MPTAmount || 0,
        mptIssuanceId: entry.MPTokenIssuanceID,
        ledgerSequence: entry.LedgerSequence,
        flags: entry.Flags || 0
    }
}

export function diff({ ctx, previous, final }){
    let account = final?.account || previous?.account
    let mptIssuanceId = final?.mptIssuanceId || previous?.mptIssuanceId
    let pseudo = isPseudoAccount({ ctx, address: account })

    let token = ctx.db.core.tokens.createOne({
        data: {
            issuer: { address: issuerFromMPTIssuanceId(mptIssuanceId) },
            mptIssuanceId,
            tokenType: TokenType.MPT
        }
    })

    let { holders, supply } = readTokenMetrics({
        ctx,
        token,
        metrics: { holders: true, supply: true },
        ledgerSequence: ctx.ledgerSequence
    })

    let metrics = {
        holders: holders || 0,
        supply: supply || 0,
    }

    if(previous && final){
        metrics.supply = sum(
            metrics.supply,
            sub(final.mptAmount, previous.mptAmount)
        )

        if(!pseudo){
            if(eq(previous.mptAmount, 0) && gt(final.mptAmount, 0)){
                metrics.holders++
            }else if(eq(final.mptAmount, 0) && gt(previous.mptAmount, 0)){
                metrics.holders--
            }
        }
    }else if(final){
        metrics.supply = sum(metrics.supply, final.mptAmount)

        if(!pseudo && gt(final.mptAmount, 0)){
            metrics.holders++
        }
    }else{
        metrics.supply = sub(metrics.supply, previous.mptAmount)

        if(!pseudo && gt(previous.mptAmount, 0)){
            metrics.holders--
        }
    }

    if(ctx.backwards && !previous){
        writeBalance({
            ctx,
            account: { address: account },
            token,
            ledgerSequence: ctx.ledgerSequence,
            balance: 0,
        })
    }

    if(final){
        writeBalance({
            ctx,
            account: { address: account },
            token,
            ledgerSequence: final.ledgerSequence,
            balance: final.mptAmount,
        })
    }else{
        writeBalance({
            ctx,
            account: { address: account },
            token,
            ledgerSequence: ctx.ledgerSequence,
            balance: 0,
        })
    }

    writeTokenMetrics({ ctx, token, metrics, ledgerSequence: ctx.ledgerSequence })
}
