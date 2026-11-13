import { replaceEmojiAliases } from './emoji'

/** 官方 5.2.97 faceArr 的顺序映射，只生成本地受信图片节点。 */
const names = ["微笑", "呲牙", "害羞", "色", "苦笑", "捂脸", "酷", "发怒", "飞吻", "大舌头", "抠鼻", "偷笑", "嘘", "得意", "享受", "生病", "顽皮", "鄙视", "难过", "怒", "惊呆了", "委屈", "流泪", "哭泣", "馋嘴", "疑问", "嘟嘴", "眨眼", "努力", "吐舌", "糟糕", "不爽", "傲慢", "困", "打瞌睡", "不开心", "好吧", "呆", "咧嘴", "恶魔", "晕", "坏笑", "打哈欠", "可怜", "吐", "勾引", "ok", "握手", "抱拳", "点赞", "胜利", "奋斗", "鼓掌", "祈祷", "握拳", "手掌", "no", "爱心", "心碎", "拥抱", "礼花", "玫瑰", "礼物", "奖杯", "红旗", "高铁", "地铁", "单车", "步行", "飞机", "互联网", "公告", "电脑", "电话", "公文包", "钢笔", "满分", "对", "错", "感叹", "警告", "问号", "top", "结束", "向上", "向下", "向左", "向右", "拳头", "不要", "不要不要", "不赞", "吻", "睡觉", "太阳", "便便", "爆筋", "白天", "夜晚", "多云", "彩虹", "下雨", "闪电", "中国", "蛋糕", "炸弹", "邮箱", "刀", "高跟鞋", "唱歌", "钓鱼", "画画", "酒杯", "咖啡", "麻将", "射箭", "足球", "放大镜", "录像", "南瓜", "圣诞老人", "沙漏", "手表", "西瓜", "回形针", "枪", "小狗", "小猪", "音乐", "上", "下", "雪人", "会议"]
const assets = import.meta.glob('../../assets/face/*.png', { eager: true, query: '?url', import: 'default' }) as Record<string, string>
export const OFFICIAL_FACES = names.map((name, index) => ({ name, text: `[${name}]`, url: assets[`../../assets/face/${index}.png`] }))
export function appendFaceText(parent: HTMLElement, text: string): void {
  let start = 0
  for (const match of text.matchAll(/\[([^\]\n]+)\]/g)) {
    const index = names.indexOf(match[1])
    if (index < 0) continue
    parent.appendChild(document.createTextNode(replaceEmojiAliases(text.slice(start, match.index))))
    const img = document.createElement('img')
    img.src = assets[`../../assets/face/${index}.png`]
    img.alt = match[0]
    img.title = match[1]
    img.className = 'official-face'
    img.width = 24
    img.height = 24
    parent.appendChild(img)
    start = match.index + match[0].length
  }
  parent.appendChild(document.createTextNode(replaceEmojiAliases(text.slice(start))))
}
export function faceTextHtml(text: string): string {
  const node = document.createElement('span')
  appendFaceText(node, text)
  return node.innerHTML
}
