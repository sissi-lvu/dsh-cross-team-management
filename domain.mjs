/**
 * cross-team-management — 跨团队管理（控制层插件）
 *
 * 不存业务数据、不发消息：只做「扫描共享目录 → 过滤流水账 → 维护台账 → 按意图组装上下文」。
 * 数据源是本地/内网共享目录；交付物是可直接注入模型上下文的文本，附带给领导的建议。
 *
 * 六个动作对应 view：
 *   overview  全景概览 + 自动催办 + 处理建议
 *   detail    单点下钻（target=团队）
 *   draft     决策分派：按团队生成沟通草稿（target + instruction）
 *   digest    全局通报：脱敏高光，屏蔽卡点
 *   escalate  逾期升级函（target）
 *   updates   事件流水：补交 / 新增红灯 / 催办 / 通报，未读即推送
 *
 * 事件来源：fs.watch 监听目录 + 内部定时轮询（截止、升级、周五通报）。
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, watch, writeFileSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { inflateRawSync } from 'node:zlib'

const DOC_EXT = new Set(['.docx', '.pptx', '.doc', '.ppt', '.md', '.txt'])
const WATCHED_DIR = /^_/ // 下划线开头的目录（如 _dispatch）不算团队

const SETUP_HINT =
  '还没有配置好：把同目录的 config.example.json 复制成 config.json，填 rootDir（共享目录绝对路径）、teams[].id（必须等于子目录名）和 deadline，然后重新调用一次即可。'

const STATUS = {
  missing: { icon: '📭', label: '未提交', rank: 0 },
  green: { icon: '✅', label: '正常', rank: 1 },
  yellow: { icon: '⚠️', label: '风险', rank: 2 },
  red: { icon: '🚨', label: '需介入', rank: 3 },
}

// ── 文本判定：什么算卡点，什么算流水账 ─────────────────────────────────────
// 解析器版本号：判定逻辑一变就 +1，强制所有团队重新解析（否则会被 analysisKey 缓存住）
const PARSE_VERSION = 2
const RED_STRONG = /(停滞|跌破|事故|阻断|停摆|亏损|失败|卡死|中断|无法交付)/
const DECISION = /(预算|审批|签批|批准|批复|追加|授权|人力|编制|资源|排期|支持)/
const RISK_HINT = /(风险|超时|兼容|待|依赖|缺口|阻塞|未达标|黑盒|拉齐|评估|延期|未解决|下跌|下滑|流失|未恢复|异常|低于|延迟|不足|卡点)/
const DONE_HINT = /(完成|达标|通过|覆盖|修复|上线|恢复|推进|保障|顺利)/
const PLAN_HINT = /^(下周|下一步|后续|接下来|计划)/
const NEGATION = /无(严重)?(阻塞|风险|异常|问题)/g

/** 按句切分。标签前缀（「卡点：」等）留给 analyze 判断，不在这里吃掉。 */
function sentences(text) {
  return String(text)
    .split(/[。！？!?；;\n]+|(?<=[，,])\s*(?=(?:卡点|风险|下一步|下周)[:：])/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 4)
}

/** 去掉括号里的举例（Bug 名单、工具名），避免「上传失败」被当成业务失败。 */
function stripParens(text) {
  return String(text)
    .replace(/（[^）]*）|\([^)]*\)/g, ' ')
    .replace(/\s+([，,。；;：:])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 一个分句的危险等级：需介入 / 风险 / 正常。 */
function levelOf(text) {
  const t = stripParens(text).replace(NEGATION, '')
  if (RED_STRONG.test(t)) return 'red'
  if (DECISION.test(t) && /(停滞|卡在|卡住|未批|待批|缺|没有批)/.test(t)) return 'red'
  if (RISK_HINT.test(t)) return 'yellow'
  if (DECISION.test(t) && /(追加|申请|需要|需|未|待)/.test(t)) return 'yellow'
  return 'green'
}

/** 取一句话里最像「诉求」和「当前状态」的两个分句。 */
function splitNeedState(text) {
  const clauses = String(text).split(/[，,]/).map((c) => c.trim()).filter(Boolean)
  const needIndex = clauses.findIndex((c) => /(预算|诉求|申请|追加|需要|支持|人力|资源)/.test(c))
  if (needIndex < 0) return { need: '', state: clauses.join('，') }
  const rest = clauses.filter((_, index) => index !== needIndex)
  return { need: clauses[needIndex], state: rest.length > 0 ? rest.join('，') : clauses[needIndex] }
}

/**
 * 结构化解析：句子 → 分句。
 * 一句里常同时有进展和卡点（「完成灰度 30%，卡在财务审批」），按分句拆开才不会张冠李戴。
 */
function analyze(text) {
  const list = sentences(text)
  const blockers = []
  const progress = []
  const plans = []
  let level = 'green'
  for (const line of list) {
    if (PLAN_HINT.test(line)) {
      // 「下周计划」不是卡点，也不是本周进展，单独收起来给「计划」用
      const plan = stripParens(line).replace(/^(?:下周计划|下一步|后续|接下来|计划)[:：]?\s*/, '').trim()
      if (plan.length >= 3) plans.push(plan)
      continue
    }
    // 「卡点：」「风险：」是人工声明，不能只靠词表判断，否则整段会被当成本周进展
    const labeled = /^(?:卡点|风险|问题|诉求)[:：]/.test(line)
    const clean = stripParens(line)
    const clauses = clean
      .split(/[，,]/)
      .map((c) => c.replace(/^(?:卡点|风险|问题|诉求|当前状态)[:：]\s*/, '').trim())
      .filter((c) => c.length >= 3)
    if (clauses.length === 0) continue
    const risky = []
    const done = []
    let lineLevel = 'green'
    for (const clause of clauses) {
      const base = levelOf(clause)
      const clauseLevel = labeled && base === 'green' ? 'yellow' : base
      if (clauseLevel === 'red' || clauseLevel === 'yellow') {
        risky.push(clause)
        if (STATUS[clauseLevel].rank > STATUS[lineLevel].rank) lineLevel = clauseLevel
      } else if (DONE_HINT.test(clause)) {
        done.push(clause)
      }
    }
    if (risky.length > 0) {
      // 卡点写「诉求 + 风险分句」，保持原文顺序；同句里的进展仍然记进 progress
      const kept = clauses.filter((c) => risky.includes(c) || DECISION.test(c))
      blockers.push({ level: lineLevel, text: kept.join('，') || line })
      if (STATUS[lineLevel].rank > STATUS[level].rank) level = lineLevel
      if (done.length > 0) progress.push(done.join('，'))
    } else {
      // 没有风险的句子就是本周进展：整句保留，别把「执行用例 150 个」这类数字丢掉
      if (!/周报$/.test(clean)) progress.push(clean)
    }
  }
  return { blockers, progress, plans, level }
}

function ensurePeriod(text) {
  const t = String(text).trim()
  return /[。！？；]$/.test(t) ? t : `${t}。`
}

/** 按分句裁剪，避免把「重构了后…」这种半句话塞进全员通报。 */
function clipClause(text, max) {
  const clauses = String(text).split(/[，,]/).map((c) => c.trim()).filter(Boolean)
  let out = ''
  for (const clause of clauses) {
    const next = out === '' ? clause : `${out}，${clause}`
    if (out !== '' && next.length > max) break
    out = next
  }
  return out === '' ? trimTo(clauses[0] || text, max) : out
}

function trimTo(text, max) {
  const t = String(text).trim()
  return t.length <= max ? t : `${t.slice(0, max - 1)}…`
}

function pad(n) {
  return String(n).padStart(2, '0')
}

/** 本地时间：MM-dd HH:mm */
function fmtTime(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return '—'
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** 相对小时数，保留一位。 */
function hoursBetween(fromIso, nowIso) {
  const from = new Date(fromIso).getTime()
  const to = new Date(nowIso).getTime()
  if (!Number.isFinite(from) || !Number.isFinite(to)) return 0
  return Math.round(((to - from) / 3600000) * 10) / 10
}

// ── OOXML 文本抽取（纯 Node，无依赖）──────────────────────────────────────
function zipEntries(buf) {
  let eocd = -1
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error('不是有效的 zip/OOXML 文件')
  const count = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const map = new Map()
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break
    const method = buf.readUInt16LE(p + 10)
    const compSize = buf.readUInt32LE(p + 20)
    const nameLen = buf.readUInt16LE(p + 28)
    const extraLen = buf.readUInt16LE(p + 30)
    const commentLen = buf.readUInt16LE(p + 32)
    const localOff = buf.readUInt32LE(p + 42)
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen)
    map.set(name, { method, compSize, localOff })
    p += 46 + nameLen + extraLen + commentLen
  }
  return map
}

function readZipEntry(buf, entry) {
  const off = entry.localOff
  if (buf.readUInt32LE(off) !== 0x04034b50) throw new Error('zip 局部头损坏')
  const nameLen = buf.readUInt16LE(off + 26)
  const extraLen = buf.readUInt16LE(off + 28)
  const start = off + 30 + nameLen + extraLen
  const data = buf.subarray(start, start + entry.compSize)
  return entry.method === 0 ? data : inflateRawSync(data)
}

function xmlToText(xml) {
  return String(xml)
    .replace(/<a:br\s*\/>/g, '\n')
    .replace(/<w:br\s*\/>/g, '\n')
    .replace(/<w:tab\s*\/>/g, ' ')
    .replace(/<\/w:p>/g, '\n')
    .replace(/<\/a:p>/g, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .replace(/\n{2,}/g, '\n')
}

/** 从 docx / pptx 里抽正文；doc / ppt 旧格式只登记不解析。 */
function extractText(file) {
  const ext = extname(file).toLowerCase()
  if (ext === '.md' || ext === '.txt') return readFileSync(file, 'utf8')
  if (ext === '.doc' || ext === '.ppt') return ''
  const buf = readFileSync(file)
  const entries = zipEntries(buf)
  const names = [...entries.keys()]
  const parts = []
  if (ext === '.docx') {
    for (const name of names) {
      if (/^word\/(document|header\d*|footer\d*)\.xml$/.test(name)) parts.push(xmlToText(readZipEntry(buf, entries.get(name)).toString('utf8')))
    }
  } else {
    const slides = names
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((a, b) => Number(a.match(/slide(\d+)/)[1]) - Number(b.match(/slide(\d+)/)[1]))
    for (const name of slides) parts.push(xmlToText(readZipEntry(buf, entries.get(name)).toString('utf8')))
  }
  return parts.join('\n')
}

// ── 建议与话术模板 ────────────────────────────────────────────────────────
function redAdvice(team) {
  const text = team.blocker ?? ''
  if (/预算|审批|财务|签批/.test(text)) return `建议致电财务总监，特批${team.name}预算。`
  if (/转化率|渠道|跌破|投放/.test(text)) return `建议立即拉取${team.name}详细数据报表，评估是否调整下半月投放预算。`
  if (/事故|停摆|阻断/.test(text)) return `建议今天内拉齐${team.name}负责人，明确止损动作与责任人。`
  return `建议要求${team.name}负责人今天就卡点给出处理方案与时间表。`
}

function yellowAdvice(team) {
  const text = team.blocker ?? ''
  if (/网关|接口|兼容/.test(text)) return `建议在研发周会上要求${team.name}给出备用方案时间表。`
  if (/超时|延期|未解决/.test(text)) return `建议要求${team.name}明确最晚解决时间，并同步影响范围。`
  return `建议在下次周会上跟进${team.name}的风险项，要求给出解决时间。`
}

function adviceFor(team) {
  if (team.status === 'missing') {
    return team.escalated
      ? `建议将${team.name}逾期未交一事上报运营总监，或发起15分钟强制对齐会。`
      : `已自动催办${team.name}；今日截止仍未交，建议直接电话其负责人。`
  }
  if (team.level === 'red') return redAdvice(team)
  if (team.level === 'yellow') return yellowAdvice(team)
  return ''
}

/**
 * 决策分派不产出成句话术：控制层只给「对象 / 事实 / 决定 / 要求 / 截止 / 语气」，
 * 措辞交给模型。模板句会让所有场合听起来一样，也会把模型变成复读机。
 */
function draftFacts(team, instruction) {
  const approved = /同意|批准|批了|批给|放行/.test(instruction)
  const lines = [`【拟稿要素 · ${team.name}】`, `对象：${team.name}负责人`]
  if (team.status === 'missing') {
    lines.push(`事实：本周周报未在共享目录中检索到${team.hoursOverdue > 0 ? `，已逾期 ${Math.round(team.hoursOverdue)} 小时` : ''}；至今催办 ${team.reminderCount || 1} 次`)
    lines.push('要求动作：今日下班前上传；如有特殊情况，直接说明原因与预计时间')
    lines.push('截止要求：今日下班前')
    lines.push('语气：就事论事、留出说明的口子，不追责')
    return lines.join('\n')
  }
  lines.push(`事实：${team.blocker || '本周无卡点'}（来源：${team.file}）`)
  if (/预算|拉新|投放/.test(team.blocker)) {
    lines.push(`你的决定：${approved ? '预算已批' : '指令里没有明确批或不批 —— 先别写「已批」，需要向用户确认'}`)
    lines.push('要求动作：立即重启拉新，周五前回报数据结果')
    lines.push('截止要求：周五前')
    lines.push('语气：肯定、干脆，不讨论审批过程')
  } else if (/网关|接口|兼容|重构/.test(team.blocker)) {
    lines.push('你的决定：无（只要求对方给时间点）')
    lines.push('要求动作：明确最晚解决时间；如无法按期，立即提交备用方案')
    lines.push('截止要求：对方自报的时间点（原文：下周三前）')
    lines.push('语气：直接要结果，不接「正在处理」这类答复')
  } else if (/转化率|渠道|跌破/.test(team.blocker)) {
    lines.push('你的决定：要求今晚给出结论')
    lines.push('要求动作：给出下滑原因、分渠道数据、恢复计划')
    lines.push('截止要求：今晚给原因，明早给数字')
    lines.push('语气：紧急但不指责，强调时间')
  } else if (team.level === 'green') {
    lines.push('你的决定：无（保持节奏）')
    lines.push('要求动作：按计划推进，有风险提前说')
    lines.push('截止要求：下周同一时间前')
    lines.push('语气：简短正向，不铺表扬')
  } else {
    lines.push('你的决定：无')
    lines.push('要求动作：把卡点拆成「责任人 + 最晚解决时间 + 备用方案」三条')
    lines.push('截止要求：今天回复')
    lines.push('语气：克制、明确')
  }
  return lines.join('\n')
}

function digestOf(board, cfg) {
  const parts = []
  const topics = []
  for (const team of board.teams) {
    if (team.status === 'missing') {
      parts.push(`${team.name}：本周未提交，已单独跟进补交。`)
      continue
    }
    const highlight = team.progress[0] ? clipClause(team.progress[0].replace(/^本周/, ''), 48) : '按计划推进'
    if (team.level === 'red' || team.level === 'yellow') {
      parts.push(`${team.name}${highlight}；相关风险已转入专项跟进。`)
      const topic = /预算|拉新|投放/.test(team.blocker) ? '拉新' : /网关|接口|支付/.test(team.blocker) ? '支付接口' : /转化率|渠道/.test(team.blocker) ? '渠道转化' : ''
      if (topic) topics.push(topic)
    } else {
      parts.push(`${team.name}${highlight}。`)
    }
  }
  const focus = [...new Set(topics)].slice(0, 2).join('与')
  const tail = focus ? `下周重点：${focus}。` : '下周重点：按既定节奏推进。'
  const body = parts.join('').replace(/。{2,}/g, '。')
  return `[全员通报] 本周${body}${tail}\n【给领导的建议】：可直接作为本周总结发送全员，鼓舞士气。`
}

function escalationText(team, hours) {
  const focus = team.focus ? `${team.name}本周负责${team.focus}，` : ''
  return `[逾期预警] ${team.name}超过${hours}小时未交周报，且无回复。\n【给领导的建议】：${focus}建议将此事上报运营总监，或发起15分钟强制对齐会。`
}

/** 邮件正文的规则兜底：模型没写正文时才用，措辞刻意朴素。 */
function feedbackMailBody(team, cfg) {
  const fact = team.blocker || '本周未见卡点'
  const ask =
    team.status === 'missing'
      ? '请于今日下班前把周报上传到共享目录；如有特殊情况，直接说明原因与预计时间。'
      : /停滞|审批|财务|卡在/.test(fact)
        ? '请把 OA 单号发我，我同步财务加急；你们先把重启拉新的准备做好，批下来当天就能跑。'
        : /网关|接口|兼容|重构/.test(fact)
          ? '请明确最晚解决时间；如无法按期，立即提交备用方案。'
          : /转化率|渠道|跌破/.test(fact)
            ? '请今晚给出下滑原因与分渠道数据，明早给出恢复计划。'
            : /预算|拉新|投放/.test(fact)
              ? '请按计划推进，周五前回报数据结果。'
              : '请把卡点拆成「责任人 + 最晚解决时间 + 备用方案」三条回复。'

  // 截止时间已经过去了就别再写进信里，避免给团队一个过期的时间点
  const deadlineDate = cfg.deadline ? new Date(cfg.deadline) : null
  const deadlineLine = deadlineDate && !Number.isNaN(deadlineDate.getTime()) && deadlineDate.getTime() > Date.now()
    ? `本周截止：${cfg.deadline.replace('T', ' ').slice(0, 16)}。`
    : ''

  const parts = [`${team.name} 负责人：`, '', `本周从共享目录看到的事实：${fact}。`, '', ask]
  if (deadlineLine) parts.push(deadlineLine)
  // 签名可选：默认不签，免得每封信都带插件名
  if (cfg.email.signature) parts.push('', cfg.email.signature)
  return parts.join('\n').trim()
}

function buildEml({ from, fromName, to, subject, body, date }) {
  const encode = (text) => `=?UTF-8?B?${Buffer.from(String(text), 'utf8').toString('base64')}?=`
  const bodyBase64 = Buffer.from(String(body), 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n')
  const fromHeader = from ? (fromName ? `${encode(fromName)} <${from}>` : from) : 'noreply@localhost'
  return [
    `From: ${fromHeader}`,
    `To: ${to}`,
    `Subject: ${encode(subject)}`,
    `Date: ${new Date(date).toUTCString()}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    `${bodyBase64}\r\n`,
  ].join('\r\n')
}

function reminderText(team, cfg, now, deadline) {
  const sameDay = deadline && new Date(deadline).toDateString() === new Date(now).toDateString()
  const when = sameDay ? '今日下班前' : deadline ? `${fmtTime(deadline)} 前` : '今日下班前'
  return `${team.name}，本周周报未在共享目录中检索到，请于${when}上传。如有特殊情况，请直接回复原因。`
}

// ── 插件主体 ──────────────────────────────────────────────────────────────
export const inject = ['tools']

export function apply(ctx, config = {}, api) {
  // 共享目录/团队表放在源码同级的 config.json：改完下一次扫描自动生效，不必重挂载。
  const sourceDir = dirname(fileURLToPath(import.meta.url))
  const configFile = join(sourceDir, 'config.json')
  let cfg = readConfig()
  let configStamp = stampOf(configFile)
  let closeWatch = () => {}
  let promptRegistered = false
  const ledgerPath = api.dataFile('ledger.json')
  const state = loadLedger()

  function stampOf(file) {
    try {
      const info = statSync(file)
      return `${info.mtimeMs}:${info.size}`
    } catch {
      return 'missing'
    }
  }

  /** evolve 挂载时给的 config 打底，config.json 覆盖。 */
  function readConfig() {
    const base = { ...config }
    try {
      if (existsSync(configFile)) Object.assign(base, JSON.parse(readFileSync(configFile, 'utf8')))
    } catch (error) {
      api.log(`cross-team-management: config.json 解析失败，沿用挂载配置（${String(error)}）`)
    }
    return normalizeConfig(base)
  }

  /** 每轮扫描前检查配置是否被改过；目录变了就重挂监听。 */
  function reloadIfChanged() {
    const stamp = stampOf(configFile)
    if (stamp === configStamp) return
    configStamp = stamp
    const previousRoot = cfg.rootDir
    const previousWatch = cfg.watch
    cfg = readConfig()
    api.log(`cross-team-management: 已重载 config.json（${cfg.rootDir}，${cfg.teams.length} 个团队）`)
    if (cfg.rootDir !== previousRoot || cfg.watch !== previousWatch) startWatch()
  }

  function loadLedger() {
    const empty = { version: 1, createdAt: new Date().toISOString(), teams: {}, events: [], outbox: [], lastDigest: null, lastTick: null }
    const raw = api.readJson(ledgerPath, null)
    if (!raw || typeof raw !== 'object') return empty
    return {
      ...empty,
      ...raw,
      teams: raw.teams && typeof raw.teams === 'object' ? raw.teams : {},
      events: Array.isArray(raw.events) ? raw.events : [],
      outbox: Array.isArray(raw.outbox) ? raw.outbox : [],
    }
  }

  let dirty = false
  function save() {
    if (!dirty) return
    api.writeJson(ledgerPath, state)
    dirty = false
  }

  function teamState(id) {
    if (!state.teams[id]) state.teams[id] = { id, firstEmptyAt: null, firstSeenAt: null, reminders: [], escalatedAt: null, analysis: null, file: null, digestAt: null }
    return state.teams[id]
  }

  function pushEvent(type, teamId, text, at) {
    const day = String(at).slice(0, 10)
    const duplicate = state.events.some((event) => event.type === type && event.teamId === teamId && String(event.at).slice(0, 10) === day)
    if (duplicate) return false
    state.events.push({ at, type, teamId, text, read: false })
    dirty = true
    return true
  }

  /** 催办/升级函按「日期 + 团队 + 类型」命名：同一天只存在一份，重复触发直接复用。 */
  function dispatchFile(team, kind, at) {
    return join(cfg.rootDir, '_dispatch', `${String(at).slice(0, 10)}-${team.id}-${kind}.md`)
  }

  function dispatchTo(team, text, kind, at) {
    state.outbox.push({ at, teamId: team.id, kind, text })
    dirty = true
    if (!cfg.writeOutbox || !existsSync(cfg.rootDir)) return null
    const dir = join(cfg.rootDir, '_dispatch')
    try {
      mkdirSync(dir, { recursive: true })
      const file = join(dir, `${String(at).slice(0, 10)}-${team.id}-${kind}.md`)
      writeFileSync(file, `# ${team.name} · ${kind === 'reminder' ? '催办' : kind === 'escalate' ? '逾期升级' : '通知'}\n\n- 时间：${fmtTime(at)}\n- 送达：${team.id}\n\n${text}\n`, 'utf8')
      return file
    } catch (error) {
      api.log(`cross-team-management: 写入 outbox 失败 ${String(error)}`)
      return null
    }
  }

  /** 扫描目录 + 解析变化 + 生成事件。返回当前大盘。 */
  let lastBoardFull = null

  function refresh(nowIso, options = {}) {
    reloadIfChanged()
    const now = nowIso || new Date().toISOString()
    if (!cfg.rootDir) return { at: now, teams: [], counts: { red: 0, yellow: 0, green: 0, missing: 0 } }
    const board = { at: now, teams: [], counts: { red: 0, yellow: 0, green: 0, missing: 0 } }
    const deadline = cfg.deadline || null
    let changed = false

    for (const team of cfg.teams) {
      const st = teamState(team.id)
      const dir = join(cfg.rootDir, team.id)
      let files = []
      try {
        files = existsSync(dir)
          ? readdirSync(dir).filter((name) => !name.startsWith('.') && !name.startsWith('~$') && DOC_EXT.has(extname(name).toLowerCase()))
          : []
      } catch {
        files = []
      }
      const item = { id: team.id, name: team.name, focus: team.focus || '', email: team.email || '', status: 'missing', level: 'green', blocker: '', progress: [], plans: [], file: null, submittedAt: null, analysis: null }

      if (files.length === 0) {
        if (!st.firstEmptyAt) {
          st.firstEmptyAt = now
          dirty = true
        }
        st.file = null
        st.analysis = null
        // 自动催办：同一团队同一天只发一次
        const today = now.slice(0, 10)
        const remindedToday =
          st.reminders.some((r) => r.slice(0, 10) === today) || (existsSync(cfg.rootDir) && existsSync(dispatchFile(team, 'reminder', now)))
        if (cfg.autoRemind && !remindedToday) {
          const text = reminderText(team, cfg, now, deadline)
          const file = dispatchTo(team, text, 'reminder', now)
          st.reminders.push(now)
          item.reminder = { text, at: now, file, fresh: true }
          pushEvent('remind', team.id, `已向${team.name}发送催办`, now)
          changed = true
        } else if (remindedToday) {
          // 台账被重置过、但今天的催办函还在：用文件时间兜底，别显示「—」
          let last = st.reminders[st.reminders.length - 1]
          if (!last && existsSync(cfg.rootDir)) {
            const file = dispatchFile(team, 'reminder', now)
            if (existsSync(file)) last = new Date(statSync(file).mtimeMs).toISOString()
          }
          item.reminder = { text: reminderText(team, cfg, now, deadline), at: last || now, fresh: false }
        }
        // 逾期升级：首次催办后超过 escalateHours
        const anchor = st.reminders[0] || st.firstEmptyAt
        const overdue = anchor ? hoursBetween(anchor, now) : 0
        const escalatedToday = Boolean(st.escalatedAt) || (existsSync(cfg.rootDir) && existsSync(dispatchFile(team, 'escalate', now)))
        if (cfg.autoEscalate && anchor && overdue >= cfg.escalateHours && !escalatedToday) {
          st.escalatedAt = now
          dispatchTo(team, escalationText(team, Math.round(overdue)), 'escalate', now)
          pushEvent('escalate', team.id, `${team.name}已逾期 ${Math.round(overdue)} 小时未交，已生成升级函`, now)
          changed = true
        }
        st.seenAt = st.seenAt || now
        item.status = 'missing'
        item.hoursOverdue = overdue
        item.escalated = Boolean(st.escalatedAt)
        item.reminderCount = st.reminders.length
        board.counts.missing += 1
        board.teams.push(item)
        continue
      }

      // 取最新文件
      const statOf = (name) => {
        try {
          return statSync(join(dir, name))
        } catch {
          return null
        }
      }
      const ranked = files
        .map((name) => ({ name, stat: statOf(name) }))
        .filter((entry) => entry.stat)
        .sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs)
      const current = ranked[0]
      const key = `${PARSE_VERSION}|${current.name}|${current.stat.mtimeMs}|${current.stat.size}`
      const firstScan = !st.seenAt
      const wasMissing = st.file === null
      st.file = current.name
      item.file = current.name
      item.submittedAt = new Date(current.stat.mtimeMs).toISOString()

      // analysis 丢了（历史状态写坏）也必须重解析，否则会兜底成绿灯
      if (!st.analysis || st.analysisKey !== key) {
        try {
          const text = extractText(join(dir, current.name))
          const parsed = analyze(text)
          st.analysis = { ...parsed, raw: trimTo(text.replace(/\s+/g, ' '), 600), parsedAt: now }
          st.analysisKey = key
          dirty = true
          changed = true
          if (!firstScan) {
            if (wasMissing) {
              pushEvent('submit', team.id, `${team.name}补交了周报（${current.name}）`, now)
              st.firstEmptyAt = null
              st.escalatedAt = null
            } else {
              pushEvent('update', team.id, `${team.name}更新了周报（${current.name}）`, now)
            }
            if (parsed.level === 'red' && st.lastLevel !== 'red') {
              const head = parsed.blockers.find((b) => b.level === 'red') || parsed.blockers[0]
              pushEvent('red', team.id, `${team.name}新增红灯：${trimTo(head ? head.text : '未识别到卡点', 60)}`, now)
            }
          }
          st.lastLevel = parsed.level
        } catch (error) {
          st.analysis = { blockers: [], progress: [], level: 'yellow', raw: `解析失败：${String(error).slice(0, 120)}`, parsedAt: now }
          st.analysisKey = key
          dirty = true
          pushEvent('update', team.id, `${team.name}的 ${current.name} 无法解析：${String(error).slice(0, 80)}`, now)
        }
      }

      const parsed = st.analysis ?? { blockers: [], progress: [], level: 'yellow' }
      item.analysis = parsed
      item.progress = parsed.progress
      item.plans = parsed.plans || []
      item.level = parsed.level
      item.status = parsed.level === 'red' ? 'red' : parsed.level === 'yellow' ? 'yellow' : 'green'
      // 展示用卡点取等级最高的一条，别让同段里较轻的分句把红灯盖住
      const topBlocker = [...(parsed.blockers || [])].sort((a, b) => (STATUS[b.level]?.rank ?? 0) - (STATUS[a.level]?.rank ?? 0))[0]
      item.blocker = topBlocker ? trimTo(topBlocker.text, 90) : ''
      item.blockers = parsed.blockers
      st.seenAt = st.seenAt || now
      board.counts[item.status] += 1
      board.teams.push(item)
    }

    state.lastBoard = summarize(board)
    lastBoardFull = board
    publishPanel(board)
    if (changed) dirty = true
    save()
    return board
  }

  /** 面板快照：只给状态与卡点摘要，不含原文，供 Web 侧轮询。 */
  function publishPanel(board) {
    try {
      api.publishBoard?.({
        at: board.at,
        label: cfg.label,
        rootDir: cfg.rootDir,
        counts: board.counts,
        teams: board.teams.map((team) => ({
          id: team.id,
          name: team.name,
          status: team.status,
          level: team.level,
          blocker: team.blocker,
          file: team.file,
          escalated: Boolean(team.escalated),
          hoursOverdue: team.hoursOverdue || 0,
          reminderAt: team.reminder ? team.reminder.at : null,
        })),
        events: state.events.slice(-20).map((event) => ({ at: event.at, type: event.type, text: event.text, read: Boolean(event.read) })),
        unreadCount: state.events.filter((event) => !event.read).length,
        lastDigestAt: state.lastDigest ? state.lastDigest.at : null,
      })
    } catch (error) {
      api.log(`cross-team-management: 面板快照发布失败 ${String(error)}`)
    }
  }

  function summarize(board) {
    return {
      at: board.at,
      counts: board.counts,
      teams: board.teams.map((t) => ({ id: t.id, name: t.name, status: t.status, level: t.level, file: t.file, blocker: t.blocker })),
    }
  }

  // ── 定时与监听 ──────────────────────────────────────────────────────────
  function tick(nowIso) {
    const now = nowIso || new Date().toISOString()
    const board = refresh(now)
    const actions = []
    // 周五 17:00 全局通报
    const d = new Date(now)
    const dueDigest = d.getDay() === cfg.digest.weekday && d.getHours() === cfg.digest.hour && d.getMinutes() < cfg.tickSeconds / 60 + 1
    const sentThisWeek = state.lastDigest && weekKey(state.lastDigest.at) === weekKey(now)
    if (cfg.autoDigest && dueDigest && !sentThisWeek) {
      actions.push(generateDigest(board, now, { scheduled: true }))
    }
    state.lastTick = now
    dirty = true
    save()
    return { board, actions }
  }

  function weekKey(iso) {
    const d = new Date(iso)
    const thursday = new Date(d)
    thursday.setHours(0, 0, 0, 0)
    thursday.setDate(thursday.getDate() + 4 - (thursday.getDay() || 7))
    const yearStart = new Date(thursday.getFullYear(), 0, 1)
    const week = Math.ceil(((thursday - yearStart) / 86400000 + 1) / 7)
    return `${thursday.getFullYear()}-W${pad(week)}`
  }

  function promptText() {
    try {
      if (!cfg.rootDir) return '## 跨团队管理\n未配置：填写 config.json 的 rootDir / teams / deadline 后生效。'
      const board = refresh(new Date().toISOString())
      const { counts } = board
      const missing = board.teams.filter((t) => t.status === 'missing')
      const unread = state.events.filter((e) => !e.read)
      if (board.teams.length === 0) return ''
      const lines = [`## 跨团队管理（${cfg.label}）`, `共享目录：${cfg.rootDir}`]
      lines.push(`大盘：红灯${counts.red} · 黄灯${counts.yellow} · 绿灯${counts.green} · 未交${counts.missing}`)
      if (missing.length > 0) lines.push(`未交：${missing.map((t) => `${t.name}${t.escalated ? '（已逾期）' : ''}`).join('、')}`)
      const red = board.teams.filter((t) => t.status === 'red')
      if (red.length > 0) lines.push(`需介入：${red.slice(0, 2).map((t) => `${t.name}（${trimTo(String(t.blocker).split(/[，,]/)[0], 24)}）`).join('；')}`)
      if (cfg.email.enabled) {
        const withMail = cfg.teams.filter((team) => team.email).length
        const parts = [`团队收件人 ${withMail}/${cfg.teams.length}`]
        if (cfg.email.digestTo.length > 0) parts.push(`通报收件人 ${cfg.email.digestTo.length}`)
        lines.push(`邮件：${parts.join(' · ')}`)
      }
      if (unread.length > 0) lines.push(`未读事件 ${unread.length} 条：${trimTo(unread.slice(-2).map((e) => e.text).join('；'), 120)}`)
      lines.push('需要时调用 weekly_context(view=overview|detail|draft|digest|escalate|updates)。')
      return lines.join('\n')
    } catch (error) {
      api.log(`cross-team-management: prompt 组装失败 ${String(error)}`)
      return ''
    }
  }

  // 监听目录：补交/更新立即刷新（换目录时重挂）
  function startWatch() {
    closeWatch()
    closeWatch = () => {}
    if (!cfg.rootDir || cfg.watch === false || !existsSync(cfg.rootDir)) return
    let timer = null
    try {
      const watcher = watch(cfg.rootDir, { recursive: true }, () => {
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
          try {
            refresh(new Date().toISOString())
          } catch (error) {
            api.log(`cross-team-management: watch refresh 失败 ${String(error)}`)
          }
        }, 400)
      })
      closeWatch = () => {
        if (timer) clearTimeout(timer)
        watcher.close()
      }
    } catch (error) {
      api.log(`cross-team-management: 目录监听不可用，退回轮询 ${String(error)}`)
    }
  }
  ctx.effect(() => () => closeWatch())
  startWatch()

  // 定时轮询：截止提醒、逾期升级、周五通报
  if (cfg.scheduler !== false) {
    const handle = setInterval(() => {
      try {
        tick()
      } catch (error) {
        api.log(`cross-team-management: tick 失败 ${String(error)}`)
      }
    }, Math.max(15, cfg.tickSeconds) * 1000)
    ctx.effect(() => () => clearInterval(handle))
  }

  // 系统提示注入：每轮携带当前大盘与未读事件
  if (cfg.injectPrompt !== false) {
    try {
      const systemPrompt = ctx.get('systemPrompt')
      if (systemPrompt && typeof systemPrompt.section === 'function') {
        promptRegistered = true
        ctx.effect(() =>
          systemPrompt.section({
            name: 'cross-team-management:board',
            order: 4500,
            text: () => promptText(),
          }),
        )
      }
    } catch (error) {
      api.log(`cross-team-management: 系统提示注入不可用 ${String(error)}`)
    }
  }

  // ── 视图组装 ────────────────────────────────────────────────────────────
  /** 明确分工：控制层给事实与候选口径，结论和话术由模型写。 */
  function withNote(text) {
    if (cfg.adviceMode === 'off') return text
    return `${text}\n\n（以上为控制层组装的事实与规则候选。最终给领导的说法、给团队的话术，请基于事实自己写。）`
  }

  function overview(board, options = {}) {
    const { counts } = board
    const lines = [`📊 跨团队管理 · ${cfg.label}`, `大盘：红灯${counts.red}项（需介入）· 黄灯${counts.yellow}项（风险）· 绿灯${counts.green}项（正常）· 未交${counts.missing}项`, '']
    for (const team of board.teams) {
      const meta = STATUS[team.status]
      const detail =
        team.status === 'missing'
          ? '目录下无文件。'
          : team.status === 'green'
            ? team.progress[0]
              ? ensurePeriod(trimTo(team.progress[0], 60))
              : '已提交，未见卡点。'
            : ensurePeriod(trimTo(team.blockers.slice(0, 2).map((item) => item.text).join('；'), 90))
      lines.push(`${meta.icon} [${meta.label}] ${team.name}：${detail}`)
    }
    const fresh = board.teams.filter((t) => t.reminder && t.reminder.fresh)
    for (const team of fresh) lines.push(`*系统已自动向${team.name}发送催促：「${team.reminder.text}」*`)
    for (const team of board.teams.filter((t) => t.reminder && !t.reminder.fresh)) {
      lines.push(`*${team.name} 今日已催办（${fmtTime(team.reminder.at)}），未重复发送。*`)
    }
    const advices = cfg.adviceMode === 'off' ? [] : board.teams.map(adviceFor).filter(Boolean)
    if (advices.length > 0) lines.push('', '【给领导的建议 · 规则候选】', ...advices.map((text, index) => `${index + 1}. ${text}`))
    return lines.join('\n')
  }

  function detailOf(board, target) {
    const team = board.teams.find((t) => t.id === target || t.name === target || t.name.includes(target) || t.id.includes(target))
    if (!team) return `未找到团队「${target}」。当前目录下的团队：${board.teams.map((t) => `${t.name}(${t.id})`).join('、')}`
    if (team.status === 'missing') {
      const st = teamState(team.id)
      return [
        `[${team.name}·未提交]`,
        `共享目录 ${join(cfg.rootDir, team.id)} 下没有周报文件。`,
        `首次空目录：${fmtTime(st.firstEmptyAt)}；催办 ${st.reminders.length} 次${st.escalatedAt ? `；已于 ${fmtTime(st.escalatedAt)} 升级` : ''}。`,
        '【给领导的建议 · 候选】：先确认是否漏传；若确实未启动，要求今日下班前上传并说明原因。',
      ].join('\n')
    }
    const lines = [`[${team.name}·卡点详情]  文件：${team.file}（提交于 ${fmtTime(team.submittedAt)}）`]
    if (team.status === 'green') {
      const progress = team.progress.map((line) => line.replace(/^本周/, '')).join('；')
      lines.push(`本周进展：${progress ? ensurePeriod(progress) : '已提交，未识别到卡点。'}`)
      if (team.plans && team.plans.length > 0) lines.push(`下周计划：${team.plans.join('；')}`)
      if (cfg.adviceMode !== 'off') lines.push('【给领导的建议 · 候选】：无需介入，保持节奏即可。')
      lines.push(`原文摘录：${trimTo(team.analysis.raw, 220)}`)
      return lines.join('\n')
    }
    const first = team.blockers[0]
    if (first) {
      const { need, state: current } = splitNeedState(first.text)
      if (need) lines.push(`诉求：${need}`)
      lines.push(`当前状态：${current}`)
    }
    const extra = team.blockers.slice(1)
    if (extra.length > 0) lines.push('其它风险：', ...extra.map((b) => `- ${b.text}`))
    if (team.progress.length > 0) lines.push(`已完成的进展：${team.progress.slice(0, 2).join('；')}`)
    if (team.plans && team.plans.length > 0) lines.push(`下周计划：${team.plans.join('；')}`)
    const advice = team.status === 'red'
      ? /预算|审批|财务/.test(team.blocker)
        ? `可直接回复OA审批，或安排${team.name}负责人与财务总监拉齐会议。`
        : redAdvice(team)
      : yellowAdvice(team)
    if (cfg.adviceMode !== 'off') lines.push(`【给领导的建议 · 候选】：${advice}`)
    lines.push(`原文摘录：${trimTo(team.analysis.raw, 220)}`)
    return lines.join('\n')
  }

  function draftsOf(board, targets, instruction) {
    const list = targets && targets.length > 0 ? targets : board.teams.map((t) => t.id)
    const picked = list
      .map((target) => board.teams.find((t) => t.id === target || t.name === target || t.name.includes(target)))
      .filter(Boolean)
    if (picked.length === 0) return `没有匹配到团队：${list.join('、')}`
    return [...picked.map((team) => draftFacts(team, instruction || '')), '', '（以上是拟稿要素：事实、决定、要求、截止、语气。话术由你按这些要素写，别照搬要素句式。）'].join('\n\n')
  }

  function escalateOf(board, target) {
    const team = board.teams.find((t) => t.id === target || t.name === target || t.name.includes(target) || t.id.includes(target))
    if (!team) return `未找到团队「${target}」。`
    const st = teamState(team.id)
    if (team.status !== 'missing') return `${team.name}已提交周报（${team.file}），无需升级；如需看卡点请用 view=detail。`
    const anchor = st.reminders[0] || st.firstEmptyAt
    const reference = st.escalatedAt || new Date().toISOString()
    const hours = Math.round(hoursBetween(anchor, reference))
    const when = anchor ? fmtTime(anchor) : '—'
    const lines = [
      `[逾期预警] ${team.name}超过${hours}小时未交周报，且无回复。`,
      `首次催办：${when}；催办次数：${st.reminders.length}。`,
    ]
    if (st.escalatedAt) lines.push(`升级时间：${fmtTime(st.escalatedAt)}（已生成升级函）`)
    lines.push(`【给领导的建议】：${team.focus ? `${team.name}本周负责${team.focus}，` : ''}建议将此事上报运营总监，或发起15分钟强制对齐会。`)
    return lines.join('\n')
  }

  function digestView(board) {
    const cached = state.lastDigest && weekKey(state.lastDigest.at) === weekKey(board.at) ? state.lastDigest : null
    const text = cached ? cached.text : digestOf(board, cfg)
    if (cached && cached.mailDraft) {
      return `${text}\n\n（邮件草稿已生成：${cached.mailDraft.file || '未落盘'}；收件人 ${cached.mailDraft.to}。确认后调 email_send 投递。）`
    }
    return text
  }

  function updatesView(board) {
    const unread = state.events.filter((e) => !e.read)
    const lines = []
    if (unread.length === 0) lines.push('[状态更新] 暂无新事件。')
    for (const event of unread) {
      const label = event.type === 'submit' ? '状态更新' : event.type === 'red' ? '新增红灯' : event.type === 'escalate' ? '逾期升级' : event.type === 'remind' ? '自动催办' : event.type === 'digest' ? '全局通报' : '内容更新'
      lines.push(`[${label}] ${event.text}`)
    }
    const { counts } = board
    lines.push(`[大盘更新] 红灯${counts.red}项，黄灯${counts.yellow}项，绿灯${counts.green}项，未交${counts.missing}项。`)
    const advices = cfg.adviceMode === 'off' ? [] : board.teams.filter((t) => t.level === 'red' || t.status === 'missing').map(adviceFor).filter(Boolean)
    if (advices.length > 0) lines.push('', '【给领导的建议 · 规则候选】', ...advices.map((text, index) => `${index + 1}. ${text}`))
    for (const event of unread) event.read = true
    if (unread.length > 0) {
      dirty = true
      save()
    }
    return lines.join('\n')
  }

  // ── 工具 ────────────────────────────────────────────────────────────────
  ctx.tools.register(
    api.tool({
      name: 'weekly_context',
      description:
        '跨团队管理：扫描共享目录、过滤流水账、按红黄绿灯组装事实与判断依据。view=overview 全景（含自动催办回执与规则候选建议）；detail 单点下钻（target=团队）；draft 返回拟稿要素（targets+instruction：对象/事实/决定/要求/截止/语气，话术由你写）；digest 脱敏全员通报；escalate 逾期升级函（target）；updates 未读事件与大盘更新。返回里的【给领导的建议 · 规则候选】是控制层口径、不是定稿，请按事实改写成你的判断。',
      parameters: {
        view: { type: 'string', enum: ['overview', 'detail', 'draft', 'digest', 'escalate', 'updates'], required: true, description: '要组装的视图。' },
        target: { type: 'string', description: '团队 id 或名称，如 A_group / 产品A组；detail/escalate 必填，draft 可用逗号分隔多个。' },
        instruction: { type: 'string', description: 'draft 用：领导的分派原话，如「预算我口头同意了」。' },
      },
      execute: async (args) => {
        if (!cfg.rootDir) return SETUP_HINT
        const now = new Date().toISOString()
        const board = refresh(now)
        if (args.view === 'overview') return withNote(overview(board))
        if (args.view === 'detail') {
          if (!args.target) return `detail 需要 target（团队 id 或名称）。当前团队：${board.teams.map((t) => t.id).join('、')}`
          return withNote(detailOf(board, args.target))
        }
        if (args.view === 'draft') {
          const targets = args.target ? args.target.split(/[,，、]/).map((s) => s.trim()).filter(Boolean) : []
          return draftsOf(board, targets, args.instruction)
        }
        if (args.view === 'digest') return withNote(digestView(board))
        if (args.view === 'escalate') {
          if (!args.target) return 'escalate 需要 target（团队 id 或名称）。'
          return withNote(escalateOf(board, args.target))
        }
        return updatesView(board)
      },
    }),
  )

  ctx.tools.register(
    api.tool({
      name: 'weekly_ops',
      description:
        '跨团队管理运维：scan 立即重扫并报告变化；remind 立即催办未交团队（可指定 target）；tick 立即跑一次定时检查（含逾期升级与周五通报，可用 at 模拟时间）；digest 立即生成全员通报；prompt 查看注入 system prompt 的看板文本；reset 清空未读事件。',
      parameters: {
        action: { type: 'string', enum: ['scan', 'remind', 'tick', 'digest', 'prompt', 'reset'], required: true, description: '运维动作；prompt 查看当前注入 system prompt 的看板文本。' },
        scope: { type: 'string', enum: ['events', 'all'], description: 'reset 用：events 只清事件（默认）；all 连团队台账与上周通报一起归零，用于换周/换数据重跑。' },
        target: { type: 'string', description: 'remind 用：只催办指定团队。' },
        at: { type: 'string', description: 'tick 用：模拟当前时间（ISO），用于演示超时升级与定时通报。' },
      },
      execute: async (args) => {
        if (!cfg.rootDir) return SETUP_HINT
        const now = args.at || new Date().toISOString()
        if (args.action === 'scan') {
          const before = state.lastBoard
          const board = refresh(now)
          const lines = [`已重扫 ${cfg.rootDir}`, `大盘：红灯${board.counts.red} · 黄灯${board.counts.yellow} · 绿灯${board.counts.green} · 未交${board.counts.missing}`]
          if (before) {
            const changedTeams = board.teams.filter((t) => {
              const old = before.teams.find((o) => o.id === t.id)
              return old && (old.status !== t.status || old.file !== t.file)
            })
            lines.push(changedTeams.length > 0 ? `变化：${changedTeams.map((t) => `${t.name} → ${STATUS[t.status].label}`).join('；')}` : '变化：无')
          }
          return lines.join('\n')
        }
        if (args.action === 'remind') {
          const board = refresh(now)
          const targets = board.teams.filter((t) => t.status === 'missing' && (!args.target || t.id === args.target || t.name.includes(args.target)))
          if (targets.length === 0) return `没有需要催办的团队${args.target ? `（${args.target}）` : ''}。`
          const lines = []
          for (const team of targets) {
            const text = reminderText(team, cfg, now, cfg.deadline)
            const file = dispatchTo(team, text, 'reminder', now)
            const st = teamState(team.id)
            st.reminders.push(now)
            pushEvent('remind', team.id, `已向${team.name}发送催办`, now)
            lines.push(`→ ${team.name}：${text}`, file ? `  已落盘：${file}` : '  （未落盘，仅记录台账）')
          }
          dirty = true
          save()
          return lines.join('\n')
        }
        if (args.action === 'tick') {
          const { board, actions } = tick(now)
          const lines = [`定时检查完成（${fmtTime(now)}）`, `大盘：红灯${board.counts.red} · 黄灯${board.counts.yellow} · 绿灯${board.counts.green} · 未交${board.counts.missing}`]
          const escalated = state.events.filter((e) => e.type === 'escalate' && !e.read)
          if (escalated.length > 0) lines.push('升级事件：', ...escalated.map((e) => `- ${e.text}`))
          if (actions.length > 0) lines.push('', '已生成定时通报：', actions[0])
          return lines.join('\n')
        }
        if (args.action === 'prompt') {
          const head = promptRegistered ? '注入状态：已注册到 systemPrompt（每轮自动携带）' : '注入状态：未注册（仅按需返回文本）'
          return `${head}\n\n${promptText() || '（未配置注入，或目录不可读）'}`
        }
        if (args.action === 'digest') {
          const board = refresh(now)
          return generateDigest(board, now)
        }
        state.events = []
        if (args.scope === 'all') {
          state.teams = {}
          state.lastDigest = null
          state.lastTick = null
          state.lastBoard = null
        }
        dirty = true
        save()
        return args.scope === 'all' ? '已清空事件流水与团队台账（周状态归零）。' : '已清空事件流水。'
      },
    }),
  )

  // ── 邮件：给团队的反馈 / 全员周报 ────────────────────────────────────────
  function mailRecipients(team, kind) {
    if (kind === 'digest') return cfg.email.digestTo
    return team && team.email ? [team.email] : []
  }

  function writeEml(name, eml) {
    try {
      const dir = join(cfg.rootDir, '_mail')
      mkdirSync(dir, { recursive: true })
      const file = join(dir, `${new Date().toISOString().slice(0, 10)}-${name}.eml`)
      writeFileSync(file, eml, 'utf8')
      return file
    } catch (error) {
      api.log(`cross-team-management: 写入 .eml 失败 ${String(error)}`)
      return null
    }
  }

  /** 组装一封草稿：解析收件人、生成主题/正文、落盘 .eml。不发送。 */
  function buildDraft(kind, team, options = {}) {
    const now = options.now || new Date().toISOString()
    const recipients = mailRecipients(team, kind)
    if (recipients.length === 0) return { ok: false, reason: 'no-recipients' }
    const subject =
      options.subject ||
      (kind === 'digest'
        ? `${cfg.email.subjectPrefix} ${cfg.label} 全员通报`
        : `${cfg.email.subjectPrefix} ${cfg.label} · 给${team.name}的反馈`)
    const body = options.body || (kind === 'digest' ? '' : feedbackMailBody(team, cfg))
    if (!body) return { ok: false, reason: 'empty-body' }
    const to = recipients.join(', ')
    const eml = buildEml({ from: cfg.email.from, fromName: cfg.email.fromName, to, subject, body, date: now })
    const file = writeEml(`${kind}-${kind === 'digest' ? 'all' : team.id}${options.suffix || ''}`, eml)
    return { ok: true, to, subject, body, file }
  }

  /** 生成周报通报；开了邮件就顺手生成一份草稿（仍然不发送）。 */
  function generateDigest(board, now, options = {}) {
    const text = digestOf(board, cfg)
    state.lastDigest = { at: now, text }
    pushEvent('digest', null, options.scheduled ? '已生成周报全局通报（定时）' : '已生成周报全局通报', now)
    let mailLine = ''
    if (cfg.email.enabled) {
      const draft = buildDraft('digest', null, { body: text, now, suffix: '-auto' })
      if (draft.ok) {
        state.lastDigest.mailDraft = { file: draft.file, to: draft.to, subject: draft.subject }
        pushEvent('mail', null, `已生成通报邮件草稿 → ${draft.to}`, now)
        mailLine = [
          '',
          '【邮件草稿已生成 · 未发送】',
          `收件人：${draft.to}`,
          draft.file ? `.eml：${draft.file}` : '.eml 未落盘',
          '确认后调用 email_send 投递（用户会再确认一次）。',
        ].join('\n')
      } else {
        mailLine = `\n【未生成邮件草稿】${draft.reason === 'no-recipients' ? '没有配置 email.digestTo' : draft.reason}`
      }
    }
    dirty = true
    save()
    return text + mailLine
  }

  ctx.tools.register(
    api.tool({
      name: 'weekly_mail_draft',
      description:
        '组装一封给团队或全员的邮件草稿：解析收件人、生成主题与正文、落盘 .eml，并返回调用 email_send 所需的参数。本工具只组装，不投递——发送由你在下一轮调用 dsh-email 的 email_send 完成，用户会在那里确认或拒绝。',
      parameters: {
        kind: { type: 'string', enum: ['feedback', 'digest'], required: true, description: 'feedback=给某个团队；digest=全员周报。' },
        target: { type: 'string', description: 'kind=feedback 时的团队 id 或名称，如 A_group / 产品A组。' },
        subject: { type: 'string', description: '可选主题；缺省按「[周报台] 2026-W44 · 给X组的反馈」生成。' },
        body: { type: 'string', description: '可选正文；建议由你写。缺省用规则草稿（只陈述事实与要求，不假装是领导口吻）。' },
      },
      execute: async (args) => {
        if (!cfg.rootDir) return SETUP_HINT
        const now = new Date().toISOString()
        const board = refresh(now)
        if (!cfg.email.enabled) return '邮件功能已关闭（config.email.enabled = false）。'
        let team = null
        if (args.kind === 'feedback') {
          if (!args.target) return 'kind=feedback 需要 target（团队 id 或名称）。'
          team = board.teams.find(
            (item) => item.id === args.target || item.name === args.target || item.name.includes(args.target) || item.id.includes(args.target),
          )
          if (!team) return `未找到团队「${args.target}」。当前：${board.teams.map((item) => item.id).join('、')}`
        }

        const draft = buildDraft(args.kind, team, {
          subject: args.subject,
          body: args.body || (args.kind === 'digest' ? digestOf(board, cfg) : undefined),
          now,
        })
        if (!draft.ok) {
          if (draft.reason === 'no-recipients') {
            return args.kind === 'digest'
              ? '没有收件人：在 config.json 里填 email.digestTo（数组），例如 ["boss@example.com"]。'
              : `没有收件人：在 config.json 里给 ${team ? team.id : '该团队'} 填 email 字段。`
          }
          return '正文为空：请传入 body，或检查 digest 是否生成成功。'
        }
        pushEvent('mail', team ? team.id : null, `已生成邮件草稿：${draft.subject}`, now)
        save()

        const to = draft.to
        const subject = draft.subject
        const body = draft.body
        const file = draft.file

        return [
          `【邮件草稿 · ${args.kind === 'digest' ? '全员通报' : team.name}】`,
          `收件人：${to}`,
          `主题：${subject}`,
          '',
          '正文：',
          body,
          '',
          file ? `.eml 已写入：${file}（可直接导入邮件客户端）` : '.eml 写入失败，正文以上面为准',
          '',
          '【下一步 · 由你决定是否发送】',
          '本工具只组装草稿，不投递。需要发送时，下一轮调用 email_send，参数为：',
          `  to: ${to}`,
          `  subject: ${subject}`,
          '  text: 上面「正文」全文（不要改写事实）',
          '用户会在 email_send 的确认里选择发送或拒绝；拒绝就到此为止。',
        ].join('\n')
      },
    }),
  )

  /** 面板的「全部标为已读」：只改事件读状态，不动团队台账。 */
  function acknowledgeEvents() {
    let changed = 0
    for (const event of state.events) {
      if (!event.read) {
        event.read = true
        changed += 1
      }
    }
    if (changed > 0) {
      dirty = true
      save()
      if (lastBoardFull) publishPanel(lastBoardFull)
    }
    return changed
  }
  api.registerAck?.(acknowledgeEvents)

  // 挂载即扫描一次，把补交/新增红灯等事件补上
  try {
    refresh(new Date().toISOString())
  } catch (error) {
    api.log(`cross-team-management: 初始扫描失败 ${String(error)}`)
  }

  api.log(`cross-team-management 已挂载：${cfg.teams.length} 个团队，目录 ${cfg.rootDir}`)
}

// ── 配置 ──────────────────────────────────────────────────────────────────
function normalizeConfig(config) {
  const rootDir = String(config.rootDir || '').trim()
  const teams = (Array.isArray(config.teams) ? config.teams : [])
    .map((team) => (typeof team === 'string' ? { id: team, name: team } : team))
    .filter((team) => team && typeof team.id === 'string')
    .map((team) => ({ id: team.id, name: team.name || team.id, focus: team.focus || '', email: String(team.email || '').trim() }))
  return {
    rootDir,
    label: config.label || rootDir.split('/').filter(Boolean).slice(-1)[0] || '未配置',
    teams,
    deadline: config.deadline || null,
    escalateHours: Number.isFinite(config.escalateHours) ? config.escalateHours : 24,
    autoRemind: config.autoRemind !== false,
    autoEscalate: config.autoEscalate !== false,
    autoDigest: config.autoDigest !== false,
    writeOutbox: config.writeOutbox !== false,
    injectPrompt: config.injectPrompt !== false,
    adviceMode: config.adviceMode === 'off' ? 'off' : 'hint',
    watch: config.watch !== false,
    scheduler: config.scheduler !== false,
    tickSeconds: Number.isFinite(config.tickSeconds) ? config.tickSeconds : 60,
    digest: {
      weekday: Number.isFinite(config.digest?.weekday) ? config.digest.weekday : 5,
      hour: Number.isFinite(config.digest?.hour) ? config.digest.hour : 17,
    },
    email: {
      enabled: config.email?.enabled !== false,
      from: String(config.email?.from || ''),
      fromName: String(config.email?.fromName || '跨团队管理'),
      digestTo: (Array.isArray(config.email?.digestTo) ? config.email.digestTo : []).map((address) => String(address).trim()).filter(Boolean),
      subjectPrefix: String(config.email?.subjectPrefix || '[周报台]'),
      signature: String(config.email?.signature || '').trim(),
    },
  }
}
