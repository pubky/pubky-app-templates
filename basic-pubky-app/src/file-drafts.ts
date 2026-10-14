import type { AppFile } from './storage'

type FileBaseline = Pick<AppFile, 'id' | 'title' | 'body' | 'updatedAt'>

export interface FileDraft {
  title: string
  body: string
  editingId?: string
  baseline?: FileBaseline
}

function snapshot(file: AppFile | undefined): FileBaseline | undefined {
  if (!file) return undefined
  const { id, title, body, updatedAt } = file
  return { id, title, body, updatedAt }
}

export function captureFileDraft(
  fields: Pick<FileDraft, 'title' | 'body' | 'editingId'>,
  file: AppFile | undefined,
  previous?: FileDraft,
): FileDraft {
  return {
    ...fields,
    baseline:
      previous?.editingId === fields.editingId
        ? (previous?.baseline ?? snapshot(file))
        : snapshot(file),
  }
}

/** Reconcile only after rereading the file under its newly acquired lock. */
export function reconcileFileDraft(file: AppFile, draft?: FileDraft) {
  if (draft?.editingId === file.id) {
    const baseline = draft.baseline
    const dirty = !baseline || draft.title !== baseline.title || draft.body !== baseline.body
    if (dirty) {
      const conflict =
        !baseline ||
        baseline.id !== file.id ||
        baseline.title !== file.title ||
        baseline.body !== file.body ||
        baseline.updatedAt !== file.updatedAt
      return { draft, conflict }
    }
  }
  return {
    draft: captureFileDraft({ editingId: file.id, title: file.title, body: file.body }, file),
    conflict: false,
  }
}
