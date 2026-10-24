import express from 'express';
import { OpenWebSearchRuntime } from '../../runtime/runtimeTypes.js';
import { SearchResult } from '../../types.js';
import { validatePublicWebUrl } from '../../core/validation/targetValidation.js';
import { parseMaxChars, parseRequestedEngines } from './localDaemon.js';

// DeepSeek 兼容层（api-docs.deepseek.com /guides/search）：
// 响应为 DeepSeek 的原生形状（顶层 results / {title, content}），
// 错误为 OpenAI 形状 —— 不走本项目的 status/data/error 信封。

type DeepSeekErrorType = 'invalid_request_error' | 'api_error';

const DEEPSEEK_QUERY_MAX_LENGTH = 128;
const DEEPSEEK_FETCH_DEFAULT_MAX_CHARS = 50000;

function sendDeepSeekError(
    res: express.Response,
    statusCode: number,
    message: string,
    type: DeepSeekErrorType
): void {
    res.status(statusCode).json({
        error: {
            message,
            type,
            code: null,
            param: null
        }
    });
}

function parseDeepSeekQuery(query: unknown): string {
    if (typeof query !== 'string' || !query.trim()) {
        throw new Error("'query' must be a non-empty string");
    }

    const trimmed = query.trim();
    if (trimmed.length > DEEPSEEK_QUERY_MAX_LENGTH) {
        throw new Error(`'query' must be at most ${DEEPSEEK_QUERY_MAX_LENGTH} characters`);
    }

    return trimmed;
}

function parseDeepSeekCount(count: unknown): number {
    if (count === undefined) {
        return 10;
    }

    if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > 50) {
        throw new Error("'count' must be between 1 and 50");
    }

    return count;
}

function parseDeepSeekUrl(url: unknown): string {
    if (typeof url !== 'string' || !url.trim()) {
        throw new Error("'url' must be a valid public HTTP(S) URL");
    }

    const trimmed = url.trim();
    if (!validatePublicWebUrl(trimmed)) {
        throw new Error("'url' must be a valid public HTTP(S) URL");
    }

    return trimmed;
}

function toDeepSeekSearchItem(result: SearchResult): Record<string, unknown> {
    let siteName = result.source;
    let siteIcon = '';
    try {
        const hostname = new URL(result.url).hostname;
        siteName = hostname;
        siteIcon = `https://${hostname}/favicon.ico`;
    } catch {
        // 引擎返回的 URL 解析失败时回退到引擎提供的 source 字段。
    }

    return {
        // 爬虫结果没有重排分/长摘要/正文/日期/权威度信号，置空保持 DeepSeek 字段形状。
        rerank_score: null,
        title: result.title,
        url: result.url,
        snippet: result.description,
        summary: '',
        content: '',
        site_name: siteName,
        site_icon: siteIcon,
        date: null,
        authority: null
    };
}

export function registerDeepSeekCompatRoutes(app: express.Express, runtime: OpenWebSearchRuntime): void {
    app.post('/v1/tools/search', async (req, res) => {
        try {
            const query = parseDeepSeekQuery(req.body?.query);
            const limit = parseDeepSeekCount(req.body?.count);
            // engines 是本服务的扩展参数（DeepSeek 客户端不会发送），缺省走默认引擎。
            // need_content / ori_question / localization 接受但忽略：正文抓取代价高，content 恒为空串。
            const engines = parseRequestedEngines(runtime, req.body?.engines);

            const result = await runtime.services.search.execute({ query, limit, engines });
            // 单引擎失败只进 partialFailures，兼容层不外泄该字段：全部失败即 results 为空数组，
            // 对齐 DeepSeek "无结果返回 200 + 空数组" 的语义。
            res.json({ results: result.results.map(toDeepSeekSearchItem) });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            const invalidRequest = message.includes('must') || message.includes('empty');
            sendDeepSeekError(
                res,
                invalidRequest ? 400 : 500,
                message,
                invalidRequest ? 'invalid_request_error' : 'api_error'
            );
        }
    });

    app.post('/v1/tools/fetch', async (req, res) => {
        let url: string;
        let maxChars: number;
        try {
            url = parseDeepSeekUrl(req.body?.url);
            // maxChars 是本服务的扩展参数，缺省比原生 /fetch-web 更宽裕。
            maxChars = parseMaxChars(req.body?.maxChars ?? DEEPSEEK_FETCH_DEFAULT_MAX_CHARS);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            sendDeepSeekError(res, 400, message, 'invalid_request_error');
            return;
        }

        try {
            const result = await runtime.services.fetchWeb.execute({ url, maxChars });
            // content 为纯文本提取结果，不是 DeepSeek 的 Markdown 正文。
            res.json({
                title: result.title ?? '',
                content: result.content ?? ''
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            sendDeepSeekError(res, 404, message, 'api_error');
        }
    });
}
