/** Toolbar automatic archival and manual batch archive / unarchive. */
import { useState } from 'react'
import { parseArchiveStatus } from './cleanup-status.ts'
import { PERMANENT_DELETE_MESSAGE, PERMANENT_DELETE_SUPPORTED } from '../deletion.ts'

export type BatchAction = 'archive' | 'unarchive' | 'delete'
export interface BatchFilter { mcpOnly?: boolean; olderThanDays?: number }

export type CleanupCommand = { action: 'cleanup-now' } | {
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
  const cleanup = parseArchiveStatus(cleanupStatus)

  const archiveNow = async () => {
    setBusy(true)
    setNotice(null)
    try {
      const result = await sendCommand({ action: 'cleanup-now' })
      setNotice(`已自动归档 ${result.archived} 个，跳过 ${result.skipped.length} 个，失败 ${result.failed.length} 个；会话文件保留`)
    } catch (error) { setNotice(message(error)) } finally { setBusy(false) }
  }

  /** Ask the host which sessions match, confirm with the user, then run. */
  const run = async () => {
    if (action === 'delete' && !PERMANENT_DELETE_SUPPORTED) {
      setNotice(PERMANENT_DELETE_MESSAGE)
      return
    }
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
      const warning = action === 'archive' ? '\n\n手动批量归档会请求停止会话活动并取消置顶。请确认没有需要继续的工作。' : action === 'delete' ? '\n\n永久删除后无法恢复。' : ''
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
        <span>会话归档</span>
        <span aria-hidden="true">{expanded ? '▴' : '▾'}</span>
      </button>
      {expanded && (
        <div className="dmb-section-body">
          <label className="dmb-field dmb-inline">
            <span>自动归档早于</span>
            <input type="number" min={0} className="dmb-num" value={autoCleanupDays ?? 0} disabled={!saveDays}
              onChange={e => saveDays?.(Math.max(0, Math.floor(Number(e.target.value) || 0)))} />
            <span>天的 MCP 会话（0 为关闭）</span>
          </label>
          <p className="dmb-note">自动归档仅处理本插件创建的旧 MCP 会话，保留日志、缓存和记录，可取消归档；不释放会话文件占用的磁盘空间。跳过本进程 live／busy、活动未知或校验失败的会话，并请求官方非停止活动归档；不保证其他进程均空闲。</p>
          <p className="dmb-note">永久删除暂不可用。旧待删除记录保留且不自动执行；如需删除，请在官方应用或工具中自行检查、手动处理，相关删除入口未在此验证。</p>
          <button type="button" className="dmb-btn" disabled={busy || !autoCleanupDays || autoCleanupDays <= 0} onClick={() => void archiveNow()}>
            {busy ? '处理中…' : '立即自动归档'}
          </button>
          {cleanup ? (
            <p className="dmb-note">
              上次自动归档：{new Date(cleanup.at).toLocaleString()}，归档 {cleanup.archived} 个，跳过 {cleanup.skipped.length} 个，失败 {cleanup.failed.length} 个。
              {cleanup.pendingDeletes?.state === 'unreadable' ? '旧待删除记录无法读取，需人工检查；原文件未改写。' : cleanup.pendingDeletes?.count ? `保留 ${cleanup.pendingDeletes.count} 条旧待删除记录，未执行。` : ''}
            </p>
          ) : cleanupStatus ? <p className="dmb-note">存在旧版或无法识别的维护记录，不能作为本次自动归档结果。</p> : null}

          <div className="dmb-divider" />

          <label className="dmb-field">
            <span>批量处理工作区</span>
            <select value={target} onChange={e => { setWorkspace(e.target.value); setNotice(null) }}>
              {workspaces.map(w => <option key={w.workspaceId} value={w.workspaceId} title={w.path}>{w.title}</option>)}
            </select>
          </label>
          <p className="dmb-note">手动批量归档会请求停止会话活动并取消置顶；活动中的 MCP 任务会拒绝处理。请先确认工作已结束。</p>
          <div className="dmb-row">
            <select className="dmb-grow" value={action} onChange={e => { setAction(e.target.value as BatchAction); setNotice(null) }}>
              <option value="archive">归档</option>
              <option value="unarchive">取消归档</option>
              <option value="delete" disabled={!PERMANENT_DELETE_SUPPORTED}>永久删除（暂不可用）</option>
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
            disabled={busy || !target || (action === 'delete' && !PERMANENT_DELETE_SUPPORTED)} onClick={() => void run()}>
            {busy ? '处理中…' : `${ACTION_LABEL[action]}符合条件的会话…`}
          </button>
        </div>
      )}
    </div>
  )
}
