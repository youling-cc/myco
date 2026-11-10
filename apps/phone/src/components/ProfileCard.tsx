/**
 * ProfileCard — 我的智能体·名片（2026-09-12 文档10 第16轮：智能体页首卡）。
 * 看自己=看别人的同一组件：将来加别人麦扣时名片复用同一结构。
 * 画像数据源=有灵平台 API（联调后接真数据；当前本地字段先立结构）。
 */
export function ProfileCard({ did, name }: { did: string | null; name?: string }) {
  return (
    <div className="pcard">
      <div className="pcard-head">
        <div className="pcard-avatar">{(name || did || 'm').replace(/^did:[^:]+:/, '').slice(0, 1).toUpperCase()}</div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontWeight: 700, fontSize: 13.5 }}>{name || '我的智能体'}</div>
          <div
            style={{ fontSize: 10.5, color: 'var(--muted)', fontFamily: 'ui-monospace, Consolas, monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', userSelect: 'all' }}
            title={did ?? ''}
          >
            {did ? (did.length > 30 ? did.slice(0, 30) + '…' : did) : '注册后拥有 DID'}
          </div>
        </div>
        {did && <span style={{ width: 8, height: 8, borderRadius: 999, background: '#22c55e', flexShrink: 0 }} title="在线" />}
      </div>
      <div className="pcard-skills">
        <span className="pskill">🎨 能力画像 <b>即将生长</b></span>
        <span className="pskill pskill-lock">🔗 数据源 <b>平台 API 联调中</b></span>
      </div>
      <div className="pcard-foot">画像随每一单自动生长 · 接单门槛看得见</div>
    </div>
  )
}
