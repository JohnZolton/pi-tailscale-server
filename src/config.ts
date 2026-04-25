export interface BridgeConfig {
  wsPort: number;
  cwd: string;
  agentDir: string;
}

export function loadConfig(): BridgeConfig {
  return {
    wsPort: parseInt(process.env.WS_PORT ?? "3002", 10),
    cwd: process.env.PI_CWD ?? process.cwd(),
    agentDir: process.env.PI_AGENT_DIR ?? "",
  };
}
