import { z } from 'zod'

export interface SuggestedNextStep {
  label: string
  prompt: string
}

export interface BufferedNextStepSuggestions {
  pending: SuggestedNextStep[] | null
  displayed: SuggestedNextStep[]
}

const suggestedNextStepSchema = z
  .object({
    label: z.string().trim().min(1),
    prompt: z.string().trim().min(1),
  })
  .transform((value) => ({
    label: value.label,
    prompt: value.prompt,
  }))

export const suggestedNextStepsSchema = z.array(suggestedNextStepSchema).length(3)

export function cloneSuggestedNextSteps(
  suggestions: SuggestedNextStep[] | null | undefined,
): SuggestedNextStep[] | null {
  if (!suggestions) {
    return null
  }

  return suggestions.map((suggestion) => ({ ...suggestion }))
}

export function normalizeSuggestedNextSteps(value: unknown): SuggestedNextStep[] | null {
  const result = suggestedNextStepsSchema.safeParse(value)

  if (!result.success) {
    return null
  }

  return cloneSuggestedNextSteps(result.data)
}

export function createEmptyBufferedNextStepSuggestions(): BufferedNextStepSuggestions {
  return {
    pending: null,
    displayed: [],
  }
}

export function clearBufferedNextStepSuggestions(): BufferedNextStepSuggestions {
  return createEmptyBufferedNextStepSuggestions()
}

export function setPendingBufferedNextStepSuggestions(
  current: BufferedNextStepSuggestions,
  suggestions: SuggestedNextStep[],
): BufferedNextStepSuggestions {
  return {
    pending: cloneSuggestedNextSteps(suggestions),
    displayed: current.displayed.map((suggestion) => ({ ...suggestion })),
  }
}

export function promotePendingBufferedNextStepSuggestions(
  current: BufferedNextStepSuggestions,
): BufferedNextStepSuggestions {
  return {
    pending: null,
    displayed: cloneSuggestedNextSteps(current.pending) ?? [],
  }
}

export function getNextStepSuggestionShortcutIndex(
  name: string | undefined,
  sequence: string | undefined,
) {
  const candidate = (name ?? sequence ?? '').trim()

  if (candidate === '1' || candidate === '2' || candidate === '3') {
    return Number(candidate) - 1
  }

  return null
}
