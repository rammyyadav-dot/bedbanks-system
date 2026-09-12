export interface ActivityItem { id: string; text: string; time: string; }

export function ActivityFeed({ items }: { items: ActivityItem[] }) {
  return (
    <div className="panel">
      <div className="panel-header"><h2>Recent Activity</h2></div>
      <div style={{ padding: '0 18px 14px' }}>
        {items.map((item) => (
          <div key={item.id} style={{ padding: '11px 0', borderTop: '1px solid #edf2f3', fontSize: 11, color: '#3c5b64' }}>
            {item.text}
            <div style={{ color: '#94a7aa', fontSize: 9, marginTop: 3 }}>{item.time}</div>
          </div>
        ))}
      </div>
    </div>
  );
}
