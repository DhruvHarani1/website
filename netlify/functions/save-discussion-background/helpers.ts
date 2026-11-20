import { graphql } from '@octokit/graphql';

export function toTitleCase(title: string): string {
  return title
    .split(' ')
    .map((word: string) => {
      return word[0].toUpperCase() + word.substring(1);
    })
    .join(' ');
}

/**
 * The purpose of this function is to prepare the query for a graphql call.
 *
 * @param query the graphql query. Never interpolate untrusted data into it; pass it through `variables`.
 * @param variables values bound to the `$name` variables declared in the query.
 * @returns {GraphQlResponse} the GitHub response object.
 */
export async function fetchGraphql(query: string, variables: Record<string, unknown> = {}): Promise<any> {
  const parameters = {
    ...variables,
    headers: {
      authorization: `token ${process.env.GITHUB_TOKEN}`,
    },
  };
  return await graphql(query, parameters);
}
