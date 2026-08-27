/* Forex Playbook — static app. ข้อมูลทั้งหมดเก็บใน localStorage ของเครื่องผู้ใช้ */
(function () {
  "use strict";

  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));
  const KEY = { trades: "fx_trades_v1", checks: "fx_checks_v1", notes: "fx_notes_v1", calc: "fx_calc_v1" };

  const load = (k, fb) => { try { return JSON.parse(localStorage.getItem(k)) || fb; } catch (e) { return fb; } };
  const save = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} };
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = (v) => { const n = parseFloat(v); return isFinite(n) ? n : 0; };
  const fmt = (n, d) => n.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d });

  let trades = load(KEY.trades, []);
  const checks = load(KEY.checks, {});
  const notes = load(KEY.notes, {});

  /* ================= เวลา / เซสชัน ================= */
  function tzOffsetHours(tz, date) {
    const dtf = new Intl.DateTimeFormat("en-US", {
      timeZone: tz, hour12: false,
      year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit"
    });
    const p = {};
    dtf.formatToParts(date).forEach((x) => { p[x.type] = x.value; });
    const asUTC = Date.UTC(+p.year, p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second);
    return Math.round((asUTC - date.getTime()) / 60000) / 60;
  }

  function bangkokHour(localHour, tz, date) {
    const off = tzOffsetHours(tz, date);
    return ((localHour - off + 7) % 24 + 24) % 24;
  }

  function sessionState(key, date) {
    const s = SESSION_META[key];
    if (!s || !s.tz) return null;
    const off = tzOffsetHours(s.tz, date);
    const utcH = date.getUTCHours() + date.getUTCMinutes() / 60;
    const localH = ((utcH + off) % 24 + 24) % 24;
    const localDay = new Date(date.getTime() + off * 3600000).getUTCDay();
    const weekday = localDay >= 1 && localDay <= 5;
    return {
      open: bangkokHour(s.open, s.tz, date),
      close: bangkokHour(s.close, s.tz, date),
      live: weekday && localH >= s.open && localH < s.close,
      weekday
    };
  }

  const activeSessions = () => {
    const now = new Date();
    return Object.keys(SESSION_META).filter((k) => {
      const st = sessionState(k, now);
      return st && st.live;
    });
  };

  const hhmm = (h) => String(Math.floor(h)).padStart(2, "0") + ":" + String(Math.round((h % 1) * 60)).padStart(2, "0");

  /* ================= แท็บ ================= */
  $$(".tab").forEach((btn) => btn.addEventListener("click", () => {
    $$(".tab").forEach((b) => b.classList.remove("active"));
    $$(".panel").forEach((p) => p.classList.remove("active"));
    btn.classList.add("active");
    $("#tab-" + btn.dataset.tab).classList.add("active");
    if (btn.dataset.tab === "sessions") renderSessions();
    if (btn.dataset.tab === "stats") renderStats();
  }));

  /* ================= ลิงก์ภายนอก ================= */
  // ปฏิทินข่าวโฟกัสเฉพาะที่กระทบ XAUUSD / DXY / BTC (ล้วนขับด้วยข่าว USD เป็นหลัก)
  const CALENDARS = [
    { label: "ข่าว USD (XAUUSD/DXY) · ForexFactory", url: "https://www.forexfactory.com/calendar?currency=USD" },
    { label: "ข่าว USD (XAUUSD/DXY) · Investing.com", url: "https://th.investing.com/economic-calendar/?country[]=5" },
    { label: "ปฏิทินคริปโต (BTC) · CoinMarketCal", url: "https://coinmarketcal.com/en/" }
  ];
  const TV_PREFIX = "OANDA:";  // เปลี่ยนเป็นโบรกเกอร์ที่ใช้จริงได้ เช่น "FX:" หรือ "PEPPERSTONE:"
  const TV_MAP = {
    XAUUSD: "OANDA:XAUUSD", XAGUSD: "OANDA:XAGUSD",
    WTI: "TVC:USOIL", BRENT: "TVC:UKOIL", DXY: "TVC:DXY",
    BTCUSD: "BITSTAMP:BTCUSD", ETHUSD: "BITSTAMP:ETHUSD", SPX: "TVC:SPX", NDX: "TVC:NDX",
    OIL: "TVC:USOIL"
  };
  const TV_INTERVAL = { M1: "1", M5: "5", M15: "15", M30: "30", H1: "60", H4: "240", D1: "1D", W1: "1W" };

  function symbolsFor(s) {
    if (s.symbols) return s.symbols.slice();  // กลยุทธ์ที่ผูกกับสินทรัพย์เฉพาะ
    const text = s.pairs.join(" ");
    const out = [];
    const push = (x) => { if (x && out.indexOf(x) < 0) out.push(x); };
    (text.match(/\b[A-Z]{6}\b/g) || []).forEach(push);
    if (/WTI/i.test(text)) push("WTI");
    if (/Brent/i.test(text)) push("BRENT");
    if (/ดัชนี USD/.test(text)) push("DXY");
    return out.length ? out : WATCHLIST.slice();  // ไม่ผูกคู่เงิน = ใช้ watchlist ของผู้ใช้
  }

  function tvInterval(timeframe) {
    const tf = (String(timeframe).match(/[MHDW]\d+/) || [])[0];
    return TV_INTERVAL[tf] || "60";
  }

  function tvUrl(code, timeframe) {
    const sym = TV_MAP[code] || TV_PREFIX + code;
    return "https://www.tradingview.com/chart/?symbol=" + encodeURIComponent(sym) + "&interval=" + tvInterval(timeframe);
  }

  /* กลยุทธ์ที่กำหนด tvStudies ไว้ = เปิดหน้ากราฟฝังของเราที่ตั้งอินดิเคเตอร์ให้อัตโนมัติ
     (URL ของ TradingView ปกติส่งค่าอินดิเคเตอร์ไม่ได้) */
  /* ทุกกลยุทธ์เข้าหน้า chart.html เสมอ แม้ไม่มีอินดิเคเตอร์ให้ตั้ง
     เพราะหน้านั้นมีแผ่นสั่งเทรดกับเช็กลิสต์ซึ่งใช้ได้กับทุกกลยุทธ์ */
  function chartUrl(code, s) {
    const sym = TV_MAP[code] || TV_PREFIX + code;
    return "chart.html?sid=" + s.id + "&symbol=" + encodeURIComponent(sym) +
      "&interval=" + tvInterval(s.timeframe);
  }

  const link = (url, label, cls) =>
    '<a class="linkbtn' + (cls ? " " + cls : "") + '" href="' + esc(url) +
    '" target="_blank" rel="noopener noreferrer">' + esc(label) + "</a>";

  /* การ์ดถือว่า "ถอดจากต้นฉบับ" ก็ต่อเมื่อมีเลขหน้าอ้างอิงจริงในฟิลด์ source */
  const isVerified = (s) => !!s.source;
  const confOf = (s) => CONFIDENCE_META[isVerified(s) ? "verified" : "unverified"];
  const refOf = (s) => "กลยุทธ์ที่ " + (s.no || s.id) + (s.source ? " · " + s.source : "");

  /* ================= Playbook ================= */
  const state = { styles: new Set(), q: "", sessionOnly: false };

  function renderChips() {
    $("#styleChips").innerHTML = Object.entries(STYLE_META).map(([k, m]) => {
      const on = state.styles.has(k);
      return '<button class="chip' + (on ? " on" : "") + '" data-style="' + k + '"' +
        (on ? ' style="background:' + m.color + ';border-color:' + m.color + '"' : "") +
        '><i class="dot" style="background:' + m.color + '"></i>' + esc(m.label) + "</button>";
    }).join("");
    $$("#styleChips .chip").forEach((c) => c.addEventListener("click", () => {
      const k = c.dataset.style;
      state.styles.has(k) ? state.styles.delete(k) : state.styles.add(k);
      renderChips(); renderCards();
    }));
  }

  function matches(s) {
    if (state.styles.size && !state.styles.has(s.style)) return false;
    if (state.sessionOnly) {
      const act = activeSessions();
      const ok = s.session.includes("any") || s.session.some((x) => act.includes(x));
      if (!ok) return false;
    }
    if (state.q) {
      const hay = [s.name, s.tagline, s.concept, s.timeframe, s.pairs.join(" "),
        s.indicators.join(" "), STYLE_META[s.style].label].join(" ").toLowerCase();
      if (!hay.includes(state.q.toLowerCase())) return false;
    }
    return true;
  }

  function renderCards() {
    const act = activeSessions();
    const list = STRATEGIES.filter(matches);
    const nv = STRATEGIES.filter(isVerified).length;
    $("#count").textContent = "แสดง " + list.length + " จาก " + STRATEGIES.length +
      " หัวข้อ (17 กลยุทธ์) · ถอดจากต้นฉบับแล้ว " + nv + "/" + STRATEGIES.length +
      (act.length ? " · ตอนนี้เปิด: " + act.map((k) => SESSION_META[k].label).join(", ") : " · ตลาดหลักปิดอยู่");
    $("#cards").innerHTML = list.map((s) => {
      const m = STYLE_META[s.style], c = confOf(s);
      const live = s.session.some((x) => act.includes(x));
      return '<article class="scard" data-id="' + s.id + '" style="--sc:' + m.color + '" tabindex="0">' +
        (live ? '<span class="active-now">เปิดอยู่</span>' : "") +
        '<div class="id">' + esc(refOf(s)) + "</div>" +
        "<h3>" + esc(s.name) + "</h3>" +
        '<p class="tag">' + esc(s.tagline) + "</p>" +
        '<div class="meta">' +
          '<span class="pill style">' + esc(m.label) + "</span>" +
          '<span class="pill">' + esc(s.timeframe) + "</span>" +
          '<span class="pill">' + s.session.map((x) => esc(SESSION_META[x].label)).join(" / ") + "</span>" +
          '<span class="pill conf" style="color:' + c.color + '">' + esc(c.label) + "</span>" +
        "</div>" +
        '<div class="links">' +
          link(chartUrl(symbolsFor(s)[0], s), "กราฟ " + symbolsFor(s)[0], "tv") +
          link(CALENDARS[0].url, "ปฏิทินข่าว", "cal") +
        "</div></article>";
    }).join("") || '<p class="empty">ไม่พบกลยุทธ์ที่ตรงกับตัวกรอง</p>';

    $$(".scard .links a").forEach((a) => a.addEventListener("click", (e) => e.stopPropagation()));
    $$(".scard").forEach((el) => {
      const open = () => openDrawer(+el.dataset.id);
      el.addEventListener("click", open);
      el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(); } });
    });
  }

  $("#search").addEventListener("input", (e) => { state.q = e.target.value.trim(); renderCards(); });
  $("#sessionOnly").addEventListener("change", (e) => { state.sessionOnly = e.target.checked; renderCards(); });

  /* ================= Drawer ================= */
  const drawer = $("#drawer"), backdrop = $("#backdrop");

  function closeDrawer() { drawer.hidden = true; backdrop.hidden = true; }
  backdrop.addEventListener("click", closeDrawer);
  $("#drawerClose").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeDrawer(); });

  function ul(arr) { return "<ul>" + arr.map((x) => "<li>" + esc(x) + "</li>").join("") + "</ul>"; }

  function openDrawer(id) {
    const s = STRATEGIES.find((x) => x.id === id);
    if (!s) return;
    const m = STYLE_META[s.style], c = confOf(s);
    const done = checks[id] || [];

    $("#drawerBody").innerHTML =
      '<div class="id" style="color:var(--muted);font-size:.75rem">' + esc(refOf(s)) + "</div>" +
      "<h2>" + esc(s.name) + "</h2>" +
      '<p class="tag">' + esc(s.tagline) + "</p>" +
      '<div class="meta" style="margin-bottom:1rem">' +
        '<span class="pill style" style="--sc:' + m.color + ';color:' + m.color + ';border-color:' + m.color + '">' + esc(m.label) + "</span>" +
        '<span class="pill conf" style="color:' + c.color + '">' + esc(c.label) + "</span>" +
      "</div>" +
      (isVerified(s) ? "" :
        '<div class="warnbox">เนื้อหาการ์ดนี้ยังไม่ได้เทียบกับหนังสือ — เรียบเรียงจากความรู้ทั่วไปเกี่ยวกับกลยุทธ์แนวนี้ ' +
        "ค่าพารามิเตอร์และกฎอาจไม่ตรงต้นฉบับ อย่าใช้เทรดเงินจริงก่อนตรวจกับหนังสือ</div>") +
      '<div class="dsection"><h4>แนวคิด</h4><p>' + esc(s.concept) + "</p></div>" +
      '<div class="dsection"><h4>ข้อมูลไม้เทรด</h4><dl class="kv">' +
        "<dt>Time frame</dt><dd>" + esc(s.timeframe) + "</dd>" +
        "<dt>ระยะถือ</dt><dd>" + esc(s.hold) + "</dd>" +
        "<dt>เซสชัน</dt><dd>" + s.session.map((x) => esc(SESSION_META[x].label)).join(", ") + "</dd>" +
        "<dt>คู่เงิน</dt><dd>" + s.pairs.map(esc).join(", ") + "</dd>" +
        "<dt>อินดิเคเตอร์</dt><dd>" + s.indicators.map(esc).join("<br>") + "</dd>" +
        "<dt>Stop Loss</dt><dd>" + esc(s.stopLoss) + "</dd>" +
        "<dt>Take Profit</dt><dd>" + esc(s.takeProfit) + "</dd>" +
        (s.riskReward ? "<dt>Risk : Reward</dt><dd>" + esc(s.riskReward) + "</dd>" : "") +
        (s.source ? "<dt>อ้างอิง</dt><dd>" + esc(s.source) + "</dd>" : "") +
      "</dl></div>" +
      (s.bookExample ? '<div class="dsection"><h4>ตัวอย่างจากหนังสือ</h4><p class="example">' +
        esc(s.bookExample) + "</p></div>" : "") +
      '<div class="dsection"><h4>เงื่อนไขเข้าไม้</h4>' + ul(s.entry) + "</div>" +
      '<div class="dsection"><h4>เงื่อนไขออก</h4>' + ul(s.exit) + "</div>" +
      '<div class="dsection risk"><h4>ความเสี่ยง / ข้อควรระวัง</h4>' + ul(s.risks) + "</div>" +
      (s.notes ? '<div class="dsection"><h4>ข้อมูลประกอบจากหนังสือ</h4>' + ul(s.notes) + "</div>" : "") +
      '<div class="dsection"><h4>เช็กลิสต์ก่อนเข้าไม้</h4>' +
        '<div class="checkbar"><i id="cbFill"></i></div><div id="checkList"></div>' +
        '<button class="btn" id="resetChecks" style="margin-top:.5rem">ล้างเช็กลิสต์</button></div>' +
      '<div class="dsection"><h4>เปิดกราฟ TradingView (' + esc(s.timeframe) + ")</h4>" +
        '<div class="links">' + symbolsFor(s).map((code) =>
          link(chartUrl(code, s), code, "tv")).join("") + "</div></div>" +
      '<div class="dsection"><h4>ปฏิทินข่าว' + (s.style === "news" ? " (จำเป็นสำหรับกลยุทธ์นี้)" : "") + "</h4>" +
        '<div class="links">' + CALENDARS.map((c2) =>
          link(c2.url, c2.label, "cal")).join("") + "</div></div>" +
      '<div class="dsection"><h4>โน้ตของฉัน / ค่าจากหนังสือ</h4>' +
        '<textarea class="notes" id="noteBox" placeholder="เติมค่าพารามิเตอร์ที่แน่นอนจากหนังสือ เช่น period ของ EMA, ระยะ SL/TP, เวลาที่ใช้ตีกรอบ">' +
        esc(notes[id] || "") + "</textarea><div class=\"saved\" id=\"noteSaved\"></div></div>" +
      '<button class="btn primary" id="logFromDrawer">บันทึกเทรดด้วยกลยุทธ์นี้</button>';

    function paintChecks() {
      $("#checkList").innerHTML = s.checklist.map((t, i) =>
        '<label class="check' + (done[i] ? " done" : "") + '"><input type="checkbox" data-i="' + i + '"' +
        (done[i] ? " checked" : "") + "><span>" + esc(t) + "</span></label>").join("");
      $("#cbFill").style.width = (done.filter(Boolean).length / s.checklist.length * 100) + "%";
      $$("#checkList input").forEach((cb) => cb.addEventListener("change", () => {
        done[+cb.dataset.i] = cb.checked;
        checks[id] = done; save(KEY.checks, checks); paintChecks();
      }));
    }
    paintChecks();

    $("#resetChecks").addEventListener("click", () => {
      done.length = 0; checks[id] = done; save(KEY.checks, checks); paintChecks();
    });

    let t;
    $("#noteBox").addEventListener("input", (e) => {
      notes[id] = e.target.value; save(KEY.notes, notes);
      clearTimeout(t); $("#noteSaved").textContent = "บันทึกแล้ว";
      t = setTimeout(() => { $("#noteSaved").textContent = ""; }, 1200);
    });

    $("#logFromDrawer").addEventListener("click", () => {
      closeDrawer();
      $$(".tab").forEach((b) => b.classList.remove("active"));
      $$(".panel").forEach((p) => p.classList.remove("active"));
      $('.tab[data-tab="journal"]').classList.add("active");
      $("#tab-journal").classList.add("active");
      $("#jStrategy").value = String(id);
      $("#jPair").focus();
    });

    drawer.hidden = false; backdrop.hidden = false; drawer.scrollTop = 0;
  }

  /* ================= เซสชัน ================= */
  function renderSessions() {
    const now = new Date();
    const keys = ["asia", "london", "ny"];
    $("#sessionGrid").innerHTML = keys.map((k) => {
      const s = SESSION_META[k], st = sessionState(k, now);
      const fits = STRATEGIES.filter((x) => x.session.includes(k)).map((x) => x.name);
      return '<div class="session' + (st.live ? " live" : "") + '">' +
        "<h3>" + esc(s.label) + (st.live ? '<span class="live-dot"></span>' : "") + "</h3>" +
        '<div class="time">' + hhmm(st.open) + " – " + hhmm(st.close) + "</div>" +
        '<div class="status">' + (st.live ? "เปิดอยู่ตอนนี้" : st.weekday ? "ปิดอยู่" : "สุดสัปดาห์ · ตลาดปิด") + "</div>" +
        (fits.length ? '<div class="fits">กลยุทธ์: ' + fits.map(esc).join(", ") + "</div>" : "") +
        "</div>";
    }).join("");
  }

  /* ================= คำนวณขนาดไม้ ================= */
  const calcFields = ["cBalance", "cRisk", "cSL", "cPipValue", "cRR"];
  const savedCalc = load(KEY.calc, null);
  if (savedCalc) calcFields.forEach((f) => { if (savedCalc[f] != null) $("#" + f).value = savedCalc[f]; });

  function renderCalc() {
    const bal = num($("#cBalance").value), risk = num($("#cRisk").value);
    const sl = num($("#cSL").value), pv = num($("#cPipValue").value), rr = num($("#cRR").value);
    const riskAmt = bal * risk / 100;
    const lots = sl > 0 && pv > 0 ? riskAmt / (sl * pv) : 0;
    const reward = riskAmt * rr;
    const store = {}; calcFields.forEach((f) => { store[f] = $("#" + f).value; }); save(KEY.calc, store);

    $("#calcResult").innerHTML =
      '<div class="big">' + fmt(lots, 2) + " <small>lot</small></div>" +
      '<p class="hint">= ' + fmt(lots * 100000, 0) + " หน่วยของสกุลเงินฐาน · " + fmt(lots * 10, 1) + " mini lot</p>" +
      '<dl class="kv" style="margin-top:1rem">' +
        "<dt>เสี่ยงต่อไม้</dt><dd>" + fmt(riskAmt, 2) + " USD (" + fmt(risk, 2) + "% ของพอร์ต)</dd>" +
        "<dt>ถ้าโดน SL</dt><dd class=\"neg\">-" + fmt(riskAmt, 2) + " USD (" + fmt(sl, 0) + " pips)</dd>" +
        "<dt>ถ้าถึง TP (RR " + fmt(rr, 1) + ":1)</dt><dd class=\"pos\">+" + fmt(reward, 2) + " USD (" + fmt(sl * rr, 0) + " pips)</dd>" +
        "<dt>เสียติดกัน 5 ไม้</dt><dd class=\"neg\">-" + fmt(riskAmt * 5, 2) + " USD → เหลือ " + fmt(bal - riskAmt * 5, 2) + " USD</dd>" +
        "<dt>Win rate ที่ต้องมีเพื่อเสมอตัว</dt><dd>" + (rr > 0 ? fmt(100 / (1 + rr), 1) + "%" : "—") + "</dd>" +
      "</dl>";
  }
  calcFields.forEach((f) => $("#" + f).addEventListener("input", renderCalc));
  $("#calcForm").addEventListener("submit", (e) => e.preventDefault());

  /* ================= Journal ================= */
  $("#jStrategy").innerHTML = STRATEGIES.map((s) =>
    '<option value="' + s.id + '">' + (s.no || s.id) + ". " + esc(s.name) + "</option>").join("");
  $("#jDate").value = new Date().toISOString().slice(0, 10);

  const stratName = (id) => { const s = STRATEGIES.find((x) => x.id === +id); return s ? s.name : "—"; };

  function renderTrades() {
    const tb = $("#tradeTable tbody");
    const sorted = trades.slice().sort((a, b) => (a.date < b.date ? 1 : -1));
    tb.innerHTML = sorted.map((t) => {
      const cls = t.result === "win" ? "pos" : t.result === "loss" ? "neg" : "";
      const label = { win: "กำไร", loss: "ขาดทุน", be: "เสมอ" }[t.result] || "";
      return "<tr>" +
        "<td>" + esc(t.date) + "</td>" +
        "<td>" + esc(stratName(t.strategy)) + "</td>" +
        "<td>" + esc(t.pair) + "</td>" +
        "<td>" + (t.side === "buy" ? "Buy" : "Sell") + "</td>" +
        '<td class="' + cls + '">' + label + "</td>" +
        '<td class="num ' + cls + '">' + (t.pips === "" ? "—" : fmt(num(t.pips), 1)) + "</td>" +
        '<td class="num ' + cls + '">' + (t.pnl === "" ? "—" : fmt(num(t.pnl), 2)) + "</td>" +
        "<td>" + (t.rules === "yes" ? "✓" : '<span class="neg">✗</span>') + "</td>" +
        "<td>" + esc(t.note || "") + "</td>" +
        '<td><button class="btn danger" data-del="' + t.id + '">ลบ</button></td>' +
        "</tr>";
    }).join("");
    $("#tradeEmpty").style.display = trades.length ? "none" : "block";
    $$("[data-del]").forEach((b) => b.addEventListener("click", () => {
      if (!confirm("ลบบันทึกนี้?")) return;
      trades = trades.filter((x) => x.id !== b.dataset.del);
      save(KEY.trades, trades); renderTrades(); renderStats();
    }));
  }

  $("#tradeForm").addEventListener("submit", (e) => {
    e.preventDefault();
    trades.push({
      id: String(Date.now()) + Math.random().toString(16).slice(2, 6),
      date: $("#jDate").value,
      strategy: $("#jStrategy").value,
      pair: $("#jPair").value.trim().toUpperCase(),
      side: $("#jSide").value,
      result: $("#jResult").value,
      pips: $("#jPips").value,
      pnl: $("#jPnl").value,
      rr: $("#jRR").value,
      rules: $("#jRules").value,
      note: $("#jNote").value.trim()
    });
    save(KEY.trades, trades);
    ["jPips", "jPnl", "jRR", "jNote"].forEach((f) => { $("#" + f).value = ""; });
    renderTrades(); renderStats();
  });

  $("#exportBtn").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify({ trades: trades, notes: notes }, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "fx-journal-" + new Date().toISOString().slice(0, 10) + ".json";
    a.click();
    URL.revokeObjectURL(a.href);
  });

  $("#importFile").addEventListener("change", (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const data = JSON.parse(r.result);
        if (Array.isArray(data.trades)) {
          trades = trades.concat(data.trades);
          save(KEY.trades, trades);
        }
        if (data.notes) { Object.assign(notes, data.notes); save(KEY.notes, notes); }
        renderTrades(); renderStats();
        alert("นำเข้าเรียบร้อย");
      } catch (err) { alert("ไฟล์ไม่ถูกต้อง"); }
    };
    r.readAsText(f);
    e.target.value = "";
  });

  /* ================= สถิติ ================= */
  function renderStats() {
    const n = trades.length;
    const wins = trades.filter((t) => t.result === "win").length;
    const losses = trades.filter((t) => t.result === "loss").length;
    const pnl = trades.reduce((a, t) => a + num(t.pnl), 0);
    const pips = trades.reduce((a, t) => a + num(t.pips), 0);
    const gross = trades.reduce((a, t) => { const v = num(t.pnl); return v > 0 ? a + v : a; }, 0);
    const lossSum = trades.reduce((a, t) => { const v = num(t.pnl); return v < 0 ? a + Math.abs(v) : a; }, 0);
    const pf = lossSum > 0 ? gross / lossSum : 0;
    const disc = n ? trades.filter((t) => t.rules === "yes").length / n * 100 : 0;

    $("#kpis").innerHTML = [
      ["ไม้ทั้งหมด", String(n), ""],
      ["Win rate", n ? fmt(wins / n * 100, 1) + "%" : "—", ""],
      ["Pips รวม", fmt(pips, 1), pips >= 0 ? "pos" : "neg"],
      ["P/L รวม", fmt(pnl, 2), pnl >= 0 ? "pos" : "neg"],
      ["Profit factor", lossSum > 0 ? fmt(pf, 2) : "—", pf >= 1 ? "pos" : "neg"],
      ["ทำตามกฎ", n ? fmt(disc, 0) + "%" : "—", disc >= 80 ? "pos" : "neg"]
    ].map((k) => '<div class="kpi"><div class="v ' + k[2] + '">' + k[1] + '</div><div class="k">' + k[0] + "</div></div>").join("");

    const byStrat = {};
    trades.forEach((t) => {
      const g = byStrat[t.strategy] || (byStrat[t.strategy] = { n: 0, w: 0, pips: 0, pnl: 0, rules: 0 });
      g.n++;
      if (t.result === "win") g.w++;
      g.pips += num(t.pips); g.pnl += num(t.pnl);
      if (t.rules === "yes") g.rules++;
    });

    const rows = Object.keys(byStrat).sort((a, b) => byStrat[b].pnl - byStrat[a].pnl).map((id) => {
      const g = byStrat[id];
      const cls = g.pnl >= 0 ? "pos" : "neg";
      return "<tr><td>" + esc(stratName(id)) + "</td>" +
        '<td class="num">' + g.n + "</td>" +
        '<td class="num">' + g.w + "</td>" +
        '<td class="num">' + fmt(g.w / g.n * 100, 1) + "%</td>" +
        '<td class="num">' + fmt(g.pips, 1) + "</td>" +
        '<td class="num ' + cls + '">' + fmt(g.pnl, 2) + "</td>" +
        '<td class="num ' + cls + '">' + fmt(g.pnl / g.n, 2) + "</td>" +
        '<td class="num">' + fmt(g.rules / g.n * 100, 0) + "%</td></tr>";
    }).join("");

    $("#statTable tbody").innerHTML = rows;
    $("#statEmpty").style.display = rows ? "none" : "block";
  }

  /* ================= นาฬิกา ================= */
  function tick() {
    $("#clockTime").textContent = new Intl.DateTimeFormat("th-TH", {
      timeZone: "Asia/Bangkok", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false
    }).format(new Date());
    if ($("#tab-sessions").classList.contains("active")) renderSessions();
  }

  /* ================= เริ่มทำงาน ================= */
  renderChips();
  renderCards();
  renderCalc();
  renderTrades();
  renderStats();
  renderSessions();
  tick();
  setInterval(tick, 1000);
  setInterval(renderCards, 60000);
})();
