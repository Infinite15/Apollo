import { QueryBatcher,
         QueryFetchRequest,
       } from '../src/batching';
import { assert } from 'chai';
import mockNetworkInterface, {
  mockBatchedNetworkInterface,
} from './mocks/mockNetworkInterface';
import gql from '../src/gql';
import { GraphQLResult } from 'graphql';

const networkInterface = mockNetworkInterface();

describe('QueryBatcher', () => {
  it('should construct', () => {
    assert.doesNotThrow(() => {
      const querySched = new QueryBatcher({
        shouldBatch: true,
        networkInterface,
      });
      querySched.consumeQueue();
    });
  });

  it('should not do anything when faced with an empty queue', () => {
    const scheduler = new QueryBatcher({
      shouldBatch: true,
      networkInterface,
    });

    assert.equal(scheduler.fetchRequests.length, 0);
    scheduler.consumeQueue();
    assert.equal(scheduler.fetchRequests.length, 0);
  });

  it('should be able to add to the queue', () => {
    const scheduler = new QueryBatcher({
      shouldBatch: true,
      networkInterface,
    });

    const query = gql`
      query {
        author {
          firstName
          lastName
        }
      }`;

    const request: QueryFetchRequest = {
      options: { query },
      queryId: 'not-a-real-id',
    };

    assert.equal(scheduler.fetchRequests.length, 0);
    scheduler.queueRequest(request);
    assert.equal(scheduler.fetchRequests.length, 1);
    scheduler.queueRequest(request);
    assert.equal(scheduler.fetchRequests.length, 2);
  });

  describe('request queue', () => {
    const query = gql`
      query {
        author {
          firstName
          lastName
        }
      }`;
    const data = {
      'author' : {
        'firstName': 'John',
        'lastName': 'Smith',
      },
    };
    const myNetworkInterface = mockBatchedNetworkInterface(
      {
        request: { query },
        result: { data },
      },
      {
        request: { query },
        result: { data },
      }
    );
    const scheduler = new QueryBatcher({
      shouldBatch: true,
      networkInterface: myNetworkInterface,
    });
    const request: QueryFetchRequest = {
      options: { query },
      queryId: 'not-a-real-id',
    };

    it('should be able to consume from a queue containing a single query',
       (done) => {
      scheduler.queueRequest(request);
      const promises: Promise<GraphQLResult>[] = scheduler.consumeQueue();
      assert.equal(promises.length, 1);
      promises[0].then((resultObj) => {
        assert.equal(scheduler.fetchRequests.length, 0);
        assert.deepEqual(resultObj, { data } );
        done();
      });
    });

    it('should be able to consume from a queue containing multiple queries', (done) => {
      const request2 = {
        options: { query },
        queryId: 'another-fake-id',
      };
      const myBatcher = new QueryBatcher({
        shouldBatch: true,
        networkInterface: mockBatchedNetworkInterface(
          {
            request: { query },
            result: {data },
          },
          {
            request: { query },
            result: { data },
          }
        ),
      });
      myBatcher.queueRequest(request);
      myBatcher.queueRequest(request2);
      const promises: Promise<GraphQLResult>[] = myBatcher.consumeQueue();
      assert.equal(scheduler.fetchRequests.length, 0);
      assert.equal(promises.length, 2);
      promises[0].then((resultObj1) => {
        assert.deepEqual(resultObj1, { data });
        promises[1].then((resultObj2) => {
          assert.deepEqual(resultObj2, { data });
          done();
        });
      });
    });

    it('should return a promise when we enqueue a request and resolve it with a result', (done) => {
      const myBatcher = new QueryBatcher({
        shouldBatch: true,
        networkInterface: mockBatchedNetworkInterface(
          {
            request: { query },
            result: { data },
          }
        ),
      });
      const promise = myBatcher.queueRequest(request);
      myBatcher.consumeQueue();
      promise.then((result) => {
        assert.deepEqual(result, { data });
        done();
      });
    });
  });

  it('should be able to stop polling', () => {
    const scheduler = new QueryBatcher({
      shouldBatch: true,
      networkInterface,
    });
    const query = gql`
      query {
        author {
          firstName
          lastName
        }
      }`;
    const request = {
      options: { query },
      queryId: 'not-a-real-id',
    };

    scheduler.queueRequest(request);
    scheduler.queueRequest(request);

    //poll with a big interval so that the queue
    //won't actually be consumed by the time we stop.
    scheduler.start(1000);
    scheduler.stop();
    assert.equal(scheduler.fetchRequests.length, 2);
  });

  it('should resolve the promise returned when we enqueue with shouldBatch: false', (done) => {
    const query = gql`
      query {
        author {
          firstName
          lastName
        }
      }`;
    const request = {
      options: { query },
      queryId: 'not-a-real-id',
    };

    const data = {
      author: {
        firstName: 'John',
        lastName: 'Smith',
      },
    };
    const myNetworkInterface = mockNetworkInterface(
      {
        request: { query },
        result: { data },
      }
    );
    const batcher = new QueryBatcher({
      shouldBatch: false,
      networkInterface: myNetworkInterface,
    });
    const promise = batcher.queueRequest(request);
    batcher.consumeQueue();
    promise.then((result) => {
      assert.deepEqual(result, { data });
      done();
    });
  });

  it('should reject the promise if there is a network error with batch:true', (done) => {
    const query = gql`
      query {
        author {
          firstName
          lastName
        }
      }`;
    const request = {
      options: { query },
      queryId: 'very-real-id',
    };
    const error = new Error('Network error');
    const myNetworkInterface = mockBatchedNetworkInterface(
      {
        request: { query },
        error,
      }
    );
    const batcher = new QueryBatcher({
      shouldBatch: true,
      networkInterface: myNetworkInterface,
    });
    const promise = batcher.queueRequest(request);
    batcher.consumeQueue();
    promise.catch((resError: Error) => {
      assert.equal(resError.message, 'Network error');
      done();
    });
  });

  it('should reject the promise if there is a network error with batch:false', (done) => {
    const query = gql`
      query {
        author {
          firstName
          lastName
        }
      }`;
    const request = {
      options: { query },
      queryId: 'super-real-id',
    };
    const error = new Error('Network error');
    const myNetworkInterface = mockNetworkInterface(
      {
        request: { query },
        error,
      }
    );
    const batcher = new QueryBatcher({
      shouldBatch: false,
      networkInterface: myNetworkInterface,
    });
    const promise = batcher.queueRequest(request);
    batcher.consumeQueue();
    promise.catch((resError: Error) => {
      assert.equal(resError.message, 'Network error');
      done();
    });
  });
});
