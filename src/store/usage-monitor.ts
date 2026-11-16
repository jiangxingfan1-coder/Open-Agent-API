import type { Store } from './store.js';

type Tally = {
  runs: number;
  requests: number;
  input: number;
  output: number;
  total: number;
  unknown: number;
  partial: number;
};
const empty = (): Tally => ({
  runs: 0,
  requests: 0,
  input: 0,
  output: 0,
  total: 0,
  unknown: 0,
  partial: 0,
});

/** Direct usage per execution: a parent's settled child usage is subtracted before aggregation. */
export function usageReport(store: Store, owner: string, days: number, now = Date.now()) {
  const end = now,
    start = Date.parse(new Date(now).toISOString().slice(0, 10)) - (days - 1) * 86_400_000;
  const sql = `WITH selected AS (
    SELECT s.run_id,s.owner,s.agent_id,s.usage_known,s.total_tokens,
      json_extract(s.payload,'$.created_at') created,
      coalesce(json_extract(s.payload,'$.usage.input_tokens'),0) input,
      coalesce(json_extract(s.payload,'$.usage.output_tokens'),0) output,
      json_extract(r.payload,'$.checkpoint.delegationDepth') parent
    FROM run_summaries s JOIN runs r ON r.id=s.run_id
    WHERE s.owner=? AND json_extract(s.payload,'$.created_at') BETWEEN ? AND ?
  ), children AS (
    SELECT p.run_id,
      coalesce(sum(c.total_tokens),0) tokens,
      coalesce(sum(json_extract(c.payload,'$.usage.input_tokens')),0) input,
      coalesce(sum(json_extract(c.payload,'$.usage.output_tokens')),0) output
    FROM selected p JOIN steps st ON st.run_id=p.run_id
    JOIN run_summaries c ON c.run_id=json_extract(st.payload,'$.childRunId') AND c.owner=p.owner
    WHERE json_extract(st.payload,'$.status')='completed' GROUP BY p.run_id
  ) SELECT p.agent_id,strftime('%Y-%m-%d',p.created/1000,'unixepoch') day,
    count(*) runs,sum(coalesce(p.parent,0)=0) requests,
    sum(max(0,p.input-coalesce(c.input,0))) input,
    sum(max(0,p.output-coalesce(c.output,0))) output,
    sum(max(0,p.total_tokens-coalesce(c.tokens,0))) total,
    sum(p.usage_known=0) unknown,sum(p.usage_known=2 OR p.total_tokens<coalesce(c.tokens,0) OR p.input<coalesce(c.input,0) OR p.output<coalesce(c.output,0)) partial
    FROM selected p LEFT JOIN children c ON c.run_id=p.run_id GROUP BY p.agent_id,day`;
  const totals = empty(),
    agents = new Map<string, Tally>(),
    daily = new Map<string, Tally>();
  for (let n = 0; n < days; n++)
    daily.set(new Date(start + n * 86_400_000).toISOString().slice(0, 10), empty());
  for (const row of store.prepare(sql).iterate(owner, start, end)) {
    const agent = String(row.agent_id),
      day = String(row.day);
    const a = agents.get(agent) ?? empty(),
      d = daily.get(day)!;
    for (const key of Object.keys(totals) as (keyof Tally)[]) {
      const value = Number(row[key]);
      totals[key] += value;
      a[key] += value;
      d[key] += value;
    }
    agents.set(agent, a);
  }
  return {
    start,
    end,
    timezone: 'UTC',
    basis: 'run_created_at',
    totals,
    agents: [...agents]
      .map(([agent, value]) => ({ agent, ...value }))
      .sort((a, b) => b.total - a.total),
    daily: [...daily].map(([date, value]) => ({ date, ...value })),
    scope: 'oaa-only',
    includes_local_history: false,
  };
}
