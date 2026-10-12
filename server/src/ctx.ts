import { db } from './db.ts'
import { expandCustomRules } from '../../shared/rules-yaml.ts'
import type { GenContext } from './core/generate.ts'

export function genCtx(): GenContext {
  const d = db.data
  return { nodes: d.nodes, subscriptions: d.subscriptions, templates: d.templates, customRules: expandCustomRules(d.customRules), settings: d.settings }
}
