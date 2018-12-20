import {
  DocumentNode,
  SelectionNode,
  SelectionSetNode,
  OperationDefinitionNode,
  FieldNode,
  DirectiveNode,
  FragmentDefinitionNode,
  ArgumentNode,
  FragmentSpreadNode,
  VariableDefinitionNode,
  VariableNode,
} from 'graphql';
import { visit } from 'graphql/language/visitor';

import {
  checkDocument,
  getOperationDefinitionOrDie,
  getFragmentDefinitions,
  createFragmentMap,
  FragmentMap,
} from './getFromAST';

export type RemoveNodeConfig<N> = {
  name?: string;
  test?: (node: N) => boolean;
  remove?: boolean;
};

export type GetNodeConfig<N> = {
  name?: string;
  test?: (node: N) => boolean;
};

export type RemoveDirectiveConfig = RemoveNodeConfig<DirectiveNode>;
export type GetDirectiveConfig = GetNodeConfig<DirectiveNode>;
export type RemoveArgumentsConfig = RemoveNodeConfig<ArgumentNode>;
export type GetFragmentSpreadConfig = GetNodeConfig<FragmentSpreadNode>;
export type RemoveFragmentSpreadConfig = RemoveNodeConfig<FragmentSpreadNode>;
export type RemoveFragmentDefinitionConfig = RemoveNodeConfig<
  FragmentDefinitionNode
>;
export type RemoveVariableDefinitionConfig = RemoveNodeConfig<
  VariableDefinitionNode
>;

const TYPENAME_FIELD: FieldNode = {
  kind: 'Field',
  name: {
    kind: 'Name',
    value: '__typename',
  },
};

function isNotEmpty(
  op: OperationDefinitionNode | FragmentDefinitionNode,
  fragments: FragmentMap,
): Boolean {
  // keep selections that are still valid
  return (
    op.selectionSet.selections.filter(
      selectionSet =>
        // anything that doesn't match the compound filter is okay
        !// not an empty array
        (
          selectionSet &&
          // look into fragments to verify they should stay
          selectionSet.kind === 'FragmentSpread' &&
          // see if the fragment in the map is valid (recursively)
          !isNotEmpty(fragments[selectionSet.name.value], fragments)
        ),
    ).length > 0
  );
}

function getDirectiveMatcher(
  directives: (RemoveDirectiveConfig | GetDirectiveConfig)[],
) {
  return function directiveMatcher(directive: DirectiveNode): boolean {
    return directives.some(
      (dir: RemoveDirectiveConfig | GetDirectiveConfig) => {
        if (dir.name && dir.name === directive.name.value) return true;
        if (dir.test && dir.test(directive)) return true;
        return false;
      },
    );
  };
}

export function removeDirectivesFromDocument(
  directives: RemoveDirectiveConfig[],
  doc: DocumentNode,
): DocumentNode | null {
  const variablesInUse: Record<string, boolean> = Object.create(null);
  let variablesToRemove: RemoveArgumentsConfig[] = [];

  const fragmentSpreadsInUse: Record<string, boolean> = Object.create(null);
  let fragmentSpreadsToRemove: RemoveFragmentSpreadConfig[] = [];

  let modifiedDoc = visit(doc, {
    Variable: {
      enter(node, _key, parent) {
        // Store each variable that's referenced as part of an argument
        // (excluding operation definition variables), so we know which
        // variables are being used. If we later want to remove a variable
        // we'll fist check to see if it's being used, before continuing with
        // the removal.
        if ((parent as VariableDefinitionNode).kind !== 'VariableDefinition') {
          variablesInUse[node.name.value] = true;
        }
      },
    },

    Field: {
      enter(node) {
        // If `remove` is set to true for a directive, and a directive match
        // is found for a field, remove the field as well.
        const shouldRemoveField = directives.some(
          directive => directive.remove,
        );

        if (
          shouldRemoveField &&
          node.directives.some(getDirectiveMatcher(directives))
        ) {
          if (node.arguments) {
            // Store field argument variables so they can be removed
            // from the operation definition.
            node.arguments
              .filter(arg => arg.value.kind === 'Variable')
              .forEach(arg => {
                variablesToRemove.push({
                  name: (arg.value as VariableNode).name.value,
                });
              });
          }

          if (node.selectionSet) {
            // Store fragment spread names so they can be removed from the
            // docuemnt.
            getAllFragmentSpreadsFromSelectionSet(node.selectionSet).forEach(
              frag => {
                fragmentSpreadsToRemove.push({
                  name: frag.name.value,
                });
              },
            );
          }

          // Remove the field.
          return null;
        }
      },
    },

    FragmentSpread: {
      enter(node) {
        // Keep track of referenced fragment spreads. This is used to
        // determine if top level fragment definitions should be removed.
        fragmentSpreadsInUse[node.name.value] = true;
      },
    },

    Directive: {
      enter(node) {
        // If a matching directive is found, remove it.
        const directiveFound = directives.some(directive => {
          if (directive.name && directive.name === node.name.value) return true;
          if (directive.test && directive.test(node)) return true;
          return false;
        });
        if (directiveFound) {
          // Remove the directive.
          return null;
        }
      },
    },
  });

  // If we've removed fields with arguments, make sure the associated
  // variables are also removed from the rest of the document, as long as they
  // aren't being used elsewhere.
  if (variablesToRemove) {
    variablesToRemove = variablesToRemove.filter(
      variable => !variablesInUse[variable.name],
    );
    modifiedDoc = removeArgumentsFromDocument(variablesToRemove, modifiedDoc);
  }

  // If we've removed selection sets with fragment spreads, make sure the
  // associated fragment definitions are also removed from the rest of the
  // document, as long as they aren't being used elsewhere.
  if (fragmentSpreadsToRemove) {
    fragmentSpreadsToRemove = fragmentSpreadsToRemove.filter(
      fragSpread => !fragmentSpreadsInUse[fragSpread.name],
    );
    modifiedDoc = removeFragmentSpreadFromDocument(
      fragmentSpreadsToRemove,
      modifiedDoc,
    );
  }

  return modifiedDoc;
}

export function addTypenameToDocument(doc: DocumentNode) {
  checkDocument(doc);

  const modifiedDoc = visit(doc, {
    SelectionSet: {
      enter(node, _key, parent) {
        // Don't add __typename to OperationDefinitions.
        if (
          parent &&
          (parent as OperationDefinitionNode).kind === 'OperationDefinition'
        ) {
          return undefined;
        }

        // No changes if no selections.
        const { selections } = node;
        if (!selections) {
          return undefined;
        }

        // If selections already have a __typename, or are part of an
        // introspection query, do nothing.
        const skip = selections.some(selection => {
          return (
            selection.kind === 'Field' &&
            ((selection as FieldNode).name.value === '__typename' ||
              (selection as FieldNode).name.value.lastIndexOf('__', 0) === 0)
          );
        });
        if (skip) {
          return undefined;
        }

        // Create and return a new SelectionSet with a __typename Field.
        return {
          ...node,
          selections: [...selections, TYPENAME_FIELD],
        };
      },
    },
  });

  return modifiedDoc;
}

const connectionRemoveConfig = {
  test: (directive: DirectiveNode) => {
    const willRemove = directive.name.value === 'connection';
    if (willRemove) {
      if (
        !directive.arguments ||
        !directive.arguments.some(arg => arg.name.value === 'key')
      ) {
        console.warn(
          'Removing an @connection directive even though it does not have a key. ' +
            'You may want to use the key parameter to specify a store key.',
        );
      }
    }

    return willRemove;
  },
};

export function removeConnectionDirectiveFromDocument(doc: DocumentNode) {
  checkDocument(doc);
  return removeDirectivesFromDocument([connectionRemoveConfig], doc);
}

function hasDirectivesInSelectionSet(
  directives: GetDirectiveConfig[],
  selectionSet: SelectionSetNode,
  nestedCheck = true,
): boolean {
  return filterSelectionSet(selectionSet, selection =>
    hasDirectivesInSelection(directives, selection, nestedCheck),
  );
}

function hasDirectivesInSelection(
  directives: GetDirectiveConfig[],
  selection: SelectionNode,
  nestedCheck = true,
): boolean {
  if (selection.kind !== 'Field' || !(selection as FieldNode)) {
    return true;
  }

  if (!selection.directives) {
    return false;
  }
  const directiveMatcher = getDirectiveMatcher(directives);
  const matchedDirectives = selection.directives.filter(directiveMatcher);
  const hasMatches = matchedDirectives.length > 0;

  return (
    hasMatches ||
    (nestedCheck &&
      hasDirectivesInSelectionSet(
        directives,
        selection.selectionSet,
        nestedCheck,
      ))
  );
}

export function getDirectivesFromDocument(
  directives: GetDirectiveConfig[],
  doc: DocumentNode,
): DocumentNode | null {
  checkDocument(doc);

  let parentPath: string;
  const modifiedDoc = visit(doc, {
    SelectionSet: {
      enter(node, _key, _parent, path) {
        const currentPath = path.join('-');

        if (
          !parentPath ||
          currentPath === parentPath ||
          !currentPath.startsWith(parentPath)
        ) {
          if (node.selections) {
            const selectionsWithDirectives = node.selections.filter(selection =>
              hasDirectivesInSelection(directives, selection),
            );

            if (hasDirectivesInSelectionSet(directives, node, false)) {
              parentPath = currentPath;
            }

            return {
              ...node,
              selections: selectionsWithDirectives,
            };
          } else {
            return null;
          }
        }
      },
    },
  });

  const operation = getOperationDefinitionOrDie(modifiedDoc);
  const fragments = createFragmentMap(getFragmentDefinitions(modifiedDoc));
  return isNotEmpty(operation, fragments) ? modifiedDoc : null;
}

function getArgumentMatcher(config: RemoveArgumentsConfig[]) {
  return (argument: ArgumentNode): Boolean => {
    return config.some((aConfig: RemoveArgumentsConfig) => {
      if (
        argument.value.kind !== 'Variable' ||
        !(argument.value as VariableNode)
      )
        return false;
      if (!argument.value.name) return false;
      if (aConfig.name === argument.value.name.value) return true;
      if (aConfig.test && aConfig.test(argument)) return true;
      return false;
    });
  };
}

function hasArgumentsInSelectionSet(
  config: RemoveArgumentsConfig[],
  selectionSet: SelectionSetNode,
  nestedCheck: boolean = false,
): boolean {
  return filterSelectionSet(selectionSet, selection =>
    hasArgumentsInSelection(config, selection, nestedCheck),
  );
}

function hasArgumentsInSelection(
  config: RemoveArgumentsConfig[],
  selection: SelectionNode,
  nestedCheck: boolean = false,
): boolean {
  // Selection is a FragmentSpread or InlineFragment, ignore (include it)...
  if (selection.kind !== 'Field' || !(selection as FieldNode)) {
    return true;
  }

  if (!selection.arguments) {
    return false;
  }
  const matcher = getArgumentMatcher(config);
  const matchedArguments = selection.arguments.filter(matcher);
  return (
    matchedArguments.length > 0 ||
    (nestedCheck &&
      hasArgumentsInSelectionSet(config, selection.selectionSet, nestedCheck))
  );
}

export function removeArgumentsFromDocument(
  config: RemoveArgumentsConfig[],
  doc: DocumentNode,
): DocumentNode | null {
  const argMatcher = getArgumentMatcher(config);

  const modifiedDoc = visit(doc, {
    OperationDefinition: {
      enter(node) {
        // Remove matching top level variables definitions.
        const variableDefinitions = node.variableDefinitions.filter(
          varDef =>
            !config.some(arg => arg.name === varDef.variable.name.value),
        );
        return {
          ...node,
          variableDefinitions,
        };
      },
    },

    Field: {
      enter(node) {
        // If `remove` is set to true for an argument, and an argument match
        // is found for a field, remove the field as well.
        const shouldRemoveField = config.some(argConfig => argConfig.remove);

        if (shouldRemoveField) {
          let argMatchCount = 0;
          node.arguments.forEach(arg => {
            if (argMatcher(arg)) {
              argMatchCount += 1;
            }
          });
          if (argMatchCount === 1) {
            return null;
          }
        }
      },
    },

    Argument: {
      enter(node) {
        // Remove all matching arguments.
        if (argMatcher(node)) {
          return null;
        }
      },
    },
  });

  const operation = getOperationDefinitionOrDie(modifiedDoc);
  const fragments = createFragmentMap(getFragmentDefinitions(modifiedDoc));
  return isNotEmpty(operation, fragments) ? modifiedDoc : null;
}

export function removeFragmentSpreadFromDocument(
  config: RemoveFragmentSpreadConfig[],
  doc: DocumentNode,
): DocumentNode | null {
  const modifiedDoc = visit(doc, {
    FragmentSpread: {
      enter(node) {
        const fragSpreadFound = config.some(
          fragSpread => fragSpread.name === node.name.value,
        );
        if (fragSpreadFound) {
          return null;
        }
      },
    },

    FragmentDefinition: {
      enter(node) {
        const fragDefFound = config.some(
          fragDef => fragDef.name && fragDef.name === node.name.value,
        );
        if (fragDefFound) {
          return null;
        }
      },
    },
  });

  return modifiedDoc;
}

function getAllFragmentSpreadsFromSelectionSet(
  selectionSet: SelectionSetNode,
): FragmentSpreadNode[] {
  return selectionSet.selections
    .map(getAllFragmentSpreadsFromSelection)
    .reduce(
      (allFragments, selectionFragments) => [
        ...allFragments,
        ...selectionFragments,
      ],
      [],
    );
}

function getAllFragmentSpreadsFromSelection(
  selection: SelectionNode,
): FragmentSpreadNode[] {
  if (
    (selection.kind === 'Field' || selection.kind === 'InlineFragment') &&
    selection.selectionSet
  ) {
    return getAllFragmentSpreadsFromSelectionSet(selection.selectionSet);
  } else if (
    selection.kind === 'FragmentSpread' &&
    (selection as FragmentSpreadNode)
  ) {
    return [selection];
  }

  return [];
}

function filterSelectionSet(
  selectionSet: SelectionSetNode,
  filter: (node: SelectionNode) => boolean,
) {
  if (!(selectionSet && selectionSet.selections)) {
    return false;
  }

  return selectionSet.selections.filter(filter).length > 0;
}
