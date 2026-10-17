/**
 * dsh-mcp-bridge — client face.
 *
 * - Bottom-right floating toolbar (`shell.overlay`): MCP switch, single-model /
 *   provider mode, model + reasoning effort, default workspace, auto-approve,
 *   auto-cleanup and batch session cleanup.
 * - "删除会话" row in every session's "…" menu (`sidebar.workspaces.session.menu.item`).
 *
 * Settings are this plugin's volatile config, read and written through
 * `remote.settings`. Host-only operations (delete, batch, cleanup) go through
 * the `command` / `commandResult` mailbox fields, so no port is opened.
 */
import type { Context } from '@deepseek-ai/cordis'
import { IconTrashOutlineRegular, MenuItemButton } from '@deepseek-ai/dsh-client-ui-primitives'
import { useEffect, useRef, useState } from 'react'
import { STYLE } from './style.ts'
import { CleanupSection, type BatchAction, type BatchFilter } from './cleanup.tsx'
import { SettingsSync } from './settings-sync.ts'

const NS = 'mcp-bridge'
const COMMAND_TIMEOUT_MS = 60_000

interface Effort { id: string; name: string }
interface Model { id: string; name: string; reasoning?: { efforts: Effort[]; defaultEffort?: string } }
interface Group { id: string; name: string; models: Model[] }
interface Catalog { default: { provider: string; model: string }; groups: Group[] }

interface Settings {
  enabled: boolean
  mode: 'single' | 'provider'
  singleProvider: string
  singleModel: string
  singleEffort: string
  providerId: string
  providerDefaultModel: string
  providerDefaultEffort: string
  providerAllowOverrides: boolean
  defaultWorkspace: string
  autoApprove: boolean
  approvalMode: 'inherit' | 'ask' | 'never'
  autoCleanupDays: number
  command: string
  commandResult: string
  cleanupStatus: string
}

type Editable = Omit<Settings, 'command' | 'commandResult' | 'cleanupStatus'>

interface BridgeState {
  catalog: Catalog | null
  settings: Settings | null
  error: string | null
  saving: boolean
}

interface WorkspaceRow { workspaceId: string; title: string; path: string }

interface Command {
  action: 'delete-session' | 'manage-sessions' | 'cleanup-now'
  sessionId?: string
  workspace?: string
  manageAction?: BatchAction
  filter?: BatchFilter
  confirm?: boolean
  previewToken?: string
}
type SendCommand = (command: Command) => Promise<any>

/** Minimal observable store compatible with the slot `hooks` compartment. */
function createStore<T>(initial: T) {
  let value = initial
  const listeners = new Set<() => void>()
  return {
    getSnapshot: () => value,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    update(patch: Partial<T>) {
      value = { ...value, ...patch }
      for (const listener of listeners) listener()
    },
  }
}

function unwrap<T>(result: any): T {
  if (result && typeof result === 'object' && 'ok' in result) {
    if (result.ok) return result.value as T
    throw new Error(result.error?.message ?? String(result.error?.code ?? 'remote error'))
  }
  return result as T
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function parseJson<T>(raw: string | undefined): T | undefined {
  if (!raw) return undefined
  try { return JSON.parse(raw) as T } catch { return undefined }
}

export const name = 'mcp-bridge-toolbar'
export const inject = ['slots', 'remote', 'remote.session', 'remote.settings']

export function apply(ctx: Context): void {
  const c = ctx as any
  const store = createStore<BridgeState>({ catalog: null, settings: null, error: null, saving: false })
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>()

  const settleCommands = (settings: Settings) => {
    const reply = parseJson<{ id: string; ok: boolean; result?: unknown; error?: string }>(settings.commandResult)
    const waiter = reply && pending.get(reply.id)
    if (!reply || !waiter) return
    pending.delete(reply.id)
    clearTimeout(waiter.timer)
    if (reply.ok) waiter.resolve(reply.result)
    else waiter.reject(new Error(reply.error ?? '执行失败'))
  }

  const loadCatalog = async () => {
    try {
      store.update({ catalog: unwrap<Catalog>(await c.remote.session.modelCatalog()) })
    } catch (error) {
      store.update({ error: `模型列表加载失败：${message(error)}` })
    }
  }
  const sync = new SettingsSync<Settings>({
    async read() {
      const described = unwrap<{ namespaces: { ns: string; value: Settings }[] }>(await c.remote.settings.describe())
      const view = described.namespaces.find(n => n.ns === NS)
      if (!view) throw new Error('Harness 未加载 mcp-bridge 插件配置')
      settleCommands(view.value)
      return view.value
    },
    async write(patch) {
      const view = unwrap<{ value: Settings }>(await c.remote.settings.update(NS, patch, undefined))
      settleCommands(view.value)
      return view.value
    },
    publish(settings, saving, error) { store.update({ ...(settings ? { settings } : {}), saving, error }) },
  })
  const loadSettings = () => sync.load()
  const save = (patch: Partial<Editable>) => sync.save(patch)
  const performCommand: SendCommand = (command) => {
    const id = `cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(new Error('Harness 没有响应（超过 60 秒）'))
      }, COMMAND_TIMEOUT_MS)
      pending.set(id, { resolve, reject, timer })
      // Don't rely on settings/document-updated alone: re-read until the host answers.
      const poll = setInterval(() => {
        if (!pending.has(id)) clearInterval(poll)
        else void loadSettings()
      }, 1_000)
      const payload = JSON.stringify({ ...command, id, at: Date.now() })
      Promise.resolve(c.remote.settings.update(NS, { command: payload }, undefined)).then(unwrap).catch((error: unknown) => {
        pending.delete(id)
        clearTimeout(timer)
        reject(new Error(`发送失败：${message(error)}`))
      })
    })
  }

  let commandQueue: Promise<unknown> = Promise.resolve()
  const sendCommand: SendCommand = command => {
    const result = commandQueue.then(() => performCommand(command))
    commandQueue = result.catch(() => undefined)
    return result
  }

  void loadCatalog()
  void loadSettings()
  for (const event of ['llm/adapters-updated', 'credentials/record-updated', 'credentials/reference-updated']) {
    c.remote.$on(event, () => { void loadCatalog() })
  }
  c.remote.$on('settings/document-updated', () => { void loadSettings(); void loadCatalog() })
  ctx.on('connection/reset' as any, () => { void loadCatalog(); void loadSettings() })

  ctx.effect(() => {
    const tag = document.createElement('style')
    tag.dataset.plugin = 'dsh-mcp-bridge'
    tag.textContent = STYLE
    document.head.appendChild(tag)
    return () => {
      tag.remove()
      for (const waiter of pending.values()) clearTimeout(waiter.timer)
      pending.clear()
    }
  }, 'mcp-bridge: toolbar style')

  c.slots.inject('shell.overlay', () => c.slots.register({
    name: 'shell.overlay',
    id: 'mcp-bridge.toolbar',
    order: 100,
    inject: () => ({ hooks: { bridge: store }, save, sendCommand, reload: () => { void loadCatalog(); void loadSettings() } }),
  }, Toolbar))

  c.slots.inject('sidebar.workspaces.session.menu.item', () => c.slots.register({
    name: 'sidebar.workspaces.session.menu.item',
    id: 'mcp-bridge.delete-session',
    order: 420,
    inject: () => ({ sendCommand }),
  }, DeleteSessionMenuItem))
}

// ---- session "…" menu -----------------------------------------------------------

interface DeleteMenuProps {
  sessionId: string
  displayTitle: string
  useMenuOpenState: () => [boolean, (open: boolean) => void]
  sendCommand: SendCommand
}

function DeleteSessionMenuItem({ sessionId, displayTitle, useMenuOpenState, sendCommand }: DeleteMenuProps) {
  const [, setMenuOpen] = useMenuOpenState()
  return (
    <MenuItemButton danger separatorBefore icon={<IconTrashOutlineRegular />} onSelect={() => {
      setMenuOpen(false)
      const label = displayTitle || sessionId
      if (!window.confirm(`永久删除会话「${label}」？\n\n删除后无法恢复。只想先收起来的话，请用菜单里的「归档」。`)) return
      sendCommand({ action: 'delete-session', sessionId }).catch(error => {
        window.alert(`删除失败：${message(error)}`)
      })
    }}>
      删除会话
    </MenuItemButton>
  )
}

// ---- toolbar ---------------------------------------------------------------------

interface ToolbarProps {
  useBridge: <S>(selector: (state: BridgeState) => S) => S
  useWorkspaces?: <S>(selector: (state: { items: readonly WorkspaceRow[] }) => S) => S
  save: (patch: Partial<Editable>) => Promise<void>
  sendCommand: SendCommand
  reload: () => void
}

function modelLabel(catalog: Catalog | null, provider: string, model: string): string {
  const group = catalog?.groups.find(g => g.id === provider)
  return group?.models.find(m => m.id === model)?.name ?? (model || '未选择')
}

function Toolbar({ useBridge, useWorkspaces, save, sendCommand, reload }: ToolbarProps) {
  const catalog = useBridge(s => s.catalog)
  const settings = useBridge(s => s.settings)
  const error = useBridge(s => s.error)
  const saving = useBridge(s => s.saving)
  const workspaces = useWorkspaces?.(s => s.items) ?? []
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDown = (event: PointerEvent) => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false)
    }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const fallback = catalog?.default
  const enabled = settings?.enabled ?? false
  const mode = settings?.mode ?? 'single'
  const singleProvider = settings?.singleProvider || fallback?.provider || ''
  const singleModel = settings?.singleModel || fallback?.model || ''
  const providerId = settings?.providerId || fallback?.provider || ''
  const providerGroup = catalog?.groups.find(g => g.id === providerId)
  const providerDefault = settings?.providerDefaultModel || providerGroup?.models[0]?.id || ''
  const providerEntry = providerGroup?.models.find(m => m.id === providerDefault)
  const providerEfforts = providerEntry?.reasoning?.efforts ?? []
  const providerEffort = settings?.providerDefaultEffort || providerEntry?.reasoning?.defaultEffort || ''
  const singleEntry = catalog?.groups.find(g => g.id === singleProvider)?.models.find(m => m.id === singleModel)
  const efforts = singleEntry?.reasoning?.efforts ?? []
  const effortValue = settings?.singleEffort || singleEntry?.reasoning?.defaultEffort || ''

  const summary = mode === 'single'
    ? modelLabel(catalog, singleProvider, singleModel)
    : (providerGroup?.name ?? providerId) || '未选择供应商'

  return (
    <div className="dmb-root" ref={root}>
      {open && (
        <div className="dmb-panel" role="dialog" aria-label="DeepSeek Harness MCP">
          <div className="dmb-row dmb-head">
            <span className="dmb-title">MCP 桥接</span>
            <label className="dmb-switch" title="开启后 Claude Code 可通过 MCP 调用 Harness">
              <input type="checkbox" checked={enabled} disabled={!settings} onChange={e => void save({ enabled: e.target.checked })} />
              <span>{enabled ? '已开启' : '已关闭'}</span>
            </label>
          </div>

          <div className="dmb-tabs" role="tablist">
            {(['single', 'provider'] as const).map(value => (
              <button key={value} type="button" role="tab" aria-selected={mode === value}
                className={mode === value ? 'dmb-tab dmb-tab-on' : 'dmb-tab'}
                disabled={!settings} onClick={() => void save({ mode: value })}>
                {value === 'single' ? '单模型' : '供应商'}
              </button>
            ))}
          </div>

          {mode === 'single' ? (
            <>
              <label className="dmb-field">
                <span>模型</span>
                <select value={`${singleProvider}\u0000${singleModel}`} disabled={!catalog || !settings}
                  onChange={e => {
                    const [provider, model] = e.target.value.split('\u0000')
                    void save({ singleProvider: provider, singleModel: model, singleEffort: '' })
                  }}>
                  {!singleEntry && <option value={`${singleProvider}\u0000${singleModel}`}>{singleModel || '请选择'}</option>}
                  {catalog?.groups.map(group => (
                    <optgroup key={group.id} label={group.name}>
                      {group.models.map(model => (
                        <option key={model.id} value={`${group.id}\u0000${model.id}`}>{model.name}</option>
                      ))}
                    </optgroup>
                  ))}
                </select>
              </label>
              {efforts.length > 0 && (
                <label className="dmb-field">
                  <span>推理等级</span>
                  <select value={effortValue} disabled={!settings} onChange={e => void save({ singleEffort: e.target.value })}>
                    {efforts.map(effort => <option key={effort.id} value={effort.id}>{effort.name}</option>)}
                  </select>
                </label>
              )}
            </>
          ) : (
            <>
              <label className="dmb-field">
                <span>供应商</span>
                <select value={providerId} disabled={!catalog || !settings}
                  onChange={e => void save({ providerId: e.target.value, providerDefaultModel: '', providerDefaultEffort: '' })}>
                  {!providerGroup && <option value={providerId}>{providerId || '请选择'}</option>}
                  {catalog?.groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
                </select>
              </label>
              <label className="dmb-field">
                <span>默认模型</span>
                <select value={providerDefault} disabled={!providerGroup || !settings}
                  onChange={e => void save({ providerDefaultModel: e.target.value, providerDefaultEffort: '' })}>
                  {providerGroup?.models.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
                </select>
              </label>
              {providerEfforts.length > 0 && (
                <label className="dmb-field">
                  <span>默认推理等级</span>
                  <select value={providerEffort} disabled={!settings} onChange={e => void save({ providerDefaultEffort: e.target.value })}>
                    {providerEfforts.map(effort => <option key={effort.id} value={effort.id}>{effort.name}</option>)}
                  </select>
                </label>
              )}
              <label className="dmb-check">
                <input type="checkbox" checked={settings?.providerAllowOverrides ?? false} disabled={!settings}
                  onChange={e => void save({ providerAllowOverrides: e.target.checked })} />
                <span>允许调用方选择模型/推理等级</span>
              </label>
              <p className="dmb-note">默认关闭：上面的模型和等级成为任务约束。开启后允许在此供应商范围内明确选择。</p>
            </>
          )}

          <label className="dmb-field">
            <span>默认工作区</span>
            <select value={settings?.defaultWorkspace ?? ''} disabled={!settings}
              onChange={e => void save({ defaultWorkspace: e.target.value })}>
              <option value="">（未设置，需调用方指定）</option>
              {workspaces.map(w => <option key={w.workspaceId} value={w.workspaceId} title={w.path}>{w.title}</option>)}
            </select>
          </label>

          <label className="dmb-field">
            <span>MCP 会话审批</span>
            <select value={settings?.approvalMode ?? 'inherit'} disabled={!settings}
              onChange={e => void save({ approvalMode: e.target.value as Settings['approvalMode'] })}>
              <option value="inherit">沿用会话 / Harness 设置</option>
              <option value="ask">需要审批时询问</option>
              <option value="never">需要审批时自动拒绝</option>
            </select>
          </label>
          <p className="dmb-note">该版只支持单次允许；允许调用 MCP 不会授予下游文件或命令权限。沙箱与权限范围沿用会话设置。</p>
          {settings?.autoApprove && <p className="dmb-note">旧“自动批准”设置已停用：它原来实际是拒绝审批。已有会话保留原权限，可明确选择“需要审批时询问”。</p>}

          <CleanupSection autoCleanupDays={settings?.autoCleanupDays} cleanupStatus={settings?.cleanupStatus} defaultWorkspace={settings?.defaultWorkspace}
            workspaces={workspaces} saveDays={settings ? days => void save({ autoCleanupDays: days }) : undefined} sendCommand={sendCommand} />

          {error && (
            <div className="dmb-error">
              {error}
              <button type="button" className="dmb-link" onClick={reload}>重试</button>
            </div>
          )}
        </div>
      )}
      <button type="button" className={enabled ? 'dmb-pill dmb-pill-on' : 'dmb-pill'} aria-expanded={open}
        title={`MCP ${enabled ? '已开启' : '已关闭'} · ${mode === 'single' ? '单模型' : '供应商'}：${summary}`}
        onClick={() => setOpen(v => !v)}>
        <span className="dmb-dot" aria-hidden="true" />
        <span>MCP</span>
        <span className="dmb-sep" aria-hidden="true">·</span>
        <span className="dmb-summary">{mode === 'single' ? summary : `供应商 ${summary}`}</span>
        {saving && <span className="dmb-spin" aria-label="保存中" />}
      </button>
    </div>
  )
}
