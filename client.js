window.__ModuleLoader__.load({
  id: 'dsh-surfcore-slang-engine',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback } = React;

    const api = async (path, body) => {
      const res = await fetch(`/api/slang-engine/${path}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        cache: 'no-store',
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      return res.json().catch(() => ({}));
    };

    const S = {
      box: { border: '1px solid rgba(127,127,127,.28)', borderRadius: 10, padding: '12px 14px', marginBottom: 12 },
      row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 8 },
      input: { padding: '6px 10px', borderRadius: 8, border: '1px solid rgba(127,127,127,.4)', background: 'transparent', color: 'inherit', fontSize: 13 },
      btn: (primary, disabled) => ({
        padding: '5px 12px', borderRadius: 8, fontSize: 13,
        cursor: disabled ? 'not-allowed' : 'pointer',
        border: primary ? '1px solid transparent' : '1px solid rgba(127,127,127,.4)',
        background: primary ? '#3b6fe0' : 'transparent',
        color: primary ? '#fff' : 'inherit',
        opacity: disabled ? 0.5 : 1,
      }),
      meta: { fontSize: 12, opacity: 0.7, marginTop: 6 },
      tab: (active) => ({
        padding: '4px 10px', borderRadius: 999, fontSize: 12, cursor: 'pointer',
        border: '1px solid rgba(127,127,127,.4)',
        background: active ? 'rgba(59,111,224,.18)' : 'transparent',
      }),
      table: { width: '100%', borderCollapse: 'collapse', fontSize: 12, marginTop: 8 },
      th: { textAlign: 'left', padding: '6px 8px', borderBottom: '1px solid rgba(127,127,127,.25)', opacity: 0.7, fontWeight: 500 },
      td: { padding: '6px 8px', borderBottom: '1px solid rgba(127,127,127,.12)', verticalAlign: 'top' },
      tag: { fontSize: 11, padding: '1px 6px', borderRadius: 6, background: 'rgba(127,127,127,.15)', marginLeft: 4 },
    };

    const TABS = [
      { id: 'candidate', label: '候选' },
      { id: 'confirmed', label: '已确认' },
      { id: 'rejected', label: '已拒绝' },
      { id: '', label: '全部' },
    ];

    function SettingsPage() {
      const [status, setStatus] = useState(null);
      const [settings, setSettings] = useState({ confirmMode: 'manual', enabled: true });
      const [overrides, setOverrides] = useState('');
      const [tab, setTab] = useState('candidate');
      const [query, setQuery] = useState('');
      const [words, setWords] = useState([]);
      const [selected, setSelected] = useState([]);
      const [common, setCommon] = useState(null);
      const [newWord, setNewWord] = useState('');
      const [preview, setPreview] = useState(null);
      const [probe, setProbe] = useState('');
      const [group, setGroup] = useState('1064722459');
      const [note, setNote] = useState(null);
      const [busy, setBusy] = useState(false);
      const [editing, setEditing] = useState(null);
      const [platform, setPlatform] = useState('qq');

      const notify = (kind, text) => setNote({ kind, text });

      const refreshStatus = useCallback(async () => {
        const d = await api('status');
        if (d?.ok === false) { notify('error', d.error ?? '读不到状态'); return; }
        setStatus(d);
        setSettings(d.settings ?? settings);
        setOverrides(Object.entries(d.settings?.groupOverrides ?? {}).map(([k, v]) => `${k}=${v}`).join('\n'));
      }, []);

      const refreshWords = useCallback(async () => {
        const params = new URLSearchParams({ limit: '200' });
        if (tab) params.set('status', tab);
        if (query.trim()) params.set('q', query.trim());
        const d = await api(`words?${params.toString()}`);
        if (d?.ok) { setWords(d.words ?? []); setSelected([]); }
      }, [tab, query]);

      const refreshCommon = useCallback(async () => {
        const d = await api('common-words');
        if (d?.ok) setCommon(d);
      }, []);

      useEffect(() => { void refreshStatus(); void refreshCommon(); }, [refreshStatus, refreshCommon]);
      useEffect(() => { void refreshWords(); }, [refreshWords]);

      const saveSettings = async () => {
        setBusy(true);
        const groupOverrides = {};
        for (const line of overrides.split('\n')) {
          const [g, mode] = line.split('=').map((s) => s.trim());
          if (g && (mode === 'auto' || mode === 'manual')) groupOverrides[g] = mode;
        }
        const d = await api('settings', {
          settings: {
            confirmMode: settings.confirmMode,
            enabled: settings.enabled,
            injectEnabled: settings.injectEnabled !== false,
            qq: settings.qq,
            groupOverrides,
            commonWords: { ...(settings.commonWords ?? {}), buildMode: settings.commonWords?.buildMode ?? 'regex' },
          },
        });
        setBusy(false);
        if (d?.ok === false) { notify('error', d.error); return; }
        setSettings(d.settings);
        notify('ok', '设置已保存');
        void refreshStatus();
      };

      const batch = async (path, ids) => {
        if (!ids.length) { notify('error', '先勾选词条'); return; }
        const d = await api(path, { ids });
        if (d?.ok === false) { notify('error', d.error); return; }
        notify('ok', `已处理 ${ids.length} 条`);
        await refreshWords();
        await refreshStatus();
      };

      const startEdit = (word) => setEditing({
        id: word.id,
        meaning: word.meaning ?? '',
        usage: word.usage ?? '',
        example: word.example ?? '',
      });

      const saveEdit = async () => {
        if (!editing) return;
        const d = await api('words/edit', {
          id: editing.id,
          patch: { meaning: editing.meaning, usage: editing.usage, example: editing.example },
        });
        if (d?.ok === false) { notify('error', d.error); return; }
        setEditing(null);
        notify('ok', '已保存');
        await refreshWords();
      };

      const toggle = (id) => {
        setSelected((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
      };

      const runPreview = async () => {
        const d = await api(`context?key=group%3A${encodeURIComponent(group)}&q=${encodeURIComponent(probe)}`);
        setPreview(d?.ok === false ? { error: d.error } : d);
      };

      const addCommon = async () => {
        if (!newWord.trim()) return;
        const d = await api('common-words', { action: 'add', word: newWord.trim() });
        if (d?.ok === false) { notify('error', d.error); return; }
        setNewWord('');
        await refreshCommon();
      };

      const removeCommon = async (word) => {
        const d = await api('common-words', { action: 'remove', word });
        if (d?.ok === false) { notify('error', d.error); return; }
        await refreshCommon();
      };

      const requestRefresh = async () => {
        const d = await api('common-words', { action: 'refresh' });
        notify(d?.ok === false ? 'error' : 'ok', d?.ok === false ? d.error : '已请求刷新，桥接下次唤醒时会尝试');
        await refreshCommon();
      };

      if (!status) return h('div', { style: S.box }, note?.text ?? '加载中…');

      const platformTabs = h('div', {
        style: { ...S.row, marginTop: 0, marginBottom: 10, borderBottom: '1px solid rgba(127,127,127,.2)', paddingBottom: 8 },
      },
        h('button', { style: S.tab(platform === 'qq'), onClick: () => setPlatform('qq') }, 'QQ'),
        h('button', { style: S.tab(platform === 'bili'), onClick: () => setPlatform('bili') }, 'B站'),
      );

      if (platform === 'bili') return h('div', null, platformTabs, h(BiliSettingsPage));

      const s = status.summary ?? {};
      const by = s.byStatus ?? {};
      const cost = status.cost ?? {};
      const today = cost.today ?? {};

      return h('div', null,
        platformTabs,
        h('div', { style: S.box },
          h('div', { style: { fontSize: 15, fontWeight: 600 } }, '网络用语学习引擎'),
          h('div', { style: S.meta }, `词库：${s.total ?? 0} 条 · 候选 ${by.candidate ?? 0} · 已确认 ${by.confirmed ?? 0} · 已拒绝 ${by.rejected ?? 0} · 有含义 ${s.withMeaning ?? 0}`),
          h('div', { style: S.meta }, `今日：提取 ${today.extract ?? 0} 次 · 研究 ${today.research ?? 0} 次 · 新增 ${today.added ?? 0} · 自动确认 ${today.autoConfirmed ?? 0} · 花费 ¥${Number(today.costCNY ?? 0).toFixed(2)}`),
          h('div', { style: S.meta }, `最近 7 天：提取 ${cost.last7?.extract ?? 0} 次 · token ${cost.last7?.tokens ?? 0} · 花费 ¥${Number(cost.last7?.costCNY ?? 0).toFixed(2)}`),
          h('div', { style: S.meta }, `文件：${status.file}`),
          h('label', { style: { ...S.row, marginTop: 10 } },
            h('input', { type: 'checkbox', checked: settings.enabled !== false, onChange: (e) => setSettings({ ...settings, enabled: e.target.checked }) }),
            ' 启用网络用语学习（关掉：不注入、不自动确认、不研究）',
          ),
          h('label', { style: { ...S.row } },
            h('input', { type: 'checkbox', checked: settings.injectEnabled !== false, onChange: (e) => setSettings({ ...settings, injectEnabled: e.target.checked }) }),
            ' 自动把黑话表拼进提示词（关掉后改为模型主动查：qq_slang_query / slang_lookup）',
          ),
        ),

        h('div', { style: S.box },
          h('div', { style: { fontSize: 14, fontWeight: 600 } }, '确认挡位'),
          h('div', { style: S.row },
            h('label', null, h('input', { type: 'radio', checked: settings.confirmMode !== 'auto', onChange: () => setSettings({ ...settings, confirmMode: 'manual' }) }), ' 手动'),
            h('label', null, h('input', { type: 'radio', checked: settings.confirmMode === 'auto', onChange: () => setSettings({ ...settings, confirmMode: 'auto' }) }), ' 自动'),
            h('span', { style: S.meta }, '自动挡：2 次、2 个群友、含义 high 才转正；私聊恒手动'),
          ),
          h('div', { style: S.meta }, '按群覆盖，每行一个：群号=auto 或 群号=manual（没写的继承全局）'),
          h('textarea', {
            style: { ...S.input, width: '100%', minHeight: 60, marginTop: 6, fontFamily: 'inherit' },
            value: overrides,
            onChange: (e) => setOverrides(e.target.value),
            placeholder: '1064722459=auto\n563186862=manual',
          }),
          h('div', { style: S.row },
            h('button', { style: S.btn(true, busy), disabled: busy, onClick: () => void saveSettings() }, '保存设置'),
            note ? h('span', { style: { fontSize: 12, color: note.kind === 'error' ? '#c0504d' : '#3f8f4f' } }, note.text) : null,
          ),
        ),

        h('div', { style: S.box },
          h('div', { style: { fontSize: 14, fontWeight: 600 } }, '词条'),
          h('div', { style: S.row },
            TABS.map((t) => h('span', { key: t.id || 'all', style: S.tab(tab === t.id), onClick: () => setTab(t.id) }, t.label)),
            h('input', { style: { ...S.input, flex: 1, minWidth: 140 }, value: query, placeholder: '搜词或含义', onChange: (e) => setQuery(e.target.value) }),
            h('button', { style: S.btn(false, false), onClick: () => void refreshWords() }, '刷新'),
          ),
          h('div', { style: S.row },
            h('button', { style: S.btn(false, !selected.length), onClick: () => void batch('words/confirm', selected) }, '批量确认'),
            h('button', { style: S.btn(false, !selected.length), onClick: () => void batch('words/reject', selected) }, '批量拒绝'),
            h('button', { style: S.btn(false, !selected.length), onClick: () => void batch('words/delete', selected) }, '批量删除'),
            tab === 'rejected'
              ? h('button', { style: S.btn(false, !selected.length), onClick: () => void batch('words/restore', selected) }, '恢复为候选')
              : null,
            h('span', { style: S.meta }, `已选 ${selected.length}`),
          ),
          h('table', { style: S.table },
            h('thead', null, h('tr', null,
              h('th', { style: S.th }, ''),
              h('th', { style: S.th }, '词'),
              h('th', { style: S.th }, '含义'),
              h('th', { style: S.th }, '次数'),
              h('th', { style: S.th }, '群友'),
              h('th', { style: S.th }, '置信'),
              h('th', { style: S.th }, '状态'),
              h('th', { style: S.th }, '操作'),
            )),
            h('tbody', null, words.map((w) => {
              const isEditing = editing?.id === w.id;
              return h('tr', { key: w.id },
                h('td', { style: S.td }, h('input', { type: 'checkbox', checked: selected.includes(w.id), onChange: () => toggle(w.id) })),
                h('td', { style: S.td }, w.content, w.groupIds?.length ? h('span', { style: S.tag }, `${w.groupIds.length} 群`) : null),
                h('td', { style: { ...S.td, opacity: w.meaning || isEditing ? 1 : 0.45 } },
                  isEditing
                    ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 260 } },
                      h('textarea', {
                        style: { ...S.input, width: '100%', minHeight: 54, fontFamily: 'inherit' },
                        value: editing.meaning,
                        placeholder: '含义',
                        onChange: (e) => setEditing({ ...editing, meaning: e.target.value }),
                      }),
                      h('input', {
                        style: { ...S.input, width: '100%' },
                        value: editing.usage,
                        placeholder: '用法（什么时候用）',
                        onChange: (e) => setEditing({ ...editing, usage: e.target.value }),
                      }),
                      h('input', {
                        style: { ...S.input, width: '100%' },
                        value: editing.example,
                        placeholder: '例句（可选）',
                        onChange: (e) => setEditing({ ...editing, example: e.target.value }),
                      }),
                    )
                    : (w.meaning || '（无）'),
                ),
                h('td', { style: S.td }, String(w.count ?? 0)),
                h('td', { style: S.td }, String(w.senders ?? 0)),
                h('td', { style: S.td }, w.confidence || '-'),
                h('td', { style: S.td }, w.status),
                h('td', { style: S.td },
                  isEditing
                    ? h('span', null,
                      h('button', { style: S.btn(true, false), onClick: () => void saveEdit() }, '保存'),
                      ' ',
                      h('button', { style: S.btn(false, false), onClick: () => setEditing(null) }, '取消'),
                    )
                    : h('span', null,
                      h('button', { style: S.btn(false, false), onClick: () => startEdit(w) }, '编辑'),
                      ' ',
                      h('button', { style: S.btn(false, false), onClick: () => void batch('words/confirm', [w.id]) }, '确认'),
                      ' ',
                      h('button', { style: S.btn(false, false), onClick: () => void batch('words/reject', [w.id]) }, '拒绝'),
                    ),
                ),
              );
            })),
          ),
          !words.length ? h('div', { style: S.meta }, '没有符合条件的词条') : null,
        ),

        h('div', { style: S.box },
          h('div', { style: { fontSize: 14, fontWeight: 600 } }, '大众词表'),
          h('div', { style: S.meta }, `自动 ${common?.words?.length ?? 0} 条 · 手工 ${common?.manual?.length ?? 0} 条${common?.updatedAt ? ` · 更新于 ${String(common.updatedAt).slice(0, 16).replace('T', ' ')}` : ''}`),
          h('div', { style: S.row },
            h('span', { style: S.meta }, '抽法：'),
            h('select', {
              value: settings.commonWords?.buildMode ?? common?.buildMode ?? 'regex',
              onChange: (e) => setSettings({ ...settings, commonWords: { ...(settings.commonWords ?? {}), buildMode: e.target.value } }),
              style: { ...S.input, padding: '4px 8px' },
            },
              h('option', { value: 'regex' }, '正则（省钱）'),
              h('option', { value: 'model' }, '模型（干净）'),
            ),
            h('input', { style: { ...S.input, minWidth: 140 }, value: newWord, placeholder: '加一个大众词', onChange: (e) => setNewWord(e.target.value) }),
            h('button', { style: S.btn(false, false), onClick: () => void addCommon() }, '添加'),
            h('button', { style: S.btn(false, false), onClick: () => void requestRefresh() }, '立即刷新'),
          ),
          h('div', { style: { ...S.row, maxHeight: 160, overflow: 'auto', alignItems: 'flex-start' } },
            (common?.manual ?? []).map((w) => h('span', { key: `m-${w}`, style: { ...S.tag, cursor: 'pointer' }, title: '点击删除', onClick: () => void removeCommon(w) }, `${w} ×`)),
            (common?.words ?? []).slice(0, 80).map((w) => h('span', { key: `w-${w}`, style: S.tag }, w)),
          ),
        ),

        h('div', { style: S.box },
          h('div', { style: { fontSize: 14, fontWeight: 600 } }, '抓取速率（QQ）'),
          h('div', { style: S.meta }, '多少分钟抓一次、一次拿多少素材、一次最多入库几条：'),
          h('div', { style: S.row },
            h('label', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 } }, '间隔(分钟)',
              h('input', { type: 'number', min: 5, max: 1440, style: { ...S.input, width: 90 }, value: settings.qq?.collect?.intervalMinutes ?? 30, onChange: (e) => setSettings({ ...settings, qq: { ...(settings.qq ?? {}), collect: { ...(settings.qq?.collect ?? {}), intervalMinutes: Number(e.target.value) || 30 } } }) })),
            h('label', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 } }, '每次素材条数',
              h('input', { type: 'number', min: 5, max: 80, style: { ...S.input, width: 90 }, value: settings.qq?.collect?.batchSize ?? 20, onChange: (e) => setSettings({ ...settings, qq: { ...(settings.qq ?? {}), collect: { ...(settings.qq?.collect ?? {}), batchSize: Number(e.target.value) || 20 } } }) })),
            h('label', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 } }, '每次最多入库',
              h('input', { type: 'number', min: 1, max: 10, style: { ...S.input, width: 90 }, value: settings.qq?.collect?.maxItemsPerRun ?? 5, onChange: (e) => setSettings({ ...settings, qq: { ...(settings.qq ?? {}), collect: { ...(settings.qq?.collect ?? {}), maxItemsPerRun: Number(e.target.value) || 5 } } }) })),
          ),
        ),

        h('div', { style: S.box },
          h('div', { style: { fontSize: 14, fontWeight: 600 } }, '注入预览'),
          h('div', { style: S.meta }, '输入一条群消息，看这一轮会带进提示词的是哪几条：'),
          h('div', { style: S.row },
            h('input', { style: { ...S.input, width: 130 }, value: group, onChange: (e) => setGroup(e.target.value), placeholder: '群号' }),
            h('input', { style: { ...S.input, flex: 1 }, value: probe, onChange: (e) => setProbe(e.target.value), placeholder: '例如：这条鱼也太肥了吧' }),
            h('button', { style: S.btn(false, false), onClick: () => void runPreview() }, '预览'),
          ),
          preview ? h('pre', { style: { marginTop: 8, padding: 10, background: 'rgba(127,127,127,.08)', borderRadius: 8, whiteSpace: 'pre-wrap', fontSize: 12 } },
            preview.error ?? (preview.block || '（这一轮不会注入任何词条）')) : null,
        ),
      );
    }

    function BiliSettingsPage() {
      const [status, setStatus] = useState(null);
      const [settings, setSettings] = useState(null);
      const [words, setWords] = useState([]);
      const [tab, setTab] = useState('candidate');
      const [selected, setSelected] = useState([]);
      const [note, setNote] = useState(null);
      const [busy, setBusy] = useState(false);

      const notify = (kind, text) => setNote({ kind, text });
      const loadWords = useCallback(async () => {
        const d = await api(`words?platform=bili&limit=300${tab ? `&status=${tab}` : ''}`);
        setWords(d.words ?? []);
        setSelected([]);
      }, [tab]);

      useEffect(() => {
        void (async () => {
          const s = await api('status');
          setStatus(s);
          setSettings(s.settings ?? {});
        })();
      }, []);
      useEffect(() => { void loadWords(); }, [loadWords]);

      const save = async () => {
        setBusy(true);
        const d = await api('settings', { settings: { ...settings } });
        setBusy(false);
        if (d?.ok === false) { notify('error', d.error); return; }
        setSettings(d.settings);
        notify('ok', '已保存');
      };

      const batch = async (path) => {
        if (!selected.length) return;
        const d = await api(path, { ids: selected });
        if (d?.ok === false) { notify('error', d.error); return; }
        notify('ok', '已更新');
        await loadWords();
      };

      const act = async (path, id) => {
        const d = await api(path, { ids: [id] });
        if (d?.ok === false) { notify('error', d.error); return; }
        notify('ok', '已更新');
        await loadWords();
      };

      if (!settings) return h('div', { style: S.box }, '加载中…');
      const b = settings.bili ?? {};
      const c = b.comments ?? {};
      const setBili = (patch) => setSettings({
        ...settings,
        bili: { ...b, ...patch, comments: { ...c, ...(patch.comments ?? {}) }, collect: { ...(b.collect ?? {}), ...(patch.collect ?? {}) } },
      });
      const field = (label, value, onChange, attrs = {}) => h('label', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 } },
        h('span', { style: { opacity: 0.75, minWidth: 96 } }, label),
        h('input', { style: { ...S.input, width: 90 }, value, onChange: (e) => onChange(e.target.value), ...attrs }),
      );

      return h('div', null,
        h('div', { style: { ...S.box, borderColor: 'rgba(230,160,40,.55)', background: 'rgba(230,160,40,.07)' } },
          h('div', { style: { fontSize: 15, fontWeight: 700 } }, '网络用语学习引擎 · B站（实验性）'),
          h('div', { style: S.meta }, 'B站 评论抓取可能触发风控，默认关闭；A 管线只整理已有素材（视频/评论/日记），相对安全。',
          h('div', { style: S.meta }, '风险说明：B站 有反爬风控，频繁或大量抓取可能触发 412/账号限制。本功能只读公开评论、不点赞不发言；建议低频使用（每天 ≤3 个视频、每视频 ≤20 条、间隔 ≥30 秒）。')),
        ),

        h('div', { style: S.box },
          h('div', { style: { fontSize: 14, fontWeight: 600 } }, '采集设置'),
          h('div', { style: S.row },
            h('label', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 } },
              h('input', { type: 'checkbox', checked: b.enabled !== false, onChange: (e) => setBili({ enabled: e.target.checked }) }),
              ' 启用 B站 语料整理'),
          ),
          h('div', { style: S.row },
            field('间隔(分钟)', b.collect?.intervalMinutes ?? 1440, (v) => setBili({ collect: { intervalMinutes: Math.max(5, Number(v) || 1440) } }), { type: 'number', min: 5, max: 10080 }),
            field('每次素材条数', b.collect?.batchSize ?? 30, (v) => setBili({ collect: { batchSize: Math.max(5, Number(v) || 30) } }), { type: 'number', min: 5, max: 120 }),
            field('每次最多入库', b.collect?.maxItemsPerRun ?? 5, (v) => setBili({ collect: { maxItemsPerRun: Math.max(1, Number(v) || 5) } }), { type: 'number', min: 1, max: 10 }),
            field('素材字数上限', b.maxChars ?? 8000, (v) => setBili({ maxChars: Number(v) || 0 }), { type: 'number', min: 1000, max: 20000 }),
          ),
          h('div', { style: { ...S.row, marginTop: 12 } },
            h('label', { style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 } },
              h('input', { type: 'checkbox', checked: c.enabled === true, onChange: (e) => setBili({ comments: { enabled: e.target.checked } }) }),
              ' 实验性：抓取公开评论（只读，有频控）'),
          ),
          h('div', { style: S.row },
            field('每天视频数', c.videosPerDay ?? 3, (v) => setBili({ comments: { videosPerDay: Number(v) || 1 } }), { type: 'number', min: 1, max: 10 }),
            field('每视频条数', c.perVideo ?? 20, (v) => setBili({ comments: { perVideo: Math.min(20, Number(v) || 10) } }), { type: 'number', min: 5, max: 20 }),
            field('请求间隔(ms)', c.minGapMs ?? 30000, (v) => setBili({ comments: { minGapMs: Number(v) || 1000 } }), { type: 'number', min: 1000, max: 120000 }),
            field('评论字数上限', c.maxChars ?? 12000, (v) => setBili({ comments: { maxChars: Number(v) || 1000 } }), { type: 'number', min: 1000, max: 30000 }),
          ),
          h('div', { style: S.row },
            h('button', { style: S.btn(true, busy), disabled: busy, onClick: () => void save() }, '保存设置'),
            note ? h('span', { style: { fontSize: 12, color: note.kind === 'error' ? '#d33' : '#2a7' } }, note.text) : null,
          ),
        ),

        h('div', { style: S.box },
          h('div', { style: { fontSize: 14, fontWeight: 600 } }, 'B站 词条'),
          h('div', { style: S.meta }, `候选 ${status?.byPlatform?.bili?.candidate ?? 0} · 已确认 ${status?.byPlatform?.bili?.confirmed ?? 0} · 已拒绝 ${status?.byPlatform?.bili?.rejected ?? 0}`),
          h('div', { style: S.row }, TABS.map((x) => h('button', { key: x.id || 'all', style: S.tab(tab === x.id), onClick: () => setTab(x.id) }, x.label))),
          h('div', { style: S.row },
            h('button', { style: S.btn(false, selected.length === 0), disabled: selected.length === 0, onClick: () => void batch('words/confirm') }, `确认选中（${selected.length}）`),
            h('button', { style: S.btn(false, selected.length === 0), disabled: selected.length === 0, onClick: () => void batch('words/reject') }, `拒绝选中（${selected.length}）`),
          ),
          h('table', { style: S.table }, h('tbody', null,
            words.length === 0
              ? h('tr', null, h('td', { style: S.td }, '（这一页还是空的）'))
              : words.map((w) => h('tr', { key: w.id },
                h('td', { style: S.td }, h('input', { type: 'checkbox', checked: selected.includes(w.id), onChange: () => setSelected(selected.includes(w.id) ? selected.filter((x) => x !== w.id) : [...selected, w.id]) })),
                h('td', { style: S.td }, w.content, w.groupIds?.length ? h('span', { style: S.tag }, `${w.groupIds.length} 群`) : null),
                h('td', { style: { ...S.td, opacity: w.meaning ? 1 : 0.45 } }, w.meaning || '（无含义）'),
                h('td', { style: S.td }, String(w.count ?? 0)),
                h('td', { style: S.td }, w.status),
                h('td', { style: S.td },
                  h('button', { style: S.btn(false, false), onClick: () => void act('words/confirm', w.id) }, '确认'),
                  ' ',
                  h('button', { style: S.btn(false, false), onClick: () => void act('words/reject', w.id) }, '拒绝'),
                ),
              )),
          )),
        ),
      );
    }
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () =>
          ctx.slots.register(
            { name: 'settings.section', id: 'slang-engine', order: 72, label: '网络用语学习引擎' },
            SettingsPage,
          ),
        );

      },
    };
  },
});

