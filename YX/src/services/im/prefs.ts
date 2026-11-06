/**
 * 会话级偏好：免打扰、折叠、置顶、目录补名、团队群判定。
 *
 * 全部对齐 web 参考实现（2026-10 实测）：
 * - 免打扰按会话类型分流，且这些接口只收表单参数（发 JSON 会报「参数缺失」）
 * - 折叠存服务端 `ms_behavior.expInfo.isFold`
 * - 置顶 `msgstick/list`
 * - 团队群靠群详情 `templateCode === workGroupDefault` 或 extendParams.tag === '团队'
 */
import { getServerPaths } from '../config'
import { httpJson, postForm } from '../http'

export interface SessionRef {
  id: string
  type: number
  name?: string
}

const TO_MULTI_TYPES = new Set([2, 4, 8])

/** 官方 getTalkTypeMsg：to_type ∈ {2,4,8} 或自己发的 → 会话是 to_*。 */
export function sessionOfMsg(
  msg: any,
  meId: string,
): { id: string; type: number; name: string } {
  const useTo = TO_MULTI_TYPES.has(Number(msg.to_type)) || msg.from_id === meId
  return {
    id: useTo ? msg.to_id : msg.from_id,
    type: (useTo ? msg.to_type : msg.from_type) || 1,
    name: (useTo ? msg.to_name : msg.from_name) || '',
  }
}

/** 服务号（type 5）是广播类的，默认不参与未读计数。 */
export function isServiceAccount(s: { type: number } | undefined): boolean {
  return !!s && Number(s.type) === 5
}

/** 工作台（type 8）官方没有免打扰开关。 */
export function supportsMute(s: SessionRef | undefined): boolean {
  return !!s && [1, 2, 4, 5].includes(Number(s.type))
}

function uamBase(): string {
  return String(getServerPaths().uamApiUri || '').replace(/\/+$/, '')
}

function normalizeList(data: any): any[] {
  return Array.isArray(data) ? data : (data && data.data) || []
}

export interface DirectoryEntry {
  name: string
  type: number
}

/** 群 / 服务号的名字表，用来给「只有 id 没有名字」的会话补名字。 */
export async function loadDirectory(): Promise<Map<string, DirectoryEntry>> {
  const map = new Map<string, DirectoryEntry>()
  const base = uamBase()
  if (!base) return map
  try {
    const d = await httpJson<any>(base + '/v1/groups/joined')
    for (const g of normalizeList(d)) {
      const id = g.groupId || g.id
      if (id) map.set(String(id), { name: g.name || '', type: 2 })
    }
  } catch {
    /* 忽略 */
  }
  try {
    const sn = String(getServerPaths().serviceNoUri || '').replace(/\/+$/, '')
    if (sn) {
      const d = await httpJson<any>(sn + '/v2/servicenos/authorized')
      for (const a of normalizeList(d)) {
        const id = a.accountId || a.id
        if (id) map.set(String(id), { name: a.name || '', type: 5 })
      }
    }
  } catch {
    /* 忽略 */
  }
  return map
}

/**
 * 置顶会话：GET {uamApiUri}/v1/msgstick/list → [{ stickId, stickTime, type }]
 * 有些置顶会话在离线窗口里没有消息，需要按 id 补出来。
 */
export async function loadPinned(): Promise<
  Array<{ id: string; type: number; time: number }>
> {
  const base = uamBase()
  if (!base) return []
  try {
    const d = await httpJson<any>(base + '/v1/msgstick/list')
    return normalizeList(d)
      .filter((it) => it && it.stickId)
      .map((it) => ({
        id: String(it.stickId),
        type: Number(it.type) || 1,
        time: Number(it.stickTime) || 0,
      }))
  } catch {
    return []
  }
}

/**
 * 折叠状态存在服务端（message_session.expInfo.isFold）：
 *   GET {uamApiUri}/v1/user/ms_behavior?sessionId=&sessionType=
 */
export async function loadFoldStates(
  sessions: SessionRef[],
): Promise<Set<string>> {
  const base = uamBase()
  const folded = new Set<string>()
  if (!base) return folded
  const targets = sessions.slice(0, 300)
  let i = 0
  const worker = async () => {
    while (i < targets.length) {
      const s = targets[i]
      i += 1
      try {
        const d = await httpJson<any>(
          base +
            '/v1/user/ms_behavior?sessionId=' +
            encodeURIComponent(s.id) +
            '&sessionType=' +
            (s.type || 1),
        )
        const info = d && d.data ? d.data : null
        if (info && info.isFold) folded.add(s.id)
      } catch {
        /* 单个失败忽略 */
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(6, targets.length) }, worker),
  )
  return folded
}

/** 折叠 / 展开：先由调用方更新本地，再同步服务端，失败抛错回滚。 */
export async function setFold(
  session: SessionRef,
  fold: boolean,
): Promise<void> {
  const base = uamBase()
  if (!base) throw new Error('缺少 uamApiUri')
  await httpJson(base + '/v1/user/ms_behavior', {
    method: fold ? 'POST' : 'DELETE',
    body: {
      sessionId: session.id,
      sessionType: session.type || 1,
      type: 2,
    },
  })
}

/**
 * 免打扰状态（按会话类型分别取，和桌面端一致）：
 *   群   groups/joined        → msgReceiveType
 *   单聊 nodisturbing/list    → msgReceiveMode
 *   组织 organizations/list   → msgReceiveType
 *   服务号 servicenos/authorized → msgReceiveType
 */
export async function loadMuteStates(): Promise<Map<string, boolean>> {
  const muted = new Map<string, boolean>()
  const base = uamBase()
  if (!base) return muted
  try {
    const d = await httpJson<any>(base + '/v1/groups/joined')
    for (const g of normalizeList(d)) {
      if (!g || !g.groupId) continue
      // 免打扰是 msgReceiveType === 1；silentStatus 是「全员禁言」，两回事
      if (Number(g.msgReceiveType) === 1) muted.set(String(g.groupId), true)
    }
  } catch {
    /* 忽略 */
  }
  try {
    const d = await httpJson<any>(base + '/v1/nodisturbing/list')
    for (const it of normalizeList(d)) {
      if (!it || !it.instanceId) continue
      if (it.msgReceiveMode === undefined || Number(it.msgReceiveMode) !== 0) {
        muted.set(String(it.instanceId), true)
      }
    }
  } catch {
    /* 忽略 */
  }
  try {
    const d = await httpJson<any>(base + '/v1/organizations/list')
    for (const o of normalizeList(d)) {
      const id = o && (o.orgId || o.id)
      if (id && Number(o.msgReceiveType) === 1) muted.set(String(id), true)
    }
  } catch {
    /* 忽略 */
  }
  try {
    const sn = String(getServerPaths().serviceNoUri || '').replace(/\/+$/, '')
    if (sn) {
      const d = await httpJson<any>(sn + '/v2/servicenos/authorized')
      for (const a of normalizeList(d)) {
        if (!a || !a.accountId) continue
        if (Number(a.msgReceiveType) === 1) muted.set(String(a.accountId), true)
      }
    }
  } catch {
    /* 忽略 */
  }
  return muted
}

/** 开/关免打扰：不同会话类型走不同接口（官方 set*RemindType）。 */
export async function toggleMute(s: SessionRef): Promise<boolean> {
  const base = uamBase()
  const type = Number(s.type) || 1
  const setting = 1
  if (type === 4) {
    await postForm(
      base + '/v1/organizations/' + encodeURIComponent(s.id) + '/disturbing',
      { orgId: s.id, msgReceiveType: setting },
    )
  } else if (type === 5) {
    const sn = String(getServerPaths().serviceNoUri || '').replace(/\/+$/, '')
    if (!sn) throw new Error('缺少服务号接口地址')
    await postForm(sn + '/' + encodeURIComponent(s.id) + '/notify', {
      serviceId: s.id,
      terminalMsgReceiveType: setting,
    })
  } else if (type === 2) {
    await postForm(base + '/v1/groups/notify', {
      groupId: s.id,
      notifySetting: setting,
    })
  } else {
    await postForm(base + '/v1/nodisturbing/set', {
      instanceId: s.id,
      notifySetting: setting,
    })
  }
  return true
}

/** 取消免打扰：同一批接口，setting 传 0。 */
export async function unmute(s: SessionRef): Promise<boolean> {
  const base = uamBase()
  const type = Number(s.type) || 1
  const setting = 0
  if (type === 4) {
    await postForm(
      base + '/v1/organizations/' + encodeURIComponent(s.id) + '/disturbing',
      { orgId: s.id, msgReceiveType: setting },
    )
  } else if (type === 5) {
    const sn = String(getServerPaths().serviceNoUri || '').replace(/\/+$/, '')
    if (!sn) throw new Error('缺少服务号接口地址')
    await postForm(sn + '/' + encodeURIComponent(s.id) + '/notify', {
      serviceId: s.id,
      terminalMsgReceiveType: setting,
    })
  } else if (type === 2) {
    await postForm(base + '/v1/groups/notify', {
      groupId: s.id,
      notifySetting: setting,
    })
  } else {
    await postForm(base + '/v1/nodisturbing/set', {
      instanceId: s.id,
      notifySetting: setting,
    })
  }
  return true
}

const TEAM_TEMPLATE = 'workGroupDefault'

/** 团队型群判定：群详情里 templateCode 是 workGroupDefault。 */
export async function isTeamGroup(
  s: SessionRef | undefined,
): Promise<boolean> {
  if (!s || Number(s.type) !== 2) return false
  const base = uamBase()
  if (!base) return false
  try {
    const d = await httpJson<any>(
      base + '/v2/groups/' + encodeURIComponent(s.id) + '/details',
    )
    const o = (d && d.data) || d || {}
    let tag = ''
    try {
      tag = JSON.parse(o.extendParams || '{}').tag || ''
    } catch {
      /* 忽略 */
    }
    return o.templateCode === TEAM_TEMPLATE || tag === '团队'
  } catch {
    return false
  }
}