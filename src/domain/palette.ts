export type Shape = 'rect' | 'round' | 'ellipse' | 'cylinder' | 'hex' | 'queue' | 'cloud';

export interface ComponentDef {
  type: string;
  label: string;
  category: string;
  shape: Shape;
  badge: string;
  fill: string;
  w: number;
  h: number;
  minW: number;
  minH: number;
}

const D = (
  category: string,
  type: string,
  label: string,
  shape: Shape,
  badge: string,
  fill: string,
  w = 140,
  h = 72,
): ComponentDef => ({ type, label, category, shape, badge, fill, w, h, minW: 60, minH: 40 });

// Light fills with dark (#0f172a) text: all pairs exceed 4.5:1 contrast.
export const PALETTE: ComponentDef[] = [
  D('General', 'service', 'Service', 'rect', 'SVC', '#dbeafe'),
  D('General', 'rectangle', 'Rectangle', 'rect', '', '#ffffff', 140, 80),
  D('General', 'ellipse', 'Ellipse', 'ellipse', '', '#ffffff', 140, 80),
  D('General', 'rounded', 'Rounded box', 'round', 'BOX', '#e0e7ff'),
  D('General', 'boundary', 'Boundary / group', 'rect', 'GRP', '#f1f5f9', 320, 200),
  D('General', 'icon', 'Generic icon', 'ellipse', 'ICN', '#fef9c3', 80, 80),

  D('Data', 'relational-db', 'Relational DB', 'cylinder', 'SQL', '#dcfce7', 110, 90),
  D('Data', 'nosql-db', 'NoSQL DB', 'cylinder', 'NoSQL', '#d1fae5', 110, 90),
  D('Data', 'cache', 'Cache', 'cylinder', 'CACHE', '#fee2e2', 110, 90),
  D('Data', 'object-storage', 'Object storage', 'cloud', 'S3', '#ffedd5', 130, 80),
  D('Data', 'data-warehouse', 'Data warehouse', 'cylinder', 'DW', '#ccfbf1', 110, 90),

  D('Messaging', 'queue', 'Queue', 'queue', 'Q', '#fce7f3'),
  D('Messaging', 'event-stream', 'Event stream / topic', 'queue', 'TOPIC', '#fae8ff'),
  D('Messaging', 'pubsub', 'Pub/sub broker', 'queue', 'PUB/SUB', '#ede9fe'),

  D('Network', 'client', 'Client', 'round', 'CLIENT', '#e0f2fe'),
  D('Network', 'browser-client', 'Browser / mobile', 'round', 'WEB', '#cffafe'),
  D('Network', 'api-gateway', 'API gateway', 'hex', 'GW', '#e0e7ff'),
  D('Network', 'load-balancer', 'Load balancer', 'hex', 'LB', '#dbeafe'),
  D('Network', 'cdn', 'CDN', 'cloud', 'CDN', '#f0f9ff', 120, 80),
  D('Network', 'external-api', 'External API', 'cloud', 'EXT', '#f5f5f4', 130, 80),

  D('Compute', 'server', 'Server', 'rect', 'SRV', '#e2e8f0'),
  D('Compute', 'worker', 'Worker', 'rect', 'WRK', '#e5e7eb'),
  D('Compute', 'function', 'Function / serverless', 'round', 'FN', '#fef3c7'),
  D('Compute', 'container', 'Container / cluster', 'rect', 'K8S', '#e7e5e4', 160, 90),

  D('AI', 'llm', 'LLM / model', 'hex', 'LLM', '#f3e8ff'),
  D('AI', 'embedding-model', 'Embedding model', 'hex', 'EMB', '#fae8ff'),
  D('AI', 'vector-db', 'Vector DB', 'cylinder', 'VEC', '#ede9fe', 110, 90),
  D('AI', 'agent', 'Agent / tool', 'round', 'AGENT', '#fce7f3'),
];

export const CATEGORIES = [...new Set(PALETTE.map((p) => p.category))];

export function findComponent(type: string | undefined | null): ComponentDef | undefined {
  return PALETTE.find((p) => p.type === type);
}

export const SWATCHES = ['#0f172a', '#dc2626', '#ea580c', '#ca8a04', '#16a34a', '#2563eb', '#7c3aed', '#db2777'];
export const STICKY_COLORS = ['#fef08a', '#bbf7d0', '#bfdbfe', '#fbcfe8', '#fed7aa'];
