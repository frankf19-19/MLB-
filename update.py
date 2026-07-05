#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
MLB 每日 AI 分析產生器
----------------------------------------------------------
每天由 GitHub Actions 執行:
1. 抓昨日(美東)完賽結果與今日賽程(含預定先發與其 ERA)
2. 呼叫 Anthropic API,產生繁體中文的每日分析
3. 寫入 analysis.json,前端 index.html 會自動讀取顯示

只用 Python 標準函式庫。需要環境變數 ANTHROPIC_API_KEY。
"""
import os, sys, json, datetime, urllib.request
from zoneinfo import ZoneInfo

API = "https://statsapi.mlb.com/api/v1"
ET = ZoneInfo("America/New_York"); TPE = ZoneInfo("Asia/Taipei")
KEY = os.environ.get("ANTHROPIC_API_KEY", "").strip()
MODEL = os.environ.get("ANTHROPIC_MODEL", "claude-sonnet-4-6").strip()
OUT = "analysis.json"

def jget(url):
    req = urllib.request.Request(url, headers={"User-Agent": "mlb-daily/2.0"})
    with urllib.request.urlopen(req, timeout=30) as r:
        return json.load(r)

def standings(season):
    d = jget(f"{API}/standings?leagueId=103,104&season={season}&standingsTypes=regularSeason")
    m = {}
    for rec in d.get("records", []):
        for t in rec.get("teamRecords", []):
            m[t["team"]["id"]] = {"name": t["team"]["name"],
                                  "w": t.get("wins", 0), "l": t.get("losses", 0)}
    return m

def games(date):
    d = jget(f"{API}/schedule?sportId=1&date={date}&hydrate=probablePitcher,team,linescore")
    out = []
    for dt in d.get("dates", []):
        for g in dt.get("games", []):
            h, a = g["teams"]["home"], g["teams"]["away"]
            out.append({
                "status": g.get("status", {}).get("abstractGameState", ""),
                "away": a["team"]["name"], "home": h["team"]["name"],
                "away_id": a["team"]["id"], "home_id": h["team"]["id"],
                "as": a.get("score"), "hs": h.get("score"),
                "away_win": a.get("isWinner"), "home_win": h.get("isWinner"),
                "ap": (a.get("probablePitcher") or {}), "hp": (h.get("probablePitcher") or {}),
            })
    return out

def pitcher_eras(ids, season):
    if not ids: return {}
    out = {}
    url = (f"{API}/people?personIds={','.join(map(str,ids))}"
           f"&hydrate=stats(group=[pitching],type=[season],season={season})")
    try:
        for p in jget(url).get("people", []):
            for s in p.get("stats", []):
                if s.get("group", {}).get("displayName") != "pitching": continue
                sp = s.get("splits", [])
                if sp:
                    st = sp[-1].get("stat", {})
                    out[p["id"]] = {"era": st.get("era"), "ip": st.get("inningsPitched")}
    except Exception as e:
        print(f"[warn] 先發 ERA 抓取失敗:{e}", file=sys.stderr)
    return out

def call_claude(prompt):
    body = json.dumps({"model": MODEL, "max_tokens": 1500,
                       "messages": [{"role": "user", "content": prompt}]}).encode()
    req = urllib.request.Request(
        "https://api.anthropic.com/v1/messages", data=body, method="POST",
        headers={"content-type": "application/json", "x-api-key": KEY,
                 "anthropic-version": "2023-06-01"})
    with urllib.request.urlopen(req, timeout=90) as r:
        d = json.load(r)
    return "\n".join(b.get("text", "") for b in d.get("content", [])
                     if b.get("type") == "text").strip()

def main():
    if not KEY:
        print("[skip] 未設定 ANTHROPIC_API_KEY,略過 AI 分析(網站其他功能不受影響)")
        return
    now_et = datetime.datetime.now(ET)
    season = now_et.year
    today = now_et.date().isoformat()
    yday = (now_et.date() - datetime.timedelta(days=1)).isoformat()

    st = standings(season)
    rec = lambda tid: (f"{st[tid]['w']}-{st[tid]['l']}" if tid in st else "")
    ygames = [g for g in games(yday) if g["status"] == "Final"]
    tgames = [g for g in games(today)]
    pids = [p["id"] for g in tgames for p in (g["ap"], g["hp"]) if p.get("id")]
    eras = pitcher_eras(list(set(pids)), season)

    def pit_txt(p):
        if not p.get("fullName"): return "未定"
        e = eras.get(p.get("id"), {})
        return f"{p['fullName']}(ERA {e.get('era','?')},{e.get('ip','?')} IP)"

    lines = [
        "你是懂棒球的台灣朋友,請用繁體中文寫一段 MLB 每日分析,約 300–400 字,直接成文、不要條列、不要標題。",
        "內容:先用兩三句回顧昨天值得一提的結果(爆冷、大勝、關鍵表現);",
        "再挑今天 2–3 場最值得關注的對戰,說明理由(先發對決、球隊近況、戰績位置);",
        "結尾誠實提醒棒球單場變異大、預測僅供參考。語氣自然,像在跟朋友聊球。\n",
        f"【昨日({yday},美東)完賽結果】"]
    if ygames:
        for g in ygames[:16]:
            w = g["home"] if g.get("home_win") else g["away"]
            lines.append(f"- {g['away']} {g['as']}:{g['hs']} {g['home']}(勝:{w})")
    else:
        lines.append("- 昨日無比賽")
    lines.append(f"\n【今日({today},美東)賽程與先發】")
    if tgames:
        for g in tgames[:16]:
            lines.append(f"- {g['away']}({rec(g['away_id'])}) @ {g['home']}({rec(g['home_id'])}):"
                         f"{pit_txt(g['ap'])} vs {pit_txt(g['hp'])}")
    else:
        lines.append("- 今日無排定比賽")
    prompt = "\n".join(lines)

    try:
        text = call_claude(prompt)
    except Exception as e:
        print(f"[error] Anthropic API 失敗:{e}", file=sys.stderr)
        sys.exit(1)

    out = {"date_et": today,
           "generated_at_taipei": datetime.datetime.now(TPE).strftime("%Y-%m-%d %H:%M"),
           "model": MODEL, "analysis": text}
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(f"[ok] 已寫入 {OUT}({len(text)} 字)")

if __name__ == "__main__":
    main()
