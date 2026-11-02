// An in-process MCP client for a server, over a linked in-memory transport
// pair. Both halves of the pair come from the client package (the SDK requires
// one package per pair).
import { Client, InMemoryTransport } from "@modelcontextprotocol/client";
import type { McpServer } from "@modelcontextprotocol/server";

export async function connect(server: McpServer, name = "test"): Promise<Client> {
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name, version: "0.0.0" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

/** The sorted names a client sees in tools/list. */
export async function toolNames(server: McpServer): Promise<string[]> {
  const client = await connect(server);
  try {
    return (await client.listTools()).tools.map((t) => t.name).sort();
  } finally {
    await client.close();
  }
}
