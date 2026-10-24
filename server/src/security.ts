import {
  GraphQLError,
  Kind,
  getNullableType,
  isListType,
  type FragmentDefinitionNode,
  type SelectionSetNode,
  type ValidationContext,
} from 'graphql';
import type { ApolloServerPlugin } from '@apollo/server';
import { getComplexity, simpleEstimator, type ComplexityEstimator } from 'graphql-query-complexity';

export const MAX_DEPTH = Number(process.env.MAX_QUERY_DEPTH ?? 12);
export const MAX_COMPLEXITY = Number(process.env.MAX_QUERY_COMPLEXITY ?? 10_000);

// ---------- depth limit (a validation rule: runs before execution, costs nothing) ----------

export const depthLimit = (max: number) => (context: ValidationContext) => {
  const fragments = new Map<string, FragmentDefinitionNode>();
  for (const def of context.getDocument().definitions) {
    if (def.kind === Kind.FRAGMENT_DEFINITION) fragments.set(def.name.value, def);
  }

  const depthOf = (set: SelectionSetNode, visiting: Set<string>): number => {
    let deepest = 0;
    for (const sel of set.selections) {
      if (sel.kind === Kind.FIELD) {
        if (sel.name.value.startsWith('__')) continue; // introspection isn't part of the budget
        deepest = Math.max(deepest, 1 + (sel.selectionSet ? depthOf(sel.selectionSet, visiting) : 0));
      } else if (sel.kind === Kind.INLINE_FRAGMENT) {
        deepest = Math.max(deepest, depthOf(sel.selectionSet, visiting));
      } else {
        const name = sel.name.value;
        const frag = fragments.get(name);
        if (!frag || visiting.has(name)) continue; // unknown / cyclic fragments are reported by other rules
        deepest = Math.max(deepest, depthOf(frag.selectionSet, new Set(visiting).add(name)));
      }
    }
    return deepest;
  };

  return {
    OperationDefinition(node: { selectionSet: SelectionSetNode }) {
      const depth = depthOf(node.selectionSet, new Set());
      if (depth > max) {
        context.reportError(
          new GraphQLError(`Query is too deep: ${depth} levels (maximum ${max})`, {
            nodes: [node as never],
            extensions: { code: 'QUERY_TOO_DEEP', http: { status: 400 } },
          }),
        );
      }
    },
  };
};

// ---------- complexity (cost estimate, needs variable values so it runs after parsing) ----------

const ASSUMED_LIST_SIZE = 10;

const estimator: ComplexityEstimator = ({ field, args, childComplexity }) => {
  if (field.name === 'edges') return childComplexity; // the page size is already applied on the connection field
  if (typeof args.first === 'number') return 1 + args.first * childComplexity; // paginated: cost scales with page size
  if (isListType(getNullableType(field.type))) return 1 + ASSUMED_LIST_SIZE * childComplexity; // unbounded lists
  return undefined; // fall through to the default cost of 1
};

export function complexityPlugin(max = MAX_COMPLEXITY): ApolloServerPlugin {
  return {
    async requestDidStart() {
      return {
        async didResolveOperation({ request, document, schema }) {
          const cost = getComplexity({
            schema,
            query: document,
            variables: request.variables,
            operationName: request.operationName ?? undefined,
            estimators: [estimator, simpleEstimator({ defaultComplexity: 1 })],
          });
          if (cost > max) {
            throw new GraphQLError(`Query is too complex: cost ${cost} (maximum ${max})`, {
              extensions: { code: 'QUERY_TOO_COMPLEX', cost, maxCost: max, http: { status: 400 } },
            });
          }
        },
      };
    },
  };
}
