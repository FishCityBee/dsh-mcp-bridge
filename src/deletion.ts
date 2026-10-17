// Harness 0.2.1-rc.2 has no storage-owned atomic delete API. A write lease
// followed by rm is insufficient: deleting its lock identity permits new owners.
export const PERMANENT_DELETE_SUPPORTED = false
export const PERMANENT_DELETE_MESSAGE = 'PERMANENT_DELETE_UNSUPPORTED: 该版 Harness 无跨进程安全删除接口，永久删除与自动清理已停用；请使用归档。旧 pending 记录保留但不执行。'
export function refusePermanentDelete(): never { throw new Error(PERMANENT_DELETE_MESSAGE) }
