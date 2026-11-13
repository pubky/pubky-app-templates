import type { AccountQuota, Session } from '@synonymdev/pubky'
import { hasAccountAccess } from './access'

export interface AppAccountInfo {
  usedBytes: number
  createdAt: string
  disabled: boolean
  quota: AccountQuota
}

/** Account inspection is separate from the template's normal folder-scoped access. */
export async function getAccountInfo(session: Session): Promise<AppAccountInfo> {
  if (!hasAccountAccess(session)) {
    throw new Error(
      'Account inspection requires read access to /, approved explicitly in Pubky Ring.',
    )
  }
  const grant = session.grant
  if (!grant)
    throw new Error('Account inspection requires a grant session authorized in Pubky Ring.')
  try {
    const account = await grant.account()
    try {
      // Return an ordinary snapshot; callers do not own any SDK/WASM handles.
      return {
        usedBytes: account.usedBytes,
        createdAt: account.createdAt,
        disabled: account.disabled,
        quota: structuredClone(account.quota),
      }
    } finally {
      account.free()
    }
  } finally {
    grant.free()
  }
}
