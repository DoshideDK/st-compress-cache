/*
 * 压缩与缓存断点 (Compress & Cache Breakpoints)
 * SillyTavern 第三方 UI 扩展
 *
 * 功能：
 *  1) 上下文压缩（两种模式）：
 *     - 手动模式（默认）：压缩“上一次压缩点之后”的全部消息；也可指定条数。
 *     - 自动模式：用户每发送 N 条消息（编辑重发不计入），在当次回复结束后
 *       自动压缩上次压缩点之后的消息。自动模式开启时仍可随时手动压缩。
 *     触发入口：设置面板按钮、输入框旁“选项”菜单（重新生成/AI帮答/续写 同级）、/compress 命令。
 *  2) 改写上一条：在输入框写下改写要求，点“选项”菜单里的「改写上一条」或
 *     /rewrite 命令，对最后一条 AI 回复做局部改写（搜索替换块）或整条重写。
 *     指令不进存档；原文保存为 swipe；请求命中已有缓存前缀（只在最后一条
 *     user 消息打断点，与上一轮位置一致，纯命中、零新写入）。
 *  3) 三组缓存断点（TTL 可配）：
 *       - 上次压缩结果所在的消息（默认关闭）
 *       - 倒数第一条 assistant 消息
 *       - 输入消息（最后一条 user 消息）
 *     断点通过 gproxy 的“魔法字符串”注入：gproxy 会在发送前删除触发串、
 *     并在该位置写入原生缓存标记。注入只作用于本次请求、不写回存档。
 *
 * gproxy 用法参考：https://gproxy.leenhawk.com/guides/claude-caching/
 */

const MODULE_NAME = 'compress_cache';
const LOG = '[压缩与缓存断点]';

// gproxy 官方固定魔法字符串（按 TTL）
const GPROXY_MAGIC = Object.freeze({
    'default': 'GPROXY_MAGIC_STRING_TRIGGER_CACHING_CREATE_7D9ASD7A98SD7A9S8D79ASC98A7FNKJBVV80SCMSHDSIUCH',
    '5m':      'GPROXY_MAGIC_STRING_TRIGGER_CACHING_CREATE_49VA1S5V19GR4G89W2V695G9W9GV52W95V198WV5W2FC9DF',
    '1h':      'GPROXY_MAGIC_STRING_TRIGGER_CACHING_CREATE_1FAS5GV9R5H29T5Y2J9584K6O95M2NBVW52C95CX984FRJY',
});

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
    compressPrompt:
        'You are a context compressor for a roleplay chat. Faithfully compress the ' +
        'conversation below into one concise memory summary. Preserve key plot points, ' +
        'character states and relationships, locations, promises made, and unresolved ' +
        'threads. Drop greetings and repetition. Write in third person, past tense, in ' +
        'the same language as the conversation. Output only the summary text, with no ' +
        'preamble and no explanations.',
    compressRole: 'assistant',  // 摘要写回时的角色：assistant / user
    hideOriginals: true,        // 压缩后是否把原始消息隐藏出上下文
    summaryPrefix: '【压缩记忆】\n',

    // —— 改写上一条 ——
    rewriteUseMainPreset: true, // 默认保留完整主路径；关闭时仅发送可见聊天和改写指令
    rewriteDiffMode: true,      // true：模型只输出改动片段（搜索替换块）；false：整条重写
    rewriteToolRepair: true,    // 局部替换解析/匹配失败时，用独立工具调用修复格式
    rewritePrompt:
        'You are revising the latest assistant reply in the conversation above. Apply the ' +
        'revision request with the minimal necessary changes: keep the wording, style, ' +
        'formatting and all content not covered by the request unchanged. Write in the same ' +
        'language as the original reply.',

    // —— 模式 ——
    autoMode: false,            // 自动模式开关（关闭即手动模式）
    autoEvery: 10,              // 用户每发送多少条消息自动压缩一次

    // —— 缓存断点 ——
    cacheMode: 'magic',         // magic（gproxy 魔法字符串） / off
    gpDefault: GPROXY_MAGIC['default'],
    gp5m:      GPROXY_MAGIC['5m'],
    gp1h:      GPROXY_MAGIC['1h'],

    bpCompression:   { enabled: false, ttl: '1h' },
    bpLastAssistant: { enabled: true,  ttl: '5m' },
    bpInput:         { enabled: true,  ttl: '5m' },
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
    for (const bp of ['bpCompression', 'bpLastAssistant', 'bpInput']) {
        if (typeof s[bp] !== 'object' || s[bp] === null) s[bp] = structuredClone(DEFAULT_SETTINGS[bp]);
        if (!Object.hasOwn(s[bp], 'enabled')) s[bp].enabled = DEFAULT_SETTINGS[bp].enabled;
        if (!Object.hasOwn(s[bp], 'ttl')) s[bp].ttl = DEFAULT_SETTINGS[bp].ttl;
    }
    return s;
}

function save() {
    SillyTavern.getContext().saveSettingsDebounced();
}

// —— 每聊天状态（用户输入计数，编辑重发不触发 MESSAGE_SENT，自然不计入） ——
function getChatState() {
    const md = SillyTavern.getContext().chatMetadata;
    if (!md[MODULE_NAME] || typeof md[MODULE_NAME] !== 'object') {
        md[MODULE_NAME] = { userMsgCount: 0 };
    }
    if (!Object.hasOwn(md[MODULE_NAME], 'userMsgCount')) md[MODULE_NAME].userMsgCount = 0;
    return md[MODULE_NAME];
}

function saveChatState() {
    const ctx = SillyTavern.getContext();
    try {
        if (ctx.saveMetadataDebounced) ctx.saveMetadataDebounced();
        else if (ctx.saveMetadata) ctx.saveMetadata();
    } catch (e) {
        console.warn(LOG, '保存聊天元数据失败：', e);
    }
}

function isSummaryMessage(m) {
    return !!(m && m.extra && m.extra[MODULE_NAME] && m.extra[MODULE_NAME].isCompression);
}

// 按 TTL 取 gproxy 触发串
function markerForTtl(s, ttl) {
    if (ttl === '5m') return s.gp5m || GPROXY_MAGIC['5m'];
    if (ttl === '1h') return s.gp1h || GPROXY_MAGIC['1h'];
    return s.gpDefault || GPROXY_MAGIC['default'];
}

// ============================================================
//  生成拦截器：注入缓存断点魔法字符串（全局函数，供 manifest 引用）
// ============================================================

// 合并类“提示词后处理”会把相邻同角色消息拼成一个字符串：若预设在对话记录后
// 还有同角色固定提示词，会被拼进被标记的输入消息里，导致该断点每轮都 miss。
// （Claude 源不受影响：其合并保留独立 text block，gproxy 按 block 打标。）
let mergeRiskWarned = false;
function warnIfMergeRisk(s) {
    try {
        if (mergeRiskWarned || !s.bpInput.enabled) return;
        const cc = SillyTavern.getContext().chatCompletionSettings;
        if (!cc) return;
        const merging = ['claude', 'merge', 'merge_tools', 'semi', 'semi_tools', 'strict', 'strict_tools', 'single']
            .includes(String(cc.custom_prompt_post_processing || ''));
        if (merging) {
            mergeRiskWarned = true;
            console.warn(LOG, '提示词后处理为合并类模式，「输入消息」断点可能因同角色消息合并而失效');
            toastr.warning(
                '当前“提示词后处理”为合并类模式：若预设在对话记录后紧跟同角色固定提示词，「输入消息」断点可能每轮失效。建议后处理选“无”，或直接使用 Claude 源。',
                '压缩与缓存断点', { timeOut: 12000 });
        }
    } catch { /* 静默 */ }
}

globalThis.compressCacheInterceptor = async function (chat, _contextSize, _abort, type) {
    try {
        const s = getSettings();
        if (!Array.isArray(chat)) return;

        // —— 使用主路径的任务（须先于 enabled/cacheMode 检查：任务指令必须注入）——
        // 1) 改写缓存断点：Claude 只有在请求带缓存标记时才会查缓存，因此改写时打一个断点。
        //    打在最后一条 user 消息上——与上一轮的「输入消息」断点位置一致，前缀完全相同，
        //    纯命中已有缓存、不产生新写入。不打在待改写的 assistant 消息上（它马上要变，写了也浪费）。
        // 2) 指令注入：任务指令以“追加的 user 消息”放在对话末尾，而不是走 quiet prompt。
        //    ST 的 quiet prompt 固定以 system 角色注入在末尾；OpenAI 兼容源（如 gproxy 的
        //    claudecode 后端）会把 system 上提，导致对话以 assistant 结尾，触发
        //    “assistant prefill 不支持”400 错误。以 user 消息结尾对任何源都安全。
        if ((isRewriting || isCompressing) && pendingTaskInjection) {
            // 压缩走主路径时仍不添加缓存断点。
            const useMarker = isRewriting && s.enabled && s.cacheMode === 'magic';
            if (useMarker) {
                for (let i = chat.length - 1; i >= 0; i--) {
                    const m = chat[i];
                    if (m && m.is_user === true && m.is_system !== true) {
                        const marker = markerForTtl(s, s.bpInput.ttl);
                        if (marker) {
                            const clone = structuredClone(m);
                            clone.mes = (clone.mes ?? '') + '\n' + marker;
                            chat[i] = clone;
                        }
                        break;
                    }
                }
            }
            const ctx = SillyTavern.getContext();
            chat.push({
                name: ctx?.name1 || 'User',
                is_user: true,
                is_system: false,
                send_date: ctx?.getMessageTimeStamp ? ctx.getMessageTimeStamp() : new Date().toISOString(),
                mes: pendingTaskInjection,
                extra: {},
            });
            return;
        }

        if (!s.enabled || s.cacheMode !== 'magic') return;
        if (isCompressing || isRewriting || type === 'quiet') return;

        warnIfMergeRisk(s);

        let idxCompression = -1, idxLastAssistant = -1, idxInput = -1;
        for (let i = chat.length - 1; i >= 0; i--) {
            const m = chat[i];
            if (!m) continue;
            if (idxCompression === -1 && isSummaryMessage(m)) idxCompression = i;
            if (idxLastAssistant === -1 && m.is_user === false && m.is_system !== true) idxLastAssistant = i;
            if (idxInput === -1 && m.is_user === true && m.is_system !== true) idxInput = i;
            if (idxCompression !== -1 && idxLastAssistant !== -1 && idxInput !== -1) break;
        }

        const applied = new Set();
        const apply = (idx, ttl) => {
            if (idx < 0 || applied.has(idx)) return;
            const marker = markerForTtl(s, ttl);
            if (!marker) return;
            const clone = structuredClone(chat[idx]);
            clone.mes = (clone.mes ?? '') + '\n' + marker;
            chat[idx] = clone;
            applied.add(idx);
        };

        if (s.bpCompression.enabled)   apply(idxCompression,   s.bpCompression.ttl);
        if (s.bpLastAssistant.enabled) apply(idxLastAssistant, s.bpLastAssistant.ttl);
        if (s.bpInput.enabled)         apply(idxInput,         s.bpInput.ttl);
    } catch (e) {
        console.error(LOG, '拦截器出错：', e);
    }
};

// ============================================================
//  压缩范围选择
// ============================================================
// countOverride 为数字时：取最近 N 条可压缩消息（旧行为）。
// 否则：取“上一次压缩摘要之后”的全部可压缩消息；没有摘要则取全部。
function collectTargets(countOverride) {
    const chat = SillyTavern.getContext().chat;
    if (!Array.isArray(chat) || chat.length === 0) return [];

    const eligible = (m) => m && m.is_system !== true && !isSummaryMessage(m);

    if (Number.isFinite(countOverride) && countOverride > 0) {
        const targets = [];
        for (let i = chat.length - 1; i >= 0 && targets.length < countOverride; i--) {
            if (eligible(chat[i])) targets.push(i);
        }
        targets.reverse();
        return targets;
    }

    let lastSummary = -1;
    for (let i = chat.length - 1; i >= 0; i--) {
        if (isSummaryMessage(chat[i])) { lastSummary = i; break; }
    }
    const targets = [];
    for (let i = lastSummary + 1; i < chat.length; i++) {
        if (eligible(chat[i])) targets.push(i);
    }
    return targets;
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

    const targets = collectTargets(countOverride);
    if (targets.length === 0) {
        if (!silent) toastr.warning('上次压缩之后没有新消息可压缩');
        return;
    }

    const transcript = targets.map((i) => {
        const m = chat[i];
        const who = m.is_user ? (ctx.name1 || 'User') : (m.name || ctx.name2 || 'Character');
        return `${who}: ${m.mes ?? ''}`;
    }).join('\n\n');

    let result = '';
    const loaderHandle = ctx.loader ? ctx.loader.show({ message: '正在压缩上下文…' }) : null;
    isCompressing = true;
    try {
        if (s.compressUseMainPreset) {
            pendingTaskInjection = [
                s.compressPrompt,
                'Summarize ONLY the conversation excerpt below. Use the preceding context only as background. Output only the summary.',
                '--- CONVERSATION TO COMPRESS ---',
                transcript,
                '--- END CONVERSATION ---',
            ].join('\n\n');
            result = await ctx.generateQuietPrompt({ quietPrompt: '' });
        } else {
            result = await ctx.generateRaw({
                systemPrompt: s.compressPrompt,
                prompt: transcript,
            });
        }
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
            if (ctx.reloadCurrentChat) await ctx.reloadCurrentChat();
        }
    }

    chat.push(newMsg);
    try {
        if (ctx.addOneMessage) ctx.addOneMessage(newMsg);
    } catch (e) {
        console.warn(LOG, 'addOneMessage 失败：', e);
    }
    try {
        if (ctx.saveChat) await ctx.saveChat();
    } catch (e) {
        console.warn(LOG, 'saveChat 失败：', e);
    }

    // 压缩完成后重置用户输入计数
    const st = getChatState();
    st.userMsgCount = 0;
    saveChatState();
    refreshCounterDisplay();

    toastr.success(`已压缩 ${targets.length} 条消息`);
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

function getRewriteRepairModel(settings, source) {
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

async function requestRewriteToolRepair(ctx, original, instruction, draft) {
    const service = ctx.ChatCompletionService;
    if (!service || typeof service.processRequest !== 'function') {
        console.warn(LOG, '当前 SillyTavern 版本未提供 ChatCompletionService，跳过结构化改写修复');
        return null;
    }

    const settings = ctx.chatCompletionSettings || {};
    const source = settings.chat_completion_source;
    const model = getRewriteRepairModel(settings, source);
    const payload = {
        stream: false,
        messages: [{
            role: 'user',
            content: buildRewriteRepairPrompt(original, instruction, draft),
        }],
        chat_completion_source: source,
        max_tokens: 2048,
        json_schema: structuredClone(REWRITE_REPAIR_SCHEMA),
    };
    if (model) payload.model = model;
    if (String(source ?? '').toLowerCase() === 'custom' && settings.custom_url) {
        payload.custom_url = settings.custom_url;
    }
    if (settings.reverse_proxy) payload.reverse_proxy = settings.reverse_proxy;
    if (settings.proxy_password) payload.proxy_password = settings.proxy_password;

    try {
        // 独立自定义请求不经过 generate 拦截器管线，因此不会带魔法字符串缓存标记，
        // 也不会改变主对话的严格缓存前缀；请求本身只含上面的三段修复材料。
        let data = await service.processRequest(payload, {}, false);
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
    const loaderHandle = ctx.loader ? ctx.loader.show({ message: '正在改写上一条…' }) : null;
    isRewriting = true;
    try {
        // quiet 生成走完整 prompt 构建管线（预设/世界书/全量历史）。改写指令不经 quiet prompt
        // （那会以 system 角色注入末尾，OpenAI 兼容源上提 system 后以 assistant 结尾、
        // 触发 prefill 400），而是由拦截器以追加 user 消息注入，保证对话以 user 结尾。
        if (s.rewriteUseMainPreset) {
            pendingTaskInjection = rewriteInstruction;
            result = await ctx.generateQuietPrompt({ quietPrompt: '' });
        } else {
            const messages = chat.filter(m => m && m.is_system !== true).map(m => ({
                role: m.is_user ? 'user' : 'assistant',
                content: String(m.mes ?? ''),
            }));
            messages.push({ role: 'user', content: rewriteInstruction });
            result = await ctx.generateRaw({ prompt: messages });
        }
    } catch (e) {
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
                const edits = await requestRewriteToolRepair(ctx, original, instruction, result);
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
function onMessageSent() {
    try {
        const st = getChatState();
        st.userMsgCount = (st.userMsgCount || 0) + 1;
        saveChatState();
        refreshCounterDisplay();
    } catch (e) {
        console.warn(LOG, 'onMessageSent 出错：', e);
    }
}

function onGenerationEnded() {
    try {
        const s = getSettings();
        if (!s.enabled || !s.autoMode || isCompressing || isRewriting) return;
        const st = getChatState();
        const every = Math.max(1, Number(s.autoEvery) || 10);
        if ((st.userMsgCount || 0) >= every) {
            // 回复已落库，此刻后台压缩安全
            setTimeout(() => runCompression(undefined, { silent: true }), 500);
        }
    } catch (e) {
        console.warn(LOG, 'onGenerationEnded 出错：', e);
    }
}

function refreshCounterDisplay() {
    try {
        const s = getSettings();
        const st = getChatState();
        const every = Math.max(1, Number(s.autoEvery) || 10);
        $('#cc_counter').text(`${st.userMsgCount || 0} / ${every}`);
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
function ttlOptions(val) {
    const opt = (v, label) => `<option value="${v}"${val === v ? ' selected' : ''}>${label}</option>`;
    return opt('default', 'default（渠道默认）') + opt('5m', '5m') + opt('1h', '1h');
}

function buildSettingsHtml() {
    return `
    <div class="compress-cache-settings">
      <div class="inline-drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
          <b>压缩与缓存断点</b>
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
            <span>自动模式：用户每发送若干条消息后自动压缩</span>
          </label>
          <div class="flex-container" style="align-items:center; gap:6px;">
            <span>每</span>
            <input id="cc_auto_every" type="number" min="1" step="1" class="text_pole" style="max-width:80px;" />
            <span>条用户输入压缩一次（当前计数：<span id="cc_counter">0 / 10</span>）</span>
          </div>
          <small class="notes">关闭自动模式即为手动模式。两种模式下都压缩“上一次压缩点之后”的消息；自动模式开启时也随时可以手动压缩。编辑重发不计入条数。</small>

          <div class="flex-container" style="margin-top:8px; align-items:center; gap:6px;">
            <input id="cc_run" class="menu_button" type="button" value="立即压缩" />
            <input id="cc_run_input" class="text_pole" type="number" min="1" step="1"
                   style="max-width:90px;" title="可选：只压缩最近 N 条" placeholder="条数(可选)" />
          </div>
          <small class="notes">“立即压缩”默认压缩上次压缩点之后的全部消息；填了条数则只压缩最近 N 条。输入框旁的“选项”菜单（重新生成/AI帮答/续写）里也有同款按钮。</small>

          <hr>
          <h4>压缩参数</h4>

          <label class="checkbox_label" for="cc_compress_main_preset">
            <input id="cc_compress_main_preset" type="checkbox" />
            <span>使用主路径预设</span>
          </label>
          <small class="notes">开启后带上当前主对话的预设、世界书和上下文，仍只压缩选定范围；关闭时仅发送压缩提示词和待压缩消息。默认关闭。</small>

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
          <small class="notes">开启后带上当前主对话的预设、世界书和上下文，并复用主对话缓存；关闭时仅发送未隐藏的聊天内容和改写指令，不添加主对话缓存断点。默认开启。</small>

          <label class="checkbox_label" for="cc_rw_diff">
            <input id="cc_rw_diff" type="checkbox" />
            <span>局部替换模式（模型只输出改动片段，省 token、不动其余部分；关闭则整条重写）</span>
          </label>

          <label class="checkbox_label" for="cc_rw_repair">
            <input id="cc_rw_repair" type="checkbox" />
            <span>解析失败时用独立工具调用修复（不影响缓存）</span>
          </label>

          <label for="cc_rw_prompt">改写提示词</label>
          <textarea id="cc_rw_prompt" class="text_pole textarea_compact" rows="4"></textarea>
          <small class="notes">用法：在输入框写下改写要求，点“选项”菜单里的「改写上一条」，或用 <code>/rewrite 要求</code>。指令不进聊天记录；原文自动存为 swipe，可左滑找回。使用主路径预设时可复用已有缓存前缀。</small>

          <hr>
          <h4>缓存断点（gproxy 魔法字符串）</h4>

          <label for="cc_mode">断点开关</label>
          <select id="cc_mode" class="text_pole">
            <option value="magic">开启（魔法字符串）</option>
            <option value="off">关闭</option>
          </select>
          <small class="notes">需在 gproxy 对应渠道打开 “Magic-string cache”。每次请求最多 4 个缓存标记，本扩展最多用 3 个。</small>

          <table class="cc_bp_table" style="width:100%; margin-top:8px;">
            <tr>
              <th style="text-align:left;">断点</th>
              <th style="width:80px;">启用</th>
              <th style="width:150px;">TTL</th>
            </tr>
            <tr>
              <td>上次压缩结果</td>
              <td><input id="cc_bp1_en" type="checkbox" /></td>
              <td><select id="cc_bp1_ttl" class="text_pole">${ttlOptions('1h')}</select></td>
            </tr>
            <tr>
              <td>倒数第一条 assistant</td>
              <td><input id="cc_bp2_en" type="checkbox" /></td>
              <td><select id="cc_bp2_ttl" class="text_pole">${ttlOptions('5m')}</select></td>
            </tr>
            <tr>
              <td>输入消息（最后一条 user）</td>
              <td><input id="cc_bp3_en" type="checkbox" /></td>
              <td><select id="cc_bp3_ttl" class="text_pole">${ttlOptions('5m')}</select></td>
            </tr>
          </table>
          <small class="notes">断点仅进入本次请求、不写回存档；gproxy 会在发送前移除触发串。</small>

          <div class="inline-drawer" style="margin-top:8px;">
            <div class="inline-drawer-toggle inline-drawer-header">
              <b>高级：gproxy 触发串</b>
              <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
              <small class="notes">一般无需改动；仅当 gproxy 更新了魔法字符串时覆盖。</small>
              <label for="cc_gp_default">default</label>
              <input id="cc_gp_default" type="text" class="text_pole" />
              <label for="cc_gp_5m">5m</label>
              <input id="cc_gp_5m" type="text" class="text_pole" />
              <label for="cc_gp_1h">1h</label>
              <input id="cc_gp_1h" type="text" class="text_pole" />
            </div>
          </div>

        </div>
      </div>
    </div>`;
}

function refreshUI() {
    const s = getSettings();
    $('#cc_enabled').prop('checked', s.enabled);
    $('#cc_auto').prop('checked', s.autoMode);
    $('#cc_auto_every').val(s.autoEvery);
    $('#cc_compress_main_preset').prop('checked', s.compressUseMainPreset);
    $('#cc_prompt').val(s.compressPrompt);
    $('#cc_role').val(s.compressRole);
    $('#cc_prefix').val(s.summaryPrefix);
    $('#cc_hide').prop('checked', s.hideOriginals);
    $('#cc_rw_main_preset').prop('checked', s.rewriteUseMainPreset);
    $('#cc_rw_diff').prop('checked', s.rewriteDiffMode);
    $('#cc_rw_repair').prop('checked', s.rewriteToolRepair);
    $('#cc_rw_prompt').val(s.rewritePrompt);
    $('#cc_mode').val(s.cacheMode);
    $('#cc_bp1_en').prop('checked', s.bpCompression.enabled);
    $('#cc_bp1_ttl').val(s.bpCompression.ttl);
    $('#cc_bp2_en').prop('checked', s.bpLastAssistant.enabled);
    $('#cc_bp2_ttl').val(s.bpLastAssistant.ttl);
    $('#cc_bp3_en').prop('checked', s.bpInput.enabled);
    $('#cc_bp3_ttl').val(s.bpInput.ttl);
    $('#cc_gp_default').val(s.gpDefault);
    $('#cc_gp_5m').val(s.gp5m);
    $('#cc_gp_1h').val(s.gp1h);
    refreshCounterDisplay();
}

function bindUI() {
    const s = getSettings();

    $('#cc_enabled').on('change', function () { s.enabled = $(this).prop('checked'); save(); });
    $('#cc_auto').on('change', function () { s.autoMode = $(this).prop('checked'); save(); refreshCounterDisplay(); });
    $('#cc_auto_every').on('input', function () { s.autoEvery = Math.max(1, parseInt($(this).val()) || 10); save(); refreshCounterDisplay(); });
    $('#cc_compress_main_preset').on('change', function () { s.compressUseMainPreset = $(this).prop('checked'); save(); });
    $('#cc_prompt').on('input', function () { s.compressPrompt = String($(this).val()); save(); });
    $('#cc_role').on('change', function () { s.compressRole = String($(this).val()); save(); });
    $('#cc_prefix').on('input', function () { s.summaryPrefix = String($(this).val()); save(); });
    $('#cc_hide').on('change', function () { s.hideOriginals = $(this).prop('checked'); save(); });
    $('#cc_rw_main_preset').on('change', function () { s.rewriteUseMainPreset = $(this).prop('checked'); save(); });
    $('#cc_rw_diff').on('change', function () { s.rewriteDiffMode = $(this).prop('checked'); save(); });
    $('#cc_rw_repair').on('change', function () { s.rewriteToolRepair = $(this).prop('checked'); save(); });
    $('#cc_rw_prompt').on('input', function () { s.rewritePrompt = String($(this).val()); save(); });

    $('#cc_mode').on('change', function () { s.cacheMode = String($(this).val()); save(); });

    $('#cc_bp1_en').on('change', function () { s.bpCompression.enabled = $(this).prop('checked'); save(); });
    $('#cc_bp1_ttl').on('change', function () { s.bpCompression.ttl = String($(this).val()); save(); });
    $('#cc_bp2_en').on('change', function () { s.bpLastAssistant.enabled = $(this).prop('checked'); save(); });
    $('#cc_bp2_ttl').on('change', function () { s.bpLastAssistant.ttl = String($(this).val()); save(); });
    $('#cc_bp3_en').on('change', function () { s.bpInput.enabled = $(this).prop('checked'); save(); });
    $('#cc_bp3_ttl').on('change', function () { s.bpInput.ttl = String($(this).val()); save(); });

    $('#cc_gp_default').on('input', function () { s.gpDefault = String($(this).val()); save(); });
    $('#cc_gp_5m').on('input', function () { s.gp5m = String($(this).val()); save(); });
    $('#cc_gp_1h').on('input', function () { s.gp1h = String($(this).val()); save(); });

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
            helpString: '按指令局部改写最后一条 AI 回复（原文存为 swipe，缓存前缀保留）。用法：/rewrite 把结尾改含蓄一点',
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
        refreshUI();
        bindUI();
        addOptionsMenuButton();
        addRewriteMenuButton();
        registerSlashCommand();

        const { eventSource, event_types } = ctx;
        eventSource.on(event_types.MESSAGE_SENT, onMessageSent);
        eventSource.on(event_types.GENERATION_ENDED, onGenerationEnded);
        eventSource.on(event_types.CHAT_CHANGED, refreshCounterDisplay);

        console.log(LOG, '已加载');
    } catch (e) {
        console.error(LOG, '初始化失败：', e);
    }
});
