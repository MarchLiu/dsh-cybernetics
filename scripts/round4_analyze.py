#!/usr/bin/env python3
# cybernetics weekly analysis — round 4: §7.9 代理口径修正（未响应要求视为失败）
# 在 round3 代理口径（静默>=1h 或归档 => goal 默认接受）基础上增加失败例外：
#   会话最后一个真实用户消息之后，若 agent 侧尾部输出包含"未被响应的要求"
#   （向用户提问 / 请求执行命令 / 等待确认审批 / 声明等待人类输入），
#   则该会话的"默认接受"goal 重分类为"失败（要求未响应）"。
# 数据: scripts/round3_stats.json + ~/.dsh/sessions/**（重新解析尾部事件）
import subprocess, glob, json, os, re, collections, datetime, sys

HOME = os.path.expanduser('~')
SESSIONS = os.path.join(HOME, '.dsh/sessions')
HERE = os.path.dirname(os.path.abspath(__file__))
R3 = os.path.join(HERE, 'round3_stats.json')

MACHINE_PREFIXES = (
 '你是一个独立的 task agent','你是 verify agent','你是 goal agent','【任务看板】',
 '【工作委托书】','<goal_round>','<cybernetics_round>','<goal_complete>','<goal_blocked>',
 'Current runtime context','<system-reminder>','Time sampled while preparing','(empty message)',
 '定时邮件检查任务','每日 GitHub 活动检查','每小时检查 Gmail',
)

# ---------- 启发式模式 ----------
# 请求用户行动/输入的特征
REQ_PATTERNS = [
    (r'请[^。！？\n]{0,40}(执行|运行|输入|回复|确认|审批|批准|检查|修复|暂停|重试|手动|粘贴|提供|补[充充一下]|告知|告诉我)', '请求用户执行/提供'),
    (r'(需要|麻烦|等待|恳请)[^。！？\n]{0,30}(你|您|用户|人工|人类)[^。！？\n]{0,40}(输入|确认|操作|处理|回复|审批|决策|介入|指示)', '等待人类输入/决策'),
    (r'(请|需要你)[^。！？\n]{0,20}(选择|决定|拍板|扫码|登录|授权|点击)', '请求用户选择/授权'),
    (r'是否(需要|继续|要|可以|同意)', '向用户提问'),
    (r'(哪个|哪种|如何处理|怎么办)[^。！？\n]*[?？]\s*$', '向用户提问'),
    (r'(?<![如好])问[^。！？\n]{0,30}[?？]\s*$', '向用户提问'),
    (r'waitingForHuman|等待人工|等待用户(输入|确认|响应|回复|操作)', '声明等待人类输入'),
    (r'(请|麻烦)[^。！？\n]{0,15}(注意|留意|关注|尽快处理)', '提醒用户处理'),
    (r'[?？]\s*$', '疑问句结尾'),
]
# 礼貌性收尾豁免（命中句若含这些标记则不算待响应要求）
POLITE_MARKERS = re.compile(r'如需|如有(需要|问题)|如果(需要|你)|若需|欢迎|随时|可以继续|无需回复|不必回复')

def zread(p):
    return subprocess.run(['zstd','-dc','-q',p],capture_output=True).stdout.decode('utf-8','replace')

def is_human(d, seen):
    if (d.get('source') or {}).get('kind') != 'user': return False
    txt = ''
    for c in d.get('content', []):
        if c.get('type') == 'text': txt += c['text']
    t = txt.strip()
    if not t: return False
    if t.startswith(MACHINE_PREFIXES): return False
    if '定时' in t[:100]: return False
    if t in seen: return False
    seen.add(t)
    return True

def find_file(sid):
    for wdir in sorted(glob.glob(os.path.join(SESSIONS,'*'))):
        cand = os.path.join(wdir, sid, 'session.v4.jsonl.zstd')
        if os.path.exists(cand): return cand
    return None

def text_of(content):
    out = []
    for c in content or []:
        if c.get('type') == 'text': out.append(c.get('text',''))
    return '\n'.join(out)

def strip_fences(text):
    """去掉 ``` 围栏代码块（dsh-ui JSON / 命令块含 ? 与'请点击'等，避免误报）"""
    return re.sub(r'```.*?```', ' ', text, flags=re.S)

def detect_requests(text):
    """返回 [(片段, 依据)]；礼貌性收尾被豁免；代码围栏先剔除"""
    hits = []
    text = strip_fences(text or '')
    # 去掉括号/引号内的内容（引用、列举中的修辞性问句不是向用户提问）
    text = re.sub(r'（[^（）]*）|\([^()]*\)|「[^「」]*」', '（）', text)
    # 按句子切分（保留结尾标点）
    sents = re.split(r'(?<=[。！？!?\n])', text)
    for s in sents:
        st = s.strip()
        if not st: continue
        for pat, label in REQ_PATTERNS:
            if re.search(pat, st):
                if POLITE_MARKERS.search(st):
                    break  # 礼貌性收尾豁免
                hits.append((st[:120], label))
                break
    return hits

r3 = json.load(open(R3))
confirmed = [r for r in r3['sessions'] if r['confirmed']]
print('confirmed sessions:', len(confirmed), file=sys.stderr)

# ---------- 对每个已收尾会话解析尾部事件 ----------
sess_tail = {}
for r in confirmed:
    sid = r['sid']
    f = find_file(sid)
    rec = dict(sid=sid, file=f, human_last=None, hit=False, signals=[], evidence='',
               last_assistant='', struct_signals=[])
    if not f:
        sess_tail[sid] = rec; continue
    seen = set()
    events = []
    for line in zread(f).splitlines():
        try: e = json.loads(line)
        except: continue
        events.append(e)
    # 找最后一个真实用户消息时刻
    for e in events:
        if e.get('type') == 'user/message':
            d = e.get('data') or {}
            if is_human(d, seen) and e.get('time'):
                if rec['human_last'] is None or e['time'] > rec['human_last']:
                    rec['human_last'] = e['time']
    cut = rec['human_last'] or 0
    # 收集 cut 之后的 agent 侧输出
    tail_texts = []
    for e in events:
        t = e.get('time') or 0
        if t and t <= cut: continue
        et = e.get('type')
        d = e.get('data') or {}
        if et == 'assistant/message':
            msg = d.get('message') or {}
            tx = text_of(msg.get('content'))
            if tx.strip(): tail_texts.append(tx)
        elif et == 'tool/call':
            name = d.get('name','')
            if name in ('ask_user_question','bsk_assist') or 'question' in name.lower():
                rec['struct_signals'].append(dict(kind='tool_call', name=name,
                    args=(d.get('arguments') or '')[:200]))
        elif et in ('approval/request','permission/request','approval/pending'):
            rec['struct_signals'].append(dict(kind='approval', name=et))
        elif et == 'system/message':
            tx = text_of(d.get('content'))
            if 'waitingForHuman' in (tx or ''): rec['struct_signals'].append(dict(kind='system', name='waitingForHuman'))
    rec['last_assistant'] = strip_fences(tail_texts[-1]).strip() if tail_texts else ''
    for tx in tail_texts:
        for frag, label in detect_requests(tx):
            rec['signals'].append(dict(fragment=frag, basis=label))
    # 结构化信号直接命中
    if rec['struct_signals']:
        rec['signals'].append(dict(fragment='[structured] '+json.dumps(rec['struct_signals'],ensure_ascii=False)[:150],
                                   basis='结构化待响应信号'))
    rec['hit'] = bool(rec['signals'])
    if rec['last_assistant']:
        rec['evidence'] = rec['last_assistant'][:200]
    sess_tail[sid] = rec

# ---------- 重分类 ----------
# 会话命中 => 该会话 defaulted goal -> failed-unresponded
hit_sids = {s for s,rec in sess_tail.items() if rec['hit']}
goal_status = {}  # goalId -> (status,title,sid) 从 board 重建
for fn in glob.glob('/Users/mars/jobs/*/.cybernetics/board-session-*.json'):
    try: b = json.load(open(fn))
    except: continue
    for g in b.get('goals',[]):
        goal_status[g['goalId']] = (g.get('status','?'), g.get('title',''), b.get('sessionId',''))
child = {}
for fn in glob.glob('/Users/mars/jobs/*/.cybernetics/revisions-cyb-*.jsonl'):
    for line in open(fn):
        line = line.strip()
        if line:
            try:
                rj = json.loads(line); child[rj['from']] = rj['to']
            except: pass
def terminal(g):
    seen = set()
    while g in child and g not in seen:
        seen.add(g); g = child[g]
    return g

rows = []
tot = collections.Counter()
for r in r3['sessions']:
    sid = r['sid']; failed = sid in hit_sids
    detail = []
    for g in r['goals']:
        v = g['verdict']
        if failed and v == 'defaulted':
            v = 'failed-unresponded'
        elif failed and v == 'chain-defaulted':
            tg = terminal(g['goalId'])
            st, _, tsid = goal_status.get(tg, ('?','',None))
            if tsid in hit_sids: v = 'chain-failed'
        detail.append(dict(goalId=g['goalId'], status=g['status'], title=g['title'], verdict=v))
    cc = collections.Counter(d['verdict'] for d in detail)
    tot.update(cc)
    rows.append(dict(sid=sid, confirmed=r['confirmed'], tail_hit=failed,
                     silence_h=r.get('silence_h'), human_silence_h=r.get('human_silence_h'),
                     goals=detail, counts=dict(cc)))

ACH = ('met','chain-achieved','chain-defaulted')
achieved = sum(tot[v] for v in ACH)
total = sum(tot.values())

# ---------- 链末端重算（对齐 round3 的 54 条链口径，避免 board 漂移） ----------
r3_chains = {r['chain_root']: r for r in r3['chain_rows']}
chain_rows = []
for fn in glob.glob('/Users/mars/jobs/*/.cybernetics/revisions-cyb-*.jsonl'):
    root = fn.split('revisions-cyb-')[1].replace('.jsonl','')
    if root not in r3_chains:   # 只保留 round3 时已存在的 54 条链
        continue
    base = r3_chains[root]
    tg = base['terminal']       # 末端 goalId 沿用 round3 判定
    st = base['terminal_status']
    title = base['title']
    tsid = goal_status.get(tg, ('?','',None))[2]
    verdict = st
    if st == 'met': verdict = 'met'
    elif st in ('paused','running'):
        verdict = 'chain-failed' if tsid in hit_sids else ('defaulted' if any(x['sid']==tsid and x['confirmed'] for x in r3['sessions']) else 'open')
    chain_rows.append(dict(chain_root=root, terminal=tg, terminal_status=st,
                           verdict=verdict, title=title, session=tsid))
chain_ct = collections.Counter(r['verdict'] for r in chain_rows)
chain_ach = sum(1 for r in chain_rows if r['verdict'] in ('met','defaulted'))

# ---------- 失败 goal 清单 ----------
fail_goals = []
for row in rows:
    if not row['tail_hit']: continue
    rec = sess_tail[row['sid']]
    for g in row['goals']:
        if g['verdict'] in ('failed-unresponded','chain-failed'):
            sig = rec['signals'][0] if rec['signals'] else {}
            fail_goals.append(dict(session=row['sid'], goalId=g['goalId'], title=g['title'],
                                   orig_verdict=('chain-defaulted' if g['verdict']=='chain-failed' else 'defaulted'),
                                   basis=sig.get('basis',''), fragment=sig.get('fragment',''),
                                   evidence=rec['evidence'][:160]))

res = dict(
  base='round3_stats.json (proxy 138/142, chains 52/54)',
  method='last-real-human-message 之后 agent 尾部输出的文本启发式 + 结构化信号(ask_user_question/approval/waitingForHuman)',
  hit_sessions=sorted(hit_sids),
  session_tails={s: {k: v for k, v in rec.items() if k != 'file'} for s, rec in sess_tail.items()},
  revised_rate=dict(achieved=achieved, total=total),
  revised_counts=dict(tot),
  chains=dict(files=len(chain_rows), verdict=dict(chain_ct), achieved=chain_ach),
  chain_rows=chain_rows,
  failed_goals=fail_goals,
  scanned_at=datetime.datetime.now(datetime.timezone(datetime.timedelta(hours=8))).isoformat(),
)
json.dump(res, open(os.path.join(HERE,'round4_stats.json'),'w'), ensure_ascii=False, indent=1, default=str)

print('=== 尾部检测命中会话 ===')
for s in sorted(hit_sids):
    rec = sess_tail[s]
    for sig in rec['signals']:
        print(s[:45], '|', sig['basis'], '|', sig['fragment'][:110])
    print()
print('=== 修正后 goal 口径 ===', dict(tot), f'{achieved}/{total} = {achieved/total*100:.1f}%')
print('=== 链末端 ===', dict(chain_ct), f'{chain_ach}/{len(chain_rows)}')
print('=== 失败 goal 数 ===', len(fail_goals))
