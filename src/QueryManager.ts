/// <reference path="../typings/main.d.ts" />

import {
  NetworkInterface,
  Request,
} from './networkInterface';

import {
  parseQueryIfString,
} from './parser';

import {
  assign,
} from 'lodash';

import {
  createQueryResultAction,
  Store,
} from './store';

import {
  Store as ReduxStore,
} from 'redux';

import {
  SelectionSet,
  GraphQLError,
} from 'graphql';

import {
  forOwn,
} from 'lodash';

import {
  readSelectionSetFromStore,
} from './readFromStore';

export class QueryManager {
  private networkInterface: NetworkInterface;
  private store: ReduxStore;
  private selectionSetMap: { [queryId: number]: SelectionSetWithRoot };

  private dataCallbacks: { [queryId: number]: QueryResultCallback[]};
  private errorCallbacks: { [queryId: number]: QueryErrorCallback[]};

  private idCounter = 0;

  constructor({
    networkInterface,
    store,
  }: {
    networkInterface: NetworkInterface,
    store: ReduxStore,
  }) {
    // XXX this might be the place to do introspection for inserting the `id` into the query? or
    // is that the network interface?
    this.networkInterface = networkInterface;
    this.store = store;

    this.selectionSetMap = {};
    this.dataCallbacks = {};
    this.errorCallbacks = {};

    this.store.subscribe((data) => {
      this.broadcastNewStore(data);
    });
  }

  public watchQuery({
     query,
  }: {
    query: string,
  }): WatchedQueryHandle {
    const queryDef = parseQueryIfString(query);

    const watchHandle = this.watchSelectionSet({
      selectionSet: queryDef.selectionSet,
      rootId: 'ROOT_QUERY',
      typeName: 'Query',
    });

    const request = {
      query: query,
    } as Request;

    this.networkInterface.query([
      request,
    ]).then((result) => {
      const resultWithDataId = assign({
        __data_id: 'ROOT_QUERY',
      }, result[0].data);

      this.store.dispatch(createQueryResultAction({
        result: resultWithDataId,
        selectionSet: queryDef.selectionSet,
      }));
    }).catch((errors: GraphQLError[]) => {
      this.broadcastErrors(watchHandle.id, errors);
      // XXX maybe stop query and clean up callbacks!
    });

    return watchHandle;
  }

  public broadcastNewStore(store: Store) {
    forOwn(this.selectionSetMap, (selectionSetWithRoot: SelectionSetWithRoot, queryId: string) => {
      const resultFromStore = readSelectionSetFromStore({
        store,
        rootId: selectionSetWithRoot.rootId,
        selectionSet: selectionSetWithRoot.selectionSet,
      });

      this.broadcastQueryChange(queryId, resultFromStore);
    });
  }

  public watchSelectionSet(selectionSetWithRoot: SelectionSetWithRoot): WatchedQueryHandle {
    const queryId = this.idCounter.toString();
    this.idCounter++;

    this.selectionSetMap[queryId] = selectionSetWithRoot;

    return {
      id: queryId,
      stop: () => {
        throw new Error('Not implemented');
      },
      onData: (callback) => {
        this.registerDataCallback(queryId, callback);
      },
      onError: (callback) => {
        this.registerErrorCallback(queryId, callback);
      },
    };
  }

  private broadcastQueryChange(queryId: string, result: any) {
    this.dataCallbacks[queryId].forEach((callback) => {
      callback(result);
    });
  }

  private broadcastErrors(queryId: string, errors: GraphQLError[]) {
    this.errorCallbacks[queryId].forEach((callback) => {
      callback(errors);
    });
  }

  private registerDataCallback(queryId: string, callback: QueryResultCallback): void {
    if (! this.dataCallbacks[queryId]) {
      this.dataCallbacks[queryId] = [];
    }

    this.dataCallbacks[queryId].push(callback);
  }

  private registerErrorCallback(queryId: string, callback: QueryErrorCallback): void {
    if (! this.errorCallbacks[queryId]) {
      this.errorCallbacks[queryId] = [];
    }

    this.errorCallbacks[queryId].push(callback);
  }
}

export interface SelectionSetWithRoot {
  rootId: string;
  typeName: string;
  selectionSet: SelectionSet;
}

export interface WatchedQueryHandle {
  id: string;
  stop();
  onData(callback: QueryResultCallback);
  onError(callback: QueryErrorCallback);
}

export type QueryResultCallback = (result: any) => void;
export type QueryErrorCallback = (errors: GraphQLError[]) => void;

