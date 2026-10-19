// Self-contained operator page. It ships no data: everything is fetched
// from /api/* with the bearer token the operator enters once per tab.
export const PORTAL_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ServiceDesk Portal</title>
<style>
  :root { color-scheme: light dark; --bg: #fff; --fg: #1b1f24; --muted: #5d6670; --line: #d9dee3; --card: #f5f7f9; --accent: #0b6bcb; --bad: #b42318; }
  @media (prefers-color-scheme: dark) {
    :root { --bg: #121417; --fg: #e8eaed; --muted: #9aa3ad; --line: #2c3137; --card: #1c2025; --accent: #6cb4ff; --bad: #ff8a80; }
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--fg); font: 15px/1.45 system-ui, sans-serif; }
  main { max-width: 860px; margin: 0 auto; padding: 16px; }
  h1 { font-size: 20px; margin: 0 0 12px; }
  h2 { font-size: 16px; margin: 20px 0 8px; }
  nav { display: flex; gap: 4px; border-bottom: 1px solid var(--line); margin-bottom: 16px; overflow-x: auto; }
  nav button { background: none; border: 0; border-bottom: 2px solid transparent; color: var(--muted); font: inherit; padding: 8px 12px; cursor: pointer; white-space: nowrap; }
  nav button.on { color: var(--fg); border-color: var(--accent); }
  .cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; }
  .card { background: var(--card); border-radius: 8px; padding: 14px; }
  .card.head { grid-column: 1 / -1; }
  .num { font-size: 34px; font-weight: 700; }
  .card p, .muted { color: var(--muted); margin: 4px 0 0; }
  .wrap { overflow-x: auto; }
  table { border-collapse: collapse; width: 100%; }
  th, td { text-align: left; padding: 6px 8px; border-bottom: 1px solid var(--line); white-space: nowrap; }
  th { color: var(--muted); font-weight: 600; }
  .bad { color: var(--bad); }
</style>
</head>
<body>
<main id="root"></main>
<script src="https://unpkg.com/react@18.3.1/umd/react.production.min.js" crossorigin></script>
<script src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js" crossorigin></script>
<script src="https://unpkg.com/htm@3.1.1/dist/htm.umd.js" crossorigin></script>
<script>
(function () {
  var html = htm.bind(React.createElement);
  var h = React;
  var KEY = "portal_token";
  var ENDPOINTS = { appointments: "/api/appointments", kpis: "/api/kpis", observability: "/api/observability" };

  function token() {
    var t = null;
    try { t = sessionStorage.getItem(KEY); } catch (e) {}
    if (!t) {
      t = (window.prompt("Portal token") || "").trim();
      try { if (t) sessionStorage.setItem(KEY, t); } catch (e) {}
    }
    return t;
  }

  function fetchAll(tok) {
    var names = Object.keys(ENDPOINTS);
    return Promise.all(names.map(function (n) {
      return fetch(ENDPOINTS[n], { headers: { authorization: "Bearer " + tok } }).then(function (r) {
        if (r.status === 401) { try { sessionStorage.removeItem(KEY); } catch (e) {} throw new Error("Unauthorized: reload the page and enter the token again."); }
        if (!r.ok) throw new Error("Service unavailable (" + r.status + ").");
        return r.json();
      });
    })).then(function (rs) { var o = {}; names.forEach(function (n, i) { o[n] = rs[i]; }); return o; });
  }

  function time(iso) { return iso ? new Date(iso).toLocaleString([], { timeZone: "America/Mexico_City", dateStyle: "short", timeStyle: "short" }) : ""; }

  function Table(props) {
    if (!props.rows.length) return html\`<p class="muted">\${props.empty || "Nothing yet."}</p>\`;
    return html\`<div class="wrap"><table><thead><tr>\${props.cols.map(function (c) { return html\`<th key=\${c}>\${c}</th>\`; })}</tr></thead>
      <tbody>\${props.rows.map(function (r, i) { return html\`<tr key=\${i}>\${r.map(function (v, j) { return html\`<td key=\${j}>\${v}</td>\`; })}</tr>\`; })}</tbody></table></div>\`;
  }

  function Card(props) {
    return html\`<div class=\${"card" + (props.head ? " head" : "")}><div class="num">\${props.value}</div><strong>\${props.title}</strong><p>\${props.text}</p></div>\`;
  }

  function Appointments(props) {
    var d = props.data;
    return html\`<div>
      \${d.days.map(function (day) {
        return html\`<section key=\${day.date}><h2>\${day.date}</h2>
          <\${Table} cols=\${["Time", "Service", "Name", "Phone"]} empty="No bookings."
            rows=\${day.bookings.map(function (b) { return [b.time, b.service_id, b.customer_name, b.customer_phone]; })} /></section>\`;
      })}
      <h2>Callback requests</h2>
      <\${Table} cols=\${["Time", "Name", "Phone", "Reason"]} empty="No callback requests."
        rows=\${d.callbacks.map(function (c) { return [time(c.created_at), c.customer_name, c.customer_phone, c.reason]; })} />
    </div>\`;
  }

  function Kpis(props) {
    var k = props.data.kpis;
    return html\`<div class="cards">
      <\${Card} head value=\${k.follow_up_opportunities} title="Follow-up opportunities"
        text="Callers a follow-up bot could re-contact this week (sum of the three cards below)." />
      <\${Card} value=\${k.checked_availability_not_booked} title="Callers who checked availability but did not book"
        text="Leads lost in the last 7 days that a follow-up call could recover." />
      <\${Card} value=\${k.unserved_requests} title="Requests we could not serve"
        text="Booking attempts rejected for a taken slot, closed day or outside hours (7 days)." />
      <\${Card} value=\${k.pending_callbacks} title="Pending callback requests"
        text="Customers waiting for the team to call them back." />
      <\${Card} value=\${k.upcoming_maintenance_reminders} title="Upcoming maintenance reminders"
        text="Customers with a confirmed booking this week who can be reminded of their next service." />
      <\${Card} value=\${k.bookings_confirmed_7d} title="Bookings confirmed (7 days)"
        text="Context: appointments the receptionist already closed." />
    </div>\`;
  }

  function Observability(props) {
    var o = props.data;
    return html\`<div>
      <p>Status: <strong class=\${o.status === "ok" ? "" : "bad"}>\${o.status === "ok" ? "OK" : "Degraded"}</strong>
        <span class="muted"> · config \${o.config_ok ? "loaded" : "unavailable"} · booking \${o.booking_enabled ? "enabled" : "disabled"}</span></p>
      <h2>Webhook today</h2>
      <\${Table} cols=\${["OK", "Degraded", "Rejected", "Avg ms"]}
        rows=\${[[o.webhook.ok, o.webhook.degraded, o.webhook.rejected, o.webhook.avg_latency_ms]]} />
      <h2>Tools today</h2>
      <\${Table} cols=\${["Tool", "Calls", "Errors", "Avg ms"]}
        rows=\${o.tools.map(function (t) { return [t.tool, t.calls, t.errors, t.avg_latency_ms]; })} />
      <h2>Recent events</h2>
      <\${Table} cols=\${["Time", "Event", "Outcome", "ms", "Conversation"]} empty="No events today."
        rows=\${o.recent.map(function (e) { return [time(e.ts), e.event, e.outcome, e.latency_ms == null ? "" : e.latency_ms, e.telnyx_conversation_id || ""]; })} />
    </div>\`;
  }

  var TABS = [["appointments", "Appointments", Appointments], ["kpis", "Business KPIs", Kpis], ["observability", "Observability", Observability]];

  function App() {
    var tab = h.useState("appointments"), data = h.useState(null), err = h.useState("");
    h.useEffect(function () {
      var tok = token();
      if (!tok) { err[1]("A portal token is required. Reload to enter it."); return; }
      var stopped = false;
      function load() { fetchAll(tok).then(function (d) { if (!stopped) { data[1](d); err[1](""); } }, function (e) { if (!stopped) err[1](e.message); }); }
      load();
      var id = setInterval(load, 10000);
      return function () { stopped = true; clearInterval(id); };
    }, []);
    var active = TABS.find(function (t) { return t[0] === tab[0]; });
    return html\`<div>
      <h1>ServiceDesk Portal</h1>
      <nav>\${TABS.map(function (t) { return html\`<button key=\${t[0]} class=\${t[0] === tab[0] ? "on" : ""} onClick=\${function () { tab[1](t[0]); }}>\${t[1]}</button>\`; })}</nav>
      \${err[0] ? html\`<p class="bad">\${err[0]}</p>\` : null}
      \${data[0] ? h.createElement(active[2], { data: data[0][active[0]] }) : (err[0] ? null : html\`<p class="muted">Loading…</p>\`)}
    </div>\`;
  }

  ReactDOM.createRoot(document.getElementById("root")).render(html\`<\${App} />\`);
})();
</script>
</body>
</html>
`;
