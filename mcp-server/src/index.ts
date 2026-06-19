#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import {
  CallToolRequestSchema,
  ErrorCode,
  ListResourceTemplatesRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  McpError,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js"
import {
  LlmWikiApiClient,
  type ApiFileNode,
  type ApiGraphNode,
  type ApiReviewItem,
  type ApiReviewsResponse,
  type ApiSearchResult,
} from "./api-client.js"

const VERSION = "0.4.20"
const DEFAULT_PROJECT_ID = "current"
const MAX_TEXT_BYTES = 120_000

const client = new LlmWikiApiClient()

const server = new Server(
  { name: "llm-wiki", version: VERSION },
  { capabilities: { tools: {}, resources: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: "llm_wiki_status",
      description: "Check whether the LLM Wiki desktop local API is reachable and list the current project.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "llm_wiki_projects",
      description: "List known LLM Wiki projects. The response includes currentProject when the desktop app has an active project.",
      inputSchema: {
        type: "object",
        properties: {},
        additionalProperties: false,
      },
    },
    {
      name: "llm_wiki_files",
      description: "List files from a project using the desktop app's API permissions. project_id may be a UUID, filesystem path, or 'current'.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "Project UUID, project path, or 'current'. Defaults to current." },
          root: { type: "string", enum: ["wiki", "sources", "all"], description: "Tree root to list. Defaults to wiki." },
          recursive: { type: "boolean", description: "Whether to list recursively. Defaults to true." },
          max_files: { type: "number", description: "Maximum files returned by the local API. Max 10000." },
        },
        additionalProperties: false,
      },
    },
    {
      name: "llm_wiki_read_file",
      description: "Read a text file from a project through the desktop app API. Only public project paths such as wiki/ and raw/sources/ are allowed by the API.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "Project UUID, project path, or 'current'. Defaults to current." },
          path: { type: "string", description: "Project-relative file path, for example wiki/index.md." },
        },
        required: ["path"],
        additionalProperties: false,
      },
    },
    {
      name: "llm_wiki_reviews",
      description: "List Review tab items from a project. Defaults to unresolved items so agent clients can help manage pending wiki review work.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "Project UUID, project path, or 'current'. Defaults to current." },
          status: { type: "string", enum: ["unresolved", "resolved", "all"], description: "Review status filter. Defaults to unresolved." },
          type: { type: "string", description: "Optional Review item type filter, for example missing-page, duplicate, contradiction, confirm, or suggestion." },
          limit: { type: "number", description: "Maximum review items returned. The local API clamps to its configured maximum." },
        },
        additionalProperties: false,
      },
    },
    {
      name: "llm_wiki_search",
      description: "Search a project using the same backend keyword/vector retrieval used by the desktop API.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "Project UUID, project path, or 'current'. Defaults to current." },
          query: { type: "string", description: "Search query." },
          top_k: { type: "number", description: "Maximum results. The local API clamps to its configured maximum." },
          include_content: { type: "boolean", description: "Include full page content in results when supported by the API." },
        },
        required: ["query"],
        additionalProperties: false,
      },
    },
    {
      name: "llm_wiki_graph",
      description: "Query the project knowledge graph through the desktop app API.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "Project UUID, project path, or 'current'. Defaults to current." },
          q: { type: "string", description: "Optional text filter." },
          node_type: { type: "string", description: "Optional node type filter." },
          limit: { type: "number", description: "Maximum nodes. The local API clamps to its configured maximum." },
        },
        additionalProperties: false,
      },
    },
    {
      name: "llm_wiki_rescan_sources",
      description: "Trigger the desktop app's source folder rescan for a project, using the user's Source Watch rules.",
      inputSchema: {
        type: "object",
        properties: {
          project_id: { type: "string", description: "Project UUID, project path, or 'current'. Defaults to current." },
        },
        additionalProperties: false,
      },
    },
  ],
}))

// === resources handlers ===
// URI scheme: llm-wiki://<path>
//   llm-wiki://status
//   llm-wiki://projects/<projectId>/files[?root=wiki|sources|all]
//   llm-wiki://projects/<projectId>/files/<relativePath>
//   llm-wiki://projects/<projectId>/reviews[?status=unresolved|resolved|all&limit=N]
//   llm-wiki://projects/<projectId>/graph[?limit=N&nodeType=...]
//   llm-wiki://projects/<projectId>/search?q=<query>[&top_k=N]
server.setRequestHandler(ListResourcesRequestSchema, async () => {
  const health = await client.health().catch(() => null)
  const projectsResp = await client.projects().catch(() => ({ projects: [] as Array<{ id: string; name: string; path: string; current: boolean }>, currentProject: null as { id: string; name: string; path: string; current: boolean } | null }))
  const current = projectsResp.currentProject?.id ?? DEFAULT_PROJECT_ID
  const base: Array<{ uri: string; name: string; description?: string; mimeType?: string }> = [
    { uri: "llm-wiki://status", name: "LLM Wiki server status", mimeType: "application/json" },
  ]
  for (const project of projectsResp.projects ?? []) {
    const pid = encodeURIComponent(project.id)
    base.push({ uri: `llm-wiki://projects/${pid}/files`, name: `Files for ${project.name}`, mimeType: "text/markdown" })
    base.push({ uri: `llm-wiki://projects/${pid}/files/wiki/index.md`, name: `Wiki index for ${project.name}`, mimeType: "text/markdown" })
    base.push({ uri: `llm-wiki://projects/${pid}/reviews`, name: `Review items for ${project.name}`, mimeType: "text/markdown" })
    base.push({ uri: `llm-wiki://projects/${pid}/graph`, name: `Knowledge graph for ${project.name}`, mimeType: "text/markdown" })
  }
  if (current !== "current") {
    // also list 'current' convenience URIs
    base.push({ uri: `llm-wiki://projects/current/files`, name: "Files for the current project", mimeType: "text/markdown" })
    base.push({ uri: `llm-wiki://projects/current/files/wiki/index.md`, name: "Wiki index for the current project", mimeType: "text/markdown" })
    base.push({ uri: `llm-wiki://projects/current/reviews`, name: "Review items for the current project", mimeType: "text/markdown" })
    base.push({ uri: `llm-wiki://projects/current/graph`, name: "Knowledge graph for the current project", mimeType: "text/markdown" })
  }
  // silence unused warning when health is not reachable
  void health
  return { resources: base as any[] }
})

server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => ({
  resourceTemplates: [
    {
      uriTemplate: "llm-wiki://projects/{projectId}/files/{path*}",
      name: "Read a project file",
      description: "Read a text file from a LLM Wiki project. path* is the project-relative path (e.g. wiki/index.md).",
      mimeType: "text/markdown",
    },
    {
      uriTemplate: "llm-wiki://projects/{projectId}/files",
      name: "List project files",
      description: "List files for a LLM Wiki project. Query parameters: root=wiki|sources|all, recursive=true|false, max_files=N.",
      mimeType: "text/markdown",
    },
    {
      uriTemplate: "llm-wiki://projects/{projectId}/reviews",
      name: "Review items",
      description: "Review tab items for a project. Query parameters: status=unresolved|resolved|all, limit=N, type=missing-page etc.",
      mimeType: "text/markdown",
    },
    {
      uriTemplate: "llm-wiki://projects/{projectId}/graph",
      name: "Knowledge graph",
      description: "Knowledge graph for a project. Query parameters: q=text, nodeType=type, limit=N.",
      mimeType: "text/markdown",
    },
    {
      uriTemplate: "llm-wiki://projects/{projectId}/search?q={query}",
      name: "Search a project",
      description: "Full-text/vector search within a project. Optional query parameters: top_k=N, include_content=true|false.",
      mimeType: "text/markdown",
    },
  ],
}))

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const raw = typeof request.params.uri === "string" ? request.params.uri : ""
  const uri = parseLlmWikiUri(raw)
  if (!uri) {
    throw new McpError(ErrorCode.InvalidParams, `Unsupported URI: ${raw}. Use llm-wiki:// scheme.`)
  }
  try {
    if (uri.kind === "status") {
      const [health, projects] = await Promise.all([
        client.health(),
        client.projects().catch(() => ({ projects: [], currentProject: null })),
      ])
      return jsonContentResult({ ...health, ...projects })
    }
    await assertMcpEnabled()
    if (uri.kind === "file") {
      const { path, content } = await client.fileContent(uri.projectId, uri.filePath)
      return markdownContentResult(`# ${path}\n\n${truncateText(content, MAX_TEXT_BYTES)}`, `llm-wiki://projects/${encodeURIComponent(uri.projectId)}/files/${uri.filePath}`)
    }
    if (uri.kind === "files") {
      const response = await client.files(uri.projectId, {
        root: enumArg(uri.params.root, ["wiki", "sources", "all"] as const, "wiki"),
        recursive: boolArg(parseBoolean(uri.params.recursive), true),
        maxFiles: numberArg(parseNumber(uri.params.max_files)),
      })
      return markdownContentResult(formatFileTree(response.files, response.truncated))
    }
    if (uri.kind === "reviews") {
      const reviews = await client.reviews(uri.projectId, {
        status: enumArg(uri.params.status, ["unresolved", "resolved", "all"] as const, "unresolved"),
        type: optionalStringArg(uri.params.type),
        limit: numberArg(parseNumber(uri.params.limit)),
      })
      return markdownContentResult(formatReviews(reviews))
    }
    if (uri.kind === "graph") {
      const graph = await client.graph(uri.projectId, {
        q: optionalStringArg(uri.params.q),
        nodeType: optionalStringArg(uri.params.node_type),
        limit: numberArg(parseNumber(uri.params.limit)),
      })
      return markdownContentResult(formatGraph(graph.nodes, graph.edges))
    }
    if (uri.kind === "search") {
      const query = stringArg(uri.params.q, "q")
      const search = await client.search(uri.projectId, query, {
        topK: numberArg(parseNumber(uri.params.top_k)),
        includeContent: boolArg(parseBoolean(uri.params.include_content), false),
      })
      return markdownContentResult(formatSearchResults(query, search))
    }
    throw new McpError(ErrorCode.InvalidParams, `Unsupported resource: ${raw}`)
  } catch (err) {
    if (err instanceof McpError) throw err
    throw new McpError(
      ErrorCode.InternalError,
      err instanceof Error ? err.message : String(err),
    )
  }
})

function jsonContentResult(obj: unknown): { contents: Array<{ type: string; mimeType: string; text: string }> } {
  return {
    contents: [{ type: "text", mimeType: "application/json", text: JSON.stringify(obj, null, 2) }],
  }
}

function markdownContentResult(text: string, _uri?: string): { contents: Array<{ type: string; mimeType: string; text: string; uri?: string }> } {
  return {
    contents: [{ type: "text", mimeType: "text/markdown", text, uri: _uri }],
  }
}

type ResourceUri =
  | { kind: "status" }
  | { kind: "files"; projectId: string; params: Record<string, string> }
  | { kind: "file"; projectId: string; filePath: string; params: Record<string, string> }
  | { kind: "reviews"; projectId: string; params: Record<string, string> }
  | { kind: "graph"; projectId: string; params: Record<string, string> }
  | { kind: "search"; projectId: string; params: Record<string, string> }

function parseLlmWikiUri(raw: string): ResourceUri | null {
  if (!raw || typeof raw !== "string") return null
  const match = /^llm-wiki:\/\/(.+)$/.exec(raw)
  if (!match) return null
  // split path and query
  const question = match[1].indexOf("?")
  let pathPart: string
  let queryPart: string
  if (question === -1) {
    pathPart = match[1]
    queryPart = ""
  } else {
    pathPart = match[1].slice(0, question)
    queryPart = match[1].slice(question + 1)
  }
  const params: Record<string, string> = {}
  for (const pair of queryPart.split("&")) {
    if (!pair) continue
    const eq = pair.indexOf("=")
    const key = decodeURIComponent(eq === -1 ? pair : pair.slice(0, eq))
    const value = decodeURIComponent(eq === -1 ? "" : pair.slice(eq + 1))
    if (key) params[key] = value
  }
  const segments = pathPart.split("/").map((s) => decodeURIComponent(s))
  if (segments.length === 1 && segments[0] === "status") return { kind: "status" }
  if (segments.length >= 2 && segments[0] === "projects") {
    const projectId = segments[1] || DEFAULT_PROJECT_ID
    if (segments.length === 2) return null
    const rest = segments.slice(2)
    if (rest[0] === "files") {
      if (rest.length === 1) return { kind: "files", projectId, params }
      return { kind: "file", projectId, filePath: rest.slice(1).join("/"), params }
    }
    if (rest[0] === "reviews" && rest.length === 1) return { kind: "reviews", projectId, params }
    if (rest[0] === "graph" && rest.length === 1) return { kind: "graph", projectId, params }
    if (rest[0] === "search" && rest.length === 1) return { kind: "search", projectId, params }
  }
  return null
}

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value
  if (typeof value !== "string") return undefined
  const v = value.trim().toLowerCase()
  if (v === "true" || v === "1") return true
  if (v === "false" || v === "0" || v === "") return false
  return undefined
}

function parseNumber(value: unknown): number | undefined {
  if (typeof value === "number") return value
  if (typeof value !== "string") return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

// === tools handlers ===
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const args = asObject(request.params.arguments ?? {})
  try {
    switch (request.params.name) {
      case "llm_wiki_status": {
        const [health, projects] = await Promise.all([
          client.health(),
          client.projects().catch(() => ({ projects: [], currentProject: null })),
        ])
        return textResult(JSON.stringify({ ...health, ...projects }, null, 2))
      }
      case "llm_wiki_projects": {
        await assertMcpEnabled()
        return textResult(JSON.stringify(await client.projects(), null, 2))
      }
      case "llm_wiki_files": {
        await assertMcpEnabled()
        const response = await client.files(projectId(args), {
          root: enumArg(args.root, ["wiki", "sources", "all"] as const, "wiki"),
          recursive: boolArg(args.recursive, true),
          maxFiles: numberArg(args.max_files),
        })
        return textResult(formatFileTree(response.files, response.truncated))
      }
      case "llm_wiki_read_file": {
        await assertMcpEnabled()
        const relPath = stringArg(args.path, "path")
        const { path, content } = await client.fileContent(projectId(args), relPath)
        return textResult(`# ${path}\n\n${truncateText(content, MAX_TEXT_BYTES)}`)
      }
      case "llm_wiki_reviews": {
        await assertMcpEnabled()
        const reviews = await client.reviews(projectId(args), {
          status: enumArg(args.status, ["unresolved", "resolved", "all"] as const, "unresolved"),
          type: optionalStringArg(args.type),
          limit: numberArg(args.limit),
        })
        return textResult(formatReviews(reviews))
      }
      case "llm_wiki_search": {
        await assertMcpEnabled()
        const rawQuery = pickStringArg(args, ["query", "q"])
        const query = stringArg(rawQuery, "query (or q)")
        const search = await client.search(projectId(args), query, {
          topK: numberArg(args.top_k),
          includeContent: boolArg(args.include_content, false),
        })
        return textResult(formatSearchResults(query, search))
      }
      case "llm_wiki_graph": {
        await assertMcpEnabled()
        const graph = await client.graph(projectId(args), {
          q: optionalStringArg(args.q),
          nodeType: optionalStringArg(args.node_type),
          limit: numberArg(args.limit),
        })
        return textResult(formatGraph(graph.nodes, graph.edges))
      }
      case "llm_wiki_rescan_sources": {
        await assertMcpEnabled()
        return textResult(JSON.stringify(await client.rescan(projectId(args)), null, 2))
      }
      default:
        throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${request.params.name}`)
    }
  } catch (err) {
    if (err instanceof McpError) throw err
    throw new McpError(
      ErrorCode.InternalError,
      err instanceof Error ? err.message : String(err),
    )
  }
})

async function assertMcpEnabled(): Promise<void> {
  const health = await client.health()
  if (health.mcpEnabled === false) {
    throw new McpError(
      ErrorCode.InvalidRequest,
      "LLM Wiki MCP access is disabled. Enable Settings -> API + MCP -> Enable MCP access in the desktop app.",
    )
  }
}

function textResult(text: string) {
  return {
    content: [{ type: "text" as const, text }],
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  return value as Record<string, unknown>
}

function projectId(args: Record<string, unknown>): string {
  return optionalStringArg(args.project_id) ?? DEFAULT_PROJECT_ID
}

function stringArg(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new McpError(ErrorCode.InvalidParams, `${name} is required`)
  }
  return value.trim()
}

function pickStringArg(args: Record<string, unknown>, names: string[]): unknown {
  for (const name of names) {
    if (typeof args[name] === "string") return args[name]
  }
  for (const name of names) {
    if (args[name] !== undefined) return args[name]
  }
  return undefined
}

function optionalStringArg(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined
}

function boolArg(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback
}

function numberArg(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function enumArg<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === "string" && allowed.includes(value as T) ? value as T : fallback
}

function truncateText(value: string, maxBytes: number): string {
  const bytes = Buffer.byteLength(value, "utf8")
  if (bytes <= maxBytes) return value
  let out = ""
  let used = 0
  for (const ch of value) {
    const size = Buffer.byteLength(ch, "utf8")
    if (used + size > maxBytes) break
    out += ch
    used += size
  }
  return `${out}\n\n[truncated: ${bytes - used} bytes omitted]`
}

function formatFileTree(files: ApiFileNode[], truncated = false): string {
  if (files.length === 0) return "No files found."
  const lines: string[] = truncated
    ? ["[warning] File tree was truncated by the LLM Wiki API maxFiles limit.", ""]
    : []
  const walk = (nodes: ApiFileNode[], depth: number) => {
    for (const node of nodes) {
      const prefix = "  ".repeat(depth)
      lines.push(`${prefix}${node.isDir ? "📁" : "📄"} ${node.path}`)
      if (node.children) walk(node.children, depth + 1)
    }
  }
  walk(files, 0)
  return lines.join("\n")
}

function formatSearchResults(query: string, search: { results: ApiSearchResult[]; mode?: string; tokenHits?: number; vectorHits?: number }): string {
  const { results } = search
  if (results.length === 0) return `No results for "${query}".`
  const meta = [
    search.mode ? `Mode: ${search.mode}` : null,
    typeof search.tokenHits === "number" ? `Token hits: ${search.tokenHits}` : null,
    typeof search.vectorHits === "number" ? `Vector hits: ${search.vectorHits}` : null,
  ].filter(Boolean)
  const lines = [`# Search results for "${query}"`, ...(meta.length > 0 ? [meta.join(" | ")] : []), ""]
  results.forEach((result, index) => {
    lines.push(`## ${index + 1}. ${result.title}`)
    lines.push(`Path: ${result.path}`)
    lines.push(`Score: ${result.score.toFixed(6)}${typeof result.vectorScore === "number" ? ` | Vector score: ${result.vectorScore.toFixed(6)}` : ""}`)
    if (result.snippet) lines.push(`Snippet: ${result.snippet}`)
    if (result.images && result.images.length > 0) {
      lines.push(`Images: ${result.images.map((image) => image.url).join(", ")}`)
    }
    lines.push("")
  })
  return lines.join("\n")
}

function formatReviews(response: ApiReviewsResponse): string {
  const { reviews } = response
  if (reviews.length === 0) return `No ${response.status} review items found.`
  const lines = [
    "# Review items",
    "",
    `Status: ${response.status}`,
    `Count: ${response.count}`,
    "",
  ]
  reviews.forEach((review, index) => {
    lines.push(`## ${index + 1}. ${review.title || review.id}`)
    lines.push(`ID: ${review.id}`)
    lines.push(`Type: ${review.type}`)
    lines.push(`Resolved: ${review.resolved ? "yes" : "no"}`)
    if (review.sourcePath) lines.push(`Source: ${review.sourcePath}`)
    if (review.affectedPages && review.affectedPages.length > 0) {
      lines.push(`Affected pages: ${review.affectedPages.join(", ")}`)
    }
    if (review.searchQueries && review.searchQueries.length > 0) {
      lines.push(`Search queries: ${review.searchQueries.join(", ")}`)
    }
    if (review.description) lines.push(`Description: ${review.description}`)
    const optionSummary = formatReviewOptions(review)
    if (optionSummary) lines.push(`Options: ${optionSummary}`)
    lines.push("")
  })
  return lines.join("\n")
}

function formatReviewOptions(review: ApiReviewItem): string {
  if (!review.options || review.options.length === 0) return ""
  return review.options
    .map((option) => option.label ? `${option.label} (${option.action})` : option.action)
    .join(", ")
}

function formatGraph(nodes: ApiGraphNode[], edges: Array<{ source: string; target: string; weight?: number }>): string {
  const typeCounts = new Map<string, number>()
  for (const node of nodes) typeCounts.set(node.type, (typeCounts.get(node.type) ?? 0) + 1)
  const lines = [
    "# Knowledge graph",
    "",
    `Nodes: ${nodes.length}`,
    `Edges: ${edges.length}`,
    "",
    "## Node types",
    ...[...typeCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => `- ${type}: ${count}`),
    "",
    "## Top nodes",
    ...nodes
      .slice()
      .sort((a, b) => (b.linkCount ?? 0) - (a.linkCount ?? 0))
      .slice(0, 30)
      .map((node) => `- ${node.label} (${node.type}, ${node.linkCount ?? 0} links)${node.path ? ` — ${node.path}` : ""}`),
  ]
  return lines.join("\n")
}

async function main(): Promise<void> {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error(`LLM Wiki MCP server v${VERSION} connected to ${process.env.LLM_WIKI_API_BASE_URL ?? "http://127.0.0.1:19828"}`)
}

main().catch((err) => {
  console.error("Failed to start LLM Wiki MCP server:", err)
  process.exit(1)
})
