// app.jsx — main Missing Data Resolution prototype

const { useState, useEffect, useRef } = React;

// PHASES: triage → script → live → review → done
const PHASES = [
  { id: 'triage', num: 1, label: 'Triage' },
  { id: 'script', num: 2, label: 'Prepare Script' },
  { id: 'live', num: 3, label: 'Live Call' },
  { id: 'review', num: 4, label: 'Apply Findings' },
  { id: 'done', num: 5, label: 'Hand Off' },
];

const TWEAK_DEFAULTS = /*EDITMODE-BEGIN*/{
  "phase": "triage",
  "showSourceQuotes": true,
  "compactFields": false,
  "accentTeal": true,
  "showRail": true,
  "autoApproveHighConf": false
}/*EDITMODE-END*/;

const App = () => {
  const [t, setTweak] = useTweaks(TWEAK_DEFAULTS);
  const phase = t.phase;

  const [editingId, setEditingId] = useState(null);
  const [editValue, setEditValue] = useState('');
  const [hoveredQ, setHoveredQ] = useState(null);
  const [activeQ, setActiveQ] = useState(null);
  const [fields, setFields] = useState(FIELDS);
  const [transcript, setTranscript] = useState([]);
  const [answeredQs, setAnsweredQs] = useState({});
  const [callTimer, setCallTimer] = useState(0);
  const [suggestions, setSuggestions] = useState({}); // fieldId -> suggestion

  // Live call simulation
  useEffect(() => {
    if (phase !== 'live') {
      setTranscript([]); setAnsweredQs({}); setSuggestions({}); setCallTimer(0);
      return;
    }
    let i = 0;
    const next = () => {
      if (i >= TRANSCRIPT_STREAM.length) return;
      const u = TRANSCRIPT_STREAM[i];
      setTranscript(prev => [...prev, u]);
      if (u.extracted) {
        setSuggestions(s => ({ ...s, [u.extracted.fieldId]: u.extracted }));
        // mark question answered (find which q maps to this field)
        const q = SCRIPT.sections.flatMap(s => s.questions).find(q => q.linksTo === u.extracted.fieldId);
        if (q) setAnsweredQs(a => ({ ...a, [q.id]: true }));
        // set active question to next unanswered after this
      }
      // set active question to current speaker's topic
      if (u.side === 'ca') {
        const q = SCRIPT.sections.flatMap(s => s.questions).find(q => u.text.toLowerCase().includes(q.text.toLowerCase().slice(0, 20)) ||
          (q.id === 'q1' && u.text.includes('current value')) ||
          (q.id === 'q2' && u.text.includes('transfer value')) ||
          (q.id === 'q3' && u.text.includes('annual management'))
        );
        if (q) setActiveQ(q.id);
      }
      i++;
      setTimeout(next, 1800);
    };
    const start = setTimeout(next, 800);
    const tick = setInterval(() => setCallTimer(s => s + 1), 1000);
    return () => { clearTimeout(start); clearInterval(tick); };
  }, [phase]);

  const formatTimer = (s) => `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;

  // Apply phase: simulate that suggestions have been accepted
  const reviewFields = phase === 'review' || phase === 'done' ? fields.map(f => {
    const sug = suggestions[f.id] || (phase === 'review' || phase === 'done' ? {
      f1: { value: '0.45%', confidence: 'high', conf: 94 },
      f2: { value: '67', confidence: 'high', conf: 92 },
      f3: { value: 'Yes — last updated 12 Mar 2024', confidence: 'high', conf: 89 },
      f4: { value: '£7,594.33', confidence: 'high', conf: 96 },
      f5: { value: '£7,594.33 (no MVR)', confidence: 'high', conf: 95 },
      f7: { value: 'None — confirmed by provider', confidence: 'high', conf: 94 },
      f8: { value: '0.00% — bundled', confidence: 'high', conf: 92 },
    }[f.id] : null);
    if (sug && (f.status === 'missing' || f.status === 'review')) {
      return { ...f, value: sug.value, confidence: sug.confidence, conf: sug.conf, status: phase === 'done' ? 'done' : f.status };
    }
    if (phase === 'done' && f.status === 'review') return { ...f, status: 'done' };
    return f;
  }) : fields;

  const counts = {
    missing: reviewFields.filter(f => f.status === 'missing').length,
    review: reviewFields.filter(f => f.status === 'review').length,
    done: reviewFields.filter(f => f.status === 'done').length,
    total: reviewFields.length,
  };

  const handleApprove = (id) => {
    setFields(prev => prev.map(f => f.id === id ? { ...f, status: 'done' } : f));
  };
  const handleEdit = (id) => {
    const f = fields.find(x => x.id === id);
    setEditingId(id);
    setEditValue(f?.value || '');
  };
  const handleSave = () => {
    setFields(prev => prev.map(f => f.id === editingId ? { ...f, value: editValue, status: 'done', confidence: 'high', conf: 100 } : f));
    setEditingId(null);
  };

  return (
    <>
      <div id="app" data-sidebar="icons">
        <Sidebar />
        <div className="main">
          <TopBar phase={phase} secs={formatTimer(callTimer)} />
          <Stages />
          <PhaseBar phase={phase} setTweak={setTweak} />

          {phase === 'triage' && <TriageView fields={reviewFields} counts={counts} t={t} onApprove={handleApprove} onEdit={handleEdit} editingId={editingId} editValue={editValue} setEditValue={setEditValue} onSave={handleSave} onCancel={() => setEditingId(null)} setTweak={setTweak} />}
          {phase === 'script' && <ScriptView fields={reviewFields} counts={counts} t={t} hoveredQ={hoveredQ} setHoveredQ={setHoveredQ} setTweak={setTweak} />}
          {phase === 'live' && <LiveCallView fields={reviewFields} counts={counts} t={t} transcript={transcript} answeredQs={answeredQs} activeQ={activeQ} suggestions={suggestions} timer={formatTimer(callTimer)} />}
          {phase === 'review' && <ReviewView fields={reviewFields} counts={counts} t={t} suggestions={suggestions} />}
          {phase === 'done' && <DoneView fields={reviewFields} counts={counts} t={t} setTweak={setTweak} />}
        </div>
      </div>

      <TweaksPanel className="tweaks-panel-fixed" title="Tweaks">
        <TweakSection title="Flow phase">
          <TweakSelect label="Phase" value={t.phase} onChange={v => setTweak('phase', v)}
            options={[
              { value: 'triage', label: '1 · Triage missing & low-confidence' },
              { value: 'script', label: '2 · Prepare AI call script' },
              { value: 'live', label: '3 · Live call (auto-extract)' },
              { value: 'review', label: '4 · Apply findings' },
              { value: 'done', label: '5 · Hand off to adviser' },
            ]} />
        </TweakSection>
        <TweakSection title="Display">
          <TweakToggle label="Show source quotes" value={t.showSourceQuotes} onChange={v => setTweak('showSourceQuotes', v)} />
          <TweakToggle label="Compact field cards" value={t.compactFields} onChange={v => setTweak('compactFields', v)} />
          <TweakToggle label="Show right rail" value={t.showRail} onChange={v => setTweak('showRail', v)} />
        </TweakSection>
        <TweakSection title="Behaviour">
          <TweakToggle label="Auto-approve ≥95% confidence" value={t.autoApproveHighConf} onChange={v => setTweak('autoApproveHighConf', v)} />
        </TweakSection>
      </TweaksPanel>
    </>
  );
};

const PhaseBar = ({ phase, setTweak }) => (
  <div className="phase-bar">
    {PHASES.map((p, i) => (
      <React.Fragment key={p.id}>
        <button className={'phase-tab' + (phase === p.id ? ' active' : '')} onClick={() => setTweak('phase', p.id)}>
          <span className="num">{p.num}</span>{p.label}
        </button>
        {i < PHASES.length - 1 && <span className="phase-divider">→</span>}
      </React.Fragment>
    ))}
    <div style={{ flex: 1 }} />
    <span style={{ fontSize: 11, color: 'var(--ink-4)' }}>Phase {PHASES.findIndex(p => p.id === phase) + 1} of {PHASES.length}</span>
  </div>
);

// PHASE 1: TRIAGE — left queue, center fields grouped, right rail
const TriageView = ({ fields, counts, t, onApprove, onEdit, editingId, editValue, setEditValue, onSave, onCancel, setTweak }) => {
  const missing = fields.filter(f => f.status === 'missing');
  const review = fields.filter(f => f.status === 'review');
  const done = fields.filter(f => f.status === 'done');

  return (
    <div className="workspace" style={{ gridTemplateColumns: t.showRail ? '280px 1fr 320px' : '280px 1fr' }}>
      {/* LEFT: queue + dial */}
      <div className="col left">
        <div className="dial-card">
          <div className="dial-card-head">
            <span>Active Case</span>
            <span style={{ color: 'var(--teal)', fontSize: 11 }}>● Active</span>
          </div>
          <div>
            <div style={{ fontSize: 16, fontWeight: 700, color: 'white' }}>{CASE.client}</div>
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)' }}>{CASE.provider} · {CASE.planType}</div>
          </div>
          <Dial done={counts.done} review={counts.review} missing={counts.missing} total={counts.total} />
        </div>

        <div className="queue-head">
          <span>Cases Needing Data</span>
          <span className="count">{QUEUE.length}</span>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {QUEUE.map(c => <CaseCard key={c.id} c={c} active={c.id === 'CASE-001'} />)}
        </div>
      </div>

      {/* CENTER: fields */}
      <div className="col center">
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--ink-4)', fontWeight: 600 }}>Step 1 · Resolve before calling</div>
            <h1 style={{ fontSize: 24, fontWeight: 700, margin: '4px 0 0', letterSpacing: '-0.02em' }}>What's blocking this case</h1>
            <p style={{ margin: '6px 0 0', fontSize: 14, color: 'var(--ink-3)', maxWidth: 600 }}>
              AI extracted {counts.total} fields from the Aviva statement. <b style={{ color: 'var(--bad)' }}>{counts.missing} are missing</b> and <b style={{ color: 'var(--warn)' }}>{counts.review} need review</b>. Resolve what you can from documents, then prepare a call script for the rest.
            </p>
          </div>
          <button className="btn primary" onClick={() => setTweak('phase', 'script')}>
            Prepare call script<Icon name="arrowR" size={14}/>
          </button>
        </div>

        <div className="fields-group">
          <div className="section-head">
            <div className="section-title bad"><Icon name="alert" size={14} style={{ color: 'var(--bad)' }}/>Missing<span className="count">{counts.missing}</span></div>
            <div className="section-actions">
              <button className="btn sm ghost"><Icon name="upload" size={12}/>Re-upload</button>
            </div>
          </div>
          {missing.map(f => (
            <FieldCard key={f.id} f={f} mode="triage" onApprove={onApprove} onEdit={onEdit}
              editing={editingId === f.id} editValue={editValue} setEditValue={setEditValue} onSave={onSave} onCancel={onCancel}
              showEvidence={t.showSourceQuotes} />
          ))}
        </div>

        <div className="fields-group">
          <div className="section-head">
            <div className="section-title warn"><Icon name="alertTri" size={14} style={{ color: 'var(--warn)' }}/>Needs Review<span className="count">{counts.review}</span></div>
            <button className="btn sm ghost">Approve all high-conf</button>
          </div>
          {review.map(f => (
            <FieldCard key={f.id} f={f} mode="triage" onApprove={onApprove} onEdit={onEdit}
              editing={editingId === f.id} editValue={editValue} setEditValue={setEditValue} onSave={onSave} onCancel={onCancel}
              showEvidence={t.showSourceQuotes} />
          ))}
        </div>

        <div className="fields-group">
          <div className="section-head">
            <div className="section-title"><Icon name="check" size={14} style={{ color: 'var(--good)' }}/>Approved<span className="count">{counts.done}</span></div>
          </div>
          {done.slice(0, 3).map(f => (
            <FieldCard key={f.id} f={f} mode="triage" showEvidence={t.showSourceQuotes} />
          ))}
          {done.length > 3 && (
            <button className="btn ghost" style={{ alignSelf: 'flex-start' }}>
              + Show {done.length - 3} more approved fields
            </button>
          )}
        </div>
      </div>

      {/* RIGHT */}
      {t.showRail && (
        <div className="col right">
          <ProviderRail phase="idle" />
          <RecentRail />
        </div>
      )}
    </div>
  );
};

// PHASE 2: SCRIPT — fields list (still left), center is generated script, hover links
const ScriptView = ({ fields, counts, t, hoveredQ, setHoveredQ, setTweak }) => {
  const open = fields.filter(f => f.askOnCall && (f.status === 'missing' || f.status === 'review'));

  return (
    <div className="workspace" style={{ gridTemplateColumns: '320px 1fr 320px' }}>
      <div className="col left" style={{ background: 'var(--surface)' }}>
        <div className="queue-head"><span>Items to ask</span><span className="count">{open.length}</span></div>
        <div style={{ fontSize: 12, color: 'var(--ink-3)', padding: '0 4px 8px' }}>
          The AI script below will populate these fields. Hover a field to see which question covers it.
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {open.map(f => (
            <div key={f.id}
              className={'field ' + f.status + (hoveredQ === f.q ? ' linked' : '')}
              onMouseEnter={() => setHoveredQ(f.q)}
              onMouseLeave={() => setHoveredQ(null)}>
              <div className="field-head" style={{ paddingBottom: 8 }}>
                <div className="field-meta">
                  <div className="field-section">{f.section}</div>
                  <div className="field-label" style={{ fontSize: 13 }}>{f.label}</div>
                </div>
                <span className={'field-status ' + f.status}>{f.status === 'missing' ? 'Missing' : 'Review'}</span>
              </div>
              {f.q && <div style={{ padding: '0 16px 12px', fontSize: 11, color: 'var(--teal-2)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>↳ Question {f.q.toUpperCase()}</div>}
            </div>
          ))}
        </div>
      </div>

      <div className="col center">
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--ink-4)', fontWeight: 600 }}>Step 2 · AI-drafted call script</div>
            <h1 style={{ fontSize: 24, fontWeight: 700, margin: '4px 0 0', letterSpacing: '-0.02em' }}>Ready to call {CASE.provider}</h1>
            <p style={{ margin: '6px 0 0', fontSize: 14, color: 'var(--ink-3)' }}>{open.length} questions across {SCRIPT.sections.length} sections · est. 4 minutes</p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn"><Icon name="refresh" size={14}/>Regenerate</button>
            <button className="btn teal" onClick={() => setTweak('phase', 'live')}>
              <Icon name="phoneCall" size={14}/>Start call
            </button>
          </div>
        </div>

        <div className="script">
          <div className="script-head">
            <span className="badge">AI</span>
            <span className="title">Call script · drafted from missing & low-confidence fields</span>
            <Icon name="sparkles" size={14}/>
          </div>
          <div className="script-body">
            <div className="script-section-title">Opener</div>
            <div className="script-narrative" dangerouslySetInnerHTML={{ __html: SCRIPT.opener }} />

            {SCRIPT.sections.map(sec => (
              <React.Fragment key={sec.title}>
                <div className="script-section-title">{sec.title}</div>
                {sec.questions.map((q, i) => (
                  <div
                    key={q.id}
                    className={'script-q' + (hoveredQ === q.id ? ' active' : '')}
                    onMouseEnter={() => setHoveredQ(q.id)}
                    onMouseLeave={() => setHoveredQ(null)}>
                    <div className="script-q-num">{q.id.replace('q','')}</div>
                    <div className="script-q-body">
                      <div className="script-q-purpose">{q.purpose}</div>
                      <div className="script-q-text">{q.text}</div>
                      <div className="script-q-link"><Icon name="arrowR" size={11}/>fills <b style={{ color: 'var(--ink-2)' }}>{fields.find(f => f.id === q.linksTo)?.label}</b></div>
                    </div>
                  </div>
                ))}
              </React.Fragment>
            ))}

            <div className="script-section-title">Closing</div>
            <div className="script-narrative" dangerouslySetInnerHTML={{ __html: SCRIPT.closing }} />
          </div>
        </div>
      </div>

      <div className="col right">
        <ProviderRail phase="dialling" />
        <div className="rail-card">
          <div className="rail-head"><Icon name="sparkles" size={14}/>Script tips</div>
          <div className="rail-body" style={{ fontSize: 12, color: 'var(--ink-3)', lineHeight: 1.6 }}>
            <p style={{ margin: 0 }}>Aviva's pensions servicing team typically takes <b style={{ color: 'var(--ink) '}}>4-7 mins</b> to verify a plan. Have the LOA reference and plan number ready.</p>
            <p style={{ margin: '8px 0 0' }}>This script was generated from <b style={{ color: 'var(--ink)' }}>3 missing fields</b> and <b style={{ color: 'var(--ink)' }}>4 low-confidence fields</b>.</p>
          </div>
        </div>
      </div>
    </div>
  );
};

// PHASE 3: LIVE CALL — split: script left, transcript center, fields update right
const LiveCallView = ({ fields, counts, t, transcript, answeredQs, activeQ, suggestions, timer }) => {
  const open = fields.filter(f => f.askOnCall);
  const transcriptRef = useRef(null);
  useEffect(() => {
    if (transcriptRef.current) transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
  }, [transcript]);

  return (
    <div className="workspace" style={{ gridTemplateColumns: '320px 1fr 360px' }}>
      <div className="col left" style={{ background: 'var(--surface)' }}>
        <div className="queue-head"><span>Script progress</span><span className="count">{Object.keys(answeredQs).length}/{SCRIPT.sections.flatMap(s=>s.questions).length}</span></div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 8 }}>
          {SCRIPT.sections.map(sec => (
            <div key={sec.title}>
              <div className="script-section-title" style={{ marginBottom: 6 }}>{sec.title}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {sec.questions.map(q => (
                  <div key={q.id}
                    className={'script-q' + (activeQ === q.id && !answeredQs[q.id] ? ' active' : '') + (answeredQs[q.id] ? ' answered' : '')}
                    style={{ padding: '8px 10px' }}>
                    <div className="script-q-num" style={{ width: 20, height: 20, fontSize: 10 }}>
                      {answeredQs[q.id] ? <Icon name="check" size={10}/> : q.id.replace('q','')}
                    </div>
                    <div className="script-q-body">
                      <div className="text" style={{ fontSize: 12, lineHeight: 1.4, color: 'var(--ink-2)' }}>{q.text}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="col center">
        <div className="transcript">
          <div className="transcript-head">
            <span className="rec"/>
            <span className="title">Live transcript · Aviva Pensions Servicing</span>
            <span className="timer tnum">REC {timer}</span>
          </div>
          <div className="transcript-body" ref={transcriptRef}>
            {transcript.length === 0 && (
              <div style={{ textAlign: 'center', padding: '40px 20px', color: 'var(--ink-4)' }}>
                <Icon name="phoneCall" size={32} style={{ opacity: 0.3 }}/>
                <div style={{ marginTop: 10, fontSize: 13 }}>Connecting…</div>
              </div>
            )}
            {transcript.map((u, i) => (
              <div key={i} className={'utter ' + u.side}>
                <div className="who">{u.who}</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, maxWidth: '70%' }}>
                  <div className="bub">{u.text}</div>
                  {u.extracted && (
                    <div className="extracted">
                      <Icon name="sparkles" size={12} style={{ color: 'var(--good)' }}/>
                      <span className="lbl">Auto-fill</span>
                      <span className="val">{fields.find(f => f.id === u.extracted.fieldId)?.label}: {u.extracted.value}</span>
                      <Conf level={u.extracted.confidence} value={u.extracted.conf}/>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>

        <div style={{ marginTop: 16, display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="btn"><Icon name="pause" size={14}/>Pause recording</button>
          <button className="btn ghost"><Icon name="edit" size={14}/>Add note</button>
          <div style={{ flex: 1 }}/>
          <span style={{ fontSize: 12, color: 'var(--ink-3)' }}>Auto-saving · transcript stored in case audit log</span>
        </div>
      </div>

      <div className="col right">
        <ProviderRail phase="live" secs={timer} />
        <div className="rail-card">
          <div className="rail-head"><Icon name="sparkles" size={14}/>Fields filling in</div>
          <div className="rail-body" style={{ padding: 10, gap: 8 }}>
            {open.map(f => {
              const sug = suggestions[f.id];
              return (
                <div key={f.id} style={{
                  padding: '8px 10px',
                  background: sug ? 'rgba(13,148,136,0.06)' : 'var(--bg-2)',
                  borderRadius: 6,
                  border: sug ? '1px solid rgba(13,148,136,0.3)' : '1px solid transparent',
                  transition: 'all .3s'
                }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'var(--ink-4)', textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 600 }}>
                    {f.section}
                    {sug && <Icon name="check" size={11} style={{ color: 'var(--good)', marginLeft: 'auto' }}/>}
                  </div>
                  <div style={{ fontSize: 13, fontWeight: 600, marginTop: 2 }}>{f.label}</div>
                  {sug ? (
                    <div style={{ fontSize: 12, marginTop: 4, color: 'var(--good)', fontWeight: 600 }}>{sug.value}</div>
                  ) : (
                    <div style={{ fontSize: 11, marginTop: 4, color: 'var(--ink-4)' }}>Listening…</div>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
};

// PHASE 4: REVIEW — apply findings, all fields ready to approve
const ReviewView = ({ fields, counts, t, suggestions }) => {
  const updated = fields.filter(f => f.askOnCall);
  return (
    <div className="workspace" style={{ gridTemplateColumns: '1fr 360px' }}>
      <div className="col center">
        <div style={{ display: 'flex', alignItems: 'flex-end', justifyContent: 'space-between', marginBottom: 12 }}>
          <div>
            <div style={{ fontSize: 11, textTransform: 'uppercase', letterSpacing: '0.08em', color: 'var(--ink-4)', fontWeight: 600 }}>Step 4 · Apply call findings</div>
            <h1 style={{ fontSize: 24, fontWeight: 700, margin: '4px 0 0', letterSpacing: '-0.02em' }}>Confirm new values</h1>
            <p style={{ margin: '6px 0 0', fontSize: 14, color: 'var(--ink-3)' }}>
              The transcript was processed. {updated.length} fields have proposed values from the call. Review and approve.
            </p>
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button className="btn">Discard call data</button>
            <button className="btn primary"><Icon name="check" size={14}/>Approve all & continue</button>
          </div>
        </div>

        <div className="fields-group">
          {updated.map(f => (
            <FieldCard key={f.id} f={{ ...f, status: 'review' }} mode="review" showEvidence={false}
              suggestion={suggestions[f.id] || { value: f.value, confidence: f.confidence, conf: f.conf }} />
          ))}
        </div>
      </div>
      <div className="col right">
        <div className="rail-card">
          <div className="rail-head"><Icon name="phone" size={14}/>Call summary</div>
          <div className="rail-body" style={{ fontSize: 13, lineHeight: 1.6 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: 'var(--ink-3)' }}>Duration</span><b>04:21</b></div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: 'var(--ink-3)' }}>Spoke with</span><b>Mark · Aviva</b></div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: 'var(--ink-3)' }}>Questions answered</span><b>7 / 7</b></div>
            <div style={{ display: 'flex', justifyContent: 'space-between' }}><span style={{ color: 'var(--ink-3)' }}>Auto-extracted</span><b style={{ color: 'var(--good)' }}>{updated.length} fields</b></div>
            <div style={{ height: 1, background: 'var(--line)', margin: '10px 0' }}/>
            <button className="btn ghost" style={{ width: '100%', justifyContent: 'flex-start' }}><Icon name="doc" size={14}/>View full transcript</button>
          </div>
        </div>
        <ProviderRail phase="idle" />
      </div>
    </div>
  );
};

// PHASE 5: DONE — handoff card
const DoneView = ({ fields, counts, t, setTweak }) => (
  <div className="workspace" style={{ gridTemplateColumns: '1fr', placeItems: 'center', alignItems: 'flex-start', padding: '40px 24px' }}>
    <div style={{ width: '100%', maxWidth: 680, display: 'flex', flexDirection: 'column', gap: 16 }}>
      <div className="complete-card">
        <div className="ico"><Icon name="check" size={32}/></div>
        <h2>Case ready for adviser review</h2>
        <p>All {counts.total} checklist fields for <b style={{ color: 'white' }}>{CASE.client}</b>'s {CASE.planType} are complete. The case has been routed to the assigned adviser.</p>
        <div className="complete-stats">
          <div className="complete-stat"><div className="num tnum">{counts.total}</div><div className="lbl">Fields complete</div></div>
          <div className="complete-stat"><div className="num tnum">04:21</div><div className="lbl">Call duration</div></div>
          <div className="complete-stat"><div className="num tnum" style={{ color: 'var(--teal)' }}>96%</div><div className="lbl">Avg confidence</div></div>
        </div>
        <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 22 }}>
          <button className="btn" style={{ background: 'rgba(255,255,255,0.08)', borderColor: 'rgba(255,255,255,0.15)', color: 'white' }} onClick={() => setTweak('phase', 'triage')}>
            <Icon name="refresh" size={14}/>Start over
          </button>
          <button className="btn teal"><Icon name="arrowR" size={14}/>Open next case</button>
        </div>
      </div>

      <div className="rail-card" style={{ background: 'var(--surface)' }}>
        <div className="rail-head"><Icon name="list" size={14}/>What happens next</div>
        <div style={{ padding: 0 }}>
          {[
            { who: 'Adviser', what: 'Sarah Khan reviews the checklist & signs off', when: 'Pending', icon: 'check' },
            { who: 'System', what: 'Excel checklist exported to Zoho WorkDrive', when: 'On approval', icon: 'doc' },
            { who: 'Zoho CRM', what: 'Case status updated to "Ready for Ceding"', when: 'Auto', icon: 'zap' },
          ].map((a, i) => (
            <div key={i} style={{ padding: '14px 18px', borderTop: i ? '1px solid var(--line-2)' : 'none', display: 'flex', gap: 12, alignItems: 'center' }}>
              <div style={{ width: 32, height: 32, borderRadius: 8, background: 'var(--bg-2)', display: 'grid', placeItems: 'center', color: 'var(--ink-3)' }}>
                <Icon name={a.icon} size={14}/>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{a.who}</div>
                <div style={{ fontSize: 12, color: 'var(--ink-3)' }}>{a.what}</div>
              </div>
              <span className="pill" style={{ height: 22, fontSize: 11 }}>{a.when}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  </div>
);

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
