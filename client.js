/**
 * dsh-task-alert —— 浏览器半边（client half）
 *
 * 加载方式：DSH 的模块系统按 package.json 的 dsh.client 声明，把本文件作为
 * /plugins/dsh-task-alert/client.js 送进页面；这里只做一件事——注册一个 factory。
 * 所以本文件必须是「普通脚本」：不能有顶层 import / export。
 *
 * 能力：
 *   1. 订阅宿主 /task-alert/events 的 SSE 推流 → 右上角弹卡片；页面在后台时同时发系统通知。
 *   2. 在 DSH 设置页注册「任务提醒」一节（slots 服务可用时），配置全部集中在那里。
 *   3. 卡片上的「设置」打开同一份配置的精简面板（设置页不可用时也能改）。
 *
 * 配置的真源在宿主：$DSH_HOME/dsh-task-alert/config.json，经 GET/POST /task-alert/config 读写。
 * 这里只缓存一份副本，收到 hello 帧 / 打开设置页 / 保存后更新。
 */

window.__ModuleLoader__.load({
  id: 'dsh-task-alert',
  factory: function (require) {
    var module = { exports: {} };
    var exports = module.exports;

    var TAG = '[task-alert]';
    var DEFAULT_CONFIG = {
      enabled: true,
      notifyDone: true,
      notifyError: true,
      notifyTruncated: true,
      notifyApproval: true,
      inPage: true,
      osNotification: true,
      sound: true,
      raiseWindow: true,
      dismissOnFocus: true,
      dismissSeconds: 12,
      maxCards: 5,
    };

    var KIND_TO_CONFIG = {
      done: 'notifyDone',
      error: 'notifyError',
      truncated: 'notifyTruncated',
      approval: 'notifyApproval',
    };

    /** @type {any} apply(ctx) 注入的 cordis 上下文（跳会话用） */
    var ctxRef = null;
    /** 配置缓存（真源在宿主） */
    var config = Object.assign({}, DEFAULT_CONFIG);
    /** 设置页注册的现场取证：控制台里 `__dshTaskAlert.state()` 就能看到卡在哪一步 */
    var diag = {
      react: false,
      hasSlots: false,
      hasInject: false,
      registered: false,
      via: null,
      error: null,
    };
    /** React（平台种子模块；拿不到就不注册设置页那一节，其余照常） */
    var reactRef = null;
    function getReact() {
      if (reactRef) return reactRef;
      try {
        reactRef = require('react');
        diag.react = Boolean(reactRef);
      } catch (error) {
        diag.error = 'require("react"): ' + (error && error.message ? error.message : String(error));
        console.warn(TAG + ' react 不可用（设置页入口会被跳过）：' + error);
      }
      return reactRef;
    }
    getReact();

    // ---------------------------------------------------------------- 配置读写

    function adoptConfig(next) {
      if (!next || typeof next !== 'object') return config;
      for (var key in DEFAULT_CONFIG) {
        if (!Object.prototype.hasOwnProperty.call(next, key)) continue;
        var value = next[key];
        if (typeof DEFAULT_CONFIG[key] === 'boolean') {
          if (typeof value === 'boolean') config[key] = value;
        } else if (typeof value === 'number' && Number.isFinite(value)) {
          config[key] = value;
        }
      }
      return config;
    }

    function loadConfig() {
      return fetch('/task-alert/config', { cache: 'no-store' })
        .then(function (response) {
          if (!response.ok) throw new Error('HTTP ' + response.status);
          return response.json();
        })
        .then(function (payload) {
          return adoptConfig(payload && payload.config);
        })
        .catch(function () {
          return config;
        });
    }

    function saveConfig(patch) {
      return fetch('/task-alert/config', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(patch),
      })
        .then(function (response) {
          if (!response.ok) throw new Error('HTTP ' + response.status);
          return response.json();
        })
        .then(function (payload) {
          adoptConfig(payload && payload.config);
          return true;
        })
        .catch(function (error) {
          console.warn(TAG + ' 保存配置失败：' + error);
          return false;
        });
    }

    // ---------------------------------------------------------------- 样式

    var CARD_CSS = [
      '.dta-root{position:fixed;top:14px;right:14px;z-index:2147483000;display:flex;flex-direction:column;gap:10px;pointer-events:none;font:13px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;max-width:min(360px,calc(100vw - 28px))}',
      '.dta-card{pointer-events:auto;box-sizing:border-box;width:100%;border-radius:13px;border:1px solid var(--dsw-alias-border-secondary,rgba(122,140,175,.30));background:var(--dsw-specific-input-major,#fff);color:var(--dsw-alias-label-primary,#1b1e26);box-shadow:0 12px 32px rgba(8,14,30,.20),0 2px 6px rgba(8,14,30,.10);padding:12px 14px 11px;display:flex;flex-direction:column;gap:8px;animation:dta-in .18s cubic-bezier(.2,.9,.3,1.2);overflow:hidden;position:relative}',
      '.dta-card::before{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--dta-accent,#4c6ef5)}',
      '.dta-card.dta-done{--dta-accent:#2f9e44}',
      '.dta-card.dta-error{--dta-accent:#e03131}',
      '.dta-card.dta-truncated{--dta-accent:#f08c00}',
      '.dta-card.dta-approval{--dta-accent:#f59f00}',
      '.dta-card.dta-test,.dta-card.dta-permission{--dta-accent:#4c6ef5}',
      '.dta-card.dta-out{animation:dta-out .16s ease-in forwards}',
      '.dta-head{display:flex;align-items:center;gap:8px}',
      '.dta-badge{flex:0 0 auto;width:20px;height:20px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-size:12px;font-weight:700;background:var(--dta-accent,#4c6ef5);line-height:1}',
      '.dta-title{flex:1 1 auto;font-weight:600;font-size:13.5px;letter-spacing:.1px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dta-close{flex:0 0 auto;border:0;background:transparent;color:var(--dsw-alias-label-tertiary,#8a90a0);cursor:pointer;font-size:15px;line-height:1;padding:2px 4px;border-radius:6px}',
      '.dta-close:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(122,140,175,.14));color:var(--dsw-alias-label-primary,#1b1e26)}',
      '.dta-body{color:var(--dsw-alias-label-secondary,#4a5061);white-space:pre-wrap;word-break:break-word;max-height:9em;overflow:auto}',
      '.dta-meta{color:var(--dsw-alias-label-tertiary,#8a90a0);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}',
      '.dta-foot{display:flex;align-items:center;gap:8px;justify-content:flex-end}',
      '.dta-btn{pointer-events:auto;border-radius:8px;border:1px solid var(--dsw-alias-border-secondary,rgba(122,140,175,.35));background:transparent;color:var(--dsw-alias-label-primary,#1b1e26);font:inherit;font-size:12.5px;padding:4px 10px;cursor:pointer}',
      '.dta-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(122,140,175,.14))}',
      '.dta-btn.dta-primary{border-color:transparent;background:var(--dta-accent,#4c6ef5);color:#fff}',
      '.dta-btn.dta-primary:hover{filter:brightness(1.08)}',
      '.dta-row{display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none;padding:2px 0}',
      '.dta-row input[type=checkbox]{accent-color:var(--dta-accent,#4c6ef5);cursor:pointer}',
      '.dta-row input[type=number]{width:64px;padding:2px 6px;border-radius:6px;border:1px solid var(--dsw-alias-border-secondary,rgba(122,140,175,.35));background:transparent;color:inherit;font:inherit}',
      '.dta-group{border-top:1px solid var(--dsw-alias-border-secondary,rgba(122,140,175,.22));margin-top:8px;padding-top:8px;display:flex;flex-direction:column;gap:2px}',
      '.dta-hint{color:var(--dsw-alias-label-tertiary,#8a90a0);font-size:12px;margin:0}',
      '.dta-settings{display:flex;flex-direction:column;gap:6px;font-size:13px;line-height:1.6;color:var(--dsw-alias-label-primary,#1b1e26);max-width:640px}',
      '.dta-settings h3{margin:10px 0 2px;font-size:13px;font-weight:600}',
      '.dta-settings .dta-saved{color:#2f9e44;font-size:12px}',
      '.dta-settings .dta-failed{color:#e03131;font-size:12px}',
      '.dta-settings input[type=checkbox]{accent-color:#4c6ef5;margin-right:8px;cursor:pointer}',
      '.dta-settings input[type=number]{width:72px;margin:0 6px;padding:2px 6px;border-radius:6px;border:1px solid var(--dsw-alias-border-secondary,rgba(122,140,175,.35));background:transparent;color:inherit;font:inherit}',
      '.dta-settings label{display:flex;align-items:center;cursor:pointer}',
      '.dta-settings .dta-actions{display:flex;gap:8px;align-items:center;margin-top:12px}',
      '.dta-settings .dta-actions button{border-radius:8px;border:1px solid var(--dsw-alias-border-secondary,rgba(122,140,175,.35));background:transparent;color:inherit;font:inherit;font-size:13px;padding:5px 14px;cursor:pointer}',
      '.dta-settings .dta-actions button.dta-primary{border-color:transparent;background:#4c6ef5;color:#fff}',
      '@keyframes dta-in{from{opacity:0;transform:translateY(-8px) scale(.97)}to{opacity:1;transform:none}}',
      '@keyframes dta-out{to{opacity:0;transform:translateY(-6px) scale(.98)}}',
      '@media (prefers-reduced-motion:reduce){.dta-card{animation:none}.dta-card.dta-out{animation:none;opacity:0}}',
    ].join('');

    function installStyle() {
      if (document.querySelector('style[data-dsh-task-alert]') !== null) return;
      var tag = document.createElement('style');
      tag.setAttribute('data-dsh-task-alert', 'dsh-task-alert/style');
      tag.textContent = CARD_CSS;
      document.head.appendChild(tag);
    }

    // ---------------------------------------------------------------- 卡片

    function ensureRoot() {
      var root = document.querySelector('.dta-root');
      if (root) return root;
      root = document.createElement('div');
      root.className = 'dta-root';
      root.setAttribute('role', 'status');
      root.setAttribute('aria-live', 'polite');
      (document.body || document.documentElement).appendChild(root);
      return root;
    }

    var KIND_META = {
      done: { badge: '✓', title: '任务完成' },
      error: { badge: '!', title: '生成失败' },
      truncated: { badge: '…', title: '输出被截断' },
      approval: { badge: '?', title: '等待审批' },
      test: { badge: '★', title: '测试提醒' },
      permission: { badge: '★', title: '提醒设置' },
    };

    function kindLabel(kind) {
      var meta = KIND_META[kind];
      return meta ? meta.title : '提醒';
    }
    function kindBadge(kind) {
      var meta = KIND_META[kind];
      return meta ? meta.badge : 'i';
    }

    function makeEl(tag, className, text) {
      var el = document.createElement(tag);
      if (className) el.className = className;
      if (text !== undefined && text !== null) el.textContent = String(text);
      return el;
    }

    function dismiss(card) {
      if (!card || card.dataset.gone === '1') return;
      card.dataset.gone = '1';
      if (card._timer) clearTimeout(card._timer);
      card.classList.add('dta-out');
      setTimeout(function () {
        if (card.parentNode) card.parentNode.removeChild(card);
        var root = document.querySelector('.dta-root');
        if (root && root.childNodes.length === 0) root.remove();
      }, 170);
    }

    function trimCards() {
      var root = document.querySelector('.dta-root');
      if (!root) return;
      var limit = Math.max(1, Math.min(10, Math.round(config.maxCards) || 5));
      // 只数"还开着"的卡片：关闭有 170ms 出场动画，DOM 节点不会立刻消失，
      // 按 childNodes.length 判断会一直循环、把卡片全部丢光（真踩过的坑）。
      var open = Array.prototype.slice.call(root.childNodes).filter(function (node) {
        return node.dataset && node.dataset.gone !== '1';
      });
      for (var i = 0; i < open.length - limit; i += 1) dismiss(open[i]);
    }

    /** 一回到 DSH（窗口重新聚焦 / 页面重新可见）就把还挂着的卡片全收掉。
     *  审批卡也收：回到界面时 DSH 自己的审批面板就在输入框上方，卡片留着只是碍事。 */
    function dismissAllCards() {
      var root = document.querySelector('.dta-root');
      if (!root) return;
      Array.prototype.slice.call(root.childNodes).forEach(function (node) {
        if (node && node.dataset && node.dataset.gone !== '1') dismiss(node);
      });
    }

    /** 页面是否在"用户眼前"：可见且持有焦点。不在眼前才需要系统通知。 */
    function pageIsActive() {
      try {
        return document.visibilityState === 'visible' && document.hasFocus();
      } catch {
        return true;
      }
    }

    /** 人话标识：会话名优先，其次项目名，实在没有才说"本轮对话"——绝不甩一串 id 给用户看。 */
    function sessionLabel(frame) {
      if (frame.sessionTitle) return '会话「' + frame.sessionTitle + '」';
      if (frame.project) return '项目「' + frame.project + '」里的这轮对话';
      return '本轮对话';
    }

    function describe(frame) {
      if (frame.kind === 'approval') {
        var tool = frame.toolName ? '工具 ' + frame.toolName + ' 请求越权执行' : '有操作等待你批准';
        return {
          title: kindLabel('approval'),
          body: (frame.reason ? frame.reason + '\n' : '') + tool,
          accent: 'approval',
        };
      }
      if (frame.kind === 'done') {
        return { title: kindLabel('done'), body: sessionLabel(frame) + '已结束，可以看结果了。', accent: 'done' };
      }
      if (frame.kind === 'error') {
        return {
          title: kindLabel('error'),
          body: (frame.message || '生成过程出错了，点开看看。') + '\n' + sessionLabel(frame),
          accent: 'error',
        };
      }
      if (frame.kind === 'truncated') {
        return {
          title: kindLabel('truncated'),
          body: sessionLabel(frame) + '的输出触到上限被截断了。',
          accent: 'truncated',
        };
      }
      return { title: kindLabel(frame.kind), body: frame.body || frame.message || '', accent: 'test' };
    }

    /** 这条提醒属于哪个项目 / 哪次对话 —— 只写"有操作要审批"等于什么都没说。 */
    function contextOf(frame) {
      var parts = [];
      if (frame.project) parts.push('项目：' + frame.project);
      if (frame.sessionTitle) parts.push('会话：' + frame.sessionTitle);
      if (frame.toolName && frame.kind === 'approval') parts.push('工具：' + frame.toolName);
      return parts;
    }

    function showCard(frame) {
      if (!config.inPage) return null;
      installStyle();
      var root = ensureRoot();
      var info = describe(frame);
      var card = makeEl('div', 'dta-card dta-' + (info.accent || 'test'));
      card.dataset.kind = String(frame.kind);
      if (frame.sessionId) card.dataset.sessionId = frame.sessionId;
      if (frame.toolName) card.dataset.toolName = frame.toolName;

      var head = makeEl('div', 'dta-head');
      head.appendChild(makeEl('span', 'dta-badge', kindBadge(frame.kind)));
      head.appendChild(makeEl('span', 'dta-title', info.title));
      var close = makeEl('button', 'dta-close', '×');
      close.type = 'button';
      close.title = '关闭';
      close.addEventListener('click', function () {
        dismiss(card);
      });
      head.appendChild(close);
      card.appendChild(head);

      card.appendChild(makeEl('div', 'dta-body', info.body));

      var metaParts = contextOf(frame);
      if (metaParts.length) card.appendChild(makeEl('div', 'dta-meta', metaParts.join(' · ')));

      var foot = makeEl('div', 'dta-foot');
      var gear = makeEl('button', 'dta-btn', '设置');
      gear.type = 'button';
      gear.addEventListener('click', function () {
        showQuickSettings();
      });
      foot.appendChild(gear);

      if (frame.sessionId) {
        var open = makeEl('button', 'dta-btn dta-primary', '查看会话');
        open.type = 'button';
        open.addEventListener('click', function () {
          focusAndOpen(frame.sessionId, false);
          dismiss(card);
        });
        foot.appendChild(open);
      }
      card.appendChild(foot);

      // 审批卡常驻（等人处理），其余按配置的秒数自动消失；鼠标悬停时暂停计时
      var seconds = Math.round(config.dismissSeconds) || 0;
      if (frame.kind === 'approval' || seconds <= 0) {
        card.dataset.sticky = '1';
      } else {
        var arm = function () {
          if (card._timer) clearTimeout(card._timer);
          card._timer = setTimeout(function () {
            dismiss(card);
          }, seconds * 1000);
        };
        card.addEventListener('mouseenter', function () {
          if (card._timer) clearTimeout(card._timer);
        });
        card.addEventListener('mouseleave', arm);
        arm();
      }

      root.appendChild(card);
      trimCards();
      return card;
    }

    // ---------------------------------------------------------------- 卡片里的精简设置

    function showQuickSettings() {
      installStyle();
      var root = ensureRoot();
      var card = makeEl('div', 'dta-card dta-permission');
      card.dataset.kind = 'settings';
      card.dataset.sticky = '1';

      var head = makeEl('div', 'dta-head');
      head.appendChild(makeEl('span', 'dta-badge', '⚙'));
      head.appendChild(makeEl('span', 'dta-title', '提醒设置'));
      var close = makeEl('button', 'dta-close', '×');
      close.type = 'button';
      close.addEventListener('click', function () {
        dismiss(card);
      });
      head.appendChild(close);
      card.appendChild(head);

      var rows = [
        ['osNotification', '后台时发系统通知'],
        ['inPage', '在页面右上角弹卡片'],
        ['sound', '播放提示音'],
        ['raiseWindow', '点通知后把窗口叫到前台'],
        ['dismissOnFocus', '回到 DSH 时自动收起'],
      ];
      rows.forEach(function (row) {
        var label = makeEl('label', 'dta-row');
        var input = document.createElement('input');
        input.type = 'checkbox';
        input.checked = Boolean(config[row[0]]);
        input.addEventListener('change', function () {
          // 先本地生效：开关不该等一个来回才起作用
          config[row[0]] = input.checked;
          var patch = {};
          patch[row[0]] = input.checked;
          void saveConfig(patch);
          if (row[0] === 'osNotification' && input.checked) requestOsPermission();
        });
        label.appendChild(input);
        label.appendChild(document.createTextNode(row[1]));
        card.appendChild(label);
      });

      var secondsRow = makeEl('label', 'dta-row');
      secondsRow.appendChild(document.createTextNode('卡片保留 '));
      var secondsInput = document.createElement('input');
      secondsInput.type = 'number';
      secondsInput.min = '0';
      secondsInput.max = '600';
      secondsInput.step = '1';
      secondsInput.value = String(config.dismissSeconds);
      secondsInput.addEventListener('change', function () {
        var value = Math.min(600, Math.max(0, Math.round(Number(secondsInput.value) || 0)));
        config.dismissSeconds = value;
        secondsInput.value = String(value);
        var patch = {};
        patch.dismissSeconds = value;
        void saveConfig(patch).then(function () {
          secondsInput.value = String(config.dismissSeconds);
        });
      });
      secondsRow.appendChild(secondsInput);
      secondsRow.appendChild(document.createTextNode(' 秒（0 = 不自动关闭）'));
      card.appendChild(secondsRow);

      card.appendChild(
        makeEl(
          'div',
          'dta-meta',
          typeof Notification === 'undefined'
            ? '当前环境没有系统通知能力，只能看页内卡片。'
            : '更多选项在「设置 → 任务提醒」；系统通知权限：' + Notification.permission,
        ),
      );

      var foot = makeEl('div', 'dta-foot');
      var test = makeEl('button', 'dta-btn', '试一下');
      test.type = 'button';
      test.addEventListener('click', function () {
        fetch('/task-alert/test', { cache: 'no-store' }).catch(function (error) {
          console.warn(TAG + ' 触发测试提醒失败：' + error);
        });
      });
      foot.appendChild(test);
      var ok = makeEl('button', 'dta-btn dta-primary', '知道了');
      ok.type = 'button';
      ok.addEventListener('click', function () {
        dismiss(card);
      });
      foot.appendChild(ok);
      card.appendChild(foot);

      root.appendChild(card);
      trimCards();
    }

    // ---------------------------------------------------------------- 设置页那一节（React）

    function makeSettingsSection() {
      var React = getReact();
      if (!React || typeof React.createElement !== 'function') return null;
      var h = React.createElement;

      function toggleRow(state, patch, key, text) {
        return h(
          'label',
          { key: key },
          h('input', {
            type: 'checkbox',
            checked: Boolean(state[key]),
            onChange: function (event) {
              patch(key, event.target.checked);
            },
          }),
          text,
        );
      }

      return function TaskAlertSettings() {
        var stateHook = React.useState(Object.assign({}, config));
        var state = stateHook[0];
        var setState = stateHook[1];
        var messageHook = React.useState('');
        var message = messageHook[0];
        var setMessage = messageHook[1];

        React.useEffect(function () {
          void loadConfig().then(function (next) {
            setState(Object.assign({}, next));
          });
        }, []);

        function patch(key, value) {
          var next = Object.assign({}, state);
          next[key] = value;
          setState(next);
        }

        function patchNumber(key, value, fallback) {
          var num = Number(value);
          if (!Number.isFinite(num)) num = fallback;
          patch(key, Math.round(num));
        }

        function save() {
          void saveConfig(state).then(function (ok) {
            setMessage(ok ? '已保存' : '保存失败（看浏览器控制台）');
            setTimeout(function () {
              setMessage('');
            }, 2400);
          });
        }

        function test() {
          fetch('/task-alert/test', { cache: 'no-store' }).catch(function (error) {
            console.warn(TAG + ' 触发测试提醒失败：' + error);
          });
        }

        return h(
          'div',
          { className: 'dta-settings' },
          h(
            'p',
            { className: 'dta-hint' },
            '任务跑完 / 生成失败 / 输出被截断 / 有操作等你批准时提醒你。DSH 在后台时走系统通知（Windows 原生 toast），前台时弹页面右上角的卡片。',
          ),

          h('h3', null, '总开关'),
          toggleRow(state, patch, 'enabled', '启用任务提醒'),

          h('h3', null, '提醒哪几类'),
          toggleRow(state, patch, 'notifyApproval', '有操作等我批准'),
          toggleRow(state, patch, 'notifyDone', '一轮对话跑完'),
          toggleRow(state, patch, 'notifyError', '生成失败'),
          toggleRow(state, patch, 'notifyTruncated', '输出被截断（触到上限）'),

          h('h3', null, '怎么提醒'),
          toggleRow(state, patch, 'inPage', '页面右上角弹卡片'),
          toggleRow(state, patch, 'osNotification', '窗口在后台时发系统通知'),
          toggleRow(state, patch, 'sound', '播放提示音'),
          toggleRow(state, patch, 'raiseWindow', '点系统通知后把窗口叫到前台'),
          toggleRow(state, patch, 'dismissOnFocus', '回到 DSH 时自动收起弹窗'),

          h('h3', null, '卡片节奏'),
          h(
            'label',
            null,
            '保留',
            h('input', {
              type: 'number',
              min: 0,
              max: 600,
              step: 1,
              value: String(state.dismissSeconds),
              onChange: function (event) {
                patchNumber('dismissSeconds', event.target.value, 12);
              },
            }),
            '秒后自动关闭（0 = 不自动关闭；审批卡永远等你处理）',
          ),
          h(
            'label',
            null,
            '最多同时显示',
            h('input', {
              type: 'number',
              min: 1,
              max: 10,
              step: 1,
              value: String(state.maxCards),
              onChange: function (event) {
                patchNumber('maxCards', event.target.value, 5);
              },
            }),
            '张（超出丢最旧的）',
          ),

          h(
            'div',
            { className: 'dta-actions' },
            h(
              'button',
              { type: 'button', className: 'dta-primary', onClick: save },
              '保存',
            ),
            h('button', { type: 'button', onClick: test }, '试一下'),
            message
              ? h('span', { className: message === '已保存' ? 'dta-saved' : 'dta-failed' }, message)
              : null,
          ),
          h('p', { className: 'dta-hint' }, '配置文件：$DSH_HOME/dsh-task-alert/config.json（手改也生效）'),
        );
      };
    }

    // ---------------------------------------------------------------- 系统通知

    var audioCtx = null;

    function blip(kind) {
      if (!config.sound) return;
      try {
        var AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        if (!audioCtx) audioCtx = new AC();
        if (audioCtx.state === 'suspended') audioCtx.resume().catch(function () {});
        var t0 = audioCtx.currentTime;
        var tones = kind === 'approval' ? [880, 1180] : [660];
        tones.forEach(function (freq, index) {
          var osc = audioCtx.createOscillator();
          var gain = audioCtx.createGain();
          var start = t0 + index * 0.12;
          osc.type = 'sine';
          osc.frequency.value = freq;
          gain.gain.setValueAtTime(0.0001, start);
          gain.gain.exponentialRampToValueAtTime(0.05, start + 0.012);
          gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.16);
          osc.connect(gain);
          gain.connect(audioCtx.destination);
          osc.start(start);
          osc.stop(start + 0.18);
        });
      } catch (error) {
        /* 声音是锦上添花，失败就算了 */
      }
    }

    function osTitle(frame) {
      if (frame.kind === 'approval') return 'DSH 需要你批准';
      if (frame.kind === 'done') return 'DSH 任务完成';
      if (frame.kind === 'error') return 'DSH 生成失败';
      if (frame.kind === 'truncated') return 'DSH 输出被截断';
      return 'DSH 提醒';
    }

    function osBody(frame) {
      var info = describe(frame);
      var body = info.body || info.title;
      var parts = contextOf(frame);
      if (parts.length) body = body + '\n' + parts.join(' · ');
      if (body.length > 240) body = body.slice(0, 239) + '…';
      return body;
    }

    function osNotify(frame) {
      if (!config.osNotification) return;
      if (typeof Notification === 'undefined') return;
      if (Notification.permission !== 'granted') return;
      try {
        var notification = new Notification(osTitle(frame), {
          body: osBody(frame),
          tag: 'dsh-task-alert',
          silent: false,
          requireInteraction: frame.kind === 'approval',
        });
        notification.onclick = function () {
          try {
            notification.close();
          } catch {
            /* 已经关了 */
          }
          focusAndOpen(frame.sessionId, true);
        };
      } catch (error) {
        console.warn(TAG + ' 系统通知发送失败：' + error);
      }
    }

    var askedPermission = false;

    function requestOsPermission() {
      if (typeof Notification === 'undefined') return;
      if (Notification.permission !== 'default') return;
      try {
        var result = Notification.requestPermission(function () {
          /* 旧式回调签名，忽略即可 */
        });
        if (result && typeof result.catch === 'function') result.catch(function () {});
      } catch (error) {
        console.warn(TAG + ' 申请通知权限失败：' + error);
      }
    }

    function maybeAskPermission() {
      if (askedPermission) return;
      askedPermission = true;
      if (typeof Notification === 'undefined') return;
      if (Notification.permission !== 'default') return;
      if (!config.osNotification) return;
      var card = showCard({
        kind: 'permission',
        body: '允许 DSH 在后台发系统通知吗？点下面的「开启」（只想看页内卡片可以不点）。',
      });
      if (!card) return;
      var foot = card.querySelector('.dta-foot');
      if (!foot) return;
      var btn = makeEl('button', 'dta-btn dta-primary', '开启');
      btn.type = 'button';
      btn.addEventListener('click', function () {
        requestOsPermission();
        dismiss(card);
      });
      foot.insertBefore(btn, foot.firstChild);
    }

    // ---------------------------------------------------------------- 跳会话 / 叫窗口

    function serviceOf(ctx, names) {
      for (var i = 0; i < names.length; i += 1) {
        try {
          var found = ctx && typeof ctx.get === 'function' ? ctx.get(names[i]) : null;
          if (found) return found;
        } catch (error) {
          /* 服务不存在就算了 */
        }
      }
      return null;
    }

    function focusAndOpen(sessionId, raise) {
      if (sessionId) {
        var workspace = serviceOf(ctxRef, ['uiWorkspace', 'workspace', 'uiSession']);
        if (workspace && typeof workspace.openSession === 'function') {
          try {
            workspace.openSession(sessionId);
          } catch (error) {
            console.warn(TAG + ' 切换会话失败：' + error);
          }
        } else {
          console.warn(TAG + ' 找不到会话切换服务（uiWorkspace），只把窗口叫到前台');
        }
      }
      try {
        window.focus();
      } catch {
        /* 忽略 */
      }
      // 页面里点卡片时窗口本来就在眼前，不用叫；点系统通知时窗口很可能在后台，
      // 走一次 dsh://open（DSH 桌面版注册的协议）把最小化的主窗口拉起来。
      if (!raise || !config.raiseWindow) return;
      if (!/electron/i.test(navigator.userAgent || '')) return;
      try {
        var frame = document.createElement('iframe');
        frame.style.display = 'none';
        frame.src = 'dsh://open';
        document.body.appendChild(frame);
        setTimeout(function () {
          if (frame.parentNode) frame.parentNode.removeChild(frame);
        }, 1000);
      } catch (error) {
        /* 浏览器里导航 dsh:// 会弹拦截框，已经按 UA 排除了 */
      }
    }

    // ---------------------------------------------------------------- 帧分发

    var seen = Object.create(null);
    var seenCount = 0;
    var lastSeq = 0;

    function rememberFrame(frame) {
      if (typeof frame.seq !== 'number') return true;
      if (seen[frame.seq]) return false;
      seen[frame.seq] = true;
      seenCount += 1;
      if (frame.seq > lastSeq) lastSeq = frame.seq;
      if (seenCount > 500) {
        seen = Object.create(null);
        seenCount = 0;
      }
      return true;
    }

    function handleFrame(frame) {
      if (!frame || typeof frame !== 'object') return;
      if (frame.kind === 'hello') {
        if (typeof frame.seq === 'number' && frame.seq > lastSeq) lastSeq = frame.seq;
        if (frame.config) adoptConfig(frame.config);
        return;
      }
      if (frame.kind === 'approval-done') {
        closeApprovalCards(frame);
        return;
      }
      if (!rememberFrame(frame)) return;
      // 宿主已经按配置过滤过一次，这里再挡一层：改完设置立刻生效，不等重连
      var key = KIND_TO_CONFIG[frame.kind];
      if (!config.enabled) return;
      if (key && !config[key]) return;
      showCard(frame);
      var active = pageIsActive();
      if (!active) osNotify(frame);
      if (!active || frame.kind === 'approval') blip(frame.kind);
    }

    function closeApprovalCards(frame) {
      var root = document.querySelector('.dta-root');
      if (!root) return;
      var nodes = Array.prototype.slice.call(root.childNodes);
      nodes.forEach(function (node) {
        if (!node.dataset || node.dataset.kind !== 'approval') return;
        if (frame.sessionId && node.dataset.sessionId && node.dataset.sessionId !== frame.sessionId) return;
        if (frame.toolName && node.dataset.toolName && node.dataset.toolName !== frame.toolName) return;
        dismiss(node);
      });
    }

    // ---------------------------------------------------------------- 事件流

    var es = null;
    var reconnectTimer = null;
    var disposed = false;
    var disposeRef = null;

    function scheduleReconnect(delay) {
      if (disposed || reconnectTimer) return;
      reconnectTimer = setTimeout(function () {
        reconnectTimer = null;
        connect();
      }, delay || 3000);
    }

    function catchUp() {
      fetch('/task-alert/pending?since=' + lastSeq, { cache: 'no-store' })
        .then(function (response) {
          if (!response.ok) throw new Error('HTTP ' + response.status);
          return response.json();
        })
        .then(function (payload) {
          var items = payload && Array.isArray(payload.items) ? payload.items : [];
          // 断线期间攒下的旧提醒不刷屏：只补最近 3 条
          items.slice(-3).forEach(handleFrame);
        })
        .catch(function () {
          /* 宿主半边没起来时静默 */
        });
    }

    function connect() {
      if (disposed) return;
      if (typeof EventSource === 'undefined') {
        setInterval(catchUp, 2000);
        return;
      }
      try {
        es = new EventSource('/task-alert/events');
      } catch (error) {
        console.warn(TAG + ' 建立提醒流失败：' + error);
        scheduleReconnect(5000);
        return;
      }
      es.onopen = function () {
        catchUp();
      };
      es.onmessage = function (event) {
        if (!event || typeof event.data !== 'string') return;
        var frame;
        try {
          frame = JSON.parse(event.data);
        } catch (error) {
          console.warn(TAG + ' 收到无法解析的提醒帧');
          return;
        }
        try {
          handleFrame(frame);
        } catch (error) {
          console.warn(TAG + ' 处理提醒失败：' + error);
        }
      };
      es.onerror = function () {
        if (!es) return;
        if (es.readyState === 2) {
          try {
            es.close();
          } catch {
            /* 忽略 */
          }
          es = null;
          scheduleReconnect(3000);
        }
      };
    }

    function onVisible() {
      var visible = document.visibilityState === 'visible';
      // 回到 DSH 就清场：卡片的任务是"叫你回来"，回来了就该让位
      if (visible && config.dismissOnFocus) dismissAllCards();
      if (visible && es === null) connect();
      if (visible) catchUp();
    }

    // ---------------------------------------------------------------- 装配

    function install() {
      installStyle();
      void loadConfig();
      connect();
      document.addEventListener('visibilitychange', onVisible);
      window.addEventListener('focus', onVisible);
      setTimeout(maybeAskPermission, 1200);

      var dispose = function dispose() {
        disposed = true;
        document.removeEventListener('visibilitychange', onVisible);
        window.removeEventListener('focus', onVisible);
        if (reconnectTimer) clearTimeout(reconnectTimer);
        if (es) {
          try {
            es.close();
          } catch {
            /* 忽略 */
          }
          es = null;
        }
        var root = document.querySelector('.dta-root');
        if (root) root.remove();
        var style = document.querySelector('style[data-dsh-task-alert]');
        if (style) style.remove();
      };
      disposeRef = dispose;
      return dispose;
    }

    function registerSettingsSection(ctx) {
      var section = makeSettingsSection();
      if (!section) {
        diag.error = 'react 不可用，跳过设置页注册';
        return;
      }
      if (diag.registered) return;

      // 逐字照抄 dsh-pet（也在本机跑着、设置页那一节能出来）的写法：
      //   ctx.slots.inject('settings.section', function* () { yield ctx.slots.register({...}, Component) })
      // 生命周期交给插槽自己管，不额外套 ctx.effect。
      var tryWithSlots = function (slots, label) {
        if (!slots || typeof slots.inject !== 'function' || diag.registered) return false;
        try {
          slots.inject('settings.section', function* () {
            yield slots.register(
              {
                name: 'settings.section',
                id: 'task-alert',
                order: 40,
                label: function () {
                  return '任务提醒';
                },
                inject: function () {
                  return {};
                },
              },
              section,
            );
          });
          diag.registered = true;
          diag.via = label;
          return true;
        } catch (error) {
          diag.error = label + ': ' + (error && error.message ? error.message : String(error));
          console.warn(TAG + ' 注册设置页失败（' + label + '）：' + error);
          return false;
        }
      };

      // 1) 首选：slots 已经是就绪服务（本插件 inject 里声明了它，正常情况下就到这一步）
      if (tryWithSlots(ctx && ctx.slots, 'ctx.slots')) return;

      // 2) 退路：用动态注入等 slots 就绪
      try {
        if (ctx && typeof ctx.inject === 'function') {
          ctx.inject(['slots'], function (scope) {
            tryWithSlots(scope && scope.slots, 'ctx.inject(scope)');
          });
        }
      } catch (error) {
        diag.error = 'ctx.inject: ' + (error && error.message ? error.message : String(error));
      }

      // 3) 再退一步：服务可能稍晚就绪，过一会儿再看一眼
      if (!diag.registered) {
        setTimeout(function () {
          if (!diag.registered) tryWithSlots(ctxRef && ctxRef.slots, 'retry(ctx.slots)');
        }, 2500);
      }
    }

    function apply(ctx) {
      ctxRef = ctx;
      diag.hasSlots = Boolean(ctx && ctx.slots);
      diag.hasInject = Boolean(ctx && typeof ctx.inject === 'function');
      var dispose = null;
      try {
        dispose = install();
      } catch (error) {
        console.error(TAG + ' 初始化失败：' + error);
      }
      registerSettingsSection(ctx);
      if (ctx && typeof ctx.effect === 'function') {
        ctx.effect(function () {
          return function () {
            if (dispose) dispose();
          };
        }, 'task-alert: 弹窗与提醒流');
      }
    }

    // 控制台自测入口
    try {
      window.__dshTaskAlert = {
        simulate: function (frame) {
          handleFrame(Object.assign({ kind: 'done' }, frame || {}));
        },
        settings: function () {
          showQuickSettings();
          return config;
        },
        config: function () {
          return config;
        },
        state: function () {
          return diag;
        },
        reload: loadConfig,
        test: function () {
          return fetch('/task-alert/test', { cache: 'no-store' });
        },
        dispose: function () {
          if (disposeRef) disposeRef();
        },
      };
    } catch (error) {
      /* 只读页面也无妨 */
    }

    exports.name = 'task-alert-client';
    // slots：设置页那一节要注册进 settings.section 插槽（与 dsh-pet / ui-approval 同样的静态依赖写法）
    exports.inject = ['slots'];
    exports.apply = apply;
    return module.exports;
  },
});
