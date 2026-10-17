/** Toolbar "会话清理" section: auto-cleanup days plus one-button batch archive / unarchive / delete. */
import { useState } from 'react'

export type BatchAction = 'archive' | 'unarchive' | 'delete'
export interface BatchFilter { mcpOnly?: boolean; olderThanDays?: number }

export interface CleanupCommand {
  action: 'manage-sessions'
  workspace: string
  manageAction: BatchAction
  filter: BatchFilter
  confirm: boolean
  previewToken?: string
}

interface WorkspaceRow { workspaceId: string; title: string; path: string }

const ACTION_LABEL: Record<BatchAction, string> = { archive: '归档', unarchive: '取消归档', delete: '永久删除' }

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function CleanupSection({ autoCleanupDays, cleanupStatus, defaultWorkspace, workspaces, saveDays, sendCommand }: {
  autoCleanupDays: number | undefined
  cleanupStatus: string | undefined
  defaultWorkspace: string | undefined
  workspaces: readonly WorkspaceRow[]
  saveDays: ((days: number) => void) | undefined
  sendCommand: (command: CleanupCommand) => Promise<any>
}) {
  const [expanded, setExpanded] = useState(false)
  const [workspace, setWorkspace] = useState('')
  const [action, setAction] = useState<BatchAction>('archive')
  const [mcpOnly, setMcpOnly] = useState(true)
  const [olderThan, setOlderThan] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)

  const target = workspace || defaultWorkspace || workspaces[0]?.workspaceId || ''
  const targetTitle = workspaces.find(w => w.workspaceId === target)?.title ?? target
  const days = Number(olderThan)
  const filter: BatchFilter = { mcpOnly, ...(olderThan && days > 0 ? { olderThanDays: days } : {}) }
  let cleanup: { at: number; deleted: number; failed: unknown[] } | undefined
  try { cleanup = cleanupStatus ? JSON.parse(cleanupStatus) : undefined } catch { cleanup = undefined }

  /** Ask the host which sessions match, confirm with the user, then run. */
  const run = async () => {
    setBusy(true)
    setNotice(null)
    try {
      const preview = await sendCommand({ action: 'manage-sessions', workspace: target, manageAction: action, filter, confirm: false })
      const targets: { sessionId: string; title?: string }[] = preview?.targets ?? []
      if (targets.length === 0) {
        setNotice('没有符合条件的会话')
        return
      }
      const names = targets.slice(0, 8).map(t => `· ${t.title || t.sessionId}`).join('\n')
      const more = targets.length > 8 ? `\n…等共 ${targets.length} 个` : ''
      const warning = action === 'delete' ? '\n\n永久删除后无法恢复。' : ''
      if (!window.confirm(`在「${targetTitle}」中${ACTION_LABEL[action]} ${targets.length} 个会话：\n\n${names}${more}${warning}`)) return
      const result = await sendCommand({ action: 'manage-sessions', workspace: target, manageAction: action, filter, confirm: true, previewToken: preview.previewToken })
      setNotice(`已${ACTION_LABEL[action]} ${result.done} 个会话${result.failed ? `，${result.failed} 个失败` : ''}`)
    } catch (error) {
      setNotice(message(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="dmb-section">
      <button type="button" className="dmb-section-head" aria-expanded={expanded} onClick={() => setExpanded(v => !v)}>
        <span>会话清理</span>
        <span aria-hidden="true">{expanded ? '▴' : '▾'}</span>
      </button>
      {expanded && (
        <div className="dmb-section-body">
          <label className="dmb-field dmb-inline">
            <span>自动删除早于</span>
            <input type="number" min={0} className="dmb-num" value={autoCleanupDays ?? 0} disabled={!saveDays}
              onChange={e => saveDays?.(Math.max(0, Math.floor(Number(e.target.value) || 0)))} />
            <span>天的 MCP 会话（0 为关闭）</span>
          </label>
          {cleanup && (
            <p className="dmb-note">
              上次自动清理：{new Date(cleanup.at).toLocaleString()}，删除 {cleanup.deleted} 个{cleanup.failed.length ? `，${cleanup.failed.length} 个失败` : ''}
            </p>
          )}

          <div className="dmb-divider" />

          <label className="dmb-field">
            <span>批量处理工作区</span>
            <select value={target} onChange={e => { setWorkspace(e.target.value); setNotice(null) }}>
              {workspaces.map(w => <option key={w.workspaceId} value={w.workspaceId} title={w.path}>{w.title}</option>)}
            </select>
          </label>
          <div className="dmb-row">
            <select className="dmb-grow" value={action} onChange={e => { setAction(e.target.value as BatchAction); setNotice(null) }}>
              <option value="archive">归档</option>
              <option value="unarchive">取消归档</option>
              <option value="delete">永久删除</option>
            </select>
            <input type="number" min={0} placeholder="早于 N 天" className="dmb-num" value={olderThan}
              onChange={e => { setOlderThan(e.target.value); setNotice(null) }} />
          </div>
          <label className="dmb-check">
            <input type="checkbox" role="switch" checked={mcpOnly} onChange={e => { setMcpOnly(e.target.checked); setNotice(null) }} />
            <span>仅 MCP 创建的会话</span>
          </label>
          {notice && <p className="dmb-note">{notice}</p>}
          <button type="button" className={action === 'delete' ? 'dmb-btn dmb-btn-danger' : 'dmb-btn dmb-btn-primary'}
            disabled={busy || !target} onClick={() => void run()}>
            {busy ? '处理中…' : `${ACTION_LABEL[action]}符合条件的会话…`}
          </button>
        </div>
      )}
    </div>
  )
}
