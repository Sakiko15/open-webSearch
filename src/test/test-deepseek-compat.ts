import { AppConfig } from '../config.js';
import { createOpenWebSearchRuntime } from '../runtime/createRuntime.js';
import { startLocalDaemon } from '../adapters/http/localDaemon.js';

function assert(condition: unknown, message: string): asserts condition {
    if (!condition) {
        throw new Error(message);
    }
}

function assertEqual<T>(actual: T, expected: T, label: string): void {
    if (actual !== expected) {
        throw new Error(`${label}: expected ${expected}, got ${actual}`);
    }
}

function createTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
    return {
        defaultSearchEngine: 'bing',
        allowedSearchEngines: [],
        searchMode: 'request',
        proxyUrl: 'http://127.0.0.1:7890',
        useProxy: false,
        fakeIpCidrs: [],
        fetchWebAllowInsecureTls: false,
        playwrightPackage: 'auto',
        playwrightModulePath: undefined,
        playwrightExecutablePath: undefined,
        playwrightWsEndpoint: undefined,
        playwrightCdpEndpoint: undefined,
        playwrightHeadless: true,
        playwrightNavigationTimeoutMs: 20000,
        enableCors: false,
        corsOrigin: '*',
        enableHttpServer: true,
        ...overrides
    };
}

function createStubRuntime() {
    return createOpenWebSearchRuntime({
        config: createTestConfig(),
        dependencies: {
            searchExecutors: {
                bing: async (query, limit) => [{
                    title: 'Compat Result',
                    url: 'https://example.com/page',
                    description: `${query}:${limit}`,
                    source: 'engine-source',
                    engine: 'bing'
                }],
                startpage: async () => [{
                    title: 'Startpage Result',
                    url: 'https://startpage.example.com/item',
                    description: 'startpage snippet',
                    source: 'startpage.example.com',
                    engine: 'startpage'
                }],
                sogou: async () => {
                    throw new Error('engine down');
                }
            },
            fetchGithubReadme: async () => '# README',
            fetchWebContent: async (url: string, maxChars: number, options?: { readability?: boolean; includeLinks?: boolean; renderMode?: string }) => {
                if (url.endsWith('/fail')) {
                    throw new Error('No readable content was extracted from this URL');
                }
                return {
                    url,
                    finalUrl: url,
                    contentType: 'text/html; charset=utf-8',
                    title: 'Example',
                    retrievalMethod: 'request' as const,
                    truncated: false,
                    content: `ok:${maxChars}:${options?.readability ? 'readability' : 'plain'}`,
                    readabilityApplied: options?.readability ?? false
                };
            },
            fetchCsdnArticle: async () => ({ content: 'csdn' }),
            fetchJuejinArticle: async () => ({ content: 'juejin' }),
            fetchLinuxDoArticle: async () => ({ content: 'linuxdo' })
        }
    });
}

async function postJson<T>(baseUrl: string, path: string, body: Record<string, unknown>) {
    const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json'
        },
        body: JSON.stringify(body)
    });
    const payload = await response.json() as T;
    return { response, payload };
}

type DeepSeekSearchItem = {
    rerank_score: number | null;
    title: string;
    url: string;
    snippet: string;
    summary: string;
    content: string;
    site_name: string;
    site_icon: string;
    date: string | null;
    authority: number | null;
};

type DeepSeekErrorBody = {
    error: { message: string; type: string; code: string | null; param: unknown };
};

async function testSearchShapeAndDefaults(): Promise<void> {
    const daemon = await startLocalDaemon(createStubRuntime(), { port: 0, version: 'compat-test' });
    try {
        const { response, payload } = await postJson<{ results: DeepSeekSearchItem[] } & Record<string, unknown>>(
            daemon.baseUrl,
            '/v1/tools/search',
            { query: 'compat' }
        );
        assertEqual(response.status, 200, 'compat search http status');
        assert(!('status' in payload), 'compat search response must not use the project envelope');
        assertEqual(payload.results.length, 1, 'compat search default count returns executor results');
        const item = payload.results[0];
        assertEqual(item.snippet, 'compat:10', 'compat search default count is 10');
        assertEqual(item.rerank_score, null, 'compat search rerank_score is null');
        assertEqual(item.summary, '', 'compat search summary is empty');
        assertEqual(item.content, '', 'compat search content is empty');
        assertEqual(item.date, null, 'compat search date is null');
        assertEqual(item.authority, null, 'compat search authority is null');
        assertEqual(item.site_name, 'example.com', 'compat search site_name derived from URL hostname');
        assertEqual(item.site_icon, 'https://example.com/favicon.ico', 'compat search site_icon derived from hostname');
        console.log('✅ compat search shape and defaults');
    } finally {
        await daemon.close();
    }
}

async function testSearchCountAndEnginesExtension(): Promise<void> {
    const daemon = await startLocalDaemon(createStubRuntime(), { port: 0, version: 'compat-test' });
    try {
        const counted = await postJson<{ results: DeepSeekSearchItem[] }>(daemon.baseUrl, '/v1/tools/search', {
            query: 'compat',
            count: 3
        });
        assertEqual(counted.response.status, 200, 'compat search count http status');
        assertEqual(counted.payload.results[0].snippet, 'compat:3', 'compat search count maps to executor limit');

        const engined = await postJson<{ results: DeepSeekSearchItem[] }>(daemon.baseUrl, '/v1/tools/search', {
            query: 'compat',
            count: 2,
            engines: ['startpage']
        });
        assertEqual(engined.response.status, 200, 'compat search engines http status');
        assertEqual(engined.payload.results[0].site_name, 'startpage.example.com', 'compat search engines extension is honored');
        console.log('✅ compat search count and engines extension');
    } finally {
        await daemon.close();
    }
}

async function testSearchValidation(): Promise<void> {
    const daemon = await startLocalDaemon(createStubRuntime(), { port: 0, version: 'compat-test' });
    try {
        const missing = await postJson<DeepSeekErrorBody>(daemon.baseUrl, '/v1/tools/search', {});
        assertEqual(missing.response.status, 400, 'compat search missing query http status');
        assertEqual(missing.payload.error.type, 'invalid_request_error', 'compat search missing query error type');
        assertEqual(missing.payload.error.code, null, 'compat search error code is null');
        assertEqual(missing.payload.error.param, null, 'compat search error param is null');

        const tooLong = await postJson<DeepSeekErrorBody>(daemon.baseUrl, '/v1/tools/search', {
            query: 'x'.repeat(129)
        });
        assertEqual(tooLong.response.status, 400, 'compat search oversized query http status');

        const badCount = await postJson<DeepSeekErrorBody>(daemon.baseUrl, '/v1/tools/search', {
            query: 'compat',
            count: 0
        });
        assertEqual(badCount.response.status, 400, 'compat search invalid count http status');
        console.log('✅ compat search validation errors');
    } finally {
        await daemon.close();
    }
}

async function testSearchAllEnginesFail(): Promise<void> {
    const daemon = await startLocalDaemon(createStubRuntime(), { port: 0, version: 'compat-test' });
    try {
        const { response, payload } = await postJson<{ results: DeepSeekSearchItem[] }>(daemon.baseUrl, '/v1/tools/search', {
            query: 'compat',
            engines: ['sogou']
        });
        assertEqual(response.status, 200, 'compat search all engines failed http status');
        assertEqual(payload.results.length, 0, 'compat search all engines failed returns empty results');
        console.log('✅ compat search empty results when engines fail');
    } finally {
        await daemon.close();
    }
}

async function testFetchSuccess(): Promise<void> {
    const daemon = await startLocalDaemon(createStubRuntime(), { port: 0, version: 'compat-test' });
    try {
        const { response, payload } = await postJson<{ title: string; content: string } & Record<string, unknown>>(
            daemon.baseUrl,
            '/v1/tools/fetch',
            { url: 'https://example.com' }
        );
        assertEqual(response.status, 200, 'compat fetch http status');
        assert(!('status' in payload), 'compat fetch response must not use the project envelope');
        assertEqual(payload.title, 'Example', 'compat fetch title');
        assertEqual(payload.content, 'ok:50000:plain', 'compat fetch default maxChars is 50000');
        console.log('✅ compat fetch success shape');
    } finally {
        await daemon.close();
    }
}

async function testFetchValidation(): Promise<void> {
    const daemon = await startLocalDaemon(createStubRuntime(), { port: 0, version: 'compat-test' });
    try {
        const missing = await postJson<DeepSeekErrorBody>(daemon.baseUrl, '/v1/tools/fetch', {});
        assertEqual(missing.response.status, 400, 'compat fetch missing url http status');
        assertEqual(missing.payload.error.type, 'invalid_request_error', 'compat fetch missing url error type');

        const privateUrl = await postJson<DeepSeekErrorBody>(daemon.baseUrl, '/v1/tools/fetch', {
            url: 'http://127.0.0.1/x'
        });
        assertEqual(privateUrl.response.status, 400, 'compat fetch private url http status');
        console.log('✅ compat fetch validation errors');
    } finally {
        await daemon.close();
    }
}

async function testFetchFailure(): Promise<void> {
    const daemon = await startLocalDaemon(createStubRuntime(), { port: 0, version: 'compat-test' });
    try {
        const { response, payload } = await postJson<DeepSeekErrorBody>(daemon.baseUrl, '/v1/tools/fetch', {
            url: 'https://example.com/fail'
        });
        assertEqual(response.status, 404, 'compat fetch failure http status');
        assertEqual(payload.error.type, 'api_error', 'compat fetch failure error type');
        console.log('✅ compat fetch failure mapping');
    } finally {
        await daemon.close();
    }
}

async function main(): Promise<void> {
    await testSearchShapeAndDefaults();
    await testSearchCountAndEnginesExtension();
    await testSearchValidation();
    await testSearchAllEnginesFail();
    await testFetchSuccess();
    await testFetchValidation();
    await testFetchFailure();
    console.log('\nDeepSeek compat tests passed.');
}

main()
    .then(() => {
        process.exit(0);
    })
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });
