import { createLokiLocalState, RxStorageInstanceLoki } from './rx-storage-instance-loki.ts';
import lokijs, { Collection } from 'lokijs';
import type {
    DeterministicSortComparator,
    LokiDatabaseSettings,
    LokiDatabaseState,
    LokiLocalDatabaseState,
    LokiRemoteResponseBroadcastMessage,
    MangoQuery,
    MangoQuerySortDirection,
    MangoQuerySortPart,
    RxDocumentData,
    RxJsonSchema
} from '../../types/index.d.ts';
import {
    add as unloadAdd,
    AddReturn
} from 'unload';
import {
    ensureNotFalsy,
    flatClone,
    getFromMapOrCreate,
    getProperty,
    promiseWait,
    randomCouchString
} from '../utils/index.ts';
import { LokiSaveQueue } from './loki-save-queue.ts';
import { newRxError } from '../../rx-error.ts';
import {
    LeaderElector,
    OnMessageHandler
} from 'broadcast-channel';
import { getBroadcastChannelReference } from '../../rx-storage-multiinstance.ts';
import { getLeaderElectorByBroadcastChannel } from '../leader-election/index.ts';
import { overwritable } from '../../overwritable.ts';

export const CHANGES_COLLECTION_SUFFIX = '-rxdb-changes';
export const LOKI_BROADCAST_CHANNEL_MESSAGE_TYPE = 'rxdb-lokijs-remote-request';
export const LOKI_KEY_OBJECT_BROADCAST_CHANNEL_MESSAGE_TYPE = 'rxdb-lokijs-remote-request-key-object';
export const RX_STORAGE_NAME_LOKIJS = 'lokijs';

/**
 * Loki attaches a $loki property to all data
 * which must be removed before returning the data back to RxDB.
 */
export function stripLokiKey<T>(docData: RxDocumentData<T> & { $loki?: number; }): T {
    if (!docData.$loki) {
        return docData;
    }
    const cloned = flatClone(docData);

    /**
     * In RxDB version 12.0.0,
     * we introduced the _meta field that already contains the last write time.
     * To be backwards compatible, we have to move the $lastWriteAt to the _meta field.
     * TODO remove this in the next major version.
     */
    if ((cloned as any).$lastWriteAt) {
        cloned._meta = {
            lwt: (cloned as any).$lastWriteAt
        };
        delete (cloned as any).$lastWriteAt;
    }

    delete cloned.$loki;
    return cloned;
}

/**
 * Used to check in tests if all instances have been cleaned up.
 */
export const OPEN_LOKIJS_STORAGE_INSTANCES: Set<RxStorageInstanceLoki<any>> = new Set();


export const LOKIJS_COLLECTION_DEFAULT_OPTIONS: Partial<CollectionOptions<any>> = {
    disableChangesApi: true,
    disableMeta: true,
    disableDeltaChangesApi: true,
    disableFreeze: true,
    // TODO use 'immutable' like WatermelonDB does it
    cloneMethod: 'shallow-assign',
    clone: false,
    transactional: false,
    autoupdate: false
};

const LOKI_DATABASE_STATE_BY_NAME: Map<string, Promise<LokiDatabaseState>> = new Map();
export function getLokiDatabase(
    databaseName: string,
    databaseSettings: LokiDatabaseSettings
): Promise<LokiDatabaseState> {


    return getFromMapOrCreate(
        LOKI_DATABASE_STATE_BY_NAME,
        databaseName,
        () => {
            /**
             * We assume that as soon as an adapter is passed,
             * the database has to be persistent.
             */
            const hasPersistence: boolean = !!databaseSettings.adapter;
            const databaseState = (async () => {
                let persistenceMethod = hasPersistence ? 'adapter' : 'memory';
                if (databaseSettings.persistenceMethod) {
                    persistenceMethod = databaseSettings.persistenceMethod;
                }
                const useSettings = Object.assign(
                    // defaults
                    {
                        autoload: hasPersistence,
                        persistenceMethod,
                        verbose: true
                    },
                    databaseSettings,
                    // overwrites
                    {
                        /**
                         * RxDB uses its custom load and save handling
                         * so we disable the LokiJS save/load handlers.
                         */
                        autoload: false,
                        autosave: false,
                        throttledSaves: false
                    }
                );
                const database = new lokijs(
                    databaseName + '.db',
                    flatClone(useSettings)
                );
                const lokiSaveQueue = new LokiSaveQueue(
                    database,
                    useSettings
                );

                /**
                 * Wait until all data is loaded from persistence adapter.
                 * Wrap the loading into the saveQueue to ensure that when many
                 * collections are created at the same time, the load-calls do not interfere
                 * with each other and cause error logs.
                 */
                if (hasPersistence) {
                    const loadDatabasePromise = new Promise<void>((res, rej) => {
                        try {
                            database.loadDatabase({
                                recursiveWait: false
                            }, (err) => {
                                if (useSettings.autoloadCallback) {
                                    useSettings.autoloadCallback(err);
                                }
                                if (err) {
                                    rej(err);
                                } else {
                                    res();
                                }
                            });
                        } catch (err) {
                            rej(err);
                        }
                    });
                    lokiSaveQueue.saveQueue = lokiSaveQueue.saveQueue.then(() => loadDatabasePromise);
                    await loadDatabasePromise;
                }

                /**
                 * Autosave database on process end
                 */
                const unloads: AddReturn[] = [];
                if (hasPersistence) {
                    unloads.push(
                        unloadAdd(() => lokiSaveQueue.run())
                    );
                }

                const state: LokiDatabaseState = {
                    database,
                    databaseSettings: useSettings,
                    saveQueue: lokiSaveQueue,
                    collections: {},
                    unloads
                };

                return state;
            })();
            return databaseState;
        }
    );
}

export async function closeLokiCollections(
    databaseName: string,
    collections: Collection[]
) {
    const databaseState = await LOKI_DATABASE_STATE_BY_NAME.get(databaseName);
    if (!databaseState) {
        // already closed
        return;
    }
    await databaseState.saveQueue.run();
    collections.forEach(collection => {
        const collectionName = collection.name;
        delete databaseState.collections[collectionName];
    });
    if (Object.keys(databaseState.collections).length === 0) {
        // all collections closed -> also close database
        LOKI_DATABASE_STATE_BY_NAME.delete(databaseName);
        databaseState.unloads.forEach(u => u.remove());
        await new Promise<void>((res, rej) => {
            databaseState.database.close(err => {
                if (err) {
                    rej(err);
                } else {
                    res();
                }
            });
        });
    }
}

/**
 * This function is at lokijs-helper
 * because we need it in multiple places.
 */
export function getLokiSortComparator<RxDocType>(
    _schema: RxJsonSchema<RxDocumentData<RxDocType>>,
    query: MangoQuery<RxDocType>
): DeterministicSortComparator<RxDocType> {
    if (!query.sort) {
        throw newRxError('SNH', { query });
    }
    const sortOptions: MangoQuerySortPart<RxDocType>[] = query.sort;

    const fun: DeterministicSortComparator<RxDocType> = (a: RxDocType, b: RxDocType) => {
        let compareResult: number = 0; // 1 | -1
        sortOptions.find(sortPart => {
            const fieldName: string = Object.keys(sortPart)[0];
            const direction: MangoQuerySortDirection = Object.values(sortPart)[0];
            const directionMultiplier = direction === 'asc' ? 1 : -1;
            const valueA: any = getProperty(a as any, fieldName);
            const valueB: any = getProperty(b as any, fieldName);
            if (valueA === valueB) {
                return false;
            } else {
                if (valueA > valueB) {
                    compareResult = 1 * directionMultiplier;
                    return true;
                } else {
                    compareResult = -1 * directionMultiplier;
                    return true;
                }
            }
        });

        /**
         * Two different objects should never have the same sort position.
         * We ensure this by having the unique primaryKey in the sort params
         * which is added by RxDB if not existing yet.
         */
        if (!compareResult) {
            throw newRxError('SNH', { args: { query, a, b } });
        }

        return compareResult as any;
    };
    return fun;
}

export function getLokiLeaderElector(
    databaseInstanceToken: string,
    broadcastChannelRefObject: any,
    databaseName: string
): LeaderElector {
    const broadcastChannel = getBroadcastChannelReference(
        RX_STORAGE_NAME_LOKIJS,
        databaseInstanceToken,
        databaseName,
        broadcastChannelRefObject
    );
    const elector = getLeaderElectorByBroadcastChannel(broadcastChannel);
    return elector;
}

/**
 * For multi-instance usage, we send requests to the RxStorage
 * to the current leading instance over the BroadcastChannel.
 */
export async function requestRemoteInstance(
    instance: RxStorageInstanceLoki<any>,
    operation: string,
    params: any[]
): Promise<any | any[]> {
    const isRxStorageInstanceLoki = typeof (instance as any).query === 'function';
    const messageType = isRxStorageInstanceLoki ? LOKI_BROADCAST_CHANNEL_MESSAGE_TYPE : LOKI_KEY_OBJECT_BROADCAST_CHANNEL_MESSAGE_TYPE;

    const leaderElector = ensureNotFalsy(instance.internals.leaderElector);
    await waitUntilHasLeader(leaderElector);
    const broadcastChannel = leaderElector.broadcastChannel;

    type WinningPromise = {
        retry: boolean;
        result?: any;
        error?: any;
    };

    let whenDeathListener: OnMessageHandler<any>;
    const leaderDeadPromise = new Promise<WinningPromise>(res => {
        whenDeathListener = (msg: any) => {
            if (msg.context === 'leader' && msg.action === 'death') {
                res({
                    retry: true
                });
            }
        };
        broadcastChannel.addEventListener('internal', whenDeathListener);
    });
    const requestId = randomCouchString(12);
    let responseListener: OnMessageHandler<any>;
    const responsePromise = new Promise<WinningPromise>((res, _rej) => {
        responseListener = (msg: any) => {
            if (
                msg.type === messageType &&
                msg.response === true &&
                msg.requestId === requestId
            ) {
                if (msg.isError) {
                    res({
                        retry: false,
                        error: msg.result
                    });
                } else {
                    res({
                        retry: false,
                        result: msg.result
                    });
                }
            }
        };
        broadcastChannel.addEventListener('message', responseListener);
    });

    // send out the request to the other instance
    broadcastChannel.postMessage({
        response: false,
        type: messageType,
        operation,
        params,
        requestId,
        databaseName: instance.databaseName,
        collectionName: instance.collectionName
    });
    let timeout: ReturnType<typeof setTimeout>;
    return Promise.race([
        leaderDeadPromise,
        responsePromise,
        // // comment in timeout to debug
        // new Promise<WinningPromise>(res => {
        //     timeout = setTimeout(() => {
        //         res({ error: new Error('requestRemoteInstance() timeout errorored'), retry: false });
        //     }, 500);
        // })

    ]).then(firstResolved => {
        if (timeout) {
            clearTimeout(timeout);
        }

        // clean up listeners
        broadcastChannel.removeEventListener('message', responseListener);
        broadcastChannel.removeEventListener('internal', whenDeathListener);

        if (firstResolved.retry) {
            /**
             * The leader died while a remote request was running
             * we re-run the whole operation.
             * We cannot just re-run requestRemoteInstance()
             * because the current instance might be the new leader now
             * and then we have to use the local state instead of requesting the remote.
             */
            return (instance as any)[operation](...params);
        } else {
            if (firstResolved.error) {
                throw firstResolved.error;
            } else {
                return firstResolved.result;
            }
        }
    });
}

/**
 * Handles a request that came from a remote instance via requestRemoteInstance()
 * Runs the requested operation over the local db instance and sends back the result.
 */
export async function handleRemoteRequest(
    instance: RxStorageInstanceLoki<any>,
    msg: any
) {
    if (
        msg.type === LOKI_BROADCAST_CHANNEL_MESSAGE_TYPE &&
        msg.requestId &&
        msg.databaseName === instance.databaseName &&
        msg.collectionName === instance.collectionName &&
        !msg.response
    ) {
        const operation = (msg as any).operation;
        const params = (msg as any).params;
        let result: any;
        let isError = false;
        try {
            result = await (instance as any)[operation](...params);
        } catch (err) {
            console.dir(err);
            isError = true;
            result = err;
        }
        const response: LokiRemoteResponseBroadcastMessage = {
            response: true,
            requestId: msg.requestId,
            databaseName: instance.databaseName,
            collectionName: instance.collectionName,
            result,
            isError,
            type: msg.type
        };
        ensureNotFalsy(instance.internals.leaderElector).broadcastChannel.postMessage(response);
    }
}

export async function waitUntilHasLeader(leaderElector: LeaderElector) {
    leaderElector.awaitLeadership().catch(() => { });
    await promiseWait(0);
    while (true) {
        const has = await leaderElector.hasLeader();
        if (
            has ||
            leaderElector.broadcastChannel.isClosed ||
            leaderElector.isDead
        ) {
            return;
        }

        if (leaderElector.applyOnce) {
            await leaderElector.applyOnce();
        } else {
            /**
             * Trigger applying for leadership
             * but do not await it in case another
             * instance becomes leader first.
             */
            leaderElector.awaitLeadership().catch(() => { });
        }
        await promiseWait(20);
    }
}

/**
 * If the local state must be used, that one is returned.
 * Returns false if a remote instance must be used.
 */
export async function mustUseLocalState(
    instance: RxStorageInstanceLoki<any>
): Promise<LokiLocalDatabaseState | false> {
    if (instance.closed) {
        /**
         * If this happens, it means that RxDB made a call to an already closed storage instance.
         * This must never happen because when RxDB closes a collection or database,
         * all tasks must be cleared so that no more calls are made the the storage.
         */
        throw new Error('already closed ' + JSON.stringify(
            {
                instanceClosed: instance.closed,
                databaseName: instance.databaseName,
                collectionName: instance.collectionName
            }
        ));
    }


    if (instance.internals.localState) {
        return instance.internals.localState;
    }
    const leaderElector = ensureNotFalsy(instance.internals.leaderElector);
    await waitUntilHasLeader(leaderElector);

    /**
     * It might already have a localState after the applying
     * because another subtask also called mustUSeLocalState()
     */
    if (instance.internals.localState) {
        return instance.internals.localState;
    }

    if (
        leaderElector.isLeader &&
        !instance.internals.localState
    ) {
        // own is leader, use local instance
        instance.internals.localState = createLokiLocalState<any>({
            databaseInstanceToken: instance.databaseInstanceToken,
            databaseName: instance.databaseName,
            collectionName: instance.collectionName,
            options: instance.options,
            schema: (instance as RxStorageInstanceLoki<any>).schema,
            multiInstance: instance.internals.leaderElector ? true : false,
            devMode: overwritable.isDevMode()
        }, instance.databaseSettings);
        return ensureNotFalsy(instance.internals.localState);
    } else {
        // other is leader, send message to remote leading instance
        return false;
    }
}


/**
 * LokiJS does not understand the 'official' $regex operator,
 * so we have to transform these back into RegExp objects.
 * @recursive
 */
export function transformRegexToRegExp(selector: any) {
    if (typeof selector !== 'object' || selector === null) {
        return selector;
    }

    const keys = Object.keys(selector);
    const ret: any = {};
    keys.forEach(key => {
        const value: any = selector[key];
        if (key === '$options') {
            return;
        }
        if (
            key === '$regex' &&
            !(value instanceof RegExp)
        ) {
            const opts = selector['$options'];
            ret[key] = new RegExp(value, opts);
        } else if (Array.isArray(value)) {
            ret[key] = value.map(item => transformRegexToRegExp(item));
        } else {
            ret[key] = transformRegexToRegExp(value);
        }
    });
    return ret;
}
