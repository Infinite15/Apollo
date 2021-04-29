import { dep, OptimisticDependencyFunction } from 'optimism';
import invariant from 'ts-invariant';
import { equal } from '@wry/equality';
import { Trie } from '@wry/trie';

import {
  isReference,
  StoreValue,
  StoreObject,
  Reference,
  makeReference,
  DeepMerger,
  maybeDeepFreeze,
  canUseWeakMap,
} from '../../utilities';
import { NormalizedCache, NormalizedCacheObject, ReadMergeModifyContext } from './types';
import { hasOwn, fieldNameFromStoreName, storeValueIsStoreObject } from './helpers';
import { Policies, StorageType } from './policies';
import { Cache } from '../core/types/Cache';
import {
  SafeReadonly,
  Modifier,
  Modifiers,
  ReadFieldOptions,
  ToReferenceFunction,
  CanReadFunction,
} from '../core/types/common';

const DELETE: any = Object.create(null);
const delModifier: Modifier<any> = () => DELETE;
const INVALIDATE: any = Object.create(null);

export abstract class EntityStore implements NormalizedCache {
  protected data: NormalizedCacheObject = Object.create(null);

  constructor(
    public readonly policies: Policies,
    public readonly group: CacheGroup,
  ) {}

  public abstract addLayer(
    layerId: string,
    replay: (layer: EntityStore) => any,
  ): Layer;

  public abstract removeLayer(layerId: string): EntityStore;

  // Although the EntityStore class is abstract, it contains concrete
  // implementations of the various NormalizedCache interface methods that
  // are inherited by the Root and Layer subclasses.

  public toObject(): NormalizedCacheObject {
    return { ...this.data };
  }

  public has(dataId: string): boolean {
    return this.lookup(dataId, true) !== void 0;
  }

  public get(dataId: string, fieldName: string): StoreValue {
    this.group.depend(dataId, fieldName);
    if (hasOwn.call(this.data, dataId)) {
      const storeObject = this.data[dataId];
      if (storeObject && hasOwn.call(storeObject, fieldName)) {
        return storeObject[fieldName];
      }
    }
    if (fieldName === "__typename" &&
        hasOwn.call(this.policies.rootTypenamesById, dataId)) {
      return this.policies.rootTypenamesById[dataId];
    }
    if (this instanceof Layer) {
      return this.parent.get(dataId, fieldName);
    }
  }

  protected lookup(dataId: string, dependOnExistence?: boolean): StoreObject | undefined {
    // The has method (above) calls lookup with dependOnExistence = true, so
    // that it can later be invalidated when we add or remove a StoreObject for
    // this dataId. Any consumer who cares about the contents of the StoreObject
    // should not rely on this dependency, since the contents could change
    // without the object being added or removed.
    if (dependOnExistence) this.group.depend(dataId, "__exists");

    if (hasOwn.call(this.data, dataId)) {
      return this.data[dataId];
    }

    if (this instanceof Layer) {
      return this.parent.lookup(dataId, dependOnExistence);
    }

    if (this.policies.rootTypenamesById[dataId]) {
      return Object.create(null);
    }
  }

  public merge(
    older: string | StoreObject,
    newer: StoreObject | string,
  ): void {
    let dataId: string;

    const existing: StoreObject | undefined =
      typeof older === "string"
        ? this.lookup(dataId = older)
        : older;

    const incoming: StoreObject | undefined =
      typeof newer === "string"
        ? this.lookup(dataId = newer)
        : newer;

    // If newer was a string ID, but that ID was not defined in this store,
    // then there are no fields to be merged, so we're done.
    if (!incoming) return;

    invariant(
      // @ts-ignore
      typeof dataId === "string",
      "store.merge expects a string ID",
    );

    const merged: StoreObject =
      new DeepMerger(storeObjectReconciler).merge(existing, incoming);

    if (merged !== existing) {
      delete this.refs[dataId];
      if (this.group.caching) {
        const fieldsToDirty: Record<string, 1> = Object.create(null);

        // If we added a new StoreObject where there was previously none, dirty
        // anything that depended on the existence of this dataId, such as the
        // EntityStore#has method.
        if (!existing) fieldsToDirty.__exists = 1;

        // Now invalidate dependents who called getFieldValue for any fields
        // that are changing as a result of this merge.
        Object.keys(incoming).forEach(storeFieldName => {
          if (!existing || existing[storeFieldName] !== merged[storeFieldName]) {
            // Always dirty the full storeFieldName, which may include
            // serialized arguments following the fieldName prefix.
            fieldsToDirty[storeFieldName] = 1;

            // Also dirty fieldNameFromStoreName(storeFieldName) if it's
            // different from storeFieldName and this field does not have
            // keyArgs configured, because that means the cache can't make
            // any assumptions about how field values with the same field
            // name but different arguments might be interrelated, so it
            // must err on the side of invalidating all field values that
            // share the same short fieldName, regardless of arguments.
            const fieldName = fieldNameFromStoreName(storeFieldName);
            if (fieldName !== storeFieldName &&
                !this.policies.hasKeyArgs(merged.__typename, fieldName)) {
              fieldsToDirty[fieldName] = 1;
            }
          }
        });

        if (fieldsToDirty.__typename &&
            !(existing && existing.__typename) &&
            // Since we return default root __typename strings
            // automatically from store.get, we don't need to dirty the
            // ROOT_QUERY.__typename field if merged.__typename is equal
            // to the default string (usually "Query").
            this.policies.rootTypenamesById[dataId] === merged.__typename) {
          delete fieldsToDirty.__typename;
        }

        Object.keys(fieldsToDirty).forEach(
          fieldName => this.group.dirty(dataId, fieldName));
      }

      // Make sure we have a (string | number)[] path for every object in the
      // merged object tree, including non-normalized non-Reference objects that
      // are embedded/nested within normalized parent objects. The path of such
      // objects will be an array starting with the string ID of the closest
      // enclosing entity object, followed by the string and number properties
      // that lead from the entity to the nested object within it.
      this.group.assignPaths(dataId, merged);

      if (existing) {
        // Collect objects and field names removed by this merge, so we can run
        // drop functions configured for the fields that are about to removed
        // (before we finally set this.data[dataId] = merged, below).
        const drops: [StoreObject, string][] = [];

        const walk = (exVal: StoreValue, inVal: StoreValue | undefined) => {
          if (exVal === inVal) return;

          if (Array.isArray(exVal)) {
            (exVal as StoreValue[]).forEach((exChild, i) => {
              const inChild = inVal && Array.isArray(inVal) ? inVal[i] : void 0;
              walk(exChild, inChild);
            });

          } else if (storeValueIsStoreObject(exVal)) {
            Object.keys(exVal).forEach(storeFieldName => {
              const exChild = exVal[storeFieldName];
              const inChild = inVal && storeValueIsStoreObject(inVal)
                ? inVal[storeFieldName]
                : void 0;

              // Visit children before running dropField for eChild.
              walk(exChild, inChild);

              if (inChild === void 0) {
                drops.push([exVal, storeFieldName]);
              }
            });
          }
        };

        const isLayer = this instanceof Layer;

        // To detect field removals (in order to run drop functions), we can
        // restrict our attention to the incoming fields, since those are the
        // top-level fields that might have changed.
        Object.keys(incoming).forEach(storeFieldName => {
          const eChild = existing[storeFieldName];
          const iChild = incoming[storeFieldName];

          walk(eChild, iChild);

          if (iChild === void 0) {
            drops.push([existing, storeFieldName]);

            // If merged[storeFieldName] has become undefined, and this is the
            // Root layer, actually delete the property from the merged object,
            // which is guaranteed to have been created fresh in store.merge.
            if (hasOwn.call(merged, storeFieldName) &&
                merged[storeFieldName] === void 0 &&
                !isLayer) {
              delete merged[storeFieldName];
            }
          }
        });

        if (drops.length) {
          const context: ReadMergeModifyContext = { store: this };

          drops.forEach(([storeObject, storeFieldName]) => {
            this.policies.dropField(
              storeObject.__typename,
              storeObject,
              storeFieldName,
              context,
            );
          });
        }
      }
    }

    // Even if merged === existing, existing may have come from a lower
    // layer, so we always need to set this.data[dataId] on this level.
    this.data[dataId] = merged;
  }

  public modify(
    dataId: string,
    fields: Modifier<any> | Modifiers,
  ): boolean {
    const storeObject = this.lookup(dataId);

    if (storeObject) {
      const changedFields: Record<string, any> = Object.create(null);
      let needToMerge = false;
      let allDeleted = true;

      const sharedDetails = {
        DELETE,
        INVALIDATE,
        isReference,
        toReference: this.toReference,
        canRead: this.canRead,
        readField: <V = StoreValue>(
          fieldNameOrOptions: string | ReadFieldOptions,
          from?: StoreObject | Reference,
        ) => this.policies.readField<V>(
          typeof fieldNameOrOptions === "string" ? {
            fieldName: fieldNameOrOptions,
            from: from || makeReference(dataId),
          } : fieldNameOrOptions,
          { store: this },
        ),
      };

      Object.keys(storeObject).forEach(storeFieldName => {
        const fieldName = fieldNameFromStoreName(storeFieldName);
        let fieldValue = storeObject[storeFieldName];
        if (fieldValue === void 0) return;
        const modify: Modifier<StoreValue> = typeof fields === "function"
          ? fields
          : fields[storeFieldName] || fields[fieldName];
        if (modify) {
          let newValue = modify === delModifier ? DELETE :
            modify(maybeDeepFreeze(fieldValue), {
              ...sharedDetails,
              fieldName,
              storeFieldName,
              storage: this.group.getStorage(
                makeReference(dataId),
                storeFieldName,
              ),
            });
          if (newValue === INVALIDATE) {
            this.group.dirty(dataId, storeFieldName);
          } else {
            if (newValue === DELETE) newValue = void 0;
            if (newValue !== fieldValue) {
              changedFields[storeFieldName] = newValue;
              needToMerge = true;
              fieldValue = newValue;
            }
          }
        }
        if (fieldValue !== void 0) {
          allDeleted = false;
        }
      });

      if (needToMerge) {
        this.merge(dataId, changedFields);

        if (allDeleted) {
          if (this instanceof Layer) {
            this.data[dataId] = void 0;
          } else {
            delete this.data[dataId];
          }
          this.group.dirty(dataId, "__exists");
        }

        return true;
      }
    }

    return false;
  }

  // If called with only one argument, removes the entire entity
  // identified by dataId. If called with a fieldName as well, removes all
  // fields of that entity whose names match fieldName according to the
  // fieldNameFromStoreName helper function. If called with a fieldName
  // and variables, removes all fields of that entity whose names match fieldName
  // and whose arguments when cached exactly match the variables passed.
  public delete(
    dataId: string,
    fieldName?: string,
    args?: Record<string, any>,
  ) {
    const storeObject = this.lookup(dataId);
    if (storeObject) {
      const typename = this.getFieldValue<string>(storeObject, "__typename");
      const storeFieldName = fieldName && args
        ? this.policies.getStoreFieldName({ typename, fieldName, args })
        : fieldName;
      return this.modify(dataId, storeFieldName ? {
        [storeFieldName]: delModifier,
      } : delModifier);
    }
    return false;
  }

  public evict(options: Cache.EvictOptions): boolean {
    let evicted = false;
    if (options.id) {
      if (hasOwn.call(this.data, options.id)) {
        evicted = this.delete(options.id, options.fieldName, options.args);
      }
      if (this instanceof Layer) {
        evicted = this.parent.evict(options) || evicted;
      }
      // Always invalidate the field to trigger rereading of watched
      // queries, even if no cache data was modified by the eviction,
      // because queries may depend on computed fields with custom read
      // functions, whose values are not stored in the EntityStore.
      if (options.fieldName || evicted) {
        this.group.dirty(options.id, options.fieldName || "__exists");
      }
    }
    return evicted;
  }

  public clear(): void {
    this.replace(null);
  }

  public extract(): NormalizedCacheObject {
    const obj = this.toObject();
    const extraRootIds: string[] = [];
    this.getRootIdSet().forEach(id => {
      if (!hasOwn.call(this.policies.rootTypenamesById, id)) {
        extraRootIds.push(id);
      }
    });
    if (extraRootIds.length) {
      obj.__META = { extraRootIds: extraRootIds.sort() };
    }
    return obj;
  }

  public replace(newData: NormalizedCacheObject | null): void {
    Object.keys(this.data).forEach(dataId => {
      if (!(newData && hasOwn.call(newData, dataId))) {
        this.delete(dataId);
      }
    });
    if (newData) {
      const { __META, ...rest } = newData;
      Object.keys(rest).forEach(dataId => {
        this.merge(dataId, rest[dataId] as StoreObject);
      });
      if (__META) {
        __META.extraRootIds.forEach(this.retain, this);
      }
    }
  }

  // Remove every Layer, leaving behind only the Root and the Stump.
  public prune(): EntityStore {
    if (this instanceof Layer) {
      const parent = this.removeLayer(this.id);
      if (parent !== this) {
        return parent.prune();
      }
    }
    return this;
  }

  // Maps root entity IDs to the number of times they have been retained, minus
  // the number of times they have been released. Retained entities keep other
  // entities they reference (even indirectly) from being garbage collected.
  private rootIds: {
    [rootId: string]: number;
  } = Object.create(null);

  public retain(rootId: string): number {
    return this.rootIds[rootId] = (this.rootIds[rootId] || 0) + 1;
  }

  public release(rootId: string): number {
    if (this.rootIds[rootId] > 0) {
      const count = --this.rootIds[rootId];
      if (!count) delete this.rootIds[rootId];
      return count;
    }
    return 0;
  }

  // Return a Set<string> of all the ID strings that have been retained by
  // this layer/root *and* any layers/roots beneath it.
  public getRootIdSet(ids = new Set<string>()) {
    Object.keys(this.rootIds).forEach(ids.add, ids);
    if (this instanceof Layer) {
      this.parent.getRootIdSet(ids);
    } else {
      // Official singleton IDs like ROOT_QUERY and ROOT_MUTATION are
      // always considered roots for garbage collection, regardless of
      // their retainment counts in this.rootIds.
      Object.keys(this.policies.rootTypenamesById).forEach(ids.add, ids);
    }
    return ids;
  }

  // The goal of garbage collection is to remove IDs from the Root layer of the
  // store that are no longer reachable starting from any IDs that have been
  // explicitly retained (see retain and release, above). Returns an array of
  // dataId strings that were removed from the store.
  public gc() {
    const ids = this.getRootIdSet();
    const snapshot = this.toObject();
    ids.forEach(id => {
      if (hasOwn.call(snapshot, id)) {
        // Because we are iterating over an ECMAScript Set, the IDs we add here
        // will be visited in later iterations of the forEach loop only if they
        // were not previously contained by the Set.
        Object.keys(this.findChildRefIds(id)).forEach(ids.add, ids);
        // By removing IDs from the snapshot object here, we protect them from
        // getting removed from the root store layer below.
        delete snapshot[id];
      }
    });
    const idsToRemove = Object.keys(snapshot);
    if (idsToRemove.length) {
      let root: EntityStore = this;
      while (root instanceof Layer) root = root.parent;
      idsToRemove.forEach(id => root.delete(id));
    }
    return idsToRemove;
  }

  // Lazily tracks { __ref: <dataId> } strings contained by this.data[dataId].
  private refs: {
    [dataId: string]: Record<string, true>;
  } = Object.create(null);

  public findChildRefIds(dataId: string): Record<string, true> {
    if (!hasOwn.call(this.refs, dataId)) {
      const found = this.refs[dataId] = Object.create(null);
      const workSet = new Set([this.data[dataId]]);
      // Within the store, only arrays and objects can contain child entity
      // references, so we can prune the traversal using this predicate:
      const canTraverse = (obj: any) => obj !== null && typeof obj === 'object';
      workSet.forEach(obj => {
        if (isReference(obj)) {
          found[obj.__ref] = true;
        } else if (canTraverse(obj)) {
          Object.values(obj!)
            // No need to add primitive values to the workSet, since they cannot
            // contain reference objects.
            .filter(canTraverse)
            .forEach(workSet.add, workSet);
        }
      });
    }
    return this.refs[dataId];
  }

  // Used to compute cache keys specific to this.group.
  public makeCacheKey(...args: any[]): object;
  public makeCacheKey() {
    const found = this.group.keyMaker.lookupArray(arguments);
    return found.cacheKey || (found.cacheKey = Object.create(null));
  }

  // Bound function that can be passed around to provide easy access to fields
  // of Reference objects as well as ordinary objects.
  public getFieldValue = <T = StoreValue>(
    objectOrReference: StoreObject | Reference | undefined,
    storeFieldName: string,
  ) => maybeDeepFreeze(
    isReference(objectOrReference)
      ? this.get(objectOrReference.__ref, storeFieldName)
      : objectOrReference && objectOrReference[storeFieldName]
  ) as SafeReadonly<T>;

  // Returns true for non-normalized StoreObjects and non-dangling
  // References, indicating that readField(name, objOrRef) has a chance of
  // working. Useful for filtering out dangling references from lists.
  public canRead: CanReadFunction = objOrRef => {
    return isReference(objOrRef)
      ? this.has(objOrRef.__ref)
      : typeof objOrRef === "object";
  };

  // Bound function that converts an id or an object with a __typename and
  // primary key fields to a Reference object. If called with a Reference object,
  // that same Reference object is returned. Pass true for mergeIntoStore to persist
  // an object into the store.
  public toReference: ToReferenceFunction = (
    objOrIdOrRef,
    mergeIntoStore,
  ) => {
    if (typeof objOrIdOrRef === "string") {
      return makeReference(objOrIdOrRef);
    }

    if (isReference(objOrIdOrRef)) {
      return objOrIdOrRef;
    }

    const [id] = this.policies.identify(objOrIdOrRef);

    if (id) {
      const ref = makeReference(id);
      if (mergeIntoStore) {
        this.merge(id, objOrIdOrRef);
      }
      return ref;
    }
  };
}

export type FieldValueGetter = EntityStore["getFieldValue"];

// A single CacheGroup represents a set of one or more EntityStore objects,
// typically the Root store in a CacheGroup by itself, and all active Layer
// stores in a group together. A single EntityStore object belongs to only
// one CacheGroup, store.group. The CacheGroup is responsible for tracking
// dependencies, so store.group is helpful for generating unique keys for
// cached results that need to be invalidated when/if those dependencies
// change. If we used the EntityStore objects themselves as cache keys (that
// is, store rather than store.group), the cache would become unnecessarily
// fragmented by all the different Layer objects. Instead, the CacheGroup
// approach allows all optimistic Layer objects in the same linked list to
// belong to one CacheGroup, with the non-optimistic Root object belonging
// to another CacheGroup, allowing resultCaching dependencies to be tracked
// separately for optimistic and non-optimistic entity data.
class CacheGroup {
  private d: OptimisticDependencyFunction<string> | null = null;

  constructor(
    public readonly caching: boolean,
    private parent: CacheGroup | null = null,
  ) {
    this.d = caching ? dep<string>() : null;
  }

  public depend(dataId: string, storeFieldName: string) {
    if (this.d) {
      this.d(makeDepKey(dataId, storeFieldName));
      const fieldName = fieldNameFromStoreName(storeFieldName);
      if (fieldName !== storeFieldName) {
        // Fields with arguments that contribute extra identifying
        // information to the fieldName (thus forming the storeFieldName)
        // depend not only on the full storeFieldName but also on the
        // short fieldName, so the field can be invalidated using either
        // level of specificity.
        this.d(makeDepKey(dataId, fieldName));
      }
      if (this.parent) {
        this.parent.depend(dataId, storeFieldName);
      }
    }
  }

  public dirty(dataId: string, storeFieldName: string) {
    if (this.d) {
      this.d.dirty(makeDepKey(dataId, storeFieldName));
    }
  }

  // This WeakMap maps every non-normalized object reference contained by the
  // store to the path of that object within the enclosing entity object. This
  // information is collected by the assignPaths method after every store.merge,
  // so store.data should never contain any un-pathed objects. As a reminder,
  // these object references are handled immutably from here on, so the objects
  // should not move around in a way that invalidates these paths. This path
  // information is useful in the getStorage method, below.
  private paths = new WeakMap<object, (string | number)[]>();

  public assignPaths(dataId: string, merged: StoreObject) {
    const paths = this.paths;
    const path: (string | number)[] = [dataId];

    function assign(this: void, obj: StoreValue) {
      if (Array.isArray(obj)) {
        obj.forEach(handleChild);
      } else if (storeValueIsStoreObject(obj) && !paths.has(obj)) {
        Object.keys(obj).forEach(handleObjectProperty, obj);
      }
    }

    function handleObjectProperty(this: StoreObject, storeFieldName: string) {
      const child = this[storeFieldName];
      handleChild(child, storeFieldName);
    }

    function handleChild(child: StoreValue, key: string | number) {
      if (storeValueIsStoreObject(child)) {
        if (paths.has(child)) return;
        paths.set(child, path.concat(key));
      }
      try {
        path.push(key);
        assign(child);
      } finally {
        invariant(path.pop() === key);
      }
    }

    assign(merged);
  }

  public getStorage(
    parentObjOrRef: StoreObject | Reference,
    ...pathSuffix: (string | number)[]
  ) {
    const path: any[] = [];
    const push = (key: StoreObject | string | number) => path.push(key);

    if (isReference(parentObjOrRef)) {
      push(parentObjOrRef.__ref);
    } else {
      // See assignPaths to understand how this map is populated.
      const assignedPath = this.paths.get(parentObjOrRef);
      if (assignedPath) {
        assignedPath.forEach(push);
      } else {
        // If we can't find a path for this object, use the object reference
        // itself as a key.
        push(parentObjOrRef);
      }
    }

    // Append the provided suffix to the path array.
    pathSuffix.forEach(push);

    const found = this.keyMaker.lookupArray(path);
    return found.storage || (found.storage = Object.create(null));
  }

  // Used by the EntityStore#makeCacheKey method to compute cache keys
  // specific to this CacheGroup.
  public readonly keyMaker = new Trie<{
    cacheKey?: object;
    storage?: StorageType;
  }>(canUseWeakMap);
}

function makeDepKey(dataId: string, storeFieldName: string) {
  // Since field names cannot have '#' characters in them, this method
  // of joining the field name and the ID should be unambiguous, and much
  // cheaper than JSON.stringify([dataId, fieldName]).
  return storeFieldName + '#' + dataId;
}

export namespace EntityStore {
  // Refer to this class as EntityStore.Root outside this namespace.
  export class Root extends EntityStore {
    constructor({
      policies,
      resultCaching = true,
      seed,
    }: {
      policies: Policies;
      resultCaching?: boolean;
      seed?: NormalizedCacheObject;
    }) {
      super(policies, new CacheGroup(resultCaching));
      if (seed) this.replace(seed);
    }

    public readonly stump = new Stump(this);

    public addLayer(
      layerId: string,
      replay: (layer: EntityStore) => any,
    ): Layer {
      // Adding an optimistic Layer on top of the Root actually adds the Layer
      // on top of the Stump, so the Stump always comes between the Root and
      // any Layer objects that we've added.
      return this.stump.addLayer(layerId, replay);
    }

    public removeLayer(): Root {
      // Never remove the root layer.
      return this;
    }
  }
}

// Not exported, since all Layer instances are created by the addLayer method
// of the EntityStore.Root class.
class Layer extends EntityStore {
  constructor(
    public readonly id: string,
    public readonly parent: EntityStore,
    public readonly replay: (layer: EntityStore) => any,
    public readonly group: CacheGroup,
  ) {
    super(parent.policies, group);
    replay(this);
  }

  public addLayer(
    layerId: string,
    replay: (layer: EntityStore) => any,
  ): Layer {
    return new Layer(layerId, this, replay, this.group);
  }

  public removeLayer(layerId: string): EntityStore {
    // Remove all instances of the given id, not just the first one.
    const parent = this.parent.removeLayer(layerId);

    if (layerId === this.id) {
      // Dirty every ID we're removing.
      if (this.group.caching) {
        Object.keys(this.data).forEach(dataId => {
          // If this.data[dataId] contains nothing different from what
          // lies beneath, we can avoid dirtying this dataId and all of
          // its fields, and simply discard this Layer. The only reason we
          // call this.delete here is to dirty the removed fields.
          if (this.data[dataId] !== (parent as Layer).lookup(dataId)) {
            this.delete(dataId);
          }
        });
      }
      return parent;
    }

    // No changes are necessary if the parent chain remains identical.
    if (parent === this.parent) return this;

    // Recreate this layer on top of the new parent.
    return parent.addLayer(this.id, this.replay);
  }

  public toObject(): NormalizedCacheObject {
    return {
      ...this.parent.toObject(),
      ...this.data,
    };
  }

  public findChildRefIds(dataId: string): Record<string, true> {
    const fromParent = this.parent.findChildRefIds(dataId);
    return hasOwn.call(this.data, dataId) ? {
      ...fromParent,
      ...super.findChildRefIds(dataId),
    } : fromParent;
  }
}

// Represents a Layer permanently installed just above the Root, which allows
// reading optimistically (and registering optimistic dependencies) even when
// no optimistic layers are currently active. The stump.group CacheGroup object
// is shared by any/all Layer objects added on top of the Stump.
class Stump extends Layer {
  constructor(root: EntityStore.Root) {
    super(
      "EntityStore.Stump",
      root,
      () => {},
      new CacheGroup(root.group.caching, root.group),
    );
  }

  public removeLayer() {
    // Never remove the Stump layer.
    return this;
  }

  public merge() {
    // We never want to write any data into the Stump, so we forward any merge
    // calls to the Root instead. Another option here would be to throw an
    // exception, but the toReference(object, true) function can sometimes
    // trigger Stump writes (which used to be Root writes, before the Stump
    // concept was introduced).
    return this.parent.merge.apply(this.parent, arguments);
  }
}

function storeObjectReconciler(
  existingObject: StoreObject,
  incomingObject: StoreObject,
  storeFieldName: string,
): StoreValue {
  const existingValue = existingObject[storeFieldName];
  const incomingValue = incomingObject[storeFieldName];

  // Wherever there is a key collision, prefer the incoming value, unless
  // it is deeply equal to the existing value. It's worth checking deep
  // equality here (even though blindly returning incoming would be
  // logically correct) because preserving the referential identity of
  // existing data can prevent needless rereading and rerendering.
  return equal(existingValue, incomingValue) ? existingValue : incomingValue;
}

export function supportsResultCaching(store: any): store is EntityStore {
  // When result caching is disabled, store.depend will be null.
  return !!(store instanceof EntityStore && store.group.caching);
}
