import { AuthForm } from '@/components/auth/auth-form'

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>
}) {
  const params = await searchParams

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/30 p-4">
      <div className="w-full max-w-sm rounded-lg border bg-background p-8 shadow-sm">
        <AuthForm initialError={params.error} />
      </div>
    </main>
  )
}
