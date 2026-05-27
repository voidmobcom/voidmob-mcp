export function makeDebugLogger(enabled: boolean) {
  if (!enabled) return () => {};
  return (line: string) => {
    process.stderr.write(`[voidmob-mcp] ${line}\n`);
  };
}
