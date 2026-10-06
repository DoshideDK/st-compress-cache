/*
 * 压缩 (Compress)
 * SillyTavern 第三方 UI 扩展
 *
 * 功能：上下文压缩（两种模式）
 *     - 手动模式（默认）：压缩“上一次压缩点之后”的全部消息；也可指定条数。
 *     - 自动模式：用户每发送 N 条消息（编辑重发不计入），在当次回复结束后
 *       自动压缩上次压缩点之后的消息。自动模式开启时仍可随时手动压缩。
 *     触发入口：设置面板按钮、输入框旁“选项”菜单（重新生成/AI帮答/续写 同级）、/compress 命令。
 *     可设置“保留最近 N 条不压缩”，摘要插在这些消息之前。
 *     可指定一个 Chat Completion 预设，执行期间临时切换、结束后切回。
 */

// 设置存储键：保持 compress_cache 不变，改名会让已有用户的压缩配置全部丢失。
const MODULE_NAME = 'compress_cache';
const LOG = '[压缩]';

// 旧版「缓存断点」功能与已移除的「改写上一条」功能遗留的设置键，加载时清理一次。
// connRewrite 是对象，单独在 getSettings 里删除。
const LEGACY_SETTING_KEYS = Object.freeze([
    'cacheMode', 'gpDefault', 'gp5m', 'gp1h',
    'bpCompression', 'bpLastAssistant', 'bpInput',
    'menuRewrite', 'rewriteUseMainPreset', 'rewritePreset', 'rewriteDiffMode',
    'rewriteToolRepair', 'rewriteStream', 'rewritePrompt',
    'compressKeepLast',   // 已拆分为 compressKeepLastManual / compressKeepLastAuto
]);

let isCompressing = false;
// 使用主路径预设时，由拦截器以追加 user 消息的方式注入任务指令
let pendingTaskInjection = null;


const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    menuCompress: true,         // 是否在左下角“选项”菜单注入“压缩上下文”

    // —— 压缩 ——
    compressUseMainPreset: false, // 开启时使用主路径的预设、世界书和聊天上下文
    compressPreset: '',           // 压缩时临时切换到的 Chat Completion 预设；空为跟随当前
    compressPrompt:
        'You are a context compressor for a roleplay chat. Faithfully compress the ' +
        'conversation below into one concise memory summary. Preserve key plot points, ' +
        'character states and relationships, locations, promises made, and unresolved ' +
        'threads. Drop greetings and repetition. Write in third person, past tense, in ' +
        'the same language as the conversation. Output only the summary text, with no ' +
        'preamble and no explanations.',
    compressRole: 'assistant',  // 摘要写回时的角色：assistant / user
    hideOriginals: true,        // 压缩后是否把原始消息隐藏出上下文
    compressKeepLastManual: 2,  // 手动压缩（立即压缩按钮 / 选项菜单 / 斜杠命令）保留最近 N 条不压缩
    compressKeepLastAuto: 4,    // 自动压缩保留最近 N 条不压缩（摘要插在这 N 条之前，它们保持可见）
    compressIncludeKept: false, // 保留的 N 条是否也发送给模型并一起总结
    compressIncludePrevSummary: true, // 之前的摘要也发送并合并进新摘要，压缩后一起隐藏
    summaryPrefix: '【压缩摘要】\n',

    // —— 模式 ——
    autoMode: true,             // 自动模式开关（关闭即手动模式）
    autoEvery: 10,              // 用户每发送多少条消息自动压缩一次
    autoTrigger: 'tokens',      // count：按用户输入条数；tokens：按历史 token 数
    autoTokens: 12000,          // 上次摘要之后的可见消息 token 数达到此值时自动压缩

    // —— 自定义连接 ——
    // 注意：这里的“预设”指 ST 的代理预设（proxies 里带 url / 账号密码的那条），
    // 不是破限或提示词预设。source 为空表示跟随当前连接。
    connCompress: { enabled: true, source: 'openai', proxyPreset: 'api', proxyUrl: '', proxyPassword: '', model: 'deepseek-flash' },
});

// —— 设置读取/初始化 ——
function getSettings() {
    const ctx = SillyTavern.getContext();
    const store = ctx.extensionSettings;
    if (!store[MODULE_NAME]) {
        store[MODULE_NAME] = structuredClone(DEFAULT_SETTINGS);
    }
    const s = store[MODULE_NAME];
    for (const k of Object.keys(DEFAULT_SETTINGS)) {
        if (!Object.hasOwn(s, k)) s[k] = structuredClone(DEFAULT_SETTINGS[k]);
    }
    // 清掉旧版缓存断点、以及已移除的「改写」功能留下的设置，避免死配置一直躺在 settings.json 里
    for (const k of LEGACY_SETTING_KEYS) {
        if (Object.hasOwn(s, k)) delete s[k];
    }
    if (Object.hasOwn(s, 'connRewrite')) delete s['connRewrite'];
    for (const conn of ['connCompress']) {
        if (typeof s[conn] !== 'object' || s[conn] === null) s[conn] = structuredClone(DEFAULT_SETTINGS[conn]);
        for (const k of Object.keys(DEFAULT_SETTINGS[conn])) {
            if (!Object.hasOwn(s[conn], k)) s[conn][k] = DEFAULT_SETTINGS[conn][k];
        }
    }
    return s;
}

function save() {
    SillyTavern.getContext().saveSettingsDebounced();
}

// —— 用户轮数：与 token 计数一致，直接由当前聊天内容实时推算 ——
// 上一次摘要之后、可见（非隐藏）、非摘要消息中，“user + AI 回复”才算一轮：
// 连续多条 user 后跟一条 AI 只算一轮；user 已发出但 AI 尚未回复不算。
// 不再使用累加计数器，因此 fork、删除、取消隐藏、切换聊天等都能保持准确。
function countUserTurns() {
    const chat = SillyTavern.getContext().chat;
    if (!Array.isArray(chat) || chat.length === 0) return 0;
    let n = 0;
    let pendingUser = false;
    for (let i = findLastSummaryIndex(chat) + 1; i < chat.length; i++) {
        const m = chat[i];
        if (!m || m.is_system === true || isSummaryMessage(m)) continue;
        if (m.is_user) {
            pendingUser = true;
        } else if (pendingUser && String(m.mes ?? '').trim()) {
            // 流式生成中的空占位不算
            n++;
            pendingUser = false;
        }
    }
    return n;
}

function isSummaryMessage(m) {
    return !!(m && m.extra && m.extra[MODULE_NAME] && m.extra[MODULE_NAME].isCompression);
}

// ============================================================
//  生成拦截器：注入主路径任务的指令（全局函数，供 manifest 引用）
// ============================================================

globalThis.compressInterceptor = async function (chat, _contextSize, _abort, _type) {
    try {
        if (!Array.isArray(chat)) return;

        // 任务指令以“追加的 user 消息”放在对话末尾，而不是走 quiet prompt。
        // ST 的 quiet prompt 固定以 system 角色注入在末尾；部分 OpenAI 兼容中转会把
        // system 上提，导致对话以 assistant 结尾，触发“assistant prefill 不支持”400
        // 错误。以 user 消息结尾对任何源都安全。
        if (isCompressing && pendingTaskInjection) {
            const ctx = SillyTavern.getContext();
            chat.push({
                name: ctx?.name1 || 'User',
                is_user: true,
                is_system: false,
                send_date: ctx?.getMessageTimeStamp ? ctx.getMessageTimeStamp() : new Date().toISOString(),
                mes: pendingTaskInjection,
                extra: {},
            });
        }
    } catch (e) {
        console.error(LOG, '拦截器出错：', e);
    }
};

// ============================================================
//  临时切换预设
// ============================================================
// 在 fn 执行期间临时切到指定的 Chat Completion 预设，结束后切回原预设。
// 预设切换会重新应用预设文件里保存的值：当前预设未保存的改动在切回后会丢失。
// 若开启了“预设绑定连接”，所选预设里的源/模型也会一并生效。
async function withPreset(presetName, fn) {
    const ctx = SillyTavern.getContext();
    if (!presetName || ctx.mainApi !== 'openai') return await fn();
    const pm = typeof ctx.getPresetManager === 'function' ? ctx.getPresetManager('openai') : null;
    if (!pm) return await fn();
    if (pm.getSelectedPresetName() === presetName) return await fn();

    const target = pm.findPreset(presetName);
    if (target === undefined) {
        toastr.warning(`找不到预设「${presetName}」，改用当前预设`);
        return await fn();
    }
    const original = pm.getSelectedPreset();
    await pm.selectPreset(target);
    try {
        return await fn();
    } finally {
        try {
            await pm.selectPreset(original);
        } catch (e) {
            console.error(LOG, '切回原预设失败：', e);
            toastr.error('切回原预设失败，请手动检查当前预设');
        }
    }
}

// ============================================================
//  压缩范围选择
// ============================================================
// 返回 { targets, kept }：
//   targets —— 被压缩后隐藏、摘要插在它们之后的消息；
//   kept    —— 最后 keepLast 条可压缩消息，始终保留可见（摘要插在它们之前）。
// countOverride 为数字时：targets 取 kept 之前最近 N 条可压缩消息。
// 否则：targets 取“上一次压缩摘要之后”到 kept 之前的全部可压缩消息。
// 主路径压缩时告诉模型总结范围（聊天本身已在请求中）
function buildMainPathScopeNote(chat, targets, kept, includeKept, countOverride, prevSummaries = []) {
    const hasSummary = findLastSummaryIndex(chat) >= 0;
    const mergePrev = prevSummaries.length > 0;
    const partial = Number.isFinite(countOverride) && countOverride > 0;
    let scope;
    const excludeKept = !includeKept && kept.length > 0;
    if (partial) {
        scope = excludeKept
            ? `Summarize ONLY the ${targets.length} message(s) that come right before the final ${kept.length} message(s) of the conversation above.`
            : `Summarize ONLY the last ${targets.length + kept.length} message(s) of the conversation above.`;
    } else if (hasSummary && mergePrev) {
        scope = 'Summarize the most recent memory summary together with the part of the conversation above that comes after it.';
    } else if (hasSummary) {
        scope = 'Summarize ONLY the part of the conversation above that comes after the most recent memory summary. Treat earlier summaries as background, do not repeat them.';
    } else {
        scope = 'Summarize the entire conversation above.';
    }
    if (excludeKept && !partial) {
        scope += ` Do NOT include the final ${kept.length} message(s); they will be kept verbatim.`;
    }
    if (mergePrev) {
        scope += ` The previous memory summary message(s) (${prevSummaries.length}) will be replaced by your output, ` +
            'so merge their content into ONE consolidated summary covering everything, in chronological order.';
    }
    return scope + ' Output only the summary.';
}

function collectTargets(countOverride, keepLast = 0) {
    const chat = SillyTavern.getContext().chat;
    if (!Array.isArray(chat) || chat.length === 0) return { targets: [], kept: [] };

    const eligible = (m) => m && m.is_system !== true && !isSummaryMessage(m);

    let skip = Math.max(0, Math.floor(Number(keepLast) || 0));
    let end = chat.length; // targets 范围的开区间上界
    const kept = [];
    for (let i = chat.length - 1; i >= 0 && skip > 0; i--) {
        if (eligible(chat[i])) { skip--; end = i; kept.push(i); }
    }
    kept.reverse();
    if (skip > 0) return { targets: [], kept };

    if (Number.isFinite(countOverride) && countOverride > 0) {
        const targets = [];
        for (let i = end - 1; i >= 0 && targets.length < countOverride; i--) {
            if (eligible(chat[i])) targets.push(i);
        }
        targets.reverse();
        return { targets, kept };
    }

    const lastSummary = findLastSummaryIndex(chat);
    const targets = [];
    for (let i = lastSummary + 1; i < end; i++) {
        if (eligible(chat[i])) targets.push(i);
    }
    return { targets, kept };
}

// 与本次压缩范围相邻的“之前的摘要”（可见的）：
//   - 从 targets 第一条往前回溯，跳过已隐藏消息，收集连续的可见摘要，遇到可见普通消息即停止
//     （中间隔着未压缩的可见消息时不合并，避免新摘要覆盖的时间顺序错乱）；
//   - 以及夹在 targets 中间的可见摘要（指定条数压缩时可能出现）。
function collectPrevSummaries(chat, targets) {
    if (!Array.isArray(chat) || targets.length === 0) return [];
    const first = targets[0], last = targets[targets.length - 1];
    const out = [];
    for (let i = first - 1; i >= 0; i--) {
        const m = chat[i];
        if (!m || m.is_system === true) continue;
        if (isSummaryMessage(m)) { out.push(i); continue; }
        break;
    }
    out.reverse();
    for (let i = first + 1; i < last; i++) {
        const m = chat[i];
        if (m && m.is_system !== true && isSummaryMessage(m)) out.push(i);
    }
    return out;
}

function findLastSummaryIndex(chat) {
    for (let i = chat.length - 1; i >= 0; i--) {
        if (isSummaryMessage(chat[i])) return i;
    }
    return -1;
}

// 历史 token：上一次摘要之后所有可见、非摘要消息的 token 数（含“保留最近 N 条”，它不影响触发）
async function countHistoryTokens() {
    const ctx = SillyTavern.getContext();
    const chat = ctx.chat;
    if (!Array.isArray(chat) || chat.length === 0) return 0;
    const start = findLastSummaryIndex(chat) + 1;
    const text = chat.slice(start)
        .filter((m) => m && m.is_system !== true && !isSummaryMessage(m))
        .map((m) => String(m.mes ?? ''))
        .join('\n\n');
    if (!text) return 0;
    try {
        if (typeof ctx.getTokenCountAsync === 'function') return await ctx.getTokenCountAsync(text);
        if (typeof ctx.getTokenCount === 'function') return ctx.getTokenCount(text);
    } catch (e) {
        console.warn(LOG, 'token 计数失败，按字符估算：', e);
    }
    return Math.ceil(text.length / 3.5);
}

// ============================================================
//  压缩执行
// ============================================================
async function runCompression(countOverride, { silent = false, auto = false } = {}) {
    if (isCompressing) {
        if (!silent) toastr.warning('已有任务在进行中');
        return;
    }
    const ctx = SillyTavern.getContext();
    const s = getSettings();
    const chat = ctx.chat;

    const keepLast = Math.max(0, Math.floor(Number(auto ? s.compressKeepLastAuto : s.compressKeepLastManual) || 0));
    const { targets, kept } = collectTargets(countOverride, keepLast);
    // 总结范围与插入位置解耦：保留的 N 条可见消息也可一起总结
    const includeKept = s.compressIncludeKept && kept.length > 0;
    if (targets.length === 0) {
        if (!silent) {
            toastr.warning(keepLast > 0
                ? `上次压缩之后没有新消息可压缩（最近 ${keepLast} 条保留不压缩）`
                : '上次压缩之后没有新消息可压缩');
        }
        return;
    }

    const prevSummaries = s.compressIncludePrevSummary ? collectPrevSummaries(chat, targets) : [];
    const byIndex = (a, b) => a - b;
    const summarized = [...prevSummaries, ...targets, ...(includeKept ? kept : [])].sort(byIndex);
    // 需要隐藏的消息：被压缩的消息 + 合并进来的旧摘要（保留的 N 条始终可见）
    const toHide = [...prevSummaries, ...targets].sort(byIndex);

    const transcript = summarized.map((i) => {
        const m = chat[i];
        if (isSummaryMessage(m)) return `[Earlier memory summary]\n${m.mes ?? ''}`;
        const who = m.is_user ? (ctx.name1 || 'User') : (m.name || ctx.name2 || 'Character');
        return `${who}: ${m.mes ?? ''}`;
    }).join('\n\n');

    let result = '';
    const loaderHandle = ctx.loader ? ctx.loader.show({ message: '正在压缩上下文…' }) : null;
    isCompressing = true;
    const conn = await resolveConnection(s, 'connCompress');
    if (conn) warnConnection(conn, '压缩');
    try {
        result = await withPreset(s.compressPreset, async () => {
            if (s.compressUseMainPreset) {
                // 主路径：聊天原样随请求发送，不再单独提取文字稿；只在末尾追加一条 user 指令
                pendingTaskInjection = [
                    s.compressPrompt,
                    buildMainPathScopeNote(chat, targets, kept, includeKept, countOverride, prevSummaries),
                ].join('\n\n');
                return await runMainPathTask(ctx, { conn, tag: '压缩' });
            }
            // 直连路径：只发压缩提示词 + 待压缩消息。
            // 走 processRequest 而不是 generateRaw，才能在吃预设参数的同时覆盖连接
            // （generateRaw 不支持指定预设，且连接只能取全局设置）。
            return await runDirectTask(ctx, {
                conn,
                presetName: s.compressPreset,
                systemPrompt: s.compressPrompt,
                userPrompt: transcript,
                // 摘要可能很长，优先用当前连接/预设的输出上限，取不到再退回 2048
                maxTokens: Number(ctx.chatCompletionSettings?.openai_max_tokens) || 2048,
            }, '压缩');
        });
    } catch (e) {
        console.error(LOG, '压缩生成失败：', e);
        if (!silent) toastr.error('压缩生成失败，详见控制台');
        return;
    } finally {
        isCompressing = false;
        pendingTaskInjection = null;
        if (loaderHandle) await loaderHandle.hide();
    }

    if (!result || !String(result).trim()) {
        if (!silent) toastr.error('压缩失败：模型返回为空');
        return;
    }

    const summaryText = (s.summaryPrefix || '') + String(result).trim();
    const asUser = s.compressRole === 'user';
    const newMsg = {
        name: asUser ? (ctx.name1 || 'User') : (ctx.name2 || 'Narrator'),
        is_user: asUser,
        is_system: false,
        send_date: ctx.getMessageTimeStamp ? ctx.getMessageTimeStamp() : new Date().toISOString(),
        mes: summaryText,
        extra: { [MODULE_NAME]: { isCompression: true, ts: Date.now() } },
    };

    let needReload = false;
    if (s.hideOriginals) {
        // 按连续区间分组隐藏，避免 min-max 整段误伤夹在中间的非目标消息（如上一条摘要）
        const runs = [];
        let runStart = toHide[0], prev = toHide[0];
        for (const i of toHide.slice(1)) {
            if (i === prev + 1) { prev = i; continue; }
            runs.push([runStart, prev]);
            runStart = prev = i;
        }
        runs.push([runStart, prev]);

        let hid = false;
        try {
            if (ctx.executeSlashCommandsWithOptions) {
                for (const [a, b] of runs) {
                    await ctx.executeSlashCommandsWithOptions(a === b ? `/hide ${a}` : `/hide ${a}-${b}`);
                }
                hid = true;
            }
        } catch (e) {
            console.warn(LOG, '/hide 调用失败，退回手动隐藏：', e);
        }
        if (!hid) {
            for (const i of toHide) chat[i].is_system = true;
            needReload = true;
        }
    }

    // 保留了最近几条时，摘要插在被压缩范围之后、保留消息之前，保证时间顺序
    const insertAt = keepLast > 0 ? targets[targets.length - 1] + 1 : chat.length;
    if (insertAt < chat.length) {
        chat.splice(insertAt, 0, newMsg);
        needReload = true;
    } else {
        chat.push(newMsg);
        if (!needReload) {
            try {
                if (ctx.addOneMessage) ctx.addOneMessage(newMsg);
            } catch (e) {
                console.warn(LOG, 'addOneMessage 失败：', e);
            }
        }
    }
    try {
        if (ctx.saveChat) await ctx.saveChat();
    } catch (e) {
        console.warn(LOG, 'saveChat 失败：', e);
    }
    // reloadCurrentChat 从服务端重新读取，必须在保存之后
    if (needReload) {
        try {
            if (ctx.reloadCurrentChat) await ctx.reloadCurrentChat();
        } catch (e) {
            console.warn(LOG, '刷新聊天失败：', e);
        }
    }

    refreshCounterDisplay();

    const msgCount = targets.length + (includeKept ? kept.length : 0);
    let doneText = includeKept
        ? `已压缩 ${msgCount} 条消息（其中最近 ${kept.length} 条保留可见）`
        : `已压缩 ${msgCount} 条消息`;
    if (prevSummaries.length > 0) doneText += `，并合并了 ${prevSummaries.length} 条旧摘要`;
    toastr.success(doneText);
}

// 当前连接在指定源下使用的模型（未指定自定义连接时的默认模型）
function currentModelForSource(settings, source) {
    const modelFields = {
        claude: 'claude_model',
        openai: 'openai_model',
        custom: 'custom_model',
        makersuite: 'google_model',
        google: 'google_model',
        vertexai: 'vertexai_model',
        openrouter: 'openrouter_model',
        ai21: 'ai21_model',
        mistralai: 'mistralai_model',
        cohere: 'cohere_model',
        perplexity: 'perplexity_model',
        groq: 'groq_model',
        electronhub: 'electronhub_model',
        chutes: 'chutes_model',
        nanogpt: 'nanogpt_model',
        deepseek: 'deepseek_model',
        aimlapi: 'aimlapi_model',
        xai: 'xai_model',
        pollinations: 'pollinations_model',
        moonshot: 'moonshot_model',
        fireworks: 'fireworks_model',
        cometapi: 'cometapi_model',
        azure_openai: 'azure_openai_model',
        zai: 'zai_model',
        siliconflow: 'siliconflow_model',
        workers_ai: 'workers_ai_model',
        minimax: 'minimax_model',
    };
    const field = modelFields[String(source ?? '').toLowerCase()];
    return (field && settings?.[field]) || settings?.model || '';
}

// 独立请求所需的连接参数（源、模型、自定义地址、反代），与主对话当前连接一致
// 各源把自定义地址存在不同字段里；换源或走直连时需要按源填对字段。
const API_URL_FIELD_BY_SOURCE = Object.freeze({
    custom: 'custom_url',
    vertexai: 'vertexai_region',
    zai: 'zai_endpoint',
    siliconflow: 'siliconflow_endpoint',
    minimax: 'minimax_endpoint',
    pollinations: 'pollinations_endpoint',
});

// 按源从当前 Chat Completion 设置里取出自定义地址字段
function apiUrlFieldsForSource(settings, source) {
    const field = API_URL_FIELD_BY_SOURCE[String(source ?? '').toLowerCase()];
    const value = field ? settings?.[field] : '';
    return field && value ? { [field]: value } : {};
}

// ============================================================
//  自定义连接（源 / 代理预设 / 模型）
// ============================================================
// 说明：这里说的“预设”是 ST 的**代理预设**——即 Connection Profiles 里那条
// 带 url / 账号密码、用于连接中转的记录，不是破限或提示词预设。
// 用户既可以从 ST 现有代理预设里挑，也可以手填 url / 密码覆盖。

// 换源时要清掉的、只对特定源有意义的字段；残留这些字段会让后端报 400。
const SOURCE_SPECIFIC_FIELDS = Object.freeze([
    'custom_url',
    'vertexai_region',
    'zai_endpoint',
    'siliconflow_endpoint',
    'minimax_endpoint',
    'pollinations_endpoint',
    'azure_base_url',
    'azure_deployment_name',
    'azure_api_version',
    'secret_id',
]);

// 代理预设列表。
// 注意：ST 的 getContext() **不暴露** proxies（只有 script.js 内部那个 getSettings 上下文里才有），
// 扩展拿不到，所以这里从 /api/settings/get 读原始设置。
// 优先级：ctx.proxies（万一将来暴露了）> 服务器设置文件里的 proxies。
let proxyListCache = null;

async function loadProxyPresets(force = false) {
    if (!force && proxyListCache) return proxyListCache;

    const ctx = SillyTavern.getContext();
    const live = ctx.proxies;
    if (Array.isArray(live) && live.length) {
        proxyListCache = live;
        return proxyListCache;
    }

    try {
        const headers = typeof ctx.getRequestHeaders === 'function'
            ? ctx.getRequestHeaders()
            : { 'Content-Type': 'application/json' };
        const response = await fetch('/api/settings/get', {
            method: 'POST',
            headers,
            body: JSON.stringify({}),
            cache: 'no-cache',
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        // settings 字段是 JSON 字符串；代理预设既可能在根上，也可能在 oai_settings 里
        const settings = typeof data?.settings === 'string' ? JSON.parse(data.settings) : (data?.settings ?? {});
        const list = settings?.proxies ?? settings?.oai_settings?.proxies;
        proxyListCache = Array.isArray(list) ? list : [];
    } catch (e) {
        console.warn(LOG, '读取代理预设失败，代理下拉将为空：', e);
        proxyListCache = proxyListCache || [];
    }
    return proxyListCache;
}

// 找到指定名字的代理预设；返回 { name, url, password } 或 null
async function findProxyPreset(name) {
    if (!name) return null;
    const list = await loadProxyPresets();
    return list.find(p => p && p.name === name) || null;
}

// 把一条自定义连接配置解析成实际要用的连接参数；未启用时返回 null（表示走原逻辑）
async function resolveConnection(s, key) {
    const c = s?.[key];
    if (!c || !c.enabled) return null;

    const ctxSettings = SillyTavern.getContext().chatCompletionSettings || {};
    const preset = await findProxyPreset(c.proxyPreset);

    // 优先级：手填 > 代理预设 > 当前连接。手填便于覆盖代理预设里的旧 url/密码。
    const reverseProxy = String(c.proxyUrl || preset?.url || '').trim();
    const proxyPassword = String(c.proxyPassword || preset?.password || '');

    const warnings = [];
    if (!String(c.source || '').trim()) warnings.push('未选择源，将沿用当前连接的源');

    return {
        key,
        source: String(c.source || '').trim() || String(ctxSettings.chat_completion_source || '').trim(),
        model: String(c.model || '').trim(),
        reverseProxy,
        proxyPassword,
        missingProxyPreset: !!c.proxyPreset && !preset,
        warnings,
    };
}


// 直连路径构造连接相关字段（其余采样参数交给预设或当前设置）
function connectionFields(conn) {
    const fields = {};
    if (conn?.source) fields.chat_completion_source = conn.source;
    if (conn?.model) fields.model = conn.model;
    if (conn?.reverseProxy) fields.reverse_proxy = conn.reverseProxy;
    if (conn?.proxyPassword) fields.proxy_password = conn.proxyPassword;
    return fields;
}

function warnConnection(conn, tag) {
    if (!conn) return;
    if (conn.missingProxyPreset) {
        console.warn(LOG, `${tag}：找不到代理预设「${conn.proxyPreset}」，已按其余设置继续`);
    }
    for (const w of conn.warnings) console.warn(LOG, `${tag}：${w}`);
}

function getChatCompletionService(ctx) {
    const service = ctx.ChatCompletionService;
    return service && typeof service.processRequest === 'function' ? service : null;
}

// —— 非流式任务请求 ——
// 直连路径：自己拼消息 + 按源填自定义地址，预设参数通过 options.presetName 应用，
// 不切换全局选中预设。返回纯文本；失败返回 null。
async function runDirectTask(ctx, { conn, presetName, systemPrompt, userPrompt, messages: presetMessages, maxTokens }, tag) {
    const service = getChatCompletionService(ctx);
    if (!service) throw new Error('当前 SillyTavern 版本未提供 ChatCompletionService');

    const settings = ctx.chatCompletionSettings || {};
    const messages = [];
    if (Array.isArray(presetMessages)) {
        messages.push(...presetMessages);
    } else {
        if (systemPrompt) messages.push({ role: 'system', content: String(systemPrompt) });
        messages.push({ role: 'user', content: String(userPrompt) });
    }

    const payload = {
        stream: false,
        messages,
        ...connectionFields(conn),
        ...apiUrlFieldsForSource(settings, conn?.source),
        max_tokens: Number(maxTokens) || Number(settings.openai_max_tokens) || undefined,
    };
    // 预设里通常不含 model 字段（模型按源存在 claude_model 等字段里），
    // 所以只要没指定自定义模型，就补上该源当前的模型，避免请求没有模型。
    if (!conn?.model) {
        const source = conn?.source || settings.chat_completion_source;
        const model = currentModelForSource(settings, source);
        if (model) payload.model = model;
    }

    const data = await service.processRequest(payload, { presetName: presetName || undefined }, true);
    const content = data?.content;
    return content === undefined || content === null ? '' : String(content);
}

// —— 自定义连接：临时切换全局 Chat Completion 设置 ——
// 主路径压缩必须让 ST 自己构建请求体（拦截器注入 + 预设提示词），因此只能临时改全局设置。
// 只覆盖源 / 代理 url / 代理密码 / 模型，绝不碰预设选择等其它设置；finally 里逐个还原。
const CONN_SETTING_KEYS = Object.freeze(['chat_completion_source', 'reverse_proxy', 'proxy_password', 'model']);

async function withConnection(ctx, conn, fn) {
    if (!conn || ctx.mainApi !== 'openai') return await fn();
    const settings = ctx.chatCompletionSettings;
    if (!settings) return await fn();

    const saved = {};
    for (const k of CONN_SETTING_KEYS) saved[k] = settings[k];

    try {
        if (conn.source) settings.chat_completion_source = conn.source;
        settings.reverse_proxy = conn.reverseProxy || '';
        settings.proxy_password = conn.proxyPassword || '';
        if (conn.model) settings.model = conn.model;
        return await fn();
    } finally {
        for (const k of CONN_SETTING_KEYS) settings[k] = saved[k];
    }
}

// —— 主路径任务请求（非流式）——
// 有自定义连接时：临时切全局连接 → ST 用完整管线构建并直接发出请求 → 还原。
// 没有自定义连接时：行为与改动前完全一致。
async function runMainPathTask(ctx, { conn, tag }) {
    if (!conn) return await ctx.generateQuietPrompt({ quietPrompt: '' });
    return await withConnection(ctx, conn, async () => {
        console.debug(LOG, `${tag}：主路径临时切换到自定义连接`, {
            source: conn.source,
            model: conn.model,
            proxy: conn.reverseProxy ? '已设置' : '未设置',
        });
        return await ctx.generateQuietPrompt({ quietPrompt: '' });
    });
}


// ============================================================
//  自动模式：事件监听
// ============================================================
function onChatMutated() {
    // 等 ST 完成本次修改后再刷新显示
    setTimeout(() => refreshCounterDisplay(), 100);
}

function onGenerationEnded() {
    try {
        const s = getSettings();
        if (!s.enabled || !s.autoMode || isCompressing) return;
        if (s.autoTrigger === 'tokens') {
            // 回复已落库后再计数
            setTimeout(async () => {
                try {
                    if (isCompressing) return;
                    const tokens = await countHistoryTokens();
                    refreshCounterDisplay(tokens);
                    const limit = Math.max(1, Number(s.autoTokens) || 20000);
                    if (tokens >= limit) await runCompression(undefined, { silent: true, auto: true });
                } catch (e) {
                    console.warn(LOG, '按 token 自动压缩出错：', e);
                }
            }, 500);
            return;
        }
        const every = Math.max(1, Number(s.autoEvery) || 10);
        if (countUserTurns() >= every) {
            // 回复已落库，此刻后台压缩安全
            setTimeout(() => runCompression(undefined, { silent: true, auto: true }), 500);
        }
    } catch (e) {
        console.warn(LOG, 'onGenerationEnded 出错：', e);
    }
}

function refreshCounterDisplay(knownTokens) {
    try {
        const s = getSettings();
        $('#cc_trigger_count').toggle(s.autoTrigger !== 'tokens');
        $('#cc_trigger_tokens').toggle(s.autoTrigger === 'tokens');
        if (s.autoTrigger === 'tokens') {
            const limit = Math.max(1, Number(s.autoTokens) || 20000);
            if (Number.isFinite(knownTokens)) {
                $('#cc_token_counter').text(`${knownTokens} / ${limit}`);
            } else {
                countHistoryTokens()
                    .then((t) => $('#cc_token_counter').text(`${t} / ${limit}`))
                    .catch(() => { /* ignore */ });
            }
            return;
        }
        const every = Math.max(1, Number(s.autoEvery) || 10);
        $('#cc_counter').text(`${countUserTurns()} / ${every}`);
    } catch { /* UI 未就绪时忽略 */ }
}

// ============================================================
//  “选项”菜单按钮（与 重新生成 / AI帮答 / 续写 同级）
// ============================================================
// 按设置注入/移除按钮：总开关关闭或对应开关关闭时不改动 ST 的菜单
function insertMenuItem(html, preferAnchor) {
    const $anchor = $(preferAnchor).length ? $(preferAnchor) : $('#option_continue');
    if ($anchor.length) $anchor.first().after(html);
    else $('#options .options-content').append(html);
}

function syncMenuButtons() {
    const s = getSettings();
    const wantCompress = !!(s.enabled && s.menuCompress);

    if (wantCompress && !$('#option_compress_context').length) {
        insertMenuItem(`
        <a id="option_compress_context" class="interactable" tabindex="0">
            <i class="fa-lg fa-solid fa-file-zipper"></i>
            <span>压缩上下文</span>
        </a>`, '#option_continue');
    } else if (!wantCompress) {
        $('#option_compress_context').remove();
    }

}

// 委托事件只绑定一次，按钮移除/重建都无需重绑
function bindMenuHandlers() {
    $(document).on('click', '#option_compress_context', async function () {
        try { $('#options').hide(); } catch { /* ignore */ }
        await runCompression();
    });
}

// ============================================================
//  设置面板 UI
// ============================================================

// ST 的 Chat Completion 源列表（与 openai.js 的 chat_completion_sources 对应）
const CC_SOURCES = Object.freeze([
    ['', '跟随当前连接'],
    ['claude', 'Claude'],
    ['openai', 'OpenAI'],
    ['openrouter', 'OpenRouter'],
    ['makersuite', 'Google AI Studio'],
    ['vertexai', 'Vertex AI'],
    ['mistralai', 'MistralAI'],
    ['custom', 'Custom (OpenAI 兼容)'],
    ['cohere', 'Cohere'],
    ['perplexity', 'Perplexity'],
    ['groq', 'Groq'],
    ['electronhub', 'ElectronHub'],
    ['chutes', 'Chutes'],
    ['nanogpt', 'NanoGPT'],
    ['deepseek', 'DeepSeek'],
    ['aimlapi', 'AIMLAPI'],
    ['xai', 'xAI'],
    ['pollinations', 'Pollinations'],
    ['moonshot', 'Moonshot'],
    ['fireworks', 'Fireworks'],
    ['cometapi', 'CometAPI'],
    ['azure_openai', 'Azure OpenAI'],
    ['zai', 'Z.AI'],
    ['siliconflow', 'SiliconFlow'],
    ['workers_ai', 'Cloudflare Workers AI'],
    ['minimax', 'MiniMax'],
]);

// 源 → ST 自己那个模型下拉的 DOM id。
// 用 ST 已经拉好的列表，避免我们自己再打一次 /status 接口（那需要凭据，还可能失败）。
// 注意 makersuite 的 select 叫 model_google_select。
const MODEL_SELECT_BY_SOURCE = Object.freeze({
    openai: '#model_openai_select',
    claude: '#model_claude_select',
    openrouter: '#model_openrouter_select',
    ai21: '#model_ai21_select',
    makersuite: '#model_google_select',
    vertexai: '#model_vertexai_select',
    mistralai: '#model_mistralai_select',
    groq: '#model_groq_select',
    siliconflow: '#model_siliconflow_select',
    minimax: '#model_minimax_select',
    electronhub: '#model_electronhub_select',
    chutes: '#model_chutes_select',
    nanogpt: '#model_nanogpt_select',
    workers_ai: '#model_workers_ai_select',
    deepseek: '#model_deepseek_select',
    fireworks: '#model_fireworks_select',
    cometapi: '#model_cometapi_select',
    perplexity: '#model_perplexity_select',
    cohere: '#model_cohere_select',
    custom: '#model_custom_select',
});

// 收集可选的模型 id：
//   1) 该源在 ST 里的原生下拉（值就是 model.id，如 #model_claude_select）
//   2) 目标源就是当前源的源时，再合并 custom 的 select 与 datalist
//   3) 一个都没取到时，用该源当前的模型兜底，保证弹窗不空
// 注意 getContext() 既不暴露 proxies 也不暴露 models，所以只能读 ST 已经填好的 DOM，
// 这样也顺带避免了为了列模型去打 /status 接口（那需要凭据，还可能失败）。
function collectModelCandidates(source, currentModel) {
    const seen = new Set();
    const out = [];
    const push = (v) => {
        const value = String(v ?? '').trim();
        if (!value || value === 'None' || seen.has(value)) return;
        seen.add(value);
        out.push(value);
    };

    const readOptions = (selector) => {
        try {
            $(selector).find('option').each(function () {
                push($(this).attr('value'));
            });
        } catch { /* 选择器取不到就跳过 */ }
    };

    const ctx = SillyTavern.getContext();
    const currentSource = String(ctx.chatCompletionSettings?.chat_completion_source ?? '').toLowerCase();
    // 没选源就等于跟随当前连接，所以先把「空」折叠成当前源，后面统一按有效源处理
    const want = String(source ?? '').trim().toLowerCase() || currentSource;

    // 目标源在 ST 里的原生下拉（值就是 model.id）
    const primary = MODEL_SELECT_BY_SOURCE[want];
    if (primary) readOptions(primary);

    // OpenAI 源的「External」是 #model_openai_select 里的一个 <optgroup>，
    // 上面的 find('option') 已经能读到；这里再显式补一次，
    // 免得哪天 ST 把它挪出这个 select。
    if (want === 'openai') readOptions('#openai_external_category');

    // 只有目标源就是当前连接的源时，才把 ST 已加载的那份列表当兜底，
    // 否则会把「当前源」的模型当成「别的源」的候选，误导人。
    if (want === currentSource) {
        readOptions('#model_custom_select');
        readOptions('#model_custom_select_fill');
    }

    // 已保存的模型必须始终在列，否则用户换源再换回来时设置会被悄悄丢掉
    push(currentModel);
    return out;
}

// 重建某一项的模型下拉选项。
// 单独抽出来是因为它需要在「面板刷新」和「下拉获焦」两个时机都能跑：
// ST 的外部模型列表是 /status 请求回来后异步填进 #openai_external_category 的，
// 比扩展初始化晚，所以获焦时要重新读一次 DOM，否则拿到的是当时的空快照。
function refreshModelOptions(taskId, conn) {
    const settings = SillyTavern.getContext().chatCompletionSettings || {};
    const id = `cc_conn_${taskId}`;
    const source = conn.source || settings.chat_completion_source;
    const candidates = collectModelCandidates(source, conn.model);

    const $model = $(`#${id}_model`).empty();
    $model.append($('<option>').val('').text('跟随该源的当前模型'));
    for (const name of candidates) {
        $model.append($('<option>').val(name).text(name));
    }
    // 之前存的值若不在候选里（例如源换了、ST 还没加载该源列表），补一项，别把设置悄悄丢掉
    if (conn.model && !candidates.includes(conn.model)) {
        $model.append($('<option>').val(conn.model).text(`${conn.model}（当前已设）`));
    }
    $model.val(conn.model || '');
}

// 生成一块「自定义连接」设置区。taskId 用于区分任务的 DOM id 与设置键。
function buildConnectionHtml(taskId, title, note) {
    const id = `cc_conn_${taskId}`;
    const options = CC_SOURCES
        .map(([v, label]) => `<option value="${v}">${label}</option>`)
        .join('');
    return `
          <hr>
          <h4>${title}</h4>

          <label class="checkbox_label" for="${id}_enabled">
            <input id="${id}_enabled" type="checkbox" />
            <span>启用自定义连接（源 / 代理预设 / 模型）</span>
          </label>
          <small class="notes">${note}这里的「代理预设」是 ST 里带 url 和账号密码的那条代理记录（Connection Profiles 用的那个），<b>不是</b>破限或提示词预设。</small>

          <div class="${id}_body" style="display:none;">
            <label for="${id}_source">源</label>
            <select id="${id}_source" class="text_pole">${options}</select>

            <label for="${id}_proxy">代理预设</label>
            <select id="${id}_proxy" class="text_pole"></select>
            <small class="notes">选择 ST 已有的代理预设（自动带出 url 和密码）。下面的手填项会覆盖它。</small>

            <div class="flex-container">
              <div class="flex1">
                <label for="${id}_proxy_url">代理地址（手填，可选）</label>
                <input id="${id}_proxy_url" type="text" class="text_pole" placeholder="留空则用代理预设的 url" />
              </div>
              <div class="flex1">
                <label for="${id}_proxy_pw">代理密码（手填，可选）</label>
                <input id="${id}_proxy_pw" type="password" class="text_pole" placeholder="留空则用代理预设的密码" />
              </div>
            </div>

            <label for="${id}_model">模型</label>
            <select id="${id}_model" class="text_pole"></select>
            <small class="notes">留空则用该源的当前模型。候选来自 ST 已加载的模型列表（跟着上面选的源走）。</small>
          </div>
`;
}

function buildSettingsHtml() {
    return `
    <div class="compress-cache-settings">
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b>压缩</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">

          <label class="checkbox_label" for="cc_enabled">
            <input id="cc_enabled" type="checkbox" />
            <span>启用本扩展</span>
          </label>
          <label class="checkbox_label" for="cc_menu_compress">
            <input id="cc_menu_compress" type="checkbox" />
            <span>在左下角菜单显示「压缩上下文」</span>
          </label>
          <small class="notes">关闭扩展或对应开关时，不会向左下角菜单注入按钮。</small>

          <hr>
          <h4>压缩模式</h4>

          <label class="checkbox_label" for="cc_auto">
            <input id="cc_auto" type="checkbox" />
            <span>自动模式：达到触发条件后自动压缩</span>
          </label>
          <div class="flex-container" style="align-items:center; gap:6px;">
            <span>触发方式</span>
            <select id="cc_auto_trigger" class="text_pole" style="max-width:200px;">
              <option value="count">按用户输入条数</option>
              <option value="tokens">按历史 token 数</option>
            </select>
          </div>
          <div id="cc_trigger_count" class="flex-container" style="align-items:center; gap:6px;">
            <span>每</span>
            <input id="cc_auto_every" type="number" min="1" step="1" class="text_pole" style="max-width:80px;" />
            <span>条用户输入压缩一次（当前计数：<span id="cc_counter">0 / 10</span>）</span>
          </div>
          <div id="cc_trigger_tokens" class="flex-container" style="align-items:center; gap:6px;">
            <span>上次压缩后的历史达到</span>
            <input id="cc_auto_tokens" type="number" min="1" step="1000" class="text_pole" style="max-width:110px;" />
            <span>token 时压缩（当前：<span id="cc_token_counter">0 / 20000</span>）</span>
          </div>
          <small class="notes">关闭自动模式即为手动模式。两种模式下都压缩“上一次压缩点之后”的消息；自动模式开启时也随时可以手动压缩。编辑重发不计入条数。</small>

          <div class="flex-container" style="margin-top:8px; align-items:center; gap:6px;">
            <input id="cc_run" class="menu_button" type="button" value="立即压缩" />
            <input id="cc_run_input" class="text_pole" type="number" min="1" step="1"
                   style="max-width:90px;" title="可选：只压缩最近 N 条" placeholder="条数(可选)" />
          </div>
          <small class="notes">“立即压缩”默认压缩上次压缩点之后的全部消息；填了条数则只压缩最近 N 条。输入框旁的“选项”菜单（重新生成/AI帮答/续写）里也有同款按钮。</small>

          <div class="flex-container" style="margin-top:8px; align-items:center; gap:6px;">
            <span>手动压缩保留最近</span>
            <input id="cc_keep_last_manual" type="number" min="0" step="1" class="text_pole" style="max-width:80px;" />
            <span>条不压缩</span>
          </div>
          <div class="flex-container" style="margin-top:4px; align-items:center; gap:6px;">
            <span>自动压缩保留最近</span>
            <input id="cc_keep_last_auto" type="number" min="0" step="1" class="text_pole" style="max-width:80px;" />
            <span>条不压缩</span>
          </div>
          <small class="notes">手动 = 立即压缩按钮、选项菜单里的“压缩上下文”、/compress 命令；自动 = 自动模式触发的压缩。</small>
          <label class="checkbox_label" for="cc_include_kept">
            <input id="cc_include_kept" type="checkbox" />
            <span>保留的消息也发送并一起总结</span>
          </label>
          <label class="checkbox_label" for="cc_include_prev_summary">
            <input id="cc_include_prev_summary" type="checkbox" />
            <span>之前的摘要也发送并合并</span>
          </label>
          <small class="notes">勾选时，紧挨本次压缩范围的上一条摘要也会发给模型，合并成一条新摘要；开启“隐藏原始消息”时旧摘要会一起隐藏。默认勾选。</small>
          <small class="notes">摘要插在倒数第 N 条之前，这 N 条保持可见、不隐藏。勾选时这 N 条也会发给模型并写进摘要，只影响插入位置；不勾选时它们不参与本次总结。0 表示不保留。这个设置不影响自动触发。</small>

          <hr>
          <h4>压缩参数</h4>

          <label class="checkbox_label" for="cc_compress_main_preset">
            <input id="cc_compress_main_preset" type="checkbox" />
            <span>使用主路径预设</span>
          </label>
          <small class="notes">开启后带上当前主对话的预设、世界书和上下文，仍只压缩选定范围；关闭时仅发送压缩提示词和待压缩消息。默认关闭。</small>

          <label for="cc_compress_preset">压缩用预设</label>
          <select id="cc_compress_preset" class="text_pole cc_preset_select"></select>
          <small class="notes">压缩时临时切换到此 Chat Completion 预设，完成后切回。开启主路径时使用它的提示词和参数，关闭时只用它的采样参数；预设绑定连接时源/模型也随之切换。</small>
${buildConnectionHtml('compress', '压缩连接（源 / 代理预设 / 模型）',
        '开启后压缩请求会走这里指定的源、代理和模型，与主对话当前连接无关；两种压缩模式都生效。')}

          <label for="cc_prompt">压缩提示词</label>
          <textarea id="cc_prompt" class="text_pole textarea_compact" rows="5"></textarea>

          <div class="flex-container">
            <div class="flex1">
              <label for="cc_role">摘要写回角色</label>
              <select id="cc_role" class="text_pole">
                <option value="assistant">assistant</option>
                <option value="user">user</option>
              </select>
            </div>
            <div class="flex1">
              <label for="cc_prefix">摘要前缀</label>
              <input id="cc_prefix" type="text" class="text_pole" />
            </div>
          </div>

          <label class="checkbox_label" for="cc_hide">
            <input id="cc_hide" type="checkbox" />
            <span>压缩后隐藏原始消息（移出上下文）</span>
          </label>


        </div>
      </div>
    </div>`;
}

let lastPresetNamesKey = null;
// force=true 时重新拉一次代理预设列表（用户刚在 ST 里加了代理，不该等到刷新页面）
async function refreshPresetOptions(force = false) {
    const s = getSettings();
    let names = [];
    try {
        const pm = SillyTavern.getContext().getPresetManager?.('openai');
        if (pm) names = pm.getAllPresets();
    } catch { /* 预设管理器未就绪 */ }

    const proxies = await loadProxyPresets(force);
    const key = JSON.stringify([
        names, s.compressPreset,
        s.connCompress,
        proxies.map(p => p?.name),
    ]);
    if (key === lastPresetNamesKey) return;
    lastPresetNamesKey = key;
    const fill = (selector, selected) => {
        const list = selected && !names.includes(selected) ? [...names, selected] : names;
        const $sel = $(selector).empty().append($('<option>').val('').text('跟随当前预设'));
        for (const name of list) {
            const label = names.includes(name) ? name : `${name}（未找到）`;
            $sel.append($('<option>').val(name).text(label));
        }
        $sel.val(selected || '');
    };
    fill('#cc_compress_preset', s.compressPreset);
    await refreshConnectionUI(s);
}

const CC_CONN_TASKS = Object.freeze([
    ['compress', 'connCompress'],
]);

// 刷新「自定义连接」区域的三个下拉与显隐
async function refreshConnectionUI(s, force = false) {
    const ctx = SillyTavern.getContext();
    const settings = ctx.chatCompletionSettings || {};
    const proxies = await loadProxyPresets(force);

    for (const [taskId, key] of CC_CONN_TASKS) {
        const c = s[key];
        const id = `cc_conn_${taskId}`;

        const $proxy = $(`#${id}_proxy`).empty();
        $proxy.append($('<option>').val('').text('不使用代理预设'));
        for (const p of proxies) {
            if (!p || !p.name) continue;
            $proxy.append($('<option>').val(p.name).text(p.name));
        }
        $proxy.val(c.proxyPreset || '');

        // 模型下拉：和上面的源下拉同样是普通 select，选项跟着所选源走
        refreshModelOptions(taskId, c);

        $(`.${id}_body`).toggle(!!c.enabled);
    }
}

async function refreshUI() {
    const s = getSettings();
    await refreshPresetOptions();
    for (const [taskId, key] of CC_CONN_TASKS) {
        const c = s[key];
        const id = `cc_conn_${taskId}`;
        $(`#${id}_enabled`).prop('checked', !!c.enabled);
        $(`#${id}_source`).val(c.source || '');
        $(`#${id}_proxy_url`).val(c.proxyUrl || '');
        $(`#${id}_proxy_pw`).val(c.proxyPassword || '');
        // 模型 select 的选项与选中值由 refreshConnectionUI 负责
    }
    $('#cc_enabled').prop('checked', s.enabled);
    $('#cc_menu_compress').prop('checked', s.menuCompress);
    $('#cc_auto').prop('checked', s.autoMode);
    $('#cc_auto_every').val(s.autoEvery);
    $('#cc_compress_main_preset').prop('checked', s.compressUseMainPreset);
    $('#cc_prompt').val(s.compressPrompt);
    $('#cc_role').val(s.compressRole);
    $('#cc_prefix').val(s.summaryPrefix);
    $('#cc_hide').prop('checked', s.hideOriginals);
    $('#cc_keep_last_manual').val(s.compressKeepLastManual);
    $('#cc_keep_last_auto').val(s.compressKeepLastAuto);
    $('#cc_include_kept').prop('checked', s.compressIncludeKept);
    $('#cc_include_prev_summary').prop('checked', s.compressIncludePrevSummary);
    $('#cc_auto_trigger').val(s.autoTrigger);
    $('#cc_auto_tokens').val(s.autoTokens);
    refreshCounterDisplay();
}

function bindUI() {
    const s = getSettings();

    $('#cc_enabled').on('change', function () { s.enabled = $(this).prop('checked'); save(); syncMenuButtons(); });
    $('#cc_menu_compress').on('change', function () { s.menuCompress = $(this).prop('checked'); save(); syncMenuButtons(); });
    $('#cc_auto').on('change', function () { s.autoMode = $(this).prop('checked'); save(); refreshCounterDisplay(); });
    $('#cc_auto_every').on('input', function () { s.autoEvery = Math.max(1, parseInt($(this).val()) || 10); save(); refreshCounterDisplay(); });
    $('#cc_compress_main_preset').on('change', function () { s.compressUseMainPreset = $(this).prop('checked'); save(); });
    $('#cc_compress_preset').on('change', function () { s.compressPreset = String($(this).val() ?? ''); save(); });
    // 展开下拉前刷新列表，跟上预设的新增/改名/删除
    // （同时会刷新代理预设下拉与模型候选）
    $('.cc_preset_select').on('mousedown focus', () => refreshPresetOptions(true));

    for (const [taskId, key] of CC_CONN_TASKS) {
        const c = () => s[key];
        const id = `cc_conn_${taskId}`;
        $(`#${id}_enabled`).on('change', function () {
            c().enabled = $(this).prop('checked');
            save();
            refreshConnectionUI(s);
        });
        $(`#${id}_source`).on('change', function () {
            c().source = String($(this).val() ?? '');
            save();
            refreshConnectionUI(s);   // 换源后模型候选跟着变
        });
        $(`#${id}_proxy`).on('change', function () { c().proxyPreset = String($(this).val() ?? ''); save(); });
        $(`#${id}_proxy_url`).on('input', function () { c().proxyUrl = String($(this).val() ?? ''); save(); });
        $(`#${id}_proxy_pw`).on('input', function () { c().proxyPassword = String($(this).val() ?? ''); save(); });
        $(`#${id}_model`).on('change', function () { c().model = String($(this).val() ?? ''); save(); });
        // 展开前重读一次 ST 的模型列表，跟上 ST 异步加载进来的 External 模型
        $(`#${id}_model`).on('focus mousedown', function () { refreshModelOptions(taskId, c()); });
    }
    $('#cc_prompt').on('input', function () { s.compressPrompt = String($(this).val()); save(); });
    $('#cc_role').on('change', function () { s.compressRole = String($(this).val()); save(); });
    $('#cc_prefix').on('input', function () { s.summaryPrefix = String($(this).val()); save(); });
    $('#cc_hide').on('change', function () { s.hideOriginals = $(this).prop('checked'); save(); });
    $('#cc_include_kept').on('change', function () { s.compressIncludeKept = $(this).prop('checked'); save(); });
    $('#cc_include_prev_summary').on('change', function () { s.compressIncludePrevSummary = $(this).prop('checked'); save(); });
    $('#cc_auto_trigger').on('change', function () { s.autoTrigger = String($(this).val()); save(); refreshCounterDisplay(); });
    $('#cc_auto_tokens').on('input', function () { s.autoTokens = Math.max(1, parseInt($(this).val()) || 20000); save(); refreshCounterDisplay(); });
    $('#cc_keep_last_manual').on('input', function () { s.compressKeepLastManual = Math.max(0, parseInt($(this).val()) || 0); save(); });
    $('#cc_keep_last_auto').on('input', function () { s.compressKeepLastAuto = Math.max(0, parseInt($(this).val()) || 0); save(); });

    $('#cc_run').on('click', async function () {
        const n = parseInt($('#cc_run_input').val());
        await runCompression(Number.isFinite(n) && n > 0 ? n : undefined);
    });
}

// ============================================================
//  斜杠命令
// ============================================================
function registerSlashCommand() {
    const ctx = SillyTavern.getContext();
    try {
        const { SlashCommandParser, SlashCommand, SlashCommandArgument, ARGUMENT_TYPE } = ctx;
        if (!SlashCommandParser || !SlashCommand) return;
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'compress',
            helpString: '压缩上次压缩点之后的消息为一段记忆摘要。/compress 20 则只压缩最近 20 条。',
            callback: async (_named, unnamed) => {
                const n = parseInt(String(unnamed || '').trim());
                await runCompression(Number.isFinite(n) && n > 0 ? n : undefined);
                return '';
            },
            unnamedArgumentList: SlashCommandArgument ? [
                SlashCommandArgument.fromProps({
                    description: '可选：只压缩最近 N 条消息',
                    typeList: ARGUMENT_TYPE ? [ARGUMENT_TYPE.NUMBER] : undefined,
                    isRequired: false,
                }),
            ] : [],
        }));
    } catch (e) {
        console.warn(LOG, '注册斜杠命令失败（可忽略）：', e);
    }
}

// ============================================================
//  初始化
// ============================================================
jQuery(async () => {
    try {
        const ctx = SillyTavern.getContext();
        getSettings();
        $('#extensions_settings2').append(buildSettingsHtml());
        await refreshUI();
        bindUI();
        bindMenuHandlers();
        syncMenuButtons();
        registerSlashCommand();

        const { eventSource, event_types } = ctx;
        for (const ev of ['MESSAGE_SENT', 'MESSAGE_RECEIVED', 'MESSAGE_DELETED', 'MESSAGE_UPDATED', 'MESSAGE_SWIPED']) {
            if (event_types[ev]) eventSource.on(event_types[ev], onChatMutated);
        }
        eventSource.on(event_types.GENERATION_ENDED, onGenerationEnded);
        eventSource.on(event_types.CHAT_CHANGED, () => refreshCounterDisplay());

        console.log(LOG, '已加载');
    } catch (e) {
        console.error(LOG, '初始化失败：', e);
    }
});
