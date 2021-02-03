import { DocumentNode } from 'graphql';
import { wrap } from 'optimism';

import {
  StoreObject,
  Reference,
  getFragmentQueryDocument,
} from '../../utilities';
import { DataProxy } from './types/DataProxy';
import { Cache } from './types/Cache';

export type Transaction<T> = (c: ApolloCache<T>) => void;

export type BatchOptions<C extends ApolloCache<any>> = {
  // Same as the first parameter of performTransaction, except the cache
  // argument will have the subclass type rather than ApolloCache.
  transaction(cache: C): void;

  // Passing a string for this option creates a new optimistic layer with
  // that string as its layer.id, just like passing a string for the
  // optimisticId parameter of performTransaction. Passing true is the
  // same as passing undefined to performTransaction, and passing false is
  // the same as passing null.
  optimistic: string | boolean;

  // If you want to find out which watched queries were invalidated during
  // this batch operation, pass this optional callback function. Returning
  // false from the callback will prevent broadcasting this result.
  onDirty?: (
    this: C,
    watch: Cache.WatchOptions,
    diff: Cache.DiffResult<any>,
  ) => void | false;
};

export abstract class ApolloCache<TSerialized> implements DataProxy {
  // required to implement
  // core API
  public abstract read<T, TVariables = any>(
    query: Cache.ReadOptions<TVariables, T>,
  ): T | null;
  public abstract write<TResult = any, TVariables = any>(
    write: Cache.WriteOptions<TResult, TVariables>,
  ): Reference | undefined;
  public abstract diff<T>(query: Cache.DiffOptions): Cache.DiffResult<T>;
  public abstract watch(watch: Cache.WatchOptions): () => void;
  public abstract reset(): Promise<void>;

  // Remove whole objects from the cache by passing just options.id, or
  // specific fields by passing options.field and/or options.args. If no
  // options.args are provided, all fields matching options.field (even
  // those with arguments) will be removed. Returns true iff any data was
  // removed from the cache.
  public abstract evict(options: Cache.EvictOptions): boolean;

  // intializer / offline / ssr API
  /**
   * Replaces existing state in the cache (if any) with the values expressed by
   * `serializedState`.
   *
   * Called when hydrating a cache (server side rendering, or offline storage),
   * and also (potentially) during hot reloads.
   */
  public abstract restore(
    serializedState: TSerialized,
  ): ApolloCache<TSerialized>;

  /**
   * Exposes the cache's complete state, in a serializable format for later restoration.
   */
  public abstract extract(optimistic?: boolean): TSerialized;

  // Optimistic API

  public abstract removeOptimistic(id: string): void;

  // Transactional API

  // The batch method is intended to replace/subsume both performTransaction
  // and recordOptimisticTransaction, but performTransaction came first, so we
  // provide a default batch implementation that's just another way of calling
  // performTransaction. Subclasses of ApolloCache (such as InMemoryCache) can
  // override the batch method to do more interesting things with its options.
  public batch(options: BatchOptions<this>) {
    const optimisticId =
      typeof options.optimistic === "string" ? options.optimistic :
      options.optimistic === false ? null : void 0;
    this.performTransaction(options.transaction, optimisticId);
  }

  public abstract performTransaction(
    transaction: Transaction<TSerialized>,
    // Although subclasses may implement recordOptimisticTransaction
    // however they choose, the default implementation simply calls
    // performTransaction with a string as the second argument, allowing
    // performTransaction to handle both optimistic and non-optimistic
    // (broadcast-batching) transactions. Passing null for optimisticId is
    // also allowed, and indicates that performTransaction should apply
    // the transaction non-optimistically (ignoring optimistic data).
    optimisticId?: string | null,
  ): void;

  public recordOptimisticTransaction(
    transaction: Transaction<TSerialized>,
    optimisticId: string,
  ) {
    this.performTransaction(transaction, optimisticId);
  }

  // Optional API

  public transformDocument(document: DocumentNode): DocumentNode {
    return document;
  }

  public identify(object: StoreObject | Reference): string | undefined {
    return;
  }

  public gc(): string[] {
    return [];
  }

  public modify(options: Cache.ModifyOptions): boolean {
    return false;
  }

  // Experimental API

  public transformForLink(document: DocumentNode): DocumentNode {
    return document;
  }

  // DataProxy API
  /**
   *
   * @param options
   * @param optimistic
   */
  public readQuery<QueryType, TVariables = any>(
    options: Cache.ReadQueryOptions<QueryType, TVariables>,
    optimistic = !!options.optimistic,
  ): QueryType | null {
    return this.read({
      rootId: options.id || 'ROOT_QUERY',
      query: options.query,
      variables: options.variables,
      returnPartialData: options.returnPartialData,
      optimistic,
    });
  }

  // Make sure we compute the same (===) fragment query document every
  // time we receive the same fragment in readFragment.
  private getFragmentDoc = wrap(getFragmentQueryDocument);

  public readFragment<FragmentType, TVariables = any>(
    options: Cache.ReadFragmentOptions<FragmentType, TVariables>,
    optimistic = !!options.optimistic,
  ): FragmentType | null {
    return this.read({
      query: this.getFragmentDoc(options.fragment, options.fragmentName),
      variables: options.variables,
      rootId: options.id,
      returnPartialData: options.returnPartialData,
      optimistic,
    });
  }

  public writeQuery<TData = any, TVariables = any>({
    id,
    data,
    ...options
  }: Cache.WriteQueryOptions<TData, TVariables>): Reference | undefined {
    return this.write(Object.assign(options, {
      dataId: id || 'ROOT_QUERY',
      result: data,
    }));
  }

  public writeFragment<TData = any, TVariables = any>({
    id,
    data,
    fragment,
    fragmentName,
    ...options
  }: Cache.WriteFragmentOptions<TData, TVariables>): Reference | undefined {
    return this.write(Object.assign(options, {
      query: this.getFragmentDoc(fragment, fragmentName),
      dataId: id,
      result: data,
    }));
  }
}
