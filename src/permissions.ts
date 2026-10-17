export const PERMISSION_PRESETS = ['read-only', 'workspace-write', 'danger-full-access'] as const
export type NewSessionPermission = 'default' | typeof PERMISSION_PRESETS[number]

/** Use the same official preset setter as Harness. Never change its global default. */
export function applyNewSessionPermission(presets: any, session: any, choice: NewSessionPermission) {
  if (choice === 'default') return // The official session/created hook pins the user default.
  if (!PERMISSION_PRESETS.includes(choice) || !presets?.set || !presets?.resolve) {
    throw new Error('PERMISSION_PRESET_UNAVAILABLE: 无法安全应用新会话权限预设')
  }
  try { presets.resolve(choice) } catch { throw new Error(`PERMISSION_PRESET_UNAVAILABLE: Harness 未提供 ${choice}`) }
  presets.set(session, choice)
}
