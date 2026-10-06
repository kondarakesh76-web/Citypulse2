import { useEffect, useMemo, useState, type FormEvent, type ReactNode, type ButtonHTMLAttributes } from 'react';
import { QueryClient, QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import { Route, Switch, Link, Router as WouterRouter, useLocation, useRoute } from 'wouter';
import { Activity, AlertTriangle, ArrowDownRight, ArrowRight, ArrowUpRight, Bell, Check, CheckCircle2, ChevronDown, ChevronRight, CircleHelp, ClipboardList, Clock3, CloudRain, Crosshair, FileCheck2, Filter, Gauge, Home, Layers3, Lightbulb, LogOut, Map, MapPin, Menu, MessageSquareText, Minus, Plus, Search, Send, Settings, ShieldCheck, Siren, Sparkles, TrendingUp, Upload, X } from 'lucide-react';
import {
  useGetCityDashboard, useListCityReports, useCreateCityReport, useAnalyzeCityReport,
  useGetCityReport, useUpdateCityReportStatus, useListCityRiskScores,
  useListCityPredictions, useGetCityAnalytics, useAskCityAssistant,
  useListCityAlerts, useUpdateCityAlert, getGetCityDashboardQueryKey,
  getListCityReportsQueryKey, getListCityRiskScoresQueryKey,
} from '@workspace/api-client-react';
import type { Report } from '@workspace/api-client-react';
import { supabase, supabaseConfigured } from '@/lib/supabase';
import { ErrorBoundary } from '@/components/error-boundary';
import { Toaster } from '@/components/ui/toaster';
import { TooltipProvider } from '@/components/ui/tooltip';
import './index.css';

const queryClient = new QueryClient();
const categories = ['Traffic', 'Flooding', 'Road Damage', 'Garbage', 'Streetlight', 'Pollution', 'Infrastructure'];
const fmtDate = (value?: string | null) => value ? new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '—';
const fmtTime = (value?: string | null) => value ? new Date(value).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—';
const pct = (value?: number | null) => `${Math.round((value ?? 0) * 100)}%`;
const cap = (value?: string) => (value ?? '').replaceAll('_', ' ').toLowerCase().replace(/\b\w/g, x => x.toUpperCase());

function Button({ children, className = '', variant = 'primary', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: 'primary' | 'ghost' | 'danger' | 'outline' }) {
  return <button {...props} className={`btn btn-${variant} ${className}`} data-testid="button-action">{children}</button>;
}
function Panel({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`panel ${className}`}>{children}</section>;
}
function SectionHeading({ eyebrow, title, children }: { eyebrow?: string; title: string; children?: ReactNode }) {
  return <div className="section-heading"><div>{eyebrow && <div className="eyebrow">{eyebrow}</div>}<h1>{title}</h1></div>{children}</div>;
}
function QueryState({ loading, error, retry, children }: { loading?: boolean; error?: unknown; retry?: () => void; children: ReactNode }) {
  if (loading) return <div className="skeleton-wrap"><div className="skeleton wide" /><div className="skeleton" /><div className="skeleton" /></div>;
  if (error) return <div className="state-box"><AlertTriangle size={22} /><div><b>Couldn’t load this view</b><p>Check your connection and try again.</p></div><Button variant="outline" onClick={retry}>Retry</Button></div>;
  return <>{children}</>;
}
function Status({ value }: { value: string }) {
  const tone = value === 'VERIFIED' || value === 'RESOLVED' ? 'good' : value === 'REJECTED' ? 'bad' : value === 'IN_PROGRESS' || value === 'ASSIGNED' ? 'blue' : 'warn';
  return <span className={`status ${tone}`}><i />{cap(value)}</span>;
}
function ReportCard({ report, compact = false }: { report: Report; compact?: boolean }) {
  return <Link href={`/my-reports/${report.id}`} className={`report-card ${compact ? 'compact' : ''}`} data-testid={`link-report-${report.id}`}>
    <div className="report-marker"><MapPin size={16} /></div>
    <div className="report-main"><div className="report-line"><span className="eyebrow">{report.category}</span><Status value={report.status} /></div>
      <h3>{report.title}</h3><p>{report.location_name || 'Location not specified'} <span className="dot-sep">·</span> {fmtDate(report.created_at)}</p>
    </div><ChevronRight className="row-chevron" size={17} />
  </Link>;
}
function EvidenceImage({ path, className = '', alt = 'Submitted evidence' }: { path: string; className?: string; alt?: string }) {
  const [url, setUrl] = useState('');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    setUrl('');
    setFailed(false);
    if (/^https?:\/\//i.test(path)) {
      setUrl(path);
      return () => { active = false; };
    }
    if (!supabase) {
      setFailed(true);
      return () => { active = false; };
    }
    supabase.storage.from('report-images').createSignedUrl(path, 3600).then(({ data, error }) => {
      if (!active) return;
      if (error || !data?.signedUrl) setFailed(true);
      else setUrl(data.signedUrl);
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [path]);
  if (failed) return <div className="evidence-unavailable">Evidence image is unavailable.</div>;
  if (!url) return <div className="evidence-loading">Loading secure evidence…</div>;
  return <img className={className} src={url} alt={alt} />;
}
const citizenNav = [
  { href: '/dashboard', label: 'Overview', icon: Home },
  { href: '/report', label: 'Submit a report', icon: Plus },
  { href: '/my-reports', label: 'My reports', icon: ClipboardList },
  { href: '/map', label: 'City map', icon: Map },
];
const staffNav = [
  { href: '/control-room', label: 'Control room', icon: Gauge },
  { href: '/reports', label: 'Verification queue', icon: FileCheck2 },
  { href: '/analytics', label: 'Analytics', icon: Activity },
  { href: '/ai-assistant', label: 'City assistant', icon: Sparkles },
];

function AppShell({ children }: { children: ReactNode }) {
  const [path, setLocation] = useLocation();
  const [open, setOpen] = useState(false);
  const [sessionReady, setSessionReady] = useState(false);
  const [hasSession, setHasSession] = useState(false);
  const [userEmail, setUserEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const roleQuery = useGetCityDashboard({ query: { queryKey: getGetCityDashboardQueryKey(), enabled: hasSession } });
  useEffect(() => {
    let mounted = true;
    if (!supabase) {
      setSessionReady(true);
      return () => { mounted = false; };
    }
    supabase.auth.getSession().then(({ data }) => {
      if (!mounted) return;
      const session = data.session;
      setHasSession(Boolean(session));
      setUserEmail(session?.user.email ?? '');
      setDisplayName(
        String(session?.user.user_metadata?.full_name ?? session?.user.email?.split('@')[0] ?? ''),
      );
      setSessionReady(true);
    }).catch(() => {
      if (mounted) setSessionReady(true);
    });
    const { data } = supabase.auth.onAuthStateChange((_event, session) => {
      setHasSession(Boolean(session));
      setUserEmail(session?.user.email ?? '');
      setDisplayName(
        String(session?.user.user_metadata?.full_name ?? session?.user.email?.split('@')[0] ?? ''),
      );
      setSessionReady(true);
    });
    return () => { mounted = false; data.subscription.unsubscribe(); };
  }, []);
  useEffect(() => {
    if (sessionReady && !hasSession && supabaseConfigured) setLocation('/login');
  }, [hasSession, sessionReady, setLocation]);
  if (!supabaseConfigured) {
    return <div className="setup-required"><Activity size={24}/><h1>Connect CityPulse to Supabase</h1><p>Add the Supabase project URL and publishable key in Replit Secrets, then reload this page.</p><Link href="/" className="btn btn-primary">Back to CityPulse</Link></div>;
  }
  if (!sessionReady || !hasSession) {
    return <div className="auth-loading"><span className="live-dot"/><p>{sessionReady ? 'Opening sign in…' : 'Connecting to CityPulse…'}</p></div>;
  }
  const isAdmin = roleQuery.data?.role === 'ADMIN';
  const links = isAdmin ? [...staffNav, ...citizenNav] : citizenNav;
  return <div className="app-shell">
    <aside className={`sidebar ${open ? 'open' : ''}`}>
      <Link href="/" className="brand" onClick={() => setOpen(false)}><span className="brand-mark"><Activity size={19} /></span><span>city<span className="brand-pulse">pulse</span><small>CIVIC INTELLIGENCE</small></span></Link>
      <div className="workspace-label">WORKSPACE</div>
        <nav className="side-nav">{links.map(item => <Link key={item.href} href={item.href} className={`nav-link ${path === item.href || (item.href === '/my-reports' && path.startsWith('/my-reports')) ? 'active' : ''}`} onClick={() => setOpen(false)}><item.icon size={17} /><span>{item.label}</span>{item.href === '/reports' && <span className="nav-count">{roleQuery.data?.pending ?? 0}</span>}</Link>)}</nav>
      <div className="nav-divider" />
      <Link href="/settings" className={`nav-link ${path === '/settings' ? 'active' : ''}`}><Settings size={17} /><span>Settings</span></Link>
      <div className="sidebar-bottom">
        <div className="signal-card"><span className="signal-live"><i /> PILOT NETWORK</span><b>CityPulse</b><small>Prototype civic intelligence</small><div className="signal-bars"><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /></div></div>
        <div className="profile-row"><span className="avatar">{userEmail ? userEmail.slice(0, 1).toUpperCase() : 'C'}</span><span className="profile-meta"><b>{displayName || userEmail.split('@')[0]}</b><small>{isAdmin ? 'City staff' : 'Community member'}</small></span><ChevronDown size={15} /></div>
      </div>
    </aside>
    {open && <button aria-label="Close navigation" className="mobile-scrim" onClick={() => setOpen(false)} />}
    <main className="main-area">
      <header className="topbar">
        <button className="icon-btn mobile-menu" aria-label="Open menu" onClick={() => setOpen(true)}><Menu size={20} /></button>
        <div className="crumb"><span>PILOT CITY</span><ChevronRight size={13} /> <b>{path.split('/').filter(Boolean).pop()?.replace('-', ' ') || 'HOME'}</b></div>
        <div className="top-actions"><span className="live-pill"><i /> PROTOTYPE DATA</span><Link href="/settings" className="icon-btn" aria-label="Settings"><Bell size={18} /></Link><span className="top-avatar">{userEmail ? userEmail.slice(0, 1).toUpperCase() : 'C'}</span></div>
      </header>
      <div className="page-content">{children}</div>
    </main>
  </div>;
}
function ShellPage({ children }: { children: ReactNode }) { return <AppShell>{children}</AppShell>; }

function Landing() {
  return <div className="landing">
    <header className="landing-nav"><Link href="/" className="brand"><span className="brand-mark"><Activity size={19} /></span><span>city<span className="brand-pulse">pulse</span></span></Link><div><Link href="/login" className="nav-login">Sign in</Link><Link href="/signup" className="btn btn-primary">Join the network <ArrowRight size={15} /></Link></div></header>
    <section className="landing-hero">
      <div className="landing-demo-note"><Sparkles size={14}/> SIMULATED DEMO DATA · NOT LIVE CITY CONDITIONS</div>
      <div className="hero-copy"><div className="overline"><span className="live-dot" /> A clearer signal for city life</div><h1>Better cities<br />start with <em>being heard.</em></h1><p>One place to surface what needs attention, follow the response, and help city teams act on evidence.</p><div className="hero-actions"><Link href="/signup" className="btn btn-primary">Report an issue <ArrowRight size={16} /></Link><Link href="/map" className="btn btn-outline">Explore city signals <Map size={16} /></Link></div><div className="hero-proof"><div className="proof-avatars"><i>ML</i><i>JS</i><i>AK</i><i>+</i></div><span>Residents and city teams, in sync.</span></div></div>
      <div className="hero-visual"><div className="visual-grid" /><div className="orb orb-a" /><div className="orb orb-b" /><div className="map-lines"><svg viewBox="0 0 560 460" role="img" aria-label="Illustrative city network map"><path d="M54 335 135 266l67 24 38-72 91 32 61-94 117 36M80 129l83 48 48-45 74 49 90-71 112 43M101 398l56-105 69 13 44-93 63 10 80-91M220 66l-8 79 38 72-48 73 20 88M406 37l-19 119 40 76-38 90 37 90M35 220l123 15 74-47 94 17 73-64 119 9" /></svg><span className="map-pin pin-one"><i /><b>North Wharf</b><small>Infrastructure · sample</small></span><span className="map-pin pin-two"><i /><b>Old Market</b><small>Flood watch · sample</small></span><span className="map-pin pin-three"><i /><b>East Junction</b><small>Road damage · sample</small></span></div><div className="visual-top"><span>PILOT CITY / EXAMPLE MAP</span><span><i /> SIMULATED</span></div><div className="visual-card"><small>SIMULATED EXAMPLE · 24H</small><strong>128 <span>sample</span></strong><div className="mini-bars">{[20,34,28,49,37,60,45,69,55,77,62,92,68,84,72,100,78,90,66,80].map((n,i)=><i key={i} style={{height:`${n}%`}} />)}</div><div className="visual-card-foot"><span><i className="dot-cyan" /> VERIFIED EXAMPLES</span><span><i className="dot-red" /> NEEDS REVIEW</span></div></div><span className="coord-tag">12.9752° N&nbsp; / &nbsp;77.6044° E · SAMPLE</span></div>
    </section>
    <section className="landing-statbar"><div><b>One civic signal</b><span>Connected reporting for residents and staff.</span></div><div><b>Human verified</b><span>AI assists. People make the call.</span></div><div><b>Visible progress</b><span>Every report has a status and timeline.</span></div></section>
    <section className="landing-section"><div className="eyebrow">THE CIVIC FEEDBACK LOOP</div><h2>From street-level signal<br />to city-level response.</h2><div className="loop-grid"><article><span>01 / NOTICE</span><MapPin size={22} /><h3>Spot something that matters</h3><p>Document an issue with a location, a little context, and evidence that helps the right team understand.</p></article><article><span>02 / REVIEW</span><ShieldCheck size={22} /><h3>Evidence before escalation</h3><p>Automated analysis helps organize incoming reports. City staff review evidence before risk scores change.</p></article><article><span>03 / RESPOND</span><TrendingUp size={22} /><h3>See what happens next</h3><p>Follow verification, assignment, and resolution in one transparent civic record.</p></article></div></section>
    <section className="landing-bottom"><div><span className="eyebrow">PILOT CITY · DEMONSTRATION NETWORK</span><h2>Small signals.<br /><em>Better decisions.</em></h2><p>Join a more accountable way to care for the places we share.</p></div><Link href="/signup" className="btn btn-primary">Get started <ArrowRight size={16} /></Link><div className="bottom-grid" /></section>
    <footer className="landing-footer"><Link href="/" className="brand"><span className="brand-mark"><Activity size={17} /></span><span>city<span className="brand-pulse">pulse</span></span></Link><span>Prototype civic intelligence · Pilot City</span><Link href="/login">Staff access <ArrowRight size={14} /></Link></footer>
  </div>;
}

function AuthPage({ signup = false }: { signup?: boolean }) {
  const [, setLocation] = useLocation();
  const [email, setEmail] = useState(''); const [password, setPassword] = useState('');
  const [name, setName] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault(); setBusy(true); setError('');
    try {
      if (!supabase) throw new Error('Supabase is not configured for this app yet.');
      const result = signup ? await supabase.auth.signUp({ email, password, options: { data: { full_name: name, role: 'CITIZEN' } } }) : await supabase.auth.signInWithPassword({ email, password });
      if (result.error) throw result.error;
      if (signup && !result.data.session) {
        setError('Your account was created. Check your email to confirm it, then sign in.');
        return;
      }
      setLocation('/dashboard');
    } catch (err: any) { setError(err?.message || 'Authentication is temporarily unavailable.'); } finally { setBusy(false); }
  }
  return <div className="auth-page"><div className="auth-art"><Link href="/" className="brand"><span className="brand-mark"><Activity size={19} /></span><span>city<span className="brand-pulse">pulse</span></span></Link><div className="auth-art-copy"><span className="eyebrow">A CITY THAT LISTENS</span><h2>Make your<br />corner count.</h2><p>Better local decisions start with the people who live here.</p><div className="auth-art-lines" /></div><div className="auth-art-foot">HARBOR CITY / COMMUNITY NETWORK <span>37.7749° N</span></div></div><div className="auth-main"><Link href="/" className="auth-back"><ArrowRight size={15} /> Back to CityPulse</Link><form className="auth-card" onSubmit={submit}><span className="eyebrow">{signup ? 'JOIN THE NETWORK' : 'WELCOME BACK'}</span><h1>{signup ? 'Create your account' : 'Sign in to CityPulse'}</h1><p>{signup ? 'Get updates on the issues shaping your neighborhood.' : 'Your neighborhood signal is waiting.'}</p>{signup && <label>Full name<input required value={name} onChange={e=>setName(e.target.value)} placeholder="Morgan Lee" data-testid="input-full-name" /></label>}<label>Email address<input required type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="you@example.com" data-testid="input-email" /></label><label>Password<input required type="password" minLength={6} value={password} onChange={e=>setPassword(e.target.value)} placeholder="At least 6 characters" data-testid="input-password" /></label>{error && <div className="form-error">{error}</div>}<Button type="submit" disabled={busy} className="auth-submit">{busy ? 'Working…' : signup ? 'Create account' : 'Sign in'} <ArrowRight size={16} /></Button><div className="auth-switch">{signup ? 'Already part of the network?' : 'New to CityPulse?'} <Link href={signup ? '/login' : '/signup'}>{signup ? 'Sign in' : 'Create an account'}</Link></div><div className="trust-note"><ShieldCheck size={15} /> Your account is protected by secure authentication.</div></form></div></div>;
}

function Dashboard() {
  const q = useGetCityDashboard(); const reports = useListCityReports({ limit: 6 });
  const summary = q.data; const list = reports.data ?? summary?.recent_reports ?? [];
  return <ShellPage><SectionHeading eyebrow="YOUR CITY, IN FOCUS" title="Good morning, Morgan."><span className="subhead">Here’s what’s moving across Harbor City today.</span><Link href="/report" className="btn btn-primary"><Plus size={16} /> New report</Link></SectionHeading>
    <QueryState loading={q.isLoading && reports.isLoading} error={q.error || reports.error} retry={()=>{q.refetch(); reports.refetch();}}>
      <div className="metric-grid"><Metric label="Reports submitted" value={summary?.total_reports ?? 0} detail="Across Harbor City" icon={<ClipboardList />} /><Metric label="Awaiting review" value={summary?.pending ?? 0} detail="Human verification required" icon={<Clock3 />} accent="amber" /><Metric label="Verified issues" value={summary?.verified ?? 0} detail="Evidence checked by staff" icon={<CheckCircle2 />} accent="green" /><Metric label="Resolved" value={summary?.resolved ?? 0} detail="Closed with city action" icon={<Check />} accent="cyan" /></div>
      {summary?.demo_mode && <div className="demo-banner"><Sparkles size={15} /> DEMO DATA <span>Prototype reporting metrics. Risk scores are not used for operational decisions.</span></div>}
      <div className="content-grid wide-left"><Panel><div className="panel-head"><div><span className="eyebrow">COMMUNITY ACTIVITY</span><h2>Recent reports</h2></div><Link className="text-link" href="/my-reports">All reports <ArrowRight size={14} /></Link></div>{list.length ? <div className="report-list">{list.map(r=><ReportCard key={r.id} report={r} compact />)}</div> : <EmptyState title="No reports yet" body="Your first report can help the city see what needs attention." action={<Link href="/report" className="btn btn-outline">Submit a report <ArrowRight size={14} /></Link>} />}</Panel>
      <Panel className="pulse-panel"><span className="eyebrow">CITY PULSE</span><h2>Attention is a<br /><em>public good.</em></h2><p>Reports stay pending until city staff review the evidence. Automated analysis can help prioritize—not decide.</p><div className="pulse-mark"><Activity size={27} /></div><Link href="/map" className="text-link">Explore the city map <ArrowRight size={14} /></Link></Panel></div>
      <Panel className="quick-panel"><span className="eyebrow">QUICK ACCESS</span><div className="quick-links"><Link href="/map"><Map size={18}/><b>City signal map</b><span>Prototype risk layers</span><ArrowRight size={15}/></Link><Link href="/my-reports"><ClipboardList size={18}/><b>Track my reports</b><span>Updates and timelines</span><ArrowRight size={15}/></Link><Link href="/report"><Plus size={18}/><b>Report an issue</b><span>Send a signal to the city</span><ArrowRight size={15}/></Link></div></Panel>
    </QueryState>
  </ShellPage>;
}
function Metric({ label, value, detail, icon, accent = '' }: { label: string; value: number | string; detail: string; icon: ReactNode; accent?: string }) {
  return <Panel className="metric"><div className={`metric-icon ${accent}`}>{icon}</div><span>{label}</span><strong>{value}</strong><small>{detail}</small></Panel>;
}
function EmptyState({ title, body, action }: { title: string; body: string; action?: ReactNode }) {
  return <div className="empty-state"><span><Layers3 size={22}/></span><h3>{title}</h3><p>{body}</p>{action}</div>;
}

function ReportForm() {
  const create = useCreateCityReport(); const analyze = useAnalyzeCityReport(); const qc = useQueryClient(); const [, setLocation] = useLocation();
  const [category,setCategory]=useState('Road Damage'); const [severity,setSeverity]=useState('MEDIUM');
  const [title,setTitle]=useState(''); const [description,setDescription]=useState(''); const [location,setLoc]=useState('');
  const [lat,setLat]=useState(''); const [lng,setLng]=useState(''); const [image,setImage]=useState(''); const [imagePreview,setImagePreview]=useState(''); const [aiPreview,setAiPreview]=useState<any>(null); const [error,setError]=useState('');
  const upload = async (file?: File) => {
    if (!file) return;
    if (!supabase) { setError('Supabase storage is not configured.'); return; }
    if (!['image/jpeg','image/png','image/webp'].includes(file.type) || file.size > 5 * 1024 * 1024) {
      setError('Choose a JPG, PNG, or WebP image under 5 MB.');
      return;
    }
    try {
      setError('');
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error('Sign in again before uploading evidence.');
      const ext = file.type === 'image/png' ? 'png' : file.type === 'image/webp' ? 'webp' : 'jpg';
      const key = `${user.id}/${crypto.randomUUID()}.${ext}`;
      const { data, error: uploadError } = await supabase.storage.from('report-images').upload(key,file,{upsert:false,contentType:file.type,cacheControl:'3600'});
      if (uploadError) throw uploadError;
      setImage(data.path);
      setImagePreview(URL.createObjectURL(file));
    } catch (e: any) { setError(e?.message || 'Could not upload evidence.'); }
  };
  const removeImage = async () => {
    if (image && supabase) await supabase.storage.from('report-images').remove([image]);
    if (imagePreview) URL.revokeObjectURL(imagePreview);
    setImage('');
    setImagePreview('');
  };
  const previewAnalysis = async () => {
    setError('');
    try {
      const result = await analyze.mutateAsync({ data: { category, title, description, severity, location_name: location || null, latitude: lat ? Number(lat) : null, longitude: lng ? Number(lng) : null } as any });
      setAiPreview(result);
    } catch (e: any) { setError(e?.message || 'AI preview is unavailable.'); }
  };
  async function submit(e: FormEvent) {
    e.preventDefault(); setError('');
    if (Boolean(lat) !== Boolean(lng)) { setError('Enter both coordinates or leave both blank.'); return; }
    const input = { category, title, description, severity, location_name: location || null, latitude: lat ? Number(lat) : null, longitude: lng ? Number(lng) : null, image_url: image || null };
    try {
      const result = await create.mutateAsync({ data: input as any });
      await qc.invalidateQueries({ queryKey: getListCityReportsQueryKey() });
      await qc.invalidateQueries({ queryKey: getGetCityDashboardQueryKey() });
      // Analysis is informational. The initial report status is never advanced automatically.
      setLocation(`/my-reports/${result.id}`);
    } catch (e: any) { setError(e?.message || 'Report could not be submitted. Please try again.'); }
  }
  return <ShellPage><SectionHeading eyebrow="CONTRIBUTE A SIGNAL" title="Report an issue"><span className="subhead">Clear details help city staff verify the situation.</span></SectionHeading>
    <div className="form-layout"><form className="form-panel panel" onSubmit={submit}><div className="form-progress"><span className="step-active">01 <i /> ISSUE DETAILS</span><span>02 <i /> LOCATION</span><span>03 <i /> EVIDENCE</span></div>
      <div className="form-section"><div className="form-section-head"><span>01</span><div><h2>What’s happening?</h2><p>Tell us enough to help the right people investigate.</p></div></div>
        <label>Issue category<select value={category} onChange={e=>setCategory(e.target.value)}>{categories.map(c=><option key={c}>{c}</option>)}</select></label>
        <label>Short title<input required minLength={4} maxLength={120} value={title} onChange={e=>setTitle(e.target.value)} placeholder="e.g. Deep pothole at the east crossing" data-testid="input-report-title"/></label>
        <label>What did you notice?<textarea required minLength={10} maxLength={2000} rows={5} value={description} onChange={e=>setDescription(e.target.value)} placeholder="Share what you saw, when it started, and who may be affected…" data-testid="input-report-description"/><small className="field-hint">{description.length}/2000 characters</small></label>
        <div className="severity-pick"><span>Estimated severity</span><div>{['LOW','MEDIUM','HIGH'].map(s=><button type="button" className={`severity-choice ${severity===s?'selected '+s.toLowerCase():''}`} key={s} onClick={()=>setSeverity(s)}>{s}</button>)}</div><small>City staff will review severity before action.</small></div>
      </div>
      <div className="form-section"><div className="form-section-head"><span>02</span><div><h2>Where is it?</h2><p>Use an address or provide coordinates.</p></div></div><label>Location name<input value={location} onChange={e=>setLoc(e.target.value)} placeholder="Street, intersection, or landmark" data-testid="input-location-name"/></label><div className="split-input"><label>Latitude<input type="number" step="any" min="-90" max="90" value={lat} onChange={e=>setLat(e.target.value)} placeholder="37.7749"/></label><label>Longitude<input type="number" step="any" min="-180" max="180" value={lng} onChange={e=>setLng(e.target.value)} placeholder="-122.4194"/></label></div></div>
       <div className="form-section"><div className="form-section-head"><span>03</span><div><h2>Add evidence</h2><p>A photo can help staff assess the report. Optional.</p></div></div><label className="upload-zone"><Upload size={21}/><b>{image ? 'Evidence attached' : 'Choose a photo'}</b><span>{image ? 'Uploaded to private CityPulse storage.' : 'JPG, PNG, or WebP · up to 5 MB'}</span><input type="file" accept="image/jpeg,image/png,image/webp" onChange={e=>void upload(e.target.files?.[0])}/></label>{image && <div className="attached-evidence"><img src={imagePreview} alt="Evidence preview"/><Button type="button" variant="ghost" onClick={()=>void removeImage()}><X size={15}/> Remove</Button></div>}</div>
       <div className="analysis-preview"><Button type="button" variant="outline" disabled={analyze.isPending || title.length < 4 || description.length < 10} onClick={()=>void previewAnalysis()}><Sparkles size={15}/>{analyze.isPending ? 'Checking…' : 'Preview AI analysis'}</Button><span>AI supports review; it never verifies a report.</span></div>{aiPreview && <div className="detail-ai"><div className="ai-icon"><Sparkles size={17}/></div><div><span className="eyebrow">AI PREVIEW · NOT A DECISION</span><p>{aiPreview.summary}</p><small>{cap(aiPreview.category)} · {pct(aiPreview.confidence)} confidence · Human verification required{aiPreview.possible_duplicate ? ' · Possible duplicate found' : ''}</small></div></div>}
      {error && <div className="form-error">{error}</div>}
      <div className="form-disclaimer"><ShieldCheck size={17}/><p><b>Human review comes first.</b> AI analysis is decision support only. Your report remains pending verification until a city staff member reviews the evidence.</p></div>
       <div className="form-actions"><Link href="/dashboard" className="btn btn-ghost">Cancel</Link><Button type="submit" disabled={create.isPending}><Send size={15}/>{create.isPending ? 'Submitting…' : 'Submit report'} <ArrowRight size={15}/></Button></div>
    </form><aside className="form-aside"><Panel><div className="aside-icon"><ShieldCheck size={20}/></div><span className="eyebrow">WHAT HAPPENS NEXT</span><h3>Your report stays yours to follow.</h3><div className="aside-step"><i>1</i><div><b>Initial review</b><p>City staff check the details and evidence.</p></div></div><div className="aside-step"><i>2</i><div><b>Verification</b><p>Only a staff decision can verify a report.</p></div></div><div className="aside-step"><i>3</i><div><b>Action and updates</b><p>Track assignment through resolution.</p></div></div></Panel><div className="privacy-note"><LockIcon/><span>Your location is used to route this issue to the right city team.</span></div></aside></div>
  </ShellPage>;
}
function LockIcon() { return <ShieldCheck size={16}/>; }

function MyReports() {
  const [search,setSearch]=useState(''); const [status,setStatus]=useState(''); const [category,setCategory]=useState('');
  const params = useMemo(() => ({ search: search || undefined, status: status || undefined, category: category || undefined, limit: 100 }),[search,status,category]);
  const q=useListCityReports(params);
  return <ShellPage><SectionHeading eyebrow="YOUR CIVIC ACTIVITY" title="My reports"><span className="subhead">Every signal, with its status and next step.</span><Link href="/report" className="btn btn-primary"><Plus size={16}/> New report</Link></SectionHeading>
    <QueryState loading={q.isLoading} error={q.error} retry={()=>q.refetch()}><Panel className="list-panel"><div className="filter-row"><label className="search-field"><Search size={16}/><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search reports…" data-testid="input-search-reports"/></label><label className="select-filter"><Filter size={15}/><select value={status} onChange={e=>setStatus(e.target.value)}><option value="">All statuses</option>{['PENDING_VERIFICATION','VERIFIED','ASSIGNED','IN_PROGRESS','RESOLVED','REJECTED'].map(s=><option key={s} value={s}>{cap(s)}</option>)}</select></label><label className="select-filter"><select value={category} onChange={e=>setCategory(e.target.value)}><option value="">All categories</option>{categories.map(c=><option key={c}>{c}</option>)}</select></label></div><div className="list-meta">{q.data?.length ?? 0} reports <span>·</span> Sorted by most recent</div>{q.data?.length ? <div className="report-list">{q.data.map(r=><ReportCard key={r.id} report={r}/>)}</div> : <EmptyState title="No matching reports" body={search || status || category ? 'Try clearing a filter or changing your search.' : 'Reports you submit will appear here.'} action={search || status || category ? <Button variant="outline" onClick={()=>{setSearch('');setStatus('');setCategory('');}}>Clear filters</Button> : <Link className="btn btn-primary" href="/report">Submit a report <ArrowRight size={14}/></Link>}/>}</Panel></QueryState>
  </ShellPage>;
}

function ReportDetail({ id }: { id?: string }) {
  const [, params] = useRoute('/my-reports/:id');
  const reportId = id || params?.id || '';
  const q=useGetCityReport(reportId,{query:{enabled:!!reportId,queryKey:[`/api/citypulse/reports/${reportId}`]}});
  const report=q.data;
  return <ShellPage><div className="backline"><Link href="/my-reports"><ArrowRight size={14}/> All reports</Link></div><QueryState loading={q.isLoading} error={q.error} retry={()=>q.refetch()}>{report ? <><SectionHeading eyebrow={`${report.category} / REPORT ${report.id.slice(0,8).toUpperCase()}`} title={report.title}><Status value={report.status}/></SectionHeading><div className="detail-grid"><div><Panel className="detail-main"><div className="detail-meta"><span><MapPin size={15}/>{report.location_name || 'Location not specified'}</span><span><Clock3 size={15}/>{fmtTime(report.created_at)}</span><span className={`severity-label ${report.severity.toLowerCase()}`}><i/> {cap(report.severity)} severity</span></div>{report.image_url && <img className="evidence-image" src={report.image_url} alt="Submitted evidence"/>}<h2>Issue details</h2><p className="detail-description">{report.description}</p><div className="detail-ai"><div className="ai-icon"><Sparkles size={17}/></div><div><span className="eyebrow">ASSISTED ANALYSIS · NOT A DECISION</span><p>{report.ai_summary || 'Automated analysis is not available for this report. Staff review is still required.'}</p>{report.ai_confidence != null && <small>Model confidence: {pct(report.ai_confidence)} · prototype value</small>}</div></div></Panel></div><div><Panel className="timeline-panel"><span className="eyebrow">REPORT TIMELINE</span><h2>What happens next</h2><div className="timeline"><div className="timeline-item complete"><i><Check size={13}/></i><div><b>Report submitted</b><small>{fmtTime(report.created_at)}</small></div></div><div className={`timeline-item ${report.status !== 'PENDING_VERIFICATION' ? 'complete' : 'current'}`}><i>{report.status !== 'PENDING_VERIFICATION' ? <Check size={13}/> : <Clock3 size={13}/>}</i><div><b>Staff verification</b><small>{report.status === 'PENDING_VERIFICATION' ? 'Waiting for evidence review' : 'Verification review recorded'}</small></div></div><div className={`timeline-item ${['ASSIGNED','IN_PROGRESS','RESOLVED'].includes(report.status) ? 'complete' : ''}`}><i><ChevronRight size={13}/></i><div><b>City action</b><small>After verification</small></div></div><div className={`timeline-item ${report.status === 'RESOLVED' ? 'complete' : ''}`}><i><Check size={13}/></i><div><b>Resolution</b><small>Close the loop</small></div></div></div><div className="staff-review-note"><ShieldCheck size={16}/><p>Risk scores only change after a report is verified by city staff.</p></div></Panel><Link href="/map" className="detail-map-link"><Map size={17}/><span><b>View city signals</b><small>Explore the prototype risk map</small></span><ArrowRight size={15}/></Link></div></div></> : null}</QueryState></ShellPage>;
}

function CityMap() {
  const scores=useListCityRiskScores(); const reports=useListCityReports({limit:100});
  const [layer,setLayer]=useState('overall_risk'); const [selected,setSelected]=useState<string>('');
  const [zoom,setZoom]=useState(1);
  const values=scores.data ?? [];
  const mapped=values.filter(r=>r.latitude!=null&&r.longitude!=null);
  const latMin=mapped.length?Math.min(...mapped.map(r=>r.latitude)):0,latMax=mapped.length?Math.max(...mapped.map(r=>r.latitude)):0;
  const lonMin=mapped.length?Math.min(...mapped.map(r=>r.longitude)):0,lonMax=mapped.length?Math.max(...mapped.map(r=>r.longitude)):0;
  const position=(lat:number|null|undefined,lon:number|null|undefined,index:number)=>{
    if(lat==null||lon==null)return {left:`${16+(index*23)%70}%`,top:`${20+(index*29)%60}%`};
    const clamp=(value:number)=>Math.max(0,Math.min(1,value));
    const x=lonMax===lonMin?0.5:clamp((lon-lonMin)/(lonMax-lonMin));
    const y=latMax===latMin?0.5:clamp((latMax-lat)/(latMax-latMin));
    return {left:`${12+x*76}%`,top:`${14+y*68}%`};
  };
  return (
    <ShellPage>
      <SectionHeading eyebrow="PILOT CITY / SPATIAL VIEW" title="City signal map">
        <span className="subhead">Prototype risk layers blend civic data and verified reports.</span>
        <span className="prototype-tag"><Sparkles size={13}/> PROTOTYPE MODEL</span>
      </SectionHeading>
      <QueryState
        loading={scores.isLoading || reports.isLoading}
        error={scores.error || reports.error}
        retry={()=>{void scores.refetch();void reports.refetch();}}
      >
        <div className="map-layout">
          <Panel className="map-canvas">
            <div className="map-toolbar">
              <span><Crosshair size={15}/> CITYPULSE / PILOT VIEW</span>
              <span className="map-zoom">
                <button aria-label="Zoom out" disabled={zoom<=0.8} onClick={()=>setZoom(v=>Math.max(0.8,Number((v-0.1).toFixed(1))))}><Minus size={15}/></button>
                <button aria-label="Zoom in" disabled={zoom>=1.4} onClick={()=>setZoom(v=>Math.min(1.4,Number((v+0.1).toFixed(1))))}><Plus size={15}/></button>
              </span>
            </div>
            <div className="schematic-map">
              <div className="map-zoom-content" style={{transform:`scale(${zoom})`}}>
                <div className="map-contours"><svg viewBox="0 0 900 600" preserveAspectRatio="xMidYMid slice"><path d="M-10 88 177 161 273 92l115 73 139-53 133 98 260-87M-12 239l169-74 100 124 130-69 107 118 121-137 154 104 163-74M-19 417l179-128 119 94 141-103 127 132 109-104 162 79M86 610l76-321 128-197M381 613l5-448 104-94M638 611l-21-401 101-85M-15 329l915-54M24 477l840-46" /></svg></div>
                <div className="map-river" />
                <div className="map-street street-1"/>
                <div className="map-street street-2"/>
                <div className="map-street street-3"/>
                <div className="map-district district-a">CENTRAL JUNCTION</div>
                <div className="map-district district-b">LAKE VIEW</div>
                <div className="map-district district-c">TECH PARK</div>
                {values.length ? values.map((r,i)=>{
                  const score=Number((r as any)[layer]??r.overall_risk);
                  const risk=score>=70?'high':score>=40?'med':'low';
                  const point=position(r.latitude,r.longitude,i);
                  return <button key={r.id} className={`risk-pin risk-${risk} ${selected===r.id?'picked':''}`} style={point} onClick={()=>setSelected(r.id)} aria-label={`Select ${r.location_name}, ${score} risk`}><i/><span>{r.location_name}</span></button>;
                }) : <div className="map-empty-label">Risk observations appear when available</div>}
                {reports.data?.slice(0,10).map((r,i)=><span key={r.id} className="report-dot" style={position(r.latitude,r.longitude,i+values.length)} title={r.title}/>)}
              </div>
            </div>
            <div className="map-legend">
              <span><i className="risk-high-dot"/> High</span><span><i className="risk-med-dot"/> Moderate</span>
              <span><i className="risk-low-dot"/> Low</span><span><i className="report-legend-dot"/> Report</span>
            </div>
            <div className="map-footnote"><AlertTriangle size={14}/> Prototype visualization. Sample values are not operational city decisions.</div>
          </Panel>
          <aside className="map-sidebar">
            <Panel>
              <span className="eyebrow">MAP LAYERS</span><h3>Signal layers</h3>
              {[
                ['overall_risk','Overall risk'],['traffic_risk','Traffic'],['flood_risk','Flooding'],
                ['infrastructure_risk','Infrastructure'],['pollution_risk','Pollution'],['verified_report_risk','Verified reports'],
              ].map(([value,label])=><button className={`layer-row ${layer===value?'selected':''}`} key={value} onClick={()=>setLayer(value)}>
                <span className="layer-check">{layer===value&&<Check size={12}/>}</span>{label}<span className="layer-switch"/>
              </button>)}
            </Panel>
            <Panel>
              <span className="eyebrow">OBSERVATIONS</span>
              {selected && values.find(r=>r.id===selected)
                ? <MapDetail item={values.find(r=>r.id===selected)!} layer={layer}/>
                : <div className="map-summary"><b>{values.length}</b><span>scored locations</span><small>Scores update with verified signals.</small></div>}
              <Link href="/analytics" className="text-link">See risk analytics <ArrowRight size={14}/></Link>
            </Panel>
            <Panel className="forecast-note"><CloudRain size={18}/><b>Forecasting is experimental</b><p>Predictions are simulation outputs—not confirmed events or emergency alerts.</p><Link href="/analytics" className="text-link">View forecast data <ArrowRight size={14}/></Link></Panel>
          </aside>
        </div>
      </QueryState>
    </ShellPage>
  );
}
function MapDetail({ item, layer }: { item: any; layer: string }) { const score=Number(item[layer]??item.overall_risk);const label=layer==='overall_risk'?'Overall risk':cap(layer.replace('_risk',''));return <div className="map-detail"><b>{item.location_name}</b><div className="map-risk-number">{Math.round(score)}<small>/100</small></div><Status value={score>=70?'HIGH':score>=40?'MEDIUM':'LOW'}/><div className="risk-meter"><i style={{width:`${Math.max(0,Math.min(100,score))}%`}}/></div><small>{label} prototype score · {fmtDate(item.calculated_at)}</small></div>; }

function ControlRoom() {
  const d=useGetCityDashboard(); const rq=useListCityReports({limit:12}); const alerts=useListCityAlerts();
  const updateAlert=useUpdateCityAlert(); const qc=useQueryClient();
  const markRead=(id:string,read:boolean)=>updateAlert.mutate({alertId:id,data:{read} as any},{onSuccess:()=>qc.invalidateQueries({queryKey:['/api/citypulse/alerts']})});
  return <ShellPage><SectionHeading eyebrow="CITY OPERATIONS / OVERVIEW" title="Control room"><span className="subhead">A human-led view of what needs attention.</span><span className="prototype-tag"><i/> STAFF VIEW</span></SectionHeading><QueryState loading={d.isLoading || rq.isLoading} error={d.error || rq.error} retry={()=>{d.refetch();rq.refetch();}}><div className="ops-banner"><div className="ops-orbit"><Activity size={25}/></div><div><span className="eyebrow">HARBOR CITY / OPERATIONS FEED</span><h2>Signals are moving. Decisions stay human.</h2><p>Review evidence before verified reports inform prototype risk scores.</p></div><span className="ops-time"><i/> UPDATED {new Date().toLocaleTimeString([], {hour:'2-digit',minute:'2-digit'})}</span></div><div className="metric-grid"><Metric label="Incoming reports" value={d.data?.total_reports ?? 0} detail="All accessible records" icon={<ClipboardList/>}/><Metric label="Needs verification" value={d.data?.pending ?? 0} detail="Awaiting staff review" icon={<Clock3/>} accent="amber"/><Metric label="High risk areas" value={d.data?.high_risk_areas ?? 0} detail="Prototype risk indicator" icon={<Siren/>} accent="red"/><Metric label="Resolved reports" value={d.data?.resolved ?? 0} detail="Status: resolved" icon={<CheckCircle2/>} accent="green"/></div><div className="content-grid wide-left"><Panel><div className="panel-head"><div><span className="eyebrow">STAFF ACTION REQUIRED</span><h2>Verification queue</h2></div><Link href="/reports" className="text-link">Open queue <ArrowRight size={14}/></Link></div>{rq.data?.filter(r=>r.status==='PENDING_VERIFICATION').length ? <div className="report-list">{rq.data.filter(r=>r.status==='PENDING_VERIFICATION').slice(0,5).map(r=><ReportCard key={r.id} report={r} compact/>)}</div> : <EmptyState title="Queue is clear" body="No pending reports in the current result set."/>}</Panel><Panel className="alerts-panel"><div className="panel-head"><div><span className="eyebrow">CITY SIGNALS</span><h2>Alerts</h2></div><Bell size={16}/></div>{alerts.isLoading ? <div className="skeleton"/> : alerts.error ? <p className="muted-copy">Alerts could not be loaded.</p> : alerts.data?.length ? <div className="alerts-list">{alerts.data.slice(0,5).map(a=><div className={`alert-row ${a.read?'read':''}`} key={a.id}><i className={`alert-dot ${a.severity.toLowerCase()}`}/><div><b>{a.title}</b><p>{a.message}</p><small>{a.location_name} · {fmtDate(a.created_at)}</small></div><button className="alert-toggle" onClick={()=>markRead(a.id,!a.read)} aria-label={a.read?'Mark unread':'Mark read'}>{a.read?<Check size={14}/>:<span/>}</button></div>)}</div> : <EmptyState title="No active alerts" body="New city alerts will appear here."/>}</Panel></div><Panel className="quick-panel"><div className="panel-head"><div><span className="eyebrow">DECISION SUPPORT</span><h2>Operational tools</h2></div></div><div className="quick-links"><Link href="/reports"><FileCheck2 size={18}/><b>Review reports</b><span>Inspect evidence and make a staff decision.</span><ArrowRight size={15}/></Link><Link href="/map"><Map size={18}/><b>Map risk signals</b><span>Explore prototype risk layers.</span><ArrowRight size={15}/></Link><Link href="/analytics"><Activity size={18}/><b>City analytics</b><span>Review reporting and resolution patterns.</span><ArrowRight size={15}/></Link></div></Panel></QueryState></ShellPage>;
}

function AdminReports() {
  const [search,setSearch]=useState(''); const [status,setStatus]=useState('PENDING_VERIFICATION'); const [category,setCategory]=useState('');
  const params=useMemo(()=>({search:search||undefined,status:status||undefined,category:category||undefined,limit:100}),[search,status,category]);
  const q=useListCityReports(params);
  return <ShellPage><SectionHeading eyebrow="STAFF WORKFLOW / EVIDENCE REVIEW" title="Verification queue"><span className="subhead">Review the evidence. Make the decision. Keep the city accountable.</span></SectionHeading><QueryState loading={q.isLoading} error={q.error} retry={()=>q.refetch()}><Panel className="list-panel"><div className="filter-row"><label className="search-field"><Search size={16}/><input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search title or location…"/></label><label className="select-filter"><Filter size={15}/><select value={status} onChange={e=>setStatus(e.target.value)}><option value="">All statuses</option>{['PENDING_VERIFICATION','VERIFIED','ASSIGNED','IN_PROGRESS','RESOLVED','REJECTED'].map(s=><option key={s} value={s}>{cap(s)}</option>)}</select></label><label className="select-filter"><select value={category} onChange={e=>setCategory(e.target.value)}><option value="">All categories</option>{categories.map(c=><option key={c}>{c}</option>)}</select></label></div><div className="list-meta">{q.data?.length ?? 0} records in view <span>·</span> Status changes require a staff decision</div>{q.data?.length ? <div className="admin-report-list">{q.data.map(r=><AdminReportCard key={r.id} report={r}/>)}</div> : <EmptyState title="No reports in this queue" body="Adjust the filters to inspect other report statuses." action={status && <Button variant="outline" onClick={()=>setStatus('')}>Show all statuses</Button>}/>}</Panel></QueryState></ShellPage>;
}
function AdminReportCard({report}:{report:Report}) {
  const mutation=useUpdateCityReportStatus(); const qc=useQueryClient(); const [notes,setNotes]=useState('');
  const doAction=(next:string)=>{ if(!window.confirm(`Apply “${cap(next)}” to this report?`))return; mutation.mutate({reportId:report.id,data:{status:next,notes:notes||undefined} as any},{onSuccess:()=>{qc.invalidateQueries({queryKey:getListCityReportsQueryKey()});qc.invalidateQueries({queryKey:getGetCityDashboardQueryKey()});qc.invalidateQueries({queryKey:getListCityRiskScoresQueryKey()});qc.invalidateQueries({queryKey:['/api/citypulse/predictions']});qc.invalidateQueries({queryKey:['/api/citypulse/alerts']});}}); };
  const pending=report.status==='PENDING_VERIFICATION';
  const canAssign=report.status==='VERIFIED';
  const canProgress=['VERIFIED','ASSIGNED'].includes(report.status);
  const canResolve=['VERIFIED','ASSIGNED','IN_PROGRESS'].includes(report.status);
  return <div className="admin-report"><div className="admin-report-top"><div><span className="eyebrow">{report.category} <span>·</span> {report.id.slice(0,8).toUpperCase()}</span><h3>{report.title}</h3><p>{report.location_name || 'Location unknown'} · {fmtDate(report.created_at)}</p></div><Status value={report.status}/></div><p className="admin-description">{report.description}</p>{report.image_url&&<EvidenceImage className="staff-evidence" path={report.image_url} alt="Citizen-submitted evidence"/>}<div className="evidence-meta"><span><Layers3 size={14}/> {report.evidence_count ?? (report.image_url?1:0)} evidence items</span>{report.duplicate_of&&<span className="flag-text">Possible duplicate linked</span>}{report.suspicious && <span className="flag-text"><AlertTriangle size={14}/> Flagged for review</span>}{report.ai_confidence!=null&&<span><Sparkles size={14}/> AI confidence {pct(report.ai_confidence)} <small>prototype</small></span>}</div>{report.ai_summary&&<div className="admin-ai"><Sparkles size={15}/><span><b>Assisted summary</b>{report.ai_summary}</span></div>}<input className="staff-note" value={notes} onChange={e=>setNotes(e.target.value)} placeholder="Optional staff decision note…"/><div className="admin-actions">{pending&&<><Button variant="outline" disabled={mutation.isPending} onClick={()=>doAction('REJECTED')}><X size={14}/> Reject</Button>{report.duplicate_of&&<Button variant="outline" disabled={mutation.isPending} onClick={()=>doAction('REJECTED')}>Mark duplicate</Button>}<Button variant="primary" disabled={mutation.isPending} onClick={()=>doAction('VERIFIED')}><ShieldCheck size={14}/> Verify evidence</Button></>}{canAssign&&<Button variant="outline" disabled={mutation.isPending} onClick={()=>doAction('ASSIGNED')}>Assign</Button>}{canProgress&&<Button variant="outline" disabled={mutation.isPending} onClick={()=>doAction('IN_PROGRESS')}>Mark in progress</Button>}{canResolve&&<Button variant="primary" disabled={mutation.isPending} onClick={()=>doAction('RESOLVED')}><Check size={14}/> Resolve</Button>}{!pending&&!canAssign&&!canProgress&&!canResolve&&<span className="muted-copy">No further action for this status.</span>}{mutation.error&&<small className="form-error">Could not update status.</small>}</div><div className="staff-caveat"><ShieldCheck size={13}/> Automated assessment does not verify reports or change risk scores.</div></div>;
}

function AnalyticsPage() {
  const [range,setRange]=useState<'7D'|'30D'|'90D'>('30D'); const q=useGetCityAnalytics({range}); const scores=useListCityRiskScores(); const predictions=useListCityPredictions();
  const data=q.data;
  return <ShellPage><SectionHeading eyebrow="CITY INTELLIGENCE / TRENDS" title="Civic analytics"><span className="subhead">Patterns in reports, verification, and resolution.</span><span className="prototype-tag"><Sparkles size={13}/> PROTOTYPE DECISION SUPPORT</span></SectionHeading><QueryState loading={q.isLoading} error={q.error} retry={()=>q.refetch()}>{data&&<><div className="range-switch">{(['7D','30D','90D'] as const).map(r=><button key={r} className={range===r?'active':''} onClick={()=>setRange(r)}>{r}</button>)}</div><div className="metric-grid analytics-metrics"><Metric label="Total reports" value={data.total_reports} detail={`In selected ${range.toLowerCase()} window`} icon={<ClipboardList/>}/><Metric label="Verification rate" value={pct(data.verification_rate)} detail="Human reviewed reports" icon={<ShieldCheck/>} accent="cyan"/><Metric label="Resolution rate" value={pct(data.resolution_rate)} detail="Reports marked resolved" icon={<CheckCircle2/>} accent="green"/><Metric label="Avg. resolution time" value={data.average_resolution_hours==null?'—':`${data.average_resolution_hours.toFixed(1)}h`} detail="Prototype metric" icon={<Clock3/>} accent="amber"/></div><div className="analytics-grid"><Panel className="chart-panel"><div className="panel-head"><div><span className="eyebrow">REPORT VOLUME</span><h2>Incoming signals</h2></div><span className="chart-legend"><i/> Reports / day</span></div><BarChart points={data.reports_over_time}/></Panel><Panel className="chart-panel"><div className="panel-head"><div><span className="eyebrow">REPORT CLASSIFICATION</span><h2>By category</h2></div></div><HorizontalChart points={data.by_category}/></Panel><Panel className="chart-panel"><div className="panel-head"><div><span className="eyebrow">CURRENT WORKFLOW</span><h2>Report status</h2></div></div><HorizontalChart points={data.by_status}/></Panel><Panel className="chart-panel"><div className="panel-head"><div><span className="eyebrow">PROTOTYPE RISK DISTRIBUTION</span><h2>Scored locations</h2></div></div>{scores.data?.length?<div className="risk-list">{scores.data.map(r=><div key={r.id}><span className={`risk-bullet ${r.risk_level.toLowerCase()}`}/><b>{r.location_name}</b><span>{Math.round(r.overall_risk*100)} / 100</span><Status value={r.risk_level}/></div>)}</div>:<EmptyState title="No scores available" body="Risk observations will appear when supplied by the API."/>}</Panel></div><Panel className="forecast-panel"><div><span className="eyebrow">FORECAST SIGNALS / SIMULATION</span><h2>Possible pressure points</h2><p>Forecasts are experimental outputs—not an emergency alert or confirmed event.</p></div>{predictions.data?.length?<div className="prediction-list">{predictions.data.map(p=><div className="prediction" key={p.id}><div><span className="prediction-prob">{pct(p.probability)}</span><Status value={p.probability>.65?'HIGH':p.probability>.35?'MEDIUM':'LOW'}/></div><h3>{p.prediction_type} near {p.location_name}</h3><p>{p.recommendation}</p><small>{fmtDate(p.expected_start)} – {fmtDate(p.expected_end)}</small></div>)}</div>:<EmptyState title="No forecast signals" body="No simulation results are currently available."/>}</Panel></>}</QueryState></ShellPage>;
}
function BarChart({points}:{points:any[]}) {
  const max=Math.max(1,...(points||[]).map(p=>p.count));
  return points?.length?<div className="bar-chart"><div className="chart-y"><span>{max}</span><span>{Math.round(max/2)}</span><span>0</span></div><div className="bars">{points.map((p,i)=><div className="bar-item" key={`${p.label}-${i}`}><span className="bar-value">{p.count}</span><i style={{height:`${Math.max(3,p.count/max*100)}%`}}/><small>{p.label}</small></div>)}</div></div>:<EmptyState title="No trend data" body="Chart data will appear as reports are recorded." />;
}
function HorizontalChart({points}:{points:any[]}) {
  const max=Math.max(1,...(points||[]).map(p=>p.count));
  return points?.length?<div className="h-chart">{points.map((p,i)=><div key={`${p.label}-${i}`}><div><span>{cap(p.label)}</span><b>{p.count}</b></div><i><em style={{width:`${p.count/max*100}%`}}/></i></div>)}</div>:<EmptyState title="No data yet" body="Values will appear when available." />;
}

function AssistantPage() {
  const [question,setQuestion]=useState(''); const [answer,setAnswer]=useState<any>(null);
  const ask=useAskCityAssistant();
  const suggestions=['Which areas have the most verified reports?','What issues need staff attention today?','Summarize current flood-related signals.'];
  async function send(e?:FormEvent, prompt=question) { e?.preventDefault(); if(prompt.trim().length<3)return; setQuestion(prompt); setAnswer(null); try { const result=await ask.mutateAsync({data:{question:prompt} as any}); setAnswer(result); } catch { setAnswer({error:'The assistant could not complete that request. Please try again.'}); } }
  return <ShellPage><SectionHeading eyebrow="CITY INTELLIGENCE / ASSISTANT" title="Ask the city signal"><span className="subhead">A decision-support assistant grounded in city statistics—not a substitute for staff judgment.</span></SectionHeading><div className="assistant-layout"><div className="assistant-main"><Panel className="assistant-welcome"><div className="assistant-symbol"><Sparkles size={23}/></div><div><span className="eyebrow">CITYPULSE ASSISTANT · {answer?.source==='gemini'?'MODEL RESPONSE':'PROTOTYPE'}</span><h2>Where should we look closer?</h2><p>Ask about verified reports, current patterns, or operational recommendations.</p></div><div className="assistant-lines"/></Panel><div className="suggestion-list">{suggestions.map(s=><button key={s} onClick={()=>void send(undefined,s)}>{s}<ArrowRight size={14}/></button>)}</div>{answer && <Panel className="answer-panel">{answer.error ? <div className="state-box"><AlertTriangle size={18}/>{answer.error}</div> : <><div className="answer-head"><span className="eyebrow">RESPONSE TO YOUR QUESTION</span><span className="prototype-tag">{answer.source==='fallback'?'SIMULATION':'AI ASSISTED'}</span></div><div className="question-bubble">{question}</div><AnswerSection title="Verified data" body={answer.verified_data} icon={<FileCheck2 size={16}/>}/><AnswerSection title="Analysis" body={answer.analysis} icon={<Activity size={16}/>}/><AnswerSection title="Prototype prediction" body={answer.prediction} icon={<TrendingUp size={16}/>}/><AnswerSection title="Recommendation" body={answer.recommendation} icon={<Lightbulb size={16}/>}/><div className="answer-caveat"><ShieldCheck size={14}/> Assistant output is decision support. Confirm findings with verified records and staff review.</div></>}</Panel>}</div><aside className="assistant-rail"><Panel><span className="eyebrow">GROUNDING RULES</span><h3>Evidence before inference.</h3><div className="grounding-row"><CheckCircle2 size={16}/><span>Verified report data is distinguished from unreviewed submissions.</span></div><div className="grounding-row"><AlertTriangle size={16}/><span>Forecasts are explicitly labeled as experimental.</span></div><div className="grounding-row"><ShieldCheck size={16}/><span>Human staff retain all verification and action decisions.</span></div></Panel><Panel className="assistant-example"><span className="eyebrow">GOOD QUESTION</span><p>“Which verified reports in Old Market are still unresolved?”</p><small>Specific questions lead to useful context.</small></Panel></aside></div><form onSubmit={send} className="assistant-composer"><label><MessageSquareText size={17}/><input value={question} maxLength={500} onChange={e=>setQuestion(e.target.value)} placeholder="Ask about verified city signals…" data-testid="input-assistant-question"/></label><Button type="submit" disabled={ask.isPending || question.trim().length<3} aria-label="Send question">{ask.isPending?'Working…':<Send size={17}/>}</Button></form></ShellPage>;
}
function AnswerSection({title,body,icon}:{title:string;body:string;icon:ReactNode}) { return <div className="answer-section"><span>{icon}</span><div><b>{title}</b><p>{body || 'No information was returned for this section.'}</p></div></div>; }

function SettingsPage() {
  const [email,setEmail]=useState(''); const [notice,setNotice]=useState('');
  useEffect(()=>{(supabase as any).auth.getUser().then(({data}:any)=>setEmail(data?.user?.email||''));},[]);
  const logout=async()=>{await (supabase as any).auth.signOut();setNotice('You have been signed out.');};
  return <ShellPage><SectionHeading eyebrow="PROFILE / PREFERENCES" title="Settings"><span className="subhead">Manage your CityPulse account and notification preferences.</span></SectionHeading><div className="settings-layout"><Panel><span className="eyebrow">ACCOUNT</span><h2>Profile information</h2><label>Email address<input value={email} readOnly placeholder="No authenticated email"/></label><p className="settings-note">Account details are managed by secure CityPulse authentication.</p><Button variant="outline" onClick={logout}><LogOut size={15}/> Sign out</Button>{notice&&<p className="success-note">{notice}</p>}</Panel><Panel><span className="eyebrow">CIVIC UPDATES</span><h2>Report notifications</h2><p>Notification controls will be available when the account preferences service is connected. Report status can be followed in My reports.</p><Link href="/my-reports" className="text-link">View my reports <ArrowRight size={14}/></Link></Panel><Panel className="settings-caveat"><ShieldCheck size={19}/><div><b>Human decisions, transparent records.</b><p>Automated analysis is not a verification decision. Prototype risk and forecast values are informational only.</p></div></Panel></div></ShellPage>;
}

function NotFound() { return <ShellPage><div className="not-found"><span className="eyebrow">404 / NOT IN THIS CITY</span><h1>This page is off the map.</h1><Link href="/dashboard" className="btn btn-primary">Return to overview <ArrowRight size={15}/></Link></div></ShellPage>; }
function AppRoutes() {
  const [location]=useLocation();
  return <ErrorBoundary resetKey={location}><Switch>
    <Route path="/" component={Landing}/><Route path="/login"><AuthPage/></Route><Route path="/signup"><AuthPage signup/></Route>
    <Route path="/dashboard"><Dashboard/></Route><Route path="/report"><ReportForm/></Route><Route path="/my-reports/:id">{params=><ReportDetail id={params.id}/>}</Route><Route path="/my-reports"><MyReports/></Route>
    <Route path="/map"><CityMap/></Route><Route path="/control-room"><ControlRoom/></Route><Route path="/reports"><AdminReports/></Route><Route path="/analytics"><AnalyticsPage/></Route><Route path="/ai-assistant"><AssistantPage/></Route><Route path="/settings"><SettingsPage/></Route><Route component={NotFound}/>
  </Switch></ErrorBoundary>;
}
function App() {
  const routeBase = import.meta.env.BASE_URL === '/' ? '' : import.meta.env.BASE_URL.replace(/\/$/, '');
  return <QueryClientProvider client={queryClient}><TooltipProvider><WouterRouter base={routeBase}><AppRoutes/><Toaster/></WouterRouter></TooltipProvider></QueryClientProvider>;
}
export default App;
