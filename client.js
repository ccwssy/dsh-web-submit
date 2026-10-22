/**
 * dsh-web-submit — Client 半（Web）
 *
 * 在「设置 → 通用设置」注册「headless 通道」行：auto / gateway / api。
 * 取值写 profile 条目 config 的 volatile 字段 `transport`，host 侧每次现读，
 * 因此同一进程内下一份 pickTransport() 即可看到新值。
 *
 * 注意：通道一经择一即固定（create/prompt 换通道重放会让任务跑两次），
 * 所以已经提交过任务的进程仍需重启 dsh web 才真正切换；卡片把这一点写在副标题里。
 *
 * 约束：本文件是宿主直接装载的零构建产物（window.__ModuleLoader__.load），只
 * require 平台表内的 'react'；不 require 任何 Harness Client 包，控件按插件
 * 开发规范的 UI 规则自绘，颜色/圆角只用 `--dsw-alias-*` token。
 */
window.__ModuleLoader__.load({
  id: 'dsh-web-submit',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useCallback, useEffect, useRef, useState, useSyncExternalStore } = React

    /** 设置命名空间 = 本插件在 profile 里的条目 id。 */
    const NAMESPACE = 'dsh-web-submit'
    /** 承载通道选择的 volatile 字段名。 */
    const FIELD = 'transport'
    /** 本插件设置行文案的 locale 命名空间。 */
    const LOCALE_NS = 'settings.headless-transport'
    const STYLE_ID = 'dsh-web-submit-settings-css'
    const MENU_GAP = 4
    const VIEWPORT_MARGIN = 12

    /** 档位表。id 序列必须与 host 侧 Config.transport 的取值一致（auto/gateway/api）。 */
    const TRANSPORT_OPTIONS = Object.freeze([
      Object.freeze({ id: 'auto', label: '自动（gateway 优先）' }),
      Object.freeze({ id: 'gateway', label: 'gateway（进程内直调）' }),
      Object.freeze({ id: 'api', label: 'api（HTTP + 签名 Cookie）' }),
    ])
    const DEFAULT_ID = TRANSPORT_OPTIONS[0].id

    /** zh 是键集真源，en 必须同键集。 */
    const DICT = {
      zh: {
        'transport.title': 'headless 通道',
        'transport.hint': '首次提交时择一并固定；改完需重启 dsh web 才真正切换',
        'transport.saveFailed': '保存失败，请重试',
      },
      en: {
        'transport.title': 'Headless transport',
        'transport.hint': 'Chosen once at the first submission; restart dsh web to switch',
        'transport.saveFailed': 'Save failed, retry',
      },
    }
    /** locale 服务缺失时的回退标题。 */
    const FALLBACK_TITLE = DICT.zh['transport.title']
    const FALLBACK_HINT = DICT.zh['transport.hint']
    const FALLBACK_FAILED = DICT.zh['transport.saveFailed']

    /** 复刻相邻设置行的样式（只保留 --dsw-alias-* token）。 */
    const CSS = [
      '.dws-row{border-bottom:.5px solid var(--dsw-alias-border-l2);align-items:center;gap:8px;padding:16px 0;display:flex}',
      '.dws-rowText{flex-direction:column;flex:1;gap:4px;min-width:0;padding-right:48px;display:flex}',
      '.dws-title{color:var(--dsw-alias-label-primary);font-size:14px;font-weight:400;line-height:22px}',
      '.dws-hint{color:var(--dsw-alias-label-primary);opacity:.6;font-size:12px;line-height:18px}',
      '.dws-control{position:relative;display:flex;align-items:center;gap:8px}',
      '.dws-selector{border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);height:36px;font:inherit;color:var(--dsw-alias-label-primary);cursor:pointer;border:none;align-items:center;gap:12px;padding:0 14px;font-size:14px;line-height:22px;display:inline-flex}',
      '.dws-selector:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dws-selector:disabled{cursor:default;opacity:.5}',
      '.dws-chevron{flex:none}',
      '.dws-menu{position:fixed;z-index:1000;min-width:200px;padding:4px;border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-module-platform);box-shadow:0 6px 20px rgba(0,0,0,.18);display:flex;flex-direction:column;gap:2px}',
      '.dws-item{display:flex;align-items:center;justify-content:space-between;gap:12px;height:32px;padding:0 10px;border:none;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;line-height:22px;text-align:left;cursor:pointer}',
      '.dws-item:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dws-item:disabled{cursor:default;opacity:.5}',
      '.dws-item:focus-visible{outline:2px solid var(--dsw-alias-text-accent);outline-offset:-2px}',
      '.dws-item[aria-checked="true"]{font-weight:500}',
      '.dws-restart{border-radius:var(--dsw-radius-md);background:transparent;border:.5px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary);height:36px;padding:0 12px;font:inherit;font-size:13px;cursor:pointer;display:inline-flex;align-items:center;gap:6px;white-space:nowrap}',
      '.dws-restart:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.dws-restart:disabled{cursor:default;opacity:.5}',
      '.dws-restart[data-arming="true"]{border-color:var(--dsw-alias-text-accent);color:var(--dsw-alias-text-accent)}',
      // ── 侧边栏底部「重启 DSH」按钮（参考 dsh-web-restart 的 UX）──
      '.dws-rb{flex:none;align-items:center;width:100%;height:49px;color:var(--dsw-alias-label-primary);cursor:pointer;background:transparent;border:none;border-radius:12px;gap:8px;padding:0 8px 0 6px;font-family:inherit;font-size:14px;display:inline-flex;overflow:hidden;position:relative}',
      '.dws-rb:hover{background:var(--dsw-alias-bg-layer-2)}',
      '.dws-rb--armed{color:var(--dsw-alias-state-error-primary)}',
      '.dws-rb--armed:hover{background:var(--dsw-alias-state-error-primary);color:#fff}',
      '.dws-rb--rail{width:36px;height:36px;border-radius:50%;justify-content:center;gap:0;padding:0}',
      '.dws-rb__label{text-overflow:ellipsis;white-space:nowrap;min-width:0;overflow:hidden}',
      '.dws-dot{flex:none;width:8px;height:8px;border-radius:50%;display:inline-block;background:var(--dsw-alias-label-tertiary)}',
      '.dws-dot--ok{background:#22c55e;box-shadow:0 0 4px rgba(34,197,94,.6)}',
      '.dws-dot--down{background:#ef4444;box-shadow:0 0 4px rgba(239,68,68,.6)}',
      '.dws-dot--unknown{background:var(--dsw-alias-label-tertiary)}',
      '.dws-rb--rail .dws-dot{position:absolute;top:2px;right:2px;width:7px;height:7px}',
      '.dws-rb__status{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:16px;white-space:nowrap}',
    ].join('')

    const CHEVRON_D = 'M4 6L7.29289 9.29289C7.68342 9.68342 8.31658 9.68342 8.70711 9.29289L12 6'
    const CHECK_D = 'M2.25 8.5L5.49732 11.7473C5.90519 12.1552 6.57263 12.1344 6.95426 11.7018L13.75 4'

    /** 语言行的 chevron 图标（path 取自宿主 primitives，避免跨包 require）。 */
    function chevron() {
      return h(
        'svg',
        { width: 14, height: 14, viewBox: '0 0 16 16', fill: 'none', strokeWidth: 1, 'aria-hidden': true, className: 'dws-chevron' },
        h('path', { d: CHEVRON_D, stroke: 'currentColor' }),
      )
    }

    /** 选中项勾标。 */
    function check() {
      return h(
        'svg',
        { width: 16, height: 16, viewBox: '0 0 16 16', fill: 'none', strokeWidth: 1, 'aria-hidden': true },
        h('path', { d: CHECK_D, stroke: 'currentColor' }),
      )
    }

    /** 注入行样式（幂等：同一标签只插一次）。 */
    function ensureStyles() {
      if (typeof document === 'undefined') return
      if (document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]') !== null) return
      const tag = document.createElement('style')
      tag.dataset.plugin = 'dsh-web-submit'
      tag.dataset.pluginCss = STYLE_ID
      tag.textContent = CSS
      document.head.appendChild(tag)
    }

    /** 等重启后的实例回来：轮询 health 直到 200，超时返回 false。 */
    async function waitForHealth() {
      const deadline = Date.now() + 60000
      while (Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 1200))
        try {
          const res = await fetch('/x/headless/health', { cache: 'no-store' })
          if (res.ok) return true
        } catch {
          // 进程退出期间连接会被拒，继续等。
        }
      }
      return false
    }

    /**
     * 提交重启请求。
     * @returns 202 时为 null，否则为可直接展示的失败原因。
     */
    async function postRestart() {
      try {
        const res = await fetch('/x/headless/restart', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        })
        const body = await res.json().catch(() => ({}))
        if (res.status === 202) return null
        return body?.error || '重启被拒绝（HTTP ' + res.status + '）'
      } catch {
        return '重启请求发送失败'
      }
    }

    /**
     * 取生效档位：宿主文档里的值经 trim/小写归一后必须落在档位表内，否则（未设置/非法）
     * 回退默认档——归一规则与 host 侧 transportPreference() 一致，两侧取值才不会分叉。
     * @param snapshot - configForms 快照。
     */
    function pickId(snapshot) {
      const value = snapshot !== undefined && snapshot !== null ? snapshot.value : undefined
      const raw = value !== null && typeof value === 'object' ? value[FIELD] : undefined
      const normalized = typeof raw === 'string' ? raw.trim().toLowerCase() : raw
      return TRANSPORT_OPTIONS.some((option) => option.id === normalized) ? normalized : DEFAULT_ID
    }

    /**
     * 渲染「headless 通道」行。
     * @param props - slot props（含 locale 绑定后的 t）与闭包传入的 form。
     */
    function TransportRow({ form, t }) {
      const subscribe = useCallback((onChange) => form.subscribe(onChange), [form])
      const getSnapshot = useCallback(() => form.getSnapshot(), [form])
      const snapshot = useSyncExternalStore(subscribe, getSnapshot)

      const [open, setOpen] = useState(false)
      const [pending, setPending] = useState(false)
      const [failed, setFailed] = useState(false)
      const [position, setPosition] = useState(null)
      /** 重启按钮状态：idle → arming（4 秒内再点才执行）→ running → 页面自动刷新。 */
      const [restart, setRestart] = useState('idle')
      const [restartNote, setRestartNote] = useState('')
      const armTimer = useRef(null)
      const controlRef = useRef(null)
      const triggerRef = useRef(null)
      const menuRef = useRef(null)

      const activeId = pickId(snapshot)
      const activeLabel = (TRANSPORT_OPTIONS.find((option) => option.id === activeId) ?? TRANSPORT_OPTIONS[0]).label
      const writable = snapshot !== undefined && snapshot !== null && snapshot.writable === true
      const disabled = pending || !writable
      const title = typeof t === 'function' ? t('transport.title') : FALLBACK_TITLE
      const hint = typeof t === 'function' ? t('transport.hint') : FALLBACK_HINT
      const failedText = typeof t === 'function' ? t('transport.saveFailed') : FALLBACK_FAILED
      const restartLabel = restart === 'arming' ? '确认重启？' : restart === 'running' ? '重启中…' : '重启 dsh web'

      // 卸载时清掉武装计时器，避免组件销毁后仍 setState。
      useEffect(() => () => {
        if (armTimer.current !== null) clearTimeout(armTimer.current)
      }, [])

      // 打开时按触发器位置定位：fixed + 视口夹取，避免设置内容栏裁剪；打开期间随窗口
      // 缩放与任意滚动容器的滚动（capture 捕获）重算，菜单始终贴住触发器。贴底放不下
      // 且上方放得下时向上展开，避免菜单溢出视口下缘。
      useEffect(() => {
        if (!open) {
          setPosition(null)
          return undefined
        }
        const update = () => {
          const rect = triggerRef.current?.getBoundingClientRect()
          if (rect === undefined) return
          const menuHeight = menuRef.current?.offsetHeight || 160
          const right = Math.max(VIEWPORT_MARGIN, Math.round(window.innerWidth - rect.right))
          const flipUp =
            rect.bottom + MENU_GAP + menuHeight > window.innerHeight - VIEWPORT_MARGIN &&
            rect.top - MENU_GAP - menuHeight >= VIEWPORT_MARGIN
          setPosition(
            flipUp
              ? { right, bottom: Math.round(window.innerHeight - rect.top + MENU_GAP) }
              : { right, top: Math.round(rect.bottom + MENU_GAP) },
          )
        }
        update()
        window.addEventListener('resize', update)
        window.addEventListener('scroll', update, true)
        return () => {
          window.removeEventListener('resize', update)
          window.removeEventListener('scroll', update, true)
        }
      }, [open])

      // 打开即聚焦选中项；点击外部或 Escape 关闭（键盘可达性按菜单按钮惯例）。
      useEffect(() => {
        if (!open) return undefined
        const node = menuRef.current
        const active = node?.querySelector('[aria-checked="true"]')
        if (active !== null && active !== undefined) active.focus()
        const onPointerDown = (event) => {
          if (controlRef.current?.contains(event.target)) return
          setOpen(false)
        }
        const onKeyDown = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('mousedown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown)
        return () => {
          document.removeEventListener('mousedown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [open])

      /** 菜单内上下键与 Home/End 在项之间移动焦点。 */
      const onMenuKeyDown = (event) => {
        const buttons = Array.from(menuRef.current?.querySelectorAll('button') ?? [])
        if (buttons.length === 0) return
        const index = buttons.indexOf(document.activeElement)
        const next =
          event.key === 'ArrowDown'
            ? (index + 1) % buttons.length
            : event.key === 'ArrowUp'
              ? (index - 1 + buttons.length) % buttons.length
              : event.key === 'Home'
                ? 0
                : event.key === 'End'
                  ? buttons.length - 1
                  : -1
        if (next === -1) return
        event.preventDefault()
        buttons[next].focus()
      }

      /** 提交选择：写 volatile 字段；返回值非 true 时回读快照确认，确实未落盘才提示重试。 */
      const select = async (id) => {
        triggerRef.current?.focus()
        setOpen(false)
        if (id === activeId || disabled) return
        setPending(true)
        setFailed(false)
        try {
          const accepted = await form.set(FIELD, id)
          if (accepted !== true && pickId(form.getSnapshot()) !== id) setFailed(true)
        } catch {
          setFailed(true)
        } finally {
          setPending(false)
        }
      }

      /**
       * 手动重启 dsh web：第一下只武装，4 秒内第二下才执行（防误触）。
       * host 侧会先确认「有 systemd 托管」和「没有任务在跑」，任一不满足就拒绝。
       */
      const requestRestart = async () => {
        if (restart === 'running') return
        if (restart !== 'arming') {
          setRestart('arming')
          setRestartNote('')
          armTimer.current = setTimeout(() => setRestart('idle'), 4000)
          return
        }
        if (armTimer.current !== null) clearTimeout(armTimer.current)
        setRestart('running')
        setRestartNote('')
        const error = await postRestart()
        if (error !== null) {
          setRestart('failed')
          setRestartNote(error)
          return
        }
        if (await waitForHealth()) window.location.reload()
        else {
          setRestart('failed')
          setRestartNote('重启后 60 秒内没回来，请手动刷新页面')
        }
      }

      const items = TRANSPORT_OPTIONS.map((option) =>
        h(
          'button',
          {
            key: option.id,
            type: 'button',
            role: 'menuitemradio',
            'aria-checked': option.id === activeId,
            className: 'dws-item',
            disabled,
            onClick: () => void select(option.id),
          },
          h('span', null, option.label),
          option.id === activeId ? check() : null,
        ),
      )

      return h(
        'div',
        { className: 'dws-row' },
        h(
          'div',
          { className: 'dws-rowText' },
          h('div', { className: 'dws-title' }, title),
          h(
            'div',
            { className: 'dws-hint' },
            restartNote !== '' ? restartNote : failed === true ? failedText : hint,
          ),
        ),
        h(
          'div',
          { className: 'dws-control', ref: controlRef },
          h(
            'button',
            {
              type: 'button',
              className: 'dws-restart',
              'data-arming': restart === 'arming' ? 'true' : undefined,
              disabled: pending || restart === 'running',
              title: '退出本进程并由 systemd 拉起；有任务在跑或非 systemd 托管时会拒绝',
              onClick: () => void requestRestart(),
            },
            restartLabel,
          ),
          h(
            'button',
            {
              ref: triggerRef,
              type: 'button',
              className: 'dws-selector',
              disabled,
              'aria-haspopup': 'menu',
              'aria-expanded': open,
              onClick: () => setOpen((value) => !value),
            },
            activeLabel,
            chevron(),
          ),
          open
            ? h(
                'div',
                {
                  ref: menuRef,
                  className: 'dws-menu',
                  role: 'menu',
                  onKeyDown: onMenuKeyDown,
                  style:
                    position === null
                      ? // 未定位的首帧用 opacity 隐藏（visibility:hidden 的元素不可聚焦，
                        // 会让「打开即聚焦选中项」失效）；pointerEvents 挡住误触。
                        { opacity: 0, pointerEvents: 'none', top: 0, right: VIEWPORT_MARGIN }
                      : position.bottom === undefined
                        ? { top: position.top, right: position.right }
                        : // 向上展开：菜单底缘贴住触发器上缘。
                          { bottom: position.bottom, right: position.right },
                },
                items,
              )
            : null,
        ),
      )
    }

    /** 重启图标（refresh-cw，path 取自参考实现 dsh-web-restart）。 */
    function refreshIcon() {
      return h(
        'svg',
        {
          width: 14,
          height: 14,
          viewBox: '0 0 24 24',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
        },
        h('path', { d: 'M23 4v6h-6' }),
        h('path', { d: 'M20.49 15a9 9 0 1 1-2.12-9.36L23 10' }),
      )
    }

    /**
     * 侧边栏底部「重启 DSH」按钮：单击即触发（host 侧拒绝「有任务在跑」与「非 systemd 托管」），
     * 右侧一个 5 秒轮询的在线状态点。
     * @param props - slot props（`wide` 决定展开态还是收起态）。
     */
    function SidebarRestartButton({ wide }) {
      const [phase, setPhase] = useState('idle')
      const [message, setMessage] = useState('')
      const [health, setHealth] = useState('checking')

      // 每 5 秒探一次 /x/headless/health：fetch 失败或非 200 视为离线。
      useEffect(() => {
        let alive = true
        const check = () => {
          fetch('/x/headless/health', { cache: 'no-store' })
            .then((res) => {
              if (alive) setHealth(res.ok ? 'ok' : 'down')
            })
            .catch(() => {
              if (alive) setHealth('down')
            })
        }
        check()
        const timer = setInterval(check, 5000)
        return () => {
          alive = false
          clearInterval(timer)
        }
      }, [])

      const click = async () => {
        if (phase === 'sending' || phase === 'done') return
        setPhase('sending')
        setMessage('')
        const error = await postRestart()
        if (error !== null) {
          setPhase('error')
          setMessage(error)
          return
        }
        setPhase('done')
        setMessage('重启中，页面会自动刷新')
        if (await waitForHealth()) window.location.reload()
        else {
          setPhase('error')
          setMessage('60 秒内没回来，请手动刷新页面')
        }
      }

      const label =
        phase === 'sending' ? '重启中…' : phase === 'done' ? '已触发' : phase === 'error' ? '失败' : '重启 DSH'
      const title = message !== '' ? message : '点击后 dsh web 退出并由 systemd 拉起（约 10-20 秒）'
      const statusText = health === 'ok' ? 'dsh 在线' : health === 'down' ? 'dsh 离线' : '检测中…'
      const dotClass =
        'dws-dot' +
        (health === 'ok' ? ' dws-dot--ok' : health === 'down' ? ' dws-dot--down' : ' dws-dot--unknown')
      const className =
        'dws-rb' + (wide === true ? '' : ' dws-rb--rail') + (phase === 'sending' || phase === 'done' ? ' dws-rb--armed' : '')

      return h(
        'button',
        {
          type: 'button',
          className,
          title,
          'aria-label': '重启 dsh web',
          disabled: phase === 'sending',
          onClick: () => void click(),
        },
        refreshIcon(),
        wide === true ? h('span', { className: 'dws-rb__label' }, label) : null,
        wide === true ? h('span', { className: 'dws-rb__status' }, statusText) : null,
        h('span', { className: dotClass, title: statusText, 'aria-label': statusText }),
      )
    }

    return {
      inject: ['slots', 'locale', 'configForms'],
      /**
       * 注册设置行与字典。
       * @param ctx - client cordis 上下文。
       */
      apply(ctx) {
        ctx.effect(() => {
          ensureStyles()
          return () => {
            if (typeof document === 'undefined') return
            document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]')?.remove()
          }
        }, 'dsh-web-submit: settings row styles')
        const form = ctx.configForms.get(NAMESPACE)
        ctx.effect(() => ctx.locale.register(LOCALE_NS, DICT), 'dsh-web-submit: dictionary')
        /** 组件身份在 apply 期固定（form 经闭包注入，避免每次渲染重挂）。 */
        const Row = (props) => h(TransportRow, { ...props, form })
        ctx.slots.inject('settings.general.item', () =>
          ctx.slots.register(
            { name: 'settings.general.item', id: 'headless-transport', order: 6, locale: LOCALE_NS },
            Row,
          ),
        )
        // 侧边栏底部：一键重启（UX 参考 1123762794/dsh-web-restart，重启动作走本插件的
        // /x/headless/restart + systemd，不依赖外部脚本）。
        ctx.slots.inject('sidebar.footer.action', () =>
          ctx.slots.register(
            { name: 'sidebar.footer.action', id: 'headless-restart', order: -100, label: () => '重启 DSH' },
            SidebarRestartButton,
          ),
        )
      },
      /** 档位表的导出面：供单测锁定与 host 侧一致。 */
      TRANSPORT_OPTIONS,
      /** 纯逻辑导出面：供单测锁定归一规则与样式幂等。 */
      _internals: { pickId, ensureStyles },
    }
  },
})
