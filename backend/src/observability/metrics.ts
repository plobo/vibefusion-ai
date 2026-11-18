/** Tiny Prometheus-compatible metrics registry (counters + latency summaries). */
export class Metrics {
  private counters = new Map<string, number>();
  private latencies = new Map<string, number[]>();

  inc(name: string, labels: Record<string, string> = {}, by = 1): void {
    const key = this.key(name, labels);
    this.counters.set(key, (this.counters.get(key) ?? 0) + by);
  }

  observe(name: string, ms: number, labels: Record<string, string> = {}): void {
    const key = this.key(name, labels);
    const arr = this.latencies.get(key) ?? [];
    arr.push(ms);
    if (arr.length > 1000) arr.shift();
    this.latencies.set(key, arr);
  }

  get(name: string, labels: Record<string, string> = {}): number {
    return this.counters.get(this.key(name, labels)) ?? 0;
  }

  private key(name: string, labels: Record<string, string>): string {
    const l = Object.entries(labels)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${k}="${v.replace(/"/g, "'")}"`)
      .join(",");
    return l ? `${name}{${l}}` : name;
  }

  render(): string {
    const lines: string[] = [];
    for (const [k, v] of this.counters) lines.push(`${k} ${v}`);
    for (const [k, arr] of this.latencies) {
      const sorted = [...arr].sort((a, b) => a - b);
      const q = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
      const base = k.includes("{") ? k.slice(0, k.indexOf("{")) : k;
      const labels = k.includes("{") ? k.slice(k.indexOf("{") + 1, -1) : "";
      const withQ = (qv: string) => `${base}{${labels ? labels + "," : ""}quantile="${qv}"}`;
      lines.push(
        `${withQ("0.5")} ${q(0.5)}`,
        `${withQ("0.95")} ${q(0.95)}`,
        `${base}_count${labels ? `{${labels}}` : ""} ${arr.length}`,
      );
    }
    return lines.join("\n") + "\n";
  }
}
