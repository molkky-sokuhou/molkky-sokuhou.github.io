function mk_roundRobinList(nos) {
  var list = nos.slice().sort(function (a, b) { return a - b; });
  if (list.length % 2) list.push(0);
  var M = list.length, rounds = [], arr = list.slice();
  for (var r = 0; r < M - 1; r++) {
    var pairs = [];
    for (var k = 0; k < M / 2; k++) {
      var a = arr[k], b = arr[M - 1 - k];
      if (a && b) pairs.push(a < b ? [a, b] : [b, a]);
    }
    pairs.sort(function (x, y) { return x[0] - y[0]; });
    rounds.push(pairs);
    arr = [arr[0], arr[M - 1]].concat(arr.slice(1, M - 1));
  }
  return rounds;
}
function mk_boardOrder(group, teamNos, courts) {
  if (courts < 4 || teamNos.length !== 8 || group.length !== 4) return null;
  var round = Number(group[0].round);
  if (round < 1 || round > 7 || !Number.isInteger(round)) return null;
  var ring = teamNos.slice().sort(function (a,b) { return a-b; });
  for (var r = 1; r < round; r++) ring.splice(1, 0, ring.pop());
  var ordered = [];
  for (var c = 0; c < 4; c++) {
    var a = ring[c], b = ring[7-c];
    var match = group.find(function (m) { return (m.a === a && m.b === b) || (m.a === b && m.b === a); });
    if (!match) return null;
    ordered.push(match);
  }
  return ordered;
}
function mk_assignCourts(matches, courts) {
  var groups = {}, teamSets = {}, out = {};
  matches.forEach(function (m) {
    var key = m.cycle + '-' + m.round;
    (groups[key] = groups[key] || []).push(m);
    var teams = teamSets[m.cycle] || (teamSets[m.cycle] = new Set());
    teams.add(m.a); teams.add(m.b);
  });
  Object.keys(groups).forEach(function (key) {
    var group = groups[key];
    var ordered = mk_boardOrder(group, Array.from(teamSets[group[0].cycle]), courts);
    if (!ordered) ordered = group.slice().sort(function (x, y) {
      return (Number(String(x.id).split('-')[2]) || 0) - (Number(String(y.id).split('-')[2]) || 0);
    });
    ordered.forEach(function (m, i) {
      out[m.id] = { court: (i % courts) + 1, wave: Math.floor(i / courts) + 1 };
    });
  });
  return out;
}
function mk_num(v) { return v === '' || v === null || v === undefined ? null : Number(v); }
function mk_total(m, side) {
  var first = mk_num(m[side + '1']), second = mk_num(m[side + '2']);
  if (first !== null && second !== null) return first + second;
  return mk_num(m[side === 'a' ? 'totalA' : 'totalB']);
}
function mk_hasResult(m) {
  return ['a','b'].every(function (side) {
    var total = mk_total(m, side);
    return total !== null && Number.isInteger(total) && total >= 0 && total <= 100;
  });
}
function mk_standings(teams, matches, players) {
  var st = {};
  teams.forEach(function (t) { st[t.no] = { no: t.no, name: t.name, played: 0, total: 0 }; });
  matches.forEach(function (m) {
    if (!mk_hasResult(m)) return;
    var ta = mk_total(m, 'a'), tb = mk_total(m, 'b');
    if (st[m.a]) { st[m.a].played++; st[m.a].total += ta; }
    if (st[m.b]) { st[m.b].played++; st[m.b].total += tb; }
  });
  var arr = Object.keys(st).map(function (k) { return st[k]; });
  arr.sort(function (x, y) { return y.total - x.total || x.no - y.no; });
  var rank = 0, prev = null;
  arr.forEach(function (s, i) {
    if (s.total !== prev) { rank = i + 1; prev = s.total; }
    s.rank = rank;
    s.avg = s.played ? Math.round(s.total / s.played * 10) / 10 : 0;
    s.members = players.filter(function (p) { return Number(p.team) === s.no; }).map(function (p) { return p.name; });
  });
  return arr;
}
function mk_match(cycle, round, k, a, b) {
  return { id: cycle + '-' + round + '-' + k + '-' + Math.random().toString(36).slice(2, 8), cycle: cycle, round: round, a: a, b: b, a1: '', a2: '', b1: '', b2: '', by: '', at: '' };
}
function mk_buildMatches(nos, cycle) {
  if (typeof nos === 'number') { var n = nos; nos = []; for (var i = 1; i <= n; i++) nos.push(i); }
  var out = [];
  mk_roundRobinList(nos).forEach(function (pairs, r) {
    pairs.forEach(function (p, k) { out.push(mk_match(cycle, r + 1, k + 1, p[0], p[1])); });
  });
  return out;
}
function mk_rebuildMatches(teamNos, matches) {
  var kept = matches.filter(mk_hasResult);
  var last = matches.reduce(function (mx, m) { return Math.max(mx, Number(m.cycle) || 1); }, 1);
  var has = {}; teamNos.forEach(function (n) { has[n] = 1; });
  var out = kept.slice();
  matches.forEach(function (m) {
    if (!mk_hasResult(m) && Number(m.cycle) < last && has[m.a] && has[m.b]) out.push(m);
  });
  return out.concat(mk_rebuildCycle(teamNos, kept, last, matches));
}
function mk_rebuildCycle(teamNos, kept, cycle, old) {
  /* 送信待ちの結果がずれないよう、同じ2チームのまだの試合は、もとの試合番号を引き継ぐ */
  var oldId = {};
  (old || []).forEach(function (m) { if (!mk_hasResult(m) && Number(m.cycle) === cycle) oldId[Math.min(m.a, m.b) + '-' + Math.max(m.a, m.b)] = m.id; });
  var played = {};
  kept.forEach(function (m) { if (Number(m.cycle) === cycle) played[Math.min(m.a, m.b) + '-' + Math.max(m.a, m.b)] = 1; });
  var remaining = [];
  mk_roundRobinList(teamNos).forEach(function (pairs) {
    pairs.forEach(function (p) { if (!played[p[0] + '-' + p[1]]) remaining.push(p); });
  });
  var round = kept.filter(function (m) { return Number(m.cycle) === cycle; }).reduce(function (mx, m) { return Math.max(mx, m.round); }, 0);
  var out = [];
  var nosSorted = teamNos.slice().sort(function (a, b) { return a - b; });
  /* 1ラウンドで全チームが試合できる組み方を探す。見つからなければできるだけ多く組む */
  function perfect(pool) {
    var used = {}, pick = [], tries = 0;
    function dfs() {
      if (++tries > 20000) return false;
      var t = nosSorted.filter(function (n) { return !used[n]; })[0];
      if (t === undefined) return true;
      for (var i = 0; i < pool.length; i++) {
        var q = pool[i];
        if ((q[0] === t || q[1] === t) && !used[q[0]] && !used[q[1]]) {
          used[q[0]] = used[q[1]] = 1; pick.push(i);
          if (dfs()) return true;
          used[q[0]] = used[q[1]] = 0; pick.pop();
        }
      }
      return false;
    }
    return dfs() ? pick : null;
  }
  while (remaining.length) {
    round++;
    var idxs = perfect(remaining);
    var take = {};
    if (idxs) idxs.forEach(function (i) { take[i] = 1; });
    else {
      var used = {};
      remaining.forEach(function (q, i) { if (!used[q[0]] && !used[q[1]]) { used[q[0]] = used[q[1]] = 1; take[i] = 1; } });
    }
    var next = [], k = 0;
    remaining.forEach(function (q, i) {
      if (take[i]) { var nm = mk_match(cycle, round, ++k, q[0], q[1]), key = q[0] + '-' + q[1]; if (oldId[key]) { nm.id = oldId[key]; nm.k = k; } out.push(nm); }
      else next.push(q);
    });
    remaining = next;
  }
  return out;
}
function mk_scheduleInSync(teams, matches) {
  if (!teams.length) return true;
  var nos = {}; teams.forEach(function (t) { nos[t.no] = 1; });
  var cycle = matches.reduce(function (mx, m) { return Math.max(mx, Number(m.cycle) || 1); }, 1);
  var seen = {};
  for (var i = 0; i < matches.length; i++) {
    var m = matches[i];
    if (!mk_hasResult(m) && (!nos[m.a] || !nos[m.b])) return false;
    if (Number(m.cycle) === cycle) { seen[m.a] = 1; seen[m.b] = 1; }
  }
  return teams.every(function (t) { return seen[t.no]; });
}
function mk_teamLabel(no) {
  var label = '';
  for (var n = Math.floor(Number(no)); Number.isFinite(n) && n > 0; n = Math.floor((n - 1) / 26)) {
    label = String.fromCharCode(65 + (n - 1) % 26) + label;
  }
  return label;
}
