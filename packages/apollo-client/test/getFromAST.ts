import {
  checkDocument,
  getFragmentDefinitions,
  getQueryDefinition,
  getMutationDefinition,
  createFragmentMap,
  FragmentMap,
  getDefaultValues,
  getOperationName,
} from '../src/queries/getFromAST';

import { FragmentDefinitionNode, OperationDefinitionNode } from 'graphql';

import { print } from 'graphql/language/printer';
import gql from 'graphql-tag';
import { assert } from 'chai';

describe('AST utility functions', () => {
  it('should correctly check a document for correctness', () => {
    const multipleQueries = gql`
      query {
        author {
          firstName
          lastName
        }
      }

      query {
        author {
          address
        }
      }
    `;
    assert.throws(() => {
      checkDocument(multipleQueries);
    });

    const namedFragment = gql`
      query {
        author {
          ...authorDetails
        }
      }

      fragment authorDetails on Author {
        firstName
        lastName
      }
    `;
    assert.doesNotThrow(() => {
      checkDocument(namedFragment);
    });
  });

  it('should get fragment definitions from a document containing a single fragment', () => {
    const singleFragmentDefinition = gql`
      query {
        author {
          ...authorDetails
        }
      }

      fragment authorDetails on Author {
        firstName
        lastName
      }
    `;
    const expectedDoc = gql`
      fragment authorDetails on Author {
        firstName
        lastName
      }
    `;
    const expectedResult: FragmentDefinitionNode[] = [
      expectedDoc.definitions[0] as FragmentDefinitionNode,
    ];
    const actualResult = getFragmentDefinitions(singleFragmentDefinition);
    assert.equal(actualResult.length, expectedResult.length);
    assert.equal(print(actualResult[0]), print(expectedResult[0]));
  });

  it('should get fragment definitions from a document containing a multiple fragments', () => {
    const multipleFragmentDefinitions = gql`
      query {
        author {
          ...authorDetails
          ...moreAuthorDetails
        }
      }

      fragment authorDetails on Author {
        firstName
        lastName
      }

      fragment moreAuthorDetails on Author {
        address
      }
    `;
    const expectedDoc = gql`
      fragment authorDetails on Author {
        firstName
        lastName
      }

      fragment moreAuthorDetails on Author {
        address
      }
    `;
    const expectedResult: FragmentDefinitionNode[] = [
      expectedDoc.definitions[0] as FragmentDefinitionNode,
      expectedDoc.definitions[1] as FragmentDefinitionNode,
    ];
    const actualResult = getFragmentDefinitions(multipleFragmentDefinitions);
    assert.deepEqual(actualResult.map(print), expectedResult.map(print));
  });

  it('should get the correct query definition out of a query containing multiple fragments', () => {
    const queryWithFragments = gql`
      fragment authorDetails on Author {
        firstName
        lastName
      }

      fragment moreAuthorDetails on Author {
        address
      }

      query {
        author {
          ...authorDetails
          ...moreAuthorDetails
        }
      }
    `;
    const expectedDoc = gql`
      query {
        author {
          ...authorDetails
          ...moreAuthorDetails
        }
      }
    `;
    const expectedResult: OperationDefinitionNode = expectedDoc
      .definitions[0] as OperationDefinitionNode;
    const actualResult = getQueryDefinition(queryWithFragments);

    assert.equal(print(actualResult), print(expectedResult));
  });

  it('should throw if we try to get the query definition of a document with no query', () => {
    const mutationWithFragments = gql`
      fragment authorDetails on Author {
        firstName
        lastName
      }

      mutation {
        createAuthor(firstName: "John", lastName: "Smith") {
          ...authorDetails
        }
      }
    `;
    assert.throws(() => {
      getQueryDefinition(mutationWithFragments);
    });
  });

  it('should get the correct mutation definition out of a mutation with multiple fragments', () => {
    const mutationWithFragments = gql`
      mutation {
        createAuthor(firstName: "John", lastName: "Smith") {
          ...authorDetails
        }
      }

      fragment authorDetails on Author {
        firstName
        lastName
      }
    `;
    const expectedDoc = gql`
      mutation {
        createAuthor(firstName: "John", lastName: "Smith") {
          ...authorDetails
        }
      }
    `;
    const expectedResult: OperationDefinitionNode = expectedDoc
      .definitions[0] as OperationDefinitionNode;
    const actualResult = getMutationDefinition(mutationWithFragments);
    assert.equal(print(actualResult), print(expectedResult));
  });

  it('should create the fragment map correctly', () => {
    const fragments = getFragmentDefinitions(gql`
      fragment authorDetails on Author {
        firstName
        lastName
      }

      fragment moreAuthorDetails on Author {
        address
      }
    `);
    const fragmentMap = createFragmentMap(fragments);
    const expectedTable: FragmentMap = {
      authorDetails: fragments[0],
      moreAuthorDetails: fragments[1],
    };
    assert.deepEqual(fragmentMap, expectedTable);
  });

  it('should return an empty fragment map if passed undefined argument', () => {
    assert.deepEqual(createFragmentMap(undefined), {});
  });

  it('should get the operation name out of a query', () => {
    const query = gql`
      query nameOfQuery {
        fortuneCookie
      }
    `;
    const operationName = getOperationName(query);
    assert.equal(operationName, 'nameOfQuery');
  });

  it('should get the operation name out of a mutation', () => {
    const query = gql`
      mutation nameOfMutation {
        fortuneCookie
      }
    `;
    const operationName = getOperationName(query);
    assert.equal(operationName, 'nameOfMutation');
  });

  it('should return null if the query does not have an operation name', () => {
    const query = gql`
      {
        fortuneCookie
      }
    `;
    const operationName = getOperationName(query);
    assert.equal(operationName, null);
  });

  it('should throw if type definitions found in document', () => {
    const queryWithTypeDefination = gql`
      fragment authorDetails on Author {
        firstName
        lastName
      }

      query($search: AuthorSearchInputType) {
        author(search: $search) {
          ...authorDetails
        }
      }

      input AuthorSearchInputType {
        firstName: String
      }
    `;
    assert.throws(() => {
      getQueryDefinition(queryWithTypeDefination);
    }, 'Schema type definitions not allowed in queries. Found: "InputObjectTypeDefinition"');
  });

  describe('getDefaultValues', () => {
    it('will create an empty variable object if no default values are provided', () => {
      const basicQuery = gql`
        query people($first: Int, $second: String) {
          allPeople(first: $first) {
            people {
              name
            }
          }
        }
      `;

      assert.deepEqual(getDefaultValues(getQueryDefinition(basicQuery)), {});
    });

    it('will create a variable object based on the definition node with default values', () => {
      const basicQuery = gql`
        query people($first: Int = 1, $second: String!) {
          allPeople(first: $first) {
            people {
              name
            }
          }
        }
      `;

      const complexMutation = gql`
        mutation complexStuff(
          $test: Input = { key1: ["value", "value2"], key2: { key3: 4 } }
        ) {
          complexStuff(test: $test) {
            people {
              name
            }
          }
        }
      `;

      assert.deepEqual(getDefaultValues(getQueryDefinition(basicQuery)), {
        first: 1,
      });
      assert.deepEqual(
        getDefaultValues(getMutationDefinition(complexMutation)),
        { test: { key1: ['value', 'value2'], key2: { key3: 4 } } },
      );
    });
  });
});
