/*
 * 压缩与改写 (Compress & Rewrite)
 * SillyTavern 第三方 UI 扩展
 *
 * 功能：
 *  1) 上下文压缩（两种模式）：
 *     - 手动模式（默认）：压缩“上一次压缩点之后”的全部消息；也可指定条数。
 *     - 自动模式：用户每发送 N 条消息（编辑重发不计入），在当次回复结束后
 *       自动压缩上次压缩点之后的消息。自动模式开启时仍可随时手动压缩。
 *     触发入口：设置面板按钮、输入框旁“选项”菜单（重新生成/AI帮答/续写 同级）、/compress 命令。
 *     可设置“保留最近 N 条不压缩”，摘要插在这些消息之前。
 *  2) 改写上一条：在输入框写下改写要求，点“选项”菜单里的「改写上一条」或
 *     /rewrite 命令，对最后一条 AI 回复做局部改写（搜索替换块）或整条重写。
 *     指令不进存档；原文保存为 swipe。整条重写可流式输出。
 *     压缩和改写都可指定一个 Chat Completion 预设，执行期间临时切换、结束后切回。
 */

// 设置存储键：保持 compress_cache 不变，改名会让已有用户的压缩/改写配置全部丢失。
const MODULE_NAME = 'compress_cache';
const LOG = '[压缩与改写]';

// 旧版「缓存断点」功能遗留的设置键，加载时清理一次。
const LEGACY_SETTING_KEYS = Object.freeze([
    'cacheMode', 'gpDefault', 'gp5m', 'gp1h',
    'bpCompression', 'bpLastAssistant', 'bpInput',
]);

let isCompressing = false;
let isRewriting = false;
// 使用主路径预设时，由拦截器以追加 user 消息的方式注入任务指令
let pendingTaskInjection = null;

// 改写输出格式说明（内部固定，不随用户提示词变化，保证可解析）
const REWRITE_FORMAT_DIFF =
    'Output ONLY one or more search-and-replace blocks in exactly this format, with nothing else:\n' +
    '<<<<<<< SEARCH\n' +
    '(an excerpt copied character-for-character from the latest assistant reply)\n' +
    '=======\n' +
    '(the replacement text)\n' +
    '>>>>>>> REPLACE\n' +
    'Rules: each SEARCH excerpt must appear verbatim in the reply and be unique within it; ' +
    'keep excerpts as short as possible while remaining unique; prefer several small blocks ' +
    'over one large block; do not rewrite parts the revision request does not touch.';

const REWRITE_FORMAT_FULL =
    'Output ONLY the complete revised reply, with no preamble, no commentary, and no surrounding quotes.';

const REWRITE_TOOL_REPAIR_PROMPT =
    'This is a formatting-repair task. Review the original assistant reply, the revision request, ' +
    'and the draft edits produced by another model call. Submit the final edits via the ' +
    'submit_edits tool (or, if no tool is available, output ONLY a JSON object of the form ' +
    '{"edits": [{"search": "...", "replace": "..."}]}). Every search value must be a ' +
    'character-for-character, unique excerpt from the ORIGINAL REPLY; keep it as short as ' +
    'possible while remaining unique. Apply only changes required by the REVISION REQUEST, ' +
    'and do not rewrite any other part of the reply.';

// 修复请求走 ST 原生的 json_schema 通道（而不是自带 tools/tool_choice）：
// claude 源后端会把它转成强制工具调用（tool_choice {type:'tool', name}），
// openai/custom 源转成 response_format json_schema——各源都可用。
// 注意：ST 的 claude 后端把 request.body.tool_choice 当字符串处理，
// 自带 OpenAI 对象格式的 tool_choice 会被包坏成 {type:{...}} 导致 400。
const REWRITE_REPAIR_SCHEMA = Object.freeze({
    name: 'submit_edits',
    description: 'Submit the final list of search-and-replace edits to apply to the assistant reply.',
    strict: true,
    value: {
        type: 'object',
        properties: {
            edits: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        search: {
                            type: 'string',
                            description: 'Exact verbatim excerpt from the original reply, as short as possible while unique',
                        },
                        replace: { type: 'string' },
                    },
                    required: ['search', 'replace'],
                },
            },
        },
        required: ['edits'],
    },
});

const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,

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
    compressKeepLast: 4,        // 摘要插在倒数第 N 条之前，这 N 条保持可见、不隐藏
    compressIncludeKept: false, // 保留的 N 条是否也发送给模型并一起总结
    summaryPrefix: '【压缩摘要】\n',

    // —— 改写上一条 ——
    rewriteUseMainPreset: true, // 默认保留完整主路径；关闭时仅发送可见聊天和改写指令
    rewritePreset: '',          // 改写时临时切换到的 Chat Completion 预设；空为跟随当前
    rewriteDiffMode: true,      // true：模型只输出改动片段（搜索替换块）；false：整条重写
    rewriteToolRepair: true,    // 局部替换解析/匹配失败时，用独立工具调用修复
    rewriteStream: true,        // 整条重写时流式输出，边生成边显示在原消息上格式
    rewritePrompt:
        'You are revising the latest assistant reply in the conversation above. Apply the ' +
        'revision request with the minimal necessary changes: keep the wording, style, ' +
        'formatting and all content not covered by the request unchanged. Write in the same ' +
        'language as the original reply.',

    // —— 模式 ——
    autoMode: true,             // 自动模式开关（关闭即手动模式）
    autoEvery: 10,              // 用户每发送多少条消息自动压缩一次
    autoTrigger: 'tokens',      // count：按用户输入条数；tokens：按历史 token 数
    autoTokens: 12000,          // 上次摘要之后的可见消息 token 数达到此值时自动压缩

    // —— 自定义连接（压缩 / 改写各自独立配置）——
    // 注意：这里的“预设”指 ST 的代理预设（proxies 里带 url / 账号密码的那条），
    // 不是破限或提示词预设。source 为空表示跟随当前连接。
    connCompress: { enabled: true, source: 'openai', proxyPreset: 'api', proxyUrl: '', proxyPassword: '', model: 'deepseek-flash' },
    connRewrite:  { enabled: false, source: '', proxyPreset: '', proxyUrl: '', proxyPassword: '', model: '' },
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
    // 清掉旧版缓存断点留下的设置，避免死配置一直躺在 settings.json 里
    for (const k of LEGACY_SETTING_KEYS) {
        if (Object.hasOwn(s, k)) delete s[k];
    }
    for (const conn of ['connCompress', 'connRewrite']) {
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
// 上一次摘要之后、可见（非隐藏）、非摘要的用户消息条数。
// 不再使用累加计数器，因此 fork、删除、取消隐藏、切换聊天等都能保持准确。
function countUserTurns() {
    const chat = SillyTavern.getContext().chat;
    if (!Array.isArray(chat) || chat.length === 0) return 0;
    let n = 0;
    for (let i = findLastSummaryIndex(chat) + 1; i < chat.length; i++) {
        const m = chat[i];
        if (m && m.is_user && m.is_system !== true && !isSummaryMessage(m)) n++;
    }
    return n;
}

function isSummaryMessage(m) {
    return !!(m && m.extra && m.extra[MODULE_NAME] && m.extra[MODULE_NAME].isCompression);
}

// ============================================================
//  生成拦截器：注入主路径任务的指令（全局函数，供 manifest 引用）
// ============================================================

globalThis.compressRewriteInterceptor = async function (chat, _contextSize, _abort, _type) {
    try {
        if (!Array.isArray(chat)) return;

        // 任务指令以“追加的 user 消息”放在对话末尾，而不是走 quiet prompt。
        // ST 的 quiet prompt 固定以 system 角色注入在末尾；部分 OpenAI 兼容中转会把
        // system 上提，导致对话以 assistant 结尾，触发“assistant prefill 不支持”400
        // 错误。以 user 消息结尾对任何源都安全。
        if ((isRewriting || isCompressing) && pendingTaskInjection) {
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
function buildMainPathScopeNote(chat, targets, kept, includeKept, countOverride) {
    const hasSummary = findLastSummaryIndex(chat) >= 0;
    const partial = Number.isFinite(countOverride) && countOverride > 0;
    let scope;
    const excludeKept = !includeKept && kept.length > 0;
    if (partial) {
        scope = excludeKept
            ? `Summarize ONLY the ${targets.length} message(s) that come right before the final ${kept.length} message(s) of the conversation above.`
            : `Summarize ONLY the last ${targets.length + kept.length} message(s) of the conversation above.`;
    } else if (hasSummary) {
        scope = 'Summarize ONLY the part of the conversation above that comes after the most recent memory summary. Treat earlier summaries as background, do not repeat them.';
    } else {
        scope = 'Summarize the entire conversation above.';
    }
    if (excludeKept && !partial) {
        scope += ` Do NOT include the final ${kept.length} message(s); they will be kept verbatim.`;
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
async function runCompression(countOverride, { silent = false } = {}) {
    if (isCompressing || isRewriting) {
        if (!silent) toastr.warning('已有任务在进行中');
        return;
    }
    const ctx = SillyTavern.getContext();
    const s = getSettings();
    const chat = ctx.chat;

    const keepLast = Math.max(0, Math.floor(Number(s.compressKeepLast) || 0));
    const { targets, kept } = collectTargets(countOverride, keepLast);
    // 总结范围与插入位置解耦：保留的 N 条可见消息也可一起总结
    const includeKept = s.compressIncludeKept && kept.length > 0;
    const summarized = includeKept ? [...targets, ...kept] : targets;
    if (targets.length === 0) {
        if (!silent) {
            toastr.warning(keepLast > 0
                ? `上次压缩之后没有新消息可压缩（最近 ${keepLast} 条保留不压缩）`
                : '上次压缩之后没有新消息可压缩');
        }
        return;
    }

    const transcript = summarized.map((i) => {
        const m = chat[i];
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
                    buildMainPathScopeNote(chat, targets, kept, includeKept, countOverride),
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
        let runStart = targets[0], prev = targets[0];
        for (const i of targets.slice(1)) {
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
            for (const i of targets) chat[i].is_system = true;
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

    toastr.success(includeKept
        ? `已压缩 ${summarized.length} 条消息（其中最近 ${kept.length} 条保留可见）`
        : `已压缩 ${targets.length} 条消息`);
}

// ============================================================
//  改写上一条
// ============================================================
const DIFF_BLOCK_RE = /<{4,}\s*SEARCH\s*\r?\n([\s\S]*?)\r?\n={4,}\r?\n([\s\S]*?)\r?\n>{4,}\s*REPLACE/g;

function parseDiffBlocks(text) {
    return [...String(text ?? '').matchAll(DIFF_BLOCK_RE)]
        .map((m) => ({ search: m[1], replace: m[2] }));
}

function normalizeToolEdits(edits) {
    if (!Array.isArray(edits)) return null;
    return edits
        .filter((edit) => edit && typeof edit.search === 'string' && typeof edit.replace === 'string')
        .map((edit) => ({ search: edit.search, replace: edit.replace }));
}

function parseToolArguments(value) {
    if (value && typeof value === 'object') return value;
    if (typeof value !== 'string') return null;
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
}

// 同时兼容 Anthropic 原生、OpenAI 兼容以及纯文本兜底响应。
function extractToolEdits(data) {
    if (data && Array.isArray(data.content)) {
        for (const block of data.content) {
            if (block?.type !== 'tool_use') continue;
            const input = parseToolArguments(block.input);
            const edits = normalizeToolEdits(input?.edits);
            if (edits !== null) return edits;
        }
    }

    const toolCalls = data?.choices?.[0]?.message?.tool_calls;
    if (Array.isArray(toolCalls)) {
        for (const call of toolCalls) {
            const args = parseToolArguments(call?.function?.arguments);
            const edits = normalizeToolEdits(args?.edits);
            if (edits !== null) return edits;
        }
    }

    const textCandidates = [];
    if (typeof data === 'string') textCandidates.push(data);
    if (typeof data?.content === 'string') textCandidates.push(data.content);
    if (typeof data?.choices?.[0]?.message?.content === 'string') {
        textCandidates.push(data.choices[0].message.content);
    }
    if (Array.isArray(data?.content)) {
        for (const block of data.content) {
            if (block?.type === 'text' && typeof block.text === 'string') textCandidates.push(block.text);
        }
    }

    for (const candidate of textCandidates) {
        const text = String(candidate).trim();
        const unfenced = text.match(/^```(?:json)?\s*\n([\s\S]*?)\n?```$/i)?.[1] ?? text;
        try {
            const parsed = JSON.parse(unfenced);
            const edits = normalizeToolEdits(parsed?.edits);
            if (edits !== null) return edits;
        } catch { /* 不是纯 JSON，继续尝试文本替换块 */ }

        const blocks = parseDiffBlocks(text);
        if (blocks.length > 0) return blocks;
    }
    return null;
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

function buildRewriteRepairPrompt(original, instruction, draft) {
    return [
        REWRITE_TOOL_REPAIR_PROMPT,
        '--- ORIGINAL REPLY ---',
        original,
        '--- REVISION REQUEST ---',
        instruction,
        '--- DRAFT EDITS ---',
        draft,
        '--- END INPUT ---',
    ].join('\n\n');
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

// 把连接参数覆盖到一个已构造好的请求体上（主路径捕获的请求体或直连构造的请求体）。
// 返回被清空的字段列表，便于日志排查。
function applyConnectionOverrides(body, conn) {
    if (!body || !conn) return;
    const cleared = [];
    for (const f of SOURCE_SPECIFIC_FIELDS) {
        if (body[f] !== undefined) { delete body[f]; cleared.push(f); }
    }
    if (conn.source) body.chat_completion_source = conn.source;
    if (conn.model) body.model = conn.model;
    body.reverse_proxy = conn.reverseProxy || undefined;
    body.proxy_password = conn.proxyPassword || undefined;
    if (!conn.reverseProxy) delete body.reverse_proxy;
    if (!conn.proxyPassword) delete body.proxy_password;
    return cleared;
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

async function requestRewriteToolRepair(ctx, original, instruction, draft, conn, presetName) {
    const service = ctx.ChatCompletionService;
    if (!service || typeof service.processRequest !== 'function') {
        console.warn(LOG, '当前 SillyTavern 版本未提供 ChatCompletionService，跳过结构化改写修复');
        return null;
    }

    const payload = {
        stream: false,
        messages: [{
            role: 'user',
            content: buildRewriteRepairPrompt(original, instruction, draft),
        }],
        max_tokens: 2048,
        json_schema: structuredClone(REWRITE_REPAIR_SCHEMA),
        ...connectionFields(conn),
    };

    try {
        // 独立自定义请求不经过 generate 拦截器管线，不会改动主对话的请求；
        // 请求本身只含上面的三段修复材料。
        // 预设通过 options.presetName 应用，不切换全局选中预设。
        let data = await service.processRequest(payload, { presetName }, false);
        if (data && typeof data.json === 'function') data = await data.json();
        const edits = extractToolEdits(data);
        if (edits === null) console.warn(LOG, '结构化修复响应中未解析出 edits：', data);
        return edits;
    } catch (e) {
        console.warn(LOG, '结构化改写修复调用失败，退回第一段结果：', e);
        return null;
    }
}

function findLastAssistantIndex(chat) {
    for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i];
        if (m && m.is_user === false && m.is_system !== true) return i;
    }
    return -1;
}

// 依次尝试：精确匹配 → 去首尾空白 → 空白容错（连续空白折叠为 \s+）
function applySearchReplace(text, search, replace) {
    if (search && text.includes(search)) {
        return text.replace(search, () => replace);
    }
    const trimmed = String(search ?? '').trim();
    if (!trimmed) return null;
    if (text.includes(trimmed)) {
        return text.replace(trimmed, () => replace);
    }
    try {
        const escaped = trimmed.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
        const re = new RegExp(escaped);
        if (re.test(text)) return text.replace(re, () => replace);
    } catch { /* 正则构造失败则视为未匹配 */ }
    return null;
}

function applyEditBlocks(original, blocks) {
    let text = original, ok = 0, fail = 0;
    for (const block of blocks) {
        const applied = applySearchReplace(text, block.search, block.replace);
        if (applied === null) fail++;
        else { text = applied; ok++; }
    }
    return { text, ok, fail };
}

// 整条重写模式下，剥掉模型可能包裹的代码围栏
function stripCodeFence(text) {
    const m = text.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
    return m ? m[1] : text;
}

// ST 的 quiet 生成不支持流式。主路径流式改写的做法：照常走 quiet 生成，让 ST 构建完整请求体
// （预设参数、世界书、拦截器注入的改写指令都已就位），在 CHAT_COMPLETION_SETTINGS_READY
// 时捕获请求体并调用 stopGeneration()——它同步中止 quiet 请求所用的全局 abortController，
// 随后的 fetch 以已中止的信号立即失败，不会发出网络请求；再由我们以 stream:true 重发同一请求体。
// 非 Chat Completion API（没触发该事件）时 body 为 null，直接沿用 quiet 生成的结果。
async function captureMainPathRequest(ctx) {
    const { eventSource, event_types } = ctx;
    const eventName = event_types.CHAT_COMPLETION_SETTINGS_READY;
    let body = null;
    const listener = (data) => {
        if (body || !isRewriting) return;
        body = JSON.parse(JSON.stringify(data));
        ctx.stopGeneration();
    };
    // 最后执行，确保拿到其他扩展修改后的请求体
    if (typeof eventSource.makeLast === 'function') eventSource.makeLast(eventName, listener);
    else eventSource.on(eventName, listener);

    let fallback = '';
    try {
        fallback = await ctx.generateQuietPrompt({ quietPrompt: '' });
    } catch (e) {
        if (!body) throw e; // 捕获后的中止错误是预期内的
    } finally {
        eventSource.removeListener(eventName, listener);
        // quiet 生成本不会锁 UI（ST 的 is_send_press 只在非 quiet 时置位），
        // 但 stopGeneration 会触发 GENERATION_STOPPED，为稳妥起见显式兜底解锁一次。
        try { if (typeof ctx.unblockGeneration === 'function') ctx.unblockGeneration('quiet'); } catch { /* ignore */ }
    }
    return { body, fallback };
}

// 以流式发送请求体，每收到一段就用累计文本回调 onText，返回最终文本
async function streamChatCompletion(ctx, body, signal, onText) {
    const generator = await ctx.ChatCompletionService.sendRequest({ ...body, stream: true }, true, signal);
    let text = '';
    for await (const chunk of generator()) {
        if (typeof chunk?.text === 'string') text = chunk.text;
        onText(text);
    }
    return text;
}

// 流式过程中只刷新消息 DOM，不改 chat 数据；最终结果由调用方写回
function createStreamRenderer(ctx, idx, msg) {
    let pending = null, scheduled = false;
    return (text) => {
        pending = text;
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame(() => {
            scheduled = false;
            try {
                const $text = $(`#chat .mes[mesid="${idx}"] .mes_text`);
                if ($text.length) {
                    $text.html(ctx.messageFormatting(stripCodeFence(pending), msg.name, false, false, idx));
                }
            } catch { /* 渲染失败不影响生成 */ }
        });
    };
}

async function runRewriteStreaming(ctx, s, chat, idx, rewriteInstruction, conn) {
    const msg = chat[idx];
    const controller = new AbortController();
    const render = createStreamRenderer(ctx, idx, msg);
    const $toast = toastr.info('正在流式改写…（点此停止）', '', {
        timeOut: 0,
        extendedTimeOut: 0,
        tapToDismiss: false,
        onclick: () => controller.abort(),
    });
    let started = false;
    try {
        let body;
        if (s.rewriteUseMainPreset) {
            pendingTaskInjection = rewriteInstruction;
            const captured = await captureMainPathRequest(ctx);
            pendingTaskInjection = null;
            if (!captured.body) return String(captured.fallback ?? '');
            body = captured.body;
            // 自定义连接只覆盖请求体里的连接字段，其余（预设参数、世界书）原样保留
            applyConnectionOverrides(body, conn);
        } else {
            const settings = ctx.chatCompletionSettings || {};
            const messages = chat.filter(m => m && m.is_system !== true).map(m => ({
                role: m.is_user ? 'user' : 'assistant',
                content: String(m.mes ?? ''),
            }));
            messages.push({ role: 'user', content: rewriteInstruction });
            body = {
                ...connectionFields(conn),
                ...apiUrlFieldsForSource(settings, conn?.source),
                messages,
                max_tokens: settings.openai_max_tokens,
                temperature: Number(settings.temp_openai),
                custom_prompt_post_processing: settings.custom_prompt_post_processing,
            };
        }
        started = true;
        return await streamChatCompletion(ctx, body, controller.signal, render);
    } catch (e) {
        if (controller.signal.aborted) {
            const err = new Error('stopped');
            err.stoppedByUser = true;
            throw err;
        }
        throw e;
    } finally {
        toastr.clear($toast);
        // 流式期间 DOM 显示的是半成品，失败/停止时恢复原文；成功时调用方会再次刷新
        if (started) {
            try { ctx.updateMessageBlock(idx, msg); } catch { /* ignore */ }
        }
    }
}

async function runRewrite(instruction) {
    if (isRewriting || isCompressing) {
        toastr.warning('已有任务在进行中');
        return false;
    }
    instruction = String(instruction ?? '').trim();
    if (!instruction) {
        toastr.warning('请先在输入框写下改写要求，再点「改写上一条」');
        return false;
    }
    const ctx = SillyTavern.getContext();
    const s = getSettings();
    const chat = ctx.chat;
    if (!Array.isArray(chat) || chat.length === 0) {
        toastr.warning('当前没有聊天记录');
        return false;
    }
    const idx = findLastAssistantIndex(chat);
    if (idx < 0) {
        toastr.warning('没有可改写的 AI 消息');
        return false;
    }
    const msg = chat[idx];
    const original = String(msg.mes ?? '');

    const rewriteInstruction = [
        s.rewritePrompt,
        `Revision request: ${instruction}`,
        s.rewriteDiffMode ? REWRITE_FORMAT_DIFF : REWRITE_FORMAT_FULL,
    ].join('\n\n');

    let result = '';
    const conn = await resolveConnection(s, 'connRewrite');
    if (conn) warnConnection(conn, '改写');
    // 整条重写 + 流式：不显示遮罩，让生成过程直接显示在原消息上
    const streaming = !s.rewriteDiffMode && s.rewriteStream && ctx.mainApi === 'openai'
        && typeof ctx.ChatCompletionService?.sendRequest === 'function'
        && typeof ctx.stopGeneration === 'function';
    const loaderHandle = (!streaming && ctx.loader) ? ctx.loader.show({ message: '正在改写上一条…' }) : null;
    isRewriting = true;
    try {
        result = await withPreset(s.rewritePreset, async () => {
            if (streaming) {
                return await runRewriteStreaming(ctx, s, chat, idx, rewriteInstruction, conn);
            }
            // quiet 生成走完整 prompt 构建管线（预设/世界书/全量历史）。改写指令不经 quiet prompt
            // （那会以 system 角色注入末尾，OpenAI 兼容源上提 system 后以 assistant 结尾、
            // 触发 prefill 400），而是由拦截器以追加 user 消息注入，保证对话以 user 结尾。
            if (s.rewriteUseMainPreset) {
                pendingTaskInjection = rewriteInstruction;
                return await runMainPathTask(ctx, { conn, tag: '改写' });
            }
            // 直连路径：未隐藏的聊天内容 + 改写指令
            const messages = chat.filter(m => m && m.is_system !== true).map(m => ({
                role: m.is_user ? 'user' : 'assistant',
                content: String(m.mes ?? ''),
            }));
            messages.push({ role: 'user', content: rewriteInstruction });
            return await runDirectTask(ctx, {
                conn,
                presetName: s.rewritePreset,
                userPrompt: '',
                messages,
            }, '改写');
        });
    } catch (e) {
        if (e?.stoppedByUser) {
            toastr.info('已停止改写，原文未改动');
            return false;
        }
        console.error(LOG, '改写生成失败：', e);
        toastr.error('改写生成失败，详见控制台');
        return false;
    } finally {
        try {
            if (loaderHandle) await loaderHandle.hide();
        } finally {
            isRewriting = false;
            pendingTaskInjection = null;
        }
    }

    result = String(result ?? '').trim();
    if (!result) {
        toastr.error('改写失败：模型返回为空');
        return false;
    }

    let newText;
    let repaired = false;
    if (s.rewriteDiffMode) {
        const blocks = parseDiffBlocks(result);
        const firstPass = applyEditBlocks(original, blocks);
        let finalPass = firstPass;

        // 第一段只要有一个块解析/匹配失败，便从原文重新应用工具修复的完整 edits；
        // 全部成功时不发第二段请求，以节省 token 和延迟。
        if (s.rewriteToolRepair && (blocks.length === 0 || firstPass.fail > 0)) {
            const repairLoader = ctx.loader ? ctx.loader.show({ message: '正在结构化修复改写结果…' }) : null;
            isRewriting = true;
            try {
                const edits = await requestRewriteToolRepair(ctx, original, instruction, result, conn, s.rewritePreset);
                if (edits !== null) {
                    const repairPass = applyEditBlocks(original, edits);
                    // 修复结果反而全部失配时，保留第一段的部分成果
                    if (repairPass.ok > 0 || firstPass.ok === 0) {
                        finalPass = repairPass;
                        repaired = true;
                    } else {
                        console.warn(LOG, '结构化修复的 edits 全部失配，沿用第一段结果');
                    }
                }
            } finally {
                try {
                    if (repairLoader) await repairLoader.hide();
                } finally {
                    isRewriting = false;
                }
            }
        }

        if (!repaired && blocks.length === 0) {
            console.warn(LOG, '未解析出替换块，模型原始输出：', result);
            toastr.error('改写失败：未能从模型输出中解析出替换块（原文未改动，详见控制台）');
            return false;
        }
        if (finalPass.ok === 0) {
            toastr.error('改写失败：所有替换块都与原文不匹配（原文未改动）');
            return false;
        }
        if (finalPass.fail > 0) {
            toastr.warning(`有 ${finalPass.fail} 个替换块未匹配到原文，已应用其余 ${finalPass.ok} 个`);
        }
        newText = finalPass.text;
    } else {
        newText = stripCodeFence(result);
    }

    if (newText === original) {
        toastr.info('改写结果与原文相同，未做修改');
        return false;
    }

    // 原文备份为 swipe，可左滑找回
    if (!Array.isArray(msg.swipes) || msg.swipes.length === 0) {
        msg.swipes = [original];
        msg.swipe_id = 0;
    }
    if (!Number.isInteger(msg.swipe_id) || msg.swipe_id < 0 || msg.swipe_id >= msg.swipes.length) {
        msg.swipe_id = msg.swipes.length - 1;
    }
    if (!Array.isArray(msg.swipe_info) || msg.swipe_info.length !== msg.swipes.length) {
        msg.swipe_info = msg.swipes.map(() => ({
            send_date: msg.send_date,
            gen_started: msg.gen_started,
            gen_finished: msg.gen_finished,
            extra: structuredClone(msg.extra ?? {}),
        }));
    }
    msg.swipes.push(newText);
    msg.swipe_info.push({
        send_date: ctx.getMessageTimeStamp ? ctx.getMessageTimeStamp() : new Date().toISOString(),
        gen_started: msg.gen_started,
        gen_finished: msg.gen_finished,
        extra: structuredClone(msg.extra ?? {}),
    });
    msg.swipe_id = msg.swipes.length - 1;
    msg.mes = newText;

    try {
        if (typeof ctx.updateMessageBlock === 'function') {
            ctx.updateMessageBlock(idx, msg);
        } else if (ctx.reloadCurrentChat) {
            await ctx.reloadCurrentChat();
        }
    } catch (e) {
        console.warn(LOG, '刷新消息渲染失败：', e);
    }
    try {
        await ctx.eventSource.emit(ctx.event_types.MESSAGE_UPDATED, idx);
    } catch { /* 事件通知失败不影响主流程 */ }
    try {
        if (ctx.saveChat) await ctx.saveChat();
    } catch (e) {
        console.warn(LOG, 'saveChat 失败：', e);
    }

    toastr.success(s.rewriteDiffMode
        ? `改写完成${repaired ? '（经工具修复）' : ''}（原文已存为 swipe，可左滑找回）`
        : '已整条重写（原文已存为 swipe）');
    return true;
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
        if (!s.enabled || !s.autoMode || isCompressing || isRewriting) return;
        if (s.autoTrigger === 'tokens') {
            // 回复已落库后再计数
            setTimeout(async () => {
                try {
                    if (isCompressing || isRewriting) return;
                    const tokens = await countHistoryTokens();
                    refreshCounterDisplay(tokens);
                    const limit = Math.max(1, Number(s.autoTokens) || 20000);
                    if (tokens >= limit) await runCompression(undefined, { silent: true });
                } catch (e) {
                    console.warn(LOG, '按 token 自动压缩出错：', e);
                }
            }, 500);
            return;
        }
        const every = Math.max(1, Number(s.autoEvery) || 10);
        if (countUserTurns() >= every) {
            // 回复已落库，此刻后台压缩安全
            setTimeout(() => runCompression(undefined, { silent: true }), 500);
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
function addOptionsMenuButton() {
    if ($('#option_compress_context').length) return;
    const html = `
        <a id="option_compress_context" class="interactable" tabindex="0">
            <i class="fa-lg fa-solid fa-file-zipper"></i>
            <span>压缩上下文</span>
        </a>`;
    const $anchor = $('#option_continue');
    if ($anchor.length) {
        $anchor.after(html);
    } else {
        $('#options .options-content').append(html);
    }
    $(document).on('click', '#option_compress_context', async function () {
        try { $('#options').hide(); } catch { /* ignore */ }
        await runCompression();
    });
}

function addRewriteMenuButton() {
    if ($('#option_rewrite_last').length) return;
    const html = `
        <a id="option_rewrite_last" class="interactable" tabindex="0">
            <i class="fa-lg fa-solid fa-pen-nib"></i>
            <span>改写上一条</span>
        </a>`;
    const $anchor = $('#option_compress_context');
    if ($anchor.length) {
        $anchor.after(html);
    } else {
        $('#options .options-content').append(html);
    }
    $(document).on('click', '#option_rewrite_last', async function () {
        try { $('#options').hide(); } catch { /* ignore */ }
        const $ta = $('#send_textarea');
        const ok = await runRewrite(String($ta.val() ?? ''));
        // 成功后清空输入框（触发 input 让 ST 刷新 token 计数等）；失败保留指令便于重试
        if (ok) $ta.val('').trigger('input');
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

// 生成一块「自定义连接」设置区。taskId 用于区分压缩 / 改写的 DOM id 与设置键。
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
          <b>压缩与改写</b>
          <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">

          <label class="checkbox_label" for="cc_enabled">
            <input id="cc_enabled" type="checkbox" />
            <span>启用本扩展</span>
          </label>

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
            <span>保留最近</span>
            <input id="cc_keep_last" type="number" min="0" step="1" class="text_pole" style="max-width:80px;" />
            <span>条不压缩</span>
          </div>
          <label class="checkbox_label" for="cc_include_kept">
            <input id="cc_include_kept" type="checkbox" />
            <span>保留的消息也发送并一起总结</span>
          </label>
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

          <hr>
          <h4>改写上一条</h4>

          <label class="checkbox_label" for="cc_rw_main_preset">
            <input id="cc_rw_main_preset" type="checkbox" />
            <span>使用主路径预设</span>
          </label>
          <small class="notes">开启后带上当前主对话的预设、世界书和上下文；关闭时仅发送未隐藏的聊天内容和改写指令。默认开启。</small>

          <label for="cc_rw_preset">改写用预设</label>
          <select id="cc_rw_preset" class="text_pole cc_preset_select"></select>
          <small class="notes">改写时临时切换到此预设，完成后切回。<br>注意：切换预设会重新载入预设文件，当前预设未保存的改动会丢失，请先保存。</small>
${buildConnectionHtml('rewrite', '改写连接（源 / 代理预设 / 模型）',
        '开启后改写请求会走这里指定的源、代理和模型；结构修复请求也一并跟随。开了「使用主路径预设」时提示词仍由主路径构建，只替换连接。')}

          <label class="checkbox_label" for="cc_rw_diff">
            <input id="cc_rw_diff" type="checkbox" />
            <span>局部替换模式（模型只输出改动片段，省 token、不动其余部分；关闭则整条重写）</span>
          </label>

          <label class="checkbox_label" for="cc_rw_repair">
            <input id="cc_rw_repair" type="checkbox" />
            <span>解析失败时用独立工具调用修复（不改动主对话）</span>
          </label>

          <label class="checkbox_label" for="cc_rw_stream">
            <input id="cc_rw_stream" type="checkbox" />
            <span>整条重写时流式输出（边生成边显示在原消息上，点提示可停止）</span>
          </label>

          <label for="cc_rw_prompt">改写提示词</label>
          <textarea id="cc_rw_prompt" class="text_pole textarea_compact" rows="4"></textarea>
          <small class="notes">用法：在输入框写下改写要求，点“选项”菜单里的「改写上一条」，或用 <code>/rewrite 要求</code>。指令不进聊天记录；原文自动存为 swipe，可左滑找回。</small>

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
        names, s.compressPreset, s.rewritePreset,
        s.connCompress, s.connRewrite,
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
    fill('#cc_rw_preset', s.rewritePreset);
    await refreshConnectionUI(s);
}

const CC_CONN_TASKS = Object.freeze([
    ['compress', 'connCompress'],
    ['rewrite', 'connRewrite'],
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
    $('#cc_auto').prop('checked', s.autoMode);
    $('#cc_auto_every').val(s.autoEvery);
    $('#cc_compress_main_preset').prop('checked', s.compressUseMainPreset);
    $('#cc_prompt').val(s.compressPrompt);
    $('#cc_role').val(s.compressRole);
    $('#cc_prefix').val(s.summaryPrefix);
    $('#cc_hide').prop('checked', s.hideOriginals);
    $('#cc_keep_last').val(s.compressKeepLast);
    $('#cc_include_kept').prop('checked', s.compressIncludeKept);
    $('#cc_auto_trigger').val(s.autoTrigger);
    $('#cc_auto_tokens').val(s.autoTokens);
    $('#cc_rw_main_preset').prop('checked', s.rewriteUseMainPreset);
    $('#cc_rw_diff').prop('checked', s.rewriteDiffMode);
    $('#cc_rw_repair').prop('checked', s.rewriteToolRepair);
    $('#cc_rw_stream').prop('checked', s.rewriteStream);
    $('#cc_rw_prompt').val(s.rewritePrompt);
    refreshCounterDisplay();
}

function bindUI() {
    const s = getSettings();

    $('#cc_enabled').on('change', function () { s.enabled = $(this).prop('checked'); save(); });
    $('#cc_auto').on('change', function () { s.autoMode = $(this).prop('checked'); save(); refreshCounterDisplay(); });
    $('#cc_auto_every').on('input', function () { s.autoEvery = Math.max(1, parseInt($(this).val()) || 10); save(); refreshCounterDisplay(); });
    $('#cc_compress_main_preset').on('change', function () { s.compressUseMainPreset = $(this).prop('checked'); save(); });
    $('#cc_compress_preset').on('change', function () { s.compressPreset = String($(this).val() ?? ''); save(); });
    $('#cc_rw_preset').on('change', function () { s.rewritePreset = String($(this).val() ?? ''); save(); });
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
    $('#cc_auto_trigger').on('change', function () { s.autoTrigger = String($(this).val()); save(); refreshCounterDisplay(); });
    $('#cc_auto_tokens').on('input', function () { s.autoTokens = Math.max(1, parseInt($(this).val()) || 20000); save(); refreshCounterDisplay(); });
    $('#cc_keep_last').on('input', function () { s.compressKeepLast = Math.max(0, parseInt($(this).val()) || 0); save(); });
    $('#cc_rw_main_preset').on('change', function () { s.rewriteUseMainPreset = $(this).prop('checked'); save(); });
    $('#cc_rw_diff').on('change', function () { s.rewriteDiffMode = $(this).prop('checked'); save(); });
    $('#cc_rw_repair').on('change', function () { s.rewriteToolRepair = $(this).prop('checked'); save(); });
    $('#cc_rw_stream').on('change', function () { s.rewriteStream = $(this).prop('checked'); save(); });
    $('#cc_rw_prompt').on('input', function () { s.rewritePrompt = String($(this).val()); save(); });

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
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name: 'rewrite',
            helpString: '按指令局部改写最后一条 AI 回复（原文存为 swipe）。用法：/rewrite 把结尾改含蓄一点',
            callback: async (_named, unnamed) => {
                await runRewrite(String(unnamed ?? ''));
                return '';
            },
            unnamedArgumentList: SlashCommandArgument ? [
                SlashCommandArgument.fromProps({
                    description: '改写要求',
                    typeList: ARGUMENT_TYPE ? [ARGUMENT_TYPE.STRING] : undefined,
                    isRequired: true,
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
        addOptionsMenuButton();
        addRewriteMenuButton();
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
