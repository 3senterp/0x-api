import { ContractAddresses, getContractAddressesForChainOrThrow } from '@0x/contract-addresses';
import { DummyERC20TokenContract, WETH9Contract } from '@0x/contracts-erc20';
import { constants, expect, OrderFactory } from '@0x/contracts-test-utils';
import { BlockchainLifecycle, web3Factory, Web3ProviderEngine } from '@0x/dev-utils';
import { assetDataUtils, Order, orderHashUtils } from '@0x/order-utils';
import { BigNumber } from '@0x/utils';
import { Web3Wrapper } from '@0x/web3-wrapper';
import { Server } from 'http';
import * as HttpStatus from 'http-status-codes';
import 'mocha';
import { ImportMock } from 'ts-mock-imports';

import { AppDependencies, getAppAsync, getDefaultAppDependenciesAsync } from '../src/app';
import * as config from '../src/config';
import { DEFAULT_PAGE, DEFAULT_PER_PAGE, NULL_ADDRESS, SRA_PATH } from '../src/constants';
import { getDBConnectionAsync } from '../src/db_connection';
import { ErrorBody, GeneralErrorCodes, generalErrorCodeToReason, ValidationErrorCodes } from '../src/errors';
import { APIOrderWithMetaData } from '../src/types';
import * as MeshClientModule from '../src/utils/mesh_client';
import { orderUtils } from '../src/utils/order_utils';

import { setupDependenciesAsync, teardownDependenciesAsync, teardownMeshAsync } from './utils/deployment';
import { constructRoute, httpGetAsync, httpPostAsync } from './utils/http_utils';
import { MeshClient as MeshClientMock } from './utils/mesh_client_mock';
import { DEFAULT_MAKER_ASSET_AMOUNT, MeshTestUtils } from './utils/mesh_test_utils';

const _meshClientMock = new MeshClientMock();
const meshClientMockManager = ImportMock.mockClass(MeshClientModule, 'MeshClient');
meshClientMockManager.mock('getStatsAsync').callsFake(_meshClientMock.getStatsAsync.bind(_meshClientMock));
meshClientMockManager.mock('getOrdersAsync').callsFake(_meshClientMock.getOrdersAsync.bind(_meshClientMock));
meshClientMockManager.mock('addOrdersAsync').callsFake(_meshClientMock.addOrdersAsync.bind(_meshClientMock));
meshClientMockManager.mock('onOrderEvents').callsFake(_meshClientMock.onOrderEvents.bind(_meshClientMock));

const SUITE_NAME = 'Standard Relayer API (SRA) tests';

const EMPTY_PAGINATED_RESPONSE = {
    perPage: DEFAULT_PER_PAGE,
    page: DEFAULT_PAGE,
    total: 0,
    records: [],
};

const TOMORROW = new BigNumber(Date.now() + 24 * 3600); // tslint:disable-line:custom-no-magic-numbers
async function addNewSignedOrderAsync(
    orderFactory: OrderFactory,
    params: Partial<Order>,
    remainingFillableAssetAmount?: BigNumber,
): Promise<APIOrderWithMetaData> {
    const order = await orderFactory.newSignedOrderAsync({
        expirationTimeSeconds: TOMORROW,
        ...params,
    });
    const apiOrder: APIOrderWithMetaData = {
        order,
        metaData: {
            orderHash: orderHashUtils.getOrderHash(order),
            remainingFillableTakerAssetAmount: remainingFillableAssetAmount || order.takerAssetAmount,
        },
    };
    await (await getDBConnectionAsync()).manager.save(orderUtils.serializeOrder(apiOrder));
    return apiOrder;
}
describe(SUITE_NAME, () => {
    let app: Express.Application;
    let server: Server;
    let dependencies: AppDependencies;
    let chainId: number;
    let contractAddresses: ContractAddresses;
    let makerAddress: string;

    let blockchainLifecycle: BlockchainLifecycle;
    let provider: Web3ProviderEngine;

    let weth: WETH9Contract;
    let zrx: DummyERC20TokenContract;

    let orderFactory: OrderFactory;
    let meshUtils: MeshTestUtils;

    before(async () => {
        await setupDependenciesAsync(SUITE_NAME);
        // We won't need Mesh as it's mocked out
        // TODO(kimpers): Don't spin up Mesh in the first place
        await teardownMeshAsync(SUITE_NAME);

        // connect to ganache and run contract migrations
        const ganacheConfigs = {
            shouldUseInProcessGanache: false,
            shouldAllowUnlimitedContractSize: true,
            rpcUrl: config.ETHEREUM_RPC_URL,
        };
        provider = web3Factory.getRpcProvider(ganacheConfigs);

        // start the 0x-api app
        dependencies = await getDefaultAppDependenciesAsync(provider, config.defaultHttpServiceConfig);
        ({ app, server } = await getAppAsync({ ...dependencies }, config.defaultHttpServiceConfig));

        const web3Wrapper = new Web3Wrapper(provider);
        blockchainLifecycle = new BlockchainLifecycle(web3Wrapper);

        const accounts = await web3Wrapper.getAvailableAddressesAsync();
        [makerAddress] = accounts;

        chainId = await web3Wrapper.getChainIdAsync();
        contractAddresses = getContractAddressesForChainOrThrow(chainId);

        weth = new WETH9Contract(contractAddresses.etherToken, provider);
        zrx = new DummyERC20TokenContract(contractAddresses.zrxToken, provider);

        const defaultOrderParams = {
            ...constants.STATIC_ORDER_PARAMS,
            makerAddress,
            feeRecipientAddress: constants.NULL_ADDRESS,
            makerAssetData: assetDataUtils.encodeERC20AssetData(zrx.address),
            takerAssetData: assetDataUtils.encodeERC20AssetData(weth.address),
            makerAssetAmount: DEFAULT_MAKER_ASSET_AMOUNT,
            makerFeeAssetData: '0x',
            takerFeeAssetData: '0x',
            makerFee: constants.ZERO_AMOUNT,
            takerFee: constants.ZERO_AMOUNT,
            exchangeAddress: contractAddresses.exchange,
            chainId,
        };
        const privateKey = constants.TESTRPC_PRIVATE_KEYS[accounts.indexOf(makerAddress)];
        orderFactory = new OrderFactory(privateKey, defaultOrderParams);
        await blockchainLifecycle.startAsync();

        meshUtils = new MeshTestUtils(provider);
        await meshUtils.setupUtilsAsync();
    });
    after(async () => {
        await blockchainLifecycle.revertAsync();
        await new Promise<void>((resolve, reject) => {
            server.close((err?: Error) => {
                if (err) {
                    reject(err);
                }
                resolve();
            });
        });
        await teardownDependenciesAsync(SUITE_NAME);
        meshClientMockManager.restore();
    });

    describe('/fee_recipients', () => {
        it('should return the list of fee recipients', async () => {
            const response = await httpGetAsync({ app, route: `${SRA_PATH}/fee_recipients` });

            expect(response.status).to.eq(HttpStatus.OK);
            expect(response.type).to.eq('application/json');
            expect(response.body).to.deep.eq({
                ...EMPTY_PAGINATED_RESPONSE,
                total: 1,
                records: [NULL_ADDRESS],
            });
        });
    });
    describe('/orders', () => {
        it('should return empty response when no orders', async () => {
            const response = await httpGetAsync({ app, route: `${SRA_PATH}/orders` });

            expect(response.type).to.eq(`application/json`);
            expect(response.status).to.eq(HttpStatus.OK);
            expect(response.body).to.deep.eq(EMPTY_PAGINATED_RESPONSE);
        });
        it('should return orders in the local cache', async () => {
            const apiOrder = await addNewSignedOrderAsync(orderFactory, {});
            const response = await httpGetAsync({ app, route: `${SRA_PATH}/orders` });

            expect(response.type).to.eq(`application/json`);
            expect(response.status).to.eq(HttpStatus.OK);
            expect(response.body).to.deep.eq({
                ...EMPTY_PAGINATED_RESPONSE,
                total: 1,
                records: [JSON.parse(JSON.stringify(apiOrder))],
            });

            await (await getDBConnectionAsync()).manager.remove(orderUtils.serializeOrder(apiOrder));
        });
        it('should return orders filtered by query params', async () => {
            const apiOrder = await addNewSignedOrderAsync(orderFactory, {});
            const response = await httpGetAsync({
                app,
                route: `${SRA_PATH}/orders?makerAddress=${apiOrder.order.makerAddress}`,
            });

            expect(response.type).to.eq(`application/json`);
            expect(response.status).to.eq(HttpStatus.OK);
            expect(response.body).to.deep.eq({
                ...EMPTY_PAGINATED_RESPONSE,
                total: 1,
                records: [JSON.parse(JSON.stringify(apiOrder))],
            });

            await (await getDBConnectionAsync()).manager.remove(orderUtils.serializeOrder(apiOrder));
        });
        it('should return empty response when filtered by query params', async () => {
            const apiOrder = await addNewSignedOrderAsync(orderFactory, {});
            const response = await httpGetAsync({ app, route: `${SRA_PATH}/orders?makerAddress=${NULL_ADDRESS}` });

            expect(response.type).to.eq(`application/json`);
            expect(response.status).to.eq(HttpStatus.OK);
            expect(response.body).to.deep.eq(EMPTY_PAGINATED_RESPONSE);

            await (await getDBConnectionAsync()).manager.remove(orderUtils.serializeOrder(apiOrder));
        });
        it('should normalize addresses to lowercase', async () => {
            const apiOrder = await addNewSignedOrderAsync(orderFactory, {});
            const response = await httpGetAsync({
                app,
                route: `${SRA_PATH}/orders?makerAddress=${apiOrder.order.makerAddress.toUpperCase()}`,
            });

            expect(response.type).to.eq(`application/json`);
            expect(response.status).to.eq(HttpStatus.OK);
            expect(response.body).to.deep.eq({
                ...EMPTY_PAGINATED_RESPONSE,
                total: 1,
                records: [JSON.parse(JSON.stringify(apiOrder))],
            });

            await (await getDBConnectionAsync()).manager.remove(orderUtils.serializeOrder(apiOrder));
        });
    });
    describe('GET /order', () => {
        it('should return order by order hash', async () => {
            const apiOrder = await addNewSignedOrderAsync(orderFactory, {});
            const response = await httpGetAsync({ app, route: `${SRA_PATH}/order/${apiOrder.metaData.orderHash}` });

            expect(response.type).to.eq(`application/json`);
            expect(response.status).to.eq(HttpStatus.OK);
            expect(response.body).to.deep.eq(JSON.parse(JSON.stringify(apiOrder)));

            await (await getDBConnectionAsync()).manager.remove(orderUtils.serializeOrder(apiOrder));
        });
        it('should return 404 if order is not found', async () => {
            const apiOrder = await addNewSignedOrderAsync(orderFactory, {});
            await (await getDBConnectionAsync()).manager.remove(orderUtils.serializeOrder(apiOrder));
            const response = await httpGetAsync({ app, route: `${SRA_PATH}/order/${apiOrder.metaData.orderHash}` });
            expect(response.status).to.deep.eq(HttpStatus.NOT_FOUND);
        });
    });

    describe('GET /asset_pairs', () => {
        it('should respond to GET request', async () => {
            const response = await httpGetAsync({ app, route: `${SRA_PATH}/asset_pairs` });

            expect(response.type).to.eq(`application/json`);
            expect(response.status).to.eq(HttpStatus.OK);
            expect(response.body.perPage).to.equal(DEFAULT_PER_PAGE);
            expect(response.body.page).to.equal(DEFAULT_PAGE);
            expect(response.body.total).to.be.an('number');
            expect(response.body.records).to.be.an('array');
        });
    });
    describe('GET /orderbook', () => {
        it('should return orderbook for a given pair', async () => {
            const apiOrder = await addNewSignedOrderAsync(orderFactory, {});
            const response = await httpGetAsync({
                app,
                route: constructRoute({
                    baseRoute: `${SRA_PATH}/orderbook`,
                    queryParams: {
                        baseAssetData: apiOrder.order.makerAssetData,
                        quoteAssetData: apiOrder.order.takerAssetData,
                    },
                }),
            });

            expect(response.type).to.eq(`application/json`);
            expect(response.status).to.eq(HttpStatus.OK);

            const expectedResponse = {
                bids: EMPTY_PAGINATED_RESPONSE,
                asks: {
                    ...EMPTY_PAGINATED_RESPONSE,
                    total: 1,
                    records: [JSON.parse(JSON.stringify(apiOrder))],
                },
            };
            expect(response.body).to.deep.eq(expectedResponse);
        });
        it('should return empty response if no matching orders', async () => {
            const apiOrder = await addNewSignedOrderAsync(orderFactory, {});
            const response = await httpGetAsync({
                app,
                route: constructRoute({
                    baseRoute: `${SRA_PATH}/orderbook`,
                    queryParams: { baseAssetData: apiOrder.order.makerAssetData, quoteAssetData: NULL_ADDRESS },
                }),
            });

            expect(response.type).to.eq(`application/json`);
            expect(response.status).to.eq(HttpStatus.OK);
            expect(response.body).to.deep.eq({
                bids: EMPTY_PAGINATED_RESPONSE,
                asks: EMPTY_PAGINATED_RESPONSE,
            });
        });
        it('should return validation error if query params are missing', async () => {
            const response = await httpGetAsync({ app, route: `${SRA_PATH}/orderbook?quoteAssetData=WETH` });
            const validationErrors = {
                code: 100,
                reason: 'Validation Failed',
                validationErrors: [
                    {
                        field: 'instance.quoteAssetData', // FIXME (xianny): bug in jsonschemas module
                        code: 1001,
                        reason: 'does not match pattern "^0x(([0-9a-f][0-9a-f])+)?$"',
                    },
                    {
                        field: 'baseAssetData',
                        code: 1000,
                        reason: 'requires property "baseAssetData"',
                    },
                ],
            };

            expect(response.type).to.eq(`application/json`);
            expect(response.status).to.eq(HttpStatus.BAD_REQUEST);
            expect(response.body).to.deep.eq(validationErrors);
        });
    });
    describe('POST /order_config', () => {
        it('should return 200 on success', async () => {
            const order = await orderFactory.newSignedOrderAsync();
            const expectedResponse = {
                senderAddress: NULL_ADDRESS,
                feeRecipientAddress: NULL_ADDRESS,
                makerFee: '0',
                takerFee: '0',
                makerFeeAssetData: '0x',
                takerFeeAssetData: '0x',
            };

            const response = await httpPostAsync({
                app,
                route: `${SRA_PATH}/order_config`,
                body: {
                    ...order,
                    expirationTimeSeconds: TOMORROW,
                },
            });

            expect(response.type).to.eq(`application/json`);
            expect(response.status).to.eq(HttpStatus.OK);
            expect(response.body).to.deep.eq(expectedResponse);
        });
        it('should return informative error when missing fields', async () => {
            const order = await orderFactory.newSignedOrderAsync();
            const validationError: ErrorBody = {
                code: GeneralErrorCodes.ValidationError,
                reason: generalErrorCodeToReason[GeneralErrorCodes.ValidationError],
                validationErrors: [
                    {
                        field: 'takerAddress',
                        code: ValidationErrorCodes.RequiredField,
                        reason: 'requires property "takerAddress"',
                    },
                    {
                        field: 'expirationTimeSeconds',
                        code: ValidationErrorCodes.RequiredField,
                        reason: 'requires property "expirationTimeSeconds"',
                    },
                ],
            };
            const response = await httpPostAsync({
                app,
                route: `${SRA_PATH}/order_config`,
                body: {
                    ...order,
                    takerAddress: undefined,
                    expirationTimeSeconds: undefined,
                },
            });
            expect(response.type).to.eq(`application/json`);
            expect(response.status).to.eq(HttpStatus.BAD_REQUEST);
            expect(response.body).to.deep.eq(validationError);
        });
    });
    describe('POST /order', () => {
        beforeEach(async () => {
            _meshClientMock._resetClient();
        });
        it('should return HTTP OK on success', async () => {
            const order = await orderFactory.newSignedOrderAsync({
                expirationTimeSeconds: TOMORROW,
            });
            const orderHash = orderHashUtils.getOrderHash(order);

            const response = await httpPostAsync({
                app,
                route: `${SRA_PATH}/order`,
                body: {
                    ...order,
                },
            });
            expect(response.status).to.eq(HttpStatus.OK);
            const meshOrders = await meshUtils.getOrdersAsync();
            expect(meshOrders.ordersInfos.find(info => info.hash === orderHash)).to.not.be.undefined();
        });
    });
});
