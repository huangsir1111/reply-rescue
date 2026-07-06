import {
    chat,
    characters,
    chat_metadata,
    ensureSwipes,
    eventSource,
    event_types,
    generateRaw,
    saveChatConditional,
    saveSettingsDebounced,
    this_chid,
    updateMessageBlock,
} from '../../../../script.js';
import { extension_settings } from '../../../extensions.js';
import { getRegexScripts } from '../../regex/engine.js';
import { loadWorldInfo, selected_world_info, world_info, world_names } from '../../../world-info.js';
import { getCharaFilename } from '../../../utils.js';
import { power_user, context_presets } from '../../../power-user.js';
import { instruct_presets } from '../../../instruct-mode.js';
import { system_prompts } from '../../../sysprompt.js';
import { oai_settings, openai_setting_names, openai_settings } from '../../../openai.js';
import { textgenerationwebui_preset_names, textgenerationwebui_presets, textgenerationwebui_settings } from '../../../textgen-settings.js';

const MODULE_NAME = 'reply_rescue';
const DISPLAY_NAME = '回复救急插件';
const SETTINGS_VERSION = '0.1.19';
const MAX_UNDO_RECORDS = 10;
const WORLD_INFO_METADATA_KEY = 'world_info';
const CHAT_BASELINE_METADATA_KEY = 'blockBaseline';
const MULTI_BLOCK_MARKER_PREFIX = 'RR_SELECTED_BLOCK';
const CONTEXT_LENGTH_MAX = 100000;
const RESPONSE_LENGTH_MAX = 20000;
const BLOCK_DETECTION_MAX = 100000;
const BASELINE_EXAMPLE_MAX = 20000;

const modeLabels = {
    rewrite_selection: '重写选中片段',
    repair_block: '修改识别块',
};

const modeDescriptions = {
    rewrite_selection: '只替换你选中的正文片段，适合改一句话、一段描写或语气。',
    repair_block: '自动识别这条回复里正文之外的块，可点选一个或多个后一次修复。',
};

const blockProfiles = {
    status: {
        label: '状态栏',
        keywords: ['状态栏', '状态', 'StatusBlock', 'statusblock', 'status bar', 'status_bar', '当前状态', '当前位置', '人物状态'],
        markerPairs: settings => [[settings.statusStart, settings.statusEnd], ['<StatusBlock>', '</StatusBlock>']],
    },
    options: {
        label: '选项栏',
        keywords: ['选项栏', '选项', '按钮', '选择', 'OptionsBlock', 'OptionBlock', 'ChoiceBlock', 'options', 'option', 'choices', '{{button}}'],
        markerPairs: () => [
            ['<OptionsBlock>', '</OptionsBlock>'],
            ['<OptionBlock>', '</OptionBlock>'],
            ['<ChoiceBlock>', '</ChoiceBlock>'],
            ['<Options>', '</Options>'],
            ['<Choices>', '</Choices>'],
        ],
    },
    physiology: {
        label: '生理系统',
        keywords: ['生理系统', '生理', '身体状态', '体征', '健康', '疲劳', '饥饿', 'PhysiologyBlock', 'PhysiologySystem', 'BodyStatus', 'body status', 'vitals'],
        markerPairs: () => [
            ['<PhysiologyBlock>', '</PhysiologyBlock>'],
            ['<PhysiologySystem>', '</PhysiologySystem>'],
            ['<BodyStatus>', '</BodyStatus>'],
            ['<BodyState>', '</BodyState>'],
        ],
    },
};

function isKnownBlockKind(blockKind) {
    return blockKind === 'auto' || blockKind === 'custom' || Object.hasOwn(blockProfiles, blockKind);
}

const defaultSettings = {
    settings_version: SETTINGS_VERSION,
    enabled: true,
    defaultMode: 'repair_block',
    contextLength: 1200,
    recentMessages: 6,
    responseLength: 700,
    statusStart: '<StatusBlock>',
    statusEnd: '</StatusBlock>',
    statusTemplate: '',
    allowNewStatusbar: false,
    allowNewBlock: false,
    generationSource: 'sillytavern',
    activeApiPresetId: 'default',
    apiPresets: [],
};

const runtime = {
    initialized: false,
    settingsMounted: false,
    settingsRetryTimer: null,
    modalMounted: false,
    modalViewportBound: false,
    modalViewportFrame: 0,
    wandMenuMounted: false,
    wandMenuRetryTimer: null,
    buttonsBound: false,
    selectionButtonBound: false,
    observer: null,
    active: null,
    undoStack: [],
    recognizedBlocks: [],
    selectedBlockIndex: -1,
    selectedBlockIndexes: new Set(),
    selectionSnapshot: null,
};

function cloneDefaultValue(value) {
    if (Array.isArray(value)) {
        return [...value];
    }

    if (value && typeof value === 'object') {
        return { ...value };
    }

    return value;
}

function clampInteger(value, fallback, min, max) {
    const numberValue = Number(value);
    if (!Number.isFinite(numberValue)) {
        return fallback;
    }

    return Math.min(Math.max(Math.floor(numberValue), min), max);
}

function clampNumber(value, fallback, min, max) {
    const numberValue = Number(value);
    if (!Number.isFinite(numberValue)) {
        return fallback;
    }

    return Math.min(Math.max(numberValue, min), max);
}

function makeApiPresetId() {
    return `api_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function sanitizeModelList(value) {
    const seen = new Set();
    const result = [];

    if (!Array.isArray(value)) {
        return result;
    }

    for (const item of value) {
        const id = typeof item === 'string'
            ? item.trim()
            : String(item?.id || item?.name || '').trim();
        if (!id || seen.has(id)) {
            continue;
        }

        seen.add(id);
        result.push(id);
    }

    return result;
}

function createDefaultApiPreset(index = 0) {
    return {
        id: makeApiPresetId(),
        name: index ? `独立 API ${index + 1}` : '默认独立 API',
        baseUrl: '',
        apiKey: '',
        model: '',
        availableModels: [],
        temperature: 0.7,
        maxTokens: defaultSettings.responseLength,
    };
}

function sanitizeApiPreset(value, index = 0) {
    const source = value && typeof value === 'object' ? value : {};
    const preset = {
        id: String(source.id || '').trim() || makeApiPresetId(),
        name: String(source.name || '').trim() || (index ? `独立 API ${index + 1}` : '默认独立 API'),
        baseUrl: String(source.baseUrl || source.url || '').trim(),
        apiKey: String(source.apiKey || source.key || '').trim(),
        model: String(source.model || '').trim(),
        availableModels: sanitizeModelList(source.availableModels || source.models),
        temperature: clampNumber(source.temperature, 0.7, 0, 2),
        maxTokens: clampInteger(source.maxTokens ?? source.responseLength, defaultSettings.responseLength, 80, RESPONSE_LENGTH_MAX),
    };

    if (preset.model && !preset.availableModels.includes(preset.model)) {
        preset.availableModels.unshift(preset.model);
    }

    return preset;
}

function sanitizeApiPresets(value) {
    const source = Array.isArray(value) && value.length ? value : [createDefaultApiPreset()];
    const used = new Set();

    return source.map((item, index) => {
        const preset = sanitizeApiPreset(item, index);
        if (used.has(preset.id)) {
            preset.id = makeApiPresetId();
        }
        used.add(preset.id);
        return preset;
    });
}

function getSettings() {
    extension_settings[MODULE_NAME] ||= {};
    const settings = extension_settings[MODULE_NAME];
    let changed = false;

    for (const [key, value] of Object.entries(defaultSettings)) {
        if (settings[key] === undefined) {
            settings[key] = cloneDefaultValue(value);
            changed = true;
        }
    }

    settings.contextLength = clampInteger(settings.contextLength, defaultSettings.contextLength, 300, CONTEXT_LENGTH_MAX);
    settings.recentMessages = clampInteger(settings.recentMessages, defaultSettings.recentMessages, 2, 20);
    settings.responseLength = clampInteger(settings.responseLength, defaultSettings.responseLength, 80, RESPONSE_LENGTH_MAX);
    settings.statusStart = String(settings.statusStart || defaultSettings.statusStart);
    settings.statusEnd = String(settings.statusEnd || defaultSettings.statusEnd);
    settings.statusTemplate = String(settings.statusTemplate || '');
    settings.allowNewStatusbar = false;
    settings.allowNewBlock = false;
    settings.enabled = settings.enabled !== false;
    if (!['sillytavern', 'independent'].includes(settings.generationSource)) {
        settings.generationSource = defaultSettings.generationSource;
        changed = true;
    }
    const serializedApiPresets = JSON.stringify(settings.apiPresets || []);
    settings.apiPresets = sanitizeApiPresets(settings.apiPresets);
    if (serializedApiPresets !== JSON.stringify(settings.apiPresets)) {
        changed = true;
    }
    if (!settings.apiPresets.some(preset => preset.id === settings.activeApiPresetId)) {
        settings.activeApiPresetId = settings.apiPresets[0].id;
        changed = true;
    }

    if (!Object.hasOwn(modeLabels, settings.defaultMode)) {
        settings.defaultMode = defaultSettings.defaultMode;
        changed = true;
    }

    if (settings.settings_version !== SETTINGS_VERSION) {
        settings.settings_version = SETTINGS_VERSION;
        settings.allowNewStatusbar = false;
        settings.allowNewBlock = false;
        changed = true;
    }

    if (changed) {
        saveSettingsDebounced();
    }

    return settings;
}

function notify(type, message) {
    const toastr = window.toastr;
    if (toastr?.[type]) {
        toastr[type](message, DISPLAY_NAME);
        return;
    }

    console[type === 'error' ? 'error' : 'log'](`[${DISPLAY_NAME}] ${message}`);
}

function getMessageIdFromElement(messageElement) {
    const value = Number(messageElement?.getAttribute('mesid'));
    return Number.isInteger(value) && value >= 0 ? value : -1;
}

function getMessageElement(messageId) {
    return document.querySelector(`#chat .mes[mesid="${messageId}"]`);
}

function getCurrentMessage(messageId) {
    const message = chat?.[messageId];
    if (!message || typeof message !== 'object') {
        return null;
    }

    if (message.is_user || message.is_system || message.extra?.isSmallSys) {
        return null;
    }

    return message;
}

function getMessageText(messageId) {
    return String(getCurrentMessage(messageId)?.mes || '');
}

function getLatestAssistantMessageId() {
    for (let index = (chat?.length || 0) - 1; index >= 0; index -= 1) {
        if (getCurrentMessage(index)) {
            return index;
        }
    }

    return -1;
}

function trimText(text, maxLength, fromEnd = false) {
    const value = String(text || '');
    if (value.length <= maxLength) {
        return value;
    }

    if (fromEnd) {
        return `...${value.slice(-maxLength)}`;
    }

    return `${value.slice(0, maxLength)}...`;
}

function normalizeLineBreaks(text) {
    return String(text || '').replace(/\r\n/g, '\n');
}

function stripWrappingCodeFence(text) {
    let value = normalizeLineBreaks(text).trim();
    const match = value.match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```$/);
    if (match) {
        value = match[1].trim();
    }

    return value;
}

function decodeHtmlEntity(entity) {
    const value = String(entity || '');
    if (!value) {
        return '';
    }

    const numeric = value.match(/^&#(x?[0-9a-f]+);$/iu);
    if (numeric) {
        const codePoint = Number.parseInt(
            numeric[1].startsWith('x') || numeric[1].startsWith('X') ? numeric[1].slice(1) : numeric[1],
            numeric[1].startsWith('x') || numeric[1].startsWith('X') ? 16 : 10,
        );
        if (Number.isFinite(codePoint)) {
            try {
                return String.fromCodePoint(codePoint);
            } catch {
                return value;
            }
        }
    }

    if (typeof document !== 'undefined') {
        const textarea = document.createElement('textarea');
        textarea.innerHTML = value;
        return textarea.value || value;
    }

    return value
        .replace(/&nbsp;/giu, ' ')
        .replace(/&amp;/giu, '&')
        .replace(/&lt;/giu, '<')
        .replace(/&gt;/giu, '>')
        .replace(/&quot;/giu, '"')
        .replace(/&#39;/giu, "'");
}

function pushVisibleMappedChar(output, starts, ends, char, rawStart, rawEnd) {
    for (const unit of String(char || '')) {
        output.push(unit);
        starts.push(rawStart);
        ends.push(rawEnd);
    }
}

function normalizeMappedLineBreaks(chars, starts, ends) {
    const output = [];
    const nextStarts = [];
    const nextEnds = [];

    for (let index = 0; index < chars.length; index += 1) {
        const char = chars[index];
        if (char === '\r') {
            const hasLf = chars[index + 1] === '\n';
            output.push('\n');
            nextStarts.push(starts[index]);
            nextEnds.push(hasLf ? ends[index + 1] : ends[index]);
            if (hasLf) {
                index += 1;
            }
            continue;
        }

        output.push(char);
        nextStarts.push(starts[index]);
        nextEnds.push(ends[index]);
    }

    return {
        text: output.join(''),
        starts: nextStarts,
        ends: nextEnds,
    };
}

function buildVisibleTextMap(rawText) {
    const source = String(rawText || '');
    const output = [];
    const starts = [];
    const ends = [];
    let index = 0;

    while (index < source.length) {
        const char = source[index];

        if (char === '<') {
            const commentEnd = source.startsWith('<!--', index) ? source.indexOf('-->', index + 4) : -1;
            if (commentEnd !== -1) {
                index = commentEnd + 3;
                continue;
            }

            const tagMatch = source.slice(index).match(/^<\/?\s*([^\s/>=]+)[^>]*>/u);
            if (tagMatch) {
                const tag = tagMatch[0];
                const tagName = String(tagMatch[1] || '').toLowerCase();
                if (tagName === 'br') {
                    pushVisibleMappedChar(output, starts, ends, '\n', index, index + tag.length);
                } else if (['div', 'section', 'article', 'aside', 'details', 'summary', 'table', 'tr', 'ul', 'ol', 'li', 'pre', 'p'].includes(tagName)) {
                    pushVisibleMappedChar(output, starts, ends, '\n', index, index + tag.length);
                }
                index += tag.length;
                continue;
            }
        }

        if (char === '&') {
            const entityMatch = source.slice(index).match(/^&(?:#x?[0-9a-f]+|[a-z][a-z0-9]+);/iu);
            if (entityMatch) {
                pushVisibleMappedChar(output, starts, ends, decodeHtmlEntity(entityMatch[0]), index, index + entityMatch[0].length);
                index += entityMatch[0].length;
                continue;
            }
        }

        if ((char === '*' || char === '_' || char === '`') && (source[index - 1] === char || source[index + 1] === char)) {
            index += 1;
            continue;
        }

        pushVisibleMappedChar(output, starts, ends, char, index, index + 1);
        index += 1;
    }

    return normalizeMappedLineBreaks(output, starts, ends);
}

function normalizeSearchTextWithMap(text, starts = [], ends = []) {
    const source = normalizeLineBreaks(text);
    const output = [];
    const map = [];
    let pendingSpace = null;

    for (let index = 0; index < source.length; index += 1) {
        const char = source[index];
        const rawStart = starts[index] ?? index;
        const rawEnd = ends[index] ?? index + 1;

        if (/\s/u.test(char)) {
            if (output.length) {
                pendingSpace ||= { start: rawStart, end: rawEnd };
            }
            continue;
        }

        if (pendingSpace && output[output.length - 1] !== ' ') {
            output.push(' ');
            map.push(pendingSpace);
        }
        pendingSpace = null;
        output.push(char);
        map.push({ start: rawStart, end: rawEnd });
    }

    return {
        text: output.join(''),
        map,
    };
}

function findAllSearchIndexes(haystack, needle) {
    const indexes = [];
    if (!needle) {
        return indexes;
    }

    let index = 0;
    while (index <= haystack.length) {
        const found = haystack.indexOf(needle, index);
        if (found === -1) {
            break;
        }
        indexes.push(found);
        index = found + Math.max(needle.length, 1);
    }

    return indexes;
}

function locateRawSelectionRange(currentText, selectedText, hint = {}) {
    const source = String(currentText || '');
    const selected = String(selectedText || '');
    if (!source || !selected.trim()) {
        return null;
    }

    const hintedStart = Number(hint.rawStart ?? hint.start);
    const hintedEnd = Number(hint.rawEnd ?? hint.end);
    const hintedText = String(hint.selectedRawText || hint.rawText || '');
    if (
        Number.isInteger(hintedStart)
        && Number.isInteger(hintedEnd)
        && hintedStart >= 0
        && hintedEnd > hintedStart
        && hintedEnd <= source.length
        && (!hintedText || source.slice(hintedStart, hintedEnd) === hintedText)
    ) {
        return {
            start: hintedStart,
            end: hintedEnd,
            text: source.slice(hintedStart, hintedEnd),
        };
    }

    const exactText = hintedText || selected;
    const exactMatches = findAllIndexes(source, exactText);
    if (exactMatches.length === 1) {
        return {
            start: exactMatches[0],
            end: exactMatches[0] + exactText.length,
            text: source.slice(exactMatches[0], exactMatches[0] + exactText.length),
        };
    }

    const visible = buildVisibleTextMap(source);
    const normalizedVisible = normalizeSearchTextWithMap(visible.text, visible.starts, visible.ends);
    const normalizedSelected = normalizeSearchTextWithMap(selected).text;
    if (!normalizedSelected) {
        return null;
    }

    const matches = findAllSearchIndexes(normalizedVisible.text, normalizedSelected);
    if (!matches.length) {
        return null;
    }

    let chosen = matches[0];
    const normalizedStartHint = Number(hint.normalizedStart);
    if (matches.length > 1 && Number.isFinite(normalizedStartHint) && normalizedStartHint >= 0) {
        chosen = matches
            .map(index => ({ index, distance: Math.abs(index - normalizedStartHint) }))
            .sort((a, b) => a.distance - b.distance)[0].index;
    } else if (matches.length > 1) {
        return null;
    }

    const first = normalizedVisible.map[chosen];
    const last = normalizedVisible.map[chosen + normalizedSelected.length - 1];
    if (!first || !last) {
        return null;
    }

    const start = first.start;
    const end = last.end;
    if (!Number.isInteger(start) || !Number.isInteger(end) || end <= start) {
        return null;
    }

    return {
        start,
        end,
        text: source.slice(start, end),
    };
}

function countOccurrences(text, needle) {
    if (!needle) {
        return 0;
    }

    let count = 0;
    let index = 0;
    while (index < text.length) {
        const found = text.indexOf(needle, index);
        if (found === -1) {
            break;
        }

        count += 1;
        index = found + needle.length;
    }

    return count;
}

function findStatusBlocks(text, settings = getSettings()) {
    const start = settings.statusStart;
    const end = settings.statusEnd;
    const source = String(text || '');
    const blocks = [];

    if (!start || !end) {
        return { blocks, startCount: 0, endCount: 0 };
    }

    let index = 0;
    while (index < source.length) {
        const startIndex = source.indexOf(start, index);
        if (startIndex === -1) {
            break;
        }

        const endIndex = source.indexOf(end, startIndex + start.length);
        if (endIndex === -1) {
            break;
        }

        const endExclusive = endIndex + end.length;
        blocks.push({
            start: startIndex,
            end: endExclusive,
            text: source.slice(startIndex, endExclusive),
        });
        index = endExclusive;
    }

    return {
        blocks,
        startCount: countOccurrences(source, start),
        endCount: countOccurrences(source, end),
    };
}

function getSearchBlockKinds(blockKind) {
    if (Object.hasOwn(blockProfiles, blockKind)) {
        return [blockKind];
    }

    if (blockKind === 'custom') {
        return [];
    }

    return Object.keys(blockProfiles);
}

function getBlockTypeLabel(blockKind) {
    if (blockKind === 'auto') {
        return '结构块';
    }

    if (blockProfiles[blockKind]?.label) {
        return blockProfiles[blockKind].label;
    }

    if (blockKind === 'custom') {
        return '结构块';
    }

    return '结构块';
}

function uniqueMarkerPairs(markerPairs) {
    const seen = new Set();
    const result = [];

    for (const pair of markerPairs || []) {
        const start = String(pair?.[0] || '').trim();
        const end = String(pair?.[1] || '').trim();
        if (!start || !end) {
            continue;
        }

        const key = `${start}\u0000${end}`;
        if (seen.has(key)) {
            continue;
        }

        seen.add(key);
        result.push([start, end]);
    }

    return result;
}

function unescapeRegexText(text) {
    return String(text || '')
        .replace(/\\([<>/])/g, '$1')
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t');
}

function escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const htmlTagNames = new Set([
    'a', 'abbr', 'address', 'area', 'article', 'aside', 'audio', 'b', 'base', 'bdi', 'bdo', 'blockquote',
    'body', 'br', 'button', 'canvas', 'caption', 'cite', 'code', 'col', 'colgroup', 'data', 'datalist',
    'dd', 'del', 'details', 'dfn', 'dialog', 'div', 'dl', 'dt', 'em', 'embed', 'fieldset', 'figcaption',
    'figure', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head', 'header', 'hgroup', 'hr',
    'html', 'i', 'iframe', 'img', 'input', 'ins', 'kbd', 'label', 'legend', 'li', 'link', 'main', 'map',
    'mark', 'menu', 'meta', 'meter', 'nav', 'noscript', 'object', 'ol', 'optgroup', 'option', 'output',
    'p', 'param', 'picture', 'pre', 'progress', 'q', 'rp', 'rt', 'ruby', 's', 'samp', 'script', 'search',
    'section', 'select', 'slot', 'small', 'source', 'span', 'strong', 'style', 'sub', 'summary', 'sup',
    'table', 'tbody', 'td', 'template', 'textarea', 'tfoot', 'th', 'thead', 'time', 'title', 'tr', 'track',
    'u', 'ul', 'var', 'video', 'wbr',
]);

const ignoredGenericTagNames = new Set(['think', 'thinking', 'reasoning', 'analysis', 'assistant', 'user', 'system']);

function normalizeTagName(tagName) {
    return String(tagName || '').trim();
}

function isSafeTagName(tagName) {
    const value = normalizeTagName(tagName);
    return Boolean(value)
        && value.length <= 80
        && !/[\s"'`<>=/]/u.test(value)
        && !/^\d/u.test(value);
}

function isHtmlTagName(tagName) {
    return htmlTagNames.has(normalizeTagName(tagName).toLowerCase());
}

function tagMatchesBlockKind(tagName, blockKind = 'auto') {
    const raw = normalizeTagName(tagName);
    const value = raw.toLowerCase();
    if (!value) {
        return false;
    }

    if (blockKind === 'status') {
        return value.includes('status') || value.includes('state') || raw.includes('状态') || raw.includes('状态栏');
    }

    if (blockKind === 'options') {
        return value.includes('option') || value.includes('choice') || value.includes('select')
            || raw.includes('选项') || raw.includes('选择') || raw.includes('按钮');
    }

    if (blockKind === 'physiology') {
        return value.includes('phys') || value.includes('body') || value.includes('vital')
            || raw.includes('生理') || raw.includes('身体') || raw.includes('体征');
    }

    return true;
}

function isLikelyBlockTagName(tagName, blockKind = 'auto', { explicit = false } = {}) {
    const value = normalizeTagName(tagName);
    const lower = value.toLowerCase();
    if (!isSafeTagName(value)) {
        return false;
    }

    if (explicit) {
        return true;
    }

    if (Object.hasOwn(blockProfiles, blockKind)) {
        return tagMatchesBlockKind(value, blockKind);
    }

    if (isHtmlTagName(value) || ignoredGenericTagNames.has(lower)) {
        return false;
    }

    return true;
}

function getCurrentBlockMarkerHint() {
    return String(document.getElementById('rr-block-marker-hint')?.value || '').trim();
}

function parseStartTagName(startTag) {
    return String(startTag || '').trim().match(/^<\s*([^\s/>=]+)(?:\s[^<>]*)?>$/u)?.[1] || '';
}

function isSafeMarkerName(name) {
    const value = String(name || '').trim();
    return Boolean(value)
        && value.length <= 80
        && !/[\r\n]/u.test(value)
        && !/^[\d\s\p{P}]+$/u.test(value);
}

function makeBracketMarkerPair(marker) {
    const source = String(marker || '').trim();
    const match = source.match(/^\[([^\]\r\n]{1,80})\]$/u);
    if (match && isSafeMarkerName(match[1]) && !match[1].startsWith('/')) {
        return [source, `[/${match[1]}]`];
    }

    const cjkMatch = source.match(/^【([^】\r\n]{1,80})】$/u);
    if (cjkMatch && isSafeMarkerName(cjkMatch[1]) && !cjkMatch[1].startsWith('/')) {
        return [source, `【/${cjkMatch[1]}】`];
    }

    const cornerMatch = source.match(/^「([^」\r\n]{1,80})」$/u);
    if (cornerMatch && isSafeMarkerName(cornerMatch[1]) && !cornerMatch[1].startsWith('/')) {
        return [source, `「/${cornerMatch[1]}」`];
    }

    return null;
}

function findMarkerPairsFromHint(hint) {
    const source = unescapeRegexText(hint).trim();
    if (!source) {
        return [];
    }

    const explicitPairs = findMarkerPairsInText(source, 'custom', { explicit: true });
    if (explicitPairs.length) {
        return explicitPairs;
    }

    const startTagName = parseStartTagName(source);
    if (startTagName && isLikelyBlockTagName(startTagName, 'custom', { explicit: true })) {
        return [[source, `</${startTagName}>`]];
    }

    const bracketPair = makeBracketMarkerPair(source);
    if (bracketPair) {
        return [bracketPair];
    }

    const plainTagName = source.replace(/^<\/?/u, '').replace(/>$/u, '').trim();
    if (isLikelyBlockTagName(plainTagName, 'custom', { explicit: true })) {
        return [[`<${plainTagName}>`, `</${plainTagName}>`]];
    }

    return [];
}

function findMarkerPairsInText(text, blockKind = 'auto', { explicit = false } = {}) {
    const source = unescapeRegexText(text);
    const pairs = [];
    const tagRegex = /<(?!\/|!|\?)([^\s/>=]+)(?:\s[^<>]*)?>/gu;
    let match;

    while ((match = tagRegex.exec(source))) {
        const tagName = match[1];
        const startTag = match[0];
        if (!isLikelyBlockTagName(tagName, blockKind, { explicit })) {
            continue;
        }

        const tail = source.slice(tagRegex.lastIndex);
        const endMatch = tail.match(new RegExp(`</\\s*${escapeRegExp(tagName)}\\s*>`, 'u'));
        if (!endMatch) {
            continue;
        }

        const endTag = endMatch[0];
        pairs.push([startTag, endTag]);
    }

    return uniqueMarkerPairs(pairs);
}

function getBlockMarkerPairs(blockKind = 'auto', settings = getSettings(), templateText = '', markerHint = getCurrentBlockMarkerHint()) {
    const pairs = [];
    pairs.push(...findMarkerPairsFromHint(markerHint));

    for (const kind of getSearchBlockKinds(blockKind)) {
        const profilePairs = blockProfiles[kind]?.markerPairs?.(settings) || [];
        pairs.push(...profilePairs);
    }

    pairs.push(...findMarkerPairsInText(templateText, blockKind));
    return uniqueMarkerPairs(pairs);
}

function looksLikeTemplateText(text) {
    return /<[^>]+>|\{\{[^}]+\}\}|class\s*=|\$\d+|\$<[^>]+>|<\/\s*[^\s/>=]+\s*>/iu.test(String(text || ''));
}

function scoreTextForBlockKind(text, blockKind = 'auto') {
    const source = String(text || '');
    const lower = source.toLowerCase();

    if (!source.trim()) {
        return 0;
    }

    if (blockKind === 'auto') {
        return Math.max(...Object.keys(blockProfiles).map(kind => scoreTextForBlockKind(source, kind)), scoreTextForBlockKind(source, 'custom'), 0);
    }

    if (blockKind === 'custom') {
        if (findMarkerPairsInText(source, 'custom').length) {
            return 3;
        }

        return /\{\{[^}]+\}\}|class\s*=|\$\d+|\$<[^>]+>/i.test(source) && looksLikeTemplateText(source) ? 1 : 0;
    }

    const profile = blockProfiles[blockKind];
    if (!profile) {
        return 0;
    }

    let score = 0;
    for (const keyword of profile.keywords) {
        if (lower.includes(String(keyword).toLowerCase())) {
            score += 2;
        }
    }

    for (const [start, end] of profile.markerPairs?.(getSettings()) || []) {
        if (start && lower.includes(start.toLowerCase())) {
            score += 3;
        }
        if (end && lower.includes(end.toLowerCase())) {
            score += 3;
        }
    }

    if (looksLikeTemplateText(source)) {
        score += 1;
    }

    return score;
}

function inferBlockKindFromText(text) {
    let bestKind = 'custom';
    let bestScore = 0;

    for (const kind of Object.keys(blockProfiles)) {
        const score = scoreTextForBlockKind(text, kind);
        if (score > bestScore) {
            bestKind = kind;
            bestScore = score;
        }
    }

    return bestScore > 0 ? bestKind : 'custom';
}

function findStructureBlocks(text, blockKind = 'auto', settings = getSettings(), templateText = '') {
    const source = String(text || '');
    const markerPairs = getBlockMarkerPairs(blockKind, settings, templateText);
    const blocks = [];
    let startCount = 0;
    let endCount = 0;

    for (const [start, end] of markerPairs) {
        startCount += countOccurrences(source, start);
        endCount += countOccurrences(source, end);

        let index = 0;
        while (index < source.length) {
            const startIndex = source.indexOf(start, index);
            if (startIndex === -1) {
                break;
            }

            const endIndex = source.indexOf(end, startIndex + start.length);
            if (endIndex === -1) {
                break;
            }

            const endExclusive = endIndex + end.length;
            blocks.push({
                start: startIndex,
                end: endExclusive,
                text: source.slice(startIndex, endExclusive),
                markerPair: [start, end],
            });
            index = endExclusive;
        }
    }

    const xmlRegex = /<(?!\/|!|\?)([^\s/>=]+)(?:\s[^<>]*)?>[\s\S]*?<\/\s*\1\s*>/gu;
    let match;
    while ((match = xmlRegex.exec(source))) {
        const tagName = match[1];
        const blockText = match[0];
        if (blockText.length > BLOCK_DETECTION_MAX || !isLikelyBlockTagName(tagName, blockKind)) {
            continue;
        }
        if (blockKind !== 'auto' && scoreTextForBlockKind(`${tagName}\n${blockText}`, blockKind) <= 0) {
            continue;
        }

        blocks.push({
            start: match.index,
            end: match.index + blockText.length,
            text: blockText,
            markerPair: [match[0].match(/^<[^>]+>/)?.[0] || `<${tagName}>`, `</${tagName}>`],
        });
    }

    const seen = new Set();
    const uniqueBlocks = blocks
        .filter((block) => {
            const key = `${block.start}:${block.end}`;
            if (seen.has(key)) {
                return false;
            }

            seen.add(key);
            return true;
        })
        .sort((a, b) => a.start - b.start);

    return { blocks: uniqueBlocks, startCount, endCount, markerPairs };
}

function findBracketStructureBlocks(text) {
    const source = String(text || '');
    const patterns = [
        {
            regex: /\[([^\]\r\n]{1,80})\]/gu,
            end: name => `[/${name}]`,
        },
        {
            regex: /【([^】\r\n]{1,80})】/gu,
            end: name => `【/${name}】`,
        },
        {
            regex: /「([^」\r\n]{1,80})」/gu,
            end: name => `「/${name}」`,
        },
    ];
    const blocks = [];

    for (const pattern of patterns) {
        let match;
        while ((match = pattern.regex.exec(source))) {
            const name = String(match[1] || '').trim();
            if (!isSafeMarkerName(name) || name.startsWith('/')) {
                continue;
            }

            const start = match[0];
            const end = pattern.end(name);
            const endIndex = source.indexOf(end, pattern.regex.lastIndex);
            if (endIndex === -1) {
                continue;
            }

            const endExclusive = endIndex + end.length;
            if (endExclusive - match.index > BLOCK_DETECTION_MAX) {
                continue;
            }

            blocks.push({
                start: match.index,
                end: endExclusive,
                text: source.slice(match.index, endExclusive),
                markerPair: [start, end],
                markerName: name,
                source: '成对标记',
            });
        }
    }

    return blocks;
}

function findMarkdownCodeFenceBlocks(text) {
    const source = String(text || '');
    const blocks = [];
    const fenceRegex = /(^|\n)([ \t]{0,3})(`{3,}|~{3,})([^\r\n]*)\r?\n([\s\S]*?)\r?\n\2\3[ \t]*(?=\r?\n|$)/gu;
    let match;

    while ((match = fenceRegex.exec(source))) {
        const start = match.index + match[1].length;
        const end = match.index + match[0].length;
        const textValue = source.slice(start, end);
        if (textValue.length > BLOCK_DETECTION_MAX) {
            continue;
        }

        const info = String(match[4] || '').trim();
        const body = String(match[5] || '');
        if (!body.trim()) {
            continue;
        }

        blocks.push({
            start,
            end,
            text: textValue,
            markerPair: [`${match[2]}${match[3]}${match[4] || ''}`, `${match[2]}${match[3]}`],
            markerName: info ? `代码块.${info.split(/\s+/u)[0]}` : '代码块',
            source: 'Markdown代码块',
        });
    }

    return blocks;
}

function findMatchingHtmlEnd(source, startIndex, tagName) {
    const tagPattern = new RegExp(`<\\s*/?\\s*${escapeRegExp(tagName)}\\b[^>]*>`, 'giu');
    tagPattern.lastIndex = startIndex;
    let depth = 0;
    let match;

    while ((match = tagPattern.exec(source))) {
        const tag = match[0];
        const isClosing = /^<\s*\//u.test(tag);
        const isSelfClosing = /\/\s*>$/u.test(tag);

        if (isClosing) {
            depth -= 1;
        } else if (!isSelfClosing) {
            depth += 1;
        }

        if (depth === 0) {
            return match.index + tag.length;
        }
    }

    return -1;
}

function getHtmlBlockLabel(openTag) {
    const tagName = parseStartTagName(openTag) || 'HTML';
    const className = String(openTag || '').match(/\bclass\s*=\s*["']([^"']{1,80})["']/iu)?.[1]?.trim();
    const idName = String(openTag || '').match(/\bid\s*=\s*["']([^"']{1,80})["']/iu)?.[1]?.trim();
    const hint = idName || className;
    return hint ? `${tagName}.${hint.split(/\s+/u)[0]}` : `${tagName} 美化块`;
}

function hasHtmlIslandAttributes(openTag) {
    return /\b(?:class|id|style)\s*=|data-|aria-/iu.test(String(openTag || ''));
}

function isHtmlIslandCandidate(openTag, tagName, textValue) {
    const lower = String(tagName || '').toLowerCase();
    const body = String(textValue || '');
    if (hasHtmlIslandAttributes(openTag)) {
        return true;
    }

    if (lower === 'details') {
        return /<\s*summary\b/iu.test(body) || body.length >= 160;
    }

    if (lower === 'pre') {
        return /<\s*code\b/iu.test(body) || body.length >= 160;
    }

    if (lower === 'table') {
        return /<\s*(?:thead|tbody|tr|td|th)\b/iu.test(body) && body.length >= 120;
    }

    if (lower === 'ul' || lower === 'ol') {
        return /<\s*li\b/iu.test(body) && body.length >= 160;
    }

    return false;
}

function findHtmlIslandBlocks(text) {
    const source = String(text || '');
    const blocks = [];
    const startRegex = /<(div|section|article|aside|details|table|ul|ol|pre)\b[^>]*>/giu;
    let match;

    while ((match = startRegex.exec(source))) {
        const tagName = match[1];
        const endExclusive = findMatchingHtmlEnd(source, match.index, tagName);
        if (endExclusive === -1 || endExclusive - match.index > BLOCK_DETECTION_MAX) {
            continue;
        }

        const textValue = source.slice(match.index, endExclusive);
        if (!/[\r\n]/u.test(textValue) && textValue.length < 80) {
            continue;
        }
        if (!isHtmlIslandCandidate(match[0], tagName, textValue)) {
            continue;
        }

        blocks.push({
            start: match.index,
            end: endExclusive,
            text: textValue,
            markerPair: [match[0], `</${tagName}>`],
            markerName: getHtmlBlockLabel(match[0]),
            source: 'HTML美化',
        });
    }

    return blocks;
}

function findBrokenHtmlIslandEnd(source, fromIndex, tagName = '') {
    if (String(tagName || '').toLowerCase() === 'details') {
        return source.length;
    }

    const tail = source.slice(fromIndex);
    const nextTopLevel = tail.search(/\n{2,}(?=(?:<\s*(?:div|section|article|aside|details|table|ul|ol|pre)\b|\[[^\]\r\n]{1,80}\]|【[^】\r\n]{1,80}】|「[^」\r\n]{1,80}」))/u);
    if (nextTopLevel !== -1) {
        return fromIndex + nextTopLevel;
    }

    return source.length;
}

function findBrokenHtmlIslandBlocks(text) {
    const source = String(text || '');
    const blocks = [];
    const startRegex = /<(div|section|article|aside|details|table|ul|ol|pre)\b[^>]*>/giu;
    let match;

    while ((match = startRegex.exec(source))) {
        const tagName = match[1];
        if (findMatchingHtmlEnd(source, match.index, tagName) !== -1) {
            continue;
        }

        const endExclusive = findBrokenHtmlIslandEnd(source, match.index + match[0].length, tagName);
        if (endExclusive <= match.index || endExclusive - match.index > BLOCK_DETECTION_MAX) {
            continue;
        }

        const textValue = source.slice(match.index, endExclusive).trimEnd();
        if (!isHtmlIslandCandidate(match[0], tagName, textValue) && !/<\s*summary\b|<\/?\s*(?:div|section|article|aside|table|ul|ol|li|button)\b/iu.test(textValue)) {
            continue;
        }

        blocks.push({
            start: match.index,
            end: match.index + textValue.length,
            text: textValue,
            markerPair: [match[0], `</${tagName}>`],
            markerName: `${getHtmlBlockLabel(match[0])}（疑似损坏）`,
            source: '疑似坏块',
        });
    }

    return blocks;
}

function panelGapLooksSafe(gap) {
    const value = String(gap || '').trim();
    if (!value) {
        return true;
    }

    if (value.length > 600) {
        return false;
    }

    if (/[。！？!?]\s*[\p{L}\p{N}]/u.test(value)) {
        return false;
    }

    return /<\/?\s*[a-z][^>]*>/iu.test(value)
        || /^[\s`~*_=\-+|:：,，;；.。·•#()[\]{}【】「」<>\/\\]+$/iu.test(value);
}

function findEnclosingHtmlContainer(source, start, end) {
    const startRegex = /<(div|section|article|aside|details|table|ul|ol|pre)\b[^>]*>/giu;
    let match;
    let best = null;

    while ((match = startRegex.exec(source))) {
        if (match.index > start) {
            break;
        }

        const tagName = match[1];
        const endExclusive = findMatchingHtmlEnd(source, match.index, tagName);
        if (endExclusive < end || endExclusive - match.index > BLOCK_DETECTION_MAX) {
            continue;
        }

        const textValue = source.slice(match.index, endExclusive);
        if (!best || (endExclusive - match.index) < (best.end - best.start)) {
            best = {
                start: match.index,
                end: endExclusive,
                text: textValue,
                openTag: match[0],
                tagName,
            };
        }
    }

    return best;
}

function combineAdjacentPanelBlocks(blocks, sourceText) {
    const source = String(sourceText || '');
    const sorted = [...blocks].sort((a, b) => a.start - b.start || a.end - b.end);
    const combined = [];
    let group = [];

    const flush = () => {
        if (group.length < 2) {
            group = [];
            return;
        }

        const first = group[0];
        const last = group[group.length - 1];
        if (last.end - first.start > BLOCK_DETECTION_MAX) {
            group = [];
            return;
        }

        const htmlLikeCount = group.filter(block => /HTML|坏块|美化|面板/u.test(String(block.source || '')) || /^<[^>]+>/.test(block.text)).length;
        if (htmlLikeCount < 2) {
            group = [];
            return;
        }

        const enclosing = findEnclosingHtmlContainer(source, first.start, last.end);
        const start = enclosing?.start ?? first.start;
        const end = enclosing?.end ?? last.end;
        const text = source.slice(start, end);
        if (!text.trim() || text.length > BLOCK_DETECTION_MAX) {
            group = [];
            return;
        }

        combined.push({
            start,
            end,
            text,
            markerPair: enclosing ? [enclosing.openTag, `</${enclosing.tagName}>`] : first.markerPair,
            markerName: enclosing ? getHtmlBlockLabel(enclosing.openTag) : `${getRecognizedBlockLabel(first)} 面板`,
            source: '组合面板',
        });
        group = [];
    };

    for (const block of sorted) {
        if (!group.length) {
            group = [block];
            continue;
        }

        const previous = group[group.length - 1];
        const gap = source.slice(previous.end, block.start);
        const canJoin = block.start >= previous.end
            && block.start - previous.end <= 800
            && block.end - group[0].start <= BLOCK_DETECTION_MAX
            && panelGapLooksSafe(gap);

        if (canJoin) {
            group.push(block);
        } else {
            flush();
            group = [block];
        }
    }

    flush();
    return combined;
}

function getRecognizedBlockLabel(block) {
    if (block.markerName) {
        return block.markerName;
    }

    const [start] = block.markerPair || [];
    const tagName = parseStartTagName(start);
    if (tagName) {
        return tagName;
    }

    const inferredKind = inferBlockKindFromText(block.text);
    return inferredKind === 'custom' ? '结构块' : getBlockTypeLabel(inferredKind);
}

function normalizeRecognizedBlocks(blocks) {
    const sorted = blocks
        .filter(block => block && block.text && block.end > block.start)
        .sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
    const result = [];

    for (const block of sorted) {
        const overlaps = result.some(item => block.start < item.end && item.start < block.end);
        if (overlaps) {
            continue;
        }

        result.push(block);
    }

    return result.sort((a, b) => a.start - b.start);
}

function collectActualRecognizedBlocks(text, settings = getSettings(), templateText = '') {
    const source = String(text || '');
    const parsed = findStructureBlocks(source, 'auto', settings, templateText);
    const blocks = [
        ...parsed.blocks.map(block => ({ ...block, source: '结构标记' })),
        ...findBracketStructureBlocks(source),
        ...findMarkdownCodeFenceBlocks(source),
        ...findHtmlIslandBlocks(source),
        ...findBrokenHtmlIslandBlocks(source),
    ];
    blocks.push(...combineAdjacentPanelBlocks(blocks, source));

    return normalizeRecognizedBlocks(blocks).map((block, index) => {
        const inferredKind = inferBlockKindFromText(`${block.markerName || ''}\n${block.text}`);
        const label = getRecognizedBlockLabel(block);
        return {
            ...block,
            index,
            label,
            blockKind: inferredKind,
            source: block.source || '结构块',
            preview: trimText(block.text.replace(/\s+/gu, ' ').trim(), 120, false),
        };
    });
}

function normalizeBlockSignaturePart(value) {
    return String(value || '')
        .replace(/\s+/gu, ' ')
        .trim()
        .toLowerCase();
}

function getBlockSignature(block) {
    const [startMarker = '', endMarker = ''] = block?.markerPair || [];
    const blockKind = isKnownBlockKind(block?.blockKind) ? block.blockKind : inferBlockKindFromText(block?.text || '');
    const label = block?.label || getRecognizedBlockLabel(block || {});
    return [
        blockKind,
        normalizeBlockSignaturePart(startMarker),
        normalizeBlockSignaturePart(endMarker),
        normalizeBlockSignaturePart(label),
    ].join('|');
}

const blockMatchStopTokens = new Set([
    'a', 'abbr', 'article', 'aside', 'body', 'button', 'code', 'container', 'content', 'details', 'div',
    'figure', 'footer', 'form', 'header', 'html', 'island', 'li', 'main', 'markdown', 'nav', 'ol', 'panel',
    'pre', 'section', 'span', 'strong', 'summary', 'table', 'tbody', 'td', 'th', 'thead', 'tr', 'ul',
    'wrapper',
]);

function normalizeBlockMatchToken(value) {
    return String(value || '')
        .replace(/\uFF08[^\uFF09]*\uFF09/gu, ' ')
        .replace(/\([^)]*\)/gu, ' ')
        .replace(/(?:\u7f8e\u5316\u5757|\u7ed3\u6784\u5757|\u9762\u677f|panel|block|container|wrapper|island|html|markdown|code)/giu, ' ')
        .replace(/[^\p{L}\p{N}_-]+/gu, ' ')
        .trim()
        .toLowerCase();
}

function isUsefulBlockMatchToken(token) {
    const value = String(token || '').trim().toLowerCase();
    const hasCjk = /[\u3400-\u9fff]/u.test(value);
    return Boolean(value)
        && (value.length >= 3 || hasCjk)
        && !blockMatchStopTokens.has(value)
        && !/^[a-z](?:[-_][a-z])+$/iu.test(value)
        && !/^[\d_-]+$/u.test(value);
}

function addBlockMatchToken(tokens, value) {
    const normalized = normalizeBlockMatchToken(value);
    if (!normalized) {
        return;
    }

    for (const token of normalized.split(/\s+/u)) {
        if (isUsefulBlockMatchToken(token)) {
            tokens.add(token);
        }

        for (const part of token.split(/[_-]+/u)) {
            if (isUsefulBlockMatchToken(part)) {
                tokens.add(part);
            }
        }
    }
}

function getMarkerNamesForMatch(marker) {
    const source = String(marker || '').trim();
    if (!source) {
        return [];
    }

    const htmlStart = parseStartTagName(source);
    const htmlEnd = source.match(/^<\s*\/\s*([^\s/>=]+)\s*>$/u)?.[1] || '';
    const square = source.match(/^\[\/?([^\]\r\n]{1,80})\]$/u)?.[1] || '';
    const corner = source.match(/^\u3010\/?([^\u3011\r\n]{1,80})\u3011$/u)?.[1] || '';
    const quote = source.match(/^\u300C\/?([^\u300D\r\n]{1,80})\u300D$/u)?.[1] || '';
    const fenceInfo = source.match(/^[`~]{3,}\s*([^\s`~]{1,80})/u)?.[1] || '';

    return [htmlStart, htmlEnd, square, corner, quote, fenceInfo].filter(Boolean);
}

function addBlockMarkerTokens(tokens, marker) {
    for (const name of getMarkerNamesForMatch(marker)) {
        addBlockMatchToken(tokens, name);
    }
}

function addOuterTextMarkerTokens(tokens, text) {
    const source = String(text || '').trim();
    if (!source) {
        return;
    }

    addBlockMarkerTokens(tokens, source.match(/^<[^>]+>/u)?.[0] || '');
    addBlockMarkerTokens(tokens, source.match(/^\[[^\]\r\n]{1,80}\]/u)?.[0] || '');
    addBlockMarkerTokens(tokens, source.match(/^\u3010[^\u3011\r\n]{1,80}\u3011/u)?.[0] || '');
    addBlockMarkerTokens(tokens, source.match(/^\u300C[^\u300D\r\n]{1,80}\u300D/u)?.[0] || '');
    addBlockMarkerTokens(tokens, source.match(/^[`~]{3,}[^\r\n]*/u)?.[0] || '');
}

function getBlockMatchTokens(block) {
    const tokens = new Set();
    const [startMarker = '', endMarker = ''] = block?.markerPair || [];

    addBlockMatchToken(tokens, block?.label);
    addBlockMatchToken(tokens, block?.markerName);
    addBlockMarkerTokens(tokens, startMarker);
    addBlockMarkerTokens(tokens, endMarker);
    addOuterTextMarkerTokens(tokens, block?.text);
    addOuterTextMarkerTokens(tokens, block?.exampleText);

    return tokens;
}

function getBlockContentMarkerTokens(block) {
    const source = String(block?.text || block?.exampleText || '');
    const tokens = new Set();
    if (!source) {
        return tokens;
    }

    const htmlTagRegex = /<(?!\/|!|\?)([^\s/>=]+)(?:\s[^<>]*)?>/gu;
    let htmlMatch;
    while ((htmlMatch = htmlTagRegex.exec(source))) {
        const tagName = htmlMatch[1];
        const lower = String(tagName || '').toLowerCase();
        if (!isHtmlTagName(tagName) && !ignoredGenericTagNames.has(lower)) {
            addBlockMatchToken(tokens, tagName);
        }
    }

    const bracketRegex = /\[([^\]\r\n]{1,80})\]/gu;
    let bracketMatch;
    while ((bracketMatch = bracketRegex.exec(source))) {
        const name = String(bracketMatch[1] || '').trim();
        if (isSafeMarkerName(name) && !name.startsWith('/')) {
            addBlockMatchToken(tokens, name);
        }
    }

    return tokens;
}

function isPanelLikeBaselineBlock(block) {
    const label = String(block?.label || block?.markerName || '');
    const source = String(block?.source || '');
    return /(?:panel|container|wrapper)/iu.test(label)
        || /(?:combined|panel|container|wrapper)/iu.test(source)
        || /\u9762\u677f|\u7ec4\u5408/u.test(`${label}\n${source}`);
}

function findFallbackBaselineMatch(block, baselineBlocks, matchedBaselineIndexes) {
    const actualTokens = getBlockMatchTokens(block);
    if (!actualTokens.size) {
        return null;
    }

    let best = null;
    for (const baselineBlock of baselineBlocks) {
        if (matchedBaselineIndexes.has(baselineBlock.baselineIndex)) {
            continue;
        }

        const baselineTokens = getBlockMatchTokens(baselineBlock);
        const sharedTokens = [...actualTokens].filter(token => baselineTokens.has(token));
        if (!sharedTokens.length) {
            continue;
        }

        let score = sharedTokens.reduce((sum, token) => sum + Math.min(18, Math.max(8, token.length)), 0);
        if (block.blockKind === baselineBlock.blockKind) {
            score += 4;
        }
        if (block.occurrence === baselineBlock.occurrence) {
            score += 2;
        }
        score -= Math.min(6, Math.abs((block.actualIndex ?? 0) - baselineBlock.baselineIndex));

        if (!best || score > best.score) {
            best = { baselineBlock, score };
        }
    }

    return best && best.score >= 8 ? best.baselineBlock : null;
}

function isBaselineCoveredByActualChildren(baselineBlock, actualBlocks) {
    if (!isPanelLikeBaselineBlock(baselineBlock)) {
        return false;
    }

    const childTokens = getBlockContentMarkerTokens(baselineBlock);
    if (childTokens.size < 2) {
        return false;
    }

    const actualTokens = new Set();
    for (const block of actualBlocks) {
        for (const token of getBlockMatchTokens(block)) {
            actualTokens.add(token);
        }
    }

    const covered = [...childTokens].filter(token => actualTokens.has(token)).length;
    return covered >= 2 && covered / childTokens.size >= 0.5;
}

function findMarkerStartInText(sourceText, marker, fromIndex = 0) {
    const source = String(sourceText || '');
    const value = String(marker || '').trim();
    if (!source || !value) {
        return null;
    }

    const exactIndex = source.indexOf(value, fromIndex);
    if (exactIndex !== -1) {
        return { index: exactIndex, text: value };
    }

    const tagName = parseStartTagName(value);
    if (!tagName || isHtmlTagName(tagName)) {
        return null;
    }

    const tagRegex = new RegExp(`<\\s*${escapeRegExp(tagName)}(?:\\s[^<>]*)?>`, 'giu');
    tagRegex.lastIndex = Math.max(0, fromIndex);
    const match = tagRegex.exec(source);
    return match ? { index: match.index, text: match[0] } : null;
}

function findNextBaselineMarkerStart(source, fromIndex, baselineBlocks, baselineIndex) {
    let nextIndex = -1;
    for (const block of baselineBlocks.slice(baselineIndex + 1)) {
        const [startMarker = ''] = block.markerPair || [];
        const match = findMarkerStartInText(source, startMarker, fromIndex);
        if (!match) {
            continue;
        }

        if (nextIndex === -1 || match.index < nextIndex) {
            nextIndex = match.index;
        }
    }

    return nextIndex;
}

function findBaselineBlockRangeInCurrentText(currentText, baselineBlock, baselineIndex, baselineBlocks) {
    const source = String(currentText || '');
    const [startMarker = '', endMarker = ''] = baselineBlock?.markerPair || [];
    const startMatch = findMarkerStartInText(source, startMarker);
    if (!startMatch) {
        return null;
    }

    let end = -1;
    const afterStart = startMatch.index + startMatch.text.length;
    if (endMarker) {
        const exactEnd = source.indexOf(endMarker, afterStart);
        if (exactEnd !== -1) {
            end = exactEnd + endMarker.length;
        }
    }

    const tagName = parseStartTagName(startMatch.text);
    if (end === -1 && tagName && !isHtmlTagName(tagName)) {
        const htmlEnd = findMatchingHtmlEnd(source, startMatch.index, tagName);
        if (htmlEnd !== -1) {
            end = htmlEnd;
        }
    }

    if (end === -1) {
        const nextStart = findNextBaselineMarkerStart(source, afterStart, baselineBlocks, baselineIndex);
        end = nextStart === -1 ? source.trimEnd().length : nextStart;
    }

    if (end <= startMatch.index || end - startMatch.index > BLOCK_DETECTION_MAX) {
        return null;
    }

    const text = source.slice(startMatch.index, end).trimEnd();
    if (!text.trim()) {
        return null;
    }

    return {
        start: startMatch.index,
        end: startMatch.index + text.length,
        text,
        markerPair: baselineBlock.markerPair,
        markerName: baselineBlock.label,
        label: baselineBlock.label,
        blockKind: baselineBlock.blockKind,
        source: '疑似损坏',
        preview: trimText(text.replace(/\s+/gu, ' ').trim(), 120, false),
        isMissing: false,
        suspectedBaselineDamage: true,
        baselineIndex,
        displayOrder: baselineIndex,
        signature: baselineBlock.signature,
        occurrence: baselineBlock.occurrence,
        identityKey: baselineBlock.identityKey,
        baselineSourceMessageId: baselineBlock.sourceMessageId,
        baselinePosition: baselineBlock.position,
    };
}

function annotateBlockOccurrences(blocks) {
    const counts = new Map();
    return blocks.map((block, index) => {
        const signature = getBlockSignature(block);
        const occurrence = counts.get(signature) || 0;
        counts.set(signature, occurrence + 1);
        return {
            ...block,
            actualIndex: index,
            signature,
            occurrence,
            identityKey: `${signature}#${occurrence}`,
        };
    });
}

function getReplyRescueChatMetadata() {
    if (!chat_metadata || typeof chat_metadata !== 'object') {
        return null;
    }

    if (!chat_metadata[MODULE_NAME] || typeof chat_metadata[MODULE_NAME] !== 'object') {
        chat_metadata[MODULE_NAME] = {};
    }

    return chat_metadata[MODULE_NAME];
}

function sanitizeChatBlockBaseline(value) {
    if (!value || typeof value !== 'object' || !Array.isArray(value.blocks) || !value.blocks.length) {
        return null;
    }

    const blocks = value.blocks
        .map((block, index) => {
            const text = String(block?.text || '');
            const label = String(block?.label || `结构块 ${index + 1}`);
            const blockKind = isKnownBlockKind(block?.blockKind) ? block.blockKind : inferBlockKindFromText(`${label}\n${text}`);
            const markerPair = Array.isArray(block?.markerPair) ? block.markerPair.map(item => String(item || '')) : inferMarkerPairFromBlockText(text);
            const signature = String(block?.signature || getBlockSignature({ ...block, label, blockKind, markerPair, text }));
            const occurrence = Number.isInteger(block?.occurrence) ? block.occurrence : index;

            return {
                order: Number.isInteger(block?.order) ? block.order : index,
                label,
                source: String(block?.source || '聊天基准'),
                blockKind,
                markerPair,
                text: trimText(text, BASELINE_EXAMPLE_MAX, false),
                preview: String(block?.preview || trimText(text.replace(/\s+/gu, ' ').trim(), 120, false)),
                signature,
                occurrence,
                identityKey: `${signature}#${occurrence}`,
                position: {
                    start: Number.isInteger(block?.position?.start) ? block.position.start : -1,
                    end: Number.isInteger(block?.position?.end) ? block.position.end : -1,
                },
            };
        })
        .sort((a, b) => a.order - b.order);

    return {
        version: Number(value.version || 1),
        sourceMessageId: Number.isInteger(value.sourceMessageId) ? value.sourceMessageId : -1,
        learnedAt: String(value.learnedAt || ''),
        blockCount: blocks.length,
        signature: blocks.map(block => block.identityKey).join('\n'),
        blocks,
    };
}

function makeChatBlockBaseline(messageId, blocks) {
    const annotated = annotateBlockOccurrences(blocks);
    const baselineBlocks = annotated.map((block, index) => ({
        order: index,
        label: block.label || getRecognizedBlockLabel(block),
        source: block.source || '聊天基准',
        blockKind: isKnownBlockKind(block.blockKind) ? block.blockKind : inferBlockKindFromText(block.text),
        markerPair: block.markerPair || inferMarkerPairFromBlockText(block.text),
        text: trimText(block.text, BASELINE_EXAMPLE_MAX, false),
        preview: trimText(block.text.replace(/\s+/gu, ' ').trim(), 120, false),
        signature: block.signature,
        occurrence: block.occurrence,
        identityKey: block.identityKey,
        position: {
            start: Number.isInteger(block.start) ? block.start : -1,
            end: Number.isInteger(block.end) ? block.end : -1,
        },
    }));

    return sanitizeChatBlockBaseline({
        version: 1,
        sourceMessageId: messageId,
        learnedAt: new Date().toISOString(),
        blocks: baselineBlocks,
    });
}

function findBestChatBlockBaseline(settings = getSettings(), templateText = '', upToMessageId = -1) {
    const maxMessageId = Number.isInteger(upToMessageId) && upToMessageId >= 0
        ? Math.min(upToMessageId, (chat?.length || 1) - 1)
        : (chat?.length || 0) - 1;
    let best = null;

    for (let messageId = 0; messageId <= maxMessageId; messageId += 1) {
        const message = getCurrentMessage(messageId);
        if (!message || message.is_user || message.is_system) {
            continue;
        }

        const blocks = collectActualRecognizedBlocks(getMessageText(messageId), settings, templateText);
        if (!blocks.length) {
            continue;
        }

        if (!best || blocks.length > best.blocks.length) {
            best = {
                messageId,
                blocks,
            };
        }
    }

    return best ? makeChatBlockBaseline(best.messageId, best.blocks) : null;
}

function saveChatBlockBaseline(baseline) {
    const metadata = getReplyRescueChatMetadata();
    if (!metadata || !baseline) {
        return;
    }

    metadata[CHAT_BASELINE_METADATA_KEY] = baseline;
    chat_metadata.tainted = true;
    void saveChatConditional();
}

function getChatBlockBaseline(settings = getSettings(), templateText = '', activeMessageId = -1) {
    const metadata = getReplyRescueChatMetadata();
    const stored = sanitizeChatBlockBaseline(metadata?.[CHAT_BASELINE_METADATA_KEY]);
    if (stored) {
        return stored;
    }

    const candidate = findBestChatBlockBaseline(settings, templateText, activeMessageId);
    if (candidate) {
        saveChatBlockBaseline(candidate);
        return candidate;
    }

    return null;
}

function resolveMissingBlockInsertIndex(currentText, missingBlock, recognizedBlocks = runtime.recognizedBlocks) {
    const baselineIndex = Number(missingBlock?.baselineIndex);
    const actualBlocks = (recognizedBlocks || [])
        .filter(block => !block?.isMissing && Number.isInteger(block?.start) && Number.isInteger(block?.end))
        .filter(block => Number.isInteger(block.baselineIndex));

    const previous = actualBlocks
        .filter(block => block.baselineIndex < baselineIndex)
        .sort((a, b) => b.baselineIndex - a.baselineIndex || b.end - a.end)[0];
    if (previous) {
        return Math.max(0, Math.min(String(currentText || '').length, previous.end));
    }

    const next = actualBlocks
        .filter(block => block.baselineIndex > baselineIndex)
        .sort((a, b) => a.baselineIndex - b.baselineIndex || a.start - b.start)[0];
    if (next) {
        return Math.max(0, Math.min(String(currentText || '').length, next.start));
    }

    return String(currentText || '').trimEnd().length;
}

function getRecognizedBlocksForInsertion(currentText, evidence = {}) {
    const settings = getSettings();
    const templateText = String(evidence?.template ?? getCurrentTemplateEvidenceText() ?? '');
    const baseline = getChatBlockBaseline(settings, templateText, runtime.active?.messageId ?? -1);
    const actualBlocks = collectActualRecognizedBlocks(currentText, settings, templateText);
    return mergeRecognizedBlocksWithBaseline(actualBlocks, baseline, currentText);
}

function resolveMissingBlockInsertIndexInText(currentText, missingBlock, evidence = {}) {
    const recognizedBlocks = getRecognizedBlocksForInsertion(currentText, evidence);
    return resolveMissingBlockInsertIndex(currentText, missingBlock, recognizedBlocks);
}

function insertBlockAtPosition(currentText, blockText, insertAt) {
    const source = String(currentText || '');
    const value = String(blockText || '').trim();
    if (!value) {
        return source;
    }

    const index = Math.max(0, Math.min(source.length, Number.isInteger(insertAt) ? insertAt : source.trimEnd().length));
    const before = source.slice(0, index).trimEnd();
    const after = source.slice(index).trimStart();

    if (!before) {
        return after ? `${value}\n\n${after}` : value;
    }

    if (!after) {
        return `${before}\n\n${value}`;
    }

    return `${before}\n\n${value}\n\n${after}`;
}

function mergeRecognizedBlocksWithBaseline(actualBlocks, baseline, currentText) {
    const actualAnnotated = annotateBlockOccurrences(actualBlocks);
    if (!baseline?.blocks?.length) {
        return actualAnnotated.map((block, index) => ({
            ...block,
            index,
            baselineIndex: index,
            displayOrder: index,
        }));
    }

    const baselineBlocks = baseline.blocks.map((block, index) => ({ ...block, baselineIndex: index }));
    const baselineByKey = new Map(baselineBlocks.map(block => [block.identityKey, block]));
    const matchedBaselineIndexes = new Set();
    const matches = actualAnnotated.map((block) => {
        const baselineBlock = baselineByKey.get(block.identityKey);
        if (baselineBlock) {
            matchedBaselineIndexes.add(baselineBlock.baselineIndex);
        }

        return {
            block,
            baselineBlock,
            matchedByFallback: false,
        };
    });

    for (const match of matches) {
        if (match.baselineBlock) {
            continue;
        }

        const baselineBlock = findFallbackBaselineMatch(match.block, baselineBlocks, matchedBaselineIndexes);
        if (!baselineBlock) {
            continue;
        }

        match.baselineBlock = baselineBlock;
        match.matchedByFallback = true;
        matchedBaselineIndexes.add(baselineBlock.baselineIndex);
    }

    const merged = matches.map(({ block, baselineBlock, matchedByFallback }) => {
        return {
            ...block,
            isMissing: false,
            baselineIndex: baselineBlock?.baselineIndex ?? -1,
            displayOrder: baselineBlock ? baselineBlock.baselineIndex : baseline.blocks.length + block.actualIndex,
            matchedBaselineFallback: matchedByFallback,
        };
    });

    for (const [baselineIndex, block] of baselineBlocks.entries()) {
        if (matchedBaselineIndexes.has(baselineIndex)) {
            continue;
        }
        if (isBaselineCoveredByActualChildren(block, actualAnnotated)) {
            continue;
        }
        const damagedBlock = findBaselineBlockRangeInCurrentText(currentText, block, baselineIndex, baselineBlocks);
        if (damagedBlock) {
            merged.push(damagedBlock);
            continue;
        }

        merged.push({
            start: -1,
            end: -1,
            text: '',
            exampleText: block.text,
            markerPair: block.markerPair,
            markerName: block.label,
            label: block.label,
            blockKind: block.blockKind,
            source: '缺失',
            preview: `当前回复缺少此块；将按聊天基准第 ${baselineIndex + 1} 个位置补回。`,
            isMissing: true,
            baselineIndex,
            displayOrder: baselineIndex,
            signature: block.signature,
            occurrence: block.occurrence,
            identityKey: block.identityKey,
            baselineSourceMessageId: baseline.sourceMessageId,
            baselinePosition: block.position,
            insertAt: resolveMissingBlockInsertIndex(currentText, { baselineIndex }, merged),
        });
    }

    return merged
        .sort((a, b) => a.displayOrder - b.displayOrder || a.start - b.start)
        .map((block, index) => ({
            ...block,
            index,
        }));
}

function shouldExpandChatBlockBaseline(baseline, actualBlocks, mergedBlocks) {
    if (!baseline?.blocks?.length || !actualBlocks?.length || actualBlocks.length <= baseline.blocks.length) {
        return false;
    }

    if (mergedBlocks.some(block => block?.isMissing || block?.suspectedBaselineDamage)) {
        return false;
    }

    const matchedBaselineIndexes = new Set();
    let hasNewActualBlock = false;
    for (const block of mergedBlocks) {
        if (Number.isInteger(block?.baselineIndex) && block.baselineIndex >= 0) {
            matchedBaselineIndexes.add(block.baselineIndex);
        } else if (!block?.isMissing && Number.isInteger(block?.start) && block.start >= 0) {
            hasNewActualBlock = true;
        }
    }

    return hasNewActualBlock && matchedBaselineIndexes.size >= baseline.blocks.length;
}

function maybeExpandChatBlockBaseline(messageId, actualBlocks, baseline, mergedBlocks) {
    if (!shouldExpandChatBlockBaseline(baseline, actualBlocks, mergedBlocks)) {
        return null;
    }

    const nextBaseline = makeChatBlockBaseline(
        Number.isInteger(messageId) ? messageId : Number(baseline.sourceMessageId ?? -1),
        actualBlocks,
    );
    if (!nextBaseline || nextBaseline.blocks.length <= baseline.blocks.length || nextBaseline.signature === baseline.signature) {
        return null;
    }

    saveChatBlockBaseline(nextBaseline);
    return nextBaseline;
}

function collectRecognizedBlocks(text, settings = getSettings(), templateText = '', options = {}) {
    const source = String(text || '');
    const actualBlocks = collectActualRecognizedBlocks(source, settings, templateText);
    if (options.includeMissing === false) {
        return actualBlocks;
    }

    const messageId = Number(options.messageId ?? runtime.active?.messageId ?? -1);
    const baseline = getChatBlockBaseline(settings, templateText, messageId);
    const merged = mergeRecognizedBlocksWithBaseline(actualBlocks, baseline, source);
    const expandedBaseline = maybeExpandChatBlockBaseline(messageId, actualBlocks, baseline, merged);

    return expandedBaseline ? mergeRecognizedBlocksWithBaseline(actualBlocks, expandedBaseline, source) : merged;
}

function inferMarkerPairFromBlockText(text) {
    const source = String(text || '').trim();
    if (!source) {
        return null;
    }

    const fenceMatch = source.match(/^([ \t]{0,3})(`{3,}|~{3,})([^\r\n]*)/u);
    if (fenceMatch) {
        const closeFence = `${fenceMatch[1]}${fenceMatch[2]}`;
        const closeRegex = new RegExp(`(?:^|\\n)${escapeRegExp(closeFence)}[ \\t]*$`, 'u');
        if (closeRegex.test(source)) {
            return [`${fenceMatch[1]}${fenceMatch[2]}${fenceMatch[3] || ''}`, closeFence];
        }
    }

    const bracketPair = makeBracketMarkerPair(source.match(/^(\[[^\]\r\n]{1,80}\]|【[^】\r\n]{1,80}】|「[^」\r\n]{1,80}」)/u)?.[1] || '');
    if (bracketPair && source.endsWith(bracketPair[1])) {
        return bracketPair;
    }

    const openTag = source.match(/^<[^>]+>/u)?.[0] || '';
    const tagName = parseStartTagName(openTag);
    if (tagName) {
        const closeTag = source.match(new RegExp(`</\\s*${escapeRegExp(tagName)}\\s*>\\s*$`, 'iu'))?.[0]?.trim();
        if (closeTag) {
            return [openTag, closeTag];
        }
    }

    return null;
}

function findAllIndexes(text, needle) {
    const indexes = [];
    const source = String(text || '');
    if (!needle) {
        return indexes;
    }

    let index = 0;
    while (index < source.length) {
        const found = source.indexOf(needle, index);
        if (found === -1) {
            break;
        }

        indexes.push(found);
        index = found + needle.length;
    }

    return indexes;
}

function findManualEvidenceTarget(currentText, sourceText) {
    const candidates = [
        String(sourceText || ''),
        String(sourceText || '').trim(),
        normalizeLineBreaks(sourceText || ''),
        normalizeLineBreaks(sourceText || '').trim(),
    ]
        .filter(Boolean)
        .sort((a, b) => b.length - a.length);

    for (const candidate of [...new Set(candidates)]) {
        const start = currentText.indexOf(candidate);
        if (start !== -1) {
            return {
                text: candidate,
                start,
                end: start + candidate.length,
            };
        }
    }

    return null;
}

function makeMultiBlockStartMarker(ordinal) {
    return `<<<${MULTI_BLOCK_MARKER_PREFIX}_${ordinal}_START>>>`;
}

function makeMultiBlockEndMarker(ordinal) {
    return `<<<${MULTI_BLOCK_MARKER_PREFIX}_${ordinal}_END>>>`;
}

function ensureSelectedBlockIndexSet() {
    if (!(runtime.selectedBlockIndexes instanceof Set)) {
        runtime.selectedBlockIndexes = new Set();
    }

    return runtime.selectedBlockIndexes;
}

function resetRecognizedBlockSelection() {
    runtime.selectedBlockIndex = -1;
    runtime.selectedBlockIndexes = new Set();
}

function getSelectedBlockIndexes() {
    const selected = ensureSelectedBlockIndexSet();
    return [...selected]
        .filter(index => Number.isInteger(index) && Boolean(runtime.recognizedBlocks[index]))
        .sort((a, b) => a - b);
}

function getSelectedRecognizedBlocks() {
    return getSelectedBlockIndexes()
        .map(index => runtime.recognizedBlocks[index] ? { ...runtime.recognizedBlocks[index], selectedIndex: index } : null)
        .filter(Boolean)
        .sort((a, b) => {
            const aOrder = Number.isInteger(a.displayOrder) ? a.displayOrder : a.selectedIndex;
            const bOrder = Number.isInteger(b.displayOrder) ? b.displayOrder : b.selectedIndex;
            return aOrder - bOrder || a.start - b.start || a.end - b.end;
        });
}

function getRecognizedBlockSelectionKey(block) {
    if (!block) {
        return '';
    }

    if (block.identityKey) {
        return `${block.isMissing ? 'missing' : 'actual'}:${block.identityKey}`;
    }

    return `${block.start}:${block.end}:${block.text}`;
}

function getBlockEvidenceText(block) {
    return String(block?.isMissing ? block.exampleText || block.text || '' : block?.text || '');
}

function selectedLooksLikeStatusBlock(selectedText, settings = getSettings()) {
    const source = String(selectedText || '').trim();
    if (!source) {
        return false;
    }

    const parsed = findStatusBlocks(source, settings);
    return parsed.blocks.length > 0
        || (settings.statusStart && source.includes(settings.statusStart))
        || (settings.statusEnd && source.includes(settings.statusEnd));
}

function selectedLooksLikeStructureBlock(selectedText, blockKind = 'auto', settings = getSettings(), templateText = '') {
    const source = String(selectedText || '').trim();
    if (!source) {
        return false;
    }

    const parsed = findStructureBlocks(source, blockKind, settings, templateText);
    return parsed.blocks.length > 0
        || findBrokenBlockCandidate(source, blockKind, settings, templateText) !== null;
}

function findGenericStartTagCandidates(text, blockKind = 'auto') {
    const source = String(text || '');
    const candidates = [];
    const tagRegex = /<(?!\/|!|\?)([^\s/>=]+)(?:\s[^<>]*)?>/gu;
    let match;

    while ((match = tagRegex.exec(source))) {
        const tagName = match[1];
        if (!isLikelyBlockTagName(tagName, blockKind)) {
            continue;
        }

        candidates.push({
            index: match.index,
            tagName,
            startTag: match[0],
        });
    }

    return candidates;
}

function hasClosingTagAfter(text, tagName, fromIndex) {
    const tail = String(text || '').slice(fromIndex);
    return new RegExp(`</\\s*${escapeRegExp(tagName)}\\s*>`, 'u').test(tail);
}

function findBrokenGenericBlockCandidate(text, blockKind = 'auto') {
    const source = String(text || '').trimEnd();
    const label = getBlockTypeLabel(blockKind);
    if (!source) {
        return null;
    }

    const starts = findGenericStartTagCandidates(source, blockKind);
    for (let index = starts.length - 1; index >= 0; index -= 1) {
        const candidate = starts[index];
        if (!hasClosingTagAfter(source, candidate.tagName, candidate.index + candidate.startTag.length)) {
            return {
                text: source.slice(candidate.index),
                warning: `检测到未闭合${label}，已从最后一个可疑开始标签抓到消息末尾；应用时会替换这段原文。`,
            };
        }
    }

    return null;
}

function findBrokenStatusCandidate(text, settings = getSettings()) {
    const source = String(text || '').trimEnd();
    const start = settings.statusStart;
    const end = settings.statusEnd;
    if (!source || !start || !end) {
        return null;
    }

    const starts = findAllIndexes(source, start);
    const ends = findAllIndexes(source, end);

    for (let index = starts.length - 1; index >= 0; index -= 1) {
        const startIndex = starts[index];
        const hasClosingTag = ends.some(endIndex => endIndex > startIndex);
        if (!hasClosingTag) {
            return {
                text: source.slice(startIndex),
                warning: '检测到未闭合状态栏，已抓取从开始标记到消息末尾的片段；应用时会替换这段原文。',
            };
        }
    }

    if (ends.length > starts.length) {
        const endExclusive = ends[ends.length - 1] + end.length;
        const before = source.slice(0, endExclusive);
        const boundary = Math.max(before.lastIndexOf('\n\n'), before.lastIndexOf('\r\n\r\n'));
        const startIndex = boundary === -1 ? Math.max(0, before.lastIndexOf('\n', Math.max(0, endExclusive - 800))) : boundary + 2;
        return {
            text: source.slice(startIndex, endExclusive).trimStart(),
            warning: '检测到疑似缺少开始标记的状态栏，已抓取靠近结束标记的尾部片段；请先看一眼证据框再生成。',
        };
    }

    return null;
}

function findTailStatusCandidate(text, settings = getSettings()) {
    const source = String(text || '').trimEnd();
    if (!source) {
        return null;
    }

    const startIndex = settings.statusStart ? source.lastIndexOf(settings.statusStart) : -1;
    if (startIndex !== -1) {
        return {
            text: source.slice(startIndex),
            warning: '已抓取从最后一个状态栏开始标记到消息末尾的内容。',
        };
    }

    const boundary = Math.max(source.lastIndexOf('\n\n'), source.lastIndexOf('\r\n\r\n'));
    if (boundary !== -1 && source.length - boundary <= 2600) {
        return {
            text: source.slice(boundary).trimStart(),
            warning: '已抓取消息最后一段作为状态栏证据；如果里面混入正文，请在证据框里删掉正文部分。',
        };
    }

    const lines = source.split(/\r?\n/);
    const tail = lines.slice(Math.max(0, lines.length - 12)).join('\n').trim();
    if (!tail) {
        return null;
    }

    return {
        text: tail,
        warning: '已抓取消息最后 12 行作为状态栏证据；如果里面混入正文，请在证据框里删掉正文部分。',
    };
}

function findBrokenBlockCandidate(text, blockKind = 'auto', settings = getSettings(), templateText = '') {
    const source = String(text || '').trimEnd();
    const markerPairs = getBlockMarkerPairs(blockKind, settings, templateText);
    const label = getBlockTypeLabel(blockKind);

    for (const [start, end] of markerPairs) {
        const starts = findAllIndexes(source, start);
        const ends = findAllIndexes(source, end);

        for (let index = starts.length - 1; index >= 0; index -= 1) {
            const startIndex = starts[index];
            const hasClosingTag = ends.some(endIndex => endIndex > startIndex);
            if (!hasClosingTag) {
                return {
                    text: source.slice(startIndex),
                    warning: `检测到未闭合${label}，已抓取从开始标记到消息末尾的片段；应用时会替换这段原文。`,
                };
            }
        }

        if (ends.length > starts.length) {
            const endExclusive = ends[ends.length - 1] + end.length;
            const before = source.slice(0, endExclusive);
            const boundary = Math.max(before.lastIndexOf('\n\n'), before.lastIndexOf('\r\n\r\n'));
            const startIndex = boundary === -1 ? Math.max(0, before.lastIndexOf('\n', Math.max(0, endExclusive - 1200))) : boundary + 2;
            return {
                text: source.slice(startIndex, endExclusive).trimStart(),
                warning: `检测到疑似缺少开始标记的${label}，已抓取靠近结束标记的尾部片段；请先确认证据框。`,
            };
        }
    }

    return findBrokenGenericBlockCandidate(source, blockKind);
}

function findTailBlockCandidate(text, blockKind = 'auto', settings = getSettings(), templateText = '') {
    const source = String(text || '').trimEnd();
    const label = getBlockTypeLabel(blockKind);
    if (!source) {
        return null;
    }

    const markerPairs = getBlockMarkerPairs(blockKind, settings, templateText);
    let bestStart = -1;
    for (const [start] of markerPairs) {
        const startIndex = start ? source.lastIndexOf(start) : -1;
        if (startIndex > bestStart) {
            bestStart = startIndex;
        }
    }

    if (bestStart !== -1) {
        return {
            text: source.slice(bestStart),
            warning: `已抓取从最后一个${label}开始标记到消息末尾的内容。`,
        };
    }

    const genericStart = findGenericStartTagCandidates(source, blockKind).pop();
    if (genericStart) {
        return {
            text: source.slice(genericStart.index),
            warning: `已从最后一个可疑${label}开始标签抓到消息末尾；如果里面混入正文，请在证据框里删掉正文部分。`,
        };
    }

    const boundary = Math.max(source.lastIndexOf('\n\n'), source.lastIndexOf('\r\n\r\n'));
    if (boundary !== -1 && source.length - boundary <= 3200) {
        return {
            text: source.slice(boundary).trimStart(),
            warning: `已抓取消息最后一段作为${label}证据；如果里面混入正文，请在证据框里删掉正文部分。`,
        };
    }

    const lines = source.split(/\r?\n/);
    const tail = lines.slice(Math.max(0, lines.length - 16)).join('\n').trim();
    if (!tail) {
        return null;
    }

    return {
        text: tail,
        warning: `已抓取消息最后 16 行作为${label}证据；如果里面混入正文，请在证据框里删掉正文部分。`,
    };
}

function getSelectionInfoInMessage(messageElement) {
    const selection = window.getSelection?.();
    const textElement = messageElement?.querySelector('.mes_text');
    if (!selection || !textElement || selection.rangeCount === 0 || selection.isCollapsed) {
        return null;
    }

    const anchorInside = selection.anchorNode && textElement.contains(selection.anchorNode);
    const focusInside = selection.focusNode && textElement.contains(selection.focusNode);
    if (!anchorInside || !focusInside) {
        return null;
    }

    const selectedText = normalizeLineBreaks(selection.toString()).trim();
    if (!selectedText) {
        return null;
    }

    const messageId = getMessageIdFromElement(messageElement);
    const currentText = getMessageText(messageId);
    const range = selection.getRangeAt(0).cloneRange();
    let normalizedStart = -1;
    try {
        const beforeRange = range.cloneRange();
        beforeRange.selectNodeContents(textElement);
        beforeRange.setEnd(range.startContainer, range.startOffset);
        normalizedStart = normalizeSearchTextWithMap(beforeRange.toString()).text.length;
    } catch {
        normalizedStart = -1;
    }

    const rawRange = locateRawSelectionRange(currentText, selectedText, { normalizedStart });
    return {
        messageId,
        messageElement,
        selectedText,
        selectedRawText: rawRange?.text || '',
        rawStart: rawRange?.start ?? -1,
        rawEnd: rawRange?.end ?? -1,
        normalizedStart,
        capturedAt: Date.now(),
    };
}

function rememberSelectionInfo(info) {
    if (info?.selectedText && Number.isInteger(info.messageId)) {
        runtime.selectionSnapshot = {
            messageId: info.messageId,
            selectedText: info.selectedText,
            selectedRawText: info.selectedRawText || '',
            rawStart: info.rawStart ?? -1,
            rawEnd: info.rawEnd ?? -1,
            normalizedStart: info.normalizedStart ?? -1,
            capturedAt: Date.now(),
        };
    }

    return info;
}

function getSelectedTextInMessage(messageElement) {
    return getSelectionInfoInMessage(messageElement)?.selectedText || '';
}

function getFreshSelectionSnapshot() {
    const snapshot = runtime.selectionSnapshot;
    if (!snapshot || !snapshot.selectedText) {
        return null;
    }

    if (Date.now() - Number(snapshot.capturedAt || 0) > 30000) {
        return null;
    }

    return snapshot;
}

function getSelectionSnapshotForMessage(messageId) {
    const snapshot = getFreshSelectionSnapshot();
    if (!snapshot || snapshot.messageId !== messageId) {
        return null;
    }

    return snapshot;
}

function getElementFromNode(node) {
    if (node instanceof Element) {
        return node;
    }

    return node?.parentElement || null;
}

function getSelectedMessageElement() {
    const selection = window.getSelection?.();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
        return null;
    }

    const anchorElement = getElementFromNode(selection.anchorNode);
    const focusElement = getElementFromNode(selection.focusNode);
    const anchorMessage = anchorElement?.closest?.('#chat .mes');
    const focusMessage = focusElement?.closest?.('#chat .mes');

    if (!anchorMessage || anchorMessage !== focusMessage) {
        return null;
    }

    const messageId = getMessageIdFromElement(anchorMessage);
    const selectionInfo = getSelectionInfoInMessage(anchorMessage);
    if (!getCurrentMessage(messageId) || !selectionInfo) {
        return null;
    }

    rememberSelectionInfo(selectionInfo);
    return anchorMessage;
}

function captureCurrentSelectionSnapshot() {
    const messageElement = getSelectedMessageElement();
    if (!messageElement) {
        return null;
    }

    const messageId = getMessageIdFromElement(messageElement);
    if (messageId === -1) {
        return null;
    }

    return { messageElement, messageId };
}

function buildRecentContext(messageId, settings = getSettings()) {
    const maxChars = settings.contextLength;
    const maxMessages = settings.recentMessages;
    const start = Math.max(0, messageId - maxMessages + 1);
    const perMessage = Math.max(200, Math.floor(maxChars / maxMessages));
    const lines = [];

    for (let index = start; index <= messageId; index += 1) {
        const message = chat[index];
        if (!message || typeof message.mes !== 'string') {
            continue;
        }

        const role = message.is_user ? '用户' : (message.is_system ? '系统' : '助手');
        const text = trimText(message.mes, perMessage, false);
        lines.push(`[${index}] ${role}: ${text}`);
    }

    return trimText(lines.join('\n\n'), maxChars, true);
}

function findPreviousStatusExamples(messageId, settings = getSettings(), limit = 3) {
    const examples = [];
    for (let index = messageId - 1; index >= 0 && examples.length < limit; index -= 1) {
        const message = chat[index];
        if (!message || message.is_user || message.is_system || typeof message.mes !== 'string') {
            continue;
        }

        const parsed = findStatusBlocks(message.mes, settings);
        if (parsed.blocks.length === 1) {
            examples.unshift(parsed.blocks[0].text);
        }
    }

    return examples;
}

function findPreviousBlockExamples(messageId, blockKind = 'auto', settings = getSettings(), templateText = '', limit = 3) {
    const examples = [];
    for (let index = messageId - 1; index >= 0 && examples.length < limit; index -= 1) {
        const message = chat[index];
        if (!message || message.is_user || message.is_system || typeof message.mes !== 'string') {
            continue;
        }

        const parsed = findStructureBlocks(message.mes, blockKind, settings, templateText);
        if (parsed.blocks.length === 1) {
            examples.unshift(parsed.blocks[0].text);
        }
    }

    return examples;
}

function getSelectionParts(messageId, selectedText, selectionRange = null) {
    const currentText = getMessageText(messageId);
    const range = locateRawSelectionRange(currentText, selectedText, selectionRange || {});
    if (!range) {
        return null;
    }

    return {
        before: currentText.slice(0, range.start),
        selected: range.text,
        selectedVisible: selectedText,
        after: currentText.slice(range.end),
        range,
    };
}

function getStatusSourceForMode(active, settings = getSettings()) {
    const currentText = getMessageText(active.messageId);
    const selectedText = active.selectedText || '';
    const parsed = findStatusBlocks(currentText, settings);

    if (selectedLooksLikeStatusBlock(selectedText, settings) && currentText.includes(selectedText)) {
        return {
            text: selectedText,
            warning: '已使用你在消息里选中的文本作为状态栏证据，应用时只替换这段选区。',
        };
    }

    if (parsed.blocks.length === 1) {
        return {
            text: parsed.blocks[0].text,
            warning: '已找到 1 个完整状态栏，应用时只替换这个状态栏块。',
        };
    }

    if (parsed.blocks.length > 1) {
        return {
            text: '',
            warning: '当前回复里有多个完整状态栏。可以用下方按钮抓取最后完整块，或抓取消息尾部作为证据。',
        };
    }

    if (parsed.startCount !== parsed.endCount) {
        const broken = findBrokenStatusCandidate(currentText, settings);
        if (broken) {
            return broken;
        }

        return {
            text: '',
            warning: '检测到状态栏标签数量不匹配。可以用下方按钮抓取消息尾部，或把坏掉的状态栏粘贴到证据框。',
        };
    }

    const previousExamples = findPreviousStatusExamples(active.messageId, settings);
    if (settings.statusTemplate.trim() || previousExamples.length) {
        return {
            text: '',
            warning: settings.allowNewStatusbar
                ? '当前回复没有完整状态栏。将只按模板/历史样例追加新状态栏，无法确定的字段必须保持未知。'
                : '当前回复没有完整状态栏。默认不会新建；需要在设置里开启“允许无旧块时追加新状态栏”。',
        };
    }

    return {
        text: '',
        warning: '没有旧状态栏、模板或历史样例，插件不会让模型凭空生成状态栏。',
    };
}

function getSelectedBlockKind() {
    const value = runtime.active?.selectedBlockKind || 'auto';
    return isKnownBlockKind(value) ? value : 'auto';
}

function getCurrentTemplateEvidenceText() {
    return String(document.getElementById('rr-template-evidence')?.value || '').trim();
}

function canAppendNewBlock(blockKind, settings = getSettings()) {
    return Boolean(settings.allowNewBlock || (blockKind === 'status' && settings.allowNewStatusbar));
}

function getBlockSourceForMode(active, settings = getSettings()) {
    const currentText = getMessageText(active.messageId);
    const selectedText = active.selectedText || '';
    const blockKind = getSelectedBlockKind();
    const templateText = getCurrentTemplateEvidenceText();
    const parsed = findStructureBlocks(currentText, blockKind, settings, templateText);
    const label = getBlockTypeLabel(blockKind);

    if (selectedLooksLikeStructureBlock(selectedText, blockKind, settings, templateText) && currentText.includes(selectedText)) {
        return {
            text: selectedText,
            warning: `已使用你在消息里选中的文本作为${label}证据，应用时只替换这段选区。`,
        };
    }

    if (parsed.blocks.length === 1) {
        return {
            text: parsed.blocks[0].text,
            warning: `已找到 1 个完整${label}，应用时只替换这个结构块。`,
        };
    }

    if (parsed.blocks.length > 1) {
        return {
            text: '',
            warning: blockKind === 'auto'
                ? '当前回复里识别到多个结构块。请在左侧列表里点你要修的那一块。'
                : `当前回复里识别到多个完整${label}。请在左侧列表里点你要修的那一块。`,
        };
    }

    const broken = findBrokenBlockCandidate(currentText, blockKind, settings, templateText);
    if (broken) {
        return broken;
    }

    if (parsed.startCount !== parsed.endCount) {
        return {
            text: '',
            warning: `检测到${label}边界可能不完整。请优先点击左侧识别到的坏块；没有显示时说明当前消息里没有可安全定位的边界。`,
        };
    }

    const previousExamples = findPreviousBlockExamples(active.messageId, blockKind, settings, templateText);
    if (templateText || previousExamples.length) {
        return {
            text: '',
            warning: canAppendNewBlock(blockKind, settings)
                ? `当前回复没有完整${label}。将只按模板/历史样例追加新块，无法确定的字段必须保持未知。`
                : `当前回复没有完整${label}。新版不会只凭模板新建块，请先确认当前消息里有真实存在的目标块。`,
        };
    }

    return {
        text: '',
        warning: `没有在当前消息里找到真实存在的${label}，插件不会让模型凭空生成。`,
    };
}

function getSourceForMode(active, mode) {
    const settings = getSettings();
    const currentText = getMessageText(active.messageId);

    switch (mode) {
        case 'continue_tail':
            return {
                text: trimText(currentText, settings.contextLength, true),
                warning: '模型只会输出要追加到末尾的新内容，不会重写前文。',
            };
        case 'rewrite_selection':
            if (!active.selectedText) {
                return {
                    text: '',
                    warning: '重写片段需要先在助手消息正文里选中文字。',
                };
            }

            return {
                text: active.selectedText,
                warning: '模型只会输出选中片段的替换文本，应用前会再次确认原选区仍存在。',
            };
        case 'repair_block':
            return getBlockSourceForMode(active, settings);
        case 'repair_statebar':
            return getStatusSourceForMode(active, settings);
        case 'repair_format':
            return {
                text: active.selectedText || currentText,
                warning: active.selectedText
                    ? '将只修复选中片段的格式，应用时替换选区。'
                    : '没有选区时将修复整条回复的格式，应用前仍需预览。',
            };
        default:
            return { text: currentText, warning: '' };
    }
}

function buildContinuePrompt(active, instruction, sourceText) {
    const settings = getSettings();
    return [
        '你正在修复一条已经生成过的角色扮演回复。',
        '严格规则：',
        '1. 只输出需要追加到原回复末尾的新内容。',
        '2. 不要重写、复述或总结已经给出的原文。',
        '3. 必须自然接上原回复的最后一句，保持视角、语气、节奏和格式。',
        '4. 不要新增与最近上下文冲突的事实。',
        '',
        `用户额外要求：${instruction || '无'}`,
        '',
        '最近上下文：',
        buildRecentContext(active.messageId, settings),
        '',
        '当前回复末尾：',
        sourceText || trimText(getMessageText(active.messageId), settings.contextLength, true),
    ].join('\n');
}

function buildRewritePrompt(active, instruction, sourceText) {
    const settings = getSettings();
    const parts = getSelectionParts(active.messageId, active.selectedText, active.selectionRange);
    if (!parts) {
        throw new Error('原选区已经不在当前回复里，不能安全重写。');
    }

    active.selectionRange = {
        rawStart: parts.range.start,
        rawEnd: parts.range.end,
        selectedRawText: parts.range.text,
        normalizedStart: active.selectionRange?.normalizedStart ?? -1,
    };

    return [
        '你正在局部重写一条已经生成过的角色扮演回复。',
        '严格规则：',
        '1. 只输出“选中片段”的替换版本。',
        '2. 不要输出前文、后文、解释、标题或代码围栏。',
        '3. 替换版本必须能自然接在前文和后文之间。',
        '4. 不要编造上下文中没有依据的新地点、人物状态、数值或关系变化。',
        '',
        `用户额外要求：${instruction || '无'}`,
        '',
        '最近上下文：',
        buildRecentContext(active.messageId, settings),
        '',
        '前文：',
        trimText(parts.before, Math.floor(settings.contextLength / 2), true),
        '',
        '需要重写的选中片段：',
        sourceText || parts.selectedVisible || parts.selected,
        '',
        '后文：',
        trimText(parts.after, Math.floor(settings.contextLength / 2), false),
    ].join('\n');
}

function makeTemplateCandidate(source, title, text, blockKind, bonus = 0) {
    const body = String(text || '').trim();
    if (!body) {
        return null;
    }

    const baseScore = scoreTextForBlockKind(`${title}\n${body}`, blockKind);
    const score = baseScore + bonus + (baseScore > 0 && looksLikeTemplateText(body) ? 1 : 0);
    if (score <= 0) {
        return null;
    }

    return {
        source,
        title: String(title || '未命名').trim(),
        text: trimText(body, 3600),
        score,
    };
}

const presetTextKeyPattern = /(prompt|template|format|sequence|suffix|prefix|separator|stop|macro|story|chat_start|content|body|include|exclude|jailbreak|nsfw|prefill|system|assistant|instruction|schema)/iu;
const presetSecretKeyPattern = /(api[_-]?key|secret|token|password|credential|authorization|bearer|cookie)/iu;
const presetIgnoredKeyPattern = /(temperature|top_|topk|tfs|mirostat|penalty|sampler|seed|model|server|url|proxy|timeout|stream|avatar|sound|theme|color|width|height|font|blur|shadow)/iu;

function shouldReadPresetKey(key, value) {
    const name = String(key || '');
    if (!name || presetSecretKeyPattern.test(name)) {
        return false;
    }

    if (typeof value === 'string') {
        return presetTextKeyPattern.test(name) || looksLikeTemplateText(value);
    }

    return !presetIgnoredKeyPattern.test(name);
}

function shouldUsePresetString(path, text, blockKind) {
    const value = String(text || '').trim();
    if (value.length < 2) {
        return false;
    }

    return presetTextKeyPattern.test(path)
        || looksLikeTemplateText(value)
        || scoreTextForBlockKind(`${path}\n${value}`, blockKind) > 0;
}

function collectPresetTextParts(value, blockKind, path = [], parts = [], depth = 0) {
    if (parts.length >= 80 || depth > 5 || value === null || value === undefined) {
        return parts;
    }

    if (typeof value === 'string') {
        const text = value.trim();
        const label = path.length ? path.join('.') : '内容';
        if (shouldUsePresetString(label, text, blockKind)) {
            parts.push(`${label}：\n${trimText(text, 1800)}`);
        }
        return parts;
    }

    if (Array.isArray(value)) {
        value.slice(0, 24).forEach((item, index) => {
            collectPresetTextParts(item, blockKind, [...path, String(index + 1)], parts, depth + 1);
        });
        return parts;
    }

    if (typeof value !== 'object') {
        return parts;
    }

    for (const [key, child] of Object.entries(value)) {
        if (parts.length >= 80) {
            break;
        }

        if (!shouldReadPresetKey(key, child)) {
            continue;
        }

        collectPresetTextParts(child, blockKind, [...path, key], parts, depth + 1);
    }

    return parts;
}

function getOpenAiPresetByName(name) {
    const presetName = String(name || '').trim();
    if (!presetName || !openai_settings) {
        return null;
    }

    const index = openai_setting_names?.[presetName];
    if (index !== undefined && openai_settings[index]) {
        return openai_settings[index];
    }

    if (!Array.isArray(openai_settings)) {
        return null;
    }

    return openai_settings.find(preset => preset?.name === presetName || preset?.preset_name === presetName) || null;
}

function unwrapNamedPreset(preset, name) {
    if (!preset || typeof preset !== 'object') {
        return preset;
    }

    const presetName = String(name || '').trim();
    if (presetName && preset[presetName] && typeof preset[presetName] === 'object') {
        return preset[presetName];
    }

    return preset;
}

function getTextGenPresetByName(name) {
    const presetName = String(name || '').trim();
    if (!presetName || !Array.isArray(textgenerationwebui_presets)) {
        return null;
    }

    const index = Array.isArray(textgenerationwebui_preset_names)
        ? textgenerationwebui_preset_names.indexOf(presetName)
        : -1;
    if (index !== -1 && textgenerationwebui_presets[index]) {
        return unwrapNamedPreset(textgenerationwebui_presets[index], presetName);
    }

    return textgenerationwebui_presets
        .map(preset => unwrapNamedPreset(preset, presetName))
        .find(preset => preset?.name === presetName || preset?.preset_name === presetName) || null;
}

function findPresetByName(presets, name) {
    const presetName = String(name || '').trim();
    if (!presetName || !Array.isArray(presets)) {
        return null;
    }

    return presets.find(preset => preset?.name === presetName) || null;
}

function addPresetTemplateCandidate(candidates, title, value, blockKind, bonus = 1) {
    const parts = collectPresetTextParts(value, blockKind);
    if (!parts.length) {
        return;
    }

    const candidate = makeTemplateCandidate('预设', title, parts.join('\n\n'), blockKind, bonus);
    if (candidate) {
        candidates.push(candidate);
    }
}

function collectPresetTemplateCandidates(blockKind) {
    const candidates = [];

    try {
        addPresetTemplateCandidate(candidates, '当前 Chat Completion 设置', oai_settings, blockKind, 1);
        const openAiPresetName = oai_settings?.preset_settings_openai;
        addPresetTemplateCandidate(candidates, `Chat Completion 预设：${openAiPresetName || '当前'}`, getOpenAiPresetByName(openAiPresetName), blockKind, 2);

        addPresetTemplateCandidate(candidates, '当前 Text Completion 设置', textgenerationwebui_settings, blockKind, 1);
        const textGenPresetName = textgenerationwebui_settings?.preset;
        addPresetTemplateCandidate(candidates, `Text Completion 预设：${textGenPresetName || '当前'}`, getTextGenPresetByName(textGenPresetName), blockKind, 2);

        const contextName = power_user?.context?.preset;
        addPresetTemplateCandidate(candidates, `上下文模板：${contextName || '当前'}`, power_user?.context, blockKind, 1);
        addPresetTemplateCandidate(candidates, `上下文预设：${contextName || '当前'}`, findPresetByName(context_presets, contextName), blockKind, 2);

        const instructName = power_user?.instruct?.preset;
        addPresetTemplateCandidate(candidates, `指令模板：${instructName || '当前'}`, power_user?.instruct, blockKind, 1);
        addPresetTemplateCandidate(candidates, `指令预设：${instructName || '当前'}`, findPresetByName(instruct_presets, instructName), blockKind, 2);

        const systemPromptName = power_user?.sysprompt?.name;
        addPresetTemplateCandidate(candidates, `系统提示：${systemPromptName || '当前'}`, power_user?.sysprompt, blockKind, 1);
        addPresetTemplateCandidate(candidates, `系统提示预设：${systemPromptName || '当前'}`, findPresetByName(system_prompts, systemPromptName), blockKind, 2);
    } catch (error) {
        console.warn(`[${DISPLAY_NAME}] 读取预设模板失败`, error);
    }

    return candidates;
}

function collectRegexTemplateCandidates(blockKind) {
    try {
        const allowedScripts = typeof getRegexScripts === 'function' ? getRegexScripts({ allowedOnly: true }) : [];
        const scripts = Array.isArray(allowedScripts) && allowedScripts.length
            ? allowedScripts
            : typeof getRegexScripts === 'function' ? getRegexScripts({ allowedOnly: false }) : [];
        if (!Array.isArray(scripts)) {
            return [];
        }

        return scripts
            .map((script, index) => {
                const title = script?.scriptName || `正则脚本 ${index + 1}`;
                const body = [
                    `脚本名：${title}`,
                    `状态：${script?.disabled ? '已禁用' : '启用'}`,
                    `查找正则：${script?.findRegex || '无'}`,
                    '替换/美化模板：',
                    script?.replaceString || '无',
                ].join('\n');
                const bonus = script?.disabled ? -1 : 1;
                return makeTemplateCandidate('正则', title, body, blockKind, bonus);
            })
            .filter(Boolean);
    } catch (error) {
        console.warn(`[${DISPLAY_NAME}] 读取正则模板失败`, error);
        return [];
    }
}

function getRelatedWorldNames() {
    const names = new Set();
    const addName = (name) => {
        const value = String(name || '').trim();
        if (value) {
            names.add(value);
        }
    };
    const addNames = (value) => {
        if (Array.isArray(value)) {
            value.forEach(addName);
        } else {
            addName(value);
        }
    };

    if (Array.isArray(selected_world_info)) {
        selected_world_info.forEach(addName);
    }

    addNames(chat_metadata?.[WORLD_INFO_METADATA_KEY]);

    const character = characters?.[this_chid];
    addNames(character?.data?.extensions?.world);

    try {
        const fileName = this_chid !== undefined ? getCharaFilename(this_chid) : '';
        const extraCharLore = world_info?.charLore?.find?.(entry => entry?.name === fileName);
        if (Array.isArray(extraCharLore?.extraBooks)) {
            extraCharLore.extraBooks.forEach(addName);
        }
    } catch (error) {
        console.warn(`[${DISPLAY_NAME}] 读取角色额外世界书失败`, error);
    }

    if (Array.isArray(world_names) && world_names.length) {
        return [...names].filter(name => world_names.includes(name));
    }

    return [...names];
}

function getWorldEntryTemplateText(worldName, entry) {
    const key = Array.isArray(entry?.key) ? entry.key.join('、') : '';
    const secondary = Array.isArray(entry?.keysecondary) ? entry.keysecondary.join('、') : '';
    return [
        `世界书：${worldName}`,
        `条目：${entry?.comment || entry?.uid || '未命名'}`,
        key ? `关键词：${key}` : '',
        secondary ? `次要关键词：${secondary}` : '',
        '内容：',
        entry?.content || '',
    ].filter(Boolean).join('\n');
}

async function collectWorldInfoTemplateCandidates(blockKind) {
    const candidates = [];
    const searched = new Set();

    const scanWorlds = async (names, sourceLabel) => {
        for (const worldName of names) {
            if (!worldName || searched.has(worldName)) {
                continue;
            }

            searched.add(worldName);

            try {
                const data = await loadWorldInfo(worldName);
                const entries = Object.values(data?.entries || {});
                for (const entry of entries) {
                    const title = `${worldName} / ${entry?.comment || entry?.uid || '未命名条目'}`;
                    const body = getWorldEntryTemplateText(worldName, entry);
                    const candidate = makeTemplateCandidate(sourceLabel, title, body, blockKind);
                    if (candidate) {
                        candidates.push(candidate);
                    }
                }
            } catch (error) {
                console.warn(`[${DISPLAY_NAME}] 读取世界书失败：${worldName}`, error);
            }
        }
    };

    const relatedNames = getRelatedWorldNames();
    await scanWorlds(relatedNames, '相关世界书');

    if (candidates.length === 0 && Array.isArray(world_names)) {
        const fallbackNames = world_names.filter(name => !searched.has(name)).slice(0, 30);
        await scanWorlds(fallbackNames, '世界书');
    }

    return candidates;
}

function dedupeTemplateCandidates(candidates) {
    const seen = new Set();
    return candidates
        .filter(Boolean)
        .sort((a, b) => b.score - a.score)
        .filter((candidate) => {
            const key = `${candidate.source}\u0000${candidate.title}\u0000${candidate.text.slice(0, 300)}`;
            if (seen.has(key)) {
                return false;
            }

            seen.add(key);
            return true;
        });
}

async function collectTemplateCandidates(blockKind) {
    const presetCandidates = collectPresetTemplateCandidates(blockKind);
    const regexCandidates = collectRegexTemplateCandidates(blockKind);
    const worldCandidates = await collectWorldInfoTemplateCandidates(blockKind);
    return dedupeTemplateCandidates([...presetCandidates, ...regexCandidates, ...worldCandidates]).slice(0, 10);
}

function formatTemplateCandidates(candidates) {
    if (!candidates.length) {
        return '';
    }

    return candidates
        .map((candidate, index) => [
            `【${index + 1}｜${candidate.source}｜${candidate.title}】`,
            candidate.text,
        ].join('\n'))
        .join('\n\n---\n\n');
}

async function refreshBlockTemplateEvidence({ silent = false } = {}) {
    if (!runtime.active) {
        return;
    }

    const templateElement = document.getElementById('rr-template-evidence');
    const statusElement = document.getElementById('rr-modal-status');
    if (!templateElement) {
        return;
    }

    const blockKind = getSelectedBlockKind();
    const token = Date.now();
    runtime.active.templateScanToken = token;

    if (!silent && statusElement) {
        statusElement.textContent = '正在读取预设、正则和世界书里的格式线索...';
    }

    const candidates = await collectTemplateCandidates(blockKind);
    if (runtime.active?.templateScanToken !== token) {
        return;
    }

    runtime.active.blockTemplateCandidates = candidates;
    templateElement.value = formatTemplateCandidates(candidates);

    if (!silent && statusElement) {
        statusElement.textContent = candidates.length
            ? `已读取 ${candidates.length} 条格式证据。它们只用于标签、字段、class、宏和排版，不当剧情事实。`
            : '没有在预设、正则或世界书里找到明显对应的格式线索；仍会依据旧块、当前回复和上下文修改。';
    }

    const sourceElement = document.getElementById('rr-source');
    const warningElement = document.getElementById('rr-source-warning');
    if (sourceElement && !sourceElement.value.trim()) {
        const source = getBlockSourceForMode(runtime.active);
        sourceElement.value = source.text;
        if (warningElement) {
            warningElement.textContent = source.warning || '';
        }
    }

    if (runtime.active?.mode === 'repair_block') {
        renderRecognizedBlocks(runtime.selectedBlockIndex);
    }
}

function prepareStatusEvidence(active, instruction, sourceText) {
    const settings = getSettings();
    const currentText = getMessageText(active.messageId);
    const parsed = findStatusBlocks(currentText, settings);
    const selectedText = active.selectedText || '';
    const selectedRange = selectedText ? locateRawSelectionRange(currentText, selectedText, active.selectionRange || {}) : null;
    const selectedInCurrent = selectedLooksLikeStatusBlock(selectedText, settings) && Boolean(selectedRange);
    const manualEvidenceRaw = String(sourceText || '');
    const manualEvidence = manualEvidenceRaw.trim();
    const manualTarget = findManualEvidenceTarget(currentText, manualEvidenceRaw);
    const previousExamples = findPreviousStatusExamples(active.messageId, settings);
    const template = settings.statusTemplate.trim();

    let targetBlock = '';
    let applyTarget = '';
    let applyMode = '';
    let applyStart = -1;
    let applyEnd = -1;

    if (selectedInCurrent) {
        targetBlock = manualEvidence || selectedText;
        applyTarget = selectedText;
        applyMode = 'replace_selection';
        applyStart = selectedRange.start;
        applyEnd = selectedRange.end;
    } else if (manualTarget) {
        targetBlock = manualEvidence || manualTarget.text;
        applyTarget = manualTarget.text;
        applyMode = 'replace_manual';
        applyStart = manualTarget.start;
        applyEnd = manualTarget.end;
    } else if (parsed.blocks.length === 1) {
        targetBlock = manualEvidence || parsed.blocks[0].text;
        applyTarget = parsed.blocks[0].text;
        applyMode = 'replace_block';
        applyStart = parsed.blocks[0].start;
        applyEnd = parsed.blocks[0].end;
    } else if (parsed.blocks.length > 1) {
        throw new Error('当前回复有多个完整状态栏。请用“抓取最后完整块”或“抓取消息尾部”把目标放进证据框。');
    } else {
        targetBlock = manualEvidence;
        applyMode = 'append_new';

        if (parsed.startCount !== parsed.endCount && !manualEvidence) {
            throw new Error('状态栏标签不完整。请用“自动抓取”或“抓取消息尾部”把坏掉的状态栏放进证据框。');
        }

        if (!settings.allowNewStatusbar) {
            throw new Error('当前回复没有可替换的状态栏位置。默认不会新建或追加状态栏，请先选中坏掉的状态栏片段，或在设置里开启按模板追加。');
        }
    }

    if (!targetBlock && !template && previousExamples.length === 0) {
        throw new Error('没有旧状态栏、模板或历史样例，不能让模型凭空生成状态栏。');
    }

    if (applyMode === 'append_new' && !targetBlock && !template && previousExamples.length === 0) {
        throw new Error('追加新状态栏至少需要模板或历史样例。');
    }

    return {
        targetBlock,
        applyTarget,
        applyMode,
        applyStart,
        applyEnd,
        previousExamples,
        template,
        instruction,
    };
}

function chooseBlockMarkerPair(blockKind, targetBlock, templateText, settings = getSettings()) {
    const inferredFromTarget = inferMarkerPairFromBlockText(targetBlock);
    if (inferredFromTarget) {
        return inferredFromTarget;
    }

    const pairs = getBlockMarkerPairs(blockKind, settings, templateText);
    const target = String(targetBlock || '');
    const template = String(templateText || '');

    for (const pair of pairs) {
        if (target.includes(pair[0]) && target.includes(pair[1])) {
            return pair;
        }
    }

    for (const pair of pairs) {
        if (template.includes(pair[0]) && template.includes(pair[1])) {
            return pair;
        }
    }

    return pairs[0] || null;
}

function resolveCurrentBlockRange(currentText, target, label = '结构块') {
    const text = String(target?.text || '');
    const start = Number(target?.start);
    const end = Number(target?.end);
    if (!text) {
        throw new Error(`${label}目标为空，不能安全替换。`);
    }

    if (Number.isInteger(start) && Number.isInteger(end) && currentText.slice(start, end) === text) {
        return { start, end };
    }

    const indexes = findAllIndexes(currentText, text);
    if (indexes.length === 1) {
        return { start: indexes[0], end: indexes[0] + text.length };
    }

    throw new Error(`${label}目标片段已经变化或出现重复，不能安全替换。请重新扫描当前聊天块。`);
}

function prepareBlockEvidence(active, instruction, sourceText) {
    const settings = getSettings();
    const currentText = getMessageText(active.messageId);
    const selectedBlockKind = getSelectedBlockKind();
    const template = getCurrentTemplateEvidenceText();
    const parsed = findStructureBlocks(currentText, selectedBlockKind, settings, template);
    const selectedText = active.selectedText || '';
    const selectedRange = selectedText ? locateRawSelectionRange(currentText, selectedText, active.selectionRange || {}) : null;
    const selectedInCurrent = selectedLooksLikeStructureBlock(selectedText, selectedBlockKind, settings, template) && Boolean(selectedRange);
    const manualEvidenceRaw = String(sourceText || '');
    const manualEvidence = manualEvidenceRaw.trim();
    const manualTarget = findManualEvidenceTarget(currentText, manualEvidenceRaw);
    let previousExamples = findPreviousBlockExamples(active.messageId, selectedBlockKind, settings, template);

    let targetBlock = '';
    let applyTarget = '';
    let applyMode = '';
    let applyStart = -1;
    let applyEnd = -1;
    let markerPairHint = null;
    let missingHint = null;
    const selectedRecognizedBlocks = getSelectedRecognizedBlocks();
    const selectedRecognizedBlock = selectedRecognizedBlocks.length === 1 ? selectedRecognizedBlocks[0] : null;

    if (selectedRecognizedBlock?.isMissing) {
        const exampleText = getBlockEvidenceText(selectedRecognizedBlock);
        targetBlock = manualEvidence || exampleText;
        applyTarget = '';
        applyMode = 'insert_missing';
        applyStart = Number.isInteger(selectedRecognizedBlock.insertAt) ? selectedRecognizedBlock.insertAt : -1;
        applyEnd = applyStart;
        markerPairHint = selectedRecognizedBlock.markerPair;
        missingHint = {
            isMissing: true,
            baselineIndex: selectedRecognizedBlock.baselineIndex,
            identityKey: selectedRecognizedBlock.identityKey,
            exampleText,
            insertAt: selectedRecognizedBlock.insertAt,
            label: selectedRecognizedBlock.label,
        };
        if (exampleText.trim() && !previousExamples.some(example => example.trim() === exampleText.trim())) {
            previousExamples = [exampleText, ...previousExamples];
        }
    } else if (selectedRecognizedBlock) {
        const range = resolveCurrentBlockRange(currentText, selectedRecognizedBlock, selectedRecognizedBlock.label || '结构块');
        targetBlock = manualEvidence || selectedRecognizedBlock.text;
        applyTarget = selectedRecognizedBlock.text;
        applyMode = 'replace_recognized';
        applyStart = range.start;
        applyEnd = range.end;
        markerPairHint = selectedRecognizedBlock.markerPair;
    } else if (selectedInCurrent) {
        targetBlock = manualEvidence || selectedText;
        applyTarget = selectedText;
        applyMode = 'replace_selection';
        applyStart = selectedRange.start;
        applyEnd = selectedRange.end;
    } else if (manualTarget) {
        targetBlock = manualEvidence || manualTarget.text;
        applyTarget = manualTarget.text;
        applyMode = 'replace_manual';
        applyStart = manualTarget.start;
        applyEnd = manualTarget.end;
    } else if (parsed.blocks.length === 1) {
        targetBlock = manualEvidence || parsed.blocks[0].text;
        applyTarget = parsed.blocks[0].text;
        applyMode = 'replace_block';
        applyStart = parsed.blocks[0].start;
        applyEnd = parsed.blocks[0].end;
        markerPairHint = parsed.blocks[0].markerPair;
    } else if (parsed.blocks.length > 1) {
        throw new Error('当前回复有多个可能的结构块。请先在左侧识别块列表里点你要修的那一块。');
    } else {
        throw new Error('没有在当前回复里找到这个目标块。为避免凭空生成，新版只修改当前消息中真实存在的块。');
    }

    if (!targetBlock && !template && previousExamples.length === 0) {
        throw new Error('没有旧结构块、模板证据或历史样例，不能让模型凭空生成。');
    }

    const inferredKind = selectedBlockKind === 'auto'
        ? inferBlockKindFromText([targetBlock, template, previousExamples.join('\n')].join('\n'))
        : selectedBlockKind;
    const markerPair = chooseBlockMarkerPair(inferredKind, targetBlock, template, settings);

    return {
        targetBlock,
        applyTarget,
        applyMode,
        applyStart,
        applyEnd,
        previousExamples,
        template,
        instruction,
        blockKind: inferredKind,
        selectedBlockKind,
        markerPair: markerPairHint || markerPair,
        ...missingHint,
    };
}

function prepareMultiBlockEvidence(active, instruction) {
    const settings = getSettings();
    const currentText = getMessageText(active.messageId);
    const template = getCurrentTemplateEvidenceText();
    const selectedBlocks = getSelectedRecognizedBlocks();

    if (!selectedBlocks.length) {
        throw new Error('请先在已识别块列表里选择至少一个要修的块。');
    }

    const targets = selectedBlocks.map((block, index) => {
        const isMissing = Boolean(block.isMissing);
        const evidenceText = getBlockEvidenceText(block);
        const blockKind = isKnownBlockKind(block.blockKind) && block.blockKind !== 'auto'
            ? block.blockKind
            : inferBlockKindFromText([block.label, evidenceText, template].join('\n'));
        const range = isMissing
            ? { start: -1, end: -1 }
            : resolveCurrentBlockRange(currentText, block, block.label || getBlockTypeLabel(blockKind));
        const ordinal = index + 1;

        return {
            ordinal,
            selectedIndex: block.selectedIndex,
            label: block.label || getBlockTypeLabel(blockKind),
            source: isMissing ? '缺失' : block.source || '结构块',
            text: evidenceText,
            start: range.start,
            end: range.end,
            missing: isMissing,
            baselineIndex: block.baselineIndex,
            identityKey: block.identityKey,
            insertAt: block.insertAt,
            blockKind,
            markerPair: block.markerPair || chooseBlockMarkerPair(blockKind, evidenceText, template, settings),
            startMarker: makeMultiBlockStartMarker(ordinal),
            endMarker: makeMultiBlockEndMarker(ordinal),
        };
    });

    const orderedTargets = targets
        .filter(target => !target.missing)
        .sort((a, b) => a.start - b.start || b.end - a.end);
    for (let index = 1; index < orderedTargets.length; index += 1) {
        const previous = orderedTargets[index - 1];
        const current = orderedTargets[index];
        if (current.start < previous.end) {
            throw new Error('选中的块互相重叠或存在包含关系。请只选最外层那一块，或选择彼此独立的块。');
        }
    }

    const previousExamples = [];
    const seenExamples = new Set();
    for (const blockKind of [...new Set(targets.map(target => target.blockKind))]) {
        for (const example of findPreviousBlockExamples(active.messageId, blockKind, settings, template, 2)) {
            const key = example.trim();
            if (key && !seenExamples.has(key)) {
                seenExamples.add(key);
                previousExamples.push(example);
            }
        }
    }

    return {
        applyMode: 'replace_multiple_blocks',
        targets,
        previousExamples,
        template,
        instruction,
        blockKind: 'auto',
        selectedBlockKind: 'auto',
    };
}

function removeKnownStatusBlock(text, evidence) {
    if (evidence.applyTarget && text.includes(evidence.applyTarget)) {
        return text.replace(evidence.applyTarget, '[状态栏位置]');
    }

    return text;
}

function removeKnownBlock(text, evidence) {
    if (evidence.applyTarget && text.includes(evidence.applyTarget)) {
        return text.replace(evidence.applyTarget, `[${getBlockTypeLabel(evidence.blockKind)}位置]`);
    }

    return text;
}

function removeKnownBlocks(text, evidence) {
    let result = String(text || '');
    const targets = [...(evidence?.targets || [])].sort((a, b) => b.start - a.start);

    for (const target of targets) {
        if (target.missing) {
            continue;
        }

        const placeholder = `[第${target.ordinal}个${target.label}位置]`;
        if (result.slice(target.start, target.end) === target.text) {
            result = `${result.slice(0, target.start)}${placeholder}${result.slice(target.end)}`;
        } else if (target.text && result.includes(target.text)) {
            result = result.replace(target.text, placeholder);
        }
    }

    return result;
}

function getBlockSpecificRules(blockKind) {
    if (blockKind === 'options') {
        return [
            '选项栏只能给出当前情境下自然可选的行动或回应，不要剧透结果，不要替用户决定已经发生的后果。',
            '如果旧选项仍可用，优先保留旧选项的含义，只修复结构、措辞或缺失标签。',
        ];
    }

    if (blockKind === 'physiology') {
        return [
            '生理系统里的数值、症状、状态和变化必须有旧块或上下文依据；无法确定就保持旧值或写“未知/无”。',
            '不要凭空新增伤势、病症、体力变化、计量数值或身体结论。',
        ];
    }

    if (blockKind === 'status') {
        return [
            '状态栏里的地点、时间、人物状态、装备、关系、数值和剧情进展必须有证据；无法确定就保持旧值或写“未知”。',
        ];
    }

    return [
        '结构块中的字段值必须来自旧块、当前回复或最近上下文；无法确定就保持旧值或写“未知”。',
    ];
}

function buildStatusPrompt(active, instruction, sourceText) {
    const settings = getSettings();
    const evidence = prepareStatusEvidence(active, instruction, sourceText);
    const contextText = removeKnownStatusBlock(getMessageText(active.messageId), evidence);

    runtime.active.statusEvidence = evidence;

    return [
        '你正在修复或按证据更新一段状态栏。',
        '硬性规则：',
        '1. 你只能使用提供的正文、旧状态栏、最近上下文、历史样例、模板和用户额外要求。',
        '2. 不要新增模板中不存在的字段，不要改变字段顺序。',
        '3. 无法从证据确定的字段，保持旧值；如果没有旧值，写“未知”。',
        '4. 不要编造地点、时间、人物状态、数值、好感度、装备、关系变化或剧情进展。',
        '5. 只输出状态栏本体，不要解释，不要输出代码围栏。',
        '',
        `状态栏开始标记：${settings.statusStart || '未配置'}`,
        `状态栏结束标记：${settings.statusEnd || '未配置'}`,
        `用户额外要求：${instruction || '无'}`,
        '',
        '状态栏模板：',
        evidence.template || '无',
        '',
        '历史正常状态栏样例：',
        evidence.previousExamples.length ? evidence.previousExamples.join('\n\n---\n\n') : '无',
        '',
        '旧状态栏或坏掉的状态栏证据：',
        evidence.targetBlock || '无',
        '',
        '最近上下文：',
        buildRecentContext(active.messageId, settings),
        '',
        '当前回复正文参考：',
        trimText(contextText, settings.contextLength, true),
    ].join('\n');
}

function buildBlockPrompt(active, instruction, sourceText) {
    if (getSelectedBlockIndexes().length > 1) {
        return buildMultiBlockPrompt(active, instruction);
    }

    const settings = getSettings();
    const evidence = prepareBlockEvidence(active, instruction, sourceText);
    const contextText = removeKnownBlock(getMessageText(active.messageId), evidence);
    const label = getBlockTypeLabel(evidence.blockKind);
    const isMissingInsert = evidence.applyMode === 'insert_missing';
    const targetLabel = evidence.label || label;

    runtime.active.blockEvidence = evidence;

    return [
        isMissingInsert
            ? `当前回复缺失一段${targetLabel}，你需要按本聊天记录的基准格式补回这一块。`
            : `你正在修复或按证据更新一段${label}。`,
        '硬性规则：',
        '1. 只输出这个结构块本体，不要解释，不要标题，不要代码围栏。',
        '2. “预设/正则/世界书格式证据”只用于确认外层标签、HTML/class、字段顺序、按钮宏和排版格式，不能当成当前剧情事实。',
        '3. “旧结构块/当前回复/最近上下文”才是字段值和状态变化的事实依据。',
        '4. 如果旧结构块标签缺失、HTML/括号未闭合或渲染破碎，必须按旧字段、旧样式和格式证据重建一个完整可渲染的块，不要原样复读坏掉的源码。',
        '5. 不要新增模板中不存在的字段，不要改变字段顺序。',
        '6. 无法从证据确定的字段，保持旧值；如果没有旧值，写“未知”或“无”。',
        '7. 不要编造地点、时间、人物状态、数值、装备、关系变化、身体变化或剧情进展。',
        '8. 模板里的 {{divlist}}、{{button}} 等宏必须按原样输出，不要解释成文字。',
        ...(isMissingInsert ? ['9. 当前目标块在本回复中缺失；聊天基准样例只能当格式和旧字段参考，字段值必须来自当前回复正文、最近上下文和用户额外要求。'] : []),
        ...getBlockSpecificRules(evidence.blockKind).map((rule, index) => `${index + (isMissingInsert ? 10 : 9)}. ${rule}`),
        '',
        `块类型：${targetLabel}`,
        `用户额外要求：${instruction || '无'}`,
        '',
        '预设/正则/世界书格式证据（只当格式，不当事实）：',
        evidence.template || '无',
        '',
        '历史正常结构块样例（优先当格式参考，不能凭空复制旧数值）：',
        evidence.previousExamples.length ? evidence.previousExamples.join('\n\n---\n\n') : '无',
        '',
        isMissingInsert ? '聊天基准样例（当前回复缺失此块，只当格式和旧字段参考）：' : '旧结构块或坏掉的结构块证据：',
        evidence.targetBlock || '无',
        '',
        '最近上下文：',
        buildRecentContext(active.messageId, settings),
        '',
        '当前回复正文参考：',
        trimText(contextText, settings.contextLength, true),
    ].join('\n');
}

function buildMultiBlockPrompt(active, instruction) {
    const settings = getSettings();
    const evidence = prepareMultiBlockEvidence(active, instruction);
    const contextText = removeKnownBlocks(getMessageText(active.messageId), evidence);
    const blockList = evidence.targets
        .map(target => [
            `第 ${target.ordinal} 个块：${target.label}`,
            `来源：${target.source}`,
            `当前状态：${target.missing ? '缺失，将按聊天基准顺序补回' : '当前回复中存在，将替换原块'}`,
            `块类型：${getBlockTypeLabel(target.blockKind)}`,
            `输出开始标记：${target.startMarker}`,
            `输出结束标记：${target.endMarker}`,
            target.missing ? '聊天基准样例（当前回复缺失此块，只当格式和旧字段参考）：' : '旧结构块或坏掉的结构块证据：',
            target.text,
        ].join('\n'))
        .join('\n\n---\n\n');
    const markerList = evidence.targets
        .map(target => `${target.startMarker}\n第 ${target.ordinal} 个修复后的结构块本体\n${target.endMarker}`)
        .join('\n\n');
    const specificRules = evidence.targets
        .flatMap(target => getBlockSpecificRules(target.blockKind).map(rule => `${target.label}：${rule}`));

    runtime.active.blockEvidence = evidence;

    return [
        `你正在一次修复 ${evidence.targets.length} 个结构块。`,
        '硬性规则：',
        `1. 必须输出 ${evidence.targets.length} 个修复后的结构块，每个结构块都要放在指定的输出开始/结束标记之间。`,
        '2. 每个输出标记之间只能放对应结构块本体，不要解释，不要标题，不要代码围栏，不要合并多个块。',
        '3. “预设/正则/世界书格式证据”只用于确认外层标签、HTML/class、字段顺序、按钮宏和排版格式，不能当成当前剧情事实。',
        '4. “旧结构块/当前回复/最近上下文”才是字段值和状态变化的事实依据。',
        '5. 如果旧结构块标签缺失、HTML/括号未闭合或渲染破碎，必须按旧字段、旧样式和格式证据重建完整可渲染的块，不要原样复读坏掉的源码。',
        '6. 不要新增模板中不存在的字段，不要改变字段顺序。',
        '7. 无法从证据确定的字段，保持旧值；如果没有旧值，写“未知”或“无”。',
        '8. 不要编造地点、时间、人物状态、数值、装备、关系变化、身体变化或剧情进展。',
        '9. 模板里的 {{divlist}}、{{button}} 等宏必须按原样输出，不要解释成文字。',
        ...(evidence.targets.some(target => target.missing) ? ['10. 对缺失块，聊天基准样例只能当格式和旧字段参考，字段值必须来自当前回复正文、最近上下文和用户额外要求。'] : []),
        ...specificRules.map((rule, index) => `${index + (evidence.targets.some(target => target.missing) ? 11 : 10)}. ${rule}`),
        '',
        `用户额外要求：${instruction || '无'}`,
        '',
        '输出格式必须严格类似：',
        markerList,
        '',
        '预设/正则/世界书格式证据（只当格式，不当事实）：',
        evidence.template || '无',
        '',
        '历史正常结构块样例（优先当格式参考，不能凭空复制旧数值）：',
        evidence.previousExamples.length ? evidence.previousExamples.join('\n\n---\n\n') : '无',
        '',
        '本次要分别修复的旧结构块：',
        blockList,
        '',
        '最近上下文：',
        buildRecentContext(active.messageId, settings),
        '',
        '当前回复正文参考（已用占位符隐藏被修复块）：',
        trimText(contextText, settings.contextLength, true),
    ].join('\n');
}

function buildFormatPrompt(active, instruction, sourceText) {
    return [
        '你正在修复一段文本格式。',
        '严格规则：',
        '1. 只修复 XML、JSON、Markdown、标签闭合、括号、缩进或多余解释等格式问题。',
        '2. 不改写剧情，不新增情节，不改变角色语气和文本顺序。',
        '3. 只输出修复后的文本，不要解释，不要代码围栏。',
        '',
        `用户额外要求：${instruction || '无'}`,
        '',
        '待修复文本：',
        sourceText || active.selectedText || getMessageText(active.messageId),
    ].join('\n');
}

function buildPromptForActive() {
    if (!runtime.active) {
        throw new Error('没有正在处理的消息。');
    }

    const mode = document.getElementById('rr-mode')?.value || getSettings().defaultMode;
    const rawInstruction = String(document.getElementById('rr-instruction')?.value || '').trim();
    const instruction = composeInstructionForActive(mode, rawInstruction);
    const sourceText = String(document.getElementById('rr-source')?.value || '').trim();
    runtime.active.mode = mode;
    runtime.active.statusEvidence = null;
    runtime.active.blockEvidence = null;

    switch (mode) {
        case 'continue_tail':
            return buildContinuePrompt(runtime.active, instruction, sourceText);
        case 'rewrite_selection':
            if (!runtime.active.selectedText) {
                throw new Error('请先在助手消息里选中要重写的片段。');
            }
            return buildRewritePrompt(runtime.active, instruction, sourceText);
        case 'repair_block':
            return buildBlockPrompt(runtime.active, instruction, sourceText);
        case 'repair_statebar':
            return buildStatusPrompt(runtime.active, instruction, sourceText);
        case 'repair_format':
            return buildFormatPrompt(runtime.active, instruction, sourceText);
        default:
            throw new Error('未知急救模式。');
    }
}

function normalizeStatusOutput(output) {
    const settings = getSettings();
    const value = stripWrappingCodeFence(output);
    const start = settings.statusStart;
    const end = settings.statusEnd;

    if (!start || !end) {
        return value;
    }

    const hasStart = value.includes(start);
    const hasEnd = value.includes(end);

    if (hasStart && hasEnd) {
        return value;
    }

    if (!hasStart && !hasEnd) {
        return `${start}\n${value}\n${end}`;
    }

    throw new Error('模型返回的状态栏标记不完整，已拒绝应用。');
}

function normalizeBlockOutput(output, evidence) {
    const value = stripWrappingCodeFence(output);
    const [start, end] = evidence?.markerPair || [];

    if (!start || !end) {
        return value;
    }

    const hasStart = value.includes(start);
    const hasEnd = value.includes(end);

    if (hasStart && hasEnd) {
        return value;
    }

    if (!hasStart && !hasEnd) {
        return `${start}\n${value}\n${end}`;
    }

    throw new Error(`模型返回的${getBlockTypeLabel(evidence?.blockKind)}标记不完整，已拒绝应用。`);
}

function parseMultiBlockPreview(output, evidence) {
    const value = stripWrappingCodeFence(output);
    const targets = evidence?.targets || [];
    if (!targets.length) {
        throw new Error('没有可解析的多选结构块目标。');
    }

    const replacements = targets.map((target) => {
        const startIndex = value.indexOf(target.startMarker);
        if (startIndex === -1) {
            throw new Error(`模型没有返回第 ${target.ordinal} 个块的开始标记，已拒绝应用。`);
        }

        const contentStart = startIndex + target.startMarker.length;
        const endIndex = value.indexOf(target.endMarker, contentStart);
        if (endIndex === -1) {
            throw new Error(`模型没有返回第 ${target.ordinal} 个块的结束标记，已拒绝应用。`);
        }

        const rawText = value.slice(contentStart, endIndex).trim();
        if (!rawText) {
            throw new Error(`第 ${target.ordinal} 个块的修复结果为空，已拒绝应用。`);
        }

        return {
            target,
            text: normalizeBlockOutput(rawText, target),
        };
    });

    return {
        type: 'multi_block_replacements',
        replacements,
    };
}

function normalizeMultiBlockOutput(output, evidence) {
    const payload = parseMultiBlockPreview(output, evidence);
    return payload.replacements
        .map(({ target, text }) => `${target.startMarker}\n${text}\n${target.endMarker}`)
        .join('\n\n');
}

function getPreviewTextForApply() {
    const preview = String(document.getElementById('rr-preview')?.value || '').trim();
    if (!preview) {
        throw new Error('修复预览为空，不能应用。');
    }

    if (runtime.active?.mode === 'repair_statebar') {
        return normalizeStatusOutput(preview);
    }

    if (runtime.active?.mode === 'repair_block') {
        const evidence = runtime.active.blockEvidence || (
            getSelectedBlockIndexes().length > 1
                ? prepareMultiBlockEvidence(runtime.active, '')
                : prepareBlockEvidence(runtime.active, '', document.getElementById('rr-source')?.value || '')
        );
        runtime.active.blockEvidence = evidence;
        if (evidence.applyMode === 'replace_multiple_blocks') {
            return parseMultiBlockPreview(preview, evidence);
        }

        return normalizeBlockOutput(preview, evidence);
    }

    return stripWrappingCodeFence(preview);
}

function buildRepairedMessageText(active, replacementText) {
    const currentText = getMessageText(active.messageId);

    switch (active.mode) {
        case 'continue_tail':
            return `${currentText}${currentText.endsWith('\n') || replacementText.startsWith('\n') ? '' : '\n'}${replacementText}`;
        case 'rewrite_selection': {
            const range = locateRawSelectionRange(currentText, active.selectedText, active.selectionRange || {});
            if (!range) {
                throw new Error('原选区已经不在当前回复里，不能安全替换。');
            }

            active.selectionRange = {
                rawStart: range.start,
                rawEnd: range.end,
                selectedRawText: range.text,
                normalizedStart: active.selectionRange?.normalizedStart ?? -1,
            };

            return `${currentText.slice(0, range.start)}${replacementText}${currentText.slice(range.end)}`;
        }
        case 'repair_format': {
            if (active.selectedText) {
                const range = locateRawSelectionRange(currentText, active.selectedText, active.selectionRange || {});
                if (!range) {
                    throw new Error('原选区已经不在当前回复里，不能安全替换。');
                }

                return `${currentText.slice(0, range.start)}${replacementText}${currentText.slice(range.end)}`;
            }

            return replacementText;
        }
        case 'repair_statebar': {
            const evidence = active.statusEvidence || prepareStatusEvidence(active, '', document.getElementById('rr-source')?.value || '');

            if (evidence.applyMode === 'replace_selection' || evidence.applyMode === 'replace_manual' || evidence.applyMode === 'replace_block') {
                const range = resolveCurrentBlockRange(currentText, {
                    text: evidence.applyTarget,
                    start: evidence.applyStart,
                    end: evidence.applyEnd,
                }, '状态栏');
                return `${currentText.slice(0, range.start)}${replacementText}${currentText.slice(range.end)}`;
            }

            if (evidence.applyMode === 'append_new') {
                if (!getSettings().allowNewStatusbar) {
                    throw new Error('未开启无旧块追加状态栏，不能应用。');
                }

                return `${currentText.trimEnd()}\n\n${replacementText}`;
            }

            throw new Error('没有可用的状态栏应用方式。');
        }
        case 'repair_block': {
            const evidence = active.blockEvidence || (
                replacementText?.type === 'multi_block_replacements' || getSelectedBlockIndexes().length > 1
                    ? prepareMultiBlockEvidence(active, '')
                    : prepareBlockEvidence(active, '', document.getElementById('rr-source')?.value || '')
            );

            if (evidence.applyMode === 'replace_multiple_blocks') {
                const payload = replacementText?.type === 'multi_block_replacements'
                    ? replacementText
                    : parseMultiBlockPreview(String(replacementText || ''), evidence);
                let result = currentText;

                const existingReplacements = payload.replacements.filter(({ target }) => !target.missing);
                const missingReplacements = payload.replacements.filter(({ target }) => target.missing);

                for (const { target, text } of [...existingReplacements].sort((a, b) => b.target.start - a.target.start)) {
                    const range = resolveCurrentBlockRange(result, target, target.label || '结构块');
                    result = `${result.slice(0, range.start)}${text}${result.slice(range.end)}`;
                }

                for (const { target, text } of [...missingReplacements].sort((a, b) => {
                    const aOrder = Number.isInteger(a.target.baselineIndex) ? a.target.baselineIndex : Number.MAX_SAFE_INTEGER;
                    const bOrder = Number.isInteger(b.target.baselineIndex) ? b.target.baselineIndex : Number.MAX_SAFE_INTEGER;
                    return aOrder - bOrder || a.target.ordinal - b.target.ordinal;
                })) {
                    const insertAt = resolveMissingBlockInsertIndexInText(result, target, evidence);
                    result = insertBlockAtPosition(result, text, insertAt);
                }

                return result;
            }

            if (evidence.applyMode === 'insert_missing') {
                const insertAt = resolveMissingBlockInsertIndexInText(currentText, evidence, evidence);
                return insertBlockAtPosition(currentText, replacementText, insertAt);
            }

            if (evidence.applyMode === 'replace_recognized') {
                const range = resolveCurrentBlockRange(currentText, {
                    text: evidence.applyTarget,
                    start: evidence.applyStart,
                    end: evidence.applyEnd,
                }, getBlockTypeLabel(evidence.blockKind));
                return `${currentText.slice(0, range.start)}${replacementText}${currentText.slice(range.end)}`;
            }

            if (evidence.applyMode === 'replace_selection' || evidence.applyMode === 'replace_manual' || evidence.applyMode === 'replace_block') {
                const range = resolveCurrentBlockRange(currentText, {
                    text: evidence.applyTarget,
                    start: evidence.applyStart,
                    end: evidence.applyEnd,
                }, getBlockTypeLabel(evidence.blockKind));
                return `${currentText.slice(0, range.start)}${replacementText}${currentText.slice(range.end)}`;
            }

            if (evidence.applyMode === 'append_new') {
                if (!canAppendNewBlock(evidence.selectedBlockKind, getSettings())) {
                    throw new Error('未开启无旧块追加结构块，不能应用。');
                }

                return `${currentText.trimEnd()}\n\n${replacementText}`;
            }

            throw new Error('没有可用的结构块应用方式。');
        }
        default:
            throw new Error('未知急救模式。');
    }
}

async function writeMessageText(messageId, nextText) {
    const message = getCurrentMessage(messageId);
    if (!message) {
        throw new Error('目标助手消息不存在。');
    }

    const text = String(nextText ?? '');
    message.mes = text;

    if (!message.extra || typeof message.extra !== 'object') {
        message.extra = {};
    }
    delete message.extra.display_text;

    if (message.swipe_id !== undefined || Array.isArray(message.swipes)) {
        ensureSwipes(message);
        const swipeId = Number.isInteger(message.swipe_id) && message.swipe_id >= 0 ? message.swipe_id : 0;
        message.swipe_id = swipeId;
        message.swipes[swipeId] = text;
    }

    chat_metadata.tainted = true;
    updateMessageBlock(messageId, message, { rerenderMessage: true });
    await eventSource.emit(event_types.MESSAGE_UPDATED, messageId);
    await saveChatConditional();
    scheduleButtonRefresh();
}

function getSelectedDeletableBlocks(blocks = getSelectedRecognizedBlocks()) {
    return blocks.filter(block => !block?.isMissing
        && Number.isInteger(block.start)
        && Number.isInteger(block.end)
        && block.start >= 0
        && block.end > block.start
        && String(block.text || '').trim());
}

function resolveDeletionRanges(currentText, blocks) {
    const ranges = blocks
        .map((block) => {
            const range = resolveCurrentBlockRange(currentText, {
                text: block.text,
                start: block.start,
                end: block.end,
            }, block.label || '结构块');

            return {
                ...range,
                label: block.label || '结构块',
            };
        })
        .sort((a, b) => a.start - b.start || b.end - a.end);

    for (let index = 1; index < ranges.length; index += 1) {
        const previous = ranges[index - 1];
        const current = ranges[index];
        if (current.start < previous.end) {
            throw new Error('选中的块互相重叠或存在包含关系；请只选最外层块，或只选彼此独立的块。');
        }
    }

    return ranges;
}

function deleteRangesFromText(text, ranges) {
    let result = String(text || '');
    for (const range of [...ranges].sort((a, b) => b.start - a.start)) {
        const before = result.slice(0, range.start).replace(/[ \t]+$/u, '');
        const after = result.slice(range.end).replace(/^[ \t]+/u, '');
        const separator = before && after && !before.endsWith('\n') && !after.startsWith('\n') ? '\n' : '';
        result = `${before}${separator}${after}`;
    }

    return result
        .replace(/[ \t]+\n/gu, '\n')
        .replace(/\n{3,}/gu, '\n\n')
        .trimEnd();
}

async function deleteSelectedRecognizedBlocks() {
    const button = document.getElementById('rr-delete-blocks');
    const status = document.getElementById('rr-modal-status');

    try {
        if (!runtime.active || runtime.active.mode !== 'repair_block') {
            throw new Error('请先打开识别块 UI。');
        }

        const selectedBlocks = getSelectedRecognizedBlocks();
        if (!selectedBlocks.length) {
            throw new Error('请先在左侧选择要删除的块。');
        }

        const deletableBlocks = getSelectedDeletableBlocks(selectedBlocks);
        if (!deletableBlocks.length) {
            throw new Error('选中的都是缺失占位，没有当前回复原文可删除。');
        }

        const skippedCount = selectedBlocks.length - deletableBlocks.length;
        const confirmText = skippedCount
            ? `确定删除 ${deletableBlocks.length} 个当前存在的块？另外 ${skippedCount} 个缺失占位会被跳过。`
            : `确定删除选中的 ${deletableBlocks.length} 个块？`;
        if (!window.confirm(confirmText)) {
            return;
        }

        if (button) {
            button.disabled = true;
        }

        const before = getMessageText(runtime.active.messageId);
        const ranges = resolveDeletionRanges(before, deletableBlocks);
        const after = deleteRangesFromText(before, ranges);
        if (after === before) {
            throw new Error('删除后内容没有变化，已取消操作。');
        }

        runtime.undoStack.push({
            messageId: runtime.active.messageId,
            before,
            after,
            mode: 'delete_blocks',
            time: new Date().toISOString(),
        });
        runtime.undoStack = runtime.undoStack.slice(-MAX_UNDO_RECORDS);

        await writeMessageText(runtime.active.messageId, after);
        resetRecognizedBlockSelection();
        renderRecognizedBlocks(-1);

        const message = skippedCount
            ? `已删除 ${ranges.length} 个当前存在的块；${skippedCount} 个缺失占位已跳过。`
            : `已删除 ${ranges.length} 个选中块。`;
        if (status) {
            status.textContent = message;
        }
        notify('success', message);
    } catch (error) {
        const message = error?.message || String(error);
        if (status) {
            status.textContent = message;
        }
        notify('error', message);
    } finally {
        updateDeleteSelectedBlocksButton();
    }
}

function getActiveApiPreset(settings = getSettings()) {
    return settings.apiPresets.find(preset => preset.id === settings.activeApiPresetId) || settings.apiPresets[0];
}

function getAuthHeaderValue(apiKey) {
    const value = String(apiKey || '').trim();
    if (!value) {
        return '';
    }

    return /^(Bearer|Basic)\s+/iu.test(value) ? value : `Bearer ${value}`;
}

function normalizeApiBaseUrl(baseUrl) {
    const value = String(baseUrl || '').trim().replace(/\/+$/u, '');
    if (!value) {
        throw new Error('请先填写独立 API 地址。');
    }

    return value.replace(/\/(?:chat\/completions|completions|models)$/iu, '');
}

function buildIndependentApiEndpoint(baseUrl, endpoint) {
    return `${normalizeApiBaseUrl(baseUrl)}/${endpoint.replace(/^\/+/u, '')}`;
}

function buildIndependentApiHeaders(preset, includeJson = false) {
    const headers = {};
    const auth = getAuthHeaderValue(preset?.apiKey);
    if (auth) {
        headers.Authorization = auth;
    }
    if (includeJson) {
        headers['Content-Type'] = 'application/json';
    }

    return headers;
}

async function parseApiErrorResponse(response) {
    const fallback = `${response.status} ${response.statusText}`.trim();
    let body = '';
    try {
        body = await response.text();
    } catch {
        return fallback;
    }

    if (!body) {
        return fallback;
    }

    try {
        const json = JSON.parse(body);
        return json?.error?.message || json?.message || json?.detail || body.slice(0, 500);
    } catch {
        return body.slice(0, 500);
    }
}

function extractIndependentModels(data) {
    const source = Array.isArray(data?.data)
        ? data.data
        : Array.isArray(data?.models)
            ? data.models
            : Array.isArray(data)
                ? data
                : [];

    return sanitizeModelList(source);
}

async function fetchIndependentApiModels(preset) {
    if (!preset?.baseUrl) {
        throw new Error('请先填写独立 API 地址。');
    }

    const url = buildIndependentApiEndpoint(preset.baseUrl, 'models');
    let response;
    try {
        response = await fetch(url, {
            method: 'GET',
            headers: buildIndependentApiHeaders(preset),
        });
    } catch (error) {
        if (error instanceof TypeError) {
            throw new Error('无法连接独立 API。请检查 URL，或确认该接口允许浏览器跨域请求（CORS）。');
        }
        throw error;
    }

    if (!response.ok) {
        throw new Error(`识别模型失败：${await parseApiErrorResponse(response)}`);
    }

    const data = await response.json();
    const models = extractIndependentModels(data);
    if (!models.length) {
        throw new Error('接口已响应，但没有识别到可用模型。请确认它兼容 /models 格式。');
    }

    return models;
}

function extractTextFromContentParts(content) {
    if (typeof content === 'string') {
        return content;
    }

    if (!Array.isArray(content)) {
        return '';
    }

    return content
        .map(part => typeof part === 'string' ? part : part?.text || part?.content || '')
        .join('');
}

function extractIndependentApiText(data) {
    const choice = Array.isArray(data?.choices) ? data.choices[0] : null;
    const chatText = extractTextFromContentParts(choice?.message?.content);
    if (chatText) {
        return chatText;
    }

    if (typeof choice?.text === 'string') {
        return choice.text;
    }

    if (typeof data?.output_text === 'string') {
        return data.output_text;
    }

    if (Array.isArray(data?.output)) {
        return data.output
            .flatMap(item => Array.isArray(item?.content) ? item.content : [])
            .map(part => part?.text || part?.content || '')
            .join('');
    }

    return '';
}

async function generateWithIndependentApi(prompt, settings = getSettings()) {
    const preset = getActiveApiPreset(settings);
    if (!preset?.baseUrl) {
        throw new Error('请先在回复救急插件设置里填写独立 API 地址。');
    }
    if (!preset.model) {
        throw new Error('请先识别并选择一个可用模型。');
    }

    const url = buildIndependentApiEndpoint(preset.baseUrl, 'chat/completions');
    const body = {
        model: preset.model,
        messages: [
            {
                role: 'system',
                content: '你是一个只按要求修复既有回复片段的助手。必须依据用户提供的预设、世界书、正则、上下文和原文证据；不要解释，不要新增无依据事实，不要胡编乱造。',
            },
            {
                role: 'user',
                content: prompt,
            },
        ],
        temperature: clampNumber(preset.temperature, 0.7, 0, 2),
        max_tokens: clampInteger(preset.maxTokens, settings.responseLength, 80, RESPONSE_LENGTH_MAX),
        stream: false,
    };

    let response;
    try {
        response = await fetch(url, {
            method: 'POST',
            headers: buildIndependentApiHeaders(preset, true),
            body: JSON.stringify(body),
        });
    } catch (error) {
        if (error instanceof TypeError) {
            throw new Error('无法连接独立 API。请检查 URL，或确认该接口允许浏览器跨域请求（CORS）。');
        }
        throw error;
    }

    if (!response.ok) {
        throw new Error(`独立 API 生成失败：${await parseApiErrorResponse(response)}`);
    }

    const data = await response.json();
    const text = extractIndependentApiText(data).trim();
    if (!text) {
        throw new Error('独立 API 返回了空内容，已拒绝预览。');
    }

    return text;
}

async function generateRepairOutput(prompt) {
    const settings = getSettings();
    if (settings.generationSource === 'independent') {
        return generateWithIndependentApi(prompt, settings);
    }

    return generateRaw({
        prompt,
        responseLength: settings.responseLength,
        trimNames: true,
    });
}

function getGenerationStatusText() {
    const settings = getSettings();
    if (settings.generationSource !== 'independent') {
        return '正在调用当前酒馆配置的模型...';
    }

    const preset = getActiveApiPreset(settings);
    return `正在调用独立 API：${preset?.name || '未命名预设'}...`;
}

async function generatePreview() {
    const button = document.getElementById('rr-generate');
    const preview = document.getElementById('rr-preview');
    const status = document.getElementById('rr-modal-status');

    try {
        if (!runtime.active) {
            throw new Error('没有正在处理的消息。');
        }

        const prompt = buildPromptForActive();
        button.disabled = true;
        status.textContent = getGenerationStatusText();
        preview.value = '';

        const output = await generateRepairOutput(prompt);
        let clean = stripWrappingCodeFence(output);
        if (runtime.active.mode === 'repair_statebar') {
            clean = normalizeStatusOutput(output);
        } else if (runtime.active.mode === 'repair_block') {
            clean = runtime.active.blockEvidence?.applyMode === 'replace_multiple_blocks'
                ? normalizeMultiBlockOutput(output, runtime.active.blockEvidence)
                : normalizeBlockOutput(output, runtime.active.blockEvidence);
        }

        if (!clean.trim()) {
            throw new Error('模型返回了空内容，已拒绝预览。');
        }

        preview.value = clean;
        if (runtime.active.blockEvidence?.applyMode === 'replace_multiple_blocks') {
            const missingCount = runtime.active.blockEvidence.targets.filter(target => target.missing).length;
            status.textContent = missingCount
                ? `已生成 ${runtime.active.blockEvidence.targets.length} 个块的预览，其中 ${missingCount} 个缺失块会按聊天基准顺序插回。`
                : `已生成 ${runtime.active.blockEvidence.targets.length} 个块的预览。确认无误后会分别替换这些原始块。`;
        } else if (runtime.active.blockEvidence?.applyMode === 'insert_missing') {
            status.textContent = '已生成缺失块预览。确认无误后会按聊天基准顺序插回当前回复。';
        } else {
            status.textContent = '已生成预览。确认无误后再应用到当前回复。';
        }
    } catch (error) {
        const message = error?.message || String(error);
        status.textContent = message;
        notify('error', message);
    } finally {
        button.disabled = false;
    }
}

async function applyPreview() {
    try {
        if (!runtime.active) {
            throw new Error('没有正在处理的消息。');
        }

        const replacementText = getPreviewTextForApply();
        const before = getMessageText(runtime.active.messageId);
        const after = buildRepairedMessageText(runtime.active, replacementText);

        if (!after.trim()) {
            throw new Error('应用后的回复为空，已拒绝。');
        }

        if (after === before) {
            throw new Error('修复结果和原文一致，没有可应用的变化。');
        }

        runtime.undoStack.push({
            messageId: runtime.active.messageId,
            before,
            after,
            mode: runtime.active.mode,
            time: new Date().toISOString(),
        });
        runtime.undoStack = runtime.undoStack.slice(-MAX_UNDO_RECORDS);

        await writeMessageText(runtime.active.messageId, after);
        if (runtime.active?.mode === 'repair_block') {
            renderRecognizedBlocks(runtime.selectedBlockIndex);
        }
        document.getElementById('rr-modal-status').textContent = '已应用到当前回复，可用“撤销上次急救”恢复。';
        notify('success', '已应用急救结果。');
    } catch (error) {
        const message = error?.message || String(error);
        document.getElementById('rr-modal-status').textContent = message;
        notify('error', message);
    }
}

async function undoLastRepair() {
    try {
        const record = runtime.undoStack.pop();
        if (!record) {
            throw new Error('没有可撤销的急救记录。');
        }

        await writeMessageText(record.messageId, record.before);
        document.getElementById('rr-modal-status').textContent = '已撤销上次急救。';
        notify('success', '已撤销上次急救。');
    } catch (error) {
        const message = error?.message || String(error);
        notify('error', message);
    }
}

function refreshModalSource() {
    if (!runtime.active) {
        return;
    }

    const mode = document.getElementById('rr-mode')?.value || getSettings().defaultMode;
    const source = mode === 'repair_block' ? { text: '', warning: '' } : getSourceForMode(runtime.active, mode);
    const sourceElement = document.getElementById('rr-source');
    const warningElement = document.getElementById('rr-source-warning');
    const previewElement = document.getElementById('rr-preview');
    const titleElement = document.getElementById('rr-target-title');
    const modeHelpElement = document.getElementById('rr-mode-help');
    const sourceHelpElement = document.getElementById('rr-source-help');
    const instructionElement = document.getElementById('rr-instruction');
    const instructionHelpElement = document.getElementById('rr-instruction-help');
    const modalElement = document.getElementById('rr-modal');
    const statebarTools = document.getElementById('rr-statebar-tools');
    const blockTools = document.getElementById('rr-block-tools');
    const selectionPanel = document.getElementById('rr-selection-panel');
    const blockWorkspace = document.getElementById('rr-block-workspace');
    const isStatebarMode = false;
    const isBlockMode = mode === 'repair_block';
    const isSelectionMode = mode === 'rewrite_selection';

    runtime.active.mode = mode;
    runtime.active.statusEvidence = null;
    runtime.active.blockEvidence = null;
    if (modalElement) {
        modalElement.classList.toggle('rr-mode-selection', isSelectionMode);
        modalElement.classList.toggle('rr-mode-block', isBlockMode);
    }
    titleElement.textContent = isBlockMode ? '块原文' : '选中片段';
    if (modeHelpElement) {
        modeHelpElement.textContent = modeDescriptions[mode] || '';
    }
    if (sourceHelpElement) {
        sourceHelpElement.textContent = isBlockMode
            ? '这里是从原始消息里安全定位到的块；应用时只替换这段原文。'
            : '这里只处理你选中的正文片段。';
    }
    if (instructionElement) {
        instructionElement.placeholder = isBlockMode
            ? '例如：把体力改成 60，其他字段不动；或：重新生成这个块，但保留原字段顺序和样式。'
            : '例如：语气更温柔一点；或：把这段改短，但保留原本事实。';
    }
    if (instructionHelpElement) {
        instructionHelpElement.textContent = isBlockMode
            ? '直接写要怎么改；预设、世界书和正则只作格式线索，当前回复和上下文才作事实依据。'
            : '只替换选中的正文，不会改动状态栏、选项栏或其他结构块。';
    }
    if (statebarTools) {
        statebarTools.hidden = !isStatebarMode;
    }
    if (blockTools) {
        blockTools.hidden = true;
    }
    if (selectionPanel) {
        selectionPanel.hidden = !isSelectionMode;
    }
    if (blockWorkspace) {
        blockWorkspace.hidden = !isBlockMode;
    }
    sourceElement.readOnly = isBlockMode;
    sourceElement.value = source.text;
    warningElement.textContent = source.warning || '';
    previewElement.value = '';
    document.getElementById('rr-modal-status').textContent = '';

    if (isBlockMode) {
        renderRecognizedBlocks(runtime.selectedBlockIndex);
        if (!getCurrentTemplateEvidenceText()) {
            void refreshBlockTemplateEvidence({ silent: true });
        }
    } else {
        runtime.recognizedBlocks = [];
        resetRecognizedBlockSelection();
        runtime.active.selectedBlockKind = 'auto';
    }
    updateDeleteSelectedBlocksButton();
}

function setStatusSource(kind) {
    if (!runtime.active) {
        return;
    }

    const settings = getSettings();
    const currentText = getMessageText(runtime.active.messageId);
    const parsed = findStatusBlocks(currentText, settings);
    let source = null;

    if (kind === 'append') {
        source = {
            text: '',
            warning: settings.allowNewStatusbar
                ? '已改为追加新状态栏：会依据模板/历史样例/当前正文生成，无法确定的字段必须写未知。'
                : '当前未开启追加新状态栏。需要先在扩展设置里开启“允许无旧块时按模板/历史样例追加新状态栏”。',
        };
    } else if (kind === 'last_block') {
        const block = parsed.blocks[parsed.blocks.length - 1];
        source = block
            ? {
                text: block.text,
                warning: parsed.blocks.length > 1
                    ? '已抓取最后一个完整状态栏；应用时只替换这段原文。'
                    : '已抓取当前完整状态栏；应用时只替换这段原文。',
            }
            : findTailStatusCandidate(currentText, settings);
    } else if (kind === 'tail') {
        source = findTailStatusCandidate(currentText, settings);
    } else {
        const selectedText = runtime.active.selectedText || '';
        if (selectedLooksLikeStatusBlock(selectedText, settings) && currentText.includes(selectedText)) {
            source = {
                text: selectedText,
                warning: '已抓取当前选区；应用时只替换这段原文。',
            };
        } else if (parsed.blocks.length === 1) {
            source = {
                text: parsed.blocks[0].text,
                warning: '已抓取当前完整状态栏；应用时只替换这段原文。',
            };
        } else if (parsed.blocks.length > 1) {
            const block = parsed.blocks[parsed.blocks.length - 1];
            source = {
                text: block.text,
                warning: '检测到多个完整状态栏，已抓取最后一个；请确认它就是你要修的那块。',
            };
        } else {
            source = findBrokenStatusCandidate(currentText, settings) || findTailStatusCandidate(currentText, settings);
        }
    }

    if (!source) {
        source = {
            text: '',
            warning: '没有找到可抓取的状态栏片段。可以改为追加新状态栏，但必须有模板或历史样例。',
        };
    }

    runtime.active.statusEvidence = null;
    document.getElementById('rr-source').value = source.text;
    document.getElementById('rr-source-warning').textContent = source.warning || '';
    document.getElementById('rr-preview').value = '';
    document.getElementById('rr-modal-status').textContent = '';
}

function setBlockSource(kind) {
    if (!runtime.active) {
        return;
    }

    const settings = getSettings();
    const currentText = getMessageText(runtime.active.messageId);
    const blockKind = getSelectedBlockKind();
    const templateText = getCurrentTemplateEvidenceText();
    const parsed = findStructureBlocks(currentText, blockKind, settings, templateText);
    const label = getBlockTypeLabel(blockKind);
    let source = null;

    if (kind === 'append') {
        source = {
            text: '',
            warning: canAppendNewBlock(blockKind, settings)
                ? `已改为追加新${label}：会依据模板/历史样例/当前正文生成，无法确定的字段必须写未知或无。`
                : '当前未开启追加结构块。需要先在扩展设置里开启“允许结构块无旧块时追加”。',
        };
    } else if (kind === 'last_block') {
        const block = parsed.blocks[parsed.blocks.length - 1];
        source = block
            ? {
                text: block.text,
                warning: parsed.blocks.length > 1
                    ? `已抓取最后一个完整${label}；请确认它就是要修的那块。`
                    : `已抓取当前完整${label}；应用时只替换这段原文。`,
            }
            : findTailBlockCandidate(currentText, blockKind, settings, templateText);
    } else if (kind === 'tail') {
        source = findTailBlockCandidate(currentText, blockKind, settings, templateText);
    } else {
        source = getBlockSourceForMode(runtime.active, settings);
    }

    if (!source) {
        source = {
            text: '',
            warning: `没有找到可抓取的${label}片段。可以读取模板后追加新结构块，但必须有模板证据或历史样例。`,
        };
    }

    runtime.active.blockEvidence = null;
    document.getElementById('rr-source').value = source.text;
    document.getElementById('rr-source-warning').textContent = source.warning || '';
    document.getElementById('rr-preview').value = '';
    document.getElementById('rr-modal-status').textContent = '';
}

function formatSelectedBlocksSource(blocks) {
    if (blocks.length === 1) {
        return getBlockEvidenceText(blocks[0]);
    }

    return blocks
        .map(block => {
            const status = block.isMissing ? '缺失，显示聊天基准样例' : '当前回复原文';
            return `【${block.selectedIndex + 1}. ${block.label}｜${status}】\n${getBlockEvidenceText(block)}`;
        })
        .join('\n\n--- 回复救急分隔 ---\n\n');
}

function syncRecognizedBlockSelectionUi() {
    const selected = new Set(getSelectedBlockIndexes());
    document.querySelectorAll('.rr-block-item').forEach((item) => {
        const index = Number(item.dataset.index);
        const active = selected.has(index);
        item.classList.toggle('active', active);
        item.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
}

function updateDeleteSelectedBlocksButton() {
    const button = document.getElementById('rr-delete-blocks');
    if (!button) {
        return;
    }

    const selectedBlocks = runtime.active?.mode === 'repair_block' ? getSelectedRecognizedBlocks() : [];
    const deletableCount = getSelectedDeletableBlocks(selectedBlocks).length;
    const skippedCount = selectedBlocks.length - deletableCount;
    button.hidden = runtime.active?.mode !== 'repair_block';
    button.disabled = deletableCount <= 0;
    button.title = deletableCount
        ? skippedCount
            ? `删除选中的 ${deletableCount} 个当前存在的块；${skippedCount} 个缺失占位会跳过`
            : `删除选中的 ${deletableCount} 个块`
        : '先选择当前回复里真实存在的块；缺失占位不能删除';
}

function updateSelectedRecognizedBlocks({ refreshTemplates = false } = {}) {
    if (!runtime.active) {
        updateDeleteSelectedBlocksButton();
        return;
    }

    const blocks = getSelectedRecognizedBlocks();
    runtime.active.blockEvidence = null;
    syncRecognizedBlockSelectionUi();

    const sourceElement = document.getElementById('rr-source');
    const titleElement = document.getElementById('rr-target-title');
    const warningElement = document.getElementById('rr-source-warning');
    const previewElement = document.getElementById('rr-preview');
    const statusElement = document.getElementById('rr-modal-status');

    if (!blocks.length) {
        runtime.selectedBlockIndex = -1;
        runtime.active.selectedBlockKind = 'auto';
        if (sourceElement) {
            sourceElement.value = '';
        }
        if (titleElement) {
            titleElement.textContent = '块原文';
        }
        if (warningElement) {
            warningElement.textContent = '没有选中块；请先在左侧点选一个或多个识别结果。';
        }
        if (previewElement) {
            previewElement.value = '';
        }
        if (statusElement) {
            statusElement.textContent = '';
        }
        updateDeleteSelectedBlocksButton();
        return;
    }

    if (blocks.length === 1) {
        const block = blocks[0];
        const isMissing = Boolean(block.isMissing);
        runtime.selectedBlockIndex = block.selectedIndex;
        runtime.active.selectedBlockKind = isKnownBlockKind(block.blockKind) ? block.blockKind : 'custom';
        if (sourceElement) {
            sourceElement.value = getBlockEvidenceText(block);
        }
        if (titleElement) {
            titleElement.textContent = isMissing ? `${block.label} 缺失样例` : `${block.label} 原文`;
        }
        if (warningElement) {
            warningElement.textContent = isMissing
                ? `当前回复缺失第 ${block.selectedIndex + 1} 个块：${block.label}。这里显示的是聊天基准样例；应用时会按基准顺序插入到对应位置。`
                : `已选中第 ${block.selectedIndex + 1} 个块：${block.label}。应用时只替换这段原始消息文本。`;
        }
    } else {
        const missingCount = blocks.filter(block => block.isMissing).length;
        runtime.selectedBlockIndex = blocks[0].selectedIndex;
        runtime.active.selectedBlockKind = 'auto';
        if (sourceElement) {
            sourceElement.value = formatSelectedBlocksSource(blocks);
        }
        if (titleElement) {
            titleElement.textContent = `已选 ${blocks.length} 个块`;
        }
        if (warningElement) {
            warningElement.textContent = missingCount
                ? `已选择 ${blocks.length} 个块，其中 ${missingCount} 个当前缺失；生成预览会分别修复，应用时会替换已有块并把缺失块插回基准位置。`
                : `已选择 ${blocks.length} 个块；生成预览会按同一条要求分别修复，应用时只替换这些原始消息文本。`;
        }
    }

    if (previewElement) {
        previewElement.value = '';
    }
    if (statusElement) {
        statusElement.textContent = '';
    }
    updateDeleteSelectedBlocksButton();

    if (refreshTemplates) {
        runtime.active.blockTemplateCandidates = [];
        runtime.active.templateScanToken = 0;
        document.getElementById('rr-template-evidence').value = '';
        void refreshBlockTemplateEvidence({ silent: true });
    }
}

function toggleRecognizedBlockSelection(index, { refreshTemplates = false } = {}) {
    if (!runtime.active || !runtime.recognizedBlocks[index]) {
        return;
    }

    const selected = ensureSelectedBlockIndexSet();
    if (selected.has(index)) {
        selected.delete(index);
        runtime.selectedBlockIndex = getSelectedBlockIndexes()[0] ?? -1;
    } else {
        selected.add(index);
        runtime.selectedBlockIndex = index;
    }

    updateSelectedRecognizedBlocks({ refreshTemplates });
}

function renderRecognizedBlocks(preferredIndex = -1, { refreshTemplates = false } = {}) {
    const list = document.getElementById('rr-block-list');
    if (!runtime.active || !list) {
        return;
    }

    const previousSelectedKeys = new Set(
        getSelectedRecognizedBlocks().map(getRecognizedBlockSelectionKey).filter(Boolean),
    );
    const currentText = getMessageText(runtime.active.messageId);
    const templateText = getCurrentTemplateEvidenceText();
    runtime.recognizedBlocks = collectRecognizedBlocks(currentText, getSettings(), templateText);
    const previousIndex = Number.isInteger(preferredIndex) && preferredIndex >= 0 ? preferredIndex : -1;
    resetRecognizedBlockSelection();
    list.replaceChildren();

    if (!runtime.recognizedBlocks.length) {
        const empty = document.createElement('div');
        empty.className = 'rr-block-empty';
        empty.textContent = '这条回复里暂时没有识别到带边界的结构块。结构块需要在原始消息里有可定位的标签、括号块或 HTML 容器。';
        list.append(empty);
        document.getElementById('rr-source').value = '';
        document.getElementById('rr-target-title').textContent = '块原文';
        document.getElementById('rr-source-warning').textContent = '没有选中块；请先点左侧识别结果。';
        document.getElementById('rr-preview').value = '';
        runtime.active.selectedBlockKind = 'auto';
        updateDeleteSelectedBlocksButton();
        return;
    }

    runtime.recognizedBlocks.forEach((block, index) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = `rr-block-item${block.isMissing ? ' missing' : ''}`;
        button.dataset.index = String(index);
        button.setAttribute('aria-pressed', 'false');
        button.title = block.isMissing
            ? '当前回复缺失此块；点击后可按聊天基准补回'
            : '点击选择或取消，可多选后一次修复';
        button.innerHTML = `
            <span class="rr-block-item-top">
                <span class="rr-block-title-line">
                    <span class="rr-block-check" aria-hidden="true"><i class="fa-solid fa-check"></i></span>
                    <strong></strong>
                </span>
                <em></em>
            </span>
            <span class="rr-block-item-preview"></span>
        `;
        button.querySelector('strong').textContent = `${index + 1}. ${block.label}`;
        button.querySelector('em').textContent = block.source;
        button.querySelector('.rr-block-item-preview').textContent = block.preview || '空块';
        button.addEventListener('click', () => toggleRecognizedBlockSelection(index, { refreshTemplates: true }));
        list.append(button);
    });

    runtime.recognizedBlocks.forEach((block, index) => {
        if (previousSelectedKeys.has(getRecognizedBlockSelectionKey(block))) {
            ensureSelectedBlockIndexSet().add(index);
        }
    });

    if (!getSelectedBlockIndexes().length && previousIndex >= 0 && runtime.recognizedBlocks[previousIndex]) {
        const nextIndex = previousIndex;
        ensureSelectedBlockIndexSet().add(nextIndex);
        runtime.selectedBlockIndex = nextIndex;
    }

    updateSelectedRecognizedBlocks({ refreshTemplates });
}

function composeInstructionForActive(mode, instruction) {
    const parts = [];
    const base = String(instruction || '').trim();

    if (mode === 'repair_block') {
        parts.push('本次操作：按用户要求修改当前选中的目标块；如果选中多个块，就分别修改每个块。除非用户明确要求“重新生成整个块”，否则只改必要内容，其他字段和值保持原样。');
    }

    if (base) {
        parts.push(base);
    }

    return parts.join('\n');
}

function updateModalViewportMetrics() {
    const viewport = window.visualViewport;
    const width = Math.max(280, Math.floor(viewport?.width || window.innerWidth || document.documentElement.clientWidth || 1024));
    const height = Math.max(240, Math.floor(viewport?.height || window.innerHeight || document.documentElement.clientHeight || 720));
    const offsetLeft = Math.floor(viewport?.offsetLeft || 0);
    const offsetTop = Math.floor(viewport?.offsetTop || 0);
    const margin = Math.max(8, Math.min(28, Math.round(Math.min(width, height) * 0.025)));
    const modalWidth = Math.max(260, Math.min(1180, width - margin * 2));
    const modalHeight = Math.max(220, height - margin * 2);
    const modalLeft = offsetLeft + Math.max(margin, Math.round((width - modalWidth) / 2));
    const modalTop = offsetTop + margin;
    const rootStyle = document.documentElement.style;

    rootStyle.setProperty('--rr-modal-top', `${modalTop}px`);
    rootStyle.setProperty('--rr-modal-left', `${modalLeft}px`);
    rootStyle.setProperty('--rr-modal-width', `${modalWidth}px`);
    rootStyle.setProperty('--rr-modal-height', `${modalHeight}px`);
}

function scheduleModalViewportUpdate() {
    if (runtime.modalViewportFrame) {
        return;
    }

    runtime.modalViewportFrame = window.requestAnimationFrame(() => {
        runtime.modalViewportFrame = 0;
        updateModalViewportMetrics();
    });
}

function bindModalViewportUpdates() {
    if (runtime.modalViewportBound) {
        updateModalViewportMetrics();
        return;
    }

    window.addEventListener('resize', scheduleModalViewportUpdate);
    window.addEventListener('orientationchange', scheduleModalViewportUpdate);
    window.visualViewport?.addEventListener('resize', scheduleModalViewportUpdate);
    window.visualViewport?.addEventListener('scroll', scheduleModalViewportUpdate);
    runtime.modalViewportBound = true;
    updateModalViewportMetrics();
}

function openRescueModal(messageId, messageElement) {
    const message = getCurrentMessage(messageId);
    if (!message) {
        notify('warning', '只能急救普通助手回复。');
        return;
    }

    const selectionInfo = rememberSelectionInfo(getSelectionInfoInMessage(messageElement))
        || getSelectionSnapshotForMessage(messageId);
    const selectedText = selectionInfo?.selectedText || '';
    if (!selectedText) {
        notify('warning', '请先选中要修改的正文片段；结构块请从底部魔法棒菜单打开“回复救急插件”。');
        return;
    }

    const initialMode = 'rewrite_selection';

    runtime.active = {
        messageId,
        selectedText,
        selectionRange: {
            rawStart: selectionInfo.rawStart ?? -1,
            rawEnd: selectionInfo.rawEnd ?? -1,
            selectedRawText: selectionInfo.selectedRawText || '',
            normalizedStart: selectionInfo.normalizedStart ?? -1,
        },
        mode: initialMode,
        statusEvidence: null,
        blockEvidence: null,
        selectedBlockKind: 'auto',
        blockTemplateCandidates: [],
        templateScanToken: 0,
    };
    runtime.recognizedBlocks = [];
    resetRecognizedBlockSelection();

    document.getElementById('rr-mode').value = initialMode;
    runtime.active.selectedBlockKind = 'auto';
    const markerHintElement = document.getElementById('rr-block-marker-hint');
    const templateElement = document.getElementById('rr-template-evidence');
    if (markerHintElement) {
        markerHintElement.value = '';
    }
    if (templateElement) {
        templateElement.value = '';
    }
    document.getElementById('rr-instruction').value = '';
    document.getElementById('rr-message-id').textContent = `#${messageId}`;
    document.getElementById('rr-selected-badge').textContent = '已捕获选区，只会替换这段正文';
    refreshModalSource();

    updateModalViewportMetrics();
    document.getElementById('rr-modal-overlay').hidden = false;
    document.getElementById('rr-modal').hidden = false;
    document.getElementById('rr-instruction').focus();
}

function openBlockRescueUi({ keepInstruction = false } = {}) {
    const messageId = getLatestAssistantMessageId();
    const message = getCurrentMessage(messageId);
    if (!message) {
        notify('warning', '当前聊天里没有可修改的助手回复。');
        return false;
    }

    const previousInstruction = keepInstruction ? String(document.getElementById('rr-instruction')?.value || '') : '';

    runtime.active = {
        messageId,
        selectedText: '',
        mode: 'repair_block',
        editor: 'block_ui',
        statusEvidence: null,
        blockEvidence: null,
        selectedBlockKind: 'auto',
        blockTemplateCandidates: [],
        templateScanToken: 0,
    };
    runtime.recognizedBlocks = [];
    resetRecognizedBlockSelection();

    const modeElement = document.getElementById('rr-mode');
    const markerHintElement = document.getElementById('rr-block-marker-hint');
    const templateElement = document.getElementById('rr-template-evidence');
    const instructionElement = document.getElementById('rr-instruction');
    const previewElement = document.getElementById('rr-preview');

    if (modeElement) {
        modeElement.value = 'repair_block';
    }
    if (markerHintElement) {
        markerHintElement.value = '';
    }
    if (templateElement) {
        templateElement.value = '';
    }
    if (instructionElement) {
        instructionElement.value = previousInstruction;
    }
    if (previewElement) {
        previewElement.value = '';
    }

    document.getElementById('rr-message-id').textContent = `#${messageId}`;
    document.getElementById('rr-selected-badge').textContent = '自动识别块：读取当前聊天最后一条助手回复';
    updateModalViewportMetrics();
    document.getElementById('rr-modal-overlay').hidden = false;
    document.getElementById('rr-modal').hidden = false;

    refreshModalSource();
    const scannedMessage = '已扫描当前聊天最后一条助手回复。点选左侧一个或多个块，再写修改要求。';
    document.getElementById('rr-modal-status').textContent = scannedMessage;
    void refreshBlockTemplateEvidence({ silent: true }).then(() => {
        if (runtime.active?.editor === 'block_ui') {
            document.getElementById('rr-modal-status').textContent = scannedMessage;
        }
    });
    document.getElementById('rr-instruction')?.focus();
    return true;
}

function closeRescueModal() {
    document.getElementById('rr-modal-overlay').hidden = true;
    document.getElementById('rr-modal').hidden = true;
    runtime.active = null;
    runtime.recognizedBlocks = [];
    resetRecognizedBlockSelection();
    updateDeleteSelectedBlocksButton();
}

function resetModalForChatChange() {
    const modal = document.getElementById('rr-modal');
    if (modal && !modal.hidden) {
        closeRescueModal();
    } else {
        runtime.active = null;
        runtime.recognizedBlocks = [];
        resetRecognizedBlockSelection();
        updateDeleteSelectedBlocksButton();
    }
}

function addRescueButtons() {
    if (!getSettings().enabled) {
        document.querySelectorAll('.rr_rescue_button').forEach(button => button.remove());
        hideSelectionButton();
        return;
    }

    let addedCount = 0;

    document.querySelectorAll('#chat .mes').forEach((messageElement) => {
        const messageId = getMessageIdFromElement(messageElement);
        const message = getCurrentMessage(messageId);
        const buttons = messageElement.querySelector('.mes_buttons');
        const extraButtons = buttons?.querySelector('.extraMesButtons');
        const editButton = messageElement.querySelector('.mes_edit');

        if (!message || !buttons) {
            return;
        }

        if (!hasDirectChild(buttons, 'rr_rescue_button_inline')) {
            const inlineButton = createRescueButton(messageId, 'inline');
            if (editButton) {
                buttons.insertBefore(inlineButton, editButton);
            } else {
                buttons.append(inlineButton);
            }
            addedCount += 1;
        }

        if (extraButtons && !hasDirectChild(extraButtons, 'rr_rescue_button_menu')) {
            extraButtons.prepend(createRescueButton(messageId, 'menu'));
            addedCount += 1;
        }
    });

    return addedCount;
}

function hasDirectChild(container, className) {
    return Array.from(container?.children || []).some(child => child.classList.contains(className));
}

function createRescueButton(messageId, variant) {
    const button = document.createElement('div');
    button.className = `mes_button rr_rescue_button rr_rescue_button_${variant} fa-solid fa-wand-magic-sparkles`;
    button.title = '回复救急';
    button.dataset.messageId = String(messageId);
    const preserveSelection = () => {
        captureCurrentSelectionSnapshot();
    };
    button.addEventListener('pointerdown', preserveSelection);
    button.addEventListener('mousedown', preserveSelection);
    button.addEventListener('touchstart', preserveSelection, { passive: true });
    return button;
}

function scheduleButtonRefresh() {
    window.setTimeout(addRescueButtons, 50);
}

function hideSelectionButton() {
    const button = document.getElementById('rr-selection-button');
    if (button) {
        button.hidden = true;
    }
}

function updateSelectionButton() {
    const button = document.getElementById('rr-selection-button');
    const modal = document.getElementById('rr-modal');
    if (!button || !getSettings().enabled || (modal && !modal.hidden)) {
        hideSelectionButton();
        return;
    }

    const messageElement = getSelectedMessageElement();
    const selection = window.getSelection?.();
    if (!messageElement || !selection || selection.rangeCount === 0) {
        hideSelectionButton();
        return;
    }

    const rect = selection.getRangeAt(0).getBoundingClientRect();
    if (!rect || (!rect.width && !rect.height)) {
        hideSelectionButton();
        return;
    }

    const size = 34;
    let left = rect.right + 8;
    if (left + size > window.innerWidth) {
        left = rect.left - size - 8;
    }

    const top = rect.top + Math.max(0, (rect.height - size) / 2);
    button.style.left = `${Math.max(8, Math.min(left, window.innerWidth - size - 8))}px`;
    button.style.top = `${Math.max(8, Math.min(top, window.innerHeight - size - 8))}px`;
    button.hidden = false;
}

function scheduleSelectionButtonUpdate() {
    window.setTimeout(updateSelectionButton, 0);
}

function mountSelectionButton() {
    if (runtime.selectionButtonBound || document.getElementById('rr-selection-button')) {
        runtime.selectionButtonBound = true;
        return;
    }

    const button = document.createElement('div');
    button.id = 'rr-selection-button';
    button.className = 'rr-selection-button fa-solid fa-wand-magic-sparkles';
    button.title = '回复救急';
    button.hidden = true;

    const preserveSelectionBeforeButtonAction = (event) => {
        captureCurrentSelectionSnapshot();
        event.preventDefault();
        event.stopPropagation();
    };

    button.addEventListener('pointerdown', preserveSelectionBeforeButtonAction);
    button.addEventListener('mousedown', preserveSelectionBeforeButtonAction);
    button.addEventListener('touchstart', preserveSelectionBeforeButtonAction, { passive: false });
    button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        let messageElement = getSelectedMessageElement();
        let messageId = getMessageIdFromElement(messageElement);
        if (!messageElement || messageId === -1) {
            const snapshot = getFreshSelectionSnapshot();
            if (snapshot) {
                messageId = snapshot.messageId;
                messageElement = getMessageElement(messageId);
            }
        }

        if (!messageElement || messageId === -1) {
            notify('warning', '没有捕获到当前选区，请重新选中正文片段后再点魔法棒。');
            hideSelectionButton();
            return;
        }

        openRescueModal(messageId, messageElement);
        hideSelectionButton();
    });

    document.body.append(button);
    document.addEventListener('selectionchange', scheduleSelectionButtonUpdate);
    document.addEventListener('mouseup', scheduleSelectionButtonUpdate);
    document.addEventListener('pointerup', scheduleSelectionButtonUpdate);
    document.addEventListener('touchend', scheduleSelectionButtonUpdate);
    document.addEventListener('keyup', scheduleSelectionButtonUpdate);
    document.addEventListener('scroll', updateSelectionButton, true);
    window.addEventListener('resize', hideSelectionButton);
    runtime.selectionButtonBound = true;
}

function mountWandMenuEntry() {
    if (document.getElementById('rr-open-ui-wand-button')) {
        runtime.wandMenuMounted = true;
        return true;
    }

    const container = document.getElementById('extensionsMenu');
    if (!(container instanceof HTMLElement)) {
        return false;
    }

    const button = document.createElement('div');
    button.id = 'rr-open-ui-wand-button';
    button.classList.add('list-group-item', 'flex-container', 'flexGap5');
    button.title = '打开回复救急插件 UI';

    const icon = document.createElement('div');
    icon.classList.add('fa-solid', 'fa-wand-magic-sparkles', 'extensionsMenuExtensionButton');

    const text = document.createElement('span');
    text.textContent = '回复救急插件';

    button.append(icon, text);
    button.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        container.style.display = 'none';
        openBlockRescueUi({ keepInstruction: false });
    });

    container.append(button);
    runtime.wandMenuMounted = true;
    return true;
}

function scheduleWandMenuMount() {
    if (runtime.wandMenuMounted || mountWandMenuEntry() || runtime.wandMenuRetryTimer) {
        return;
    }

    let attempts = 0;
    runtime.wandMenuRetryTimer = window.setInterval(() => {
        attempts += 1;
        if (mountWandMenuEntry() || attempts >= 20) {
            window.clearInterval(runtime.wandMenuRetryTimer);
            runtime.wandMenuRetryTimer = null;
        }
    }, 500);
}

function mountModal() {
    if (runtime.modalMounted || document.getElementById('rr-modal')) {
        runtime.modalMounted = true;
        return;
    }

    const overlay = document.createElement('div');
    overlay.id = 'rr-modal-overlay';
    overlay.className = 'rr-modal-overlay';
    overlay.hidden = true;

    const modal = document.createElement('div');
    modal.id = 'rr-modal';
    modal.className = 'rr-modal';
    modal.hidden = true;
    modal.innerHTML = `
        <div class="rr-modal-header">
            <div>
                <div class="rr-modal-title">回复救急插件 <span id="rr-message-id"></span></div>
                <div class="rr-modal-subtitle"><span id="rr-selected-badge"></span></div>
            </div>
            <button id="rr-close" class="menu_button rr-icon-button" title="关闭"><i class="fa-solid fa-xmark"></i></button>
        </div>
        <div class="rr-modal-grid">
            <select id="rr-mode" hidden>
                <option value="repair_block">修改识别块</option>
                <option value="rewrite_selection">重写选中片段</option>
            </select>
            <input id="rr-block-marker-hint" type="hidden" value="">
            <textarea id="rr-template-evidence" hidden></textarea>
            <div id="rr-selection-panel" class="rr-inline-note rr-wide" hidden>
                <i class="fa-solid fa-highlighter"></i>
                <span id="rr-mode-help"></span>
            </div>
            <aside id="rr-block-workspace" class="rr-block-workspace" hidden>
                <div class="rr-block-head">
                    <span>已识别块</span>
                    <button id="rr-rescan-blocks" class="menu_button rr-refresh-buttons" type="button" title="重新读取当前聊天最后一条助手回复并识别结构块">
                        <i class="fa-solid fa-arrows-rotate"></i>
                        <span>扫描当前聊天块</span>
                    </button>
                </div>
                <div id="rr-block-list" class="rr-block-list"></div>
            </aside>
            <label id="rr-source-field" class="rr-field rr-editor-field">
                <span id="rr-target-title">目标内容</span>
                <textarea id="rr-source" class="text_pole rr-mono" rows="8"></textarea>
                <small id="rr-source-help" class="rr-help">这里只处理你选中的正文片段。</small>
            </label>
            <label id="rr-instruction-field" class="rr-field rr-editor-field">
                <span>你的修改要求</span>
                <textarea id="rr-instruction" class="text_pole" rows="3" placeholder="例如：语气更温柔一点；或：把这段改短，但保留原本事实。"></textarea>
                <small id="rr-instruction-help" class="rr-help">只替换选中的正文，不会改动状态栏、选项栏或其他结构块。</small>
            </label>
            <div id="rr-source-warning" class="rr-warning rr-editor-field"></div>
            <label id="rr-preview-field" class="rr-field rr-editor-field">
                <span>修复结果预览</span>
                <textarea id="rr-preview" class="text_pole rr-mono" rows="10" placeholder="先生成预览，确认后再应用。"></textarea>
                <small class="rr-help">预览不会自动写回；确认无误后再点应用。</small>
            </label>
        </div>
        <div id="rr-modal-status" class="rr-status"></div>
        <div class="rr-modal-actions">
            <button id="rr-undo" class="menu_button"><i class="fa-solid fa-rotate-left"></i>撤销上次急救</button>
            <button id="rr-delete-blocks" class="menu_button rr-danger-button" type="button" disabled hidden><i class="fa-solid fa-trash-can"></i>删除选中块</button>
            <div class="rr-spacer"></div>
            <button id="rr-cancel" class="menu_button">取消</button>
            <button id="rr-generate" class="menu_button"><i class="fa-solid fa-wand-magic-sparkles"></i>生成修复预览</button>
            <button id="rr-apply" class="menu_button"><i class="fa-solid fa-check"></i>应用到当前回复</button>
        </div>
    `;

    document.body.append(overlay, modal);
    document.getElementById('rr-close').addEventListener('click', closeRescueModal);
    document.getElementById('rr-cancel').addEventListener('click', closeRescueModal);
    overlay.addEventListener('click', closeRescueModal);
    document.getElementById('rr-rescan-blocks')?.addEventListener('click', () => {
        openBlockRescueUi({ keepInstruction: true });
    });
    document.getElementById('rr-mode').addEventListener('change', refreshModalSource);
    document.getElementById('rr-generate').addEventListener('click', generatePreview);
    document.getElementById('rr-apply').addEventListener('click', applyPreview);
    document.getElementById('rr-undo').addEventListener('click', undoLastRepair);
    document.getElementById('rr-delete-blocks')?.addEventListener('click', deleteSelectedRecognizedBlocks);
    document.getElementById('rr-status-auto')?.addEventListener('click', () => setStatusSource('auto'));
    document.getElementById('rr-status-last-block')?.addEventListener('click', () => setStatusSource('last_block'));
    document.getElementById('rr-status-tail')?.addEventListener('click', () => setStatusSource('tail'));
    document.getElementById('rr-status-append')?.addEventListener('click', () => setStatusSource('append'));
    document.getElementById('rr-block-auto')?.addEventListener('click', () => setBlockSource('auto'));
    document.getElementById('rr-block-last-block')?.addEventListener('click', () => setBlockSource('last_block'));
    document.getElementById('rr-block-tail')?.addEventListener('click', () => setBlockSource('tail'));
    document.getElementById('rr-block-append')?.addEventListener('click', () => setBlockSource('append'));
    document.getElementById('rr-block-scan-template')?.addEventListener('click', () => refreshBlockTemplateEvidence({ silent: false }));
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && !document.getElementById('rr-modal')?.hidden) {
            closeRescueModal();
        }
    });

    runtime.modalMounted = true;
}

function setApiSettingsVisibility() {
    const settings = getSettings();
    const sourceSelect = document.getElementById('rr-setting-generation-source');
    const apiPanel = document.getElementById('rr-api-settings');

    if (sourceSelect) {
        sourceSelect.value = settings.generationSource;
    }
    if (apiPanel) {
        apiPanel.hidden = settings.generationSource !== 'independent';
    }
}

function fillApiModelControls(preset) {
    const modelSelect = document.getElementById('rr-api-model');
    const modelManual = document.getElementById('rr-api-model-manual');
    if (!modelSelect) {
        return;
    }

    const models = sanitizeModelList(preset?.availableModels || []);
    modelSelect.innerHTML = '';
    if (models.length) {
        for (const model of models) {
            modelSelect.append(new Option(model, model));
        }
        modelSelect.disabled = false;
        modelSelect.value = models.includes(preset.model) ? preset.model : models[0];
    } else {
        modelSelect.append(new Option('请先识别可用模型', ''));
        modelSelect.disabled = true;
        modelSelect.value = '';
    }

    if (modelManual) {
        modelManual.value = preset?.model || modelSelect.value || '';
    }
}

function fillApiPresetForm() {
    const settings = getSettings();
    const preset = getActiveApiPreset(settings);
    if (!preset) {
        return;
    }

    const presetSelect = document.getElementById('rr-api-preset');
    if (presetSelect) {
        presetSelect.innerHTML = '';
        for (const item of settings.apiPresets) {
            presetSelect.append(new Option(item.name || '未命名预设', item.id));
        }
        presetSelect.value = preset.id;
    }

    const setValue = (id, value) => {
        const element = document.getElementById(id);
        if (element) {
            element.value = String(value ?? '');
        }
    };

    setValue('rr-api-name', preset.name);
    setValue('rr-api-url', preset.baseUrl);
    setValue('rr-api-key', preset.apiKey);
    setValue('rr-api-max-tokens', preset.maxTokens);
    setValue('rr-api-temperature', preset.temperature);
    fillApiModelControls(preset);
    setApiSettingsVisibility();
}

function readApiPresetFormValues(basePreset, index = 0) {
    const valueOf = id => String(document.getElementById(id)?.value || '').trim();
    const selectedModel = valueOf('rr-api-model-manual') || valueOf('rr-api-model');
    const modelSelect = document.getElementById('rr-api-model');
    const availableModels = modelSelect
        ? Array.from(modelSelect.options).map(option => option.value).filter(Boolean)
        : basePreset.availableModels;

    return sanitizeApiPreset({
        ...basePreset,
        name: valueOf('rr-api-name') || basePreset.name,
        baseUrl: valueOf('rr-api-url'),
        apiKey: valueOf('rr-api-key'),
        model: selectedModel,
        availableModels,
        maxTokens: document.getElementById('rr-api-max-tokens')?.value || basePreset.maxTokens,
        temperature: document.getElementById('rr-api-temperature')?.value || basePreset.temperature,
    }, index);
}

function saveActiveApiPresetFromUi({ silent = false } = {}) {
    const settings = getSettings();
    const index = settings.apiPresets.findIndex(preset => preset.id === settings.activeApiPresetId);
    if (index === -1) {
        return null;
    }

    const saved = readApiPresetFormValues(settings.apiPresets[index], index);
    settings.apiPresets[index] = saved;
    settings.activeApiPresetId = saved.id;
    saveSettingsDebounced();
    fillApiPresetForm();

    if (!silent) {
        notify('success', '独立 API 预设已保存。');
    }

    return saved;
}

async function loadModelsForActiveApiPreset() {
    const button = document.getElementById('rr-api-load-models');
    const status = document.getElementById('rr-api-status');
    try {
        const preset = saveActiveApiPresetFromUi({ silent: true });
        if (!preset) {
            throw new Error('没有可用的独立 API 预设。');
        }

        if (button) {
            button.disabled = true;
        }
        if (status) {
            status.textContent = '正在识别可用模型...';
        }

        const models = await fetchIndependentApiModels(preset);
        const settings = getSettings();
        const index = settings.apiPresets.findIndex(item => item.id === preset.id);
        if (index !== -1) {
            settings.apiPresets[index] = sanitizeApiPreset({
                ...settings.apiPresets[index],
                availableModels: models,
                model: models.includes(settings.apiPresets[index].model) ? settings.apiPresets[index].model : models[0],
            }, index);
            settings.activeApiPresetId = settings.apiPresets[index].id;
            saveSettingsDebounced();
        }

        fillApiPresetForm();
        const message = `已识别 ${models.length} 个可用模型，请选择后保存。`;
        if (status) {
            status.textContent = message;
        }
        notify('success', message);
    } catch (error) {
        const message = error?.message || String(error);
        if (status) {
            status.textContent = message;
        }
        notify('error', message);
    } finally {
        if (button) {
            button.disabled = false;
        }
    }
}

function addApiPresetFromUi() {
    saveActiveApiPresetFromUi({ silent: true });
    const settings = getSettings();
    const preset = createDefaultApiPreset(settings.apiPresets.length);
    settings.apiPresets.push(preset);
    settings.activeApiPresetId = preset.id;
    settings.generationSource = 'independent';
    saveSettingsDebounced();
    fillApiPresetForm();
    notify('success', '已新增独立 API 预设。');
}

function deleteActiveApiPresetFromUi() {
    const settings = getSettings();
    if (settings.apiPresets.length <= 1) {
        settings.apiPresets = [createDefaultApiPreset()];
        settings.activeApiPresetId = settings.apiPresets[0].id;
        saveSettingsDebounced();
        fillApiPresetForm();
        notify('info', '已重置最后一个独立 API 预设。');
        return;
    }

    const index = settings.apiPresets.findIndex(preset => preset.id === settings.activeApiPresetId);
    if (index === -1) {
        return;
    }

    settings.apiPresets.splice(index, 1);
    settings.activeApiPresetId = settings.apiPresets[Math.max(0, index - 1)].id;
    saveSettingsDebounced();
    fillApiPresetForm();
    notify('success', '已删除独立 API 预设。');
}

function mountSettings() {
    if (runtime.settingsMounted || document.getElementById('reply_rescue_settings')) {
        runtime.settingsMounted = true;
        return;
    }

    const target = document.getElementById('extensions_settings2') || document.getElementById('extensions_settings');
    if (!target) {
        return;
    }

    const settings = getSettings();
    const container = document.createElement('div');
    container.id = 'reply_rescue_settings';
    container.className = 'reply-rescue-settings';
    container.innerHTML = `
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>回复救急插件</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <label class="checkbox_label rr-setting-check">
                    <input id="rr-setting-enabled" type="checkbox">
                    <span class="rr-checkbox-copy">
                        <span>启用回复救急按钮</span>
                        <small class="rr-help">在助手消息按钮区和正文选区旁显示小魔法棒。</small>
                    </span>
                </label>
                <button id="rr-refresh-buttons" class="menu_button rr-refresh-buttons">
                    <i class="fa-solid fa-arrows-rotate"></i>
                    <span>重新扫描消息按钮</span>
                </button>
                <div class="rr-settings-grid">
                    <label>
                        <span>上下文字符数</span>
                        <small class="rr-help">发送给模型的最近上下文总字数，越大越稳但更费 token。</small>
                        <input id="rr-setting-context-length" class="text_pole" type="number" min="300" max="${CONTEXT_LENGTH_MAX}" step="100">
                    </label>
                    <label>
                        <span>最近消息数</span>
                        <small class="rr-help">最多读取多少条最近消息作为依据。</small>
                        <input id="rr-setting-recent-messages" class="text_pole" type="number" min="2" max="20" step="1">
                    </label>
                    <label>
                        <span>修复输出长度</span>
                        <small class="rr-help">限制模型本次急救输出长度，避免整段重写失控。</small>
                        <input id="rr-setting-response-length" class="text_pole" type="number" min="80" max="${RESPONSE_LENGTH_MAX}" step="20">
                    </label>
                    <label>
                        <span>生成来源</span>
                        <small class="rr-help">默认使用当前酒馆模型；也可以改用下方保存的独立 API。</small>
                        <select id="rr-setting-generation-source" class="text_pole">
                            <option value="sillytavern">当前酒馆模型</option>
                            <option value="independent">独立 API</option>
                        </select>
                    </label>
                </div>
                <div id="rr-api-settings" class="rr-api-settings" hidden>
                    <div class="rr-api-toolbar">
                        <label class="rr-api-preset-field">
                            <span>API 预设</span>
                            <select id="rr-api-preset" class="text_pole"></select>
                        </label>
                        <button id="rr-api-add" class="menu_button" type="button"><i class="fa-solid fa-plus"></i>新增预设</button>
                        <button id="rr-api-delete" class="menu_button rr-danger-button" type="button"><i class="fa-solid fa-trash-can"></i>删除预设</button>
                    </div>
                    <div class="rr-settings-grid rr-api-grid">
                        <label>
                            <span>自定义名称</span>
                            <small class="rr-help">只用于你自己区分不同接口。</small>
                            <input id="rr-api-name" class="text_pole" type="text" placeholder="例如：备用急救 API">
                        </label>
                        <label class="rr-api-wide">
                            <span>API URL</span>
                            <small class="rr-help">填写 OpenAI 兼容地址，例如 https://example.com/v1。</small>
                            <input id="rr-api-url" class="text_pole" type="url" placeholder="https://api.example.com/v1">
                        </label>
                        <label class="rr-api-wide">
                            <span>API Key</span>
                            <small class="rr-help">Key 会保存在本地酒馆设置里，只建议个人电脑使用。</small>
                            <input id="rr-api-key" class="text_pole" type="password" autocomplete="off" placeholder="sk-...">
                        </label>
                        <label>
                            <span>选中模型</span>
                            <small class="rr-help">点“识别可用模型”后在这里选择。</small>
                            <select id="rr-api-model" class="text_pole"></select>
                        </label>
                        <label>
                            <span>手填模型名</span>
                            <small class="rr-help">识别失败但你知道模型名时使用。</small>
                            <input id="rr-api-model-manual" class="text_pole" type="text" placeholder="model-id">
                        </label>
                        <label>
                            <span>独立 API 输出长度</span>
                            <small class="rr-help">最大 ${RESPONSE_LENGTH_MAX}，只影响独立 API。</small>
                            <input id="rr-api-max-tokens" class="text_pole" type="number" min="80" max="${RESPONSE_LENGTH_MAX}" step="20">
                        </label>
                        <label>
                            <span>温度</span>
                            <small class="rr-help">越低越稳，建议 0.3 到 0.8。</small>
                            <input id="rr-api-temperature" class="text_pole" type="number" min="0" max="2" step="0.1">
                        </label>
                    </div>
                    <div class="rr-api-toolbar rr-api-actions">
                        <button id="rr-api-load-models" class="menu_button" type="button"><i class="fa-solid fa-list-check"></i>识别可用模型</button>
                        <button id="rr-api-save" class="menu_button" type="button"><i class="fa-solid fa-floppy-disk"></i>保存 API 预设</button>
                        <span id="rr-api-status" class="rr-settings-note"></span>
                    </div>
                </div>
            </div>
        </div>
    `;
    target.append(container);

    const bind = (id, eventName, handler) => {
        document.getElementById(id)?.addEventListener(eventName, handler);
    };

    document.getElementById('rr-setting-enabled').checked = settings.enabled;
    document.getElementById('rr-setting-context-length').value = String(settings.contextLength);
    document.getElementById('rr-setting-recent-messages').value = String(settings.recentMessages);
    document.getElementById('rr-setting-response-length').value = String(settings.responseLength);
    document.getElementById('rr-setting-generation-source').value = settings.generationSource;
    fillApiPresetForm();

    bind('rr-setting-enabled', 'change', (event) => {
        getSettings().enabled = event.currentTarget.checked;
        saveSettingsDebounced();
        scheduleButtonRefresh();
    });
    bind('rr-refresh-buttons', 'click', () => {
        const addedCount = addRescueButtons() || 0;
        notify('info', addedCount ? `已新增 ${addedCount} 个回复救急入口。` : '已扫描，当前可见消息没有缺失入口。');
    });
    bind('rr-setting-context-length', 'change', (event) => {
        getSettings().contextLength = clampInteger(event.currentTarget.value, defaultSettings.contextLength, 300, CONTEXT_LENGTH_MAX);
        event.currentTarget.value = String(getSettings().contextLength);
        saveSettingsDebounced();
    });
    bind('rr-setting-recent-messages', 'change', (event) => {
        getSettings().recentMessages = clampInteger(event.currentTarget.value, defaultSettings.recentMessages, 2, 20);
        event.currentTarget.value = String(getSettings().recentMessages);
        saveSettingsDebounced();
    });
    bind('rr-setting-response-length', 'change', (event) => {
        getSettings().responseLength = clampInteger(event.currentTarget.value, defaultSettings.responseLength, 80, RESPONSE_LENGTH_MAX);
        event.currentTarget.value = String(getSettings().responseLength);
        saveSettingsDebounced();
    });
    bind('rr-setting-generation-source', 'change', (event) => {
        getSettings().generationSource = event.currentTarget.value === 'independent' ? 'independent' : 'sillytavern';
        saveSettingsDebounced();
        setApiSettingsVisibility();
    });
    bind('rr-api-preset', 'change', (event) => {
        const nextPresetId = event.currentTarget.value;
        saveActiveApiPresetFromUi({ silent: true });
        getSettings().activeApiPresetId = nextPresetId;
        saveSettingsDebounced();
        fillApiPresetForm();
    });
    bind('rr-api-add', 'click', addApiPresetFromUi);
    bind('rr-api-delete', 'click', deleteActiveApiPresetFromUi);
    bind('rr-api-load-models', 'click', loadModelsForActiveApiPreset);
    bind('rr-api-save', 'click', () => saveActiveApiPresetFromUi({ silent: false }));
    bind('rr-api-model', 'change', (event) => {
        const manual = document.getElementById('rr-api-model-manual');
        if (manual) {
            manual.value = event.currentTarget.value;
        }
    });

    runtime.settingsMounted = true;
}

function scheduleSettingsMount() {
    mountSettings();

    if (runtime.settingsMounted || runtime.settingsRetryTimer) {
        return;
    }

    let attempts = 0;
    runtime.settingsRetryTimer = window.setInterval(() => {
        attempts += 1;
        mountSettings();

        if (runtime.settingsMounted || attempts >= 20) {
            window.clearInterval(runtime.settingsRetryTimer);
            runtime.settingsRetryTimer = null;
        }
    }, 500);
}

function bindMessageButtonHandler() {
    if (runtime.buttonsBound) {
        return;
    }

    document.addEventListener('click', (event) => {
        const button = event.target instanceof Element ? event.target.closest('.rr_rescue_button') : null;
        if (!button) {
            return;
        }

        event.preventDefault();
        event.stopPropagation();
        const messageElement = button.closest('.mes');
        const messageId = getMessageIdFromElement(messageElement);
        openRescueModal(messageId, messageElement);
    }, true);

    runtime.buttonsBound = true;
}

function bindChatRefreshHooks() {
    const refreshEvents = [
        event_types.APP_READY,
        event_types.CHAT_CHANGED,
        event_types.CHAT_LOADED,
        event_types.MESSAGE_RECEIVED,
        event_types.MESSAGE_UPDATED,
        event_types.CHARACTER_MESSAGE_RENDERED,
        event_types.MESSAGE_SWIPED,
    ].filter(Boolean);

    for (const eventName of refreshEvents) {
        eventSource.on(eventName, scheduleButtonRefresh);
    }

    if (event_types.APP_READY) {
        eventSource.on(event_types.APP_READY, scheduleWandMenuMount);
    }

    [event_types.CHAT_CHANGED, event_types.CHAT_LOADED].filter(Boolean).forEach((eventName) => {
        eventSource.on(eventName, () => {
            resetModalForChatChange();
        });
    });

    const chatElement = document.getElementById('chat');
    if (chatElement && !runtime.observer) {
        runtime.observer = new MutationObserver(scheduleButtonRefresh);
        runtime.observer.observe(chatElement, { childList: true, subtree: true });
    }
}

export async function init() {
    getSettings();
    bindModalViewportUpdates();
    mountModal();
    mountSelectionButton();
    scheduleWandMenuMount();
    scheduleSettingsMount();
    bindMessageButtonHandler();

    if (!runtime.initialized) {
        bindChatRefreshHooks();
        runtime.initialized = true;
    }

    scheduleButtonRefresh();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => init(), { once: true });
} else {
    window.setTimeout(() => init(), 0);
}
