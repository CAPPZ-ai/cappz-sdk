import { hostedClient } from '../sync/hostedBackend';

export interface MergeSuggestion { merged: string; rationale: string }

/**
 * Ask the RepoZ agent for a merge suggestion. A person always reviews and signs.
 * The operation is `repoz-merge-assist` on the registered hosted client: a host
 * answers it however it likes (cappz.ai routes it to its browser AI path; there
 * is no hosted copy). Without a registered client this throws, and the merge
 * stays manual.
 */
export async function suggestRepoZMerge(input: { artifactId: string; base: string; ours: string; theirs: string; instruction?: string }): Promise<MergeSuggestion> {
  const fns = hostedClient().functions;
  if (!fns) throw new Error('repoz-merge-assist: no hosted backend registered (local-only)');
  const { data, error } = await fns.invoke('repoz-merge-assist', { body: input });
  if (error) {
    const context = (error as { context?: { text?: () => Promise<string> } }).context;
    throw new Error(context?.text ? await context.text() : (error as { message?: string }).message ?? String(error));
  }
  return data as MergeSuggestion;
}
