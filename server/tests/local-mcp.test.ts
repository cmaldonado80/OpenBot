import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import { customUrlRefusal, localMcpUrl } from "../src/plugins/catalogue";
import { listTools } from "../src/plugins/mcp";
import { createPluginRoutes } from "../src/plugins/routes";
import {
  createPluginStore,
  type PluginStoreOptions,
} from "../src/plugins/store";
import { testEnvironment } from "./support/environment";

const environment = testEnvironment();
const endpoint = "http://127.0.0.1:8301/mcp";

describe("explicit local MCP connections", () => {
  test("default configuration keeps loopback refused", () => {
    expect(loadConfig(environment).localMcpUrls).toEqual([]);
    expect(customUrlRefusal(endpoint)).not.toBeNull();
  });

  test("configuration authorizes exactly one loopback port and path", () => {
    const config = loadConfig({
      ...environment,
      OPENBOT_LOCAL_MCP_URLS: ` ${endpoint} `,
    });
    expect(config.localMcpUrls).toEqual([endpoint]);
    expect(customUrlRefusal(endpoint, config.localMcpUrls)).toBeNull();
    for (const other of [
      "http://127.0.0.1:8302/mcp",
      "http://127.0.0.1:8301/admin",
      "http://localhost:8301/mcp",
      "http://169.254.169.254:8301/mcp",
      "http://mcp.example.com:8301/mcp",
    ]) {
      expect(customUrlRefusal(other, config.localMcpUrls)).not.toBeNull();
    }
  });

  test.each([
    "http://127.0.0.1/mcp",
    "http://127.0.0.1:8301/",
    "http://token@127.0.0.1:8301/mcp",
    "http://127.0.0.1:8301/mcp?token=fixture",
    "http://127.0.0.1:8301/mcp?project=fixture",
    "http://127.0.0.1:8301/mcp#section",
    "http://host.docker.internal:8301/mcp",
    "http://192.168.1.1:8301/mcp",
    "https://mcp.example.com/mcp",
    "not a url",
  ])("unsafe local configuration is refused: %s", (url) => {
    expect(localMcpUrl(url)).toBeNull();
    expect(() =>
      loadConfig({ ...environment, OPENBOT_LOCAL_MCP_URLS: url }),
    ).toThrow("OPENBOT_LOCAL_MCP_URLS must name exact");
  });

  test.each(["production", " production "])(
    "local exceptions refuse production startup: %s",
    (nodeEnv) => {
      expect(() =>
        loadConfig({
          ...environment,
          NODE_ENV: nodeEnv,
          KEY_ENCRYPTION_KEY: "b3BlbmJvdC1wcm9kdWN0aW9uLXRlc3Qta2V5LTMyMzI=",
          OPENBOT_LOCAL_MCP_URLS: endpoint,
        }),
      ).toThrow("OPENBOT_LOCAL_MCP_URLS is for local development only");
    },
  );

  test("removing the exception refuses a saved connection before credential or network access", async () => {
    // Only the row read is supplied: reaching the vault, audit or transport is a test failure.
    const database = {
      select: () => ({
        from: () => ({
          where: () => ({
            limit: async () => [
              {
                id: "local-fixture",
                title: "Local fixture",
                url: endpoint,
                provenance: "custom",
                credentialId: null,
              },
            ],
          }),
        }),
      }),
    } as unknown as PluginStoreOptions["database"];
    const store = createPluginStore({
      database,
      auditStore: {} as PluginStoreOptions["auditStore"],
      credentials: {} as PluginStoreOptions["credentials"],
      encryptionKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
      policy: () => ({ mode: "enforce", deny: [], allow: [] }),
    });
    await expect(store.refreshTools("local-fixture")).rejects.toThrow(
      "An MCP server must be reached over https",
    );
    const routes = createPluginRoutes(
      store,
      async (context, next) => {
        context.set("actor", {
          id: "fixture-admin",
          email: "admin@fixture.test",
          role: "admin",
        });
        await next();
      },
      async () => true,
    );
    const response = await routes.request("/servers/local-fixture/refresh", {
      method: "POST",
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: "An MCP server must be reached over https.",
      rule: null,
    });
  });

  test("a local server cannot redirect the client to another endpoint", async () => {
    let destinationRequests = 0;
    const destination = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        destinationRequests++;
        return new Response("should not be reached");
      },
    });
    const redirect = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => Response.redirect(`${destination.url}mcp`, 307),
    });
    try {
      await expect(listTools({ url: `${redirect.url}mcp` })).rejects.toThrow();
      expect(destinationRequests).toBe(0);
    } finally {
      redirect.stop(true);
      destination.stop(true);
    }
  });

  test("the SSE request after initialization also cannot follow a redirect", async () => {
    let destinationRequests = 0;
    let sseRequests = 0;
    const destination = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        destinationRequests++;
        return new Response("", { status: 405 });
      },
    });
    const redirect = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: async (request) => {
        if (request.method === "GET") {
          sseRequests++;
          return Response.redirect(`${destination.url}mcp`, 307);
        }
        if (request.method !== "POST")
          return new Response(null, { status: 202 });
        const message = await request.json();
        if (message.method === "initialize") {
          return Response.json({
            jsonrpc: "2.0",
            id: message.id,
            result: {
              protocolVersion: message.params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "local-fixture", version: "1" },
            },
          });
        }
        if (message.method === "tools/list") {
          // Let the SDK's concurrent SSE request finish before listing closes the transport.
          await Bun.sleep(50);
          return Response.json({
            jsonrpc: "2.0",
            id: message.id,
            result: { tools: [] },
          });
        }
        return new Response(null, { status: 202 });
      },
    });
    try {
      expect(await listTools({ url: `${redirect.url}mcp` })).toEqual([]);
      expect(sseRequests).toBeGreaterThan(0);
      expect(destinationRequests).toBe(0);
    } finally {
      redirect.stop(true);
      destination.stop(true);
    }
  });
});
