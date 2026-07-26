export type Labels = Record<string, string>

interface Summary {
  count: number
  sum: number
}

/**
 * A small Prometheus text-format registry. Deliberately not a dependency: the guard sits
 * in the send path and every dependency there is a liability.
 */
export class Metrics {
  private counters = new Map<string, number>()
  private summaries = new Map<string, Summary>()
  private gauges = new Map<string, () => number>()

  inc(name: string, labels: Labels = {}, by = 1): void {
    const key = seriesKey(name, labels)
    this.counters.set(key, (this.counters.get(key) ?? 0) + by)
  }

  observe(name: string, value: number, labels: Labels = {}): void {
    const key = seriesKey(name, labels)
    const s = this.summaries.get(key) ?? { count: 0, sum: 0 }
    s.count += 1
    s.sum += value
    this.summaries.set(key, s)
  }

  gauge(name: string, read: () => number, labels: Labels = {}): void {
    this.gauges.set(seriesKey(name, labels), read)
  }

  render(): string {
    const lines: string[] = []
    const emitted = new Set<string>()
    const help = (key: string, type: string) => {
      const name = key.split('{')[0]!
      if (emitted.has(name)) return
      emitted.add(name)
      lines.push(`# TYPE ${name} ${type}`)
    }
    for (const [key, value] of [...this.counters].sort()) {
      help(key, 'counter')
      lines.push(`${key} ${value}`)
    }
    for (const [key, s] of [...this.summaries].sort()) {
      const name = key.split('{')[0]!
      const labels = key.slice(name.length)
      help(key, 'summary')
      lines.push(`${name}_count${labels} ${s.count}`)
      lines.push(`${name}_sum${labels} ${s.sum}`)
    }
    for (const [key, read] of [...this.gauges].sort()) {
      help(key, 'gauge')
      lines.push(`${key} ${read()}`)
    }
    return `${lines.join('\n')}\n`
  }
}

function seriesKey(name: string, labels: Labels): string {
  const entries = Object.entries(labels).filter(([, v]) => v !== undefined && v !== '')
  if (entries.length === 0) return `waha_guard_${name}`
  const rendered = entries
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}="${escapeLabel(v)}"`)
    .join(',')
  return `waha_guard_${name}{${rendered}}`
}

function escapeLabel(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"')
}
