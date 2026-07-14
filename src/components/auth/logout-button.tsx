'use client'

import { useState } from 'react'
import { logout } from '@/lib/actions/auth'
import { Button } from '@/components/ui/button'
import { LogOut } from 'lucide-react'

export function LogoutButton() {
  const [pending, setPending] = useState(false)
  return (
    <form
      action={async () => {
        setPending(true)
        await logout()
      }}
    >
      <Button type="submit" variant="ghost" size="sm" disabled={pending}>
        <LogOut className="h-4 w-4" />
        退出
      </Button>
    </form>
  )
}
