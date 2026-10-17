import { createHash } from 'node:crypto'
import type { Catalog } from './catalog.ts'

export interface Selection { provider: string; model: string; reasoningEffort?: string }
export interface SelectionSettings {
  enabled: boolean
  mode: 'single' | 'provider'
  singleProvider: string
  singleModel: string
  singleEffort: string
  providerId: string
  providerDefaultModel: string
  providerDefaultEffort: string
  providerAllowOverrides: boolean
  approvalMode: 'inherit' | 'ask' | 'never'
  defaultWorkspace: string
  fallback?: Selection
}
export interface RequestedSelection { provider?: string; model?: string; reasoningEffort?: string }
export const configVersion = (settings: SelectionSettings) => `v2-${createHash('sha256').update(JSON.stringify(settings)).digest('hex').slice(0, 16)}`
export const sameSelection = (a: Selection, b: Selection) => a.provider === b.provider && a.model === b.model && a.reasoningEffort === b.reasoningEffort

export function select(settings: SelectionSettings, requested: RequestedSelection, catalog: Catalog): Selection {
  if (!settings.enabled) throw new Error('CONFIG_CONFLICT: MCP 已关闭')
  const single = settings.mode === 'single'
  const provider = (single ? settings.singleProvider : settings.providerId) || settings.fallback?.provider
  const group = catalog.groups.find(g => g.id === provider)
  if (!provider || !group) throw new Error('CONFIG_CONFLICT: 右下角供应商不可用，请重新选择')
  if (requested.provider !== undefined && requested.provider !== provider) throw new Error('CONFIG_CONFLICT: 供应商已锁定')
  const lockedModel = (single ? settings.singleModel || settings.fallback?.model : settings.providerDefaultModel || group.models[0]?.id)
  const overrides = !single && settings.providerAllowOverrides
  if (!overrides && requested.model !== undefined && requested.model !== lockedModel) throw new Error(`CONFIG_CONFLICT: ${single ? '单模型' : '供应商'}模式锁定 ${provider}/${lockedModel}`)
  const model = overrides ? requested.model ?? lockedModel : lockedModel
  const entry = group.models.find(m => m.id === model)
  if (!entry) throw new Error('CONFIG_CONFLICT: 模型不属于锁定的供应商，或当前不可用')
  const configured = (single ? settings.singleEffort : settings.providerDefaultEffort) || undefined
  const allowed = entry.reasoning?.efforts.map(e => e.id) ?? []
  // With overrides enabled, a different chosen model may have a different effort vocabulary.
  const preferred = configured && allowed.includes(configured) ? configured : undefined
  if (configured && !preferred && !overrides) throw new Error('CONFIG_CONFLICT: 配置的推理等级不受该模型支持，请在工具栏重新选择')
  const lockedEffort = preferred ?? entry.reasoning?.defaultEffort
  if (!overrides && requested.reasoningEffort !== undefined && requested.reasoningEffort !== lockedEffort) throw new Error('CONFIG_CONFLICT: 推理等级已由工具栏锁定')
  const reasoningEffort = overrides ? requested.reasoningEffort ?? lockedEffort : lockedEffort
  if (reasoningEffort !== undefined && !allowed.includes(reasoningEffort)) throw new Error('CONFIG_CONFLICT: 模型不支持所选推理等级')
  return { provider, model: entry.id, ...(reasoningEffort === undefined ? {} : { reasoningEffort }) }
}
