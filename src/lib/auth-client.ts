import { adminClient, organizationClient } from 'better-auth/client/plugins'
import { createAuthClient } from 'better-auth/react'

export const authClient = createAuthClient({
  plugins: [organizationClient(), adminClient()],
})

export const { useSession, signIn, signUp, signOut, organization, admin } = authClient

export type Session = typeof authClient.$Infer.Session
export type SessionUser = Session['user']
export type ActiveOrganization = typeof authClient.$Infer.ActiveOrganization
