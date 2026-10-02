import { useMemo } from 'react';
import { useOffice, type AgentState } from '../store/officeStore';
import { portrait } from '../scene/portrait';
import { DIVISION_COLOR } from '../scene/visuals';

export const withRole = (a?: Pick<AgentState, 'name' | 'role'> | null, fallback = 'Sistem') =>
  a ? `${a.name} (${a.role})` : fallback;

export function Portrait({ agentId, size = 28 }: { agentId: string; size?: number }) {
  const agent = useOffice((s) => s.agents[agentId]);
  const src = useMemo(
    () => (agent ? portrait(agent.agent_id, agent.division, agent.number) : ''),
    [agent?.agent_id, agent?.division, agent?.number],
  );
  const style = { width: size, height: size, borderColor: agent ? DIVISION_COLOR[agent.division] : undefined };
  if (!agent) return <span className="portrait" style={style} aria-hidden />;
  return src ? (
    <img className="portrait" style={style} src={src} alt={`Foto ${agent.name}`} width={size} height={size} />
  ) : (
    <span className="portrait initial" style={style} aria-hidden>{agent.name[0]}</span>
  );
}
