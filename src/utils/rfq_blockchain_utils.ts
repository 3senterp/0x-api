import { IZeroExRfqOrderFilledEventArgs } from '@0x/contract-wrappers';
import { IZeroExContract } from '@0x/contracts-zero-ex';
import { MetaTransaction, RfqOrder, Signature } from '@0x/protocol-utils';
import { PrivateKeyWalletSubprovider, SupportedProvider, Web3ProviderEngine } from '@0x/subproviders';
import { AbiDecoder, BigNumber, providerUtils } from '@0x/utils';
import { Web3Wrapper } from '@0x/web3-wrapper';
import { HDNode } from '@ethersproject/hdnode';
import { CallData, LogEntry, LogWithDecodedArgs, TransactionReceipt, TxData } from 'ethereum-types';

import { NULL_ADDRESS, ZERO } from '../constants';
import { logger } from '../logger';
import { ChainId } from '../types';

import { isWorkerReadyAndAbleAsync } from './rfqm_worker_balance_utils';
import { SubproviderAdapter } from './subprovider_adapter';

// allow a wide range for gas price for flexibility
const MIN_GAS_PRICE = new BigNumber(0);
// 10K Gwei
const MAX_GAS_PRICE = new BigNumber(1e13);
const GAS_ESTIMATE_BUFFER = 0.5;
const RFQ_ORDER_FILLED_EVENT_TOPIC0 = '0x829fa99d94dc4636925b38632e625736a614c154d55006b7ab6bea979c210c32';
const RFQ_ORDER_FILLED_EVENT_ABI = [
    {
        anonymous: false,
        inputs: [
            { indexed: false, internalType: 'bytes32', name: 'orderHash', type: 'bytes32' },
            { indexed: false, internalType: 'address', name: 'maker', type: 'address' },
            { indexed: false, internalType: 'address', name: 'taker', type: 'address' },
            { indexed: false, internalType: 'address', name: 'makerToken', type: 'address' },
            { indexed: false, internalType: 'address', name: 'takerToken', type: 'address' },
            { indexed: false, internalType: 'uint128', name: 'takerTokenFilledAmount', type: 'uint128' },
            { indexed: false, internalType: 'uint128', name: 'makerTokenFilledAmount', type: 'uint128' },
            { indexed: false, internalType: 'bytes32', name: 'pool', type: 'bytes32' },
        ],
        name: 'RfqOrderFilled',
        type: 'event',
    },
];

export class RfqBlockchainUtils {
    private readonly _exchangeProxy: IZeroExContract;
    private readonly _web3Wrapper: Web3Wrapper;
    private readonly _abiDecoder: AbiDecoder;

    public static getPrivateKeyFromIndexAndPhrase(mnemonic: string, index: number): string {
        const hdNode = HDNode.fromMnemonic(mnemonic).derivePath(this._getPathByIndex(index));

        // take '0x' off
        return hdNode.privateKey.substring(2);
    }

    public static getAddressFromIndexAndPhrase(mnemonic: string, index: number): string {
        const hdNode = HDNode.fromMnemonic(mnemonic).derivePath(this._getPathByIndex(index));

        return hdNode.address;
    }

    public static createPrivateKeyProvider(
        rpcProvider: SupportedProvider,
        privateWalletSubprovider: PrivateKeyWalletSubprovider,
    ): SupportedProvider {
        const providerEngine = new Web3ProviderEngine();
        providerEngine.addProvider(privateWalletSubprovider);
        providerEngine.addProvider(new SubproviderAdapter(rpcProvider));
        providerUtils.startProviderEngine(providerEngine);
        return providerEngine;
    }

    // tslint:disable-next-line:prefer-function-over-method
    private static _getPathByIndex(index: number): string {
        // ensure index is a 0+ integer
        if (index < 0 || index !== Math.floor(index)) {
            throw new Error(`invalid index`);
        }
        return `m/44'/60'/0'/0/`.concat(String(index));
    }

    constructor(provider: SupportedProvider, private readonly _exchangeProxyAddress: string) {
        this._exchangeProxy = new IZeroExContract(this._exchangeProxyAddress, provider);
        this._web3Wrapper = new Web3Wrapper(provider);
        this._abiDecoder = new AbiDecoder([RFQ_ORDER_FILLED_EVENT_ABI]);
    }

    // for use when 0x API operator submits an order on-chain on behalf of taker
    public generateMetaTransaction(
        rfqOrder: RfqOrder,
        signature: Signature,
        taker: string,
        takerAmount: BigNumber,
        chainId: ChainId,
    ): MetaTransaction {
        // generate call data for fillRfqOrder
        const callData = this._exchangeProxy
            .fillRfqOrder(rfqOrder, signature, takerAmount)
            .getABIEncodedTransactionData();

        return new MetaTransaction({
            signer: taker,
            sender: NULL_ADDRESS,
            minGasPrice: MIN_GAS_PRICE,
            maxGasPrice: MAX_GAS_PRICE,
            expirationTimeSeconds: rfqOrder.expiry,
            salt: new BigNumber(Date.now()),
            callData,
            value: ZERO,
            feeToken: NULL_ADDRESS,
            feeAmount: ZERO,
            chainId,
            verifyingContract: this._exchangeProxy.address,
        });
    }

    public async decodeMetaTransactionCallDataAndValidateAsync(
        calldata: string,
        sender: string,
        txOptions?: Partial<CallData>,
    ): Promise<[BigNumber, BigNumber]> {
        const metaTxInput: any = this._exchangeProxy.getABIDecodedTransactionData('executeMetaTransaction', calldata);
        return this.validateMetaTransactionOrThrowAsync(metaTxInput[0], metaTxInput[1], sender, txOptions);
    }

    public getTakerTokenFillAmountFromMetaTxCallData(calldata: string): BigNumber {
        const metaTxInput: any = this._exchangeProxy.getABIDecodedTransactionData('executeMetaTransaction', calldata);
        return (this._exchangeProxy.getABIDecodedTransactionData('fillRfqOrder', metaTxInput[0].callData) as any)[2];
    }

    public async validateMetaTransactionOrThrowAsync(
        metaTx: MetaTransaction,
        metaTxSig: Signature,
        sender: string,
        txOptions?: Partial<CallData>,
    ): Promise<[BigNumber, BigNumber]> {
        try {
            const results = await this._exchangeProxy
                .executeMetaTransaction(metaTx, metaTxSig)
                .callAsync({ from: sender, ...txOptions });
            const takerTokenFillAmount = (
                this._exchangeProxy.getABIDecodedTransactionData('fillRfqOrder', metaTx.callData) as any
            )[2];
            const decodedResults: [BigNumber, BigNumber] = this._exchangeProxy.getABIDecodedReturnData(
                'fillRfqOrder',
                results,
            );
            if (decodedResults[0].isLessThan(takerTokenFillAmount)) {
                throw new Error(`filled amount is less than requested fill amount`);
            }
            // returns [takerTokenFilledAmount, makerTokenFilledAmount]
            return decodedResults;
        } catch (err) {
            throw new Error(err);
        }
    }

    public generateMetaTransactionCallData(metaTx: MetaTransaction, metaTxSig: Signature): string {
        return this._exchangeProxy.executeMetaTransaction(metaTx, metaTxSig).getABIEncodedTransactionData();
    }

    public async getNonceAsync(workerAddress: string): Promise<number> {
        return this._web3Wrapper.getAccountNonceAsync(workerAddress);
    }

    public getExchangeProxyAddress(): string {
        return this._exchangeProxyAddress;
    }

    public async getTransactionReceiptIfExistsAsync(transactionHash: string): Promise<TransactionReceipt | undefined> {
        try {
            return await this._web3Wrapper.getTransactionReceiptIfExistsAsync(transactionHash);
        } catch (err) {
            logger.warn({ transactionHash, error: err }, `failed to get transaction receipt`);
            return undefined;
        }
    }

    public async getCurrentBlockAsync(): Promise<number> {
        return this._web3Wrapper.getBlockNumberAsync();
    }

    public async estimateGasForExchangeProxyCallAsync(callData: string, workerAddress: string): Promise<number> {
        const txData: Partial<TxData> = {
            to: this._exchangeProxy.address,
            data: callData,
            from: workerAddress,
        };

        const gasEstimate = await this._web3Wrapper.estimateGasAsync(txData);

        // add a buffer
        return Math.ceil((GAS_ESTIMATE_BUFFER + 1) * gasEstimate);
    }

    public getDecodedRfqOrderFillEventLogFromLogs(
        logs: LogEntry[],
    ): LogWithDecodedArgs<IZeroExRfqOrderFilledEventArgs> {
        for (const log of logs) {
            if (log.topics[0] === RFQ_ORDER_FILLED_EVENT_TOPIC0) {
                return this._abiDecoder.tryToDecodeLogOrNoop(log) as LogWithDecodedArgs<IZeroExRfqOrderFilledEventArgs>;
            }
        }
        throw new Error(
            `no RfqOrderFilledEvent logs among the logs passed into getDecodedRfqOrderFillEventLogFromLogs`,
        );
    }

    public async submitCallDataToExchangeProxyAsync(
        callData: string,
        workerAddress: string,
        txOptions?: Partial<TxData>,
    ): Promise<string> {
        const txData: TxData = {
            to: this._exchangeProxy.address,
            data: callData,
            from: workerAddress,
            ...txOptions,
        };

        return this._web3Wrapper.sendTransactionAsync(txData);
    }

    public async getAccountBalanceAsync(accountAddress: string): Promise<BigNumber> {
        return this._web3Wrapper.getBalanceInWeiAsync(accountAddress);
    }

    public async isWorkerReadyAsync(workerAddress: string, balance: BigNumber, gasPrice: BigNumber): Promise<boolean> {
        return isWorkerReadyAndAbleAsync(this._web3Wrapper, workerAddress, balance, gasPrice);
    }
}
