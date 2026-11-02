// cross-team-management — Web 面板（只读）
// 由 Host 的 /cross-team-management/board 提供快照；面板每 10 秒拉一次。
// 不触发任何模型调用，也不改动台账。

window.__ModuleLoader__.load({
  id: 'cross-team-management',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const NS = 'cross-team-management'

    const zh = {
      panel: 'cross-team-management',
      subtitle: '共享目录里的团队周报（只读）',
      refresh: '刷新',
      updated: '更新于',
      red: '需介入',
      yellow: '风险',
      green: '正常',
      missing: '未提交',
      unread: '未读事件',
      events: '最近动作',
      ack: '全部标为已读',
      acked: '已全部标为已读',
      loading: '加载中…',
      error: '加载失败',
      retry: '重试',
      empty: '还没有扫描到数据。确认共享目录存在后点刷新。',
      readOnly: '',
      overdue: '已逾期',
      none: '—',
    }

    const en = {
      panel: 'Cross-Team Management',
      subtitle: 'Team weekly reports in the shared folder (read-only)',
      refresh: 'Refresh',
      updated: 'Updated',
      red: 'Needs action',
      yellow: 'At risk',
      green: 'On track',
      missing: 'Not submitted',
      unread: 'Unread events',
      events: 'Recent activity',
      ack: 'Mark all read',
      acked: 'All marked read',
      loading: 'Loading…',
      error: 'Failed to load',
      retry: 'Retry',
      empty: 'Nothing scanned yet. Check the shared folder and refresh.',
      readOnly: '',
      overdue: 'Overdue',
      none: '—',
    }

    const STATUS_COLOR = {
      red: 'var(--dsw-alias-state-error-primary)',
      yellow: 'var(--dsw-alias-state-warn-primary)',
      green: 'var(--dsw-alias-state-success-primary)',
      missing: 'var(--dsw-alias-state-idle-primary)',
    }

    const styles = {
      root: { padding: '22px 24px', color: 'var(--dsw-alias-label-primary)', fontSize: 15, lineHeight: 1.6 },
      header: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 },
      title: { fontSize: 19, fontWeight: 600 },
      sub: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)', marginTop: 3 },
      button: {
        fontSize: 13,
        padding: '5px 12px',
        borderRadius: 7,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-2)',
        color: 'var(--dsw-alias-label-primary)',
        cursor: 'pointer',
      },
      pills: { display: 'flex', gap: 10, marginTop: 16, flexWrap: 'wrap' },
      pill: {
        display: 'flex',
        alignItems: 'baseline',
        gap: 6,
        padding: '6px 13px',
        borderRadius: 999,
        border: '1px solid var(--dsw-alias-border-l1)',
        background: 'var(--dsw-alias-bg-layer-2)',
      },
      pillValue: { fontSize: 17, fontWeight: 600 },
      pillLabel: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
      section: { marginTop: 20, fontSize: 13, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)' },
      team: {
        display: 'flex',
        gap: 8,
        alignItems: 'flex-start',
        padding: '11px 0',
        borderBottom: '1px solid var(--dsw-alias-border-l1)',
      },
      dot: { width: 9, height: 9, borderRadius: '50%', marginTop: 7, flex: '0 0 auto' },
      teamName: { fontWeight: 600, fontSize: 15 },
      teamState: { fontSize: 12, color: 'var(--dsw-alias-label-secondary)' },
      blocker: { fontSize: 14, color: 'var(--dsw-alias-label-secondary)', marginTop: 3, wordBreak: 'break-word' },
      event: { fontSize: 13, color: 'var(--dsw-alias-label-secondary)', padding: '4px 0', display: 'flex', gap: 8, alignItems: 'baseline' },
      footer: { marginTop: 20, fontSize: 12, color: 'var(--dsw-alias-label-secondary)', lineHeight: 1.6 },
    }

    function PanelIcon(props) {
      const size = props.size || 20
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 24 24',
          fill: 'none',
          'aria-hidden': true,
          style: { display: 'block', opacity: props.active ? 1 : 0.76 },
        },
        h('rect', { x: 3, y: 4, width: 8, height: 7, rx: 2, stroke: 'currentColor', strokeWidth: 1.7 }),
        h('rect', { x: 13, y: 4, width: 8, height: 7, rx: 2, stroke: 'currentColor', strokeWidth: 1.7 }),
        h('rect', { x: 3, y: 13, width: 8, height: 7, rx: 2, stroke: 'currentColor', strokeWidth: 1.7 }),
        h('rect', { x: 13, y: 13, width: 8, height: 7, rx: 2, stroke: 'currentColor', strokeWidth: 1.7 }),
      )
    }

    function pill(key, label, value) {
      return h(
        'span',
        { key, style: styles.pill },
        h('span', { style: { ...styles.pillValue, color: STATUS_COLOR[key] } }, String(value || 0)),
        h('span', { style: styles.pillLabel }, label),
      )
    }

    function fmtTime(iso) {
      if (!iso) return '—'
      const date = new Date(iso)
      if (Number.isNaN(date.getTime())) return '—'
      const pad = (n) => String(n).padStart(2, '0')
      return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
    }

    function PanelView(props) {
      const t = props.t
      const [data, setData] = React.useState(null)
      const [status, setStatus] = React.useState('loading')
      const [error, setError] = React.useState('')
      const requestId = React.useRef(0)

      const load = React.useCallback(async () => {
        const current = ++requestId.current
        try {
          const response = await fetch('/cross-team-management/board', {
            headers: { accept: 'application/json' },
            cache: 'no-store',
          })
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          const json = await response.json()
          if (current !== requestId.current) return
          setData(json && json.empty ? null : json)
          setStatus('ready')
          setError('')
        } catch (cause) {
          if (current !== requestId.current) return
          setStatus('error')
          setError(String((cause && cause.message) || cause))
        }
      }, [])

      React.useEffect(() => {
        load()
        const timer = setInterval(load, 10000)
        return () => clearInterval(timer)
      }, [load])

      const counts = (data && data.counts) || { red: 0, yellow: 0, green: 0, missing: 0 }
      const teams = (data && data.teams) || []
      const events = (data && data.events) || []
      const unreadCount = (data && data.unreadCount) || 0

      const acknowledge = React.useCallback(async () => {
        try {
          await fetch('/cross-team-management/ack', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: '{}',
          })
          await load()
        } catch (cause) {
          setStatus('error')
          setError(String((cause && cause.message) || cause))
        }
      }, [load])

      return h(
        'div',
        { style: styles.root },
        h(
          'div',
          { style: styles.header },
          h(
            'div',
            null,
            h('div', { style: styles.title }, `${t('panel')}${data && data.label ? ` · ${data.label}` : ''}`),
            h('div', { style: styles.sub }, t('subtitle')),
          ),
          h(
            'div',
            { style: { display: 'flex', gap: 8 } },
            unreadCount > 0 ? h('button', { type: 'button', style: styles.button, onClick: acknowledge }, `${t('ack')} (${unreadCount})`) : null,
            h('button', { type: 'button', style: styles.button, onClick: load }, t('refresh')),
          ),
        ),

        h(
          'div',
          { style: styles.pills },
          pill('red', t('red'), counts.red),
          pill('yellow', t('yellow'), counts.yellow),
          pill('green', t('green'), counts.green),
          pill('missing', t('missing'), counts.missing),
        ),

        status === 'error'
          ? h('div', { style: { ...styles.footer, color: 'var(--dsw-alias-state-error-primary)' } }, `${t('error')}：${error}`)
          : null,

        teams.length > 0
          ? h(
              'div',
              { style: styles.section },
              teams.map((team) =>
                h(
                  'div',
                  { key: team.id, style: styles.team },
                  h('span', { style: { ...styles.dot, background: STATUS_COLOR[team.status] || STATUS_COLOR.missing } }),
                  h(
                    'div',
                    { style: { minWidth: 0 } },
                    h(
                      'div',
                      { style: { display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' } },
                      h('span', { style: styles.teamName }, team.name),
                      h('span', { style: styles.teamState }, t(team.status)),
                      team.escalated
                        ? h(
                            'span',
                            { style: { ...styles.teamState, color: 'var(--dsw-alias-state-error-primary)' } },
                            `${t('overdue')} ${Math.round(team.hoursOverdue || 0)}h`,
                          )
                        : null,
                    ),
                    team.blocker ? h('div', { style: styles.blocker }, team.blocker) : null,
                  ),
                ),
              ),
            )
          : h('div', { style: styles.section }, status === 'loading' ? t('loading') : t('empty')),

        events.length > 0
          ? h(
              'div',
              { style: styles.section },
              `${t('events')} ${events.length}${unreadCount > 0 ? ` · ${t('unread')} ${unreadCount}` : ''}`,
              events
                .slice()
                .reverse()
                .map((event, index) =>
                  h(
                    'div',
                    { key: index, style: styles.event },
                    h('span', {
                      style: {
                        width: 6,
                        height: 6,
                        borderRadius: '50%',
                        marginTop: 6,
                        flex: '0 0 auto',
                        background: event.read ? 'var(--dsw-alias-border-l2)' : 'var(--dsw-alias-brand-primary)',
                      },
                    }),
                    h('span', null, `${fmtTime(event.at)} · ${event.text}`),
                  ),
                ),
            )
          : null,

        h(
          'div',
          { style: styles.footer },
          data ? `${t('updated')} ${fmtTime(data.at)}` : t('none'),
        ),
      )
    }

    const inject = ['slots', 'locale']

    function apply(ctx) {
      const t = ctx.locale.bind(NS)
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'cross-team-management: dictionaries')

      ctx.slots.inject('sidebar.panellist', () =>
        ctx.slots.register(
          {
            name: 'sidebar.panellist',
            id: 'cross-team-management',
            order: 30,
            label: () => t('panel'),
          },
          PanelIcon,
        ),
      )

      ctx.slots.inject('main', () =>
        ctx.slots.register(
          {
            name: 'main',
            key: 'cross-team-management',
          },
          (slotProps) => h(PanelView, Object.assign({}, slotProps, { t })),
        ),
      )
    }

    return { inject, apply }
  },
})
