import { beforeEach, describe, expect, it, vi } from "vitest"
import { hasConfiguredDeepResearchSources, hasConfiguredSearchProvider, resolveSearchConfig, webSearch } from "./web-search"

const fetchMock = vi.fn<typeof fetch>()

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
    ...init,
  })
}

describe("webSearch", () => {
  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal("fetch", fetchMock)
  })

  it("normalizes Tavily results", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      results: [
        { title: "A", url: "https://www.example.com/a", content: "Alpha" },
      ],
    }))

    const out = await webSearch("alpha", { provider: "tavily", apiKey: "tvly" }, 3)

    expect(fetchMock).toHaveBeenCalledWith("https://api.tavily.com/search", expect.objectContaining({
      method: "POST",
    }))
    expect(out).toEqual([
      { title: "A", url: "https://www.example.com/a", snippet: "Alpha", source: "example.com" },
    ])
  })

  it("calls SerpApi Google Search and normalizes organic results", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      organic_results: [
        { title: "Serp result", link: "https://www.serp.example/page", snippet: "Snippet" },
        { title: "Second", link: "https://docs.example/item", snippet: "More" },
      ],
    }))

    const out = await webSearch("knowledge graph", { provider: "serpapi", apiKey: "serp" }, 1)
    const [url, init] = fetchMock.mock.calls[0]
    const parsed = new URL(String(url))

    expect(parsed.origin + parsed.pathname).toBe("https://serpapi.com/search")
    expect(parsed.searchParams.get("engine")).toBe("google")
    expect(parsed.searchParams.get("q")).toBe("knowledge graph")
    expect(parsed.searchParams.get("api_key")).toBe("serp")
    expect(parsed.searchParams.get("num")).toBe("1")
    expect(init).toEqual(expect.objectContaining({ method: "GET" }))
    expect(out).toEqual([
      { title: "Serp result", url: "https://www.serp.example/page", snippet: "Snippet", source: "serp.example" },
    ])
  })

  it("uses SerpApi provider-specific config and selected engine", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      news_results: [
        { title: "News", link: "https://news.example/story", snippet: "Fresh" },
      ],
    }))

    const out = await webSearch(
      "ai policy",
      {
        provider: "serpapi",
        apiKey: "",
        providerConfigs: {
          tavily: { apiKey: "tavily-key" },
          serpapi: { apiKey: "serp-key", serpApiEngine: "google_news" },
        },
      },
      5,
    )
    const parsed = new URL(String(fetchMock.mock.calls[0][0]))

    expect(parsed.searchParams.get("engine")).toBe("google_news")
    expect(parsed.searchParams.get("api_key")).toBe("serp-key")
    expect(out).toEqual([
      { title: "News", url: "https://news.example/story", snippet: "Fresh", source: "news.example" },
    ])
  })

  it("calls SearXNG JSON search with the configured instance and categories", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      results: [
        {
          title: "SearXNG result",
          url: "https://docs.example/page",
          content: "Result content",
          engine: "duckduckgo",
        },
      ],
    }))

    const out = await webSearch(
      "local search",
      {
        provider: "searxng",
        apiKey: "",
        providerConfigs: {
          searxng: {
            searXngUrl: "https://search.example.com",
            searXngCategories: ["general", "news"],
          },
        },
      },
      3,
    )
    const [url, init] = fetchMock.mock.calls[0]
    const parsed = new URL(String(url))

    expect(parsed.origin + parsed.pathname).toBe("https://search.example.com/search")
    expect(parsed.searchParams.get("q")).toBe("local search")
    expect(parsed.searchParams.get("format")).toBe("json")
    expect(parsed.searchParams.get("categories")).toBe("general,news")
    expect(init).toEqual(expect.objectContaining({ method: "GET" }))
    expect(out).toEqual([
      { title: "SearXNG result", url: "https://docs.example/page", snippet: "Result content", source: "docs.example" },
    ])
  })

  it("preserves SearXNG subpath instances when building the search endpoint", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ results: [] }))

    await webSearch(
      "subpath",
      {
        provider: "searxng",
        apiKey: "",
        providerConfigs: {
          searxng: { searXngUrl: "http://localhost:8080/searx/" },
        },
      },
      5,
    )
    const parsed = new URL(String(fetchMock.mock.calls[0][0]))

    expect(parsed.origin + parsed.pathname).toBe("http://localhost:8080/searx/search")
    expect(parsed.searchParams.get("categories")).toBe("general")
  })

  it("surfaces SerpApi JSON errors", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "Invalid API key" }))

    await expect(webSearch("x", { provider: "serpapi", apiKey: "bad" }, 5))
      .rejects.toThrow("SerpApi search failed: Invalid API key")
  })

  it("requires a configured search provider and key", async () => {
    await expect(webSearch("x", { provider: "none", apiKey: "" }, 5))
      .rejects.toThrow("Select a search provider")
    await expect(webSearch("x", { provider: "serpapi", apiKey: "" }, 5))
      .rejects.toThrow("Tavily or SerpApi API key")
    await expect(webSearch("x", { provider: "searxng", apiKey: "" }, 5))
      .rejects.toThrow("SearXNG instance URL")
  })

  it("treats SearXNG instance URLs as configured without an API key", () => {
    expect(hasConfiguredSearchProvider({
      provider: "searxng",
      apiKey: "",
      providerConfigs: {
        searxng: {
          searXngUrl: "http://127.0.0.1:8080",
          searXngCategories: ["general", "science", "it"],
        },
      },
      searXngUrl: "http://127.0.0.1:8080",
      searXngCategories: ["general", "science", "it"],
      serpApiEngine: "google",
    })).toBe(true)
  })

  it("requires an API key for the Ollama Web Search API", async () => {
    await expect(webSearch(
      "official ollama",
      {
        provider: "ollama",
        apiKey: "",
        providerConfigs: {
          ollama: { ollamaUrl: "https://ollama.com" },
        },
      },
      5,
    )).rejects.toThrow("requires an Ollama API key")

    expect(hasConfiguredSearchProvider({
      provider: "ollama",
      apiKey: "",
      providerConfigs: {
        ollama: { ollamaUrl: "https://ollama.com" },
      },
    })).toBe(false)
  })

  it("does not leak a stale top-level Ollama URL into non-Ollama providers", () => {
    const resolved = resolveSearchConfig({
      provider: "serpapi",
      apiKey: "",
      ollamaUrl: "http://localhost:11434",
      providerConfigs: {
        serpapi: { apiKey: "serp-key" },
        ollama: { ollamaUrl: "https://ollama.com" },
      },
    })

    expect(resolved.ollamaUrl).toBe("https://ollama.com")
  })

  it("tracks Deep Research source configuration independently from the active web provider", () => {
    expect(hasConfiguredDeepResearchSources({
      provider: "none",
      apiKey: "",
      deepResearchSource: "anytxt",
      anyTxt: { enabled: true, endpoint: "http://127.0.0.1:9920" },
    })).toBe(true)

    expect(hasConfiguredDeepResearchSources({
      provider: "none",
      apiKey: "",
      deepResearchSource: "anytxt",
      anyTxt: { enabled: false, endpoint: "http://127.0.0.1:9920" },
    })).toBe(false)

    expect(hasConfiguredDeepResearchSources({
      provider: "none",
      apiKey: "",
      deepResearchSource: "web",
      anyTxt: { endpoint: "http://127.0.0.1:9920" },
    })).toBe(false)

    expect(resolveSearchConfig({
      provider: "none",
      apiKey: "",
    }).deepResearchSource).toBe("web")
  })

  it("calls the Ollama Web Search API with Bearer auth", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      results: [
        { title: "Official", url: "https://ollama.example/search", content: "Cloud result" },
      ],
    }))

    const out = await webSearch(
      "official ollama",
      {
        provider: "ollama",
        apiKey: "",
        providerConfigs: {
          ollama: { apiKey: "ollama-key" },
        },
      },
      1,
    )
    const [url, init] = fetchMock.mock.calls[0]

    expect(url).toBe("https://ollama.com/api/web_search")
    expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer ollama-key")
    expect(JSON.parse(String(init?.body))).toEqual({ query: "official ollama", max_results: 1 })
    expect(out).toEqual([
      { title: "Official", url: "https://ollama.example/search", snippet: "Cloud result", source: "ollama.example" },
    ])
    expect(hasConfiguredSearchProvider({
      provider: "ollama",
      apiKey: "",
      providerConfigs: {
        ollama: { apiKey: "ollama-key" },
      },
    })).toBe(true)
  })

  it("surfaces Ollama authentication guidance for 401 responses", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "unauthorized" }, { status: 401 }))

    await expect(webSearch(
      "official ollama",
      {
        provider: "ollama",
        apiKey: "",
        providerConfigs: {
          ollama: { apiKey: "bad-key" },
        },
      },
      5,
    )).rejects.toThrow("Check your Ollama API key")
  })

  it("calls a custom POST endpoint with Bearer auth and the configured model + search_type", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      results: [
        { title: "Custom hit", url: "https://custom.example/page", snippet: "Fresh content" },
        { title: "Second", url: "https://custom.example/two", snippet: "Second snippet" },
      ],
    }))

    const out = await webSearch(
      "query for custom",
      {
        provider: "custom",
        apiKey: "",
        customEndpoint: "http://localhost:20128/v1/search",
        customModel: "tavily",
        customSearchType: "web",
        providerConfigs: {
          custom: { apiKey: "sk-custom-token" },
        },
      },
      5,
    )
    const [url, init] = fetchMock.mock.calls[0]

    expect(url).toBe("http://localhost:20128/v1/search")
    expect(init).toEqual(expect.objectContaining({ method: "POST" }))
    const headers = (init?.headers as Record<string, string>) ?? {}
    expect(headers["Content-Type"]).toBe("application/json")
    expect(headers["Authorization"]).toBe("Bearer sk-custom-token")
    const body = JSON.parse(String(init?.body))
    expect(body).toEqual({
      model: "tavily",
      query: "query for custom",
      search_type: "web",
      max_results: 5,
    })
    expect(out).toEqual([
      { title: "Custom hit", url: "https://custom.example/page", snippet: "Fresh content", source: "custom.example" },
      { title: "Second", url: "https://custom.example/two", snippet: "Second snippet", source: "custom.example" },
    ])
    expect(hasConfiguredSearchProvider({
      provider: "custom",
      apiKey: "",
      providerConfigs: {
        custom: {
          customEndpoint: "http://localhost:20128/v1/search",
          customModel: "tavily",
          customSearchType: "web",
          apiKey: "sk-custom-token",
        },
      },
    })).toBe(true)
  })

  it("treats a custom provider with only an endpoint (no API key) as configured", () => {
    expect(hasConfiguredSearchProvider({
      provider: "custom",
      apiKey: "",
      providerConfigs: {
        custom: { customEndpoint: "http://localhost:20128/v1/search" },
      },
    })).toBe(true)
    expect(hasConfiguredSearchProvider({
      provider: "custom",
      apiKey: "",
      customEndpoint: "",
    })).toBe(false)
  })

  it("calls a custom endpoint without Bearer auth when no token is provided", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ results: [] }))

    await webSearch(
      "unauth",
      {
        provider: "custom",
        apiKey: "",
        providerConfigs: {
          custom: { customEndpoint: "https://search.local/query" },
        },
      },
      3,
    )
    const init = fetchMock.mock.calls[0][1] as { headers?: Record<string, string> } | undefined
    const headers = init?.headers ?? {}

    expect(headers["Authorization"]).toBeUndefined()
    expect(headers["Content-Type"]).toBe("application/json")
    const body = JSON.parse(String((init as { body?: string })?.body ?? ""))
    expect(body.query).toBe("unauth")
    expect(body.max_results).toBe(3)
  })

  it("requires a custom endpoint to run a web search", async () => {
    await expect(webSearch("x", { provider: "custom", apiKey: "", customEndpoint: "" }, 5))
      .rejects.toThrow("custom search endpoint")
  })

  it("surfaces non-2xx responses from the custom endpoint with the status code", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, { status: 500 }))

    await expect(webSearch(
      "failure",
      {
        provider: "custom",
        apiKey: "",
        providerConfigs: {
          custom: { customEndpoint: "http://localhost:20128/v1/search" },
        },
      },
      5,
    )).rejects.toThrow(/Custom search failed \(500\)/)
  })

  it("resolves custom endpoint values from providerConfigs and defaults model/search_type", () => {
    const resolved = resolveSearchConfig({
      provider: "custom",
      apiKey: "",
      customEndpoint: "http://localhost:20128/v1/search",
      customModel: "tavily",
      customSearchType: "web",
    })

    expect(resolved.customEndpoint).toBe("http://localhost:20128/v1/search")
    expect(resolved.customModel).toBe("tavily")
    expect(resolved.customSearchType).toBe("web")
  })

  it("uses the providerConfigs override for the custom endpoint over the top-level value", () => {
    const resolved = resolveSearchConfig({
      provider: "custom",
      apiKey: "top-level-key",
      customEndpoint: "http://127.0.0.1:9999/wrong",
      customModel: "wrong",
      customSearchType: "wrong",
      providerConfigs: {
        custom: {
          apiKey: "override-key",
          customEndpoint: "http://localhost:20128/v1/search",
          customModel: "tavily",
          customSearchType: "web",
        },
      },
    })

    expect(resolved.customEndpoint).toBe("http://localhost:20128/v1/search")
    expect(resolved.customModel).toBe("tavily")
    expect(resolved.customSearchType).toBe("web")
    expect(resolved.apiKey).toBe("override-key")
  })
})
