/* Renders the Cantelvio results page from window.RESULTS. No dependencies; charts are plain HTML/SVG. */
(function () {
  'use strict';
  var R = window.RESULTS;
  var lang = 'zh';
  try { lang = localStorage.getItem('cantelvio-lang') || ((navigator.language || '').indexOf('zh') === 0 ? 'zh' : 'en'); } catch (e) { lang = (navigator.language || '').indexOf('zh') === 0 ? 'zh' : 'en'; }

  var esc = function (s) { return String(s).replace(/[&<>"]/g, function (c) { return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;'}[c]; }); };
  var t = function (o) { return typeof o === 'string' ? o : (o && (o[lang] || o.zh)) || ''; };
  var $ = function (id) { return document.getElementById(id); };
  var L = function (zh, en) { return lang === 'en' ? en : zh; };
  var COLOR = {ref: 'var(--ref)', a: 'var(--s1)', v: 'var(--s1)', amt: 'var(--s2)', s3: 'var(--s3)'};

  function tableHtml(head, rows) {
    return '<div class="tbl"><table><thead><tr>' + head.map(function (h) { return '<th>' + esc(h) + '</th>'; }).join('') + '</tr></thead><tbody>' +
      rows.map(function (r) { return '<tr>' + r.map(function (c, i) { var isNum = /\d/.test(c) && /^[\d.,%≈\-−+→/\s×·()▲▼]*$/.test(c); return (i ? '<td' + (isNum ? ' class="num"' : '') + '>' : '<th scope="row">') + esc(c) + (i ? '</td>' : '</th>'); }).join('') + '</tr>'; }).join('') + '</tbody></table></div>';
  }
  function tableView(head, rows) { return '<details class="tv"><summary>' + L('数据表', 'Data table') + '</summary>' + tableHtml(head, rows) + '</details>'; }
  function legend(items) {
    return '<div class="legend" role="list">' + items.map(function (i) { return '<span role="listitem"><i style="background:' + i.color + '"></i>' + esc(i.label) + '</span>'; }).join('') + '</div>';
  }

  /* ---------- horizontal bars (always from zero) ---------- */
  function hbars(el, items, o) {
    o = o || {};
    var dec = o.dec == null ? 1 : o.dec, unit = o.unit || '';
    var max = o.max || Math.max.apply(null, items.map(function (i) { return i.v; })) * 1.0;
    var html = (o.legend ? legend(o.legend) : '') + '<div class="hb" role="list">' + items.map(function (i) {
      var lab = t(i), val = i.v.toFixed(dec) + unit;
      var w = Math.max(0.5, i.v / max * 100);
      var tip = '<b>' + esc(lab) + '</b><br>' + val + (i.tip ? '<br>' + esc(t(i.tip)) : '');
      return '<div class="hb-row' + (i.best ? ' best' : '') + '" role="listitem" tabindex="0" data-tip="' + esc(tip) + '" aria-label="' + esc(lab + ': ' + val) + '">' +
        '<span class="hb-l">' + esc(lab) + '</span><span class="hb-t"><span class="hb-b" style="width:' + w.toFixed(2) + '%;background:' + (COLOR[i.c] || 'var(--s1)') + '"></span><span class="hb-v">' + val + '</span></span></div>';
    }).join('') + '</div>';
    var head = [L('项目', 'Item'), (o.col || L('数值', 'Value')) + (unit ? ' (' + unit + ')' : '')];
    html += tableView(head, items.map(function (i) { return [t(i), i.v.toFixed(dec)]; }));
    el.innerHTML = html;
  }

  /* ---------- line chart (SVG at 1:1 pixels, re-rendered on resize) ---------- */
  function nice(min, max) {
    var span = max - min || 1, raw = span / 4, p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
    var step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
    var lo = Math.floor(min / step) * step, hi = Math.ceil(max / step) * step, ticks = [];
    for (var v = lo; v <= hi + step / 2; v += step) ticks.push(+v.toFixed(6));
    return {lo: lo, hi: hi, ticks: ticks, step: step};
  }
  var tipEl;
  function line(el, o) {
    var width = Math.max(280, el.clientWidth || 600), H = 250, m = {l: 46, r: 46, t: 14, b: 34};
    var xs = o.x, n = xs.length, dec = o.dec == null ? 1 : o.dec, unit = o.unit || '';
    var all = []; o.series.forEach(function (s) { all = all.concat(s.y); });
    var sc = nice(Math.min.apply(null, all), Math.max.apply(null, all));
    var pw = width - m.l - m.r, ph = H - m.t - m.b;
    var X = function (i) { return m.l + (n === 1 ? pw / 2 : pw * i / (n - 1)); };
    var Y = function (v) { return m.t + ph * (1 - (v - sc.lo) / (sc.hi - sc.lo)); };
    var spacing = pw / Math.max(1, n - 1), est = Math.max.apply(null, xs.map(function (x) { return x.length; })) * (lang === 'en' ? 6.4 : 12.5), narrow = !!o.xLong && est > spacing - 10;
    var s = '<svg class="lc" width="' + width + '" height="' + H + '" viewBox="0 0 ' + width + ' ' + H + '" role="img" aria-label="' + esc(o.aria || '') + '">';
    sc.ticks.forEach(function (v) {
      s += '<line class="grid" x1="' + m.l + '" x2="' + (width - m.r) + '" y1="' + Y(v) + '" y2="' + Y(v) + '"/><text class="ax" x="' + (m.l - 8) + '" y="' + (Y(v) + 4) + '" text-anchor="end">' + (+v.toFixed(2)) + '</text>';
    });
    xs.forEach(function (lab, i) { s += '<text class="ax" x="' + X(i) + '" y="' + (H - 12) + '" text-anchor="' + (narrow || (i > 0 && i < n - 1) ? 'middle' : i === 0 ? 'start' : 'end') + '">' + esc(narrow ? String(i + 1) : lab) + '</text>'; });
    o.series.forEach(function (se) {
      var d = se.y.map(function (v, i) { return (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1); }).join('');
      s += '<path d="' + d + '" fill="none" stroke="' + se.color + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>';
      se.y.forEach(function (v, i) { s += '<circle class="pt" data-i="' + i + '" cx="' + X(i) + '" cy="' + Y(v) + '" r="4" fill="' + se.color + '" stroke="var(--surface)" stroke-width="2"/>'; });
      var last = se.y.length - 1;
      s += '<text class="end" x="' + (X(last) + 9) + '" y="' + (Y(se.y[last]) + 4) + '">' + se.y[last].toFixed(dec) + '</text>';
    });
    s += '<line id="xh" class="xh" x1="0" x2="0" y1="' + m.t + '" y2="' + (m.t + ph) + '" style="display:none"/>';
    s += '<rect class="hit" x="' + m.l + '" y="' + m.t + '" width="' + pw + '" height="' + ph + '" fill="transparent"/></svg>';
    var html = legend(o.series.map(function (se) { return {color: se.color, label: se.name}; })) + s;
    if (narrow) html += '<ol class="xkey">' + xs.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ol>';
    html += tableView([o.xlabel || ''].concat(o.series.map(function (se) { return se.name; })), xs.map(function (x, i) { return [x].concat(o.series.map(function (se) { return se.y[i].toFixed(dec); })); }));
    el.innerHTML = html;
    var svg = el.querySelector('svg'), xh = svg.querySelector('.xh');
    function at(ev) {
      var r = svg.getBoundingClientRect(), px = ev.clientX - r.left;
      var i = Math.round((px - m.l) / pw * (n - 1)); i = Math.max(0, Math.min(n - 1, i));
      xh.setAttribute('x1', X(i)); xh.setAttribute('x2', X(i)); xh.style.display = '';
      svg.querySelectorAll('.pt').forEach(function (c) { c.setAttribute('r', +c.getAttribute('data-i') === i ? 6 : 4); });
      var rows = o.series.map(function (se) { return '<i style="background:' + se.color + '"></i>' + esc(se.name) + ': <b>' + se.y[i].toFixed(dec) + unit + '</b>'; }).join('<br>');
      showTip('<b>' + esc(xs[i]) + '</b><br>' + rows, ev.clientX, ev.clientY);
    }
    var hit = svg.querySelector('.hit');
    hit.addEventListener('pointermove', at); hit.addEventListener('pointerdown', at);
    hit.addEventListener('pointerleave', function () { xh.style.display = 'none'; hideTip(); svg.querySelectorAll('.pt').forEach(function (c) { c.setAttribute('r', 4); }); });
  }

  /* ---------- tooltip ---------- */
  function showTip(html, x, y) {
    if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'tip'; tipEl.setAttribute('role', 'tooltip'); document.body.appendChild(tipEl); }
    tipEl.innerHTML = html; tipEl.style.display = 'block';
    var w = tipEl.offsetWidth, h = tipEl.offsetHeight;
    var px = Math.min(Math.max(8, x + 14), window.innerWidth - w - 8), py = y + 16 + h > window.innerHeight ? y - h - 12 : y + 16;
    tipEl.style.left = px + 'px'; tipEl.style.top = py + 'px';
  }
  function hideTip() { if (tipEl) tipEl.style.display = 'none'; }
  document.addEventListener('pointermove', function (e) { var n = e.target.closest && e.target.closest('[data-tip]'); if (n) showTip(n.getAttribute('data-tip'), e.clientX, e.clientY); else if (!(e.target.closest && e.target.closest('.hit'))) hideTip(); });
  document.addEventListener('focusin', function (e) { var n = e.target.closest && e.target.closest('[data-tip]'); if (n) { var r = n.getBoundingClientRect(); showTip(n.getAttribute('data-tip'), r.left + 40, r.top); } });
  document.addEventListener('focusout', hideTip);

  function JL() { return [{color: 'var(--ref)', label: L('旧的分开训练模型', 'Old separately trained model')}, {color: 'var(--s1)', label: L('联合模型及其对照', 'Joint model and its controls')}]; }
  /* ---------- sections ---------- */
  function renderLines() {
    var cols = ['var(--s1)', 'var(--s2)'];
    function pen(id, key, aria) {
      line($(id), {x: R.penaltyX, xlabel: L('冲突惩罚', 'Clash penalty'), unit: '%', series: R.penalty[key].map(function (s, i) { return {name: t(s), y: s.y, color: cols[i]}; }), aria: aria});
    }
    pen('pen-clash', 'clash', L('半音冲突随惩罚变化', 'Semitone clashes versus penalty'));
    pen('pen-tone', 'tone', L('强拍和弦音随惩罚变化', 'Strong-beat chord tones versus penalty'));

    var xl = R.audioX[lang];
    line($('audio'), {x: xl, xlong: true, xLong: true, xlabel: L('阶段', 'Stage'), unit: '%', series: R.audio.map(function (s, i) { return {name: t(s), y: s.y, color: cols[i]}; }), aria: L('逐音 F1 随流程阶段变化', 'Note F1 across pipeline stages')});
    line($('train'), {x: R.trainX[lang], xLong: true, xlabel: L('阶段', 'Stage'), dec: 2, series: R.train.map(function (s) { return {name: t(s), y: s.y, color: 'var(--s1)'}; }), aria: L('事件损失随训练下降', 'Event loss falls with training')});
  }

  function render() {
    document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN';
    document.querySelectorAll('[data-zh]').forEach(function (e) { e.textContent = e.getAttribute('data-' + lang) || e.getAttribute('data-zh'); });
    $('lang').value = lang;
    $('asof').textContent = R.asOf;

    $('tiles').innerHTML = R.tiles.map(function (x) { return '<div class="tile"><div class="tv-v">' + esc(x.v) + '</div><div class="tv-l">' + esc(t(x)) + '</div></div>'; }).join('');

    $('models-t').innerHTML = tableHtml([L('模型', 'Model'), L('参数量', 'Parameters'), L('作用', 'Role'), L('状态', 'Status')],
      R.models.map(function (m) { return [m.n, m.p, t(m), t(R.statusLabel[m.s])]; }));

    hbars($('joint-m'), R.jointMelody, {legend: JL(), dec: 3, max: 2.6, col: L('旋律交叉熵', 'Melody CE')});
    hbars($('joint-c'), R.jointChord, {legend: JL(), dec: 3, max: 4.6, col: L('下一和弦交叉熵', 'Next-chord CE')});

    hbars($('ablation'), R.ablation.map(function (a) { return {zh: a.zh, en: a.en, v: a.v, c: a.best ? 'a' : 'ref', best: a.best, tip: {zh: '移调 +5：' + a.t5 + '；−4：' + a.t4, en: 'transposed +5: ' + a.t5 + '; −4: ' + a.t4}}; }), {legend: [{color: 'var(--ref)', label: L('其他设置', 'Other settings')}, {color: 'var(--s1)', label: L('最佳', 'Best')}], dec: 3, max: 2.8, col: L('验证损失', 'Validation loss')});
    $('ablation-t').innerHTML = tableHtml([L('设置', 'Setting'), L('验证损失', 'Val loss'), L('移调 +5', 'Transposed +5'), L('移调 −4', 'Transposed −4')],
      R.ablation.map(function (a) { return [t(a), a.v.toFixed(3), a.t5.toFixed(3), a.t4.toFixed(3)]; }));

    hbars($('amt-simple'), R.amtSimple, {dec: 1, unit: '%', max: 26, col: L('半音冲突', 'Semitone clashes')});
    $('amt-simple-lg').innerHTML = legend([{color: 'var(--s1)', label: 'v3.1'}, {color: 'var(--s2)', label: 'AMT'}]);
    hbars($('amt-lieder'), R.amtLieder.map(function (x) { return {zh: x.zh, en: x.en, v: x.v, c: x.c, tip: {zh: '强拍和弦拟合 ' + x.tone + '%', en: 'strong-beat chord fit ' + x.tone + '%'}}; }), {dec: 1, unit: '%', max: 32, col: L('半音冲突', 'Semitone clashes')});
    $('amt-lieder-lg').innerHTML = legend([{color: 'var(--ref)', label: L('真实钢琴', 'Real piano')}, {color: 'var(--s1)', label: 'v3.1'}, {color: 'var(--s2)', label: 'AMT'}]);
    $('amt-lieder-t').innerHTML = tableHtml([L('做法', 'Method'), L('半音冲突', 'Clashes'), L('强拍和弦拟合', 'Strong-beat chord fit')], R.amtLieder.map(function (x) { return [t(x), x.v + '%', x.tone + '%']; }));

    $('clips').innerHTML = R.audioClips.map(function (c) {
      return '<div class="clip"><h4>' + esc(t(c)) + '</h4>' + R.audioKinds.map(function (k) {
        return '<label><span>' + esc(t(k)) + '</span><audio controls preload="none" src="audio/' + c.id + '--' + k.id + '.mp3"></audio></label>';
      }).join('') + '</div>';
    }).join('');

    hbars($('harm'), R.harmBars, {legend: [{color: 'var(--s1)', label: L('学出来的模型', 'Learned models')}, {color: 'var(--ref)', label: L('规则基线', 'Rule baselines')}], dec: 1, unit: '%', max: 80, col: L('逐拍和弦完全一致', 'Exact per-beat chord match')});
    $('harm-effect').innerHTML = tableHtml([L('配伴奏场景', 'Accompaniment setting'), L('半音冲突：自定和弦 → 配和声模型', 'Clashes: own chords → harmonizer'), L('强拍和弦音', 'Strong-beat chord tones'), L('备注', 'Note')],
      R.harmEffect.map(function (h) { return [t(h), h.a, h.b, t(h.note)]; }));

    $('augnet').innerHTML = tableHtml([L('指标（186 部四重奏，333,793 拍）', 'Metric (186 quartets, 333,793 beats)'), 'AugmentedNet', L('规则跟踪器', 'Rule tracker')],
      R.augnet.map(function (a) { return [t(a), a.a, a.b || '—']; }));

    $('v31').innerHTML = tableHtml([L('指标（训练集窗口）', 'Metric (training-set windows)'), L('第 45,225 步', 'Step 45,225'), L('第 101,129 步', 'Step 101,129'), L('变化', 'Change')],
      R.v31Steps.map(function (r) { return [t(r), r.a, r.b, (r.better ? '▲ ' + L('更好', 'better') : '▼ ' + L('更差', 'worse'))]; }));

    $('software').innerHTML = tableHtml([L('项目', 'Item'), L('结果', 'Result')], R.software.map(function (s) { return [t(s), t(s.v)]; })).replace(/<td class="num">/g, '<td>');

    $('limits').innerHTML = R.limits.map(function (x) { return '<li>' + esc(t(x)) + '</li>'; }).join('');
    $('sources').innerHTML = R.sources.map(function (x) { return '<li>' + esc(t(x)) + '：<a href="' + R.repo + '/tree/main/' + encodeURI(x.p.split('、')[0]) + '"><code>' + esc(x.p) + '</code></a></li>'; }).join('');
    document.querySelectorAll('a.gh').forEach(function (a) { a.href = R.repo; });
    renderLines();
  }

  $('lang').addEventListener('change', function () { lang = this.value; try { localStorage.setItem('cantelvio-lang', lang); } catch (e) { } render(); });
  var rt, lastW = window.innerWidth; window.addEventListener('resize', function () { clearTimeout(rt); rt = setTimeout(function () { if (window.innerWidth !== lastW) { lastW = window.innerWidth; renderLines(); } }, 150); });
  render();
})();
