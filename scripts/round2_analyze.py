#!/usr/bin/env python3
# cybernetics weekly analysis — round 2: six methodology dimensions
# data: ~/.dsh/sessions/**/session.v4.jsonl.zstd + /Users/mars/jobs/*/.cybernetics/
import subprocess, glob, json, os, re, collections, statistics, datetime, sys

HOME = os.path.expanduser('~')
SESSIONS = os.path.join(HOME, '.dsh/sessions')
WINDOW_START = datetime.datetime(2026,11,2,0,0,tzinfo=datetime.timezone(datetime.timedelta(hours=8))).timestamp()*1000
NOW = datetime.datetime(2026,11,5,15,21,tzinfo=datetime.timezone(datetime.timedelta(hours=8))).timestamp()*1000

MACHINE_PREFIXES = (
 '你是一个独立的 task agent','你是 verify agent','你是 goal agent','【任务看板】',
 '【工作委托书】','<goal_round>','<cybernetics_round>','<goal_complete>','<goal_blocked>',
 'Current runtime context','<system-reminder>','Time sampled while preparing','(empty message)',
 '定时邮件检查任务','每日 GitHub 活动检查','每小时检查 Gmail',
)
def is_human(d, seen_texts):
    if (d.get('source') or {}).get('kind') != 'user':
        return False
    txt = ''
    for c in d.get('content', []):
        if c.get('type') == 'text': txt += c['text']
    t = txt.strip()
    if not t: return False
    if t.startswith(MACHINE_PREFIXES): return False
    if '定时' in t[:100]: return False          # scheduled-task injection
    if t in seen_texts: return False            # verbatim repeat of earlier prompt (scheduled re-injection)
    seen_texts.add(t)
    return True

def zread(path):
    return subprocess.run(['zstd','-dc','-q',path],capture_output=True).stdout.decode('utf-8','replace')

def role_of(out):
    # role from first system prompt text
    for line in out.splitlines():
        if '"system/message"' in line or '"agent/inbox/spliced"' in line:
            try: e=json.loads(line)
            except: continue
            s=json.dumps(e.get('data'),ensure_ascii=False)
            if 'task agent' in s[:3000] or '工作委托书' in s: return 'task'
            if 'verify agent' in s[:3000]: return 'verify'
            if 'goal agent' in s[:3000]: return 'triage'
    return 'other'

sessions = {}   # id -> rec
files = sorted(glob.glob(os.path.join(SESSIONS,'*','*','session.v4.jsonl.zstd')))
print('session files:', len(files), file=sys.stderr)

for f in files:
    try:
        out = zread(f)
    except Exception:
        continue
    lines = out.splitlines()
    if not lines: continue
    try:
        head = json.loads(lines[0])
    except Exception:
        continue
    sid = head.get('id'); 
    if not sid: continue
    rec = dict(id=sid, cwd=head.get('cwd',''), parent=head.get('parentSession'),
               origin=head.get('origin'), createdAt=head.get('createdAt'),
               inTok=0,outTok=0,cacheTok=0,totalTok=0, n_asst=0, n_user_raw=0,
               human_msgs=[], first_t=None,last_t=None, has_cyb_plugin=False,
               first_text='', events=0)
    seen=set()
    for line in lines:
        try: e=json.loads(line)
        except: continue
        ty=e.get('type'); t=e.get('time'); rec['events']+=1
        if t:
            if rec['first_t'] is None: rec['first_t']=t
            rec['last_t']=t
        if ty=='assistant/message':
            d=e.get('data') or {}
            u=(d.get('message') or {}).get('usage') or d.get('usage') or {}
            rec['inTok']+=u.get('inputTokens',0); rec['outTok']+=u.get('outputTokens',0)
            rec['cacheTok']+=u.get('cacheReadTokens',0)
            rec['totalTok']+=u.get('totalTokens',0)
            rec['n_asst']+=1
        elif ty=='user/message':
            d=e.get('data') or {}
            rec['n_user_raw']+=1
            txt=''
            for c in d.get('content',[]):
                if c.get('type')=='text': txt+=c['text']
            if not rec['first_text'] and txt: rec['first_text']=txt[:200]
            if is_human(d, seen):
                rec['human_msgs'].append({'t':t,'text':txt[:400]})
        elif ty=='plugin:cybernetics/goals':
            rec['has_cyb_plugin']=True
    sessions[sid]=rec

# activity window filter (same rule as round 1: overlaps [WINDOW_START, NOW])
def in_window(r):
    ft=r['first_t'] or 0; lt=r['last_t'] or 0
    return lt>=WINDOW_START and ft<=NOW
active={k:v for k,v in sessions.items() if in_window(v)}
print('active in window:', len(active), file=sys.stderr)

# cybernetics data dirs
cyb_ws=['hypatia','dsh-cybernetics','deepseek-harness','marchliu.github.com','baoyu-design',
        'zgci.ac.cn/lab-ops','zgci.ac.cn/PhotoStory','zgci.ac.cn/ZGCAI-Mattermost','zgci.ac.cn/Mattermost-Plugins-Dev']
cyb_root='/Users/mars/jobs'
boards={}; rounds=[]; revisions=[]
for ws in cyb_ws:
    base=os.path.join(cyb_root,ws,'.cybernetics')
    if not os.path.isdir(base): continue
    for fn in glob.glob(os.path.join(base,'board-session-*.json')):
        try: boards[fn]=json.load(open(fn))
        except Exception: pass
    for fn in glob.glob(os.path.join(base,'round-cyb-*.json')):
        try: rounds.append((ws,fn,json.load(open(fn))))
        except Exception: rounds.append((ws,fn,None))
    for fn in glob.glob(os.path.join(base,'revisions-cyb-*.jsonl')):
        for line in open(fn):
            line=line.strip()
            if line:
                try: revisions.append((ws,fn,json.loads(line)))
                except Exception: pass

# main sessions using cybernetics (same rule as round 1)
board_sids=set()
for fn,b in boards.items():
    s=b.get('sessionId','').replace('session-','')
    board_sids.add(s)
cyb_main=set()
for k,r in active.items():
    if r['origin']=='subagent': continue
    sid=k.replace('session-','')
    if r['has_cyb_plugin'] or sid in board_sids:
        cyb_main.add(k)

# children map parent
children=collections.defaultdict(list)
for k,r in active.items():
    if r['origin']=='subagent' and r['parent']:
        # role: from first_text
        ft=r['first_text']
        if ft.startswith('你是一个独立的 task agent') or '工作委托书' in ft: role='task'
        elif ft.startswith('你是 verify agent'): role='verify'
        elif ft.startswith('你是 goal agent'): role='triage'
        else: role='other'
        children[r['parent']].append((k,role,r))

res={}
res['meta']=dict(files=len(files), active=len(active), boards=len(boards),
                 rounds=len(rounds), revisions=len(revisions),
                 cyb_main=sorted(cyb_main))

# ---------- helpers ----------
def tree(sid):
    """main session + descendant subagent sessions"""
    out=[]
    for c,role,r in children.get(sid,[]):
        out.append((c,role,r))
    return out

def agg(sid_list):
    ti=to=tc=tt=0; n=0
    for s in sid_list:
        r=active[s]; ti+=r['inTok']; to+=r['outTok']; tc+=r['cacheTok']; tt+=r['totalTok']; n+=1
    return dict(sessions=n,input=ti,output=to,cache=tc,total_sum=tt)

main_ids=[k for k in active if active[k]['origin']!='subagent']
cyb_all=[]; norm_all=[]
for m in main_ids:
    grp=[m]+[c for c,_,_ in tree(m)]
    if m in cyb_main: cyb_all+=grp
    else: norm_all+=grp
res['groups']={'cyb':agg(cyb_all),'normal':agg(norm_all)}

# per-main-session stats
def sess_stats(sid):
    r=active[sid]
    kids=tree(sid)
    tok=r['inTok']+r['outTok']+sum(k['inTok']+k['outTok'] for _,_,k in kids)
    return dict(sid=sid,tok=tok,n_sub=len(kids),
                dur_min=(r['last_t']-r['first_t'])/60000.0,
                n_human=len(r['human_msgs']))

per_main={m:sess_stats(m) for m in main_ids}
res['per_main']=per_main

# ---------- ① bucketed comparison (by session total token) ----------
def bucket(tok):
    if tok<200_000: return '<200K'
    if tok<1_000_000: return '200K–1M'
    if tok<3_000_000: return '1M–3M'
    return '≥3M'
buck=collections.defaultdict(lambda: dict(cyb=[],norm=[]))
for m in main_ids:
    st=per_main[m]
    buck[bucket(st['tok'])]['cyb' if m in cyb_main else 'norm'].append(st)
b1=[]
for b in ['<200K','200K–1M','1M–3M','≥3M']:
    d=buck[b]
    row={'bucket':b}
    for g in ('cyb','norm'):
        lst=d[g]
        if lst:
            row[g]=dict(n=len(lst),
                tok_mean=statistics.mean(x['tok'] for x in lst),
                tok_median=statistics.median(x['tok'] for x in lst),
                dur_mean=statistics.mean(x['dur_min'] for x in lst),
                dur_median=statistics.median(x['dur_min'] for x in lst))
        else: row[g]=None
    b1.append(row)
res['dim1_buckets']=b1

# ---------- ② unattended time ----------
def unattended(sid):
    r=active[sid]
    hm=[h['t'] for h in r['human_msgs'] if h['t']]
    ft,lt=r['first_t'],r['last_t']
    if not hm: hm=[]
    span=(lt-ft)/60000.0
    if span<=0: return (0.0,0.0,0)
    # agent running time between consecutive human messages:
    # from human msg i to last event before human msg i+1 (approximated by msg i+1 time
    # minus a proxy: use events between). We record event times sparsely — use all event times.
    # simpler: unattended_i = t_{i+1} - t_i, then subtract human presence unknown; per spec,
    # unattended = span - sum(agent idle waiting)? Not recorded. Use: unattended = span minus
    # (time from last agent event before each human msg to that human msg) = human latency.
    # We did not store per-event times for speed; recompute: last event time before each human msg.
    return None  # replaced below
# recompute with event times: need them; do a second targeted pass for main sessions only
def detailed(sid):
    f=None
    for wdir in glob.glob(os.path.join(SESSIONS,'*')):
        cand=os.path.join(wdir,'session-'+sid.replace('session-',''),'session.v4.jsonl.zstd')
        if os.path.exists(cand): f=cand; break
    return f
def unattended2(sid):
    r=active[sid]
    f=None
    for wdir in glob.glob(os.path.join(SESSIONS,'*')):
        cand=os.path.join(wdir,'session-'+sid.replace('session-',''),'session.v4.jsonl.zstd')
        if os.path.exists(cand): f=cand; break
    if not f: return None
    out=zread(f)
    human_t=[]; all_t=[]; last_agent=[None]
    seen=set()
    for line in out.splitlines():
        if '"time"' not in line: continue
        try: e=json.loads(line)
        except: continue
        t=e.get('time')
        if t: all_t.append(t)
        ty=e.get('type')
        if ty in ('assistant/message','tool/result','step/end','turn/end','tool/call'):
            if t: last_agent[0]=t
        if ty=='user/message':
            d=e.get('data') or {}
            txt=''
            for c in d.get('content',[]):
                if c.get('type')=='text': txt+=c['text']
            if is_human(d,seen): human_t.append((t,last_agent[0]))
    if not all_t: return None
    all_t.sort(); span=(all_t[-1]-all_t[0])/60000.0
    pts=sorted(human_t)
    # attended (human-presence) = sum over human msgs of (t_human - last agent activity
    # observed before that msg): the window where the agent had stopped and was waiting.
    idle=0.0
    for t,la in pts:
        if la is not None:
            idle+=max(0.0,(t-la))/60000.0
    un=max(0.0,span-idle)
    return dict(sid=sid, span=round(span,1), unattended=round(un,1),
                idle=round(idle,1), ratio=round(un/span,3) if span>0 else 0,
                n_human=len(pts))
u={}
for m in main_ids:
    x=unattended2(m)
    if x: u[m]=x
res['dim2_unattended']=u

# ---------- ③ intervention classification ----------
CORR_WORDS=['不对','错了','有问题','没有','不对劲','重新','不是','应该','错误','别','不要',
            '问题','报错','失败','fix','wrong','not ','issue','but ','错','超','溢','bug','没找到','找不到','还是']
CONFIRM_WORDS=['可以','好的','确认','同意','没问题','ok','OK','行','通过','继续做','就这么','做吧','批准','lgtm']
def classify(sid):
    r=active[sid]
    msgs=sorted(r['human_msgs'],key=lambda x:x['t'] or 0)
    out=[]
    # goals created in this session for revise-correlation
    for i,msg in enumerate(msgs):
        txt=msg['text']
        cls=None
        if i==0: cls='goal_def'
        else:
            if i==len(msgs)-1 and any(w in txt for w in CONFIRM_WORDS): cls='accept'
        if cls is None:
            if any(w in txt for w in CORR_WORDS): cls='correct'
            elif i==len(msgs)-1: cls='accept'
            else: cls='other'
        out.append(cls)
    return out
c3={}
for m in sorted(cyb_main):
    c3[m]=classify(m)
res['dim3_class']={m:collections.Counter(v) for m,v in c3.items()}
res['dim3_totals']=collections.Counter(x for v in c3.values() for x in v)
# per-goal mid-correction rate: sessions map to goals via boards
sess_goal_cor=collections.defaultdict(lambda:[0,0])  # goals_with_correction, goals_total
for fn,b in boards.items():
    if not isinstance(b,dict): continue
    sid=b.get('sessionId','')
    g=b.get('goals',[])
    if sid in c3 and g:
        cnt=collections.Counter(c3[sid])
        # heuristic session-level: a session had correction if any 'correct'
        sess_goal_cor[sid][1]=len(g)
        sess_goal_cor[sid][0]=len(g) if cnt.get('correct',0)>0 else 0
res['dim3_goal']={k:dict(zip(('goals_with_corr','goals_total'),v)) for k,v in sess_goal_cor.items()}

# ---------- ④ verdict / rounds per goal ----------
# round file name = round-cyb-<goalId>-<n>.json; goalId IS the filename token
goal_rounds=collections.defaultdict(list)
verdicts=collections.Counter(); triage_ct=collections.Counter()
bad_rounds=0
for ws,fn,d in rounds:
    base=os.path.basename(fn)
    if d is None: bad_rounds+=1; continue
    m=re.match(r'round-cyb-(.+)-(\d+)\.json$',base)
    gid=m.group(1) if m else base
    goal_rounds[(ws,gid)].append(d)
    v=d.get('verdict')
    if isinstance(v,dict): verdicts['verdict.met=True' if v.get('met') else 'verdict.met=False']+=1
    else: verdicts['no-verdict(quick轮)']+=1
    t=d.get('triage')
    if isinstance(t,dict):
        for k in ('human','defer','auto'):
            triage_ct[k]+=len(t.get(k) or [])
res['dim4']=dict(verdicts=dict(verdicts), triage_items=dict(triage_ct),
    goals=len(goal_rounds),
    rounds_hist=dict(sorted(collections.Counter(len(v) for v in goal_rounds.values()).items())),
    multi_round_goals=sum(1 for v in goal_rounds.values() if len(v)>1),
    corrective_rounds=sum(max(0,len(v)-1) for v in goal_rounds.values()),
    bad_round_files=bad_rounds)

# ---------- ⑤ revision chains ----------
parent={}
for ws,fn,r in revisions:
    parent[r['to']]=r['from']
def chain_len(g):
    n=0; seen=set()
    while g in parent and g not in seen:
        seen.add(g); g=parent[g]; n+=1
    return n
all_goals=set()
for fn,b in boards.items():
    for g in b.get('goals',[]): all_goals.add(g.get('goalId'))
all_goals|=set(parent.keys())|set(parent.values())
chain=collections.Counter(chain_len(g) for g in all_goals if g)
res['dim5']=dict(goals_total=len(all_goals), chain_hist=dict(sorted(chain.items())),
                 revisions=len(revisions))

# ---------- ⑥ cache split ----------
def cache_split(id_list,label):
    ti=to=tc=0; n=0
    roles=collections.defaultdict(lambda:[0,0,0,0])
    for s in id_list:
        r=active[s]; ti+=r['inTok']; to+=r['outTok']; tc+=r['cacheTok']; n+=1
        if r['origin']=='subagent':
            ft=r['first_text']
            role='task' if (ft.startswith('你是一个独立的 task agent') or '工作委托书' in ft) else \
                 'verify' if ft.startswith('你是 verify agent') else \
                 'triage' if ft.startswith('你是 goal agent') else 'other'
        else: role='main'
        roles[role][0]+=r['inTok']; roles[role][1]+=r['outTok']; roles[role][2]+=r['cacheTok']; roles[role][3]+=1
    return dict(group=label,sessions=n,input=ti,output=to,cache=tc,
                cache_pct_of_input=round(100*tc/ti,1) if ti else None,
                roles={k:dict(sessions=v[3],input=v[0],output=v[1],cache=v[2],
                       cache_pct=round(100*v[2]/v[0],1) if v[0] else None) for k,v in roles.items()})
cyb_kids=[c for m in cyb_main for c,_,_ in tree(m)]
norm_main=[m for m in main_ids if m not in cyb_main]
norm_kids=[c for m in norm_main for c,_,_ in tree(m)]
res['dim6']=[cache_split(sorted(cyb_main),'cyb-main'),cache_split(cyb_kids,'cyb-sub'),
             cache_split(norm_main,'norm-main'),cache_split(norm_kids,'norm-sub')]

json.dump(res,open(os.path.join(os.path.dirname(__file__),'round2_stats.json'),'w'),ensure_ascii=False,indent=1,default=str)
print('written round2_stats.json', file=sys.stderr)
