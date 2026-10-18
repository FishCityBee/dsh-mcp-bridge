/** Only versioned archive receipts may be displayed as automatic archival. */
export interface ArchiveStatus {
  kind: 'auto-archive'
  schemaVersion: 1
  at: number
  archived: number
  deleted: 0
  skipped: unknown[]
  failed: unknown[]
  pendingDeletes?: { state: 'empty' | 'retained' | 'unreadable'; count: number | null }
}
export function parseArchiveStatus(raw: string | undefined): ArchiveStatus | undefined {
  try {
    const value = raw ? JSON.parse(raw) : undefined
    if (value?.kind !== 'auto-archive' || value.schemaVersion !== 1 || !Number.isFinite(value.at)
      || !Number.isInteger(value.archived) || value.archived < 0 || value.deleted !== 0
      || !Array.isArray(value.skipped) || !Array.isArray(value.failed)) return undefined
    const pending = value.pendingDeletes
    if (pending !== undefined && (!pending || !['empty', 'retained', 'unreadable'].includes(pending.state)
      || (pending.count !== null && (!Number.isInteger(pending.count) || pending.count < 0)))) return undefined
    return value
  } catch { return undefined }
}
