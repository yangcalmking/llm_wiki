export const DEFAULT_API_BASE_URL = "http://127.0.0.1:19828";
export function normalizeBaseUrl(value) {
    const raw = (value ?? DEFAULT_API_BASE_URL).trim() || DEFAULT_API_BASE_URL;
    return raw.replace(/\/+$/, "");
}
function apiPath(path) {
    return path.startsWith("/api/v1") ? path : `/api/v1${path.startsWith("/") ? path : `/${path}`}`;
}
function requireObject(value, context) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${context}: expected JSON object`);
    }
    return value;
}
function numberOrUndefined(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
export class LlmWikiApiClient {
    baseUrl;
    token;
    fetchImpl;
    constructor(options = {}) {
        this.baseUrl = normalizeBaseUrl(options.baseUrl ?? process.env.LLM_WIKI_API_BASE_URL);
        this.token = options.token ?? process.env.LLM_WIKI_API_TOKEN;
        this.fetchImpl = options.fetchImpl ?? fetch;
    }
    async health() {
        return this.request("/health", { auth: false });
    }
    async projects() {
        const json = await this.request("/projects");
        const projects = Array.isArray(json.projects) ? json.projects.map(parseProject) : [];
        const currentProject = json.currentProject ? parseProject(json.currentProject) : null;
        return { projects, currentProject };
    }
    async files(projectId = "current", options = {}) {
        const params = new URLSearchParams();
        params.set("root", options.root ?? "wiki");
        if (options.recursive !== undefined)
            params.set("recursive", String(options.recursive));
        if (options.maxFiles !== undefined)
            params.set("maxFiles", String(options.maxFiles));
        const json = await this.request(`/projects/${encodeURIComponent(projectId)}/files?${params.toString()}`);
        return {
            files: Array.isArray(json.files) ? json.files.map(parseFileNode) : [],
            truncated: json.truncated === true,
        };
    }
    async fileContent(projectId = "current", path) {
        const params = new URLSearchParams({ path });
        const json = await this.request(`/projects/${encodeURIComponent(projectId)}/files/content?${params.toString()}`);
        return {
            path: typeof json.path === "string" ? json.path : path,
            content: typeof json.content === "string" ? json.content : "",
        };
    }
    async reviews(projectId = "current", options = {}) {
        const params = new URLSearchParams();
        if (options.status)
            params.set("status", options.status);
        if (options.type)
            params.set("type", options.type);
        if (options.limit !== undefined)
            params.set("limit", String(options.limit));
        const suffix = params.toString() ? `?${params.toString()}` : "";
        const json = await this.request(`/projects/${encodeURIComponent(projectId)}/reviews${suffix}`);
        const reviews = Array.isArray(json.reviews) ? json.reviews.map(parseReviewItem) : [];
        return {
            projectId: typeof json.projectId === "string" ? json.projectId : undefined,
            status: parseReviewStatus(json.status),
            count: numberOrUndefined(json.count) ?? reviews.length,
            reviews,
        };
    }
    async search(projectId = "current", query, options = {}) {
        const json = await this.request(`/projects/${encodeURIComponent(projectId)}/search`, {
            method: "POST",
            body: {
                query,
                topK: options.topK,
                includeContent: options.includeContent,
            },
        });
        return {
            results: Array.isArray(json.results) ? json.results.map(parseSearchResult) : [],
            mode: typeof json.mode === "string" ? json.mode : undefined,
            tokenHits: numberOrUndefined(json.tokenHits),
            vectorHits: numberOrUndefined(json.vectorHits),
        };
    }
    async graph(projectId = "current", options = {}) {
        const params = new URLSearchParams();
        if (options.q)
            params.set("q", options.q);
        if (options.nodeType)
            params.set("nodeType", options.nodeType);
        if (options.limit !== undefined)
            params.set("limit", String(options.limit));
        const suffix = params.toString() ? `?${params.toString()}` : "";
        const json = await this.request(`/projects/${encodeURIComponent(projectId)}/graph${suffix}`);
        return {
            nodes: Array.isArray(json.nodes) ? json.nodes.map(parseGraphNode) : [],
            edges: Array.isArray(json.edges) ? json.edges.map(parseGraphEdge) : [],
        };
    }
    async rescan(projectId = "current") {
        return this.request(`/projects/${encodeURIComponent(projectId)}/sources/rescan`, {
            method: "POST",
        });
    }
    async request(path, options = {}) {
        const url = `${this.baseUrl}${apiPath(path)}`;
        const headers = { Accept: "application/json" };
        if (options.auth !== false && this.token?.trim()) {
            headers.Authorization = `Bearer ${this.token.trim()}`;
        }
        if (options.body !== undefined)
            headers["Content-Type"] = "application/json";
        let response;
        try {
            response = await this.fetchImpl(url, {
                method: options.method ?? (options.body === undefined ? "GET" : "POST"),
                headers,
                body: options.body === undefined ? undefined : JSON.stringify(options.body),
            });
        }
        catch (err) {
            throw new Error(`LLM Wiki API request failed. Is the desktop app running? ${err instanceof Error ? err.message : String(err)}`);
        }
        const text = await response.text();
        let json;
        try {
            json = text ? requireObject(JSON.parse(text), "LLM Wiki API response") : {};
        }
        catch (err) {
            throw new Error(`LLM Wiki API returned non-JSON response (${response.status}): ${text.slice(0, 300)}${err instanceof Error ? ` (${err.message})` : ""}`);
        }
        if (!response.ok || json.ok === false) {
            const message = typeof json.error === "string" ? json.error : response.statusText;
            throw new Error(`LLM Wiki API ${response.status}: ${message}`);
        }
        return json;
    }
}
function parseProject(value) {
    const obj = requireObject(value, "project");
    return {
        id: String(obj.id ?? ""),
        name: String(obj.name ?? ""),
        path: String(obj.path ?? ""),
        current: obj.current === true,
    };
}
function parseFileNode(value) {
    const obj = requireObject(value, "file node");
    const children = Array.isArray(obj.children) ? obj.children.map(parseFileNode) : undefined;
    return {
        name: String(obj.name ?? ""),
        path: String(obj.path ?? ""),
        isDir: obj.isDir === true || obj.is_dir === true,
        ...(children ? { children } : {}),
    };
}
function parseSearchResult(value) {
    const obj = requireObject(value, "search result");
    return {
        path: String(obj.path ?? ""),
        title: String(obj.title ?? ""),
        snippet: String(obj.snippet ?? ""),
        score: numberOrUndefined(obj.score) ?? 0,
        titleMatch: obj.titleMatch === true,
        images: Array.isArray(obj.images) ? obj.images.map((image) => {
            const item = requireObject(image, "image");
            return { url: String(item.url ?? ""), alt: String(item.alt ?? "") };
        }) : [],
        vectorScore: numberOrUndefined(obj.vectorScore) ?? null,
    };
}
function parseReviewStatus(value) {
    return value === "resolved" || value === "all" ? value : "unresolved";
}
function stringArray(value) {
    if (!Array.isArray(value))
        return undefined;
    return value.map((item) => String(item));
}
function parseReviewItem(value) {
    const obj = requireObject(value, "review item");
    return {
        id: String(obj.id ?? ""),
        type: String(obj.type ?? ""),
        title: String(obj.title ?? ""),
        description: String(obj.description ?? ""),
        sourcePath: typeof obj.sourcePath === "string" ? obj.sourcePath : undefined,
        affectedPages: stringArray(obj.affectedPages),
        searchQueries: stringArray(obj.searchQueries),
        options: Array.isArray(obj.options) ? obj.options.map((option) => {
            const item = requireObject(option, "review option");
            return { label: String(item.label ?? ""), action: String(item.action ?? "") };
        }) : [],
        resolved: obj.resolved === true,
        resolvedAction: typeof obj.resolvedAction === "string" ? obj.resolvedAction : undefined,
        createdAt: numberOrUndefined(obj.createdAt) ?? 0,
    };
}
function parseGraphNode(value) {
    const obj = requireObject(value, "graph node");
    return {
        id: String(obj.id ?? ""),
        label: String(obj.label ?? ""),
        type: String(obj.nodeType ?? obj.type ?? "other"),
        path: typeof obj.path === "string" ? obj.path : undefined,
        linkCount: numberOrUndefined(obj.linkCount),
        weight: numberOrUndefined(obj.weight),
    };
}
function parseGraphEdge(value) {
    const obj = requireObject(value, "graph edge");
    return {
        source: String(obj.source ?? ""),
        target: String(obj.target ?? ""),
        weight: numberOrUndefined(obj.weight),
    };
}
