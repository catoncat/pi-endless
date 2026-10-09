"""First-principles check of the OptChat/UniiChat view math.

1. Does `due = (T - last)/2^l` reproduce Taelin's rollback push exactly (view = push list)?
   Does the old `(T - first)/2^(l+2)` rule fail, as the v2 recipe claims?
2. Cache cost: per-message merging at a fixed budget (v1) vs batched sawtooth 128K->64K (v2):
   how many view lines are *not* a shared prefix with the previous call (must be re-sent)?
3. Shape of the resulting view (lines per level).
"""
import random, sys
from collections import Counter

# ---------- 1. Taelin's push ----------
def push(new_state, states):
    if states is None:
        return {'keep': 0, 'life': 0, 'state': new_state, 'older': None}
    keep, life, state, older = states['keep'], states['life'], states['state'], states['older']
    if keep == 0:
        return {'keep': 1, 'life': life, 'state': state, 'older': older}
    if life > 0:
        return {'keep': 0, 'life': 0, 'state': new_state, 'older': {'keep': 0, 'life': life - 1, 'state': state, 'older': older}}
    return {'keep': 0, 'life': life, 'state': new_state, 'older': push(state, older)}

def push_view(states, T):
    """States newest-first -> lines oldest-first as (l, i): each state starts a line up to the next newer state."""
    starts = []
    s = states
    while s is not None:
        starts.append(s['state']); s = s['older']
    starts.reverse()
    lines = []
    for k, st in enumerate(starts):
        nxt = starts[k + 1] if k + 1 < len(starts) else T
        n = nxt - st
        assert n & (n - 1) == 0 and st % n == 0, (st, n)
        l = n.bit_length() - 1
        lines.append((l, st >> l))
    return lines

def start(p): return p[1] << p[0]
def end(p): return start(p) + (1 << p[0])

def fit_to_count(view, T, budget_lines, rule):
    """Merge most-due sibling pair until len(view) <= budget_lines. rule: 'last' (v2) or 'first' (v1)."""
    view = list(view)
    while len(view) > budget_lines:
        best, best_due = -1, None
        for j in range(len(view) - 1):
            a, b = view[j], view[j + 1]
            if a[0] != b[0] or a[1] % 2 or b[1] != a[1] + 1: continue
            l = a[0]
            due = (T - (end(b) - 1)) / 2 ** l if rule == "last" else (T - start(a)) / 2 ** (l + 2)
            if best_due is None or due > best_due:  # strict >: oldest of equal pairs wins (scanned oldest-first)
                best, best_due = j, due
        if best < 0: break
        a = view[best]
        view[best:best + 2] = [(a[0] + 1, a[1] // 2)]
    return view

def check_push(N=20000):
    states = None
    ok = {'last': 0, 'first': 0}
    view = {'last': [], 'first': []}
    for t in range(N + 1):
        states = push(t, states)
        T = t + 1
        pv = push_view(states, T)
        for rule in ok:
            view[rule] = fit_to_count(view[rule] + [(0, t)], T, len(pv), rule)
            if view[rule] == pv: ok[rule] += 1
    print(f"[1] push equivalence over t=0..{N}: rule=last matches {ok['last']}/{N+1}, rule=first matches {ok['first']}/{N+1}")

# ---------- 2. cache cost ----------
def simulate(N, policy, rule, hi=128_000, lo=64_000, seed=0, size_range=(150, 512)):
    rnd = random.Random(seed)
    sizes = {}  # node -> bytes (deterministic per node)
    def sz(p):
        if p not in sizes: sizes[p] = rnd.randint(*size_range)
        return sizes[p]
    view, prev = [], []
    total_bytes = 0
    resent = 0            # lines not shared as prefix with previous call's view
    merges = 0
    batches = 0
    max_lines = 0
    for t in range(N):
        view.append((0, t)); total_bytes += sz((0, t))
        T = t + 1
        if policy == 'per-message':
            target = hi
            if total_bytes > hi:
                view, total_bytes, m = fit_bytes(view, T, target, rule, sz)
                merges += m
        else:  # batched
            if total_bytes > hi:
                view, total_bytes, m = fit_bytes(view, T, lo, rule, sz)
                merges += m; batches += 1
        # common prefix with previous view
        k = 0
        while k < len(prev) and k < len(view) and prev[k] == view[k]: k += 1
        resent += len(view) - k
        prev = list(view)
        max_lines = max(max_lines, len(view))
    levels = Counter(l for l, _ in view)
    return dict(resent_per_msg=resent / N, merges=merges, batches=batches, lines=len(view), bytes=total_bytes,
                max_lines=max_lines, levels=dict(sorted(levels.items())))

def fit_bytes(view, T, target, rule, sz):
    view = list(view); total = sum(sz(p) for p in view); merges = 0
    while total > target:
        best, best_due = -1, None
        for j in range(len(view) - 1):
            a, b = view[j], view[j + 1]
            if a[0] != b[0] or a[1] % 2 or b[1] != a[1] + 1: continue
            l = a[0]
            due = (T - (end(b) - 1)) / 2 ** l if rule == "last" else (T - start(a)) / 2 ** (l + 2)
            if best_due is None or due > best_due: best, best_due = j, due
        if best < 0: break
        a, b = view[best], view[best + 1]
        parent = (a[0] + 1, a[1] // 2)
        total += sz(parent) - sz(a) - sz(b)
        view[best:best + 2] = [parent]; merges += 1
    return view, total, merges

if __name__ == '__main__':
    check_push(int(sys.argv[1]) if len(sys.argv) > 1 else 20000)
    N = int(sys.argv[2]) if len(sys.argv) > 2 else 30000
    for policy, rule in [('per-message', 'first'), ('per-message', 'last'), ('batched', 'last'), ('batched', 'first')]:
        r = simulate(N, policy, rule)
        print(f"[2] N={N} {policy:12s} rule={rule:5s}: resent lines/msg={r['resent_per_msg']:.1f} merges={r['merges']} batches={r['batches']} "
              f"final lines={r['lines']} bytes={r['bytes']} max_lines={r['max_lines']}")
        print(f"    lines per level: {r['levels']}")
