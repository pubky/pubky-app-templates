/** Keep a Ring waiter alive while a page is in the back/forward cache. */
export function createRingAuthAttempt(
  getSelectedAccount: () => string | null,
  isActive: () => boolean,
) {
  const selectedAccount = getSelectedAccount()
  let canceled = false
  let visibility: Promise<void> | undefined
  let show: (() => void) | undefined
  const isCurrent = () => !canceled && isActive() && getSelectedAccount() === selectedAccount
  return {
    isCurrent,
    pause() {
      visibility ??= new Promise<void>((resolve) => {
        show = resolve
      })
    },
    resume() {
      visibility = undefined
      show?.()
      show = undefined
    },
    cancel() {
      canceled = true
      show?.()
    },
    async waitUntilVisible() {
      while (visibility && !canceled) await visibility
      return isCurrent()
    },
  }
}

export type RingAuthAttempt = ReturnType<typeof createRingAuthAttempt>
