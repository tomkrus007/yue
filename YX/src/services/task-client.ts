/**
 * 团队任务：团队(群) → 分组(inventory) → 任务
 *   分组：GET {taskUri}/v1/inventory/source?sourceId={群id}
 *   任务：GET {taskUri}/v1/task/inventory/{分组id}/tasks   → { tasks: [...] }
 * 都是 GET，且只认 query 里的 access_token。
 */
import { getServerPaths } from './config'
import { tokenGet } from './http'

export interface TeamTask {
  id: string
  title: string
  status?: number
  expiredAt?: number
  finishAt?: number
  principalName?: string
  children?: TeamTask[]
}

export interface TaskGroup {
  id: string
  name: string
  lastUpdatedDate?: number
  tasks: TeamTask[]
  failed?: boolean
}

function taskBase(): string {
  return String(getServerPaths().taskUri || '').replace(/\/+$/, '')
}

export async function loadTeamTasks(groupId: string): Promise<TaskGroup[]> {
  const base = taskBase()
  if (!base || !groupId) return []
  const d = await tokenGet<any>(
    base + '/v1/inventory/source?sourceId=' + encodeURIComponent(groupId),
  )
  const groups = (Array.isArray(d) ? d : (d && d.data) || []).slice()
  groups.sort(
    (a: any, b: any) =>
      (Number(b.lastUpdatedDate) || 0) - (Number(a.lastUpdatedDate) || 0),
  )
  return Promise.all(
    groups.map(async (g: any): Promise<TaskGroup> => {
      try {
        const r = await tokenGet<any>(
          base +
            '/v1/task/inventory/' +
            encodeURIComponent(g.id) +
            '/tasks',
        )
        const list = (r && (r.tasks || r.data)) || []
        return {
          id: String(g.id),
          name: g.name || String(g.id),
          lastUpdatedDate: Number(g.lastUpdatedDate) || 0,
          tasks: Array.isArray(list) ? list : [],
        }
      } catch {
        return {
          id: String(g.id),
          name: g.name || String(g.id),
          lastUpdatedDate: Number(g.lastUpdatedDate) || 0,
          tasks: [],
          failed: true,
        }
      }
    }),
  )
}

export function taskStatus(task: TeamTask): {
  cls: 'done' | 'over' | 'doing'
  text: string
} {
  if (task.status === 1) return { cls: 'done', text: '已完成' }
  if (task.status === 2) return { cls: 'over', text: '已终止' }
  if (task.expiredAt && task.expiredAt < Date.now()) {
    return { cls: 'over', text: '已逾期' }
  }
  return { cls: 'doing', text: '进行中' }
}