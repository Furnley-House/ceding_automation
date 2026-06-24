// components.jsx — shared UI components

const Sidebar = () => (
  <aside className="sb">
    <div className="sb-logo">
      <div className="sb-logo-mark">FH</div>
      <div className="sb-logo-name">ProviderHub</div>
    </div>
    <nav className="sb-nav">
      <SbItem icon="home" label="Dashboard" />
      <SbItem icon="cases" label="Cases" />
      <SbItem icon="inbox" label="Document Inbox" />
      <SbItem icon="list" label="Ceding Checklist" />
      <SbItem icon="alertTri" label="Missing Data" active count={6} />
      <SbItem icon="building" label="Provider Directory" />
      <SbItem icon="zap" label="Automations" />
      <SbItem icon="phone" label="Call Assist" />
    </nav>
    <div className="sb-foot">
      <div className="sb-avatar">PR</div>
      <div className="sb-foot-meta">
        <div className="sb-foot-name">Priya Ramesh</div>
        <div className="sb-foot-role">CA Team · Chennai</div>
      </div>
    </div>
  </aside>
);

const SbItem = ({ icon, label, active, count }) => (
  <div className={'sb-item' + (active ? ' active' : '')}>
    <Icon name={icon} size={18} />
    <span className="sb-item-label">{label}</span>
    {count != null && <span style={{ background: '#dc2626', color: '#fff', fontSize: 10, fontWeight: 700, padding: '1px 6px', borderRadius: 999 }}>{count}</span>}
  </div>
);

const TopBar = ({ phase }) => (
  <div className="top">
    <div style={{ flex: 1 }}>
      <div className="crumbs">
        <span>Cases</span>
        <Icon name="chevR" size={12} />
        <span>{CASE.client}</span>
        <Icon name="chevR" size={12} />
        <span className="cur">Missing Data</span>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 6 }}>
        <div className="top-title">Missing Data Resolution</div>
        <div className="pill teal"><span className="dot"/>{CASE.ref}</div>
      </div>
    </div>
    <div className="top-meta">
      <div className="pill"><Icon name="building" size={12} />{CASE.provider}</div>
      <div className="pill mono tnum">{CASE.plan}</div>
      <div className="pill warn"><Icon name="alertTri" size={12} />SLA 1d</div>
    </div>
    <button className="btn ghost"><Icon name="bell" size={14} /></button>
    <button className="btn"><Icon name="doc" size={14} />View PDF</button>
    {phase === 'live' ? (
      <button className="btn danger"><Icon name="phoneOff" size={14} />End call</button>
    ) : (
      <button className="btn teal"><Icon name="phoneCall" size={14} />Call provider</button>
    )}
  </div>
);

// Confidence dial (donut)
const Dial = ({ done, review, missing, total }) => {
  const r = 36, c = 2 * Math.PI * r;
  const pctDone = done / total, pctReview = review / total, pctMissing = missing / total;
  return (
    <div className="dial">
      <svg className="dial-svg" width="92" height="92" viewBox="0 0 92 92">
        <circle cx="46" cy="46" r={r} fill="none" stroke="rgba(255,255,255,.1)" strokeWidth="10" />
        {/* missing red */}
        <circle cx="46" cy="46" r={r} fill="none" stroke="#ef4444" strokeWidth="10" strokeDasharray={`${pctMissing*c} ${c}`} transform="rotate(-90 46 46)" strokeLinecap="round" />
        {/* review amber */}
        <circle cx="46" cy="46" r={r} fill="none" stroke="#f59e0b" strokeWidth="10" strokeDasharray={`${pctReview*c} ${c}`} strokeDashoffset={`${-pctMissing*c}`} transform="rotate(-90 46 46)" strokeLinecap="round" />
        {/* done teal */}
        <circle cx="46" cy="46" r={r} fill="none" stroke="#00C2CB" strokeWidth="10" strokeDasharray={`${pctDone*c} ${c}`} strokeDashoffset={`${-(pctMissing+pctReview)*c}`} transform="rotate(-90 46 46)" strokeLinecap="round" />
        <text x="46" y="50" textAnchor="middle" fill="#fff" fontSize="18" fontWeight="700">{done}</text>
        <text x="46" y="64" textAnchor="middle" fill="rgba(255,255,255,.6)" fontSize="10">/{total}</text>
      </svg>
      <div className="dial-meta">
        <div className="dial-title">Case Completion</div>
        <div className="dial-num">{Math.round(done/total*100)}%<small> ready</small></div>
        <div className="dial-legend">
          <span><i style={{ background: '#00C2CB' }}/>{done} approved</span>
          <span><i style={{ background: '#f59e0b' }}/>{review} review</span>
          <span><i style={{ background: '#ef4444' }}/>{missing} missing</span>
        </div>
      </div>
    </div>
  );
};

// Stage strip
const Stages = () => {
  const stages = [
    { n: 1, name: 'LOA Sent', done: true },
    { n: 2, name: 'PDF Received', done: true },
    { n: 3, name: 'AI Extracted', done: true },
    { n: 4, name: 'Resolve Missing', active: true },
    { n: 5, name: 'Call Provider' },
    { n: 6, name: 'Adviser Review' },
    { n: 7, name: 'Approved' },
    { n: 8, name: 'Export' },
  ];
  return (
    <div className="stages">
      {stages.map((s, i) => (
        <React.Fragment key={s.n}>
          <div className={'stage' + (s.done ? ' done' : '') + (s.active ? ' active' : '')}>
            <span className="num">{s.done ? <Icon name="check" size={10}/> : s.n}</span>
            <span>{s.name}</span>
          </div>
          {i < stages.length - 1 && <span className="stage-arrow">→</span>}
        </React.Fragment>
      ))}
    </div>
  );
};

// Case card in queue
const CaseCard = ({ c, active }) => {
  const pct = Math.round((c.done / c.total) * 100);
  return (
    <div className={'case-card' + (active ? ' active' : '')}>
      <div className="case-row">
        <div className="case-name">{c.client}</div>
        {c.flag === 'urgent' && <span className="pill bad" style={{ height: 18, padding: '0 6px', fontSize: 10 }}>URGENT</span>}
      </div>
      <div className="case-meta">
        <span>{c.provider}</span>
        <span style={{ opacity: 0.5 }}>·</span>
        <span className="mono tnum">{c.plan}</span>
      </div>
      <div className="case-bottom">
        <div className="case-spark"><i style={{ width: pct + '%' }} /></div>
        <span className="case-stat tnum">{pct}%</span>
      </div>
      <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
        {c.missing > 0 && <span className="case-stat bad"><Icon name="alert" size={12}/>{c.missing} missing</span>}
        {c.review > 0 && <span className="case-stat warn"><Icon name="alertTri" size={12}/>{c.review} review</span>}
        <span className="case-stat" style={{ marginLeft: 'auto', fontSize: 10 }}>{c.sla}</span>
      </div>
    </div>
  );
};

// Confidence chip
const Conf = ({ level, value }) => (
  <span className={'conf ' + level}>
    <Icon name={level === 'high' ? 'check' : level === 'medium' ? 'alertTri' : 'alert'} size={11}/>
    {value}%
  </span>
);

// Field card
const FieldCard = ({ f, mode, linkedQ, onHover, onApprove, onEdit, suggestion, editing, editValue, setEditValue, onSave, onCancel, showEvidence = true }) => {
  const linked = mode === 'call' && linkedQ === f.id;
  return (
    <div
      id={`field-${f.id}`}
      className={'field ' + f.status + (linked ? ' linked' : '')}
      onMouseEnter={() => onHover && onHover(f.q)}
      onMouseLeave={() => onHover && onHover(null)}
    >
      <div className="field-head">
        <div className="field-meta">
          <div className="field-section">{f.section}</div>
          <div className="field-label">{f.label}</div>
        </div>
        <span className={'field-status ' + f.status}>
          {f.status === 'missing' && <><Icon name="alert" size={11}/>Missing</>}
          {f.status === 'review' && <><Icon name="alertTri" size={11}/>Review</>}
          {f.status === 'done' && <><Icon name="check" size={11}/>Approved</>}
        </span>
      </div>

      <div className="field-body">
        {f.value && f.status !== 'missing' && (
          <div className="field-current">
            <span className="label">Value</span>
            <span className="val">{f.value}</span>
            {f.confidence && <Conf level={f.confidence} value={f.conf}/>}
          </div>
        )}

        {showEvidence && f.evidence && f.evidence.quote && (
          <div className="field-evidence">
            <span dangerouslySetInnerHTML={{ __html: '"' + f.evidence.quote + '"' }} />
            <div className="field-evidence-meta">
              <Icon name="doc" size={11}/>
              <span>{f.evidence.source}</span>
              {f.evidence.page && <><span style={{ opacity: 0.4 }}>·</span><span className="mono">{f.evidence.page}</span></>}
            </div>
          </div>
        )}

        {f.notes && (
          <div style={{ fontSize: 12, color: 'var(--ink-3)', display: 'flex', gap: 6, lineHeight: 1.5 }}>
            <Icon name="alertTri" size={12} style={{ flexShrink: 0, marginTop: 2, color: 'var(--warn)' }}/>
            <span>{f.notes}</span>
          </div>
        )}

        {suggestion && (
          <div className="field-suggest">
            <Icon name="sparkles" size={14}/>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, flex: 1 }}>
              <span className="src">From transcript · {suggestion.confidence}-confidence ({suggestion.conf}%)</span>
              <span className="val">{suggestion.value}</span>
            </div>
            <button className="btn sm teal">Accept</button>
            <button className="btn sm ghost"><Icon name="x" size={12}/></button>
          </div>
        )}

        {editing ? (
          <div className="field-input-row">
            <input
              autoFocus
              className="input"
              value={editValue || ''}
              onChange={(e) => setEditValue && setEditValue(e.target.value)}
              placeholder={`Enter ${f.label.toLowerCase()}…`}
            />
            <button className="btn primary" onClick={onSave}><Icon name="check" size={14}/>Save</button>
            <button className="btn ghost" onClick={onCancel}><Icon name="x" size={14}/></button>
          </div>
        ) : (
          <div className="field-actions">
            {f.status === 'missing' ? (
              <>
                <button className="btn sm" onClick={() => onEdit && onEdit(f.id)}><Icon name="edit" size={12}/>Enter value</button>
                <button className="btn sm"><Icon name="phone" size={12}/>Ask on call</button>
                <button className="btn sm ghost"><Icon name="upload" size={12}/>Re-upload doc</button>
              </>
            ) : f.status === 'review' ? (
              <>
                <button className="btn sm" style={{ borderColor: 'var(--good)', color: 'var(--good)' }} onClick={() => onApprove && onApprove(f.id)}><Icon name="check" size={12}/>Confirm</button>
                <button className="btn sm" onClick={() => onEdit && onEdit(f.id)}><Icon name="edit" size={12}/>Edit</button>
                {f.askOnCall && <span className="field-tag q"><Icon name="phone" size={11}/>Asked on call</span>}
              </>
            ) : (
              <span className="field-tag" style={{ background: 'transparent', color: 'var(--ink-4)' }}>
                <Icon name="check" size={11}/>Approved · ready for adviser
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

// Right rail: provider context
const ProviderRail = ({ phase, secs }) => (
  <div className="rail-card">
    <div className="rail-head"><Icon name="building" size={14}/>Provider Context</div>
    <div className="rail-body">
      <div className="provider-name">{CASE.provider}</div>
      <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>Personal Pension · LOA on file</div>

      <div className="routing">
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
          <Icon name="zap" size={12}/>
          <b style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.04em' }}>Routing rule matched</b>
        </div>
        <div style={{ fontSize: 12, lineHeight: 1.5 }}>
          From plan <span className="mono" style={{ color: 'var(--ink)' }}>{CASE.plan}</span>
          <br/>prefix <span className="prefix mono">{CASE.routing.prefix}</span> → <b>{CASE.routing.dept}</b>
        </div>
        <div className="routing-row"><Icon name="phone" size={14}/><span className="num mono">{CASE.routing.phone}</span></div>
        <div className="routing-row"><Icon name="send" size={14}/><span style={{ fontSize: 12 }}>{CASE.routing.email}</span></div>
      </div>

      {/* RingCentral configuration */}
      <div style={{ marginTop: 12, padding: '10px 12px', background: 'var(--bg-2)', borderRadius: 'var(--r-sm)', display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ width: 28, height: 28, borderRadius: 6, background: CASE.rcConfigured ? 'var(--good-soft)' : 'var(--warn-soft)', color: CASE.rcConfigured ? 'var(--good)' : 'var(--warn)', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
            <Icon name={CASE.rcConfigured ? 'phoneCall' : 'alertTri'} size={14}/>
        </div>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 11, color: 'var(--ink-3)', textTransform: 'uppercase', letterSpacing: '0.04em', fontWeight: 600 }}>RingCentral</div>
          <div style={{ fontSize: 12, fontWeight: 600 }}>
            {CASE.rcConfigured ? <>Agent · <span className="mono">{CASE.agentPhone}</span></> : 'Not configured'}
          </div>
        </div>
        <Icon name="settings" size={12} style={{ color: 'var(--ink-4)' }}/>
      </div>

      {phase === 'idle' && (
        <button className="btn teal" style={{ width: '100%', marginTop: 12, justifyContent: 'center' }}>
          <Icon name="phoneCall" size={14}/>Call {CASE.routing.dept}
        </button>
      )}
      {phase === 'dialling' && (
        <div className="call-state">
          <div className="icon"><Icon name="phone" size={16}/></div>
          <div>
            <div className="label">Dialling via RingCentral</div>
            <div className="name mono">{CASE.routing.phone}</div>
          </div>
          <div className="timer"><Icon name="refresh" size={14} className="spin"/></div>
        </div>
      )}
      {phase === 'live' && (
        <div className="call-state live">
          <div className="icon"><Icon name="mic" size={16}/></div>
          <div>
            <div className="label">Live · recording</div>
            <div className="name">Mark @ {CASE.routing.dept}</div>
          </div>
          <div className="timer tnum">{secs || '02:14'}</div>
        </div>
      )}
    </div>
  </div>
);

const RecentRail = () => (
  <div className="rail-card">
    <div className="rail-head"><Icon name="list" size={14}/>Recent Activity</div>
    <div className="rail-body" style={{ padding: 0 }}>
      {[
        { who: 'AI', what: 'Extracted 24 fields from Aviva Statement.pdf', when: '2h ago', icon: 'sparkles' },
        { who: 'Priya', what: 'Approved 12 high-confidence fields', when: '1h ago', icon: 'check' },
        { who: 'Priya', what: 'Flagged 5 fields for review', when: '34m ago', icon: 'alertTri' },
        { who: 'AI', what: 'Drafted call script (7 questions)', when: '12m ago', icon: 'sparkles' },
      ].map((a, i) => (
        <div key={i} style={{ padding: '10px 16px', borderTop: i ? '1px solid var(--line-2)' : 'none', display: 'flex', gap: 10, alignItems: 'flex-start' }}>
          <div style={{ width: 24, height: 24, borderRadius: 6, background: 'var(--bg-2)', display: 'grid', placeItems: 'center', flexShrink: 0, color: 'var(--ink-3)' }}>
            <Icon name={a.icon} size={12}/>
          </div>
          <div style={{ flex: 1, fontSize: 12, lineHeight: 1.4 }}>
            <span style={{ fontWeight: 600 }}>{a.who}</span>
            <span style={{ color: 'var(--ink-3)' }}> · {a.what}</span>
            <div style={{ fontSize: 11, color: 'var(--ink-4)', marginTop: 2 }}>{a.when}</div>
          </div>
        </div>
      ))}
    </div>
  </div>
);

Object.assign(window, { Sidebar, TopBar, Dial, Stages, CaseCard, Conf, FieldCard, ProviderRail, RecentRail });
