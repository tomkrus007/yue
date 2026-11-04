/**
 * IM 内容编解码 + 二进制帧编解码
 * 逆向自 home.js 的 k / I / C 函数
 *
 * 内容"加密"算法：UTF-8 字节 → 按位取反(~) → Base64
 * 帧格式：[header:1][command:1][number:1][operation:1][length:4 BE][payload: UTF-8 JSON]
 */

const enc = new TextEncoder()
const dec = new TextDecoder()

/* ============ Base64 编解码（标准字母表，与原实现一致）============ */
const B64 =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const B64_REV: Record<string, number> = {}
for (let i = 0; i < B64.length; i++) B64_REV[B64[i]] = i

function bytesToB64(bytes: number[] | Uint8Array): string {
  const arr = Array.from(bytes)
  const pad = (3 - (arr.length % 3)) % 3
  for (let i = 0; i < pad; i++) arr.push(0)
  let out = ''
  for (let i = 0; i < arr.length; i += 3) {
    const b0 = arr[i],
      b1 = arr[i + 1],
      b2 = arr[i + 2]
    const triple = (b0 << 16) | (b1 << 8) | b2
    out +=
      B64[(triple >> 18) & 0x3f] +
      B64[(triple >> 12) & 0x3f] +
      B64[(triple >> 6) & 0x3f] +
      B64[triple & 0x3f]
  }
  // 末尾补 '='（与原实现一致：原实现不补 '='，而是 slice 修剪；这里按标准补齐以兼容）
  if (pad === 1) out = out.slice(0, -1) + '='
  else if (pad === 2) out = out.slice(0, -2) + '=='
  return out
}

function b64ToBytes(b64: string): number[] {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, '')
  const out: number[] = []
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = B64_REV[clean[i]] ?? 0
    const c1 = B64_REV[clean[i + 1]] ?? 0
    const c2 = B64_REV[clean[i + 2]] ?? 0
    const c3 = B64_REV[clean[i + 3]] ?? 0
    const triple = (c0 << 18) | (c1 << 12) | (c2 << 6) | c3
    out.push((triple >> 16) & 0xff, (triple >> 8) & 0xff, triple & 0xff)
  }
  // 修剪 padding
  const pad = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return out.slice(0, out.length - pad)
}

/* ============ content 取反编解码（k / I）============ */

/** 编码 content：UTF-8 → 取反 → Base64 */
export function encryptContent(str: string): string {
  if (!str) return ''
  const bytes = Array.from(enc.encode(str))
  for (let i = 0; i < bytes.length; i++) bytes[i] = (~bytes[i]) & 0xff
  return bytesToB64(bytes)
}

/** 解码 content：Base64 → 取反 → UTF-8 */
export function decryptContent(b64: string): string {
  if (!b64 || b64.length > 102400) return ''
  const bytes = b64ToBytes(b64)
  for (let i = 0; i < bytes.length; i++) bytes[i] = (~bytes[i]) & 0xff
  return dec.decode(new Uint8Array(bytes))
}

/* ============ 二进制帧编解码（C / parseFrame）============ */

/** 默认 header */
export const FRAME_HEADER = 5

export interface ImFrame {
  header: number
  command: number
  /** 原实现 byte[2]，命名混淆为 operation */
  number: number
  /** 原实现 byte[3]，命名混淆为 number；=0 表示无负载 */
  operation: number
  length: number
  /** 已解析的 JSON 对象（operation != 0 时） */
  data?: any
}

/**
 * 编码帧。对应原 C(command, operation, data, s=5, o=0)
 * @param command 命令码
 * @param operation 1=有负载, 0=无负载（心跳）
 * @param data 负载对象（会被 JSON.stringify，content 字段会被 encryptContent 编码）
 * @param header 默认 5
 * @param number 默认 0
 */
export function encodeFrame(
  command: number,
  operation: number = 1,
  data?: any,
  header: number = FRAME_HEADER,
  number: number = 0,
): Uint8Array {
  let payloadBytes: number[] = []
  if (operation !== 0 && data !== undefined) {
    const obj = typeof data === 'string' ? JSON.parse(data) : { ...data }
    // content 字段编码：对象则 JSON.stringify 后编码；字符串直接编码
    if (obj && Object.prototype.hasOwnProperty.call(obj, 'content')) {
      const c = obj.content
      obj.content = encryptContent(
        typeof c === 'object' ? JSON.stringify(c) : String(c ?? ''),
      )
    }
    payloadBytes = Array.from(enc.encode(JSON.stringify(obj)))
  }
  const len = payloadBytes.length
  const frame: number[] = [
    header,
    command,
    number,
    operation,
    (len >>> 24) & 0xff,
    (len >>> 16) & 0xff,
    (len >>> 8) & 0xff,
    len & 0xff,
    ...payloadBytes,
  ]
  return new Uint8Array(frame)
}

/** 解码帧（从 ArrayBuffer）
 *
 * 原版解码器（home.js）：
 *   t.operation = e[2]; t.number = e[3];
 *   if (!t.number) return t;        // 判断的是字节 3（有负载=1，心跳=0）
 *
 * 注意：原版命名把字节 2/3 叫反了。真实语义：
 *   byte0 header, byte1 command, byte2 number(恒0), byte3 operation(1=有负载)
 * 有负载的判定依据是 byte3，不是 byte2。
 */
export function decodeFrame(buf: ArrayBuffer): ImFrame {
  const bytes = new Uint8Array(buf)
  const f: ImFrame = {
    header: bytes[0],
    command: bytes[1],
    number: bytes[2],
    operation: bytes[3],
    length: 0,
  }
  if (!bytes[3]) return f // byte3=0 表示无负载（心跳/纯控制帧）
  // length: bytes[4..8] big-endian
  f.length = (bytes[4] << 24) | (bytes[5] << 16) | (bytes[6] << 8) | bytes[7]
  if (!f.length) return f
  const jsonStr = dec.decode(bytes.subarray(8, 8 + f.length))
  try {
    f.data = JSON.parse(jsonStr)
  } catch {
    f.data = { __raw: jsonStr }
  }
  return f
}
