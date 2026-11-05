#!/usr/bin/env python3
# cybernetics weekly analysis — round 5: §7.10 会话用时统计（倒数第二事件口径）
# 主口径：会话用时 = 首个事件时间戳 → 倒数第二个事件时间戳
#   （理由：无法跟踪"用户满意离开的那一刻"，最后一个事件之后通常用户已离开）
# 对照口径：① 完整跨度（首→末）② 末 agent 活动口径（首→最后一条 assistant/tool/step 事件）
# 另：goal 粒度用时 = goal 创建（首次出现在 plugin:cybernetics/goals 快照）
#   → 末轮 round-cyb-<gid>-<n>.json 文件 mtime，按轮数分组。
# 数据: scripts/round2_stats.json（cyb_main 名单与 79 主会话集合）
#      ~/.dsh/sessions/**/session.v4.jsonl.zstd
#      /Users/mars/jobs/*/.cybernetics/（board / round 文件）
import subprocess, glob, json, os, collections, statistics, sys, re

HOME = os.path.expanduser('~')
SESSIONS = os.path.join(HOME, '.dsh/sessions')
CYB_ROOT = '/Users/mars/jobs'
HERE = os.path.dirname(os.path.abspath(__file__))
R2 = os.path.join(HERE, 'round2_stats.json')

CYB_WS = ['hypatia','dsh-cybernetics','deepseek-harness','marchliu.github.com','baoyu-design',
          'zgci.ac.cn/lab-ops','zgci.ac.cn/PhotoStory','zgci.ac.cn/ZGCAI-Mattermost','zgci.ac.cn/Mattermost-Plugins-Dev']

# 机器注入前缀（沿用 round4 口径）
MACHINE_PREFIXES = (
 '你是一个独立的 task agent','你是 verify agent','你是 goal agent','【任务看板】',
 '【工作委托书】','<goal_round>','<cybernetics_round>','<goal_complete>','<goal_blocked>',
 'Current runtime context','<system-reminder>','Time sampled while preparing','(empty message)',
 '定时邮件检查任务','每日 GitHub 活动检查','每小时检查 Gmail',
)
AGENT_EVENT_TYPES = {'assistant/message','tool/call','tool/result','step/start','step/end','assistant/attempt'}

def zread(p):
    return subprocess.run(['zstd','-dc','-q',p],capture_output=True).stdout.decode('utf-8','replace')

def find_file(sid):
    for wdir in sorted(glob.glob(os.path.join(SESSIONS,'*'))):
        cand = os.path.join(wdir, sid, 'session.v4.jsonl.zstd')
        if os.path.exists(cand): return cand
    return None

def text_of(d):
    return '\n'.join(c.get('text','') for c in d.get('content',[]) if c.get('type')=='text')

def is_human_text(d):
    if (d.get('source') or {}).get('kind') != 'user': return False
    t = text_of(d).strip()
    if not t: return False
    if t.startswith(MACHINE_PREFIXES): return False
    if '定时' in t[:100]: return False
    return True

def pct(vals, q):
    """线性插值分位数"""
    if not vals: return None
    s = sorted(vals)
    k = (len(s)-1) * q
    f, c = int(k), min(int(k)+1, len(s)-1)
    return s[f] + (s[c]-s[f]) * (k-f)

def dist(vals):
    if not vals: return None
    return {'n': len(vals), 'median_min': round(statistics.median(vals),2),
            'mean_min': round(statistics.mean(vals),2),
            'p25_min': round(pct(vals,0.25),2), 'p75_min': round(pct(vals,0.75),2),
            'min_min': round(min(vals),2), 'max_min': round(max(vals),2)}

# ---------- 1. 逐主会话解析 ----------
r2 = json.load(open(R2))
cyb_main = set(r2['meta']['cyb_main'])          # 26 个，带 session- 前缀
all_main = sorted(r2['per_main'].keys())        # 79 个主会话
print('cyb_main:', len(cyb_main), 'all_main:', len(all_main), file=sys.stderr)

sessions = {}
anomalies = {'missing_time_events': 0, 'sessions_with_missing_time': 0, 'out_of_order_pairs': 0,
             'sessions_with_out_of_order': 0, 'file_missing': []}
for sid in all_main:
    f = find_file(sid)
    rec = {'sid': sid, 'group': 'cyb' if sid in cyb_main else 'normal', 'file': f}
    if not f:
        anomalies['file_missing'].append(sid)
        rec['error'] = 'file_not_found'
        sessions[sid] = rec; continue
    evs = []
    for line in zread(f).splitlines():
        try: e = json.loads(line)
        except: continue
        if e.get('time') is None:
            anomalies['missing_time_events'] += 1
            rec['missing_time'] = rec.get('missing_time',0)+1
            continue
        evs.append(e)
    evs.sort(key=lambda e: e.get('seq', 0))
    n = len(evs)
    rec['n_timed'] = n
    rec['missing_time'] = rec.get('missing_time',0)
    if rec['missing_time']: anomalies['sessions_with_missing_time'] += 1
    for i in range(1, n):
        if evs[i]['time'] < evs[i-1]['time']:
            anomalies['out_of_order_pairs'] += 1
            rec['ooo'] = rec.get('ooo',0)+1
    if rec.get('ooo'): anomalies['sessions_with_out_of_order'] += 1
    if n < 2:
        rec['too_few'] = True
        sessions[sid] = rec; continue
    first, penult, last = evs[0]['time'], evs[-2]['time'], evs[-1]['time']
    last_agent_t = None
    for e in reversed(evs):
        if e.get('type') in AGENT_EVENT_TYPES:
            last_agent_t = e['time']; break
    rec['first_t'], rec['penult_t'], rec['last_t'] = first, penult, last
    rec['dur_full_min']   = (last - first) / 60000
    rec['dur_penult_min'] = (penult - first) / 60000
    rec['dur_lastagent_min'] = ((last_agent_t or first) - first) / 60000
    rec['tail_min'] = rec['dur_full_min'] - rec['dur_penult_min']
    # 末事件分类
    le = evs[-1]; lt = le.get('type','')
    if lt == 'assistant/message':
        cls = 'assistant 消息'
    elif lt == 'user/message':
        cls = 'user 消息（真人）' if is_human_text(le.get('data') or {}) else '机器注入（user 机器文本）'
    else:
        cls = '系统/机器事件（非消息类型）'
    rec['last_type'] = cls
    rec['last_type_raw'] = lt
    sessions[sid] = rec

# ---------- 2. 分组统计 ----------
def group_stats(grp):
    rows = [r for r in sessions.values() if r['group']==grp and not r.get('too_few') and not r.get('error')]
    out = {}
    for key in ('dur_penult_min','dur_full_min','dur_lastagent_min'):
        out[key] = dist([r[key] for r in rows])
    out['tail_min'] = dist([r['tail_min'] for r in rows])
    return out

stats = {'cyb': group_stats('cyb'), 'normal': group_stats('normal')}

# 末事件类型分布与尾部贡献（完整跨度−主口径）
tail_by_type = collections.defaultdict(lambda: collections.defaultdict(list))
for r in sessions.values():
    if r.get('too_few') or r.get('error'): continue
    tail_by_type[r['group']][r['last_type']].append(r['tail_min'])
tail_table = {}
for grp, m in tail_by_type.items():
    tail_table[grp] = {k: {'n': len(v), 'share': round(len(v)/sum(len(x) for x in m.values()),3),
                           'tail_median_min': round(statistics.median(v),2),
                           'tail_mean_min': round(statistics.mean(v),2)}
                       for k, v in sorted(m.items())}
# 末事件原始类型细分
last_raw = collections.Counter((r['group'], r.get('last_type_raw')) for r in sessions.values()
                               if not r.get('too_few') and not r.get('error'))
last_raw_table = {f'{g}|{t}': n for (g, t), n in sorted(last_raw.items())}

too_few = [r['sid'] for r in sessions.values() if r.get('too_few')]
errors  = [{'sid': r['sid'], 'error': r.get('error')} for r in sessions.values() if r.get('error')]

# 跨天尾部敏感样本：截掉的尾部最大的几个会话
big_tails = sorted((r for r in sessions.values() if not r.get('too_few') and not r.get('error')),
                   key=lambda r: -r['tail_min'])[:8]
big_tail_rows = [{'sid': r['sid'], 'group': r['group'], 'last_type': r['last_type'],
                  'tail_min': round(r['tail_min'],1), 'dur_full_min': round(r['dur_full_min'],1),
                  'dur_penult_min': round(r['dur_penult_min'],1)} for r in big_tails]

# ---------- 3. goal 粒度 ----------
# goal 创建时间 = goalId 首次出现在所属会话 plugin:cybernetics/goals 快照的时间
# 末轮结束时间 = 最大轮号 round-cyb-<gid>-<n>.json 的文件 mtime
goal_rounds = {}   # gid -> {ws, max_n, end_t(mtime), owner_sid}
for ws in CYB_WS:
    base = os.path.join(CYB_ROOT, ws, '.cybernetics')
    if not os.path.isdir(base): continue
    for fn in glob.glob(os.path.join(base,'round-cyb-*.json')):
        m = re.match(r'round-cyb-(.+)-(\d+)\.json$', os.path.basename(fn))
        if not m: continue
        gid, n = 'cyb-' + m.group(1), int(m.group(2))  # 文件名 token 无 cyb- 前缀，board/revisions 中为 cyb-<token>
        cur = goal_rounds.get(gid)
        if cur is None or n > cur['max_n']:
            goal_rounds[gid] = {'ws': ws, 'max_n': n, 'end_t': os.path.getmtime(fn)*1000, 'owner_sid': None}
    for fn in glob.glob(os.path.join(base,'board-session-*.json')):
        try: b = json.load(open(fn))
        except: continue
        sid = b.get('sessionId')
        for g in b.get('goals') or []:
            gid = g.get('goalId')
            if gid in goal_rounds:
                goal_rounds[gid]['owner_sid'] = sid

goal_create_cache = {}
def goal_create_t(sid, gid):
    key = (sid, gid)
    if key in goal_create_cache: return goal_create_cache[key]
    t = None
    f = find_file(sid) if sid else None
    if f:
        for line in zread(f).splitlines():
            if gid not in line: continue
            try: e = json.loads(line)
            except: continue
            if e.get('type') == 'plugin:cybernetics/goals':
                goals = (e.get('data') or {}).get('goals') or []
                if any(g.get('goalId')==gid for g in goals):
                    t = e['time']; break
    goal_create_cache[key] = t
    return t

goal_rows = []
no_create = 0
for gid, info in goal_rounds.items():
    ct = goal_create_t(info['owner_sid'], gid)
    if ct is None:
        no_create += 1; continue
    dur = (info['end_t'] - ct) / 60000
    if dur < 0:
        continue  # mtime 早于创建（异常），排除并计数
    goal_rows.append({'goalId': gid, 'ws': info['ws'], 'rounds': info['max_n'], 'dur_min': dur})
neg_mtime = no_create  # 粗记（说明中区分）
buckets = {'1轮': [], '2轮': [], '3+轮': []}
for g in goal_rows:
    k = '1轮' if g['rounds']==1 else ('2轮' if g['rounds']==2 else '3+轮')
    buckets[k].append(g['dur_min'])
goal_stats = {k: dist(v) for k, v in buckets.items()}

res = {
 'meta': {
   'base': 'round2_stats.json (79 主会话，cyb 26 / normal 53)',
   'method': '主口径=首事件→倒数第二事件；对照=完整跨度(首→末)与末 agent 活动口径(首→最后一条 assistant/tool/step 事件)；时间来自 session.v4.jsonl.zstd 事件 time 字段(ms)',
   'goal_method': 'goal 创建=goalId 首次出现于所属会话 plugin:cybernetics/goals 快照；末轮结束=round-cyb-<gid>-<n>.json 文件 mtime（近似，含盘上写盘延迟）',
 },
 'anomalies': anomalies,
 'group_stats': stats,
 'tail_by_type': tail_table,
 'last_raw_types': last_raw_table,
 'too_few_sessions': too_few,
 'file_errors': errors,
 'big_tail_samples': big_tail_rows,
 'goal_stats': goal_stats,
 'goal_rows_n': len(goal_rows),
 'goal_excluded_no_create_time': no_create,
 'per_session': [{k: (round(v,4) if isinstance(v,float) else v) for k, v in r.items() if k != 'file'}
                 for r in (sessions[s] for s in all_main)],
}
with open(os.path.join(HERE,'round5_stats.json'),'w') as fp:
    json.dump(res, fp, ensure_ascii=False, indent=1)

print(json.dumps({k: res[k] for k in ('anomalies','group_stats','tail_by_type','too_few_sessions','file_errors','goal_stats','goal_rows_n','goal_excluded_no_create_time')}, ensure_ascii=False, indent=1))
