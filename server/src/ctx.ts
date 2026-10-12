import { db } from './db.ts'
import type { GenContext } from './core/generate.ts'

export function genCtx(): GenContext {
  const d = db.data
  return { nodes: d.nodes, subscriptions: d.subscriptions, templates: d.templates, customRules: d.customRules, settings: d.settings }
}
