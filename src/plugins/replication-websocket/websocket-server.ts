import type {
    RxReplicationHandler
} from '../../types/index.d.ts';

import type {
    WebSocket,
    ServerOptions
} from 'isomorphic-ws';
import pkg from 'isomorphic-ws';
const { WebSocketServer } = pkg;

import type {
    WebsocketMessageResponseType,
    WebsocketMessageType,
    WebsocketServerOptions,
    WebsocketServerState
} from './websocket-types.ts';
import { rxStorageInstanceToReplicationHandler } from '../../replication-protocol/index.ts';
import {
    PROMISE_RESOLVE_VOID, getFromMapOrCreate
} from '../../plugins/utils/index.ts';
import { Subject } from 'rxjs';

export function startSocketServer(options: ServerOptions): WebsocketServerState {
    const wss = new WebSocketServer(options);
    let closed = false;
    function closeServer() {
        if (closed) {
            return PROMISE_RESOLVE_VOID;
        }
        closed = true;
        onConnection$.complete();
        return new Promise<void>((res, rej) => {
            /**
             * We have to close all client connections,
             * otherwise wss.close() will never call the callback.
             * @link https://github.com/websockets/ws/issues/1288#issuecomment-360594458
             */
            for (const ws of wss.clients) {
                ws.close();
            }
            wss.close((err: any) => {
                if (err) {
                    rej(err);
                } else {
                    res();
                }
            });
        });
    }

    const onConnection$ = new Subject<WebSocket>();
    wss.on('connection', (ws: any, req: any) => onConnection$.next({ws, req} as any));

    return {
        server: wss,
        close: closeServer,
        onConnection$: onConnection$.asObservable()
    };
}

export function startWebsocketServer(options: WebsocketServerOptions): WebsocketServerState {
    const { database, ...wsOptions } = options;
    const serverState = startSocketServer(wsOptions);

    // auto close when the database gets destroyed
    database.onDestroy.push(() => serverState.close());

    const replicationHandlerByCollection: Map<string, RxReplicationHandler<any, any>> = new Map();
    function getReplicationHandler(collectionName: string): RxReplicationHandler<any, any> {
        if (!database.collections[collectionName]) {
            throw new Error('collection ' + collectionName + ' does not exist');
        }

        const handler = getFromMapOrCreate(
            replicationHandlerByCollection,
            collectionName,
            () => {
                const collection = database.collections[collectionName];
                return rxStorageInstanceToReplicationHandler(
                    collection.storageInstance,
                    collection.conflictHandler,
                    database.token
                );
            }
        );
        return handler;
    }

    serverState.onConnection$.subscribe(socket => {
        const {ws, req} = socket;
        const onCloseHandlers: Function[] = [];
        ws.onclose = () => {
            onCloseHandlers.map(fn => fn());
        };
        ws.on('message', async (messageString: string) => {
            const message: WebsocketMessageType = JSON.parse(messageString);
            if(options.collectionRules && !(await options.collectionRules(req, message.collection))){
                // access denial
                return;
            }
            const handler = getReplicationHandler(message.collection);
            const method = handler[message.method];

            /**
             * If it is not a function,
             * it means that the client requested the masterChangeStream$
             */
            if (typeof method !== 'function') {
                const changeStreamSub = handler.masterChangeStream$.subscribe(ev => {
                    const streamResponse: WebsocketMessageResponseType = {
                        id: 'stream',
                        collection: message.collection,
                        result: ev
                    };
                    ws.send(JSON.stringify(streamResponse));
                });
                onCloseHandlers.push(() => changeStreamSub.unsubscribe());
                return;
            }
            const result = await (method as any)(...message.params);
            const response: WebsocketMessageResponseType = {
                id: message.id,
                collection: message.collection,
                result
            };
            ws.send(JSON.stringify(response));
        });
    });


    return serverState;
}
