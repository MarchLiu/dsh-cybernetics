#!/usr/bin/env python3
# cybernetics weekly analysis — round 3: 7.8 用户确认代理口径下的目标达成率
# 规则 A: 会话最后事件距快照时刻 >= 1h 无追加; 规则 B: 会话在归档台账中
# 数据: ~/.dsh/sessions/**, /Users/mars/jobs/*/.cybernetics/, ~/.dsh/dsh-session-archive/archive-ledger.json
import subprocess, glob, json, os, re, collections, datetime, sys

HOME = os.path.expanduser('~')
SESSIONS = os.path.join(HOME, '.dsh/sessions')
LEDGER = os.path.join(HOME, '.dsh/dsh-session-archive/archive-ledger.json')
R2 = os.path.join(os.path.dirname(__file__), 'round2_stats.json')
# 与 round2/报告一致的快照时刻（2026-11-05 15:21 +08:00）；同时记录真实重扫时刻
NOW = datetime.datetime(2026,11,5,15,21,tzinfo=datetime.timezone(datetime.timedelta(hours=8))).timestamp()*1000
SCAN = datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).timestamp()*1000
HOUR = 3600*1000

MACHINE_PREFIXES = (
 '你是一个独立的 task agent','你是 verify agent','你是 goal agent','【任务看板】',
 '【工作委托书】','<goal_round>','<cybernetics_round>','<goal_complete>','<goal_blocked>',
 'Current runtime context','<system-reminder>','Time sampled while preparing','(empty message)',
 '定时邮件检查任务','每日 GitHub 活动检查','每小时检查 Gmail',
)
def is_human(d, seen_texts):
    if (d.get('source') or {}).get('kind') != 'user': return False
    txt = ''
    for c in d.get('content', []):
        if c.get('type') == 'text': txt += c['text']
    t = txt.strip()
    if not t: return False
    if t.startswith(MACHINE_PREFIXES): return False
    if '定时' in t[:100]: return False
    if t in seen_texts: return False
    seen_texts.add(t)
    return True

def zread(p): return subprocess.run(['zstd','-dc','-q',p],capture_output=True).stdout.decode('utf-8','replace')

r2 = json.load(open(R2))
cyb_main = r2['meta']['cyb_main']
print('cyb_main sessions:', len(cyb_main), file=sys.stderr)

# ---------- archive ledger ----------
ledger = set()
ledger_meta = {}
try:
    L = json.load(open(LEDGER))
    for sid, v in (L.get('entries') or {}).items():
        ledger.add(sid); ledger_meta[sid] = v
    ledger_n = len(ledger)
except Exception as e:
    ledger_n = 0; print('LEDGER ERROR', e, file=sys.stderr)

# ---------- parse each cyb_main session ----------
def find_file(sid):
    for wdir in sorted(glob.glob(os.path.join(SESSIONS,'*'))):
        cand = os.path.join(wdir, sid, 'session.v4.jsonl.zstd')
        if os.path.exists(cand): return cand
    return None

sess = {}
for sid in cyb_main:
    f = find_file(sid)
    rec = dict(sid=sid, file=f, last_t=None, first_t=None, human_last=None,
               human_n=0, archived=(sid in ledger))
    if f:
        seen=set()
        try: out = zread(f)
        except Exception: out=''
        for line in out.splitlines():
            if '"time"' not in line and '"user/message"' not in line: continue
            try: e = json.loads(line)
            except: continue
            t = e.get('time')
            if t:
                if rec['first_t'] is None: rec['first_t'] = t
                if rec['last_t'] is None or t > rec['last_t']: rec['last_t'] = t
            if e.get('type') == 'user/message':
                d = e.get('data') or {}
                txt=''
                for c in d.get('content',[]):
                    if c.get('type')=='text': txt+=c['text']
                if is_human(d, seen):
                    rec['human_n'] += 1
                    if t and (rec['human_last'] is None or t > rec['human_last']):
                        rec['human_last'] = t
    sess[sid] = rec

# ---------- rules A / B ----------
for sid, r in sess.items():
    lt = r['last_t'] or 0
    r['silence_h'] = round((NOW - lt)/HOUR, 1) if lt else None
    r['ruleA'] = bool(lt) and (NOW - lt) >= HOUR
    r['ruleB'] = r['archived']
    r['confirmed'] = r['ruleA'] or r['ruleB']
    hl = r['human_last'] or 0
    r['human_silence_h'] = round((NOW - hl)/HOUR, 1) if hl else None
    r['ruleA_human'] = bool(hl) and (NOW - hl) >= HOUR

# ---------- boards: session -> goals ----------
boards = {}
for fn in glob.glob('/Users/mars/jobs/*/.cybernetics/board-session-*.json'):
    try:
        b = json.load(open(fn))
        boards[b.get('sessionId','')] = (fn, b)
    except Exception: pass

# ---------- revision chains ----------
parent = {}   # to -> from
rev_files = 0
for fn in glob.glob('/Users/mars/jobs/*/.cybernetics/revisions-cyb-*.jsonl'):
    rev_files += 1
    for line in open(fn):
        line = line.strip()
        if line:
            try:
                r = json.loads(line); parent[r['to']] = r['from']
            except Exception: pass

goal_status = {}   # goalId -> (status, title, sessionId)
for sid,(fn,b) in boards.items():
    for g in b.get('goals',[]):
        goal_status[g['goalId']] = (g.get('status','?'), g.get('title',''), sid)

child = {}   # from -> to (forward direction)
for to_,from_ in parent.items(): child[from_] = to_
def terminal(g):
    """walk forward along revisions to the chain tip (final goal)"""
    seen=set()
    while g in child and g not in seen:
        seen.add(g); g = child[g]
    return g

def chain_verdict(g):
    """superseded goal -> follow chain to terminal, judge terminal goal.
    returns (verdict, terminal_goalId, terminal_status)"""
    tg = terminal(g)
    st,_,tsid = goal_status.get(tg, ('?','',None))
    if st == 'met': return ('chain-achieved', tg, st)
    if st in ('paused','running'):
        r = sess.get(tsid or '', {})
        if r.get('confirmed'): return ('chain-defaulted', tg, st)
        return ('chain-open', tg, st)
    return ('chain-'+st, tg, st)

# ---------- per-session goal rollup ----------
ACH = ('met','chain-achieved','chain-defaulted')
rows = []
tot = collections.Counter()
for sid in cyb_main:
    r = sess[sid]
    fnb = boards.get(sid)
    goals = fnb[1].get('goals',[]) if fnb else []
    cc = collections.Counter()
    detail = []
    for g in goals:
        st, title, _ = goal_status.get(g['goalId'], (g.get('status','?'), g.get('title',''), sid))
        if st == 'met': v='met'
        elif st in ('paused','running'): v='defaulted' if r['confirmed'] else 'open-'+st
        elif st == 'superseded': v = chain_verdict(g['goalId'])[0]
        else: v='?'+st
        cc[v]+=1
        detail.append(dict(goalId=g['goalId'], status=st, title=title, verdict=v))
    rows.append(dict(sid=sid, ruleA=r['ruleA'], ruleB=r['ruleB'], confirmed=r['confirmed'],
                     silence_h=r['silence_h'], human_silence_h=r['human_silence_h'],
                     human_n=r['human_n'], last_t=r['last_t'], goals=detail,
                     counts=dict(cc)))
    tot.update(cc)

# ---------- headline numbers ----------
met_strict_now   = tot['met']
defaulted        = tot['defaulted']
chain_ach        = tot['chain-achieved']
chain_def        = tot['chain-defaulted']
chain_open       = tot['chain-open']
chain_sup        = tot['chain-superseded']  # terminal itself superseded (shouldn't happen)
proxy_achieved   = met_strict_now + defaulted + chain_ach + chain_def
goals_now        = sum(tot.values())

# strict baseline from round-1 snapshot (report section 5)
strict = dict(met=84, superseded=57, paused=23, running=1, total=165)

# chain-level: 58 revision files = 58 chains; terminal goal of each chain
chain_rows = []
for fn in glob.glob('/Users/mars/jobs/*/.cybernetics/revisions-cyb-*.jsonl'):
    tos = []
    for line in open(fn):
        line=line.strip()
        if line:
            try: tos.append(json.loads(line)['to'])
            except: pass
    if not tos: continue
    g = tos[-1]
    tg = terminal(g)
    st, title, tsid = goal_status.get(tg, ('?','',None))
    chain_rows.append(dict(chain_root=fn.split('revisions-cyb-')[1].replace('.jsonl',''),
                           terminal=tg, terminal_status=st, title=title))
chain_ct = collections.Counter(r['terminal_status'] for r in chain_rows)

# scheduled-task sessions (rule A may never fire): many machine-injected user msgs
for row in rows:
    r = sess[row['sid']]
    row['sched_suspect'] = (not r['ruleA']) and row['human_n'] <= 1 and (r['last_t'] and (NOW - r['last_t']) < HOUR)

res = dict(
  now_snapshot='2026-11-05 15:21 +08:00', scan_time=datetime.datetime.fromtimestamp(SCAN/1000, datetime.timezone(datetime.timedelta(hours=8))).isoformat(),
  ledger=dict(path=LEDGER, entries=ledger_n),
  strict_round1=strict, boards_now=dict(total=goals_now, met=met_strict_now,
      defaulted=defaulted, chain_achieved=chain_ach, chain_defaulted=chain_def,
      chain_open=chain_open, other=dict(tot)),
  proxy_rate=dict(achieved=proxy_achieved, total=goals_now),
  strict_rate_now=dict(achieved=met_strict_now, total=goals_now),
  chains=dict(files=rev_files, terminal_status=dict(chain_ct),
              achieved=sum(1 for r in chain_rows if r['terminal_status']=='met'),
              defaulted=sum(1 for r in chain_rows if r['terminal_status'] in ('paused','running') and sess.get(goal_status.get(r['terminal'],('','',''))[2] or '',{}).get('confirmed'))),
  sessions=rows,
  chain_rows=chain_rows,
)
json.dump(res, open(os.path.join(os.path.dirname(__file__),'round3_stats.json'),'w'), ensure_ascii=False, indent=1, default=str)

# console summary
print('=== sessions (26) ===')
for row in rows:
    print(f"{row['sid'][:24]} A={int(row['ruleA'])} B={int(row['ruleB'])} conf={int(row['confirmed'])} silence={row['silence_h']}h human_sil={row['human_silence_h']}h humans={row['human_n']} goals={row['counts']}")
print('=== totals ===')
print(dict(tot))
print('proxy achieved:', proxy_achieved, '/', goals_now)
print('strict now    :', met_strict_now, '/', goals_now)
print('strict round1 :', strict)
print('chains:', rev_files, dict(chain_ct))
