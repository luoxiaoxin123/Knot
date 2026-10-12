import { useQuery } from '@tanstack/react-query'
import type { Node, Profile, CustomRule, RuleTemplate, Settings, Subscription } from '@shared/types'
import { api } from './api'

export type NodeView = Node & { uri: string | null }

export interface RulesMeta {
  modules: { id: string; name: string; description: string; fixed?: string; defaultPolicy: string; required?: boolean; sources: string[] }[]
  presets: { id: string; name: string; description: string; modules: string[] }[]
  ruleTypes: string[]
  policies: string[]
  templatePresets: { name: string; kind: 'ini' | 'clash'; url: string }[]
}

export type SettingsView = Settings & { s3: Settings['s3'] & { hasSecret: boolean } }

export const useNodes = () => useQuery({ queryKey: ['nodes'], queryFn: () => api.get<NodeView[]>('/nodes') })
export const useSubs = () => useQuery({ queryKey: ['subs'], queryFn: () => api.get<Subscription[]>('/subs') })
export const useProfiles = () => useQuery({ queryKey: ['profiles'], queryFn: () => api.get<Profile[]>('/profiles') })
export const useCustomRules = () => useQuery({ queryKey: ['customRules'], queryFn: () => api.get<CustomRule[]>('/rules/custom') })
export const useTemplates = () => useQuery({ queryKey: ['templates'], queryFn: () => api.get<RuleTemplate[]>('/templates') })
export const useRulesMeta = () => useQuery({ queryKey: ['rulesMeta'], queryFn: () => api.get<RulesMeta>('/rules/meta'), staleTime: Infinity })
export const useSettings = () => useQuery({ queryKey: ['settings'], queryFn: () => api.get<SettingsView>('/settings') })

/** 订阅链接的对外地址 */
export function subBase(settings?: Settings) {
  return settings?.publicUrl || window.location.origin
}
