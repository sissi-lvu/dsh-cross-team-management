// cross-team-management — 跨团队管理
//
// 控制层插件：扫描共享目录里的团队周报 → 过滤流水账 → 维护台账 → 按意图组装事实与判断依据。
// 领域逻辑在 ./domain.mjs；本文件只负责把它接到 Harness 上（工具、持久化目录、日志）。
//
// 与 evolve 版的差别只有三处：
//   1. 工具用 defineTool 注册，而不是 evolve 的 api.tool
//   2. 台账写在 $DSH_HOME/state/cross-team-management，而不是 evolve store
//   3. 首次启动时从旧 evolve 台账迁移一次，避免丢掉已经催办过的记录

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { apply as applyDomain } from './domain.mjs'

export const name = 'cross-team-management'

export const inject = ['tools']

const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url))
const DSH_HOME = process.env.DSH_HOME || join(homedir(), '.dsh')
const STATE_DIR = join(DSH_HOME, 'state', 'cross-team-management')
const LEDGER = join(STATE_DIR, 'ledger.json')
const LEGACY_LEDGER = join(DSH_HOME, 'evolve', 'data', 'weekly-desk', 'ledger.json')
const BOARD_PATH = '/cross-team-management/board'
const ACK_PATH = '/cross-team-management/ack'

const textOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }],
}

/**
 * 只读面板路由：把 domain 发布的快照原样返回给浏览器。
 * 只接受本机回环连接，不设 CORS；不触发扫描，也不调用模型。
 */
function createBoardHandler(read) {
  return function boardHandler(req, res) {
    try {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { allow: 'GET' })
        res.end()
        return
      }
      const remote = String((req.socket && req.socket.remoteAddress) || '')
      const local = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
      if (!local) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('forbidden')
        return
      }
      const body = JSON.stringify(read() || { empty: true })
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(req.method === 'HEAD' ? undefined : body)
    } catch (error) {
      try {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: String(error && error.message ? error.message : error) }))
      } catch {
        res.destroy && res.destroy()
      }
    }
  }
}

/**
 * 标为已读：POST + application/json。JSON 请求跨域会先预检，而这里不返回 CORS 头，
 * 所以别的网页没法替你点这个按钮。
 */
function createAckHandler(read) {
  return function ackHandler(req, res) {
    try {
      if (req.method !== 'POST') {
        res.writeHead(405, { allow: 'POST' })
        res.end()
        return
      }
      const remote = String((req.socket && req.socket.remoteAddress) || '')
      const local = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
      if (!local) {
        res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('forbidden')
        return
      }
      const contentType = String((req.headers && req.headers['content-type']) || '')
      if (!contentType.includes('application/json')) {
        res.writeHead(415, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('expected application/json')
        return
      }
      const acknowledge = read()
      const changed = typeof acknowledge === 'function' ? acknowledge() : 0
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      })
      res.end(JSON.stringify({ ok: true, read: changed }))
    } catch (error) {
      try {
        res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: String(error && error.message ? error.message : error) }))
      } catch {
        res.destroy && res.destroy()
      }
    }
  }
}

/** 一个 evolve 版 api 的最小替身，让 domain.mjs 原样跑起来。 */
function createApi(publishBoard, registerAck) {
  return {
    publishBoard,
    registerAck,
    tool: (spec) =>
      defineTool({
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters,
        output: textOutput,
        execute: async (args) => {
          const result = await spec.execute(args)
          return typeof result === 'string' ? result : JSON.stringify(result)
        },
      }),
    dataFile(relative) {
      const file = join(STATE_DIR, String(relative))
      mkdirSync(dirname(file), { recursive: true })
      return file
    },
    readJson(file, fallback) {
      return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : fallback
    },
    writeJson(file, value) {
      mkdirSync(dirname(file), { recursive: true })
      const temporary = `${file}.tmp-${process.pid}-${Date.now()}`
      writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
      renameSync(temporary, file)
    },
    readText(file, fallback) {
      return existsSync(file) ? readFileSync(file, 'utf8') : fallback
    },
    writeText(file, text) {
      mkdirSync(dirname(file), { recursive: true })
      writeFileSync(file, text, 'utf8')
    },
    log: (...args) => console.log('[cross-team-management]', ...args.map((entry) => (typeof entry === 'string' ? entry : JSON.stringify(entry)))),
  }
}

export function apply(ctx, config = {}) {
  mkdirSync(STATE_DIR, { recursive: true })
  let latest = null
  let acknowledge = null
  if (!existsSync(LEDGER) && existsSync(LEGACY_LEDGER)) {
    try {
      copyFileSync(LEGACY_LEDGER, LEDGER)
      console.log('[cross-team-management] 已从 evolve 台账迁移历史状态')
    } catch (error) {
      console.log(`[cross-team-management] 台账迁移失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }
  if (!existsSync(join(PACKAGE_DIR, 'config.json'))) {
    console.log(`[cross-team-management] 未找到 ${join(PACKAGE_DIR, 'config.json')}，使用插件行 config`)
  }
  // Web 面板：只读快照路由（本机回环）
  try {
    ctx.inject(['webServer'], (webCtx) => {
      webCtx.effect(() =>
        webCtx.webServer.register({
          kind: 'exact',
          path: BOARD_PATH,
          handler: createBoardHandler(() => latest),
        }),
      )
      webCtx.effect(() =>
        webCtx.webServer.register({
          kind: 'exact',
          path: ACK_PATH,
          handler: createAckHandler(() => acknowledge),
        }),
      )
    })
  } catch (error) {
    console.log(`[cross-team-management] 面板路由注册失败：${error instanceof Error ? error.message : String(error)}`)
  }

  return applyDomain(
    ctx,
    config,
    createApi(
      (snapshot) => {
        latest = snapshot
      },
      (handler) => {
        acknowledge = handler
      },
    ),
  )
}
