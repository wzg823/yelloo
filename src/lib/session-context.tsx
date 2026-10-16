'use client'

/**
 * 会话上下文。
 *
 * 目的：让客户端组件（发帖框、实时流、导航）拿到当前用户，
 * 而不必每个组件各自发一次请求。
 *
 * 注意：这里的用户数据只是**渲染用**，任何权限判断都必须在服务端重做。
 * 客户端隐藏按钮不等于阻止操作。
 */
import { createContext, useContext, type ReactNode } from 'react'

export type SessionSnapshot = {
  id: number
  handle: string
  displayName: string | null
  avatarUrl: string | null
  role: string
} | null

const SessionContext = createContext<SessionSnapshot>(null)

export function SessionProvider({
  user,
  children,
}: {
  user: SessionSnapshot
  children: ReactNode
}) {
  return <SessionContext.Provider value={user}>{children}</SessionContext.Provider>
}

export function useSession(): SessionSnapshot {
  return useContext(SessionContext)
}
