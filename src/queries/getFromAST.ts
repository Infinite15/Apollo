import {
  Document,
  OperationDefinition,
  FragmentDefinition,
} from 'graphql';

import countBy = require('lodash.countby');
import identity = require('lodash.identity');

export function getMutationDefinition(doc: Document): OperationDefinition {
  checkDocument(doc);

  let mutationDef: OperationDefinition = null;
  doc.definitions.map((definition) => {
    if (definition.kind === 'OperationDefinition'
        && (definition as OperationDefinition).operation === 'mutation') {
      mutationDef = definition as OperationDefinition;
    }
  });

  if (mutationDef === null) {
    throw new Error('Must contain a mutation definition.');
  }

  return mutationDef;
}

// Checks the document for errors and throws an exception if there is an error.
export function checkDocument(doc: Document) {
  if (doc.kind !== 'Document') {
    throw new Error(`Expecting a parsed GraphQL document. Perhaps you need to wrap the query \
string in a "gql" tag? http://docs.apollostack.com/apollo-client/core.html#gql`);
  }

  const definitionTypes = doc.definitions.map((definition) => {
    return definition.kind;
  });
  const typeCounts = countBy(definitionTypes, identity);

  // can't have more than one operation definition per query
  if (typeCounts['OperationDefinition'] > 1) {
    throw new Error('Queries must have exactly one operation definition.');
  }
}

// Returns the FragmentDefinitions from a particular document as an array
export function getFragmentDefinitions(doc: Document): FragmentDefinition[] {
  checkDocument(doc);
  let fragmentDefinitions: FragmentDefinition[] = [];

  doc.definitions.map((definition) => {
    if (definition.kind === 'FragmentDefinition') {
      fragmentDefinitions.push(definition as FragmentDefinition);
    }
  });

  return fragmentDefinitions;
}

export function getQueryDefinition(doc: Document): OperationDefinition {
  checkDocument(doc);

  let queryDef: OperationDefinition = null;
  doc.definitions.map((definition) => {
    if(definition.kind === 'OperationDefinition'
       && (definition as OperationDefinition).operation === 'query') {
      queryDef = definition as OperationDefinition;
    }
  });

  if (queryDef === null) {
    throw new Error('Must contain a query definition.');
  }

  return queryDef;
}

export function getFragmentDefinition(doc: Document): FragmentDefinition {
  if (doc.kind !== 'Document') {
    throw new Error(`Expecting a parsed GraphQL document. Perhaps you need to wrap the query \
string in a "gql" tag? http://docs.apollostack.com/apollo-client/core.html#gql`);
  }

  if (doc.definitions.length > 1) {
    throw new Error('Fragment must have exactly one definition.');
  }

  const fragmentDef = doc.definitions[0] as FragmentDefinition;

  if (fragmentDef.kind !== 'FragmentDefinition') {
    throw new Error('Must be a fragment definition.');
  }

  return fragmentDef as FragmentDefinition;
}
