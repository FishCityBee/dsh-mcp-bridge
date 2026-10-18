// Harness 0.2.1-rc.2 has no storage-owned atomic delete API. A write lease
// followed by rm is insufficient: deleting its lock identity permits new owners.
export const PERMANENT_DELETE_SUPPORTED = false
export const PERMANENT_DELETE_MESSAGE = 'PERMANENT_DELETE_UNSUPPORTED: 该版 Harness 无跨进程安全删除接口，插件内永久删除已停用；请使用归档。如需永久删除，请在官方应用或工具中自行检查并手动处理，相关入口不在本次安全验证范围。旧 pending 记录保留但不执行。'
export function refusePermanentDelete(): never { throw new Error(PERMANENT_DELETE_MESSAGE) }
