/** Host-side model catalog, mirroring dsh-api-session-controller's buildModelCatalog so MCP sees the chat picker's list. */
import type { Context } from '@deepseek-ai/cordis'

export interface CatalogModel {
  id: string
  name: string
  reasoning?: { efforts: { id: string; name: string }[]; defaultEffort?: string }
}

export interface Catalog {
  groups: { id: string; name: string; models: CatalogModel[] }[]
  failures: { id: string; name: string; message: string }[]
}

export async function buildCatalog(ctx: Context): Promise<Catalog> {
  const llm = (ctx as any).llm
  const providers: { id: string; name: string }[] = llm.listProviders()
  const results = await Promise.all(providers.map(async provider => {
    try {
      const models: { id: string; name: string }[] = await llm.listModels(provider.id)
      const entries = await Promise.all(models.map(async (model): Promise<CatalogModel> => {
        const resolved = await llm.resolveModelInfo(provider.id, model.id)
        const reasoning = resolved?.reasoning
        return {
          id: model.id,
          name: model.name,
          ...(reasoning ? {
            reasoning: {
              efforts: reasoning.efforts.map((e: { id: string; name: string }) => ({ id: String(e.id), name: e.name })),
              ...(reasoning.defaultEffort === undefined ? {} : { defaultEffort: String(reasoning.defaultEffort) }),
            },
          } : {}),
        }
      }))
      return { group: { id: provider.id, name: provider.name, models: entries }, failure: undefined }
    } catch (error) {
      return { group: undefined, failure: { id: provider.id, name: provider.name, message: error instanceof Error ? error.message : String(error) } }
    }
  }))
  return {
    groups: results.flatMap(r => r.group && r.group.models.length > 0 ? [r.group] : []),
    failures: results.flatMap(r => r.failure ? [r.failure] : []),
  }
}

export function findModel(catalog: Catalog, provider: string, model: string): CatalogModel | undefined {
  return catalog.groups.find(g => g.id === provider)?.models.find(m => m.id === model)
}
